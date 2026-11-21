/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { InMemoryFileSystemProvider } from '../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IMarkdownString } from '../../../../base/common/htmlContent.js';
import { ILiveCollabTreeItem, livecollabService } from './livecollabService.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { lcLog } from './livecollabLog.js';
import { createFileSystemProviderError, FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType, IFileDeleteOptions, IFileOpenOptions, IFileOverwriteOptions, IFileWriteOptions, IStat } from '../../../../platform/files/common/files.js';

export const LIVECOLLAB_SCHEME = 'livecollab';

/** Where the provider reads a file's room text when it fills from a tree (the room service). */
export interface ILiveCollabRoomDocs {
	hasLiveDoc(fileId: string): boolean;
	getSnapshotText(fileId: string): Promise<string>;
}

export class LiveCollabFileSystemProvider extends InMemoryFileSystemProvider {

	private _roomId: string = '';
	// Real fix (PHASE3_YJS_DESIGN.md section 30, Option A - server
	// assigns identity, not clients). The server now assigns a real,
	// stable id to every file the first time its tree entry is
	// broadcast, and preserves that same id across re-broadcasts. This
	// map stores that server-assigned id per itemPath (the same string
	// used to build this file's livecollab:// URI, so it can be looked
	// up directly from a model's own uri.path when needed), replacing
	// the previous approach of using the client-computed path itself as
	// the sync identity - which never matched between a host's real
	// disk file and a guest's virtual copy of the same conceptual file.
	private readonly _serverFileIds = new Map<string, string>();
	getServerFileId(itemPath: string): string | undefined {
		return this._serverFileIds.get(itemPath);
	}
	// Real fix (PHASE3_YJS_DESIGN.md section 30 follow-up): the host
	// never runs populateFromTree for its own broadcast (socket.to()
	// excludes the sender), so it would never learn its own files'
	// server-assigned ids without this. This stores ids only, without
	// touching the virtual filesystem itself - the host's own files
	// already exist for real on disk, so only the id needs recording.
	/**
	 * Makes the map exactly the room's ids, from an attach's ack (the room's whole tree). Adding
	 * only left an entry for every path the room dropped while the owner was away, and the
	 * persister then aimed at it (ATTACH_RECONCILE_DESIGN.md, "Stale owner map"; matrix #23-#27).
	 */
	replaceServerFileIds(tree: readonly ILiveCollabTreeItem[]): void {
		this._serverFileIds.clear();
		this._serverFolders.clear();
		this.storeServerFileIds(tree);
	}

	// Which of the paths with a server id are folders, from the trees that
	// brought them (a room create is always a file). Lets chat's @ list offer
	// files only, an empty folder included (CHAT_DESIGN.md, Tags).
	private readonly _serverFolders = new Set<string>();

	/** Every file (never a folder) with a server id, as [room path, id]. */
	serverFiles(): [string, string][] {
		return [...this._serverFileIds].filter(([itemPath]) => !this._serverFolders.has(itemPath));
	}

	storeServerFileIds(tree: readonly ILiveCollabTreeItem[], basePath: string = ''): void {
		for (const item of tree) {
			const itemPath = basePath ? `${basePath}/${item.name}` : item.name;
			if (item.id) { this._serverFileIds.set(itemPath, item.id); this._onFileIdsAvailable.fire(); }
			if (item.type === 'directory') { this._serverFolders.add(itemPath); }
			if (item.type === 'directory' && item.children && item.children.length > 0) {
				this.storeServerFileIds(item.children, itemPath);
			}
		}
		if (!basePath) { this._onDidChangeServerFileIds.fire(); }
	}

