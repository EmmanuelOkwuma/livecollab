/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/livecollabChat.css';
import { initialsFromName } from '../../../../base/common/initials.js';
import { isolatedName, nameForDisplay } from '../../../../base/common/nameDirection.js';
import { localize } from '../../../../nls.js';
import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ChatPart, IChatMessage, IChatPendingSend } from './livecollabChat.js';
import { chatTime, ComposerTags, editableText, mentionAt, pastedText, plainText, startsRun, textSegments } from './livecollabChatFormat.js';
import { colorForIndex } from './livecollabAvatar.js';
import { LIVECOLLAB_SCHEME, LiveCollabFileSystemProvider } from './livecollabFileSystemProvider.js';
import { LiveCollabService } from './livecollabService.js';
import { draftVersion, IChatDraft, IChatDrafts, IKeptChatDraft, IStoredChatDraft, mergeSeen, parseDraftVersion, sameDraft } from './livecollabChatDrafts.js';
import { lcLog } from './livecollabLog.js';

/** What the chat widget asks of the workbench around it (the view; a B test passes its own). */
export interface IChatWidgetHost {
	/** Opens a room file in the reader's editor. */
	openFile(resource: URI): void;
	/** Opens a link from a message. */
	openLink(url: string): void;
	copy(text: string): void;
	/** Shows `text` when `element` is hovered. */
	hover(element: HTMLElement, text: string): IDisposable;
	/** Whether the window has focus (the read position moves only for what was actually seen). */
	hasFocus(): boolean;
}

/** How a file tag shows (CHAT_DESIGN.md, "Absence has three states"). */
export type FileTagState = 'resolved' | 'unavailable' | 'deleted';

/** How many people and files the @ list offers at most, each. */
const SUGGEST_LIMIT = 8;
/** How close to the top of the log (px) scrolling loads the page before. */
const LOAD_OLDER_PX = 40;
/** Code blocks' tab size until the view says what the editor's is. */
const DEFAULT_TAB_SIZE = 4;

interface ISuggestion {
	readonly section: 'people' | 'files';
	readonly label: string;
	readonly detail?: string;
	readonly token: string;
	readonly part: ChatPart;
}

/**
 * The room chat: the log, the not-sent sends, the composer with its @ list,
 * and the selection mode for deleting (CHAT_DESIGN.md). Drawn from the room's
 * chat log (livecollabChat.ts); every change redraws the log.
 */
export class LiveCollabChatWidget extends Disposable {

	readonly element: HTMLElement;
	private readonly _log: HTMLElement;
	private readonly _jump: HTMLButtonElement;
	private readonly _selectBar: HTMLElement;
	private readonly _composer: HTMLTextAreaElement;
	private readonly _suggest: HTMLElement;
	private readonly _rendered = this._register(new DisposableStore());
	private readonly _suggestRendered = this._register(new DisposableStore());

	private _visible = true;
	/**
	 * Where the unread divider sits: after the read position when the log was
	 * opened. While no divider shows and the reader is looking at the latest,
	 * it follows them, so what arrives in front of them isn't marked new; once
	 * something arrives unseen it stays put until the view is next opened.
	 */
	private _dividerAfter: number | undefined;
	private _dividerShown = false;
	private _loadingOlder = false;
	private _selected: Set<number> | undefined;
	private _selectError: string | undefined;
	/**
	 * The message being edited: the revision the edit was made from, and
	 * `gone` once the room says it no longer exists. Kept while the message is
	 * missing from the log, so a delete from another window loses nothing typed.
	 */
	private _editing: { id: number; revision: number; text: string; tags: ComposerTags; error?: string; gone?: boolean } | undefined;
	private readonly _composerTags = new ComposerTags();
	/** Whose draft, for which room, the composer holds (IChatDrafts). */
	private _draftOwner: { readonly userId: string; readonly roomId: string } | undefined;
	/** This window's name as a draft writer, and its count of versions written. */
	private readonly _draftWriter = generateUuid();
	private _draftSeq = 0;
	/** The name of the stored draft version the composer holds: the one it loaded, wrote or took from another window. */
	private _draftHeld: string | undefined;
	/** Every window's latest version this window has passed, for the current account and room. Only grows. */
	private _draftSeen: Record<string, number> = {};
	/** Whether `_draftSeen` came, even in part, from a draft whose writers were dropped (IStoredChatDraft.pruned). */
	private _draftPruned = false;
	/** Whether this window wrote the version it holds (typed, picked or sent since the last version it took). */
	private _draftTyped = false;
	/**
	 * Whether the reader is at the latest. A log with no height yet (not laid
	 * out) can't say, so it keeps the last answer: it starts at the latest.
	 */
	private _atLatest = true;
	private _tabSize = DEFAULT_TAB_SIZE;
	private _suggestions: ISuggestion[] = [];
	private _suggestIndex = 0;
	private readonly _deletedFiles = new Set<string>();

