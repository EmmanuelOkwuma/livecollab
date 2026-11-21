/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/path.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { localize } from '../../../../nls.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { INotificationService, IPromptChoice, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { SaveReason } from '../../../common/editor.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { LiveCollabService } from './livecollabService.js';
import { LiveCollabFileSystemProvider } from './livecollabFileSystemProvider.js';
import { ILiveCollabClient } from './livecollabClient.js';
import { lcLog } from './livecollabLog.js';

// ROOM_SAVE_DESIGN.md, piece 1: every room edit reaches the owner's disk,
// whoever made it and whether or not anyone has the file open.

/** How long a file waits after its last change before it is written. */
const QUIET_MS = 750;
/** The longest a changing file waits from its first unwritten change. */
const MAX_WAIT_MS = 5000;
/** How many files a notice names. */
const FILES_NAMED_IN_NOTICE = 3;
/**
 * How long a file whose room text this machine doesn't hold may wait before
 * the owner is told: long enough for the attach snapshot to land.
 */
const UNKNOWN_TEXT_GRACE_MS = 15_000;
/** Read-only documents holding a file's room text, for Compare. */
const ROOM_VERSION_SCHEME = 'livecollab-room-version';

/**
 * A file the room couldn't write:
 * - `changedOutside`: the disk changed since LiveCollab last wrote it.
 * - `noHistory`: LiveCollab has never written it from this machine (a room
 *   from before this version), and the disk and the room differ, so which is
 *   newer can't be told. Not called an outside change: it usually isn't one.
 */
type ConflictKind = 'changedOutside' | 'noHistory';

interface IConflict {
	readonly fileId: string;
	readonly path: string;
	readonly kind: ConflictKind;
}

/**
 * What to do with one file:
 * - `inSync`: the disk already holds the room's text; only remember it.
 * - `write`: the disk holds what LiveCollab last wrote (or nothing, and
 *   LiveCollab never wrote it), so the room's text may replace it.
 * - `conflict`: the disk changed since LiveCollab last wrote it, or there
 *   is no record and it differs: something outside LiveCollab may have
 *   changed it. Never written over without the owner saying so.
 *
 * @param roomText the room's text for the file
 * @param disk the file's text on disk, or undefined if it isn't there
 * @param lastWritten the hash of what LiveCollab last wrote or saw in sync
 */
export function planPersist(roomText: string, disk: string | undefined, lastWritten: string | undefined): 'inSync' | 'write' | 'conflict' {
	if (disk === roomText) {
		return 'inSync';
	}
	if (lastWritten === undefined) {
		return disk === undefined ? 'write' : 'conflict';
	}
	if (disk === undefined) {
		return 'conflict';
	}
	return hashText(disk) === lastWritten ? 'write' : 'conflict';
}

/** The record kept per file: the SHA-1 of the text. */
/**
 * What a change made to a file on the owner's disk outside the app does (Manny, 2026-11-12:
 * outside changes reach the room). The same text as the room's is in sync. What LiveCollab
 * itself last wrote there is its own write, not a change (an echo). Otherwise the disk's text
 * goes to the room when the room hasn't changed since the two last agreed, or when the file is
 * new outside the app and the room only seeded it empty. Changed on both sides is a conflict,
 * left to the owner as one changed outside LiveCollab always is.
 */
export function planOutsideChange(roomText: string, disk: string, lastWritten: string | undefined, isNew: boolean): 'inSync' | 'echo' | 'take' | 'conflict' {
	if (disk === roomText) {
		return 'inSync';
	}
	if (lastWritten !== undefined && hashText(disk) === lastWritten) {
		return 'echo';
	}
	if (lastWritten === undefined ? isNew && roomText === '' : hashText(roomText) === lastWritten) {
		return 'take';
	}
	return 'conflict';
}

export function hashText(text: string): string {
	const sha = new StringSHA1();
	sha.update(text);
	return sha.digest();
}

/** Line endings aside, the same text: a Monaco model normalises them. */
function sameText(a: string, b: string): boolean {
	return a === b || a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}