	/**
	 * Fires when the id map changes through any of its setters (an attach's ack, a create, a
	 * rename, a delete), so the owner can keep a copy across restarts. Not on `clear()`: leaving a
	 * room empties the map, and the copy must outlive that.
	 */
	private readonly _onDidChangeServerFileIds = this._register(new Emitter<void>());
	readonly onDidChangeServerFileIds: Event<void> = this._onDidChangeServerFileIds.event;
	// Real fix (PHASE3_YJS_DESIGN.md section 30 follow-up): the host's
	// own model uri for a real, locally-attached file is its absolute
	// disk path (file:// scheme) - not the relative itemPath used as
	// the key for server-assigned ids. This maps a real, absolute path
	// back to the relative itemPath computed when the tree was first
	// read, so _setupYjsBinding() can translate a host's own file:// uri
	// into the same identity space guests already use for livecollab://
	// files.
	// Real fix (PHASE3_YJS_DESIGN.md section 30 follow-up, real race
	// condition caught before testing): _setupYjsBinding() can genuinely
	// run before either id map above is populated, if a file opens
	// right on room join before the tree finishes reading/broadcasting.
	// The existing code already handles that moment gracefully (skips
	// with a log, doesn't crash) - but without this event, if the id
	// becomes available moments later and the user never happens to
	// switch files afterward, that first file would be permanently
	// stuck with no Yjs binding for the rest of the session. This fires
	// whenever either populateFromTree (guest's own tree arriving) or
	// storeServerFileIds (host learning its own ids back via ack) adds
	// real ids, so a listener can retry a previously-skipped binding.
	private readonly _onFileIdsAvailable = new Emitter<void>();
	readonly onFileIdsAvailable: Event<void> = this._onFileIdsAvailable.event;
	private readonly _realPathToItemPath = new Map<string, string>();
	recordRealPath(realPath: string, itemPath: string): void {
		this._realPathToItemPath.set(realPath, itemPath);
	}
	getItemPathForRealPath(realPath: string): string | undefined {
		return this._realPathToItemPath.get(realPath);
	}
	/** The owner's real disk path for the room file at `itemPath`, if this window has it on disk. */
	getRealPathForItemPath(itemPath: string): string | undefined {
		for (const [realPath, item] of this._realPathToItemPath) {
			if (item === itemPath) { return realPath; }
		}
		return undefined;
	}
	removeRealPath(realPath: string): void {
		this._realPathToItemPath.delete(realPath);
	}
	// Owner-side rename/move: re-key the fsPath -> itemPath map by prefix, so a
	// renamed file (or every descendant of a renamed directory) still resolves
	// its real disk path to the room-relative itemPath. Handles the single-file
	// case too (only the exact fsPath matches).
	rePathRealPaths(oldFsPrefix: string, newFsPrefix: string, oldItemPrefix: string, newItemPrefix: string): void {
		for (const [fsPath, itemPath] of Array.from(this._realPathToItemPath.entries())) {
			if (fsPath === oldFsPrefix || fsPath.startsWith(oldFsPrefix + '/')) {
				this._realPathToItemPath.delete(fsPath);
				this._realPathToItemPath.set(newFsPrefix + fsPath.slice(oldFsPrefix.length), newItemPrefix + itemPath.slice(oldItemPrefix.length));
			}
		}
	}

	// PHASE4 file lifecycle (section 4b): single-file id register/remove/re-key,
	// used when applying a remote create/rename/delete.
	setServerFileId(itemPath: string, id: string): void {
		this._serverFileIds.set(itemPath, id);
		this._onFileIdsAvailable.fire();
		this._onDidChangeServerFileIds.fire();
	}
	removeServerFileId(itemPath: string): void {
		this._serverFolders.delete(itemPath);
		if (this._serverFileIds.delete(itemPath)) { this._onDidChangeServerFileIds.fire(); }
	}
	// Re-key a path -> id mapping, preserving the id. For a directory rename,
	// re-keys every descendant (prefix swap) so all their ids stay stable.
	/**
	 * Every file (not folder) with a server id at `path` or under it, as
	 * [room path, id].
	 */
	/** The room path of the file with server id `id`, or undefined. */
	getPathForServerFileId(id: string): string | undefined {
		for (const [itemPath, itemId] of this._serverFileIds) {
			if (itemId === id) { return itemPath; }
		}
		return undefined;
	}

	/** Every file and folder with a server id, as [room path, id]. */
	allServerIds(): [string, string][] {
		return [...this._serverFileIds];
	}

	serverFilesUnder(path: string): [string, string][] {
		const prefix = path + '/';
		const under = [...this._serverFileIds].filter(([itemPath]) => itemPath === path || itemPath.startsWith(prefix));
		return under.filter(([itemPath]) => !under.some(([other]) => other.startsWith(itemPath + '/')));
	}

