/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { isolatedName } from '../../../../base/common/nameDirection.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IViewsRegistry, Extensions as ViewExtensions, IViewDescriptor, IViewContainersRegistry, ViewContainerLocation } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { LiveCollabChatView } from './livecollabChatView.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { LiveCollabMembersView } from './livecollabMembersView.js';
import { LiveCollabStatusBarContribution } from './livecollabStatusBar.js';
import { VIEW_CONTAINER } from '../../files/browser/explorerViewlet.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { livecollabService } from './livecollabService.js';
import { LIVECOLLAB_SCHEME } from './livecollabFileSystemProvider.js';
import { livecollabRoomCover } from './livecollabRoomCover.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import './livecollabEditorContribution.js';
import { LiveCollabFolderContribution } from './livecollabFolderContribution.js';
import { LiveCollabRoomNotices, roomTerminatedNotice } from './livecollabRoomNotices.js';
import { LiveCollabDashboardOverlay } from './livecollabDashboardOverlay.js';
import { LiveCollabRoomLabelContribution } from './livecollabRoomLabel.js';
import { LiveCollabWorkbenchJoin } from './livecollabWorkbenchJoin.js';
import './livecollabCursorContribution.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { lcLog, setLiveCollabLogService } from './livecollabLog.js';

/**
 * The preload-exposed IPC renderer (window.vscode.ipcRenderer), as far as this
 * file uses it.
 */
interface ILiveCollabIpcRenderer {
	send(channel: string, ...args: unknown[]): void;
	invoke(channel: string, ...args: unknown[]): Promise<unknown>;
	on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
	removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

function getIpcRenderer(): ILiveCollabIpcRenderer | undefined {
	return (mainWindow as unknown as { vscode?: { ipcRenderer?: ILiveCollabIpcRenderer } }).vscode?.ipcRenderer;
}

/**
 * Hands the log service to LiveCollab's diagnostics as early as possible, so
 * they reach renderer.log (lines logged before this are buffered).
 */
class LiveCollabLogContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.livecollabLog';
	constructor(
		@ILogService logService: ILogService,
	) {
		setLiveCollabLogService(logService);
	}
}

registerWorkbenchContribution2(LiveCollabLogContribution.ID, LiveCollabLogContribution, WorkbenchPhase.BlockStartup);

// Bootstrap contribution — runs at startup to wire IRequestService into livecollabService
class LiveCollabBootstrap extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.livecollabBootstrap';
	constructor(
		@IRequestService requestService: IRequestService,
	) {
		super();
		livecollabService.setRequestService(requestService);
		livecollabService.connect().catch(e => lcLog.error('[LiveCollab] connect error:', e));
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	LiveCollabBootstrap,
	LifecyclePhase.Restored
);

// Members icon
const livecollabMembersIcon = registerIcon(
	'livecollab-members',
	Codicon.person,
	localize('livecollabMembersIcon', 'LiveCollab members icon')
);

// Members panel in Explorer sidebar
const membersViewDescriptor: IViewDescriptor = {
	id: LiveCollabMembersView.ID,
	name: { value: LiveCollabMembersView.TITLE, original: 'Members' },
	containerIcon: livecollabMembersIcon,
	ctorDescriptor: new SyncDescriptor(LiveCollabMembersView),
	order: 10,
	weight: 30,
	// Open in a room (CHAT_DESIGN.md, slice 4); a person who collapses it keeps it collapsed.
	collapsed: false,
	canToggleVisibility: true,
	canMoveView: true,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews(
	[membersViewDescriptor],
	VIEW_CONTAINER
);

// Room chat, in the secondary sidebar, which it has to itself (CHAT_DESIGN.md, Where things live).
const livecollabChatIcon = registerIcon('livecollab-chat', Codicon.commentDiscussion, localize('livecollabChatIcon', "LiveCollab room chat icon"));
const CHAT_CONTAINER_ID = 'workbench.view.livecollab.chatContainer';
const chatContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: CHAT_CONTAINER_ID,
	title: { value: localize('livecollabChatContainer', "Room Chat"), original: 'Room Chat' },
	icon: livecollabChatIcon,
	order: 1,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CHAT_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: `${CHAT_CONTAINER_ID}.state`,
	hideIfEmpty: false,
}, ViewContainerLocation.AuxiliaryBar, { doNotRegisterOpenCommand: true });
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: LiveCollabChatView.ID,
	name: { value: LiveCollabChatView.TITLE, original: 'Chat' },
	containerIcon: livecollabChatIcon,
	ctorDescriptor: new SyncDescriptor(LiveCollabChatView),
	order: 1,
	canToggleVisibility: false,
	canMoveView: true,
}], chatContainer);