/**
 * What the persister needs from the folder contribution, which owns the
 * attached folder and the containment rule.
 */
export interface IRoomPersisterHost {
	/**
	 * The folder this machine attached as the room's owner, or undefined when
	 * it may not write (a guest, or no attached folder open).
	 */
	ownerRoot(): URI | undefined;
	/**
	 * Where a room path lives on the owner's disk, or undefined when the
	 * room may not write there (outside the folder, a link, kept out).
	 * Silent: the create or move that put the file there already said so.
	 */
	diskTarget(root: URI, path: string): Promise<URI | undefined>;
	/** The notice button that opens the log. */
	showLogChoice(): IPromptChoice;
}

/** One file to write, everything it needs captured. */
interface IPersistJob {
	readonly roomId: string;
	readonly fileId: string;
	readonly path: string;
	readonly target: URI;
	readonly roomText: string;
	/** Write even if the disk changed outside LiveCollab: the owner chose it. */
	readonly force: boolean;
}

/**
 * Writes every room edit to the owner's disk (ROOM_SAVE_DESIGN.md piece 1).
 * Active only on the owner's machine with the attached folder open; a no-op
 * everywhere else.
 */
export class LiveCollabRoomPersister extends Disposable {

	/** Files waiting to be written, with when their first unwritten change came. */
	private readonly _waiting = new Map<string, { readonly timer: ReturnType<typeof setTimeout>; readonly firstAt: number }>();
	/** Per room: file id -> hash of what LiveCollab last wrote or saw in sync. */
	private readonly _records = new Map<string, Map<string, string>>();
	/** Disk targets judged for this session, by file id, for writes that can't wait. */
	private readonly _targets = new Map<string, { readonly path: string; readonly target: URI }>();
	/** Files the room couldn't write, reported once until resolved. */
	private readonly _conflicts = new Set<string>();
	/** Files skipped because this machine doesn't hold their room text. */
	private readonly _unknownText = new Map<string, string>();
	private _unknownTextCheck: ReturnType<typeof setTimeout> | undefined;
	private _unknownTextReported = false;
	/** Room paths over the share cap: in the room by name only, never written. */
	private readonly _oversize = new Set<string>();
	/**
	 * Files the room deleted this session. The server never gives a deleted file's id to a
	 * new file, so none of these is ever written again: not by a catch-up listed before the
	 * delete, nor by a write already under way when it arrived.
	 */
	private readonly _deleted = new Set<string>();
	/** Writes run one at a time, in order. */
	private _queue: Promise<void> = Promise.resolve();
	/** This client's room service and virtual file system (ILiveCollabClient). */
	private readonly _service: LiveCollabService;
	private readonly _fileSystem: LiveCollabFileSystemProvider;

	constructor(
		private readonly _host: IRoomPersisterHost,
		@IFileService private readonly fileService: IFileService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IEditorService private readonly editorService: IEditorService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@ITextModelService textModelService: ITextModelService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ILiveCollabClient client: ILiveCollabClient,
	) {
		super();
		this._service = client.service;
		this._fileSystem = client.fileSystem;
		// Compare's right-hand side: the room's text, read-only.
		this._register(textModelService.registerTextModelContentProvider(ROOM_VERSION_SCHEME, {
			provideTextContent: resource => this._roomVersionModel(resource),
		}));
		this._register(this._service.onRoomTextChanged(fileId => this._schedule(fileId)));
		this._register(this._service.onFileDeleted(({ files }) => {
			for (const { fileId } of files) {
				this._deleted.add(fileId);
				this._forget(fileId);
			}
		}));
		this._register(this._service.registerRoomState({
			name: 'room persister',
			// The session's documents are about to go: capture every file still
			// waiting, with its text, so it is written after all. What can't be
			// captured stays in the room, and the next catch-up writes it.
			beforeClear: () => this._captureWaiting(),
			clear: () => {
				for (const { timer } of this._waiting.values()) { clearTimeout(timer); }
				this._waiting.clear();
				this._targets.clear();
				this._conflicts.clear();
				this._oversize.clear();
				this._deleted.clear();
				this._unknownText.clear();
				if (this._unknownTextCheck) { clearTimeout(this._unknownTextCheck); this._unknownTextCheck = undefined; }
				this._unknownTextReported = false;
			},
			inspect: () => this._waiting.size ? [`${this._waiting.size} files waiting to be written`] : [],
		}));
		// Quitting: write what's waiting before the window goes.
		this._register(lifecycleService.onWillShutdown(e => {
			if (!this._waiting.size) { return; }
			this._captureWaiting();
			e.join(this._queue, { id: 'livecollab.roomPersister', label: localize('livecollab.persist.shutdown', "Writing the room's edits to disk") });
		}));
	}

