/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The containment rule (advisor, 2026-10-29), replacing "is this entry a
// symlink": a path belongs to the room if, with every link resolved, it lies
// inside the shared folder (the root, itself resolved once at attach), and
// never otherwise. Asked in both directions: what the owner's folder sends to
// the room, and where a change from the room may land on the owner's disk.
// Anything that cannot be resolved (a broken link, a loop, no permission)
// counts as outside: the rule fails closed.

/**
 * The owner's disk, as far as the containment rule needs to see it.
 */
export interface IContainmentDisk {
	/**
	 * The real path of `path`, every link along it resolved; undefined when
	 * nothing exists there. Throws for anything else (a loop, no permission).
	 */
	realpath(path: string): Promise<string | undefined>;
	/**
	 * Whether `path` itself is a link (lstat). Asked only to check a realpath
	 * that came back unchanged.
	 */
	isLink(path: string): Promise<boolean>;
}

/**
 * The shared folder as captured at attach: the path the owner opened, and
 * where it really is.
 */
export interface IContainmentRoot {
	readonly path: string;
	readonly realPath: string;
}

/**
 * Whether a resolved path is the resolved root or inside it.
 */
export function isInsideRoot(realRoot: string, realPath: string): boolean {
	const root = realRoot.endsWith('/') ? realRoot.slice(0, -1) : realRoot;
	return realPath === root || realPath.startsWith(root + '/');
}

/**
 * Whether a room-relative path is a withheld item or inside one.
 */
export function isUnderWithheld(path: string, withheld: Iterable<string>): boolean {
	for (const item of withheld) {
		if (path === item || path.startsWith(item + '/')) {
			return true;
		}
	}
	return false;
}

/**
 * What the attach walk does with an entry that is a link (only links are ever
 * resolved: a non-link child of a contained folder is contained).
 * - 'outside': it leads out of the shared folder, or nowhere (broken, a loop,
 *   unreadable). Withheld, as before.
 * - 'alias': it leads to somewhere inside the shared folder, which the walk
 *   reaches anyway under its real name. Sharing it too would give one file on
 *   disk two room paths, two documents and two editors writing to it, so it
 *   is withheld as well (see STATUS: this departs from "a link inside the
 *   folder is shared").
 */
export async function judgeLink(disk: IContainmentDisk, root: IContainmentRoot, linkPath: string): Promise<{ readonly verdict: 'outside' | 'alias'; readonly detail: string }> {
	let target: string | undefined;
	try {
		target = await disk.realpath(linkPath);
	} catch (e) {
		return { verdict: 'outside', detail: `link that can't be resolved (${e instanceof Error ? e.message : String(e)})` };
	}
	if (target === undefined) {
		return { verdict: 'outside', detail: 'broken link' };
	}
	if (target === linkPath) {
		// Node's realpath falls back to the unresolved path when resolving
		// fails but the path is readable: a link resolving to itself was not
		// resolved at all.
		return { verdict: 'outside', detail: 'link that can\'t be resolved' };
	}
	if (!isInsideRoot(root.realPath, target)) {
		return { verdict: 'outside', detail: 'link to outside the folder' };
	}
	const relative = target.slice(root.realPath.length + 1);
	return { verdict: 'alias', detail: `link to ${relative || 'the folder itself'}, already shared under that name` };
}

/**
 * Where `relativePath`, joined onto the root, really lands on disk: the
 * deepest part of it that exists is resolved and must be inside the resolved
 * root. That one resolution also re-checks the root itself, so a root or a
 * folder swapped for a link since the attach is caught here, at write time.
 */
export async function judgeDiskPath(disk: IContainmentDisk, root: IContainmentRoot, relativePath: string): Promise<{ readonly inside: boolean; readonly exists: boolean; readonly detail?: string }> {
	const segments = relativePath.split('/');
	for (let depth = segments.length; depth >= 0; depth--) {
		const candidate = depth === 0 ? root.path : `${root.path}/${segments.slice(0, depth).join('/')}`;
		let real: string | undefined;
		try {
			real = await disk.realpath(candidate);
		} catch (e) {
			return { inside: false, exists: false, detail: `could not resolve ${candidate} (${e instanceof Error ? e.message : String(e)})` };
		}
		if (real === undefined) {
			continue;
		}
		if (real === candidate) {
			// Unchanged: either nothing along it is a link, or resolving failed
			// and Node's realpath fell back to the path as given (pfs.ts). Only
			// the first may pass: any link at or below the root means the path
			// was not resolved, which counts as outside.
			const unresolved = await findLinkBelowRoot(disk, root.path, segments.slice(0, depth));
			if (unresolved) {
				return { inside: false, exists: false, detail: unresolved };
			}
		}
		const exists = depth === segments.length;
		return isInsideRoot(root.realPath, real)
			? { inside: true, exists }
			: { inside: false, exists, detail: `resolves to ${real}, outside the shared folder` };
	}
	return { inside: false, exists: false, detail: 'the shared folder is no longer there' };
}