	constructor(
		container: HTMLElement,
		private readonly _service: LiveCollabService,
		private readonly _fileSystem: LiveCollabFileSystemProvider,
		private readonly _host: IChatWidgetHost,
		private readonly _drafts: IChatDrafts,
	) {
		super();
		this.element = append(container, $('.livecollab-chat'));
		const logArea = append(this.element, $('.livecollab-chat-log-area'));
		this._log = append(logArea, $('.livecollab-chat-log'));
		this._log.tabIndex = 0;
		this._log.setAttribute('role', 'log');
		this._log.setAttribute('aria-label', localize('livecollab.chat.log', "Room chat"));
		this._jump = append(logArea, $('button.livecollab-chat-jump')) as HTMLButtonElement;
		this._selectBar = append(this.element, $('.livecollab-chat-select-bar'));
		const composerArea = append(this.element, $('.livecollab-chat-composer'));
		this._suggest = append(composerArea, $('.livecollab-chat-suggest'));
		this._suggest.setAttribute('role', 'listbox');
		this._composer = append(composerArea, $('textarea.livecollab-chat-input')) as HTMLTextAreaElement;
		this._composer.rows = 2;
		this._composer.placeholder = localize('livecollab.chat.placeholder', "Message the room. @ to tag a person or a file");
		this._composer.setAttribute('aria-label', localize('livecollab.chat.composer', "Message the room"));

		const chat = this._service.chat;
		this._register(chat.onDidChange(() => {
			if (chat.loaded && this._dividerAfter === undefined) {
				this._openDivider();
			}
			if (!chat.loaded) {
				this._dividerAfter = undefined;
				this._selected = undefined;
				this._editing = undefined;
			}
			this.render();
		}));
		this._register(chat.onDidChangeUnread(() => this._renderJump()));
		this._register(this._service.onMembersChanged(() => this.render()));
		this._register(this._service.onConnected(() => this.render()));
		this._register(this._service.onDisconnected(() => this.render()));
		this._register(this._fileSystem.onDidChangeServerFileIds(() => this.render()));
		this._register(this._fileSystem.onFileIdsAvailable(() => this.render()));
		this._register(this._service.onFileDeleted(({ files }) => {
			for (const file of files) {
				this._deletedFiles.add(file.fileId);
			}
			this.render();
		}));
		this._register(this._service.onRoomLeft(() => {
			this._deletedFiles.clear();
			this.render();
		}));
		this._register(this._service.onRoomJoined(() => this.render()));
		this._register(this._drafts.onDidChange(e => {
			if (e.userId === this._draftOwner?.userId && e.roomId === this._draftOwner?.roomId) {
				if (e.kind === 'draft') {
					this._onStoredDraftChanged();
				} else {
					this.render();
				}
			}
		}));

		this._register(addDisposableListener(this._log, EventType.SCROLL, () => this._onScroll()));
		this._register(addDisposableListener(this._jump, EventType.CLICK, () => this._scrollToLatest()));
		this._register(addDisposableListener(getWindow(this.element), EventType.FOCUS, () => this._markReadIfSeen()));
		this._register(addDisposableListener(this._composer, EventType.KEY_DOWN, e => this._onComposerKey(e)));
		this._register(addDisposableListener(this._composer, EventType.INPUT, (e: InputEvent) => this._onComposerInput(e.inputType)));
		// Laid out or resized: a reader at the latest stays there, and Jump to Latest is decided again.
		const resizeObserver = new (getWindow(this._log).ResizeObserver)(() => this._onResize());
		resizeObserver.observe(this._log);
		this._register({ dispose: () => resizeObserver.disconnect() });
		this._register(addDisposableListener(this._composer, 'paste', (e: ClipboardEvent) => this._onPaste(e)));
		// Relative times move on.
		const timer = getWindow(this.element).setInterval(() => this.render(), 60 * 1000);
		this._register({ dispose: () => getWindow(this.element).clearInterval(timer) });
		// Opened on a log that is already loaded: the divider goes where the reader is now.
		if (chat.loaded) {
			this._openDivider();
		}
		this.render();
	}

	/** Code blocks show tabs at the editor's tab size. */
	setTabSize(size: number): void {
		if (size !== this._tabSize) {
			this._tabSize = size;
			this.render();
		}
	}

	/** Puts the caret in the composer. */
	focusComposer(): void {
		this._composer.focus();
	}

	/** The view was shown or hidden. Shown again, the unread divider moves to where the reader now is. */
	setVisible(visible: boolean): void {
		const opened = visible && !this._visible;
		this._visible = visible;
		if (opened) {
			this._openDivider();
			this.render();
		}
		this._markReadIfSeen();
	}

	/** The log was opened: the divider goes after the read position, if anything after it is unread. */
	private _openDivider(): void {
		const chat = this._service.chat;
		this._dividerAfter = chat.loaded ? chat.readUpTo : undefined;
		this._dividerShown = this._dividerAfter !== undefined && chat.messages.some(m => this._isNew(m, this._dividerAfter!));
	}

	private _isNew(message: IChatMessage, after: number): boolean {
		return message.id > after && message.kind === 'message' && message.authorId !== this._service.myUserId;
	}

