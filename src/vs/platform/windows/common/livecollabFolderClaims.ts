/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../base/common/async.js';

/** A folder this computer shares in one of the owner's rooms. */
export interface ILiveCollabFolderClaim {
	readonly roomId: string;
	/** As it was when shared or last entered; absent for a record from before 0.3.6. */
	readonly roomName?: string;
	/** The account that shared it; absent for a record from before 0.3.6. */
	readonly userId?: string;
	/** The folder's path as it was opened. */
	readonly path: string;
}

/** A room's folder as the window recorded it before 0.3.6 (`livecollab.attachedFolder.<roomId>`). */
export interface ILiveCollabKnownFolder {
	readonly roomId: string;
	readonly path: string;
}

/** What a share has to be asked about: the rooms whose folders overlap the one being shared. */
export interface ILiveCollabFolderOverlaps {
	readonly rooms: readonly ILiveCollabFolderClaim[];
}

export interface ILiveCollabClaimRequest {
	readonly path: string;
	readonly roomId: string;
	readonly roomName: string | undefined;
	readonly userId: string | undefined;
	/** The rooms the person was told about and chose to share anyway. */
	readonly acknowledged: readonly string[];
	readonly known?: readonly ILiveCollabKnownFolder[];
}

/** Recorded; or not, because another room overlaps that the person wasn't told about. */
export type ILiveCollabClaimResult = { readonly ok: true } | { readonly ok: false; readonly rooms: readonly ILiveCollabFolderClaim[] };

/** The computer's folders, compared by what they are on disk. */
export interface ILiveCollabFolderDisk {
	/** The path with every link resolved, or undefined if there's nothing there. */
	realpath(path: string): Promise<string | undefined>;
	/**
	 * What the folder is on its volume (device and inode), or undefined if there's nothing there.
	 * Two spellings of one folder, on a volume that ignores case, have the same identity; two
	 * folders differing only by case, on one that doesn't, have different ones.
	 */
	identity(path: string): Promise<string | undefined>;
	/** The folder containing `path`, or undefined at the root. */
	parent(path: string): string | undefined;
}

/** Where the records are kept between launches. */
export interface ILiveCollabClaimStore {
	load(): readonly ILiveCollabFolderClaim[];
	save(claims: readonly ILiveCollabFolderClaim[]): void;
}

/** The computer's record of shared folders, as each window reaches it. */
export interface ILiveCollabFolderClaims {
	overlaps(path: string, roomId: string, known?: readonly ILiveCollabKnownFolder[]): Promise<ILiveCollabFolderOverlaps>;
	claim(request: ILiveCollabClaimRequest): Promise<ILiveCollabClaimResult>;
	/** Forgets a room's record: only once it's confirmed the room is deleted, or the owner's ownership or access ended. */
	release(roomId: string): Promise<void>;
}

/**
 * One record for the whole computer of which folder each of the owner's rooms shares
 * (ATTACH_RECONCILE_DESIGN.md, "Sharing asks first"). It lives where every window reaches it at
 * once (the main process), and answers one request at a time: a share is recorded only if no
 * room overlaps it that the person wasn't told about, so two windows sharing at once can't both
 * miss each other. Records are compared by what the folders are on disk, links resolved.
 */
export class LiveCollabFolderClaims implements ILiveCollabFolderClaims {

	private readonly _sequencer = new Sequencer();
	private _claims: ILiveCollabFolderClaim[];

	constructor(
		private readonly _disk: ILiveCollabFolderDisk,
		private readonly _store: ILiveCollabClaimStore,
	) {
		this._claims = [..._store.load()];
	}

	overlaps(path: string, roomId: string, known?: readonly ILiveCollabKnownFolder[]): Promise<ILiveCollabFolderOverlaps> {
		return this._sequencer.queue(async () => {
			this._adopt(known);
			return { rooms: await this._overlapping(path, roomId) };
		});
	}

	claim(request: ILiveCollabClaimRequest): Promise<ILiveCollabClaimResult> {
		return this._sequencer.queue(async () => {
			this._adopt(request.known);
			const rooms = await this._overlapping(request.path, request.roomId);
			if (rooms.some(room => !request.acknowledged.includes(room.roomId))) {
				return { ok: false, rooms };
			}
			const previous = this._claims.find(claim => claim.roomId === request.roomId);
			this._claims = this._claims.filter(claim => claim.roomId !== request.roomId);
			this._claims.push({
				roomId: request.roomId,
				roomName: request.roomName ?? previous?.roomName,
				userId: request.userId ?? previous?.userId,
				path: request.path,
			});
			this._store.save(this._claims);
			return { ok: true };
		});
	}

	release(roomId: string): Promise<void> {
		return this._sequencer.queue(async () => {
			const before = this._claims.length;
			this._claims = this._claims.filter(claim => claim.roomId !== roomId);
			if (this._claims.length !== before) {
				this._store.save(this._claims);
			}
		});
	}

	/** Records a window kept before 0.3.6, for rooms not recorded here yet. */
	private _adopt(known: readonly ILiveCollabKnownFolder[] | undefined): void {
		const adopted = (known ?? []).filter(folder => !this._claims.some(claim => claim.roomId === folder.roomId));
		if (adopted.length) {
			this._claims.push(...adopted.map(folder => ({ roomId: folder.roomId, path: folder.path })));
			this._store.save(this._claims);
		}
	}

	/**
	 * The other rooms whose folder is the same as `path`, inside it, or contains it. A record whose
	 * folder isn't on disk now overlaps nothing, and is kept.
	 */
	private async _overlapping(path: string, roomId: string): Promise<ILiveCollabFolderClaim[]> {
		const real = await this._disk.realpath(path);
		const self = real === undefined ? undefined : await this._disk.identity(real);
		if (real === undefined || self === undefined) {
			return [];
		}
		const containing = await this._lineage(real);
		const rooms: ILiveCollabFolderClaim[] = [];
		for (const claim of this._claims) {
			if (claim.roomId === roomId) {
				continue;
			}
			const other = await this._disk.realpath(claim.path);
			const otherIdentity = other === undefined ? undefined : await this._disk.identity(other);
			if (other === undefined || otherIdentity === undefined) {
				continue;
			}
			if (containing.has(otherIdentity) || (await this._lineage(other)).has(self)) {
				rooms.push(claim);
			}
		}
		return rooms;
	}

	/** The identities of a folder and of every folder containing it. */
	private async _lineage(real: string): Promise<Set<string>> {
		const lineage = new Set<string>();
		for (let current: string | undefined = real; current !== undefined; current = this._disk.parent(current)) {
			const identity = await this._disk.identity(current);
			if (identity !== undefined) {
				lineage.add(identity);
			}
		}
		return lineage;
	}
}
