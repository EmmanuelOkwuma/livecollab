/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the workbench needs from the room server to enter a room.
 */
export interface ILiveCollabJoinTarget {
	isConnected(): boolean;
	/** Signs in and connects, once. Resolves whether the socket is connected. */
	connect(): Promise<boolean>;
	join(roomId: string, roomName: string | undefined): Promise<void>;
}

export type LiveCollabJoinResult = 'joined' | 'notConnected';

/**
 * Enters rooms for the workbench view. The workbench used to sign in once at
 * startup and only then start listening for "enter this room"; when that one
 * sign-in failed (an expired session), every later room entry went nowhere
 * and the guest saw an empty window until the app restarted (HANDOFF,
 * "BLOCKER — the guest's workbench never joins the room", 2026-10-14).
 * Joins are now always accepted: a join that finds no connection signs in
 * and connects then — one attempt per join, never a retry loop. A join that
 * arrives while another attempt is running waits for that attempt.
 */
export class LiveCollabWorkbenchJoin {

	private _connecting: Promise<boolean> | undefined;

	constructor(private readonly _target: ILiveCollabJoinTarget) { }

	/** The startup sign-in. A failure leaves joins working. */
	start(): Promise<boolean> {
		return this._ensureConnected();
	}

	async join(roomId: string, roomName: string | undefined): Promise<LiveCollabJoinResult> {
		if (!await this._ensureConnected()) {
			return 'notConnected';
		}
		await this._target.join(roomId, roomName);
		return 'joined';
	}

	private _ensureConnected(): Promise<boolean> {
		if (this._target.isConnected()) {
			return Promise.resolve(true);
		}
		if (!this._connecting) {
			this._connecting = this._target.connect().finally(() => this._connecting = undefined);
		}
		return this._connecting;
	}
}