	/** The share walk found these room paths over the per-file cap. */
	setOversize(paths: Iterable<string>): void {
		for (const path of paths) { this._oversize.add(path); }
	}

	/**
	 * LiveCollab itself just put `text` in the file on disk (a remote create's
	 * empty file, a move's room copy): remember it, so it isn't mistaken for
	 * a change made outside LiveCollab.
	 */
	noteWritten(fileId: string, text: string): void {
		const roomId = this._service.roomId;
		if (roomId) { this._remember(roomId, fileId, text); }
	}

	/**
	 * `fileId` changed on the owner's disk outside the app while connected: its text goes to the
	 * room by planOutsideChange's rule. Queued with the writes, so a write of this file under way
	 * finishes first and is then recognised as LiveCollab's own.
	 * @param isNew the file was created outside the app, and the room has only just seeded it empty
	 */
	diskChanged(fileId: string, isNew: boolean): void {
		const root = this._host.ownerRoot();
		const roomId = this._service.roomId;
		if (!root || !roomId) { return; }
		this._enqueue(async () => {
			if (this._service.roomId !== roomId || this._deleted.has(fileId)) { return; }
			const path = this._fileSystem.getPathForServerFileId(fileId);
			if (!path || this._oversize.has(path) || !this._service.knowsRoomText(fileId)) { return; }
			const target = await this._host.diskTarget(root, path);
			if (!target || this._service.roomId !== roomId) { return; }
			let disk: string;
			try {
				disk = (await this.fileService.readFile(target)).value.toString();
			} catch {
				return; // gone again: the next batch sees it missing
			}
			const roomText = await this._service.getRoomText(fileId);
			if (this._service.roomId !== roomId || this._deleted.has(fileId)) { return; }
			const lastWritten = this._recordsFor(roomId).get(fileId);
			const plan = planOutsideChange(roomText, disk, lastWritten, isNew);
			if (plan === 'inSync') {
				this._remember(roomId, fileId, disk);
				this._conflicts.delete(fileId);
			} else if (plan === 'conflict') {
				if (!this._conflicts.has(fileId)) {
					this._reportConflicts(roomId, [{ fileId, path, kind: lastWritten === undefined ? 'noHistory' : 'changedOutside' }]);
				}
			} else if (plan === 'take') {
				if (!await this._service.replaceRoomText(fileId, disk)) {
					lcLog.warn('[LiveCollab] outside the app: the text of', path, 'could not be put in the room');
					return;
				}
				this._remember(roomId, fileId, disk);
				this._conflicts.delete(fileId);
				lcLog.info('[LiveCollab] outside the app: the text of', path, 'sent to the room');
			}
		});
	}

	/**
	 * Writes the room's copy of these files back to the owner's disk, where the disk has none: the
	 * owner chose to keep in the room files that are gone from this folder, so the room is right
	 * and the two agree again. A file now on disk at that path is left to the usual catch-up rules,
	 * never overwritten here.
	 */
	writeBackFromRoom(fileIds: Iterable<string>): void {
		const root = this._host.ownerRoot();
		const roomId = this._service.roomId;
		if (!root || !roomId) { return; }
		const ids = [...fileIds];
		this._enqueue(async () => {
			let written = 0;
			for (const fileId of ids) {
				if (this._service.roomId !== roomId) { return; }
				const job = await this._jobFor(root, roomId, fileId, false);
				if (!job) { continue; }
				const absent = !(await this.fileService.exists(job.target));
				const outcome = await this._write(absent ? { ...job, force: true } : job);
				if (outcome === 'written') { written++; }
			}
			lcLog.info(`[LiveCollab] persist: wrote back ${written} of ${ids.length} files kept in the room`);
		});
	}

