/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What changed while the owner was away, worked out before a re-attach
 * (ATTACH_RECONCILE_DESIGN.md, "Reconcile before the attach"). Paths are room-relative, folders
 * without a trailing slash, as the owner's id map keys them.
 */
export interface IReconcile {
	/** Disk paths left out of the attach, so the server doesn't add back what the room moved or removed. */
	readonly leaveOut: ReadonlySet<string>;
	/** Moved in the room while away: the owner's disk still has it at `from`. */
	readonly movedInRoom: readonly { readonly id: string; readonly from: string; readonly to: string }[];
	/** Removed in the room while away: the owner's disk still has it. */
	readonly removedInRoom: readonly { readonly id: string; readonly path: string }[];
	/** On disk and not in the room or the owner's map: new outside LiveCollab. Sent in the attach. */
	readonly newOutside: readonly string[];
	/** In the room where the owner last knew it, missing from the owner's disk: removed or renamed outside LiveCollab. */
	readonly missingOnDisk: readonly { readonly id: string; readonly path: string }[];
	/**
	 * Changed on both sides: the room moved or removed it, and the owner's disk no longer has it
	 * where it was (renamed or deleted there), or the owner added something inside a folder the
	 * room removed. Which side wins is Manny's ruling, not made yet: until then these are
	 * neither sent nor acted on.
	 */
	readonly twoSided: readonly { readonly path: string; readonly id?: string; readonly roomPath?: string }[];
}

/**
 * Compares the room's ids (`room`), the owner's ids from before the owner went away (`known`),
 * and the paths on the owner's disk now (`disk`).
 */
export function reconcileBeforeAttach(room: ReadonlyMap<string, string>, known: ReadonlyMap<string, string>, disk: ReadonlySet<string>): IReconcile {
	const roomPathOf = new Map<string, string>();
	for (const [path, id] of room) {
		roomPathOf.set(id, path);
	}
	const leaveOut = new Set<string>();
	const movedInRoom: { id: string; from: string; to: string }[] = [];
	const removedInRoom: { id: string; path: string }[] = [];
	const missingOnDisk: { id: string; path: string }[] = [];
	const twoSided: { path: string; id?: string; roomPath?: string }[] = [];
	for (const [path, id] of known) {
		const roomPath = roomPathOf.get(id);
		const onDisk = disk.has(path);
		if (roomPath === path) {
			if (!onDisk) {
				missingOnDisk.push({ id, path });
			}
			continue;
		}
		if (!onDisk) {
			twoSided.push({ path, id, roomPath });
			continue;
		}
		leaveOut.add(path);
		if (roomPath === undefined) {
			removedInRoom.push({ id, path });
		} else {
			movedInRoom.push({ id, from: path, to: roomPath });
		}
	}
	const underLeftOut = (path: string) => [...leaveOut].some(out => path.startsWith(out + '/'));
	const newOutside: string[] = [];
	for (const path of disk) {
		if (room.has(path) || known.has(path) || leaveOut.has(path)) {
			continue;
		}
		if (underLeftOut(path)) {
			// Added by the owner inside a folder the room moved or removed.
			leaveOut.add(path);
			twoSided.push({ path });
			continue;
		}
		newOutside.push(path);
	}
	// A known path under a folder that's left out goes with it, whatever its own state.
	for (const path of disk) {
		if (underLeftOut(path)) {
			leaveOut.add(path);
		}
	}
	return { leaveOut, movedInRoom, removedInRoom, newOutside: newOutside.sort(), missingOnDisk, twoSided };
}

/**
 * What the owner changed on disk while away, to apply to the room (Manny's ruling, 2026-11-05:
 * a rename or delete applies whichever side made it, and everyone is told). Paths in `renames`
 * and `deletes` are the room's: `from` and `path` are where the room has the file now.
 */
export interface IOwnerOfflineChanges {
	/** Renamed on the owner's disk: the room's file moves to the disk path `to`, keeping its id. */
	readonly renames: readonly { readonly id: string; readonly from: string; readonly to: string }[];
	/** Deleted on the owner's disk: removed from the room. A folder takes its contents. */
	readonly deletes: readonly { readonly id: string; readonly path: string }[];
	/** Not applied, and why: left as they are in the room, logged, and told to the owner. */
	readonly held: readonly IHeldChange[];
}

/**
 * A change on the owner's disk the reconcile didn't apply, and why:
 * - `pathTaken`: the room's path for the file is on this disk as another file;
 * - `noRecord`: no record of the file's text on this computer, so a rename can't be told from a delete;
 * - `severalNames`: more than one new file could be its new name (`candidates`);
 * - `sharedName`: the one file that could be its new name could be another missing file's too;
 * - `roomEdited`: deleted here, but edited in the room since this computer last had it;
 * - `folderKeeps`: a folder deleted here, with something under it that stays in the room.
 */
