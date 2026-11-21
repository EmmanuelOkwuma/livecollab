/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Type-only: the runtime Yjs module comes from the vendored bundle and is
// passed in by the caller (livecollabService.getYjsModule()).
type YjsModule = typeof import('yjs');
type YDoc = InstanceType<YjsModule['Doc']>;

/**
 * What this client holds for each room file it has no live doc for: the
 * server's seed state (from room:snapshot / room:file:created), plus every
 * remote update that arrived since. Without this, an update for a file no
 * editor had open was dropped, and the file opened later without it (HANDOFF,
 * "edits to a file you don't have open are lost", design approved 2026-10-01).
 *
 * Updates are merged into the seed when it is READ, not when they arrive:
 * Yjs updates commute and merging is idempotent, so the order is irrelevant,
 * and arriving updates never need the Yjs module. R1 holds: held updates with
 * no seed are never returned as a seed — a bare update must not let a doc be
 * marked seeded and bound to a real file.
 */
export class LiveCollabFileStates {

	private readonly _seedStates = new Map<string, Uint8Array>();
	private readonly _heldUpdates = new Map<string, Uint8Array[]>();

	constructor(private readonly _getLiveDoc: (fileId: string) => YDoc | undefined) { }

	/**
	 * Applies a remote update to the file's live doc if one exists (an open
	 * editor's binding renders it), otherwise holds it until the file is read.
	 * `Y` is the loaded Yjs module, or undefined if it has not loaded yet — in
	 * which case no live doc can exist either.
	 */
	receiveRemoteUpdate(Y: YjsModule | undefined, fileId: string, update: Uint8Array): void {
		const doc = this._getLiveDoc(fileId);
		if (doc && Y) {
			Y.applyUpdate(doc, update, 'remote');
			return;
		}
		const held = this._heldUpdates.get(fileId);
		if (held) {
			held.push(update);
		} else {
			this._heldUpdates.set(fileId, [update]);
		}
	}

	setSeedState(fileId: string, state: Uint8Array): void {
		this._seedStates.set(fileId, state);
	}

	hasSeedState(fileId: string): boolean {
		return this._seedStates.has(fileId);
	}

	/**
	 * The file's seed state with every held update merged in, or undefined if
	 * no seed has arrived yet (held updates alone are never a seed — R1). The
	 * merged result replaces the stored seed, so each update is merged once.
	 */
	readSeedState(Y: YjsModule, fileId: string): Uint8Array | undefined {
		const seed = this._seedStates.get(fileId);
		if (!seed) {
			return undefined;
		}
		const held = this._heldUpdates.get(fileId);
		if (!held) {
			return seed;
		}
		const merged = Y.mergeUpdates([seed, ...held]);
		this._seedStates.set(fileId, merged);
		this._heldUpdates.delete(fileId);
		return merged;
	}

	/** Forgets one file (deleted from the room). */
	drop(fileId: string): void {
		this._seedStates.delete(fileId);
		this._heldUpdates.delete(fileId);
	}

	/** What is held, for the room-state check: counts only. */
	describe(): string[] {
		const held = [];
		if (this._seedStates.size) { held.push(`${this._seedStates.size} seed states`); }
		if (this._heldUpdates.size) { held.push(`held updates for ${this._heldUpdates.size} files`); }
		return held;
	}

	/** Forgets everything (room-session teardown, folder cleared). */
	clear(): void {
		this._seedStates.clear();
		this._heldUpdates.clear();
	}
}