	/**
	 * The hash of the text this computer last wrote or saw in sync, by file id, for the current
	 * room: what the reconcile matches an offline rename against. Kept across restarts.
	 */
	recordedHashes(): ReadonlyMap<string, string> {
		const roomId = this._service.roomId;
		return roomId ? new Map(this._recordsFor(roomId)) : new Map();
	}

	/**
	 * Writes every room file whose disk copy is behind the room: after an
	 * attach, when edits made while the owner was away are still only in the
	 * room. Files changed outside LiveCollab are reported together.
	 * @param leaveAlone file ids not written: the reconcile is waiting on the owner about them
	 */
	catchUp(leaveAlone: ReadonlySet<string> = new Set()): void {
		const root = this._host.ownerRoot();
		const roomId = this._service.roomId;
		if (!root || !roomId) { return; }
		const files = this._fileSystem.allServerIds().filter(([, id]) => this._service.knowsRoomText(id) && !leaveAlone.has(id));
		lcLog.info(`[LiveCollab] persist: catch-up over ${files.length} files in`, roomId);
		this._enqueue(async () => {
			const conflicts: IConflict[] = [];
			let written = 0;
			for (const [path, fileId] of files) {
				if (this._service.roomId !== roomId) { return; }
				const job = await this._jobFor(root, roomId, fileId, false);
				if (!job) { continue; }
				const outcome = await this._write(job);
				if (outcome === 'written') { written++; }
				if ((outcome === 'changedOutside' || outcome === 'noHistory') && !this._conflicts.has(fileId)) { conflicts.push({ fileId, path, kind: outcome }); }
			}
			lcLog.info(`[LiveCollab] persist: catch-up wrote ${written} files, ${conflicts.length} changed outside LiveCollab`);
			if (conflicts.length) { this._reportConflicts(roomId, conflicts); }
		});
	}

	private _schedule(fileId: string): void {
		if (!this._host.ownerRoot()) { return; }
		const now = Date.now();
		const waiting = this._waiting.get(fileId);
		const firstAt = waiting?.firstAt ?? now;
		if (waiting) { clearTimeout(waiting.timer); }
		const delay = Math.max(0, Math.min(QUIET_MS, firstAt + MAX_WAIT_MS - now));
		const timer = setTimeout(() => {
			this._waiting.delete(fileId);
			this._enqueue(async () => {
				const root = this._host.ownerRoot();
				const roomId = this._service.roomId;
				if (!root || !roomId) { return; }
				const job = await this._jobFor(root, roomId, fileId, false);
				if (!job) { return; }
				const outcome = await this._write(job);
				if ((outcome === 'changedOutside' || outcome === 'noHistory') && !this._conflicts.has(fileId)) {
					this._reportConflicts(roomId, [{ fileId, path: job.path, kind: outcome }]);
				}
			});
		}, delay);
		this._waiting.set(fileId, { timer, firstAt });
	}

	/** Everything a write needs, captured now; undefined when it can't be written. */
	private async _jobFor(root: URI, roomId: string, fileId: string, force: boolean): Promise<IPersistJob | undefined> {
		const path = this._fileSystem.getPathForServerFileId(fileId);
		if (!path || this._deleted.has(fileId)) { return undefined; } // no longer in the room
		if (this._oversize.has(path)) { return undefined; }
		if (!this._service.knowsRoomText(fileId)) {
			lcLog.warn('[LiveCollab] persist: no room text held for', path, '— not written (unknown is not empty)');
			this._unknownText.set(fileId, path);
			this._checkUnknownTextLater(roomId);
			return undefined;
		}
		this._unknownText.delete(fileId);
		const target = await this._host.diskTarget(root, path);
		if (!target || this._service.roomId !== roomId) { return undefined; }
		this._targets.set(fileId, { path, target });
		const roomText = await this._service.getRoomText(fileId);
		if (this._service.roomId !== roomId || this._deleted.has(fileId)) { return undefined; }
		return { roomId, fileId, path, target, roomText, force };
	}