export interface IHeldChange {
	readonly id: string;
	readonly path: string;
	readonly reason: 'pathTaken' | 'noRecord' | 'severalNames' | 'sharedName' | 'roomEdited' | 'folderKeeps';
	readonly candidates?: readonly string[];
}

/**
 * Plans the owner's offline renames and deletes from what the reconcile found missing on disk.
 *
 * A known file is missing from the owner's disk where it was. It was renamed when exactly one
 * file new on disk has the text this computer last had for it (`recorded`, the persister's
 * hash), and no other missing file claims that one. The old path being gone is what makes it a
 * rename: a file whose old path is still on disk is never a candidate, so a match beside it is a
 * copy, sent as new. With no match it was deleted, applied only when the room's text is still
 * what this computer last had: a file the room changed meanwhile isn't deleted. Anything else is
 * held, never guessed: a wrong guess moves a file nobody asked to move.
 *
 * A missing folder is deleted when everything the room has under it is deleted or renamed out
 * by this plan; otherwise it's held.
 *
 * @param room the room's ids by path
 * @param disk the paths on the owner's disk now
 * @param recorded the hash of the text this computer last had, by file id
 * @param roomHashes the hash of the room's text now, by file id
 * @param newOnDisk the hash of each file new on disk (not in the room or known), by path
 */
export function planOwnerOfflineChanges(reconcile: IReconcile, room: ReadonlyMap<string, string>, disk: ReadonlySet<string>, recorded: ReadonlyMap<string, string>, roomHashes: ReadonlyMap<string, string>, newOnDisk: ReadonlyMap<string, string>): IOwnerOfflineChanges {
	const candidates = [
		...reconcile.missingOnDisk.map(({ id, path }) => ({ id, roomPath: path })),
		...reconcile.twoSided.flatMap(({ id, roomPath }) => id && roomPath ? [{ id, roomPath }] : []),
	];
	const isFolder = (roomPath: string) => [...room.keys()].some(path => path.startsWith(roomPath + '/'));
	const files = candidates.filter(c => !isFolder(c.roomPath));
	const folders = candidates.filter(c => isFolder(c.roomPath)).sort((a, b) => b.roomPath.length - a.roomPath.length);
	const held: IHeldChange[] = [];
	const renames: { id: string; from: string; to: string }[] = [];
	const deletes: { id: string; path: string }[] = [];
	const matchesOf = new Map<string, string[]>();
	const claims = new Map<string, number>();
	for (const { id } of files) {
		const hash = recorded.get(id);
		const matches = hash === undefined ? [] : [...newOnDisk].filter(([, h]) => h === hash).map(([path]) => path);
		matchesOf.set(id, matches);
		for (const path of matches) {
			claims.set(path, (claims.get(path) ?? 0) + 1);
		}
	}
	for (const { id, roomPath } of files) {
		const matches = matchesOf.get(id)!;
		if (disk.has(roomPath)) {
			held.push({ id, path: roomPath, reason: 'pathTaken' });
		} else if (!recorded.has(id)) {
			held.push({ id, path: roomPath, reason: 'noRecord' });
		} else if (matches.length === 1 && claims.get(matches[0]) === 1) {
			renames.push({ id, from: roomPath, to: matches[0] });
		} else if (matches.length > 1) {
			held.push({ id, path: roomPath, reason: 'severalNames', candidates: matches });
		} else if (matches.length === 1) {
			held.push({ id, path: roomPath, reason: 'sharedName', candidates: matches });
		} else if (roomHashes.get(id) === recorded.get(id)) {
			deletes.push({ id, path: roomPath });
		} else {
			held.push({ id, path: roomPath, reason: 'roomEdited' });
		}
	}
	const goneFromRoom = (path: string) => renames.some(r => r.from === path) || deletes.some(d => d.path === path || path.startsWith(d.path + '/'));
	for (const { id, roomPath } of folders) {
		const inside = [...room.keys()].filter(path => path.startsWith(roomPath + '/'));
		if (disk.has(roomPath) || !inside.every(goneFromRoom)) {
			held.push({ id, path: roomPath, reason: 'folderKeeps' });
			continue;
		}
		// The folder's delete takes what's under it. Its files renamed out go first (renames are sent first).
		for (let i = deletes.length - 1; i >= 0; i--) {
			if (deletes[i].path.startsWith(roomPath + '/')) {
				deletes.splice(i, 1);
			}
		}
		deletes.push({ id, path: roomPath });
	}
	return { renames, deletes, held };
}

