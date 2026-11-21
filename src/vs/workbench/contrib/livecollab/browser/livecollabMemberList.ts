/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/livecollabMembers.css';
import { $, append } from '../../../../base/browser/dom.js';
import { safeIntl } from '../../../../base/common/date.js';
import { initialsFromName } from '../../../../base/common/initials.js';
import { nameForDisplay } from '../../../../base/common/nameDirection.js';
import { localize } from '../../../../nls.js';
import { colorForIndex } from './livecollabAvatar.js';

/** One member as the members panel shows them. */
export interface IMemberEntry<T> {
	readonly member: T;
	readonly name: string;
	readonly isMe: boolean;
	readonly online: boolean;
	/** The member's place in the room's member list: their color, the same as in the chat. */
	readonly colorIndex: number;
}

const collator = safeIntl.Collator(undefined, { sensitivity: 'base', numeric: true });

/**
 * The members panel's order (CHAT_DESIGN.md, slice 4): you first, then who is online, then who
 * isn't, each group alphabetical by the name shown.
 */
export function orderMembers<T extends { readonly userId: string }>(members: readonly T[], myUserId: string, isOnline: (userId: string) => boolean, nameOf: (userId: string) => string): IMemberEntry<T>[] {
	const group = (entry: IMemberEntry<T>) => entry.isMe ? 0 : entry.online ? 1 : 2;
	return members
		.map((member, colorIndex) => ({ member, name: nameOf(member.userId), isMe: member.userId === myUserId, online: isOnline(member.userId), colorIndex }))
		.sort((a, b) => group(a) - group(b) || collator.value.compare(a.name, b.name));
}

/**
 * A member's avatar, with a dot while online, and their name, with a "You" chip for this user.
 * An offline member is muted, the name kept readable (descriptionForeground, not opacity).
 * @returns the element the role goes under the name in
 */
export function renderMemberIdentity<T>(row: HTMLElement, entry: IMemberEntry<T>): HTMLElement {
	row.classList.add('livecollab-member', entry.online ? 'online' : 'offline');
	const color = colorForIndex(entry.colorIndex);
	const avatar = append(row, $('.livecollab-member-avatar'));
	avatar.style.background = `${color}33`;
	avatar.style.borderColor = `${color}66`;
	avatar.style.color = color;
	append(avatar, $('span.livecollab-member-initials')).textContent = initialsFromName(entry.name);
	if (entry.online) {
		append(avatar, $('span.livecollab-member-dot'));
	}
	const info = append(row, $('.livecollab-member-info'));
	const line = append(info, $('.livecollab-member-line'));
	const name = append(line, $('span.livecollab-member-name'));
	name.textContent = nameForDisplay(entry.name);
	name.dir = 'auto'; // the name's own direction, isolated from the chip beside it
	if (entry.isMe) {
		append(line, $('span.livecollab-member-chip')).textContent = localize('livecollab.members.youChip', "You");
	}
	row.setAttribute('aria-label', entry.online
		? localize('livecollab.members.onlineLabel', "{0}, online", entry.name)
		: localize('livecollab.members.offlineLabel', "{0}, offline", entry.name));
	return info;
}