// A keyboard shortcut to focus the composer (CHAT_DESIGN.md, Composer).
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'livecollab.chat.focusComposer',
			title: { value: localize('livecollab.chat.focusComposer', "Focus Room Chat"), original: 'Focus Room Chat' },
			category: { value: 'LiveCollab', original: 'LiveCollab' },
			f1: true,
			keybinding: { weight: KeybindingWeight.WorkbenchContrib, primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyJ },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(LiveCollabChatView.ID, true);
	}
});

// Status bar
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	LiveCollabStatusBarContribution,
	LifecyclePhase.Restored
);

// Back to Dashboard command
// Navigation, not leaving: membership stays, the room's workspace is torn down.
CommandsRegistry.registerCommand('livecollab.backToDashboard', async (_accessor, source?: unknown) => {
	livecollabService.returnToDashboard(typeof source === 'string' ? source : 'command');
});

// Join Session command
CommandsRegistry.registerCommand('livecollab.joinSession', async (accessor) => {
	const quickInputService = accessor.get(IQuickInputService);
	const notificationService = accessor.get(INotificationService);

	const code = await quickInputService.input({
		prompt: localize('livecollab.joinSession.prompt', 'Enter invite code'),
		placeHolder: localize('livecollab.joinSession.placeholder', 'Paste your invite code here...'),
	});

	if (!code) { return; }

	await livecollabService.connect();
	const result = await livecollabService.joinRoom(code.trim());

	if (result.success) {
		notificationService.notify({
			severity: Severity.Info,
			message: localize('livecollab.joinSession.success', 'Joined session successfully!'),
		});
	} else {
		notificationService.notify({
			severity: Severity.Error,
			message: localize('livecollab.joinSession.error', 'Could not join session: {0}', result.error || 'Unknown error'),
		});
	}
});

import { EditorsOrder } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	LiveCollabFolderContribution,
	LifecyclePhase.Restored
);

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	LiveCollabRoomNotices,
	LifecyclePhase.Restored
);

// ===== LiveCollab Startup Owner =====
// Reads pending token from main process (set by bootstrap after auth),
// stores it in the OS keychain via secretStorageService, then connects.

// How long a sign-in waits for the socket to connect before giving up.
const CONNECT_WAIT_MS = 10000;

