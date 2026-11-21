/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { isolatedName } from '../../../../base/common/nameDirection.js';
import Severity from '../../../../base/common/severity.js';
import { IConfirmation } from '../../../../platform/dialogs/common/dialogs.js';
import { IMemberActionResult } from './livecollabService.js';

/**
 * The owner's actions on a member, behind the member's role (MEMBERS_PANEL_DESIGN.md, "The
 * design, approved 2026-11-05"; the Google Drive and Figma pattern). The role change is reached
 * directly and isn't confirmed; transferring ownership and removing someone sit below a divider
 * and are confirmed, naming the person and what it costs.
 */
export type MemberActionId = 'editor' | 'viewer' | 'transfer' | 'remove';

/** One item in a member's menu. */
export interface IMemberMenuItem {
	readonly id: MemberActionId;
	readonly label: string;
	readonly checked: boolean;
}

/** A room member as the panel knows them. */
export interface IMemberRef {
	readonly userId: string;
	readonly name: string;
	readonly role: string;
}

/**
 * What the owner's menu on `member` holds, in groups (a divider between groups). Empty when the
 * person looking isn't the owner, or the row is the owner's own: there is nothing to do there.
 */
export function memberMenu(myUserId: string, myRole: string | undefined, member: IMemberRef): IMemberMenuItem[][] {
	if (myRole !== 'owner' || member.userId === myUserId || member.role === 'owner') {
		return [];
	}
	return [
		[
			{ id: 'editor', label: localize('livecollab.members.editor', "Editor"), checked: member.role === 'editor' },
			{ id: 'viewer', label: localize('livecollab.members.viewer', "Viewer"), checked: member.role === 'viewer' },
		],
		[
			{ id: 'transfer', label: localize('livecollab.members.transfer', "Transfer Ownership…"), checked: false },
			{ id: 'remove', label: localize('livecollab.members.remove', "Remove from Room…"), checked: false },
		],
	];
}

/** What running a member action needs: the confirmation dialog, the room's answers, and a place to say a refusal. */
export interface IMemberActionHost {
	confirm(confirmation: IConfirmation): Promise<boolean>;
	setRole(userId: string, role: 'editor' | 'viewer'): Promise<IMemberActionResult>;
	transfer(userId: string): Promise<IMemberActionResult>;
	remove(userId: string): Promise<IMemberActionResult>;
	refused(message: string): void;
}

/** Runs the owner's choice from a member's menu: confirmed first if it's destructive, and a refusal is said. */
export async function runMemberAction(id: MemberActionId, member: IMemberRef, roomName: string | undefined, host: IMemberActionHost): Promise<void> {
	let result: IMemberActionResult;
	if (id === 'editor' || id === 'viewer') {
		if (member.role === id) {
			return;
		}
		result = await host.setRole(member.userId, id);
	} else if (id === 'transfer') {
		if (!await host.confirm(transferConfirmation(member.name, roomName))) {
			return;
		}
		result = await host.transfer(member.userId);
	} else {
		if (!await host.confirm(removeConfirmation(member.name))) {
			return;
		}
		result = await host.remove(member.userId);
	}
	if (!result.ok) {
		host.refused(localize('livecollab.members.refused', "That didn't happen: {0}", result.error ?? ''));
	}
}

function transferConfirmation(memberName: string, roomName: string | undefined): IConfirmation {
	// Names go in isolated, in their own direction (nameDirection.ts).
	const name = isolatedName(memberName);
	return {
		type: Severity.Warning,
		message: roomName
			? localize('livecollab.members.transferConfirm', "Make {0} the owner of {1}?", name, isolatedName(roomName))
			: localize('livecollab.members.transferConfirmUnnamed', "Make {0} the owner of this room?", name),
		// What a transfer does to the folder today (read from the code, 2026-11-05): files reach a
		// disk only from the owner's window, and a new owner's folder is refused because the room
		// already has one. So no folder follows the room afterwards; the room itself keeps every file.
		detail: localize('livecollab.members.transferConfirmDetail', "You'll become an editor, and only {0} can make you the owner again. Your folder will stop receiving the room's changes, and {0} can't connect a folder to this room yet. The room keeps every file.", name),
		primaryButton: localize({ key: 'livecollab.members.transferButton', comment: ['&& denotes a mnemonic'] }, "&&Transfer Ownership"),
	};
}

function removeConfirmation(memberName: string): IConfirmation {
	const name = isolatedName(memberName);
	return {
		type: Severity.Warning,
		message: localize('livecollab.members.removeConfirm', "Remove {0} from this room?", name),
		detail: localize('livecollab.members.removeConfirmDetail', "They lose access now. Anyone in the room can invite them back."),
		primaryButton: localize({ key: 'livecollab.members.removeButton', comment: ['&& denotes a mnemonic'] }, "&&Remove {0}", name),
	};
}
