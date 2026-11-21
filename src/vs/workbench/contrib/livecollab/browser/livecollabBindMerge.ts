/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDiffChange, stringDiff } from '../../../../base/common/diff/diff.js';

/** One change to the room's text: at `offset`, remove `deleteCount` characters, then insert `insert`. */
export interface IRoomTextEdit {
	readonly offset: number;
	readonly deleteCount: number;
	readonly insert: string;
}

/**
 * The edits that carry what was typed in an editor while it waited for its binding into the
 * room's text, so the binding (which replaces the editor's text with the room's) loses none of it.
 *
 * `base` is the editor's text when the wait began, `local` its text now, `room` the room's text
 * now. What changed from `base` to `local` was typed here; what changed from `base` to `room`
 * came from the room meanwhile. Each local change lands where its spot moved to in the room's text.
 * Nothing the room has is dropped: a local deletion applies only where the room still has exactly
 * the deleted text, and where both sides changed the same spot, the room's text comes first and
 * the local text follows it.
 *
 * The edits are in descending offset order, so applying them one after another needs no
 * adjustment of the later ones.
 */
export function mergeIntoRoomText(base: string, local: string, room: string): IRoomTextEdit[] {
	if (local === base) {
		return [];
	}
	const fromRoom = room === base ? [] : stringDiff(base, room, false);
	const edits: IRoomTextEdit[] = [];
	const typed = stringDiff(base, local, false);
	for (let i = typed.length - 1; i >= 0; i--) {
		const change = typed[i];
		const end = change.originalStart + change.originalLength;
		// The room's insertions at either edge stay out of the deleted span.
		const start = mapOffset(fromRoom, change.originalStart, true);
		const endBeforeRoomInsertions = mapOffset(fromRoom, end, false);
		const endAfterRoomInsertions = mapOffset(fromRoom, end, true);
		const deleted = base.substring(change.originalStart, end);
		const deletes = deleted.length > 0 && start <= endBeforeRoomInsertions && room.substring(start, endBeforeRoomInsertions) === deleted;
		const insert = local.substring(change.modifiedStart, change.modifiedStart + change.modifiedLength);
		if (deletes) {
			edits.push({ offset: start, deleteCount: deleted.length, insert });
		} else if (insert.length > 0) {
			// Where the deletion doesn't apply, the insert goes after the room's text for that spot.
			edits.push({ offset: endAfterRoomInsertions, deleteCount: 0, insert });
		}
	}
	return edits;
}

/**
 * Where `offset` in the base text is in the room's text. An offset inside a span the room
 * changed maps to the end of the room's replacement. An insertion by the room exactly at the
 * offset comes before it when `afterRoomInsertions`, after it otherwise.
 */
function mapOffset(changes: readonly IDiffChange[], offset: number, afterRoomInsertions: boolean): number {
	let delta = 0;
	for (const change of changes) {
		const changeEnd = change.originalStart + change.originalLength;
		if (changeEnd < offset || (changeEnd === offset && (change.originalLength > 0 || afterRoomInsertions))) {
			delta += change.modifiedLength - change.originalLength;
		} else if (change.originalStart < offset) {
			return change.modifiedStart + change.modifiedLength;
		} else {
			break;
		}
	}
	return offset + delta;
}