	/**
	 * At the session's end, or quitting: the files still waiting, written with
	 * their text as it is now. Only files whose disk target is already known
	 * this session; the rest stay in the room for the next catch-up.
	 */
	private _captureWaiting(): void {
		const roomId = this._service.roomId;
		if (!roomId || !this._host.ownerRoot()) { return; }
		let left = 0;
		for (const [fileId, { timer }] of this._waiting) {
			clearTimeout(timer);
			const known = this._targets.get(fileId);
			const path = this._fileSystem.getPathForServerFileId(fileId);
			const roomText = this._service.roomTextNow(fileId);
			if (!known || known.path !== path || roomText === undefined || this._oversize.has(known.path)) {
				left++;
				continue;
			}
			const job: IPersistJob = { roomId, fileId, path: known.path, target: known.target, roomText, force: false };
			this._enqueue(async () => { await this._write(job); });
		}
		this._waiting.clear();
		if (left) { lcLog.warn(`[LiveCollab] persist: ${left} files left the session unwritten — still in the room, written at the next catch-up`); }
	}

	private async _write(job: IPersistJob): Promise<'written' | 'inSync' | ConflictKind | 'skipped'> {
		if (this._deleted.has(job.fileId)) { return 'skipped'; }
		try {
			// An editor on the owner holds the file: save through it, so the
			// editor and the disk agree and no "changed on disk" banner shows.
			// Without the save participants, so no formatter rewrites the text
			// and sends the change back into the room.
			const model = this.textFileService.files.get(job.target);
			if (model) {
				const editorText = model.textEditorModel?.getValue();
				if (editorText !== undefined && !sameText(editorText, job.roomText)) {
					lcLog.warn('[LiveCollab] persist: the open editor and the room differ for', job.path, '— not written (the out-of-sync check reports it)');
					return 'skipped';
				}
				if (model.isDirty()) {
					await this.textFileService.save(job.target, { reason: SaveReason.AUTO, skipSaveParticipants: true });
					if (model.isDirty()) { return 'skipped'; } // the save reported its own error
					const saved = await this.fileService.readFile(job.target);
					this._remember(job.roomId, job.fileId, saved.value.toString());
					this._conflicts.delete(job.fileId);
					return 'written';
				}
			}
			let disk: string | undefined;
			let etag: string | undefined;
			let mtime: number | undefined;
			try {
				const content = await this.fileService.readFile(job.target);
				disk = content.value.toString();
				etag = content.etag;
				mtime = content.mtime;
			} catch (e) {
				if (toFileOperationResult(e) !== FileOperationResult.FILE_NOT_FOUND) { throw e; }
			}
			const lastWritten = this._recordsFor(job.roomId).get(job.fileId);
			const plan = job.force ? 'write' : planPersist(job.roomText, disk, lastWritten);
			if (plan === 'inSync') {
				this._remember(job.roomId, job.fileId, job.roomText);
				this._conflicts.delete(job.fileId);
				return 'inSync';
			}
			if (plan === 'conflict') {
				if (lastWritten === undefined) {
					lcLog.warn('[LiveCollab] persist: never written from this machine, and the disk differs from the room —', job.path, '— not written');
					return 'noHistory';
				}
				lcLog.warn('[LiveCollab] persist: changed outside LiveCollab since it was last written —', job.path, '— not written');
				return 'changedOutside';
			}
			// The room may have deleted the file while the reads above waited.
			if (this._deleted.has(job.fileId) || this._service.roomId !== job.roomId) {
				lcLog.info('[LiveCollab] persist: deleted in the room meanwhile —', job.path, '— not written');
				return 'skipped';
			}
			// The etag makes the write refuse if the file changes between the
			// read above and this write.
			await this.fileService.writeFile(job.target, VSBuffer.fromString(job.roomText), disk !== undefined && !job.force ? { etag, mtime } : undefined);
			this._remember(job.roomId, job.fileId, job.roomText);
			this._conflicts.delete(job.fileId);
			lcLog.info('[LiveCollab] persist: wrote', job.path);
			return 'written';
		} catch (e) {
			if (toFileOperationResult(e) === FileOperationResult.FILE_MODIFIED_SINCE) {
				lcLog.warn('[LiveCollab] persist: changed on disk during the write —', job.path, '— not written');
				return 'changedOutside';
			}
			lcLog.error('[LiveCollab] persist: writing', job.path, 'failed:', toErrorMessage(e));
			this.notificationService.prompt(Severity.Error, localize('livecollab.persist.failed', "The room's edits to '{0}' couldn't be written to this computer. They're still in the room. The reason is in the log.", job.path), [this._host.showLogChoice()]);
			return 'skipped';
		}
	}