	renameServerFileId(oldPath: string, newPath: string, isDirectory: boolean): void {
		if (!isDirectory) {
			const id = this._serverFileIds.get(oldPath);
			if (id === undefined) { return; }
			this._serverFileIds.delete(oldPath);
			this._serverFileIds.set(newPath, id);
			// An editor already on the new name (the renamer's, moved by the workbench) found no
			// id and is waiting for this retry, as a created file's editor does (setServerFileId).
			this._onFileIdsAvailable.fire();
			this._onDidChangeServerFileIds.fire();
			return;
		}
		const oldPrefix = oldPath + '/';
		for (const folder of Array.from(this._serverFolders)) {
			if (folder === oldPath || folder.startsWith(oldPrefix)) {
				this._serverFolders.delete(folder);
				this._serverFolders.add(newPath + folder.slice(oldPath.length));
			}
		}
		for (const [key, id] of Array.from(this._serverFileIds.entries())) {
			if (key === oldPath) {
				this._serverFileIds.delete(key);
				this._serverFileIds.set(newPath, id);
			} else if (key.startsWith(oldPrefix)) {
				this._serverFileIds.delete(key);
				this._serverFileIds.set(newPath + key.slice(oldPath.length), id);
			}
		}
		this._onFileIdsAvailable.fire();
		this._onDidChangeServerFileIds.fire();
	}

	/**
	 * @param warn where the populate guard reports a tree a leave failed to
	 * empty; the window log by default (tests pass a collector).
	 * @param _docs where a file's room text comes from: the window's room
	 * service by default; the layer B harness passes each client's own.
	 */
	constructor(
		private readonly _warn: (message: string) => void = message => lcLog.warn(message),
		private readonly _docs: ILiveCollabRoomDocs = livecollabService,
	) {
		super();
	}

	// Set while this user is a viewer in the room: the whole provider reports
	// Readonly, so editors and the Explorer refuse edits and show this message.
	// LiveCollab's own writes (snapshot, remote create/move/delete) call the
	// provider directly and are unaffected; only the file service checks it.
	private _viewerMessage: IMarkdownString | undefined;

	get readOnlyMessage(): IMarkdownString | undefined { return this._viewerMessage; }

	override get capabilities(): FileSystemProviderCapabilities {
		const base = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileOpenReadWriteClose | FileSystemProviderCapabilities.FileAppend | FileSystemProviderCapabilities.PathCaseSensitive;
		return this._viewerMessage ? base | FileSystemProviderCapabilities.Readonly : base;
	}

	/** Makes the room read-only for this user (`message` says why), or writable again (`undefined`). */
	setViewerReadOnly(message: IMarkdownString | undefined): void {
		const changed = !!message !== !!this._viewerMessage;
		this._viewerMessage = message;
		if (changed) {
			// The base class owns the capability-change event; its own flag is
			// unused because `capabilities` is computed here.
			super.setReadOnly(!!message);
		}
	}

	/**
	 * Makes `roomId` the room this file system serves, called by the snapshot
	 * listener before it populates. Entering a different room empties the
	 * tree first, so a room never starts with another room's files even if
	 * a leave's clear() was missed; a repeat snapshot of the same room
	 * (a re-attach mid-session) leaves the tree and its open files alone.
	 */
	enterRoom(roomId: string): void {
		if (this._roomId === roomId) {
			return;
		}
		// The leave should already have emptied the tree. If it didn't, some
		// way out of a room skipped clear(): say so, with what was left, so
		// the next leak shows in the log instead of in someone's Explorer.
		const left = this.describeContents();
		if (left.count > 0) {
			this._warn(`[LiveCollab] virtual file system was NOT empty entering ${roomId}: ${left.count} entries left from ${this._roomId || '(no room)'}, top level: ${left.topLevel.join(', ')} — emptying it`);
		}
		this.clear();
		this._roomId = roomId;
	}

	/**
	 * Empties the file system and forgets the room (every room-session
	 * teardown, onRoomLeft). The parent keeps every file in one tree under
	 * `root`, looked up by path alone — the room id in a URI never separates
	 * rooms there — so leaving a room must empty that tree, or the next room's
	 * folder shows both rooms' files.
	 */
	clear(): void {
		this._roomId = '';
		this._serverFileIds.clear();
		this._serverFolders.clear();
		this._realPathToItemPath.clear();
		this.root.entries.clear();
	}

	/** The top-level names and the number of entries in the tree, for the log. */
	describeContents(): { count: number; topLevel: string[] } {
		let count = 0;
		const walk = (entries: typeof this.root.entries) => {
			for (const entry of entries.values()) {
				count++;
				if (entry.type === FileType.Directory) {
					walk((entry as typeof this.root).entries);
				}
			}
		};
		walk(this.root.entries);
		return { count, topLevel: [...this.root.entries.keys()].sort() };
	}

