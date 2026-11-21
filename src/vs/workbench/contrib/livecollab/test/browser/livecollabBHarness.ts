/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IRoomSharingProvider, IRoomSharingService } from '../../../../services/livecollab/common/roomSharing.js';
import { Schemas } from '../../../../../base/common/network.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { Handler } from '../../../../../editor/common/editorCommon.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { createTestCodeEditor } from '../../../../../editor/test/browser/testCodeEditor.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { INotification, INotificationHandle, INotificationService, IPromptChoice, IPromptOptions, NoOpNotification, NotificationPriority, Severity } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent, Workspace, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { IWorkingCopyFileService } from '../../../../services/workingCopy/common/workingCopyFileService.js';
import { TestEditorService, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { ILiveCollabClient } from '../../browser/livecollabClient.js';
import { LiveCollabFileSystemProvider } from '../../browser/livecollabFileSystemProvider.js';
import { LiveCollabRoomNotices } from '../../browser/livecollabRoomNotices.js';
import { LiveCollabFolderContribution } from '../../browser/livecollabFolderContribution.js';
import { ILiveCollabSocket, ILiveCollabSocketOptions, LiveCollabService } from '../../browser/livecollabService.js';
// As in the app (livecollab.contribution.ts): this module sets globalThis.__livecollabMonacoAPI at
// load, which the Yjs bundle reads when it loads. Without it every bundle load fails.
import { LiveCollabEditorContribution } from '../../browser/livecollabEditorContribution.js';
import { LiveCollabCursorContribution } from '../../browser/livecollabCursorContribution.js';
import { IConfirmation, IConfirmationResult, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { ILiveCollabClaimStore, ILiveCollabFolderClaim, ILiveCollabFolderClaims, LiveCollabFolderClaims } from '../../../../../platform/windows/common/livecollabFolderClaims.js';
import { dirname } from '../../../../../base/common/path.js';

// The unit runner's page (test/unit/electron/renderer.html) require()s every package.json
// dependency to build its import map, yjs among them, so Yjs's already-imported flag is set
// before any test loads and the app's bundle would warn on load (a failure here). The app loads
// Yjs once, from the bundle; nothing in the runner uses the copy the page loaded.
delete (globalThis as unknown as Record<string, unknown>)['__ $YJS$ __'];

/**
 * Layer B's stand-in for a disk (TEST_HARNESS_TRIAGE.md, "How each test environment differs"):
 * an in-memory `file:` provider that also answers realpath (no links, so a path is its own real
 * path) and accepts deletes to the trash (it deletes). The browser test layer cannot load the
 * real disk provider, and no B test so far needs a link, a mode or a real trash.
 */
export class TestDisk extends InMemoryFileSystemProvider {

	/** How long realpath takes for a path: a real disk answers with I/O, this one at once unless told. */
	readonly realpathDelays = new Map<string, number>();

	override get capabilities(): FileSystemProviderCapabilities {
		return super.capabilities | FileSystemProviderCapabilities.FileRealpath | FileSystemProviderCapabilities.Trash;
	}

	async realpath(resource: URI): Promise<string> {
		const delay = this.realpathDelays.get(resource.path);
		if (delay) {
			await timeout(delay);
		}
		await this.stat(resource);
		return resource.path;
	}
}

/**
 * The window's workspace, for one client: the folders it has open, changed the way the
 * workbench changes them (Open Folder, the guest's virtual folder, removal on leave).
 */
class TestRoomWorkspace {

	private readonly _onDidChangeWorkspaceFolders = new Emitter<IWorkspaceFoldersChangeEvent>();
	readonly onDidChangeWorkspaceFolders = this._onDidChangeWorkspaceFolders.event;
	private readonly _workspace = new Workspace('layer-b-workspace', [], false, null, () => false);

	constructor(disposables: Pick<DisposableStore, 'add'>) {
		disposables.add(this._onDidChangeWorkspaceFolders);
	}

	/**
	 * How long a change of the folder list takes to apply. The workbench's takes effect only once
	 * the workspace file is written (WorkspaceService.updateFolders), so its folders are briefly the
	 * old ones after the call; 0 applies at once.
	 */
	changeDelay = 0;

	/**
	 * Whether a change works out the new folder list when it is called and applies it after
	 * `changeDelay`, as a single-folder or empty window does: it enters a new untitled workspace
	 * (AbstractWorkspaceEditingService.createAndEnterWorkspace), built from the folders it saw when
	 * called. Off: the list is read once the delay has passed.
	 */
	readsFoldersWhenCalled = false;

	getWorkspace(): Workspace {
		return this._workspace;
	}

	/**
	 * Puts the window in an untitled workspace (Workspaces/<id>/workspace.json), as a desktop window is
	 * once a folder is open. Deleting that file (a room's leave, deleteUntitledWorkspace) then empties
	 * the folder list a moment later, as the workbench's reload of the missing file does
	 * (configuration.ts, FileServiceBasedWorkspaceConfiguration.load; the real WorkspaceService is
	 * tested doing this in livecollabLeaveFolders.test.ts).
	 */
	useUntitledWorkspaceFile(): void {
		this._workspace.configuration = URI.file('/user-data/Workspaces/layer-b/workspace.json');
	}

	/** The untitled workspace file deleted: the folder list is read again, from nothing. */
	async deleteUntitledWorkspace(): Promise<void> {
		if (!this._workspace.configuration) {
			return;
		}
		setTimeout(() => this._set([], [...this._workspace.folders]), 50);
	}

	async updateFolders(index: number, deleteCount = 0, foldersToAdd: { uri: URI; name?: string }[] = []): Promise<void> {
		const change = (before: WorkspaceFolder[]) => {
			const after = [...before];
			const removed = after.splice(index, deleteCount, ...foldersToAdd.map(add => new WorkspaceFolder({ uri: add.uri, name: add.name ?? add.uri.path.split('/').pop() ?? '', index: 0 })));
			return { after, removed };
		};
		await this._apply(change);
	}

	async addFolders(foldersToAdd: { uri: URI; name?: string }[]): Promise<void> {
		return this.updateFolders(this._workspace.folders.length, 0, foldersToAdd);
	}

	async removeFolders(uris: URI[]): Promise<void> {
		await this._apply(before => {
			const removed = before.filter(folder => uris.some(uri => isEqual(uri, folder.uri)));
			return { after: before.filter(folder => !removed.includes(folder)), removed };
		});
	}

	/** Applies a change of the folder list, read when called or after the delay (readsFoldersWhenCalled). */
	private async _apply(change: (before: WorkspaceFolder[]) => { after: WorkspaceFolder[]; removed: WorkspaceFolder[] }): Promise<void> {
		const seen = this.readsFoldersWhenCalled ? change(this._workspace.folders) : undefined;
		if (this.changeDelay) {
			await timeout(this.changeDelay);
		}
		const { after, removed } = seen ?? change(this._workspace.folders);
		this._set(after, removed);
	}

	private _set(folders: WorkspaceFolder[], removed: WorkspaceFolder[]): void {
		const reindexed = folders.map((folder, index) => new WorkspaceFolder({ uri: folder.uri, name: folder.name, index }));
		const added = reindexed.filter(folder => !this._workspace.folders.some(old => isEqual(old.uri, folder.uri)));
		this._workspace.folders = reindexed;
		this._onDidChangeWorkspaceFolders.fire({ added, removed, changed: [] });
	}
}

/** The vendored socket.io client socket, with the parts a network drop uses. */
interface IVendorSocket extends ILiveCollabSocket {
	readonly io: { reconnection(enabled: boolean): void; readonly engine: { close(): void } | undefined };
	connect(): void;
}

/**
 * One client's connection, as the network sees it. `drop` closes the transport the way a lost
 * connection does (socket.io reports "transport close"), with reconnection held off; `restore`
 * lets it reconnect, which runs the app's own reconnect path (re-join, then the folder's attach).
 * TEST_HARNESS_TRIAGE.md, environments: offline is a socket close, not a dead network.
 */
export interface IBNetwork {
	drop(): Promise<void>;
	restore(): Promise<void>;
	/**
	 * Holds every message the room sends this client for `ms` before the app sees it, in order,
	 * like a slow link in that direction (0 delivers at once again). What the client sends, and
	 * the server's replies to it (acks), are not held.
	 */
	delayIncoming(ms: number): void;
	/**
	 * Changes every `event` message the room sends this client before the app sees it, as a
	 * malformed message from the room would arrive (undefined puts it back as sent).
	 */
	rewriteIncoming(event: string, rewrite: ((...args: unknown[]) => unknown[]) | undefined): void;
	/** Holds every `event` message this client sends for `ms` before it leaves, like a slow link for that message (0 sends at once again). */
	delayOutgoing(event: string, ms: number): void;
	/** Holds one incoming event `ms` before the app's listeners hear it (instead of the general delay). */
	delayIncomingEvent(event: string, ms: number): void;
	/** Sends `event` on this client's connection as the app would, and resolves with the server's answer. */
	ask<T>(event: string, payload: object): Promise<T>;
}

/**
 * A file open in one client's window: a code editor with the real LiveCollab editor contribution,
 * which binds it to the room's document for that file as the app does.
 */
export interface IBEditor {
	readonly editor: ICodeEditor;
	/** Types `text` at the end of the file, as keystrokes do. */
	type(text: string): void;
	text(): string;
	/**
	 * Puts the editor on `target`, keeping its text: what the workbench does to an open editor
	 * when its file is moved or renamed, as soon as the move completes and before any reply from
	 * the room. B has no editor service, so the test does it at that point.
	 */
	follow(target: URI): void;
	/** Shows `resource`, holding `content`, in this editor instead of its file: switching to another tab in the same editor group. */
	switchTo(resource: URI, content: string): void;
	/**
	 * Makes this the window's active editor, as clicking into its editor group or its tab does
	 * (opening an editor makes it active too).
	 */
	activate(): void;
	/**
	 * Closes the editor, as closing its tab does: if it was active, the editor active before it
	 * becomes active again, or none.
	 */
	close(): void;
	/** Where this editor draws other members' cursors in its file, as "line:column". */
	remoteCursors(): string[];
}

/** One LiveCollab client as a window holds it: its service, its file systems, its folder contribution. */
export interface IBClient {
	readonly service: LiveCollabService;
	/** The client's own file service: its disk (`file:`) and the room's virtual files (`livecollab:`). */
	readonly fileService: IFileService;
	readonly workingCopyFileService: IWorkingCopyFileService;
	readonly workspace: TestRoomWorkspace;
	readonly network: IBNetwork;
	/** The client's room file system: its id maps (server ids by room path, and the owner's disk paths). */
	readonly fileSystem: LiveCollabFileSystemProvider;
	/** Opens `resource` (a guest's `livecollab:` file or the owner's disk file) in an editor. */
	openEditor(resource: URI): Promise<IBEditor>;
	/**
	 * Opens a disk file as the workbench does: on its text file model, so typing leaves it dirty
	 * (unsaved) and the persister saves through it.
	 */
	openFileEditor(resource: URI): Promise<IBEditor>;
	/** Opens an editor on `content` that isn't read through the file service: an untitled file, or the settings. */
	openText(resource: URI, content: string): IBEditor;
	/** What outlives the window when the app is quit: its disk and its application storage. */
	readonly kept: IBKept;
	/** Every notice and prompt the window showed, in order. A prompt's choices can be run. */
	readonly notices: IBNotice[];
	/** The window's log (its info lines). */
	readonly logged: readonly string[];
	/** What the window sent to main for its dashboard ('vscode:livecollab-load-dashboard', '-dashboard-notice'). */
	readonly toMain: readonly IBMainMessage[];
	/**
	 * Main, as the window's dashboard notices see it: whether the dashboard is in front (it is, unless a
	 * test says otherwise), how long a notice takes to reach main and main's answer to reach the window
	 * (ms), and the notices main showed on the dashboard.
	 */
	readonly main: { dashboardInFront: boolean; handleDelay: number; answerDelay: number; readonly shown: string[] };
	/** The window's dialogs: each question asked, and how the next is answered. */
	readonly dialogs: { readonly asked: IBQuestion[]; readonly closed: IBQuestion[]; answer: (question: IBQuestion) => boolean | Promise<boolean> };
	/** What the Explorer's Copy Folders choice is told about a drop target (IRoomSharingService). */
	readonly roomSharing: Pick<IRoomSharingService, 'isInRoom' | 'sharedLocationOf'>;
}

/** A notice or prompt a window showed. */
export interface IBNotice {
	readonly severity: Severity;
	readonly message: string;
	readonly choices: readonly IPromptChoice[];
	/** Shown only in the notification center, never as a toast. */
	readonly silent: boolean;
	/** Closed by the code that showed it (its handle's close()). */
	readonly closed: boolean;
}

/** A notification's handle that records its closing. */
class RecordedNotification extends NoOpNotification {
	private readonly _onDidClose = new Emitter<void>();
	override readonly onDidClose = this._onDidClose.event;

	constructor(private readonly notice: { closed: boolean }) {
		super();
	}

	override close(): void {
		if (!this.notice.closed) {
			this.notice.closed = true;
			this._onDidClose.fire();
			this._onDidClose.dispose();
		}
	}
}

/** A message the window sent to the main process. */
export interface IBMainMessage {
	readonly channel: string;
	readonly payload: unknown;
}

/** The window's log, recording its info lines so a test can read them. */
class RecordingLogService extends NullLogService {
	readonly lines: string[] = [];

	override info(message: string): void {
		this.lines.push(message);
	}
}

/** The test notification service, recording what's shown so a test can read it and choose. */
class RecordingNotificationService extends TestNotificationService {
	readonly shown: IBNotice[] = [];
	override notify(notification: INotification): INotificationHandle {
		const notice = { severity: notification.severity, message: String(notification.message), choices: [], silent: notification.priority === NotificationPriority.SILENT, closed: false };
		this.shown.push(notice);
		return new RecordedNotification(notice);
	}
	override prompt(severity: Severity, message: string, choices: IPromptChoice[], options?: IPromptOptions): INotificationHandle {
		const notice = { severity, message, choices, silent: options?.priority === NotificationPriority.SILENT, closed: false };
		this.shown.push(notice);
		return new RecordedNotification(notice);
	}
}

/** What a client keeps across a restart of the app: its disk and its storage, and the computer's record of shared folders (main's, in the app). */
export interface IBKept {
	readonly disk: TestDisk;
	readonly storage: IStorageService;
	readonly folderClaims: ILiveCollabFolderClaims;
}

/** The computer's record of shared folders over a test disk: no links, and a path is its folder's identity. */
function testFolderClaims(disk: TestDisk): ILiveCollabFolderClaims {
	const exists = async (path: string) => {
		try {
			await disk.stat(URI.file(path));
			return path;
		} catch {
			return undefined;
		}
	};
	let saved: readonly ILiveCollabFolderClaim[] = [];
	const store: ILiveCollabClaimStore = { load: () => saved, save: claims => { saved = claims; } };
	return new LiveCollabFolderClaims({ realpath: exists, identity: exists, parent: path => dirname(path) === path ? undefined : dirname(path) }, store);
}

/** A "Share … with …?" question a window asked. */
export interface IBQuestion {
	readonly message: string;
	readonly detail: string;
	readonly primaryButton: string;
	readonly cancelButton: string;
}

/** The test dialog service, recording each question; it answers with `answer` (Share, unless a test says otherwise). */
/**
 * The window's questions, shown as VS Code shows them: one at a time, each only once the one
 * before it is answered (DialogHandlerContribution.processDialogs). A question is in `asked` once
 * it is on screen.
 */
class RecordingDialogService extends TestDialogService {
	readonly asked: IBQuestion[] = [];
	/** Questions closed by their token (shown or still waiting): they resolved as cancelled. */
	readonly closed: IBQuestion[] = [];
	answer: (question: IBQuestion) => boolean | Promise<boolean> = () => true;
	private readonly _shown = new Sequencer();
	override confirm(confirmation: IConfirmation): Promise<IConfirmationResult> {
		return this._shown.queue(async () => {
			const question = { message: confirmation.message, detail: confirmation.detail ?? '', primaryButton: (confirmation.primaryButton ?? '').replace(/&&/g, ''), cancelButton: confirmation.cancelButton ?? '' };
			const token = confirmation.token;
			// Dismissed by its token (BrowserDialogHandler.doShow disposes the dialog): it resolves as cancelled, and the next question is shown.
			if (token?.isCancellationRequested) {
				this.closed.push(question);
				return { confirmed: false };
			}
			this.asked.push(question);
			const store = new DisposableStore();
			try {
				const dismissed = new Promise<boolean>(resolve => token && store.add(token.onCancellationRequested(() => resolve(false))));
				const confirmed = await Promise.race([Promise.resolve(this.answer(question)), dismissed]);
				if (token?.isCancellationRequested) {
					this.closed.push(question);
					return { confirmed: false };
				}
				return { confirmed };
			} finally {
				store.dispose();
			}
		});
	}
}

/**
 * Builds one client's window: the workbench test services, a test disk, a workspace that can
 * change, and the folder contribution (with its room persister) taking this client through
 * ILiveCollabClient. The service is not yet signed in or connected.
 */
export function createBClient(serverUrl: string, disposables: Pick<DisposableStore, 'add'>, restartOf?: IBKept): IBClient {
	const instantiationService = workbenchInstantiationService({ fileService: () => disposables.add(new FileService(new NullLogService())) }, disposables);
	const fileService = instantiationService.get(IFileService);
	// A restart: a new window on the same disk and the same application storage.
	const disk = restartOf?.disk ?? disposables.add(new TestDisk());
	const kept: IBKept = restartOf ?? { disk, storage: instantiationService.get(IStorageService), folderClaims: testFolderClaims(disk) };
	disposables.add(fileService.registerProvider(Schemas.file, kept.disk));
	instantiationService.stub(IStorageService, kept.storage);
	const notifications = new RecordingNotificationService();
	instantiationService.stub(INotificationService, notifications);
	const dialogs = new RecordingDialogService();
	instantiationService.stub(IDialogService, dialogs);
	const log = new RecordingLogService();
	instantiationService.stub(ILogService, log);
	let sharingProvider: IRoomSharingProvider | undefined;
	const roomSharing: IRoomSharingService = {
		_serviceBrand: undefined,
		isInRoom: () => sharingProvider?.isInRoom() ?? false,
		sharedLocationOf: resource => sharingProvider?.sharedLocationOf(resource),
		setProvider: provider => {
			sharingProvider = provider;
			return toDisposable(() => { sharingProvider = undefined; });
		},
	};
	instantiationService.stub(IRoomSharingService, roomSharing);

	const workspace = new TestRoomWorkspace(disposables);
	instantiationService.stub(IWorkspaceContextService, workspace);
	instantiationService.stub(IWorkspaceEditingService, workspace);
	instantiationService.stub(IWorkspacesService, 'deleteUntitledWorkspace', () => workspace.deleteUntitledWorkspace());
	// Nothing in a B test opens a terminal or the log.
	instantiationService.stub(ITerminalService, { instances: [], whenConnected: Promise.resolve() });
	instantiationService.stub(IOutputService, {});

	let socket: IVendorSocket | undefined;
	const openSocket = async (url: string, options: ILiveCollabSocketOptions): Promise<ILiveCollabSocket> => {
		// @ts-ignore the vendored bundle has no types; the app loads it the same way (livecollabService.ts)
		const { io } = await import('../../browser/vendor/socket.io.esm.min.js');
		const raw = io(url, options) as IVendorSocket;
		socket = raw;
		// The app's listeners, behind the incoming delay (zero: called at once, as without the harness).
		const held: ILiveCollabSocket = {
			get connected() { return raw.connected; },
			get id() { return raw.id; },
			emit: (event, ...args) => {
				const delay = outgoingDelays.get(event) ?? 0;
				if (delay === 0) {
					raw.emit(event, ...args);
				} else {
					setTimeout(() => raw.emit(event, ...args), delay);
				}
			},
			disconnect: () => raw.disconnect(),
			on: (event, listener) => raw.on(event, (...sent: never[]) => {
				const rewrite = rewrites.get(event);
				const args = (rewrite ? rewrite(...sent) : sent) as never[];
				const delay = incomingDelays.get(event) ?? incomingDelay;
				if (delay === 0) {
					listener(...args);
				} else {
					setTimeout(() => listener(...args), delay);
				}
			}),
		};
		return held;
	};
	let incomingDelay = 0;
	const rewrites = new Map<string, (...args: unknown[]) => unknown[]>();
	const outgoingDelays = new Map<string, number>();
	const incomingDelays = new Map<string, number>();
	// The window's messages to main (the dashboard), recorded; main answers a notice for the
	// dashboard as the window's navigation does: delivered only while the dashboard is in front.
	const toMain: IBMainMessage[] = [];
	const main = { dashboardInFront: true, handleDelay: 0, answerDelay: 0, shown: [] as string[] };
	const fromMain = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();
	const service = disposables.add(new LiveCollabService(serverUrl, openSocket, undefined, {
		send: (channel, ...args) => {
			toMain.push({ channel, payload: args[0] });
			if (channel === 'vscode:livecollab-dashboard-notice') {
				const { id, notice } = (args[0] ?? {}) as { id?: unknown; notice?: string };
				// Main handles it when it arrives: shown only if the dashboard is in front then.
				setTimeout(() => {
					const delivered = main.dashboardInFront;
					if (delivered && notice) {
						main.shown.push(notice);
					}
					setTimeout(() => fromMain.get('vscode:livecollab-dashboard-notice-result')?.forEach(listener => listener({}, { id, delivered })), main.answerDelay);
				}, main.handleDelay);
			}
		},
		invoke: async () => undefined,
		on: (channel, listener) => {
			let listeners = fromMain.get(channel);
			if (!listeners) {
				listeners = new Set();
				fromMain.set(channel, listeners);
			}
			listeners.add(listener);
		},
		removeListener: (channel, listener) => { fromMain.get(channel)?.delete(listener); },
	}));
	const network: IBNetwork = {
		drop: async () => {
			const gone = Event.toPromise(service.onDisconnected);
			socket!.io.reconnection(false);
			socket!.io.engine?.close();
			await gone;
		},
		restore: async () => {
			const back = Event.toPromise(service.onConnected);
			socket!.io.reconnection(true);
			socket!.connect();
			await back;
		},
		delayIncoming: ms => { incomingDelay = ms; },
		delayOutgoing: (event, ms) => { outgoingDelays.set(event, ms); },
		delayIncomingEvent: (event, ms) => { incomingDelays.set(event, ms); },
		ask: <T>(event: string, payload: object) => new Promise<T>(resolve => socket!.emit(event, payload, (answer: T) => resolve(answer))),
		rewriteIncoming: (event, rewrite) => {
			if (rewrite) {
				rewrites.set(event, rewrite);
			} else {
				rewrites.delete(event);
			}
		},
	};
	// The window's active editor, as the editor service reports it. Opening an editor makes it
	// active; closing the active one hands it back to the one active before (the group's order).
	const editorService = instantiationService.get(IEditorService) as TestEditorService;
	const activeChanged = disposables.add(new Emitter<void>());
	instantiationService.stub(IEditorService, 'onDidActiveEditorChange', activeChanged.event);
	const activeOrder: ICodeEditor[] = [];
	const setActive = (editor: ICodeEditor | undefined) => {
		editorService.activeTextEditorControl = editor;
		activeChanged.fire();
	};
	const activate = (editor: ICodeEditor) => {
		const at = activeOrder.indexOf(editor);
		if (at >= 0) {
			activeOrder.splice(at, 1);
		}
		activeOrder.push(editor);
		setActive(editor);
	};
	const closed = (editor: ICodeEditor) => {
		const wasActive = editorService.activeTextEditorControl === editor;
		const at = activeOrder.indexOf(editor);
		if (at >= 0) {
			activeOrder.splice(at, 1);
		}
		if (wasActive) {
			setActive(activeOrder.at(-1));
		}
	};
	const fileSystem = disposables.add(new LiveCollabFileSystemProvider(undefined, service));
	instantiationService.stub(ILiveCollabClient, { _serviceBrand: undefined, service, fileSystem, folderClaims: kept.folderClaims });
	disposables.add(instantiationService.createInstance(LiveCollabFolderContribution));
	disposables.add(instantiationService.createInstance(LiveCollabRoomNotices));

	const openEditor = async (resource: URI): Promise<IBEditor> => {
		const content = (await fileService.readFile(resource)).value.toString();
		return editorOn(disposables.add(createTextModel(content, null, undefined, resource)));
	};
	const openFileEditor = async (resource: URI): Promise<IBEditor> => {
		const fileModel = disposables.add(await instantiationService.get(ITextFileService).files.resolve(resource));
		return editorOn(fileModel.textEditorModel!);
	};
	const editorOn = (model: ITextModel): IBEditor => {
		const editor = disposables.add(createTestCodeEditor(model));
		disposables.add(instantiationService.createInstance(LiveCollabEditorContribution, editor));
		disposables.add(instantiationService.createInstance(LiveCollabCursorContribution, editor));
		activate(editor);
		return {
			editor,
			type: text => {
				const model = editor.getModel()!;
				editor.setPosition(model.getFullModelRange().getEndPosition());
				editor.trigger('keyboard', Handler.Type, { text });
			},
			text: () => editor.getModel()!.getValue(),
			follow: target => editor.setModel(disposables.add(createTextModel(editor.getModel()!.getValue(), null, undefined, target))),
			switchTo: (resource, content) => editor.setModel(disposables.add(createTextModel(content, null, undefined, resource))),
			activate: () => activate(editor),
			close: () => {
				editor.dispose();
				closed(editor);
			},
			remoteCursors: () => (editor.getModel()?.getAllDecorations() ?? [])
				.filter(decoration => decoration.options.description === 'livecollab-remote-cursor')
				.map(decoration => `${decoration.range.startLineNumber}:${decoration.range.startColumn}`),
		};
	};

	const openText = (resource: URI, content: string): IBEditor => editorOn(disposables.add(createTextModel(content, null, undefined, resource)));

	return { service, fileService, workingCopyFileService: instantiationService.get(IWorkingCopyFileService), workspace, network, fileSystem, openEditor, openFileEditor, openText, kept, notices: notifications.shown, logged: log.lines, toMain, main, dialogs, roomSharing };
}
