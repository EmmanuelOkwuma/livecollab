/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { isolatedName } from '../../../../base/common/nameDirection.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import Severity from '../../../../base/common/severity.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { livecollabService, ILiveCollabMember } from './livecollabService.js';
import { IMemberRef, memberMenu, MemberActionId, runMemberAction } from './livecollabMemberActions.js';
import { orderMembers, renderMemberIdentity } from './livecollabMemberList.js';

function roleName(role: string): string {
	return role === 'owner' ? localize('livecollab.members.owner', "Owner")
		: role === 'viewer' ? localize('livecollab.members.viewer', "Viewer")
			: localize('livecollab.members.editor', "Editor");
}

export class LiveCollabMembersView extends ViewPane {

	static readonly ID = 'workbench.view.livecollab.members';
	static readonly TITLE = localize('livecollabMembers', "Members");

	private membersContainer: HTMLElement | undefined;
	// Leave Room, once, apart from the members (MEMBERS_PANEL_DESIGN.md).
	private dangerArea: HTMLElement | undefined;
	private members: ILiveCollabMember[] = [];
	// The invite code shown after Create Invite Code, and its row.
	private inviteCodeText: HTMLElement | undefined;
	private inviteCodeRow: HTMLElement | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(livecollabService.onConnected(() => {
			if (livecollabService.lastMembers.length > 0) {
				this.members = livecollabService.lastMembers;
				this.updateMembersList();
			}
		}));

		// The member list and the invite code belong to one room session
		// (IRoomStateOwner): an owner who switches rooms must never be shown,
		// and able to copy, the last room's invite code.
		this._register(livecollabService.registerRoomState({
			name: 'members panel',
			clear: () => {
				this.members = [];
				this.updateMembersList();
				if (this.inviteCodeText) { this.inviteCodeText.textContent = ''; }
				if (this.inviteCodeRow) { this.inviteCodeRow.style.display = 'none'; }
			},
			inspect: () => {
				const held: string[] = [];
				if (this.members.length) { held.push(`${this.members.length} members`); }
				if (this.inviteCodeText?.textContent) { held.push('an invite code'); }
				return held;
			},
		}));

		this._register(livecollabService.onPresenceChanged(() => this.updateMembersList()));