class LiveCollabStartupOwner extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.livecollabStartupOwner';

	private readonly _join = new LiveCollabWorkbenchJoin({
		isConnected: () => livecollabService.isConnected,
		connect: () => this._signInAndConnect(),
		join: (roomId, roomName) => this._joinRoom(roomId, roomName),
	});

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		// Listen for room entries BEFORE any sign-in, and whatever its outcome:
		// a failed startup sign-in used to leave this listener unregistered for
		// the app's lifetime — the guest's empty window (HANDOFF, "BLOCKER — the
		// guest's workbench never joins the room"). A join that finds no
		// connection signs in then (LiveCollabWorkbenchJoin). Fires on every
		// room open; roomId/roomName arrive as the event payload.
		const ipc = getIpcRenderer();
		if (ipc) {
			const onJoinRoom = (_event: unknown, ...args: unknown[]) => {
				const payload = args[0] as { roomId?: string; roomName?: string } | undefined;
				if (payload?.roomId) {
					lcLog.info('[LiveCollab] join-room received:', payload.roomId);
					this._enterRoom(payload.roomId, payload.roomName);
				}
			};
			ipc.on('vscode:livecollab-join-room', onJoinRoom);
			this._register(toDisposable(() => ipc.removeListener('vscode:livecollab-join-room', onJoinRoom)));
			// Sign-out on the dashboard (relayed by main): close this view's
			// connection so the next account doesn't act as the previous one.
			const onSignedOut = () => livecollabService.signOut();
			ipc.on('vscode:livecollab-signed-out', onSignedOut);
			this._register(toDisposable(() => ipc.removeListener('vscode:livecollab-signed-out', onSignedOut)));
			// The main process holds a room opened before this point and
			// delivers it now (LiveCollabJoinRelay).
			ipc.send('vscode:livecollab-workbench-listening');
			this._join.start();
		}
		// Membership ended (left, kicked, room ended): go to the dashboard, which says why. The
		// message is shown there because the dashboard covers this window at once; a notice here
		// would be hidden behind it. The workspace teardown has already run (onRoomLeft).
		this._register(livecollabService.onRoomTerminated(({ roomId, roomName, reason, by }) => {
			const ipc = getIpcRenderer();
			if (ipc) { ipc.send('vscode:livecollab-load-dashboard', { roomId, notice: roomTerminatedNotice(reason, roomName, by) }); }
		}));
		// The room's own editors (livecollab://, never VS Code's internal
		// editors or panels) are room-session state: closed when the session
		// ends (PHASE2_OVERLAY_DESIGN.md section 4). The close completes after
		// the next join may have started, so only an editor from an earlier
		// room than the one just left counts as left over.
		const roomEditors = () => this.editorService.getEditors(EditorsOrder.SEQUENTIAL).filter(identifier => identifier.editor.resource?.scheme === LIVECOLLAB_SCHEME);
		this._register(livecollabService.registerRoomState({
			name: 'room editors',
			clear: () => {
				const open = roomEditors();
				if (open.length > 0) {
					this.editorService.closeEditors(open);
				}
			},
			inspect: ({ left, entering }) => roomEditors()
				.map(identifier => identifier.editor.resource!)
				.filter(resource => resource.authority !== left && resource.authority !== entering)
				.map(resource => `editor ${resource.toString()}`),
		}));
	}

	private async _enterRoom(roomId: string, roomName: string | undefined): Promise<void> {
		const result = await this._join.join(roomId, roomName);
		if (result === 'notConnected') {
			lcLog.warn('[LiveCollab] room-join: not connected after one sign-in attempt —', roomId, 'not joined');
			// No room will become ready; don't leave "Opening room…" over the error.
			livecollabRoomCover.hide();
			const name = roomName ? isolatedName(roomName) : localize('livecollab.unnamedRoom', "the room");
			this.notificationService.error(localize('livecollab.joinNotConnected', "Couldn't connect to {0}. Go back to the dashboard and open the room again.", name));
		}
	}

	// Mint a Clerk session JWT for the socket and connect, once. Called at
	// startup and again by a room entry that finds no connection — never in
	// a loop (LiveCollabWorkbenchJoin). Resolves whether the socket connected.
	private async _signInAndConnect(): Promise<boolean> {
		try {
			const ipc = getIpcRenderer();
			if (!ipc) { return false; }
			// Main holds the device credential (option F) and mints from it; nothing is read here.
			const mintResult = await ipc.invoke('vscode:livecollab-mint-token') as { jwt: string | null; error?: string } | null;
			if (!mintResult || !mintResult.jwt) {
				lcLog.info('[LiveCollab] could not mint a session token - reason:', mintResult?.error ?? '(no reply)');
				return false;
			}
			const dashNames = mainWindow as unknown as { _dashDisplayName?: string; _dashFullName?: string };
			const displayName = dashNames._dashDisplayName || dashNames._dashFullName || 'User';
			livecollabService.setToken(mintResult.jwt);
			(livecollabService as unknown as { _displayName: string })._displayName = displayName;
			await livecollabService.connect();
			// Wait for the socket to actually be connected.
			await new Promise<void>(resolve => {
				if (livecollabService.isConnected) { resolve(); return; }
				const done = () => { listener.dispose(); clearTimeout(timer); resolve(); };
				const listener = livecollabService.onConnected(done);
				const timer = setTimeout(done, CONNECT_WAIT_MS);
			});
			lcLog.info(livecollabService.isConnected ? '[LiveCollab] workbench connected with Clerk token' : '[LiveCollab] workbench socket not connected after wait');
			return livecollabService.isConnected;
		} catch (e) {
			lcLog.error('[LiveCollab] sign-in error:', e);
			return false;
		}
	}

	private async _joinRoom(roomId: string, roomName: string | undefined): Promise<void> {
		try {
			// joinExistingRoom ends the current room session first (switch).
			await livecollabService.joinExistingRoom(roomId, roomName);
			lcLog.info('[LiveCollab] joined room:', roomId);
			setTimeout(() => livecollabService.fetchMembers(roomId), 500);
		} catch (e) {
			lcLog.error('[LiveCollab] room-join error:', e);
		}
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	LiveCollabStartupOwner,
	LifecyclePhase.Restored
);

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	LiveCollabDashboardOverlay,
	LifecyclePhase.Restored
);

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	LiveCollabRoomLabelContribution,
	LifecyclePhase.Restored
);