/**
 * The room's moves to make on the owner's disk: a folder's move carries what's under it, so a
 * move that only follows from an outer one is dropped.
 */
export function outermostMoves(moves: IReconcile['movedInRoom']): IReconcile['movedInRoom'] {
	return moves.filter(move => !moves.some(outer => outer !== move && move.from.startsWith(outer.from + '/') && move.to === outer.to + move.from.substring(outer.from.length)));
}

/** What the room removed while the owner was away, as it reaches the owner's disk. */
export interface IRoomRemovals {
	/** To the owner's Trash (never unlinked), outermost paths: a folder takes what's under it. */
	readonly trash: readonly string[];
	/** Kept on the owner's disk and sent back to the room as new files: changed by the owner meanwhile. */
	readonly sendBack: readonly { readonly path: string; readonly reason: string }[];
}

/**
 * Plans how the room's removals reach the owner's disk (decided 2026-11-05: as in Dropbox, Drive
 * and OneDrive, a member's delete removes the file from every member's copy, recoverably). A file
 * the room removed goes to the Trash unless the owner changed it while away: its text on disk
 * differs from what this computer last had. An edit meeting a delete survives, as in those
 * products, so it's sent back to the room as a new file; so is a file the owner added inside a
 * folder the room removed. A removed folder goes to the Trash whole only when nothing under it
 * is sent back; otherwise only its unchanged files do. With no record of a file's text, a change
 * can't be seen, and the delete applies (to the Trash, so it can be got back).
 *
 * @param folders the folders on the owner's disk
 * @param recorded the hash of the text this computer last had, by file id
 * @param diskHashes the hash of each file's text on the owner's disk now, by path
 */
export function planRoomRemovals(reconcile: IReconcile, folders: ReadonlySet<string>, recorded: ReadonlyMap<string, string>, diskHashes: ReadonlyMap<string, string>): IRoomRemovals {
	const sendBack: { path: string; reason: string }[] = [];
	const removedFiles: string[] = [];
	for (const { id, path } of reconcile.removedInRoom) {
		if (folders.has(path)) {
			continue;
		}
		const hash = recorded.get(id);
		if (hash !== undefined && diskHashes.get(path) !== hash) {
			sendBack.push({ path, reason: 'changed on this disk while away' });
		} else {
			removedFiles.push(path);
		}
	}
	const removedFolders = new Set(reconcile.removedInRoom.filter(({ path }) => folders.has(path)).map(({ path }) => path));
	for (const { path, id } of reconcile.twoSided) {
		if (id === undefined && [...removedFolders].some(folder => path.startsWith(folder + '/'))) {
			sendBack.push({ path, reason: 'added on this disk, inside a folder the room removed' });
		}
	}
	const under = (folder: string, path: string) => path.startsWith(folder + '/');
	const wholeFolders = [...removedFolders].filter(folder => !sendBack.some(({ path }) => under(folder, path)));
	const trash = [...wholeFolders, ...removedFiles].filter(path => !wholeFolders.some(folder => under(folder, path)));
	return { trash: trash.sort(), sendBack };
}

/**
 * At or above this many files, the owner's offline removals are asked about before they're
 * applied. OneDrive asks before a local mass delete reaches the cloud above 200 items by default,
 * for a whole drive; a room is one project, an order of magnitude smaller. No precedent at that
 * scale, so this is a call (ATTACH_RECONCILE_DESIGN.md, "The notification"): ordinary offline
 * work stays under it, a branch switch or a deleted folder of generated files goes over it.
 */
export const LARGE_REMOVAL_FILES = 25;

/** The files the room would lose to `deletes` (a folder counts the files under it), by id. */
export function filesRemovedBy(deletes: IOwnerOfflineChanges['deletes'], room: ReadonlyMap<string, string>): Map<string, string> {
	const isFolder = (path: string) => [...room.keys()].some(other => other.startsWith(path + '/'));
	const removed = new Map<string, string>();
	for (const [path, id] of room) {
		if (!isFolder(path) && deletes.some(d => d.path === path || path.startsWith(d.path + '/'))) {
			removed.set(id, path);
		}
	}
	return removed;
}

/**
 * Whether removing `files` of the room's `roomFiles` files is asked about first: at least
 * LARGE_REMOVAL_FILES, or at least half of a room of 8 or more (where 25 would be most of it), or
 * everything the room has, whatever its size. The count guards against volume; the last against
 * a room left empty, the worst outcome for a guest.
 */
export function isLargeRemoval(files: number, roomFiles: number): boolean {
	return files >= LARGE_REMOVAL_FILES || (roomFiles >= 8 && files * 2 >= roomFiles) || (files > 0 && files >= roomFiles);
}