		this._register(livecollabService.onMembersChanged((members) => {
			this.members = members;
			// Load existing members immediately
			if (livecollabService.lastMembers.length > 0) {
				this.members = livecollabService.lastMembers;
			}
			this.updateMembersList();
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.overflow = 'hidden';
		container.style.height = '100%';

		// Invite section
		const inviteSection = document.createElement('div');
		inviteSection.style.padding = '8px 12px';
		inviteSection.style.borderBottom = '1px solid #2b2b2b';

		const inviteLabel = document.createElement('div');
		inviteLabel.style.cssText = 'font-size:11px;color:#858585;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.08em;';
		inviteLabel.textContent = 'Invite';
		inviteSection.appendChild(inviteLabel);

		// Only owner can create invite codes


		const inviteBody = document.createElement('div');
		inviteBody.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

		const createInviteBtn = document.createElement('button') as HTMLButtonElement;
		createInviteBtn.style.cssText = 'background:#1e1e1e;border:1px solid #2b2b2b;color:#cccccc;border-radius:4px;padding:4px 8px;font-size:12px;cursor:pointer;text-align:left;width:100%;';
		createInviteBtn.textContent = 'Create invite code';
		createInviteBtn.onmouseenter = () => { createInviteBtn.style.borderColor = '#007ACC'; };
		createInviteBtn.onmouseleave = () => { createInviteBtn.style.borderColor = '#2b2b2b'; };

		// Code row — hidden until code is created
		const codeRow = document.createElement('div');
		codeRow.style.cssText = 'display:none;align-items:center;gap:8px;background:#1e1e1e;border:1px solid #2b2b2b;border-radius:4px;padding:4px 8px;';
		const codeText = document.createElement('span');
		codeText.style.cssText = 'font-size:11px;color:#cccccc;font-family:monospace;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
		const copyBtn = document.createElement('button') as HTMLButtonElement;
		copyBtn.textContent = 'Copy';
		copyBtn.style.cssText = 'background:transparent;border:none;color:#858585;cursor:pointer;font-size:11px;padding:4px;flex-shrink:0;';
		// Manny, 2026-10-29: a code is shown once. Copy closes it, leaving only
		// the Create button until a new code is created, so no stale code stays
		// on screen to be copied later (the room change clears it the same way,
		// in the members panel room state above). The Create button says Copied
		// for a moment, since the row it was clicked in is gone.
		copyBtn.onclick = async () => {
			await this.clipboardService.writeText(codeText.textContent || '');
			codeText.textContent = '';
			codeRow.style.display = 'none';
			createInviteBtn.textContent = 'Copied';
			setTimeout(() => { if (createInviteBtn.textContent === 'Copied') { createInviteBtn.textContent = 'Create invite code'; } }, 2000);
		};
		codeRow.appendChild(codeText);
		codeRow.appendChild(copyBtn);
		this.inviteCodeText = codeText;
		this.inviteCodeRow = codeRow;

		createInviteBtn.onclick = async () => {
			createInviteBtn.textContent = 'Creating...';
			createInviteBtn.disabled = true;
			const forRoom = livecollabService.roomId;
			const result = await livecollabService.createInviteCode();
			if (livecollabService.roomId !== forRoom) {
				// The room changed while the code was being created: it belongs
				// to the room just left, so it is never shown.
				createInviteBtn.textContent = 'Create invite code';
			} else if (result.success && result.code) {
				codeText.textContent = result.code;
				codeRow.style.display = 'flex';
				createInviteBtn.textContent = 'Create invite code';
			} else {
				createInviteBtn.textContent = result.error || 'Failed';
				setTimeout(() => createInviteBtn.textContent = 'Create invite code', 2000);
			}
			createInviteBtn.disabled = false;
		};

		inviteBody.appendChild(createInviteBtn);
		inviteBody.appendChild(codeRow);
		inviteSection.appendChild(inviteBody);
		container.appendChild(inviteSection);

		// Members list
		this.membersContainer = document.createElement('div');
		this.membersContainer.style.flex = '1';
		this.membersContainer.style.overflowY = 'auto';
		this.membersContainer.style.padding = '4px 0';
		container.appendChild(this.membersContainer);

		this.dangerArea = document.createElement('div');
		this.dangerArea.dataset.lcTest = 'danger-area';
		this.dangerArea.style.cssText = 'flex-shrink:0;margin-top:16px;padding:10px 12px 12px;border-top:1px solid #2b2b2b;';
		container.appendChild(this.dangerArea);

		// Populate immediately from cached members on render
		if (livecollabService.lastMembers.length > 0) {
			this.members = livecollabService.lastMembers;
		}
		// Re-request fresh members list from server
		if (livecollabService.isConnected && livecollabService.roomId) {
			livecollabService.fetchMembers(livecollabService.roomId);
		}
		this.updateMembersList();
	}

	private updateMembersList(): void {
		if (!this.membersContainer) { return; }
		while (this.membersContainer.firstChild) { this.membersContainer.removeChild(this.membersContainer.firstChild); }
		this.updateDangerArea();
		if (this.members.length === 0) {
			const empty = document.createElement('div');
			empty.style.cssText = 'padding:12px;font-size:12px;color:#858585;text-align:center;';
			empty.textContent = localize('livecollab.members.empty', "Open a folder to start collaborating");
			this.membersContainer.appendChild(empty);
			return;
		}

		const myUserId = livecollabService.myUserId;
		const entries = orderMembers(this.members, myUserId, userId => livecollabService.isOnline(userId), userId => livecollabService.memberName(userId));
		for (const entry of entries) {
			const { member, name: displayName } = entry;
			// Never the email in place of a name: it's personal data on everyone's screen (option F scope).
			const ref: IMemberRef = { userId: member.userId, name: displayName, role: member.role };

			const row = document.createElement('div');
			row.dataset.lcTest = 'member';
			row.dataset.lcUser = member.userId;
			const info = renderMemberIdentity(row, entry);

			// The role, under the name. For the owner it's also the way to the member's actions:
			// a click opens the menu, so nothing beside the name or on hover can be hit by accident.
			const roleLabel = roleName(member.role);
			const menu = memberMenu(myUserId, livecollabService.myRole, ref);
			if (menu.length > 0) {
				const roleButton = document.createElement('button');
				roleButton.type = 'button';
				roleButton.dataset.lcTest = 'role-menu';
				roleButton.className = 'livecollab-member-role';
				roleButton.textContent = `${roleLabel} \u25BE`;
				roleButton.setAttribute('aria-haspopup', 'menu');
				roleButton.setAttribute('aria-label', localize('livecollab.members.roleMenu', "{0}, {1}: change role or manage", displayName, roleLabel));
				roleButton.style.cssText = 'background:transparent;border:none;padding:0;cursor:pointer;';
				roleButton.onclick = () => this.showMemberMenu(roleButton, ref, menu);
				info.appendChild(roleButton);
			} else {
				const roleEl = document.createElement('div');
				roleEl.className = 'livecollab-member-role';
				roleEl.textContent = roleLabel;
				info.appendChild(roleEl);
			}
			this.membersContainer.appendChild(row);
		}
	}

	private showMemberMenu(anchor: HTMLElement, member: IMemberRef, menu: ReturnType<typeof memberMenu>): void {
		const actions: IAction[] = [];
		menu.forEach((group, index) => {
			if (index > 0) { actions.push(new Separator()); }
			for (const item of group) {
				actions.push(toAction({ id: `livecollab.member.${item.id}`, label: item.label, checked: item.checked, run: () => this.runAction(item.id, member) }));
			}
		});
		this.contextMenuService.showContextMenu({ getAnchor: () => anchor, getActions: () => actions });
	}

	private runAction(id: MemberActionId, member: IMemberRef): Promise<void> {
		return runMemberAction(id, member, livecollabService.roomName, {
			confirm: async confirmation => (await this.dialogService.confirm(confirmation)).confirmed,
			setRole: (userId, role) => livecollabService.setMemberRole(userId, role),
			transfer: userId => livecollabService.transferOwnership(userId),
			remove: userId => livecollabService.kickMember(userId),
			refused: message => this.notificationService.warn(message),
		});
	}

	// Leave Room gives up membership (coming back needs a new invite), so it is a labelled,
	// confirmed action, once, below a divider at the foot of the panel. The owner can't leave (the
	// server refuses), so the owner is told what to do instead; nothing here is shown disabled.
	// The role comes from the server (myRole).
	private updateDangerArea(): void {
		if (!this.dangerArea) { return; }
		while (this.dangerArea.firstChild) { this.dangerArea.removeChild(this.dangerArea.firstChild); }
		const role = livecollabService.myRole;
		if (!role || this.members.length === 0) {
			this.dangerArea.style.display = 'none';
			return;
		}
		this.dangerArea.style.display = 'block';
		if (role === 'owner') {
			const note = document.createElement('div');
			note.dataset.lcTest = 'owner-cannot-leave';
			note.style.cssText = 'font-size:11px;color:#858585;';
			note.textContent = localize('livecollab.members.ownerLeave', "To leave this room, transfer ownership first.");
			this.dangerArea.appendChild(note);
			return;
		}
		const leave = document.createElement('button');
		leave.type = 'button';
		leave.dataset.lcTest = 'leave-room';
		leave.textContent = localize('livecollab.leaveRoomLink', "Leave Room…");
		leave.style.cssText = 'background:transparent;border:1px solid #5a2a2a;color:#d16969;border-radius:4px;padding:4px 8px;font-size:12px;cursor:pointer;width:100%;text-align:left;';
		leave.onmouseenter = () => { leave.style.borderColor = '#F14C4C'; leave.style.color = '#F14C4C'; };
		leave.onmouseleave = () => { leave.style.borderColor = '#5a2a2a'; leave.style.color = '#d16969'; };
		leave.onclick = () => this.confirmLeaveRoom();
		this.dangerArea.appendChild(leave);
	}

	private async confirmLeaveRoom(): Promise<void> {
		const name = livecollabService.roomName ? isolatedName(livecollabService.roomName) : localize('livecollab.thisRoom', "this room");
		const { confirmed } = await this.dialogService.confirm({
			type: Severity.Warning,
			message: localize('livecollab.leaveRoomConfirm', "Leave {0}?", name),
			detail: localize('livecollab.leaveRoomConfirmDetail', "You'll need a new invite to come back."),
			primaryButton: localize({ key: 'livecollab.leaveRoomButton', comment: ['&& denotes a mnemonic'] }, "&&Leave Room")
		});
		if (confirmed) {
			await livecollabService.leaveRoom();
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}
}