	/**
	 * Tells the owner which files the room couldn't write. One file: its
	 * choices right in the notice. Several: a list to go through one by one.
	 * Never a one-click overwrite of several files.
	 */
	private _reportConflicts(roomId: string, conflicts: readonly IConflict[]): void {
		for (const { fileId } of conflicts) { this._conflicts.add(fileId); }
		if (conflicts.length === 1) {
			this._askAbout(roomId, conflicts[0]);
			return;
		}
		const named = conflicts.slice(0, FILES_NAMED_IN_NOTICE).map(c => c.path).join(', ');
		const more = conflicts.length - FILES_NAMED_IN_NOTICE;
		const allNoHistory = conflicts.every(c => c.kind === 'noHistory');
		const message = allNoHistory
			? (more > 0
				? localize('livecollab.persist.noHistoryMore', "LiveCollab is saving this room to this computer for the first time. {0} files are different here and in the room, and there's no earlier save to tell which is newer: {1} and {2} more. Nothing was written to them.", conflicts.length, named, more)
				: localize('livecollab.persist.noHistoryMany', "LiveCollab is saving this room to this computer for the first time. {0} files are different here and in the room, and there's no earlier save to tell which is newer: {1}. Nothing was written to them.", conflicts.length, named))
			: (more > 0
				? localize('livecollab.persist.conflictMore', "The room's edits to {0} files weren't written to this computer, because the copies here changed outside LiveCollab or can't be compared: {1} and {2} more. The files here are untouched.", conflicts.length, named, more)
				: localize('livecollab.persist.conflictMany', "The room's edits to {0} files weren't written to this computer, because the copies here changed outside LiveCollab or can't be compared: {1}. The files here are untouched.", conflicts.length, named));
		this.notificationService.prompt(Severity.Warning, message, [
			{ label: localize('livecollab.persist.review', "Review Files..."), run: () => this._review(roomId, conflicts) },
			{ ...this._host.showLogChoice(), isSecondary: true },
		]);
	}

	/** One file: Compare (keeps the notice open), Use Disk Version, Use Room Version (confirmed). */
	private _askAbout(roomId: string, conflict: IConflict): void {
		const message = conflict.kind === 'noHistory'
			? localize('livecollab.persist.noHistoryOne', "'{0}' is different on this computer and in the room, and LiveCollab hasn't saved it here before, so it can't tell which is newer. Nothing was written. Compare them and choose which to keep.", conflict.path)
			: localize('livecollab.persist.conflictOne', "'{0}' changed on this computer outside LiveCollab, so the room's edits weren't written to it. Both versions are kept until you choose.", conflict.path);
		this.notificationService.prompt(Severity.Warning, message, [
			{ label: localize('livecollab.persist.compare', "Compare"), keepOpen: true, run: () => this._compare(roomId, conflict) },
			{ label: localize('livecollab.persist.useDiskVersion', "Use Disk Version"), run: () => this._useDiskVersion(roomId, conflict) },
			{ label: localize('livecollab.persist.useRoomVersion', "Use Room Version..."), run: () => this._useRoomVersion(roomId, conflict) },
			{ ...this._host.showLogChoice(), isSecondary: true },
		]);
	}

