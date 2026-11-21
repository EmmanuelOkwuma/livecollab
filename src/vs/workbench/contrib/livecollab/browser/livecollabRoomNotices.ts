/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { isolatedName } from '../../../../base/common/nameDirection.js';
import { INotificationService, NotificationPriority } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILiveCollabClient } from './livecollabClient.js';
import { RoomTerminationReason } from './livecollabService.js';

/**
 * Who in a room is told what (Manny's rule, 2026-11-05; the per-action list is in
 * MEMBERS_PANEL_DESIGN.md, "Who is told what"). Everyone in the room is told when an action changes
 * what other people can see or do: someone joined or left, ownership moved, the folder was shared.
 * Only the person affected is told when it changes their own standing and nothing else: their role
 * changed, or they were removed. Whoever did it is never told about their own action.
 */
export class LiveCollabRoomNotices extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.livecollabRoomNotices';

	constructor(
		@ILiveCollabClient client: ILiveCollabClient,
		@INotificationService notificationService: INotificationService,
	) {
		super();
		const service = client.service;
		const tell = (message: string) => notificationService.notify({ severity: Severity.Info, message });
		// Joins and leaves are told in the notification center without a toast: the room's chat shows
		// each as a line in its log (CHAT_DESIGN.md, Join and leave lines), where a toast would only
		// cover the chat's composer. Slack does the same: a join is a line in the channel.
		const tellQuietly = (message: string) => notificationService.notify({ severity: Severity.Info, message, priority: NotificationPriority.SILENT });
		this._register(service.onMemberJoined(({ name }) => tellQuietly(localize('livecollab.notice.joined', "{0} joined the room.", nameOrMember(name)))));
		this._register(service.onMemberLeft(({ name }) => tellQuietly(localize('livecollab.notice.left', "{0} left the room.", nameOrMember(name)))));
		this._register(service.onFolderShared(({ folderName, by }) => tell(folderName
			? localize('livecollab.notice.folderShared', "{0} shared the folder '{1}' with this room.", nameOrOwner(by), folderName)
			: localize('livecollab.notice.folderSharedUnnamed', "{0} shared a folder with this room.", nameOrOwner(by)))));
		// The new owner and the one who handed it over are told by their own role change.
		this._register(service.onOwnerChanged(({ ownerUserId, ownerName, by, byUserId }) => {
			if (ownerUserId === service.myUserId || byUserId === service.myUserId) {
				return;
			}
			tell(localize('livecollab.notice.ownerChanged', "{0} made {1} the owner of this room.", nameOrOwner(by), nameOrMember(ownerName)));
		}));
		this._register(service.onMyRoleChangedBy(({ role, by }) => tell(roleChangedNotice(role, by))));
	}
}

/** What the person whose role changed is told: who changed it, to what, and what it means. */
function roleChangedNotice(role: string, by: string): string {
	if (role === 'owner') {
		return localize('livecollab.notice.madeOwner', "{0} made you the owner of this room. You now decide who's in it and what they can do. The room keeps its files; connecting a folder of yours to it isn't supported yet.", nameOrOwner(by));
	}
	if (role === 'viewer') {
		return localize('livecollab.notice.madeViewer', "{0} made you a viewer. You can read this room's files but not change them.", nameOrOwner(by));
	}
	return localize('livecollab.notice.madeEditor', "{0} made you an editor. You can change this room's files.", nameOrOwner(by));
}

/**
 * What someone whose membership ended is told, on the dashboard they land on.
 * Names go in isolated (nameDirection.ts), as in every notice here.
 */
export function roomTerminatedNotice(reason: RoomTerminationReason, roomName: string | undefined, by: string | undefined): string | undefined {
	const name = roomName ? isolatedName(roomName) : localize('livecollab.unnamedRoom', "the room");
	switch (reason) {
		case 'kicked': return by
			? localize('livecollab.notice.removedBy', "{0} removed you from {1}.", isolatedName(by), name)
			: localize('livecollab.removedFromRoom', "You were removed from {0}.", name);
		case 'ended': return localize('livecollab.roomDeleted', "{0} was deleted.", name);
		case 'leftElsewhere': return localize('livecollab.leftElsewhere', "You left {0} in another window.", name);
		case 'notMember': return localize('livecollab.notMember', "You're no longer a member of {0}. Ask the owner for a new invite.", name);
		default: return undefined;
	}
}

function nameOrMember(name: string): string {
	return name ? isolatedName(name) : localize('livecollab.notice.someone', "A member");
}

function nameOrOwner(name: string): string {
	return name ? isolatedName(name) : localize('livecollab.notice.theOwner', "The owner");
}