	/** Redraws the log, keeping the reader's place (at the latest, it stays at the latest). */
	render(): void {
		this._syncDraft();
		const atBottom = this._readerAtLatest();
		if (!this._dividerShown && this._dividerAfter !== undefined && this._visible && atBottom && this._host.hasFocus()) {
			this._dividerAfter = Math.max(this._dividerAfter, this._service.chat.messages.at(-1)?.id ?? 0);
		}
		const fromBottom = this._log.scrollHeight - this._log.scrollTop;
		this._rendered.clear();
		clearNode(this._log);
		const chat = this._service.chat;
		if (chat.hasMore) {
			const older = append(this._log, $('.livecollab-chat-older'));
			// Unread beyond what is loaded (a long absence): said so, and they load on scroll.
			const loadedUnread = chat.messages.filter(m => this._isNew(m, chat.readUpTo)).length;
			older.classList.toggle('unread', chat.unread > loadedUnread);
			older.textContent = this._loadingOlder ? localize('livecollab.chat.loadingOlder', "Loading earlier messages…")
				: chat.unread > loadedUnread ? localize('livecollab.chat.earlierUnread', "Earlier unread messages: scroll up to load them")
					: localize('livecollab.chat.scrollForOlder', "Scroll up for earlier messages");
		}
		if (!this._service.roomId) {
			append(this._log, $('.livecollab-chat-empty')).textContent = localize('livecollab.chat.noRoom', "Chat opens with a room: join or create one from the dashboard.");
		} else if (chat.loaded && chat.messages.length === 0 && chat.pending.length === 0) {
			const empty = append(this._log, $('.livecollab-chat-empty'));
			append(empty, $('.livecollab-chat-empty-title')).textContent = localize('livecollab.chat.emptyTitle', "No messages yet");
			append(empty, $('.livecollab-chat-empty-body')).textContent = localize('livecollab.chat.emptyBody', "Everyone in the room sees what you write here. Type @ to tag a person or a file.");
		}
		let previous: IChatMessage | undefined;
		let dividerShown = false;
		for (const message of chat.messages) {
			if (!dividerShown && this._dividerAfter !== undefined && this._isNew(message, this._dividerAfter)) {
				const divider = append(this._log, $('.livecollab-chat-divider'));
				append(divider, $('span')).textContent = localize('livecollab.chat.new', "New");
				dividerShown = true;
			}
			this._renderEntry(message, startsRun(previous, message));
			previous = message;
		}
		this._dividerShown = dividerShown;
		for (const pending of chat.pending) {
			this._renderPending(pending);
		}
		const editing = this._editing;
		if (editing && (editing.gone || !chat.messages.some(m => m.id === editing.id))) {
			this._renderOrphan(editing);
		}
		if (this._draftOwner) {
			for (const kept of this._drafts.kept(this._draftOwner.userId, this._draftOwner.roomId)) {
				this._renderKept(kept);
			}
		}
		this._renderSelectBar();
		if (atBottom) {
			this._log.scrollTop = this._log.scrollHeight;
		} else {
			this._log.scrollTop = this._log.scrollHeight - fromBottom;
		}
		this._readerAtLatest();
		this._renderJump();
		this._markReadIfSeen();
	}

	private _renderEntry(message: IChatMessage, runStart: boolean): void {
		const mine = message.authorId === this._service.myUserId;
		const name = this._service.memberName(message.authorId, message.authorName);
		if (message.kind !== 'message') {
			const line = append(this._log, $('.livecollab-chat-line'));
			line.dataset.id = String(message.id);
			append(line, $('span')).textContent = message.kind === 'joined'
				? localize('livecollab.chat.joined', "{0} joined the room", isolatedName(name))
				: localize('livecollab.chat.left', "{0} left the room", isolatedName(name));
			this._renderTime(append(line, $('span.livecollab-chat-time')), message.createdAt);
			return;
		}
		const row = append(this._log, $('.livecollab-chat-message'));
		row.dataset.id = String(message.id);
		row.classList.toggle('run-start', runStart);
		row.classList.toggle('mine', mine);
		if (this._selected) {
			const box = append(row, $('input.livecollab-chat-select')) as HTMLInputElement;
			box.type = 'checkbox';
			box.checked = this._selected.has(message.id);
			box.setAttribute('aria-label', localize('livecollab.chat.selectMessage', "Select message"));
			this._rendered.add(addDisposableListener(box, EventType.CHANGE, () => {
				if (box.checked) {
					this._selected?.add(message.id);
				} else {
					this._selected?.delete(message.id);
				}
				this._selectError = undefined;
				this._renderSelectBar();
			}));
		}
		const avatar = append(row, $('.livecollab-chat-avatar'));
		if (runStart) {
			avatar.textContent = initialsFromName(name);
			avatar.style.backgroundColor = colorForIndex(this._memberIndex(message.authorId));
		}
		const body = append(row, $('.livecollab-chat-body'));
		if (runStart) {
			const head = append(body, $('.livecollab-chat-head'));
			const author = append(head, $('span.livecollab-chat-name'));
			author.textContent = nameForDisplay(name);
			author.dir = 'auto'; // the name's own direction, isolated from the time beside it
			this._renderTime(append(head, $('span.livecollab-chat-time')), message.createdAt);
		}
		if (this._editing?.id === message.id) {
			this._renderEditor(body, message);
			return;
		}
		const text = append(body, $('.livecollab-chat-text'));
		this._renderParts(text, message.parts);
		if (message.editedAt !== null) {
			append(text, $('span.livecollab-chat-edited')).textContent = localize('livecollab.chat.edited', "(edited)");
		}
		if (!this._selected) {
			const actions = append(row, $('.livecollab-chat-actions'));
			this._action(actions, localize('livecollab.chat.copy', "Copy"), () => this._host.copy(plainText(message.parts, part => this._tagName(part))));
			if (mine) {
				this._action(actions, localize('livecollab.chat.edit', "Edit"), () => {
					const editable = editableText(message.parts, part => this._tagName(part));
					this._editing = { id: message.id, revision: message.revision, text: editable.text, tags: new ComposerTags(editable.text, editable.tags) };
					this.render();
				});
			}
			this._action(actions, localize('livecollab.chat.delete', "Delete"), () => {
				this._selected = new Set([message.id]);
				this._selectError = undefined;
				this.render();
			});
		}
	}