	private async _review(roomId: string, conflicts: readonly IConflict[]): Promise<void> {
		const open = conflicts.filter(c => this._conflicts.has(c.fileId));
		const picked = await this.quickInputService.pick(open.map(c => ({
			label: c.path,
			description: c.kind === 'noHistory'
				? localize('livecollab.persist.reviewNoHistory', "different here and in the room")
				: localize('livecollab.persist.reviewChanged', "changed outside LiveCollab"),
			conflict: c,
		})), { placeHolder: localize('livecollab.persist.reviewPlaceholder', "Choose a file to compare and decide") });
		if (!picked || this._service.roomId !== roomId) { return; }
		await this._compare(roomId, picked.conflict);
		this._askAbout(roomId, picked.conflict);
	}

	/** A diff: this computer's copy on the left, the room's on the right. */
	private async _compare(roomId: string, conflict: IConflict): Promise<void> {
		const root = this._host.ownerRoot();
		if (!root || this._service.roomId !== roomId) { return; }
		const target = await this._host.diskTarget(root, conflict.path);
		if (!target) { return; }
		const roomVersion = URI.from({ scheme: ROOM_VERSION_SCHEME, authority: roomId, path: `/${conflict.path}`, query: conflict.fileId });
		// A diff opened earlier keeps its model: bring it up to date.
		const existing = this.modelService.getModel(roomVersion);
		if (existing) { existing.setValue(await this._service.getRoomText(conflict.fileId)); }
		await this.editorService.openEditor({
			original: { resource: target },
			modified: { resource: roomVersion },
			label: localize('livecollab.persist.compareLabel', "{0} (This Computer ↔ Room)", basename(conflict.path)),
			options: { pinned: true },
		});
	}

	private async _roomVersionModel(resource: URI): Promise<ITextModel | null> {
		const fileId = resource.query;
		if (resource.authority !== this._service.roomId || !this._service.knowsRoomText(fileId)) { return null; }
		const text = await this._service.getRoomText(fileId);
		return this.modelService.getModel(resource) ?? this.modelService.createModel(text, this.languageService.createByFilepathOrFirstLine(resource), resource);
	}

	/** This computer's copy wins: it becomes the room's text, for everyone. */
	private _useDiskVersion(roomId: string, conflict: IConflict): void {
		this._enqueue(async () => {
			const root = this._host.ownerRoot();
			if (!root || this._service.roomId !== roomId) { return; }
			const target = await this._host.diskTarget(root, conflict.path);
			if (!target) { return; }
			let disk: string;
			try {
				disk = (await this.fileService.readFile(target)).value.toString();
			} catch (e) {
				lcLog.error('[LiveCollab] persist: Use Disk Version could not read', conflict.path, toErrorMessage(e));
				this.notificationService.prompt(Severity.Error, localize('livecollab.persist.diskUnreadable', "'{0}' couldn't be read on this computer, so the room keeps its version. The reason is in the log.", conflict.path), [this._host.showLogChoice()]);
				return;
			}
			if (!await this._service.replaceRoomText(conflict.fileId, disk)) {
				this.notificationService.prompt(Severity.Error, localize('livecollab.persist.diskNotTaken', "This computer's copy of '{0}' couldn't be put in the room. Nothing changed. The reason is in the log.", conflict.path), [this._host.showLogChoice()]);
				return;
			}
			this._remember(roomId, conflict.fileId, disk);
			this._conflicts.delete(conflict.fileId);
			lcLog.info('[LiveCollab] persist: the owner kept this computer\'s version of', conflict.path, '— now the room\'s text');
		});
	}

