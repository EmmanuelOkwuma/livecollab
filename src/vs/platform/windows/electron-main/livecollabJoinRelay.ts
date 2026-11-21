/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A room the user opened from the dashboard.
 */
export interface ILiveCollabJoin {
	readonly roomId: string;
	readonly roomName: string;
}

/**
 * Hands room joins to the workbench view only once it listens for them. The
 * window is shown when the DASHBOARD is ready, while the workbench view is
 * still loading; a join sent to it before its listener exists was lost, and
 * the user saw an empty room (HANDOFF, "OPEN — a room opened right at launch
 * can be dropped", 2026-10-15). A join that arrives early is held — only the
 * latest, a later click replaces it — and delivered when the workbench says
 * it listens. A reload of the workbench view stops delivery until it says so
 * again.
 */
export class LiveCollabJoinRelay {

	private _listening = false;
	private _held: ILiveCollabJoin | undefined;

	constructor(
		private readonly _send: (join: ILiveCollabJoin) => void,
		private readonly _log: (message: string) => void,
	) { }

	request(join: ILiveCollabJoin): void {
		if (this._listening) {
			this._log(`[LiveCollab] join-room: sent to the workbench (${join.roomId})`);
			this._send(join);
			return;
		}
		if (this._held) {
			this._log(`[LiveCollab] join-room: replacing held ${this._held.roomId}`);
		}
		this._held = join;
		this._log(`[LiveCollab] join-room: held, the workbench is not listening yet (${join.roomId})`);
	}

	workbenchListening(): void {
		this._listening = true;
		const held = this._held;
		this._held = undefined;
		if (held) {
			this._log(`[LiveCollab] join-room: the workbench is listening, delivering held ${held.roomId}`);
			this._send(held);
		} else {
			this._log('[LiveCollab] join-room: the workbench is listening, nothing held');
		}
	}

	workbenchUnloaded(): void {
		this._listening = false;
	}
}