/**
 * For a realpath that came back unchanged: the first part of the path, below
 * the root, that is a link (so was never resolved), as a reason; undefined
 * when none is. A check that fails is a reason too.
 */
async function findLinkBelowRoot(disk: IContainmentDisk, rootPath: string, segments: readonly string[]): Promise<string | undefined> {
	for (let depth = 1; depth <= segments.length; depth++) {
		const part = `${rootPath}/${segments.slice(0, depth).join('/')}`;
		try {
			if (await disk.isLink(part)) {
				return `the link ${part} could not be resolved`;
			}
		} catch (e) {
			return `could not check ${part} (${e instanceof Error ? e.message : String(e)})`;
		}
	}
	return undefined;
}

/**
 * What a rename made on this machine does to the room, re-judged against the
 * share rules on both ends (2026-10-29: a shared notes.txt renamed to .env
 * stayed in the room and kept syncing, walking around the secret rules).
 * - 'rename': an ordinary rename of a room file, sent to the room;
 * - 'leaveRoom': the owner renamed a room file into a shape the room never
 *   shares (.env, node_modules/…): it leaves the room, the file stays on the
 *   owner's disk, and the owner is told;
 * - 'refuse': a guest renamed a room file into such a shape: not sent, the
 *   rename is put back on the guest's side, and the guest is told (the file
 *   lives on the owner's disk, which a guest's rename must not take out);
 * - 'enterRoom': the owner renamed a file the room didn't have (.env ->
 *   notes.txt) to a shareable name: it is shared like a new file;
 * - 'ignore': neither end is in the room.
 */
export function planLocalRename(rename: { readonly tracked: boolean; readonly destinationRule: string | undefined; readonly onOwnerDisk: boolean }): 'rename' | 'leaveRoom' | 'refuse' | 'enterRoom' | 'ignore' {
	if (rename.destinationRule) {
		return !rename.tracked ? 'ignore' : rename.onOwnerDisk ? 'leaveRoom' : 'refuse';
	}
	if (!rename.tracked) {
		return rename.onOwnerDisk ? 'enterRoom' : 'ignore';
	}
	return 'rename';
}

/**
 * What the owner does with a move from the room, judged on its destination:
 * - 'refuse': the destination is outside the shared folder. Nothing on disk is
 *   touched, the source least of all;
 * - 'nothing': the destination is already there (this owner made the move);
 * - 'move': the source is on disk inside the folder, so it is moved;
 * - 'write': the source never was on this disk inside the folder (refused
 *   when it was created, or under a withheld link), so the room's copy is
 *   written at the destination and the source is left alone.
 */
export function planOwnerMove(source: { readonly inside: boolean; readonly exists: boolean }, destination: { readonly inside: boolean; readonly exists: boolean }): 'refuse' | 'nothing' | 'move' | 'write' {
	if (!destination.inside) {
		return 'refuse';
	}
	if (destination.exists) {
		return 'nothing';
	}
	return source.inside && source.exists ? 'move' : 'write';
}

/**
 * The owner's corrective moves (a refused move sent straight back to the
 * room). The server broadcasts every rename to the whole room, the owner
 * included, so the owner hears its own correction back: that echo is
 * recognised here and never applied to the owner's disk (2026-10-29 run J:
 * applying it threw, its source having never been on this disk).
 *
 * No clock anywhere. Every refused move is corrected, however soon after the
 * last (until 2026-10-29 a 30 s cooldown per file left a second refused move
 * standing in the room). A loop can't form, by a condition rather than a
 * delay: a correction is only sent when the file's old path exists inside the
 * folder on this disk, it moves the file back to exactly that path, and the
 * owner never refuses a move to an existing path inside the folder. The
 * correction is also flagged in its message (`correction: true`), and a
 * client never answers a flagged rename with a correction.
 */
export class MoveCorrections {

	private readonly _sent = new Map<string, { readonly from: string; readonly to: string }[]>();

	/** Records a correction (from -> to) sent for fileId, so its echo is recognised. */
	sent(fileId: string, from: string, to: string): void {
		const sent = this._sent.get(fileId) ?? [];
		sent.push({ from, to });
		this._sent.set(fileId, sent);
	}

	/**
	 * Whether a rename from the room is the echo of a correction this owner
	 * sent. An echo is consumed: the same move made later by a member is not
	 * mistaken for it.
	 */
	isOwnEcho(fileId: string, oldPath: string, newPath: string): boolean {
		const sent = this._sent.get(fileId);
		const index = sent?.findIndex(s => s.from === oldPath && s.to === newPath) ?? -1;
		if (!sent || index < 0) {
			return false;
		}
		sent.splice(index, 1);
		if (!sent.length) { this._sent.delete(fileId); }
		return true;
	}

	/** How many corrections are waiting for their echo, for the room-state check. */
	get waiting(): number {
		let count = 0;
		for (const sent of this._sent.values()) { count += sent.length; }
		return count;
	}

	clear(): void {
		this._sent.clear();
	}
}
