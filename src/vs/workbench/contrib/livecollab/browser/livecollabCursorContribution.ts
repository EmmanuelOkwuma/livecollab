/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { ICodeEditor, IContentWidget, IContentWidgetPosition, isDiffEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILiveCollabClient } from './livecollabClient.js';
import { LIVECOLLAB_SCHEME, LiveCollabFileSystemProvider } from './livecollabFileSystemProvider.js';
import { LiveCollabService } from './livecollabService.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { localize } from '../../../../nls.js';
import { nameForDisplay } from '../../../../base/common/nameDirection.js';

const USER_COLORS = [
	'#93c5fd', '#60a5fa', '#38bdf8', '#3b82f6', '#2563eb', '#818cf8',
];

function colorForIndex(index: number): string {
	return USER_COLORS[index % USER_COLORS.length];
}

function colorIndexFromSocketId(socketId: string): number {
	let hash = 0;
	for (let i = 0; i < socketId.length; i++) {
		hash = socketId.charCodeAt(i) + ((hash << 5) - hash);
	}
	return Math.abs(hash) % USER_COLORS.length;
}

interface IRemoteCursorInfo {
	fileId: string;
	name: string;
	colorIndex: number;
	position: { lineNumber: number; column: number };
}

export class LiveCollabCursorContribution extends Disposable implements IEditorContribution {

	static readonly ID = 'editor.contrib.livecollabCursor';

	private readonly _remoteCursors = new Map<string, IRemoteCursorInfo>();
	private readonly _decorations = new Map<string, string[]>();
	private readonly _labelWidgets = new Map<string, { widget: IContentWidget; dom: HTMLElement; setPosition: (position: { lineNumber: number; column: number }) => void }>();
	private readonly _cursorStyles = new Map<string, HTMLStyleElement>();
	private _styleEl: HTMLStyleElement | undefined;

	private readonly _service: LiveCollabService;
	private readonly _fileSystem: LiveCollabFileSystemProvider;

	constructor(
		private readonly editor: ICodeEditor,
		@ILiveCollabClient client: ILiveCollabClient,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		this._service = client.service;
		this._fileSystem = client.fileSystem;

		this._injectStyles();

		this._register(this.editor.onDidChangeCursorPosition(() => this._emitCursor()));
		this._register(this.editor.onDidChangeCursorSelection(() => this._emitCursor()));

		// Another file in this editor (a tab switch, or the tab closed): if this is the active
		// editor, the cursor is now in that file, or, if it isn't a room file, nowhere in the room.
		this._register(this.editor.onDidChangeModel(() => {
			this._repaintAll();
			this._followActiveEditor();
		}));
		// The cursor is where the active editor is: another group or tab made active (or this
		// editor closed and another took its place) moves it there. The window losing focus, to
		// another app, changes no active editor, so it neither moves nor clears the cursor.
		this._register(this.editorService.onDidActiveEditorChange(() => this._followActiveEditor()));
		this._register(this.editor.onDidDispose(() => this._leave()));

		// The room's ids arrive after the files open (the join's snapshot, the owner's attach,
		// again after a reconnect): cursors already received can be placed, and this editor's
		// own cursor, if it's the one the room last heard, is sent again.
		this._register(this._fileSystem.onFileIdsAvailable(() => {
			this._repaintAll();
			if (this._service.isCursorSource(this)) {
				this._emitCursor();
			}
		}));

		this._register(this._service.onCursorUpdate(payload => {
			if (!this._service.roomId || payload.roomId !== this._service.roomId) { return; }
			this._remoteCursors.set(payload.socketId, {
				fileId: payload.fileId,
				name: payload.name || 'Anonymous',
				colorIndex: colorIndexFromSocketId(payload.socketId),
				position: payload.position,
			});
			this._paintCursor(payload.socketId);
		}));

		this._register(this._service.onCursorLeave(payload => {
			this._clearCursor(payload.socketId);
		}));

		// While this window is away, others' cursors can leave without it hearing: forget them
		// all, and show each again when it next moves.
		this._register(this._service.onDisconnected(() => {
			for (const [socketId] of this._remoteCursors) {
				this._clearCursor(socketId);
			}
		}));
	}