	/** The room's copy wins, after the owner confirms losing the one on disk. */
	private async _useRoomVersion(roomId: string, conflict: IConflict): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			message: localize('livecollab.persist.confirmRoomVersion', "Replace '{0}' on this computer with the room's version?", conflict.path),
			detail: localize('livecollab.persist.confirmRoomVersionDetail', "The copy on this computer will be lost. Its changes aren't in the room."),
			primaryButton: localize({ key: 'livecollab.persist.confirmRoomVersionButton', comment: ['&& denotes a mnemonic'] }, "&&Replace"),
		});
		if (!confirmed) {
			this._askAbout(roomId, conflict);
			return;
		}
		this._enqueue(async () => {
			const root = this._host.ownerRoot();
			if (!root || this._service.roomId !== roomId) { return; }
			const job = await this._jobFor(root, roomId, conflict.fileId, true);
			if (job) {
				lcLog.info('[LiveCollab] persist: the owner chose the room version of', job.path);
				await this._write(job);
			}
		});
	}

	/**
	 * A file skipped for unknown room text is told once per session, after a
	 * grace period: right after an attach the snapshot may still be on its
	 * way, and the catch-up it triggers writes the file.
	 */
	private _checkUnknownTextLater(roomId: string): void {
		if (this._unknownTextCheck || this._unknownTextReported) { return; }
		this._unknownTextCheck = setTimeout(() => {
			this._unknownTextCheck = undefined;
			if (this._service.roomId !== roomId) { return; }
			const still = [...this._unknownText].filter(([fileId]) => !this._service.knowsRoomText(fileId) && this._fileSystem.getPathForServerFileId(fileId));
			if (!still.length) { return; }
			this._unknownTextReported = true;
			const named = still.slice(0, FILES_NAMED_IN_NOTICE).map(([, path]) => path).join(', ');
			lcLog.error(`🔴 [LiveCollab] persist: ${still.length} files have room edits this machine can't write (no room text held): ${still.map(([, path]) => path).join(', ')}`);
			this.notificationService.prompt(Severity.Warning, still.length === 1
				? localize('livecollab.persist.unknownOne', "The room's edits to '{0}' can't be written to this computer: it doesn't have the room's copy of that file. The edits are safe in the room. Leave the room and enter it again to retry.", named)
				: localize('livecollab.persist.unknownMany', "The room's edits to {0} files can't be written to this computer: it doesn't have the room's copies ({1}). The edits are safe in the room. Leave the room and enter it again to retry.", still.length, named),
				[this._host.showLogChoice()]);
		}, UNKNOWN_TEXT_GRACE_MS);
	}

	private _enqueue(task: () => Promise<void>): void {
		this._queue = this._queue.then(task, task).catch(e => lcLog.error('[LiveCollab] persist: task failed:', toErrorMessage(e)));
	}

	private _forget(fileId: string): void {
		const waiting = this._waiting.get(fileId);
		if (waiting) { clearTimeout(waiting.timer); this._waiting.delete(fileId); }
		this._targets.delete(fileId);
		this._conflicts.delete(fileId);
		const roomId = this._service.roomId;
		if (roomId && this._recordsFor(roomId).delete(fileId)) { this._storeRecords(roomId); }
	}

	private _remember(roomId: string, fileId: string, text: string): void {
		this._recordsFor(roomId).set(fileId, hashText(text));
		this._storeRecords(roomId);
	}

	// Kept on this machine across quits: after a restart, a file whose disk
	// copy no longer matches what LiveCollab last wrote is a conflict, not a
	// write.
	private _recordsFor(roomId: string): Map<string, string> {
		let records = this._records.get(roomId);
		if (!records) {
			records = new Map();
			try {
				const stored = this.storageService.get(recordsKey(roomId), StorageScope.APPLICATION);
				if (stored) {
					for (const [fileId, hash] of Object.entries(JSON.parse(stored) as Record<string, string>)) { records.set(fileId, hash); }
				}
			} catch (e) {
				lcLog.error('[LiveCollab] persist: unreadable records for', roomId, '— starting empty:', toErrorMessage(e));
			}
			this._records.set(roomId, records);
		}
		return records;
	}

	private _storeRecords(roomId: string): void {
		const records = this._records.get(roomId);
		if (!records) { return; }
		this.storageService.store(recordsKey(roomId), JSON.stringify(Object.fromEntries(records)), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}
}

function recordsKey(roomId: string): string {
	return `livecollab.persisted.${roomId}`;
}