	private _renderPending(pending: IChatPendingSend): void {
		const row = append(this._log, $('.livecollab-chat-message.pending.mine.run-start'));
		row.dataset.requestKey = pending.requestKey;
		append(row, $('.livecollab-chat-avatar'));
		const body = append(row, $('.livecollab-chat-body'));
		this._renderParts(append(body, $('.livecollab-chat-text')), pending.parts);
		const status = append(body, $('.livecollab-chat-status'));
		if (pending.state === 'sending') {
			status.textContent = localize('livecollab.chat.sending', "Sending…");
			return;
		}
		row.classList.add('not-sent');
		append(status, $('span.livecollab-chat-not-sent')).textContent = localize('livecollab.chat.notSent', "Not sent");
		append(status, $('span.livecollab-chat-reason')).textContent = this._reason(pending.error);
		// One group, so the two stay side by side however narrow the view.
		const choices = append(status, $('span.livecollab-chat-choices'));
		this._button(choices, localize('livecollab.chat.retry', "Retry"), () => { void this._service.chat.retry(pending.requestKey); });
		this._button(choices, localize('livecollab.chat.discard', "Discard"), () => this._service.chat.discard(pending.requestKey));
	}

	private _renderEditor(body: HTMLElement, message: IChatMessage): void {
		const editing = this._editing!;
		const input = append(body, $('textarea.livecollab-chat-input.edit')) as HTMLTextAreaElement;
		input.value = editing.text;
		this._rendered.add(addDisposableListener(input, EventType.INPUT, (e: InputEvent) => {
			editing.text = input.value;
			editing.tags.changed(input.value, input.selectionStart, isUndoOrRedo(e.inputType));
		}));
		input.setAttribute('aria-label', localize('livecollab.chat.editMessage', "Edit message"));
		const hint = append(body, $('.livecollab-chat-status'));
		hint.textContent = editing.error ?? localize('livecollab.chat.editHint', "Enter to save, Escape to cancel");
		this._rendered.add(addDisposableListener(input, EventType.KEY_DOWN, async (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				this._editing = undefined;
				this.render();
			} else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				const parts = editing.tags.parts(input.value);
				const result = await this._service.chat.edit(message.id, parts, editing.revision);
				if (result.ok) {
					this._editing = undefined;
				} else if (this._editing?.id === message.id) {
					// Stale: changed in another window. The text stays; saving again,
					// now from that version, replaces it.
					this._editing = { ...editing, revision: result.message?.revision ?? editing.revision, gone: result.error === 'not_found', error: this._reason(result.error) };
				}
				this.render();
			}
		}));
		getWindow(input).setTimeout(() => input.focus());
	}

	/** A message removed while it was being edited: what was typed stays, to copy or discard. */
	private _renderOrphan(editing: NonNullable<LiveCollabChatWidget['_editing']>): void {
		const row = append(this._log, $('.livecollab-chat-orphan.mine'));
		const body = append(row, $('.livecollab-chat-body'));
		append(body, $('.livecollab-chat-text')).textContent = editing.text;
		const status = append(body, $('.livecollab-chat-status'));
		append(status, $('span')).textContent = localize('livecollab.chat.editedMessageGone', "This message was removed while you were editing it. Your text is kept here.");
		const choices = append(status, $('span.livecollab-chat-choices'));
		this._button(choices, localize('livecollab.chat.copy', "Copy"), () => this._host.copy(editing.text));
		this._button(choices, localize('livecollab.chat.discard', "Discard"), () => {
			this._editing = undefined;
			this.render();
		});
	}

	/** A draft kept aside when two windows changed it at once: shown as it would send, never sent by itself. */
	private _renderKept(kept: IKeptChatDraft): void {
		const owner = this._draftOwner!;
		const row = append(this._log, $('.livecollab-chat-orphan.livecollab-chat-kept.mine'));
		const body = append(row, $('.livecollab-chat-body'));
		this._renderParts(append(body, $('.livecollab-chat-text')), new ComposerTags(kept.text, kept.tags).parts(kept.text));
		const status = append(body, $('.livecollab-chat-status'));
		append(status, $('span')).textContent = localize('livecollab.chat.draftKept', "This draft was changed in two windows at once, so it's kept here. It hasn't been sent.");
		const choices = append(status, $('span.livecollab-chat-choices'));
		this._button(choices, localize('livecollab.chat.continueEditing', "Continue Editing"), () => this._continueKept(kept));
		this._button(choices, localize('livecollab.chat.copy', "Copy"), () => this._host.copy(kept.text));
		this._button(choices, localize('livecollab.chat.discard', "Discard"), () => this._drafts.discard(owner.userId, owner.roomId, kept.id));
	}

	/**
	 * Puts a kept draft back in the composer, its tags as tags. A different
	 * draft already there (text or tags) is kept aside first, so nothing is
	 * replaced silently. Nothing is sent.
	 */
	private _continueKept(kept: IKeptChatDraft): void {
		const owner = this._draftOwner!;
		const mine: IChatDraft = { text: this._composer.value, tags: [...this._composerTags.tags] };
		if (mine.text && !sameDraft(mine, kept)) {
			this._drafts.keep(owner.userId, owner.roomId, generateUuid(), mine);
		}
		this._composer.value = kept.text;
		this._composerTags.reset(kept.text, kept.tags);
		this._closeSuggestions();
		this._saveDraft();
		this._drafts.discard(owner.userId, owner.roomId, kept.id);
		this.render();
		this._composer.focus();
		this._composer.setSelectionRange(kept.text.length, kept.text.length);
	}

	private _renderParts(container: HTMLElement, parts: readonly ChatPart[]): void {
		for (const part of parts) {
			if (part.type === 'text') {
				for (const segment of textSegments(part.text)) {
					if (segment.kind === 'text') {
						append(container, $('span')).textContent = segment.value;
					} else if (segment.kind === 'code') {
						const code = append(container, $('code.livecollab-chat-code'));
						code.textContent = segment.value;
						code.style.tabSize = String(this._tabSize);
					} else if (segment.kind === 'block') {
						const block = append(container, $('pre.livecollab-chat-block'));
						block.textContent = segment.value;
						block.style.tabSize = String(this._tabSize);
					} else {
						const link = append(container, $('a.livecollab-chat-link')) as HTMLAnchorElement;
						link.textContent = segment.value;
						link.href = segment.value;
						this._rendered.add(addDisposableListener(link, EventType.CLICK, e => {
							e.preventDefault();
							this._host.openLink(segment.value);
						}));
					}
				}
			} else if (part.type === 'person') {
				const person = append(container, $('span.livecollab-chat-person'));
				person.textContent = `@${nameForDisplay(this._tagName(part))}`;
				person.dir = 'auto';
			} else {
				this._renderFileTag(container, part);
			}
		}
	}

	private _renderFileTag(container: HTMLElement, part: Extract<ChatPart, { type: 'file' }>): void {
		const state = this.fileTagState(part.fileId);
		const current = state === 'resolved' ? this._fileSystem.getPathForServerFileId(part.fileId) : undefined;
		const path = current ?? part.path ?? part.name ?? '';
		const name = current ? current.split('/').pop()! : part.name ?? path.split('/').pop() ?? '';
		const pill = append(container, $(`span.livecollab-chat-file.${state}`));
		pill.dataset.fileId = part.fileId;
		pill.textContent = state === 'deleted' ? localize('livecollab.chat.fileDeleted', "{0} (deleted)", name) : name;
		this._rendered.add(this._host.hover(pill, state === 'unavailable'
			? localize('livecollab.chat.fileUnavailable', "{0} isn't available right now", path)
			: path));
		if (state === 'resolved') {
			pill.tabIndex = 0;
			pill.setAttribute('role', 'link');
			const open = () => {
				const resource = this._fileResource(part.fileId);
				if (resource) {
					this._host.openFile(resource);
				}
			};
			this._rendered.add(addDisposableListener(pill, EventType.CLICK, open));
			this._rendered.add(addDisposableListener(pill, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter') {
					open();
				}
			}));
		}
	}

	/**
	 * A file tag's state: resolved when the file is in the room as this window
	 * has it (connected, and the id in its tree); deleted only when this window
	 * saw it deleted; unavailable otherwise. Never "deleted" on a guess.
	 */
	fileTagState(fileId: string): FileTagState {
		if (this._deletedFiles.has(fileId) && this._fileSystem.getPathForServerFileId(fileId) === undefined) {
			return 'deleted';
		}
		return this._service.isConnected && this._fileResource(fileId) ? 'resolved' : 'unavailable';
	}

	private _fileResource(fileId: string): URI | undefined {
		const path = this._fileSystem.getPathForServerFileId(fileId);
		const roomId = this._service.roomId;
		if (path === undefined || !roomId) {
			return undefined;
		}
		if (this._service.myRole === 'owner') {
			const real = this._fileSystem.getRealPathForItemPath(path);
			return real ? URI.file(real) : undefined;
		}
		return URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: `/${path}` });
	}

	private _renderSelectBar(): void {
		clearNode(this._selectBar);
		this._selectBar.classList.toggle('visible', !!this._selected);
		if (!this._selected) {
			return;
		}
		const chat = this._service.chat;
		const ids = [...this._selected];
		const others = chat.messages.some(m => this._selected!.has(m.id) && m.authorId !== this._service.myUserId);
		append(this._selectBar, $('span.livecollab-chat-select-count')).textContent = ids.length === 1
			? localize('livecollab.chat.oneSelected', "1 selected")
			: localize('livecollab.chat.selected', "{0} selected", ids.length);
		const forMe = this._button(this._selectBar, localize('livecollab.chat.deleteForMe', "Delete for Me"), () => this._delete(ids, 'me'));
		const forEveryone = this._button(this._selectBar, localize('livecollab.chat.deleteForEveryone', "Delete for Everyone"), () => this._delete(ids, 'everyone'));
		forMe.disabled = ids.length === 0;
		forEveryone.disabled = ids.length === 0 || others;
		if (others) {
			this._rendered.add(this._host.hover(forEveryone, localize('livecollab.chat.onlyYours', "Only your own messages can be deleted for everyone.")));
			append(this._selectBar, $('span.livecollab-chat-select-why')).textContent = localize('livecollab.chat.onlyYours', "Only your own messages can be deleted for everyone.");
		}
		this._button(this._selectBar, localize('livecollab.chat.cancel', "Cancel"), () => {
			this._selected = undefined;
			this.render();
		});
		if (this._selectError) {
			append(this._selectBar, $('span.livecollab-chat-select-why')).textContent = this._selectError;
		}
	}

	private async _delete(ids: number[], scope: 'me' | 'everyone'): Promise<void> {
		const result = await this._service.chat.delete(ids, scope);
		if (result.ok) {
			this._selected = undefined;
		} else {
			this._selectError = this._reason(result.error);
		}
		this.render();
	}

	private _renderJump(): void {
		// A log with no height isn't on screen: nothing to jump to.
		const away = this._log.clientHeight > 0 && !this._isAtBottom();
		this._jump.classList.toggle('visible', away);
		const unread = this._service.chat.unread;
		this._jump.textContent = unread > 0
			? localize('livecollab.chat.jumpNew', "{0} new ↓", unread)
			: localize('livecollab.chat.jump', "Jump to Latest ↓");
	}

	private _renderTime(element: HTMLElement, createdAt: number): void {
		element.textContent = chatTime(createdAt);
		this._rendered.add(this._host.hover(element, new Date(createdAt).toLocaleString()));
	}

	private _action(container: HTMLElement, label: string, run: () => void): HTMLButtonElement {
		const button = this._button(container, label, run);
		button.classList.add('livecollab-chat-action');
		return button;
	}

	private _button(container: HTMLElement, label: string, run: () => void): HTMLButtonElement {
		const button = append(container, $('button.livecollab-chat-button')) as HTMLButtonElement;
		button.textContent = label;
		this._rendered.add(addDisposableListener(button, EventType.CLICK, e => {
			e.preventDefault();
			run();
		}));
		return button;
	}

	private _isAtBottom(): boolean {
		return this._log.scrollTop + this._log.clientHeight >= this._log.scrollHeight - 4;
	}

	/** Whether the reader is at the latest; the last answer while the log has no height. */
	private _readerAtLatest(): boolean {
		if (this._log.clientHeight > 0) {
			this._atLatest = this._isAtBottom();
		}
		return this._atLatest;
	}

	private _onResize(): void {
		if (this._atLatest) {
			this._log.scrollTop = this._log.scrollHeight;
		}
		this._readerAtLatest();
		this._renderJump();
		this._markReadIfSeen();
	}

	private _scrollToLatest(): void {
		this._log.scrollTop = this._log.scrollHeight;
		this._readerAtLatest();
		this._renderJump();
		this._markReadIfSeen();
	}

	private _onScroll(): void {
		this._readerAtLatest();
		this._renderJump();
		this._markReadIfSeen();
		const chat = this._service.chat;
		if (this._log.scrollTop < LOAD_OLDER_PX && chat.hasMore && !this._loadingOlder) {
			void this._loadOlder();
		}
	}

	/** Loads the page before, keeping the reader where they were. */
	private async _loadOlder(): Promise<void> {
		this._loadingOlder = true;
		try {
			await this._service.chat.loadOlder();
		} finally {
			this._loadingOlder = false;
			this.render();
		}
	}

	/** The read position moves to the latest message only while it is on screen, in a focused window. */
	private _markReadIfSeen(): void {
		const chat = this._service.chat;
		const latest = chat.messages.at(-1);
		if (this._visible && latest && latest.id > chat.readUpTo && this._isAtBottom() && this._host.hasFocus()) {
			void chat.markRead(latest.id);
		}
	}

	// ---- The composer ----

	private _onComposerKey(e: KeyboardEvent): void {
		if (this._suggestions.length > 0) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				const step = e.key === 'ArrowDown' ? 1 : -1;
				this._suggestIndex = (this._suggestIndex + step + this._suggestions.length) % this._suggestions.length;
				this._renderSuggestions();
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				this._pick(this._suggestions[this._suggestIndex]);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				this._closeSuggestions();
				return;
			}
		}
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			this._send();
		}
	}

	private _send(): void {
		const text = this._composer.value;
		if (!text.trim()) {
			return;
		}
		const parts = this._composerTags.parts(text);
		this._composer.value = '';
		this._composerTags.reset('');
		this._saveDraft();
		this._closeSuggestions();
		void this._service.chat.send(parts);
		this._scrollToLatest();
	}

	/** Types `text` into the composer at the caret, as typing or a paste would. */
	insert(text: string): void {
		this._replace(this._composer.selectionStart, this._composer.selectionEnd, text);
	}

	/**
	 * Replaces `start` to `end` in the composer with `text` as an edit the
	 * composer's own undo and redo know about (setting its value would clear
	 * them), the caret after it.
	 */
	private _replace(start: number, end: number, text: string): void {
		const composer = this._composer;
		composer.focus();
		composer.setSelectionRange(start, end);
		if (!composer.ownerDocument.execCommand('insertText', false, text)) {
			// Not editable as a document edit here: the same change, without undo.
			composer.value = composer.value.slice(0, start) + text + composer.value.slice(end);
			composer.setSelectionRange(start + text.length, start + text.length);
			this._onComposerInput(undefined);
		}
	}

	private _onComposerInput(inputType: string | undefined): void {
		this._composerTags.changed(this._composer.value, this._composer.selectionStart, isUndoOrRedo(inputType));
		this._saveDraft();
		this._updateSuggestions();
	}

	/**
	 * The composer holds the draft of the account and room now open: on a
	 * change of either, the one for the new pair (or nothing) takes its place.
	 * What was there is already kept, as every change is.
	 */
	private _syncDraft(): void {
		const userId = this._service.myUserId;
		const roomId = this._service.roomId;
		const owner = userId && roomId ? { userId, roomId } : undefined;
		if (owner?.userId === this._draftOwner?.userId && owner?.roomId === this._draftOwner?.roomId) {
			return;
		}
		this._draftOwner = owner;
		this._draftSeen = {};
		this._draftPruned = false;
		const draft = owner ? this._drafts.get(owner.userId, owner.roomId) : undefined;
		this._showDraft(draft);
	}

	private _showDraft(draft: IStoredChatDraft | undefined): void {
		this._draftHeld = draft && draftVersion(draft);
		this._draftSeen = draft ? mergeSeen(this._draftSeen, draft.seen) : this._draftSeen;
		this._draftPruned ||= draft?.pruned === true;
		this._draftTyped = false;
		this._composer.value = draft?.text ?? '';
		this._composerTags.reset(draft?.text ?? '', draft?.tags ?? []);
		this._closeSuggestions();
	}

	/** Stores the composer as a new version over the one it holds. */
	private _saveDraft(): void {
		if (this._draftOwner) {
			const version = { writer: this._draftWriter, seq: ++this._draftSeq };
			this._draftSeen = { ...this._draftSeen, [version.writer]: version.seq };
			this._draftHeld = draftVersion(version);
			this._draftTyped = true;
			this._drafts.set(this._draftOwner.userId, this._draftOwner.roomId, { ...version, seen: this._draftSeen, pruned: this._draftPruned, text: this._composer.value, tags: this._composerTags.tags });
		}
	}

	/**
	 * The stored draft for this account and room changed. Each window hears of
	 * another's writes, and its own, a moment later and only the latest of
	 * them (VS Code's storage flushes one value per key after 100 ms, and the
	 * main process tells every window each key's value then), so:
	 * - a version this window has already passed (its own, heard back however
	 *   late, or one at or before another window's latest it has seen) changes
	 *   nothing, so an older version arriving late never reverts the text;
	 * - one written over the version this window holds (its `seen` reaches it),
	 *   or, while this window hasn't typed since the last it took, one it can
	 *   place as newer (from a writer it knows, or any while what it knows is
	 *   complete), is the same draft moving on, typed or sent elsewhere: shown
	 *   here too;
	 * - past WRITERS_KEPT a writer can be dropped from what this window knows:
	 *   a version from a writer it can't place may then be newer or long passed,
	 *   so it's treated as written without seeing this window's, below;
	 * - otherwise both windows wrote without seeing the other's: whichever
	 *   texts differ are kept aside, tags and all, in storage (they outlive a
	 *   restart), and the composer starts empty, so no window's text silently
	 *   replaces another's and nothing is sent by itself (CHAT_DESIGN.md,
	 *   Composer: proposed, awaiting Manny's approval).
	 */
	private _onStoredDraftChanged(): void {
		const owner = this._draftOwner!;
		const stored = this._drafts.get(owner.userId, owner.roomId);
		if (!stored || stored.writer === this._draftWriter || (this._draftSeen[stored.writer] ?? 0) >= stored.seq) {
			return;
		}
		const held = this._draftHeld === undefined ? undefined : parseDraftVersion(this._draftHeld);
		const writtenOverHeld = !held || (stored.seen[held.writer] ?? 0) >= held.seq;
		const placed = this._draftSeen[stored.writer] !== undefined || !this._draftPruned;
		if (writtenOverHeld || (!this._draftTyped && placed)) {
			this._showDraft(stored);
			this.render();
			return;
		}
		const mine: IChatDraft = { text: this._composer.value, tags: [...this._composerTags.tags] };
		if (!this._draftTyped) {
			lcLog.info('[LiveCollab] chat draft: a version from a writer this window can\'t place (writers past the last 64 were dropped): both kept');
		}
		if (sameDraft(mine, stored)) {
			// Both wrote the same thing: one draft, now this version. The composer is left as it is.
			this._draftHeld = draftVersion(stored);
			this._draftSeen = mergeSeen(this._draftSeen, stored.seen);
			this._draftTyped = false;
			return;
		}
		if (mine.text) {
			this._drafts.keep(owner.userId, owner.roomId, this._draftHeld ?? generateUuid(), mine);
		}
		if (stored.text) {
			this._drafts.keep(owner.userId, owner.roomId, draftVersion(stored), stored);
		}
		// Typed in the other window before it heard: the same draft moving on
		// from a version already kept aside replaces that one, so one draft
		// typed on keeps one row.
		for (const entry of this._drafts.kept(owner.userId, owner.roomId)) {
			const earlier = parseDraftVersion(entry.id);
			if (earlier && entry.id !== draftVersion(stored) && (stored.seen[earlier.writer] ?? 0) >= earlier.seq) {
				this._drafts.discard(owner.userId, owner.roomId, entry.id);
			}
		}
		this._showDraft({ ...stored, text: '', tags: [] });
		this._saveDraft();
		this.render();
	}

	private _onPaste(e: ClipboardEvent): void {
		const pasted = e.clipboardData?.getData('text/plain');
		if (pasted === undefined || !pasted.includes('\n')) {
			return;
		}
		e.preventDefault();
		this.insert(pastedText(pasted));
	}

	private _updateSuggestions(): void {
		const mention = mentionAt(this._composer.value, this._composer.selectionStart);
		if (!mention) {
			this._closeSuggestions();
			return;
		}
		const query = mention.query.toLowerCase();
		const people: ISuggestion[] = this._service.lastMembers
			.map(m => ({ userId: m.userId, name: this._service.memberName(m.userId) }))
			.filter(m => m.name.toLowerCase().includes(query))
			.slice(0, SUGGEST_LIMIT)
			.map(m => ({ section: 'people', label: m.name, token: `@${m.name}`, part: { type: 'person', userId: m.userId } }));
		const files = this._roomFiles();
		const sameName = (name: string) => files.filter(f => f.name === name).length > 1;
		const fileSuggestions: ISuggestion[] = files
			.filter(f => f.name.toLowerCase().includes(query) || f.path.toLowerCase().includes(query))
			.slice(0, SUGGEST_LIMIT)
			.map(f => ({ section: 'files', label: f.name, detail: sameName(f.name) ? f.path : undefined, token: `@${f.name}`, part: { type: 'file', fileId: f.id } }));
		this._suggestions = [...people, ...fileSuggestions];
		this._suggestIndex = 0;
		this._renderSuggestions();
	}

	/** The room's files, never its folders, as this window has them. */
	private _roomFiles(): { id: string; path: string; name: string }[] {
		return this._fileSystem.serverFiles()
			.map(([path, id]) => ({ id, path, name: path.split('/').pop()! }))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	private _renderSuggestions(): void {
		this._suggestRendered.clear();
		clearNode(this._suggest);
		this._suggest.classList.toggle('visible', this._suggestions.length > 0);
		let section: string | undefined;
		this._suggestions.forEach((suggestion, index) => {
			if (suggestion.section !== section) {
				section = suggestion.section;
				append(this._suggest, $('.livecollab-chat-suggest-heading')).textContent = section === 'people'
					? localize('livecollab.chat.people', "People")
					: localize('livecollab.chat.files', "Files");
			}
			const row = append(this._suggest, $(`.livecollab-chat-suggest-row.${suggestion.section}`));
			row.setAttribute('role', 'option');
			row.classList.toggle('selected', index === this._suggestIndex);
			row.setAttribute('aria-selected', String(index === this._suggestIndex));
			if (suggestion.section === 'files') {
				append(row, $('span.codicon.codicon-file'));
			}
			const label = append(row, $('span.livecollab-chat-suggest-label'));
			label.textContent = suggestion.section === 'people' ? nameForDisplay(suggestion.label) : suggestion.label;
			label.dir = 'auto';
			if (suggestion.detail) {
				append(row, $('span.livecollab-chat-suggest-detail')).textContent = suggestion.detail;
			}
			this._suggestRendered.add(addDisposableListener(row, EventType.MOUSE_DOWN, e => {
				e.preventDefault();
				this._pick(suggestion);
			}));
		});
	}

	private _pick(suggestion: ISuggestion): void {
		const caret = this._composer.selectionStart;
		const mention = mentionAt(this._composer.value, caret);
		if (!mention) {
			this._closeSuggestions();
			return;
		}
		this._replace(mention.start, caret, suggestion.token + ' ');
		// Each tag keeps its own place, so two with the same text stay two.
		this._composerTags.add({ start: mention.start, text: suggestion.token, part: suggestion.part });
		this._saveDraft();
		this._closeSuggestions();
	}

	private _closeSuggestions(): void {
		this._suggestions = [];
		this._renderSuggestions();
	}

	/** What the @ list currently offers, as "section: label". */
	get suggestions(): string[] {
		return this._suggestions.map(s => `${s.section}: ${s.label}${s.detail ? ` (${s.detail})` : ''}`);
	}

	/** Picks the @ list's entry at `index`, as a click would. */
	pickSuggestion(index: number): void {
		this._pick(this._suggestions[index]);
	}

	/** Sends what the composer holds, as Enter would. */
	sendComposer(): void {
		this._send();
	}

	// ---- Names ----

	private _memberIndex(userId: string): number {
		const index = this._service.lastMembers.findIndex(m => m.userId === userId);
		return index < 0 ? 0 : index;
	}

	private _tagName(part: ChatPart): string {
		if (part.type === 'person') {
			return this._service.memberName(part.userId, part.name);
		}
		if (part.type === 'file') {
			const current = this.fileTagState(part.fileId) === 'resolved' ? this._fileSystem.getPathForServerFileId(part.fileId) : undefined;
			return current ? current.split('/').pop()! : part.name ?? '';
		}
		return part.text;
	}

	private _reason(error: string | undefined): string {
		switch (error) {
			case 'offline': return localize('livecollab.chat.offline', "You're offline.");
			case 'no_answer': return localize('livecollab.chat.noAnswer', "The room didn't answer. It may have arrived; retrying won't post it twice.");
			case 'not_saved': return localize('livecollab.chat.notSaved', "The room couldn't save it.");
			case 'unknown_person': return localize('livecollab.chat.unknownPerson', "Someone you tagged isn't in the room.");
			case 'unknown_file': return localize('livecollab.chat.unknownFile', "A file you tagged isn't in the room.");
			case 'too_long': return localize('livecollab.chat.tooLong', "It's too long.");
			case 'empty': return localize('livecollab.chat.empty', "There's nothing to send.");
			case 'not_yours': return localize('livecollab.chat.notYours', "Only your own messages can be changed for everyone.");
			case 'stale': return localize('livecollab.chat.stale', "You changed this message in another window. Enter saves this text over it; Escape keeps that version.");
			case 'not_found': return localize('livecollab.chat.notFound', "This message no longer exists.");
			default: return localize('livecollab.chat.refused', "The room refused it ({0}).", error ?? 'unknown');
		}
	}
}

/** Whether an input event was the composer's own undo or redo. */
function isUndoOrRedo(inputType: string | undefined): boolean {
	return inputType === 'historyUndo' || inputType === 'historyRedo';
}