	/**
	 * The room's id for the file in this editor, or undefined when it isn't a file of the room
	 * this window is in: an untitled file, the settings, a file outside the shared folder, a
	 * room file whose id hasn't arrived yet.
	 */
	private _roomFileId(): string | undefined {
		const uri = this.editor.getModel()?.uri;
		const roomId = this._service.roomId;
		if (!uri || !roomId) { return undefined; }
		let itemPath: string | undefined;
		if (uri.scheme === LIVECOLLAB_SCHEME) {
			itemPath = uri.authority === roomId ? uri.path.replace(/^\//, '') : undefined;
		} else if (uri.scheme === Schemas.file) {
			itemPath = this._fileSystem.getItemPathForRealPath(uri.fsPath);
		}
		return itemPath ? this._fileSystem.getServerFileId(itemPath) : undefined;
	}

	/**
	 * Whether this is the window's active editor (or the changed side of the active diff). Only
	 * the active editor speaks for the cursor: a caret that moves in a background editor, as
	 * when someone else's edit shifts it, isn't the person moving.
	 */
	private _isActive(): boolean {
		const active = this.editorService.activeTextEditorControl;
		return active === this.editor || (isDiffEditor(active) && active.getModifiedEditor() === this.editor);
	}

	/** This editor became active, or its file changed: the cursor goes to its file, or leaves. */
	private _followActiveEditor(): void {
		// Not active, or active in a non-room file: leave. That only acts if the room last heard
		// the cursor from this editor; an active editor with a room file sends it there and
		// becomes where it was last heard, whichever of the two runs first.
		if (!this._emitCursor()) {
			this._leave();
		}
	}

	/** Sends this editor's cursor to the room, if it's the active editor and its file is a room file. Returns whether it sent. */
	private _emitCursor(): boolean {
		if (!this._isActive()) { return false; }
		const roomId = this._service.roomId;
		const fileId = this._roomFileId();
		const position = this.editor.getPosition();
		if (!roomId || !fileId || !position) { return false; }
		this._service.emitCursorUpdate(roomId, fileId, { lineNumber: position.lineNumber, column: position.column }, this);
		return true;
	}

	/** Takes this window's cursor out of the room, if this editor is where the room last saw it. */
	private _leave(): void {
		const roomId = this._service.roomId;
		if (roomId) {
			this._service.emitCursorLeave(roomId, this);
		}
	}

	private _paintCursor(socketId: string): void {
		const info = this._remoteCursors.get(socketId);
		if (!info) { return; }
		// By id only: a cursor naming its file by name (0.3.5 and earlier send the base name)
		// matches nothing.
		if (this._roomFileId() !== info.fileId) {
			this._clearCursorDecorations(socketId);
			return;
		}

		const { lineNumber, column } = info.position;
		const color = colorForIndex(info.colorIndex);
		const className = `lc-remote-cursor-${socketId.replace(/[^a-zA-Z0-9]/g, '_')}`;

		// Inject per-cursor style
		this._injectCursorStyle(socketId, color, className, info.name || localize('livecollab.cursor.unnamed', "Member"));

		const range = new Range(lineNumber, column, lineNumber, column);
		const prev = this._decorations.get(socketId) || [];
		const next = this.editor.deltaDecorations(prev, [
			{
				range,
				options: {
					description: 'livecollab-remote-cursor',
					beforeContentClassName: className,
					stickiness: 1,
				},
			},
		]);
		this._decorations.set(socketId, next);
		this._ensureLabelWidget(socketId, info.name, color, { lineNumber, column });
	}

	private _clearCursor(socketId: string): void {
		this._clearCursorDecorations(socketId);
		this._remoteCursors.delete(socketId);
		this._removeLabelWidget(socketId);
	}

	private _clearCursorDecorations(socketId: string): void {
		const prev = this._decorations.get(socketId) || [];
		if (prev.length) {
			this.editor.deltaDecorations(prev, []);
			this._decorations.set(socketId, []);
		}
	}

	private _repaintAll(): void {
		for (const [socketId] of this._remoteCursors) {
			this._clearCursorDecorations(socketId);
			this._removeLabelWidget(socketId);
			this._paintCursor(socketId);
		}
	}

	private _ensureLabelWidget(
		socketId: string,
		name: string,
		color: string,
		position: { lineNumber: number; column: number }
	): void {
		const existing = this._labelWidgets.get(socketId);
		if (existing) {
			existing.dom.textContent = nameForDisplay(name);
			existing.dom.style.background = color;
			existing.setPosition(position);
			this.editor.layoutContentWidget(existing.widget);
			return;
		}

		const dom = document.createElement('div');
		dom.style.position = 'absolute';
		dom.style.transform = 'translateY(-85%)';
		dom.style.fontSize = '10px';
		dom.style.padding = '1px 4px';
		dom.style.borderRadius = '2px 2px 2px 0';
		dom.style.color = 'white';
		dom.style.whiteSpace = 'nowrap';
		// A long name (up to 64 characters) is cut short here, not refused.
		dom.style.maxWidth = '160px';
		dom.style.overflow = 'hidden';
		dom.style.textOverflow = 'ellipsis';
		dom.style.pointerEvents = 'none';
		dom.style.userSelect = 'none';
		dom.style.background = color;
		dom.style.fontWeight = '600';
		dom.style.letterSpacing = '0.02em';
		dom.style.transition = 'opacity 0.3s ease';
		dom.style.opacity = '1';
		dom.textContent = nameForDisplay(name);
		dom.dir = 'auto'; // the name's own direction

		let pos: { lineNumber: number; column: number } | null = position;

		const widget: IContentWidget = {
			getId: () => `lc-cursor-label-${socketId}`,
			getDomNode: () => dom,
			getPosition: (): IContentWidgetPosition | null => {
				if (!pos) { return null; }
				return {
					position: pos,
					preference: [1], // ABOVE
				};
			},
		};

		this._labelWidgets.set(socketId, { widget, dom, setPosition: p => { pos = p; } });
		this.editor.addContentWidget(widget);
		setTimeout(() => { dom.style.opacity = '0'; }, 2000);
	}

	private _removeLabelWidget(socketId: string): void {
		const entry = this._labelWidgets.get(socketId);
		if (!entry) { return; }
		try { this.editor.removeContentWidget(entry.widget); } catch { }
		this._labelWidgets.delete(socketId);
	}

	private _injectStyles(): void {
		this._styleEl = document.createElement('style');
		this._styleEl.textContent = `
			.lc-remote-cursor-base {
				border-left: 1px solid;
				margin-left: -1px;
				height: 1.2em;
				display: inline-block;
				position: relative;
			}
			.lc-remote-cursor-base::before {
				content: '';
				position: absolute;
				top: -4px;
				left: -2px;
				width: 6px;
				height: 3px;
				border-radius: 2px 2px 0 0;
				background: inherit;
			}
		`;
		mainWindow.document.head.appendChild(this._styleEl);
	}

	private _injectCursorStyle(socketId: string, color: string, className: string, name: string): void {
		this._cursorStyles.get(socketId)?.remove();
		const style = document.createElement('style');
		this._cursorStyles.set(socketId, style);
		style.textContent = `
			.${className} {
				border-left: 1px solid ${color};
				margin-left: -1px;
				height: 1.2em;
				display: inline-block;
				position: relative;
			}
			.${className}::before {
				content: '';
				position: absolute;
				top: -3px;
				left: -2px;
				width: 5px;
				height: 3px;
				background: ${color};
				border-radius: 1px 1px 0 0;
			}
			.${className}::after {
				content: '${name}';
				position: absolute;
				top: -20px;
				left: -1px;
				font-size: 12px;
				font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
				font-weight: 600;
				padding: 2px 6px;
				border-radius: 3px 3px 3px 0;
				background: ${color};
				color: white;
				white-space: nowrap;
				max-width: 160px;
				overflow: hidden;
				text-overflow: ellipsis;
				pointer-events: none;
				opacity: 0;
				transition: opacity 0.15s ease;
				z-index: 999;
			}
			.${className}:hover::after {
				opacity: 1;
			}
		`;
		mainWindow.document.head.appendChild(style);
	}

	override dispose(): void {
		this._leave();
		for (const [socketId] of this._remoteCursors) {
			this._clearCursor(socketId);
		}
		if (this._styleEl) {
			this._styleEl.remove();
		}
		super.dispose();
	}
}

registerEditorContribution(
	LiveCollabCursorContribution.ID,
	LiveCollabCursorContribution,
	EditorContributionInstantiation.AfterFirstRender
);