	// Every read and write must name the current room: a URI for any other
	// room, or any URI while no room is entered, is not found, so a stale
	// editor or a late event from a left room can never see this room's files.
	private _checkRoom(resource: URI): void {
		if (!this._roomId || resource.authority !== this._roomId) {
			throw createFileSystemProviderError(`not in the current room: ${resource.toString()}`, FileSystemProviderErrorCode.FileNotFound);
		}
	}

	override async stat(resource: URI): Promise<IStat> {
		this._checkRoom(resource);
		return super.stat(resource);
	}

	override async readdir(resource: URI): Promise<[string, FileType][]> {
		this._checkRoom(resource);
		return super.readdir(resource);
	}

	override async readFile(resource: URI): Promise<Uint8Array> {
		this._checkRoom(resource);
		return super.readFile(resource);
	}

	override async writeFile(resource: URI, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
		this._checkRoom(resource);
		return super.writeFile(resource, content, opts);
	}

	override async open(resource: URI, opts: IFileOpenOptions): Promise<number> {
		this._checkRoom(resource);
		return super.open(resource, opts);
	}

	override async rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
		this._checkRoom(from);
		this._checkRoom(to);
		return super.rename(from, to, opts);
	}

	override async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
		this._checkRoom(resource);
		return super.delete(resource, opts);
	}

	override async mkdir(resource: URI): Promise<void> {
		this._checkRoom(resource);
		return super.mkdir(resource);
	}

	// PHASE4 replicate-on-join: populate the virtual filesystem from the
	// snapshot tree, writing each file's REAL seeded content up front (from
	// the server-sent Y.Doc state, decoded via the service) instead of the
	// old empty placeholder + lazy per-file fetch. R2: these writes only
	// ever touch the in-memory livecollab:// filesystem, never real disk.
	// `isCurrent` reports whether the room session that started this populate is
	// still the current one; once it isn't, stop before the next write.
	/** Creates every missing folder above `uri` in the virtual file system. */
	async ensureParentFolders(uri: URI): Promise<void> {
		const parents: URI[] = [];
		for (let parent = dirname(uri); parent.path !== '/' && parent.path !== ''; parent = dirname(parent)) {
			parents.unshift(parent);
		}
		for (const parent of parents) {
			if (!await this._exists(parent)) {
				await this.mkdir(parent);
			}
		}
	}

	private async _exists(uri: URI): Promise<boolean> {
		try {
			await this.stat(uri);
			return true;
		} catch {
			return false;
		}
	}

	async populateFromTree(tree: readonly ILiveCollabTreeItem[], isCurrent: () => boolean, basePath: string = ''): Promise<void> {
		for (const item of tree) {
			if (!isCurrent()) { return; }
			const itemPath = basePath ? `${basePath}/${item.name}` : item.name;
			// Record the server-assigned id so the editor's _getServerFileId
			// can resolve this file to the room-wide sync identity.
			if (item.id) { this._serverFileIds.set(itemPath, item.id); this._onFileIdsAvailable.fire(); }
			if (item.type === 'directory') { this._serverFolders.add(itemPath); }
			const uri = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: this._roomId, path: `/${itemPath}` });
			if (item.type === 'directory') {
				try { await this.mkdir(uri); } catch { }
				if (item.children && item.children.length > 0) {
					await this.populateFromTree(item.children, isCurrent, itemPath);
				}
			} else {
				// A file with a live doc is owned by its binding: rewriting it
				// here (a re-attach snapshot mid-session) would reload a clean
				// open editor from the snapshot, over newer room edits.
				if (item.id && this._docs.hasLiveDoc(item.id) && await this._exists(uri)) { continue; }
				const content = item.id ? await this._docs.getSnapshotText(item.id) : '';
				if (!isCurrent()) { return; }
				try {
					await this.writeFile(uri, VSBuffer.fromString(content).buffer, { create: true, overwrite: true, unlock: false, atomic: false });
				} catch (e) {
					lcLog.error('[LiveCollab] virtual writeFile failed for', itemPath, e);
				}
			}
		}
	}
}

export const livecollabFileSystemProvider = new LiveCollabFileSystemProvider();
