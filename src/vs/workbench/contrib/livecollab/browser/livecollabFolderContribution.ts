/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { basename, isEqual, isEqualOrParent } from '../../../../base/common/resources.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkspaceContextService, IWorkspaceFolder, IWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { ILiveCollabTreeItem, IRoomReconciledSummary, LiveCollabService } from './livecollabService.js';
import { filesRemovedBy, IOwnerOfflineChanges, IReconcile, IRoomRemovals, isLargeRemoval, outermostMoves, planOwnerOfflineChanges, planRoomRemovals, reconcileBeforeAttach } from './livecollabReconcile.js';
import { LiveCollabFileSystemProvider, LIVECOLLAB_SCHEME } from './livecollabFileSystemProvider.js';
import { ILiveCollabClient } from './livecollabClient.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { IFileService, FileChangesEvent, FileOperation, FileOperationResult, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { IWorkingCopyFileService } from '../../../services/workingCopy/common/workingCopyFileService.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EditorsOrder, IEditorIdentifier } from '../../../common/editor.js';
import { IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { INotificationHandle, INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { localize } from '../../../../nls.js';
import { Schemas } from '../../../../base/common/network.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { lcLog } from './livecollabLog.js';
import { whenFoldersLeave } from './livecollabLeaveFolders.js';
import { roomPathProblem, secretFileRule, secretFolderRule } from './livecollabShareRules.js';
import { IContainmentDisk, IContainmentRoot, isUnderWithheld, judgeDiskPath, judgeLink, MoveCorrections, planLocalRename, planOwnerMove } from './livecollabContainment.js';
import { IOutputService } from '../../../services/output/common/output.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { windowLogId } from '../../../services/log/common/logConstants.js';
import { livecollabRoomCover } from './livecollabRoomCover.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { hashText, LiveCollabRoomPersister } from './livecollabRoomPersister.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IDecorationsService } from '../../../services/decorations/common/decorations.js';
import { Emitter } from '../../../../base/common/event.js';
import { ResourceSet } from '../../../../base/common/map.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { raceTimeout, Sequencer } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { ILiveCollabFolderClaim, ILiveCollabFolderClaims, ILiveCollabKnownFolder } from '../../../../platform/windows/common/livecollabFolderClaims.js';
import { IRoomSharedLocation, IRoomSharingService } from '../../../services/livecollab/common/roomSharing.js';

/**
 * The preload-exposed IPC renderer (window.vscode.ipcRenderer), as far as this
 * contribution uses it.
 */
interface IOverlayIpcRenderer {
	send(channel: string, ...args: unknown[]): void;
	on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
	removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

// PHASE4 attach guards (PHASE4_REPLICATE_ON_JOIN.md section 7).
const PER_FILE_CAP_BYTES = 1024 * 1024;      // 1 MB per file
const TOTAL_FOLDER_CAP_MB = 25;
const TOTAL_FOLDER_CAP_BYTES = TOTAL_FOLDER_CAP_MB * 1024 * 1024;
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.next', '__pycache__', '.DS_Store']);
// Genuinely-binary extensions (text formats like .svg/.map are intentionally
// NOT here). A null-byte sniff on the actual bytes is the backstop.
const BINARY_EXTS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.pdf',
	'.zip', '.gz', '.tar', '.tgz', '.rar', '.7z', '.bz2',
	'.wasm', '.exe', '.dll', '.so', '.dylib', '.bin', '.node', '.class', '.jar', '.pyc',
	'.woff', '.woff2', '.ttf', '.otf', '.eot',
	'.mp3', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wav', '.ogg', '.flac',
	'.lockb'
]);
// A folder named .env or .env.* (often a Python virtualenv) is never walked.
// A file of that name is a secret (livecollabShareRules.ts).
function isEnvFolderName(name: string): boolean {
	return name === '.env' || name.startsWith('.env.');
}

/**
 * One entry of the folder tree read off disk and sent to the server on attach
 * (`room:attach`). A directory has `children`; a file has `content`, or
 * `oversize: true` instead when it is over the per-file cap.
 */
/** Room paths of the files the attach walk found over the per-file cap. */
function oversizePaths(items: readonly IAttachTreeItem[]): string[] {
	return items.flatMap(item => item.type === 'directory' ? oversizePaths(item.children ?? []) : item.oversize ? [item.path] : []);
}

/** The owner's id map as saved across restarts, with the folder it belongs to. */
interface IStoredKnownIds {
	readonly folder: string;
	readonly ids: [string, string][];
}

/** What the reconcile applied, for the notice. */
interface IReconcileOutcome {
	readonly movedInRoom: { readonly from: string; readonly to: string }[];
	readonly removedInRoom: string[];
	readonly keptChanged: readonly string[];
	readonly renamedHere: { readonly from: string; readonly to: string }[];
	readonly deletedHere: string[];
}

/** How many changes a reconcile notice names; the rest are counted, and listed in the log. */
const FILES_NAMED_IN_NOTICE = 3;
/** A batch of disk changes made outside the app runs after this long without another (a checkout writes in bursts)... */
const OUTSIDE_QUIET_MS = 500;
/** ...or this long after its first change, whichever comes first. */
const OUTSIDE_MAX_WAIT_MS = 3000;
/** How long a path a working-copy operation here just sent stays this window's own, not an outside change. */
const IN_APP_MS = 5000;

/** Every room path in an attach walk, folders included. */
function walkPaths(items: readonly IAttachTreeItem[]): string[] {
	return items.flatMap(item => [item.path, ...walkPaths(item.children ?? [])]);
}

/** The folders in an attach walk. */
function walkFolders(items: readonly IAttachTreeItem[]): string[] {
	return items.flatMap(item => item.type === 'directory' ? [item.path, ...walkFolders(item.children ?? [])] : []);
}

/** The text of each file in an attach walk that carries it, by room path. */
function walkContents(items: readonly IAttachTreeItem[]): Map<string, string> {
	const contents = new Map<string, string>();
	for (const item of items) {
		if (item.content !== undefined) { contents.set(item.path, item.content); }
		for (const [path, content] of walkContents(item.children ?? [])) { contents.set(path, content); }
	}
	return contents;
}

/**
 * The walk without the paths in `leaveOut` (a folder left out takes its contents), except the
 * paths in `keep`: a folder left out still carries those under it.
 */
function walkWithout(items: readonly IAttachTreeItem[], leaveOut: ReadonlySet<string>, keep: ReadonlySet<string> = new Set()): IAttachTreeItem[] {
	const keepsSomethingUnder = (folder: string) => [...keep].some(path => path.startsWith(folder + '/'));
	return items
		.filter(item => !leaveOut.has(item.path) || keep.has(item.path) || keepsSomethingUnder(item.path))
		.map(item => {
			if (!item.children) { return item; }
			if (leaveOut.has(item.path) && !keep.has(item.path)) {
				// Left out, but carrying what's kept under it: only that.
				const kept = new Set([...keep].filter(path => path.startsWith(item.path + '/')));
				return { ...item, children: walkWithout(item.children, new Set(item.children.map(child => child.path)), kept) };
			}
			return { ...item, children: walkWithout(item.children, leaveOut, keep) };
		});
}

/** A room tree's ids by room path, folders included. */
function roomIds(items: readonly ILiveCollabTreeItem[], base = ''): Map<string, string> {
	const ids = new Map<string, string>();
	for (const item of items) {
		const path = base ? `${base}/${item.name}` : item.name;
		if (item.id) { ids.set(path, item.id); }
		for (const [childPath, id] of roomIds(item.children ?? [], path)) { ids.set(childPath, id); }
	}
	return ids;
}

interface IAttachTreeItem {
	readonly name: string;
	readonly path: string;
	readonly type: 'file' | 'directory';
	readonly children?: IAttachTreeItem[];
	readonly content?: string;
	readonly oversize?: boolean;
}

/**
 * A link or secret-looking item the attach walk kept out of the room, which
 * the owner is told about. `detail` is the full rule, for the log.
 */
interface IWithheldItem {
	readonly path: string;
	readonly reason: 'link' | 'secret';
	readonly detail: string;
}

/**
 * What one attach walk has read and kept back: bytes read so far (for the
 * folder cap), skip counts by reason (for the log summary), and the links
 * and secret-looking items.
 */
interface IAttachWalkContext {
	/** The shared folder, resolved before the walk (livecollabContainment.ts). */
	readonly root: IContainmentRoot;
	totalBytes: number;
	readonly skipped: Map<string, number>;
	readonly withheld: IWithheldItem[];
}

/** How many withheld items the owner's notice names before "and N more". */
const WITHHELD_NAMED_IN_NOTICE = 3;

/**
 * Failed attaches in a row (failed ack, or the socket closed during the
 * attach) after which the room session stops attaching: each failure
 * reconnects, and each reconnect would attach again, forever.
 */
const ATTACH_FAILURES_BEFORE_STOP = 2;

export class LiveCollabFolderContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.livecollabFolder';

	// Room isolation: the room this window's workspace last belonged to. A
	// window has ONE workspace identity for every room it enters (switching it
	// needs a reload, which the overlay refuses), so whatever VS Code keeps per
	// workspace crosses rooms unless it is cleared at the boundary.
	private static readonly WORKSPACE_ROOM_KEY = 'livecollab.workspaceRoom';

	private _virtualFolderAdded = false;
	// The room session whose attach last told the owner that links or
	// secret-looking files were kept out of the room (row 27).
	private _withheldNoticeEpoch: number | undefined;
	// Failed attaches in a row, per room session, and the session in which
	// attaching stopped (ATTACH_FAILURES_BEFORE_STOP).
	private _attachFailures: { readonly epoch: number; readonly count: number } | undefined;
	private _attachStoppedEpoch: number | undefined;
	// Changes made to the owner's folder outside the app while connected (Manny, 2026-11-12):
	// the room session whose attach has finished (none while one runs: the reconcile covers
	// that), the paths the disk watcher reported, waiting for the batch, the paths this window's
	// own working-copy operations just sent, and files created outside, waiting for their id.
	private _liveEpoch: number | undefined;
	private readonly _outsidePaths = new Set<string>();
	private _outsideBatch: { readonly timer: ReturnType<typeof setTimeout>; readonly firstAt: number } | undefined;
	private readonly _inAppPaths = new Map<string, number>();
	private readonly _outsideCreates = new Set<string>();
	// The containment rule's root (livecollabContainment.ts), captured at
	// attach, and the links that attach withheld: nothing from the room is
	// written under one of them.
	private _containment: { readonly root: IContainmentRoot; readonly withheldLinks: ReadonlySet<string> } | undefined;
	// Moves this window sent to the room, by file id, so that one the owner
	// sends straight back (a refused move, undone) is reported to its mover.
	private readonly _myRecentMoves = new Map<string, { readonly oldPath: string; readonly newPath: string; readonly at: number }>();
	// The owner's corrective moves, so their echo from the server is never
	// applied to this disk (livecollabContainment.ts, MoveCorrections).
	private readonly _corrections = new MoveCorrections();
	private readonly _disk: IContainmentDisk = {
		realpath: path => this._realpath(path),
		isLink: async path => (await this.fileService.stat(URI.file(path))).isSymbolicLink,
	};
	// Set while the join removes folders that are not the room's, so that
	// change does not run the attach (which, with no folder left, would clear
	// the room's file state).
	private _removingNonRoomFolders = false;
	/**
	 * The join's removal of folders that aren't the room's and a guest's add of the room's folder,
	 * one after the other. In a single-folder or empty window each change enters a new workspace
	 * built from the folders it saw when called, so two that overlap undo each other: the stray
	 * folder came back beside the room's (staging, 2026-11-16).
	 */
	private readonly _roomFolderEdits = new Sequencer();
	// PHASE4 echo-guard TRIPWIRE: an apply records `${kind}:${path}` here. The
	// primary defence is structural (applies never use working-copy APIs, so
	// the detector never sees them) — in normal operation every mark expires
	// unconsumed, silently. A mark being CONSUMED means an apply reached the
	// working-copy channel: that is logged loudly as a broken invariant.
	private readonly _selfAppliedOps = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly _persister: LiveCollabRoomPersister;
	/** This client's room service and virtual file system (ILiveCollabClient). */
	private readonly _service: LiveCollabService;
	private readonly _fileSystem: LiveCollabFileSystemProvider;
	/** This computer's record of which folder each of the owner's rooms shares (ATTACH_RECONCILE_DESIGN.md, "Sharing asks first"). */
	private readonly _folderClaims: ILiveCollabFolderClaims;
	// "Share … with …?" answers in this room session, by folder: one question for one attempt,
	// however many events (the folder change, a reconnect, the restore) reach the attach.
	private readonly _shareAnswers = new Map<string, Promise<boolean>>();
	private _shareAnswersEpoch: number | undefined;
	// Real folders open in this room's window that aren't shared with it, marked in the Explorer:
	// its root is labelled with the room's name, which would otherwise suggest they are.
	private readonly _notShared = new ResourceSet();
	/** Folders a leave is waiting to see closed by the deletion of the workspace file, to name them; see _tellFoldersClosedOnLeave. */
	private _closingOnLeave: ResourceSet | undefined;
	private readonly _leaveNoticesEnd = new CancellationTokenSource();
	/** The room whose session ended last with its own notice on the dashboard (removed, deleted). */
	private _lastTerminatedRoomId: string | undefined;
	/** This contribution's notifications, each tied to the room session it was shown in; see _tieToRoom. */
	private readonly _notices: {
		info(message: string): INotificationHandle;
		warn(message: string): INotificationHandle;
		error(message: string): INotificationHandle;
		prompt: INotificationService['prompt'];
	};
	private readonly _roomNotices = new Map<string, Set<INotificationHandle>>();
	private readonly _onDidChangeNotShared = this._register(new Emitter<readonly URI[]>());
	// The room session whose overlap warning was shown (once per entry).
	private _overlapToldEpoch: number | undefined;
	// Folders whose attach (and its question) is under way in this window.
	private readonly _attaching = new ResourceSet();
	// Closes this room session's open "Share … with …?" questions when the session ends, however it
	// ends: VS Code shows one dialog at a time, so one left open would hold up the next room's.
	private _shareQuestionsEnd = new CancellationTokenSource();
	private _openShareQuestions = 0;

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkingCopyFileService private readonly workingCopyFileService: IWorkingCopyFileService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IOutputService private readonly outputService: IOutputService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IDialogService private readonly dialogService: IDialogService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IDecorationsService decorationsService: IDecorationsService,
		@ILiveCollabClient client: ILiveCollabClient,
		@IRoomSharingService roomSharingService: IRoomSharingService,
	) {
		super();
		this._service = client.service;
		// Whether the window is in a room (an editor-area drop of several folders), and the room's shared
		// folder (the Explorer's Copy Folders).
		this._register(roomSharingService.setProvider({
			isInRoom: () => !!this._service.roomId,
			sharedLocationOf: resource => this._sharedLocationOf(resource),
		}));
		this._fileSystem = client.fileSystem;
		this._folderClaims = client.folderClaims;
		this._register(decorationsService.registerDecorationsProvider({
			label: localize('livecollab.notShared.provider', "LiveCollab sharing"),
			onDidChange: this._onDidChangeNotShared.event,
			provideDecorations: uri => this._notShared.has(uri)
				? { letter: Codicon.circleSlash, tooltip: localize('livecollab.notShared.tooltip', "Not shared with this room. Open on this computer only.") }
				: undefined,
		}));
		// An owner's offline changes reaching the room: one notice here (the owner doesn't hear its own).
		this._register(this._service.onRoomReconciled(summary => this._notifyOwnerReconciled(summary)));
		// The owner's id map, kept across restarts (the reconcile reads it back).
		this._register(this._fileSystem.onDidChangeServerFileIds(() => this._storeKnownIds()));
		// ROOM_SAVE_DESIGN.md piece 1: every room edit reaches the owner's disk.
		this._persister = this._register(instantiationService.createInstance(LiveCollabRoomPersister, {
			ownerRoot: () => this._ownerRealFolder()?.uri,
			diskTarget: async (root, path) => {
				const judged = await this._judgeOwnerPath(root, path, true);
				if (judged.inside) { return judged.uri; }
				lcLog.warn(`[LiveCollab] persist: not written to this disk — ${judged.reason}: ${path}`);
				return undefined;
			},
			showLogChoice: () => this._showLogChoice(),
		}));
		// The workbench is only on screen in a room; until the first room is
		// ready it stays covered (livecollabRoomCover).
		livecollabRoomCover.show();

		// Real fix (real root cause, confirmed with direct evidence): virtual
		// livecollab:// workspace folders persist into the workspace file and
		// get restored on next launch, but they are only ever valid for the
		// one specific room they were created for. The existing leave-room
		// cleanup below deliberately removes only REAL folders, never these -
		// so they accumulate forever. Confirmed live: a guest's Explorer showed
		// folders from a previous room (room-d9b733f5) while actually being in
		// a different room (room-c0eaa19d), producing "Unable to resolve
		// nonexistent file" on every entry, with all those errors firing at
		// startup before LiveCollab even initialized. Removing them here, at
		// construction, means every session starts clean rather than
		// inheriting dead references to rooms that no longer exist.
		const staleVirtualFolders = this.workspaceContextService.getWorkspace().folders
			.filter(f => f.uri.scheme === LIVECOLLAB_SCHEME);
		if (staleVirtualFolders.length > 0) {
			lcLog.info('[LiveCollab] removing', staleVirtualFolders.length, 'stale virtual room folders from a previous session');
			const firstIndex = this.workspaceContextService.getWorkspace().folders
				.findIndex(f => f.uri.scheme === LIVECOLLAB_SCHEME);
			this.workspaceEditingService.updateFolders(firstIndex, staleVirtualFolders.length);
		}

		// When socket connects — attach current folder content to active room (if any)
		this._register(this._service.onConnected(() => {
			lcLog.info('[LiveCollab] socket connected — checking folder');
			this._attachFolderToRoom();
		}));

		// When leaving a room - remove any REAL (non-livecollab://) workspace
		// folder that was attached to it. Room isolation gap found 2026-08-14:
		// opening a real folder to attach content to a room is the CORRECT,
		// intended mechanism (see _attachFolderToRoom's own comment below) -
		// but nothing previously closed that folder on leave, so it stayed
		// visibly open across different rooms (confirmed by real user testing:
		// Room 1's folder was still showing after switching to Room 2). No
		// stored reference to "the room's folder" exists anywhere in this
		// codebase - read the live workspace state at leave-time instead.
		this._register(toDisposable(() => this._shareQuestionsEnd.dispose(true)));
		this._register(toDisposable(() => this._leaveNoticesEnd.dispose(true)));
		this._notices = {
			info: message => this._tieToRoom(this.notificationService.notify({ severity: Severity.Info, message })),
			warn: message => this._tieToRoom(this.notificationService.notify({ severity: Severity.Warning, message })),
			error: message => this._tieToRoom(this.notificationService.notify({ severity: Severity.Error, message })),
			prompt: (severity, message, choices, options) => this._tieToRoom(this.notificationService.prompt(severity, message, choices, options)),
		};
		this._register(this._service.onRoomTerminated(({ roomId }) => this._lastTerminatedRoomId = roomId));
		this._register(this._service.onRoomLeft(leftRoomId => {
			this._closeShareQuestions(leftRoomId);
			this._closeRoomNotices(leftRoomId);
			// The next room's join waits for this (_restoreJoinedRoom): its folder
			// check would otherwise see this room's folder still open, as the
			// workbench applies a removal only once the workspace file is written.
			this._forgetShareAnswers();
			this._roomLeaving = this._leaveRoom(leftRoomId).catch(e => lcLog.error('[LiveCollab] room leave cleanup failed:', e));
		}));

		// Scenario 1 restore: when a room join succeeds, re-apply any saved
		// state for THIS specific room. No-op for a room with no saved state
		// (correctly matches Scenario 3 - a genuinely new/different room).
		// Stale-state handling is a correctness requirement, not polish: a
		// saved file may no longer exist (deleted, moved) - each file open
		// is attempted independently and failures are skipped silently, never
		// thrown, so one stale file cannot break restoring the rest.
		this._register(this._service.onRoomJoined(async (joinedRoomId) => {
			const readyEpoch = this._service.roomEpoch;
			try {
				await this._restoreJoinedRoom(joinedRoomId);
			} finally {
				this._joinRestoreDone(readyEpoch);
			}
		}));

		// Register livecollab:// file system provider
		this._register(this.fileService.registerProvider(LIVECOLLAB_SCHEME, this._fileSystem));

		// The role gates act on every change, not once at join: a viewer's room
		// is read-only in this window the moment the owner says so (the server
		// drops a viewer's edits too, so a writable editor would let their text
		// silently diverge from everyone else's).
		this._applyRole(this._service.myRole);
		this._register(this._service.onDidChangeMyRole(({ role }) => this._applyRole(role)));

		this._registerRoomState();

		// PHASE4: when the room snapshot arrives — populate the virtual file
		// system with real seeded content (the service has already stored the
		// per-file Y.Doc states this reads back) and open the workspace.
		// The owner's snapshot can land after the attach ack: catch up then too.
		this._register(this._service.onSnapshot(() => {
			if (this._ownerRealFolder()) { this._persister.catchUp(); }
		}));
		this._register(this._service.onSnapshot(async ({ tree, roomName, folderName }) => {
			const roomId = this._service.roomId;
			if (!roomId) { return; }
			// The host receives the snapshot too (to seed its own local docs,
			// handled in the service), but it has the REAL folder open - it
			// must never build a virtual livecollab:// mirror over it.
			if (this._service.myRole === 'owner') {
				lcLog.info('[LiveCollab] snapshot received on owner — skipping virtual filesystem (owner has the real folder)');
				return;
			}
			lcLog.info('[LiveCollab] populating virtual file system from snapshot:', tree.length, 'items, roomName:', roomName, 'folderName:', folderName);
			// Room-session invariant: populate awaits per file; if the session
			// changes mid-way it must stop writing (the provider may already
			// belong to the next room) and must not add this room's folder.
			const epoch = this._service.roomEpoch;
			const isCurrent = () => this._service.isCurrentRoomSession(epoch);
			this._fileSystem.enterRoom(roomId);
			await this._fileSystem.populateFromTree(tree, isCurrent);
			if (!isCurrent()) { lcLog.info('[LiveCollab] stale snapshot populate — was populating', roomId, ', now in', this._service.roomId ?? '(no room)', '— stopped, folder not added'); return; }
			const contents = this._fileSystem.describeContents();
			lcLog.info(`[LiveCollab] virtual file system for ${roomId}: ${contents.count} entries, top level: ${contents.topLevel.join(', ')}`);
			// Add ONE workspace folder at the virtual root, named after the
			// host's real folder. VS Code resolves the children from the
			// virtual filesystem automatically, giving the guest the exact
			// same Explorer view as the host: folderName > {all files and
			// subdirectories}. Previous approaches either (a) wrapped
			// everything in a "Shared Room" folder that didn't match the
			// host's path structure, breaking Yjs file-id matching, or
			// (b) added each top-level directory as its own workspace folder
			// while losing root-level files entirely.
			if (!this._virtualFolderAdded) {
				this._virtualFolderAdded = true;
				const displayName = folderName || roomName || 'Shared Workspace';
				lcLog.info('[LiveCollab] adding virtual workspace folder:', displayName);
				const rootUri = URI.file('/').with({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
				await this._roomFolderEdits.queue(() => this.workspaceEditingService.updateFolders(0, 0, [{ uri: rootUri, name: displayName }]));
			}
			this._roomReady(epoch, 'guest snapshot, virtual folder in place');
		}));

		// PHASE4: late joiners are served their snapshot by the SERVER (which
		// owns the docs), so the host no longer re-reads disk or re-broadcasts
		// on member join. The old onMemberJoined re-broadcast, the guest
		// file-content request handler, and the yjs seed-content request
		// handler are all deleted with the host-socket seeding path.

		// PHASE4 file lifecycle apply (section 4b, piece 3). Every write below
		// uses the RAW fileService/provider API, never IWorkingCopyFileService,
		// so applying a remote change can never fire the working-copy operation
		// event the detection layer (piece 2) listens to — the echo guard is
		// structural, not a timing window.

		// 3a — apply a remote CREATE: materialize the file (guest -> virtual FS,
		// owner -> real disk) and register its server id.
		this._register(this._service.onFileCreated(async ({ fileId, path }) => {
			// INVARIANT: no working-copy APIs (IWorkingCopyFileService, text file
			// / editor save paths) in this handler — raw fileService/provider
			// only. Breaking it re-emits this create to the room: an echo loop.
			const roomId = this._service.roomId;
			if (!roomId) { return; }
			// Room-session invariant: re-checked after every await, before any write.
			const sessionGone = this._sessionGuard('create ' + path, roomId);
			const realFolder = this._ownerRealFolder(); // R2: guests never reach real disk
			const target = realFolder ? await this._remoteDiskTarget(realFolder.uri, path, 'create', false) : undefined;
			if (realFolder && !target) { return; }
			if (sessionGone()) { return; }
			// The owner's editor finds the id through the real path, so record it
			// before the id: registering the id fires onFileIdsAvailable, and an
			// editor already open on the new file binds then or not at all.
			if (target) {
				this._fileSystem.recordRealPath(target.fsPath, path);
			}
			// Register the id FIRST so an already-open editor binds to the
			// now-seeded doc via onFileIdsAvailable.
			this._fileSystem.setServerFileId(path, fileId);
			this._markSelfApplied('create', path); // echo guard: this write is mine
			try {
				if (target) {
					const exists = await this.fileService.exists(target);
					if (sessionGone()) { return; }
					if (!exists) {
						await this.fileService.writeFile(target, VSBuffer.fromString(''));
						if (sessionGone()) { return; }
						this._persister.noteWritten(fileId, '');
					} else {
						// This disk made the file (the owner's own New File): the room
						// seeded it empty, so an empty file here is the room's version,
						// not a change made outside LiveCollab.
						const onDisk = await this.fileService.readFile(target);
						if (sessionGone()) { return; }
						if (this._outsideCreates.delete(path)) {
							this._persister.diskChanged(fileId, true); // made outside the app: its text is the room's
						} else if (onDisk.value.byteLength === 0) { this._persister.noteWritten(fileId, ''); }
					}
				} else {
					const uri = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: `/${path}` });
					const exists = await this.fileService.exists(uri);
					if (sessionGone()) { return; }
					if (!exists) {
						// A file can arrive for a folder this side never saw (folders
						// are not sent on their own): make its parents first.
						await this._fileSystem.ensureParentFolders(uri);
						if (sessionGone()) { return; }
						await this._fileSystem.writeFile(uri, VSBuffer.fromString('').buffer, { create: true, overwrite: false, unlock: false, atomic: false });
					}
				}
			} catch (e) {
				lcLog.error('[LiveCollab] apply create failed for', path, e);
			}
		}));

		// 3b — apply a remote RENAME/MOVE: the fileId and its Y.Doc are
		// unchanged; only the path moves. Re-key the id maps on both sides, move
		// the file on the applier's FS via raw APIs, and re-point any open
		// editor to the new URI so it stays on the same document.
		// The room refused a create, move or delete this window sent: say so here,
		// on the screen of the member who made it (the standing rule in STATUS).
		this._register(this._service.onFileOperationRefused(({ operation, path, newPath, error }) => {
			const reason = error === 'read_only' ? localize('livecollab.fileOpRefused.readOnly', "you can only read files in this room")
				: error === 'bad_path' ? localize('livecollab.fileOpRefused.badPath', "that name or place isn't allowed in a shared folder")
					: error === 'withheld_path' ? localize('livecollab.fileOpRefused.withheld', "that place is outside the folder the owner shared (it goes through a link)")
						: localize('livecollab.fileOpRefused.other', "the room didn't accept it ({0})", error);
			const message = operation === 'create' ? localize('livecollab.fileOpRefused.create', "'{0}' wasn't added to the room: {1}.", path, reason)
				: operation === 'rename' ? localize('livecollab.fileOpRefused.rename', "'{0}' wasn't moved to '{1}' in the room: {2}.", path, newPath ?? '', reason)
					: localize('livecollab.fileOpRefused.delete', "'{0}' wasn't deleted from the room: {1}.", path, reason);
			this._notices.warn(message);
		}));

		// Changes this window made that the room can't take (no document for
		// the file, not saved, or this member no longer allowed to edit, after a
		// retry; or a document rebuilt with no history in common):
		// they are only here. Said, so they aren't lost unseen.
		this._register(this._service.onSyncFailed(({ path, reason }) => {
			const name = path ?? localize('livecollab.syncFailed.aFile', "a file");
			this._notices.error(reason === 'rebuilt'
				? localize('livecollab.syncFailed.rebuilt', "Your copy of '{0}' no longer matches the room's: the room's copy was rebuilt from the owner's files while you were away. What you see may differ from what others see, and your recent changes are only on this computer; copy them somewhere, then leave the room and join it again.", name)
				: reason === 'read_only'
					? localize('livecollab.syncFailed.readOnly', "You no longer have edit permission in this room, so your changes to '{0}' weren't added to it. They are still in your window, and nowhere else: copy them somewhere before you close the file.", name)
					: reason === 'not_saved'
						? localize('livecollab.syncFailed.notSaved', "Your changes to '{0}' haven't reached the room: it couldn't save them. They are only on this computer; copy them somewhere before you close the file.", name)
						: localize('livecollab.syncFailed.noDoc', "Your changes to '{0}' haven't reached the room: it has no copy of the file to add them to. They are only on this computer; copy them somewhere before you close the file.", name));
		}));

		this._register(this._service.onFileRenamed(async ({ fileId, oldPath, newPath, type, correction }) => {
			// INVARIANT: no working-copy APIs (IWorkingCopyFileService, text file
			// / editor save paths) in this handler — raw fileService/provider
			// only. Breaking it re-emits this rename to the room: an echo loop.
			const roomId = this._service.roomId;
			if (!roomId) { return; }
			// Room-session invariant: re-checked after every await, before any write.
			const sessionGone = this._sessionGuard('rename ' + oldPath + ' -> ' + newPath, roomId);
			this._reportIfMyMoveUndone(fileId, oldPath, newPath, correction);
			const realFolder = this._ownerRealFolder(); // R2: guests never reach real disk
			const isDir = type === 'directory';
			this._fileSystem.renameServerFileId(oldPath, newPath, isDir);
			// This owner's own correction, heard back from the server: the disk
			// already has the file where the correction puts it, and the source
			// was never there. The ids above follow it; nothing else to do.
			if (realFolder && this._corrections.isOwnEcho(fileId, oldPath, newPath)) {
				lcLog.info(`[LiveCollab] correction echoed back by the room: ${oldPath} -> ${newPath} — already so on this disk`);
				return;
			}
			this._markSelfApplied('move', newPath); // echo guard: this move is mine
			try {
				if (realFolder) {
					await this._moveOnOwnerDisk(realFolder.uri, fileId, oldPath, newPath, isDir, correction, sessionGone);
				} else {
					const oldUri = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: `/${oldPath}` });
					const newUri = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: `/${newPath}` });
					const shouldMove = await this.fileService.exists(oldUri) && !(await this.fileService.exists(newUri));
					if (sessionGone()) { return; }
					if (shouldMove) {
						await this._fileSystem.ensureParentFolders(newUri);
						await this._fileSystem.rename(oldUri, newUri, { overwrite: false });
						if (sessionGone()) { return; }
					}
					await this._repointEditors(oldUri, newUri);
				}
			} catch (e) {
				lcLog.error('[LiveCollab] apply rename failed for', oldPath, '->', newPath, e);
			}
		}));

		// 3c — apply a remote DELETE: close any editor open on the deleted path
		// (or under it) WITHOUT saving, drop the local Y.Doc(s) so nothing can
		// rebind to a stale document, and remove the file from the applier's FS
		// via raw APIs. The server sends node + every descendant, so a directory
		// delete arrives as its full set of {fileId, path}.
		this._register(this._service.onFileDeleted(async ({ files }) => {
			// INVARIANT: no working-copy APIs (IWorkingCopyFileService, text file
			// / editor save paths) in this handler — raw fileService/provider
			// only. Breaking it re-emits this delete to the room: an echo loop.
			// (editorService revert/close below is editor state, not a file op.)
			const roomId = this._service.roomId;
			if (!roomId) { return; }
			// Room-session invariant: re-checked after every await, before any
			// write. On the owner this deletes from REAL disk — a stale event
			// from a room already left must never get that far.
			const sessionGone = this._sessionGuard('delete ' + files.length + ' path(s)', roomId);
			const realFolder = this._ownerRealFolder(); // R2: guests never reach real disk
			let closedAny = false;
			for (const { fileId, path } of files) {
				if (sessionGone()) { return; }
				closedAny = await this._applyRoomDelete(realFolder?.uri, roomId, fileId, path, sessionGone) || closedAny;
			}
			if (closedAny) {
				this._notices.info(localize('livecollab.fileDeleted', "A file open in your editor was deleted in this room."));
			}
		}));

		// PHASE4 file lifecycle DETECTION (section 4b, piece 2). User file ops
		// from the Explorer run through IWorkingCopyFileService; our own applied
		// remote ops use the RAW fileService/provider API and never route through
		// it — so this event fires for user actions but NOT for our applies. That
		// is the structural echo guard. The self-applied marks are only a
		// tripwire behind it: if one is ever consumed here, _consumeSelfApplied
		// logs that the invariant is broken (and still suppresses that one op).
		// Changes made to the owner's folder outside the app (a shell, Finder, git, another editor).
		this._register(this.fileService.onDidFilesChange(e => this._onDiskChanged(e)));
		this._register(toDisposable(() => { if (this._outsideBatch) { clearTimeout(this._outsideBatch.timer); } }));

		this._register(this.workingCopyFileService.onDidRunWorkingCopyFileOperation(async (e) => {
			if (!this._service.roomId) { return; }
			for (const { source, target } of e.files) {
				this._noteInApp(source, target);
				if (e.operation === FileOperation.CREATE) {
					await this._detectCreate(target);
				} else if (e.operation === FileOperation.DELETE) {
					this._detectDelete(target);
				} else if (e.operation === FileOperation.MOVE && source) {
					this._detectRename(source, target);
				}
				// COPY/WRITE: WRITE is content (flows over Yjs); COPY is not yet
				// supported (the target would sync as empty) — skipped for Phase 1.
			}
		}));

		// When folder changes while already connected — register new folder
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(e => {
			// A folder removed and added again is a new attempt: it's asked about again.
			this._forgetShareAnswers(e.removed.map(folder => folder.uri));
			if (this._removingNonRoomFolders) { return; }
			if (this._service.isConnected) {
				this._attachFolderToRoom();
			}
		}));

		// LiveCollab overlay: main hands a folder opened into this window (Open
		// Folder, Open Recent, the Welcome page, Finder/Dock) to the workbench
		// instead of reloading it — see windowsMainService. Adding it here, in
		// place, fires onDidChangeWorkspaceFolders above, which attaches it to
		// the room. Exact channel name.
		const ipc = (mainWindow as unknown as { vscode?: { ipcRenderer?: IOverlayIpcRenderer } }).vscode?.ipcRenderer;
		if (ipc) {
			const onOpenFolder = (_event: unknown, ...args: unknown[]) => {
				const payload = args[0] as { folderUri?: UriComponents } | undefined;
				if (payload?.folderUri) {
					this._openFolderFromMain(URI.revive(payload.folderUri));
				}
			};
			ipc.on('vscode:livecollab-open-folder', onOpenFolder);
			this._register(toDisposable(() => ipc.removeListener('vscode:livecollab-open-folder', onOpenFolder)));
		}

		// lc/1: startup is owned by LiveCollabStartupOwner — this contribution only listens

		// Clear any pending echo-guard timers on dispose so none dangle.
		this._register({ dispose: () => { for (const t of this._selfAppliedOps.values()) { clearTimeout(t); } this._selfAppliedOps.clear(); } });
	}


	// Translate a URI into the room-relative itemPath, or undefined if it is not
	// a tracked room resource. A guest's `livecollab://` file uses its path; a
	// real `file://` file is a room resource ONLY on the owner and ONLY under
	// the attached folder (R2 — a guest's own local folder is never a room
	// resource). Uses URI.path ('/'-separated) so it matches the itemPaths the
	// attach walk and the server assign ids under.
	private _toRoomRelativePath(uri: URI): string | undefined {
		if (uri.scheme === LIVECOLLAB_SCHEME) {
			return uri.path.replace(/^\/+/, '') || undefined;
		}
		const realFolder = this._ownerRealFolder();
		if (!realFolder) { return undefined; }
		const root = realFolder.uri.path;
		const prefix = root.endsWith('/') ? root : root + '/';
		if (!uri.path.startsWith(prefix)) { return undefined; } // the root itself, or outside it
		return uri.path.slice(prefix.length) || undefined;
	}

	// Room-session guard for an apply handler: captures the session now and
	// returns a check that is true (and logs, naming both rooms) once the
	// session the handler started in is gone. See the room-session invariant
	// in LIVECOLLAB_BEHAVIORAL_SPEC.md.
	private _sessionGuard(what: string, roomId: string): () => boolean {
		const epoch = this._service.roomEpoch;
		return () => {
			if (this._service.isCurrentRoomSession(epoch)) { return false; }
			lcLog.info('[LiveCollab] stale apply', what, '— started in', roomId, ', now in', this._service.roomId ?? '(no room)', '— stopped');
			return true;
		};
	}

	// Echo-guard tripwire. An apply calls _markSelfApplied before its raw FS
	// write. Expiry is the NORMAL case (raw applies never fire the detector) and
	// is silent; the TTL just stops a stale mark swallowing a later genuine op.
	/**
	 * Applies one delete from the room: editors on it closed without saving, its doc and id
	 * dropped, and the file removed. On the owner's real disk it goes to the Trash, never unlinked:
	 * a delete made by someone else must be recoverable. Used for a delete heard from the room, and
	 * for what the room removed while this owner was away (the reconcile, after the re-attach).
	 * @param root the owner's folder, or undefined on a guest
	 * @returns whether an open editor was closed
	 */
	private async _applyRoomDelete(root: URI | undefined, roomId: string, fileId: string | undefined, path: string, sessionGone: () => boolean): Promise<boolean> {
		const uri = root
			? await this._remoteDiskTarget(root, path, 'delete', true)
			: URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: `/${path}` });
		if (!uri || sessionGone()) { return false; }
		// Close editors FIRST: closing disposes the editor contribution,
		// which destroys the MonacoBinding. Only THEN drop the doc — pulling
		// it out from under a live binding is undefined behaviour.
		const stale = this._openEditorsUnder(uri);
		await this._closeWithoutSaving(stale);
		if (sessionGone()) { return stale.length > 0; }
		if (fileId) { this._service.dropYjsDoc(fileId); }
		this._fileSystem.removeServerFileId(path);
		this._markSelfApplied('delete', path); // echo guard: this delete is mine
		try {
			const exists = await this.fileService.exists(uri);
			if (sessionGone()) { return stale.length > 0; }
			if (root) {
				this._fileSystem.removeRealPath(uri.fsPath);
				// useTrash: true — a remote-triggered delete of a file on the
				// owner's REAL disk must be recoverable (macOS Trash), never a
				// permanent, unrecoverable removal.
				if (exists) { await this.fileService.del(uri, { recursive: true, useTrash: true }); }
			} else if (exists) {
				// In-memory provider — nothing to trash.
				await this._fileSystem.delete(uri, { recursive: true, useTrash: false, atomic: false });
			}
		} catch (e) {
			lcLog.error('[LiveCollab] apply delete failed for', path, e);
		}
		return stale.length > 0;
	}

	/**
	 * Makes a room move on the owner's disk, through the containment rule: judged on the
	 * destination, refused (and corrected back) when it leads outside the folder or into a path
	 * kept out of the room. Used for a move heard from the room, and for the moves the room made
	 * while this owner was away (the reconcile, before the re-attach).
	 */
	private async _moveOnOwnerDisk(root: URI, fileId: string, oldPath: string, newPath: string, isDir: boolean, correction: boolean, sessionGone: () => boolean): Promise<void> {
		// Judged on the destination (livecollabContainment.ts, planOwnerMove).
		const source = await this._judgeOwnerPath(root, oldPath, true);
		// The destination is held to the share rules too: a move from the
		// room to .env or into node_modules is refused like one outside.
		const destination = await this._judgeOwnerPath(root, newPath, true);
		if (sessionGone()) { return; }
		const plan = planOwnerMove(source, destination);
		if (plan === 'refuse') {
			lcLog.warn(`[LiveCollab] remote move NOT applied to this disk — destination ${destination.reason}: ${oldPath} -> ${newPath}`);
			if (correction) {
				// Never answered with a correction: that is what makes a loop impossible.
				lcLog.error(`🔴 [LiveCollab] a correction from the room was refused here and is not corrected back: ${oldPath} -> ${newPath}`);
				this._notices.prompt(Severity.Warning, localize('livecollab.remoteNotApplied', "A change from the room to '{0}' wasn't made on this computer: that path is outside the shared folder, a link, or kept out of the room.", newPath), [this._showLogChoice()]);
				return;
			}
			this._undoRefusedMove(fileId, oldPath, newPath, source.inside && source.exists);
			return;
		}
		const newUri = destination.uri!;
		if (plan === 'write') {
			lcLog.info(`[LiveCollab] remote move: the source was never on this disk inside the folder (${source.reason ?? 'not there'}) — writing the room's copy at ${newPath}, source left alone`);
			await this._writeRoomCopy(root, newPath, fileId, isDir, sessionGone);
			return;
		}
		const oldUri = source.uri;
		if (!oldUri) {
			// 'nothing' with a source that never was on this disk: the
			// destination is already there and nothing points at the source.
			lcLog.info(`[LiveCollab] remote move: ${newPath} already on this disk, ${oldPath} never was (${source.reason ?? 'not there'}) — nothing to do`);
			return;
		}
		this._fileSystem.rePathRealPaths(oldUri.fsPath, newUri.fsPath, oldPath, newPath);
		if (plan === 'move') {
			// Applier still has the source; the originator already moved it.
			await this.fileService.move(oldUri, newUri, false);
			if (sessionGone()) { return; }
		}
		await this._repointEditors(oldUri, newUri);
	}

	private _markSelfApplied(kind: string, path: string): void {
		const key = kind + ':' + path;
		const existing = this._selfAppliedOps.get(key);
		if (existing) { clearTimeout(existing); }
		this._selfAppliedOps.set(key, setTimeout(() => this._selfAppliedOps.delete(key), 5000));
	}
	// Returns true (suppress) when the detector sees an op we applied. That
	// should NEVER happen — reaching here means the invariant is broken.
	private _consumeSelfApplied(kind: string, path: string): boolean {
		const key = kind + ':' + path;
		const timer = this._selfAppliedOps.get(key);
		if (timer === undefined) { return false; }
		clearTimeout(timer);
		this._selfAppliedOps.delete(key);
		lcLog.error(`🔴 [LiveCollab ECHO GUARD] remote ${kind} of '${path}' was applied through a working-copy API — the no-working-copy-APIs-in-apply-paths invariant is BROKEN and echo loops are now possible. This op was suppressed; fix the apply handler.`);
		return true;
	}

	// Which exclusion rule (if any) drops a path from the room, for logging.
	private _exclusionRule(path: string): string | undefined {
		const segments = path.split('/');
		for (let i = 0; i < segments.length - 1; i++) {
			const seg = segments[i];
			if (EXCLUDED_DIRS.has(seg) || isEnvFolderName(seg)) { return `excluded dir '${seg}'`; }
			const secretFolder = secretFolderRule(segments.slice(0, i + 1).join('/'));
			if (secretFolder) { return secretFolder; }
		}
		const name = segments[segments.length - 1];
		if (EXCLUDED_DIRS.has(name)) { return `excluded dir '${name}'`; }
		const secret = secretFolderRule(path) ?? secretFileRule(path);
		if (secret) { return secret; }
		if (this._isBinaryExt(name)) { return `binary type '${name.slice(name.lastIndexOf('.'))}'`; }
		return undefined;
	}

	// The real path of `path` on this disk (IContainmentDisk.realpath):
	// undefined only when nothing is there, not even a broken link (lstat);
	// any other failure throws, and the caller treats it as outside.
	private async _realpath(path: string): Promise<string | undefined> {
		const uri = URI.file(path);
		try {
			const real = await this.fileService.realpath(uri);
			if (!real) { throw new Error('this file system cannot resolve links'); }
			return real.fsPath;
		} catch (e) {
			try {
				await this.fileService.stat(uri); // something is there (a broken link): unresolvable
			} catch (statError) {
				if (statError instanceof Error && toFileOperationResult(statError) === FileOperationResult.FILE_NOT_FOUND) { return undefined; }
			}
			throw e;
		}
	}

	// The containment root for the attached folder: as captured at attach, or,
	// for a change that arrives before this session's attach has run, resolved
	// now (with no withheld links yet; every write is still resolved).
	private async _containmentFor(rootUri: URI): Promise<{ readonly root: IContainmentRoot; readonly withheldLinks: ReadonlySet<string> } | undefined> {
		if (this._containment?.root.path === rootUri.fsPath) { return this._containment; }
		try {
			const realPath = await this._realpath(rootUri.fsPath);
			if (!realPath) { return undefined; }
			this._containment = { root: { path: rootUri.fsPath, realPath }, withheldLinks: new Set() };
			return this._containment;
		} catch (e) {
			lcLog.warn('[LiveCollab] could not resolve the shared folder', rootUri.fsPath, toErrorMessage(e));
			return undefined;
		}
	}

	// Row 28, under the containment rule: where a room path lands on the
	// owner's real disk, and whether that is inside the shared folder. A
	// guest's path is joined onto the folder, so it must be plain (a '..'
	// segment would leave the folder); it must not be under a link the attach
	// withheld; and, every link along it resolved, it must land inside the
	// resolved folder. `keptOut` also refuses paths the share rules keep out
	// of the room (a delete, a move's source), so the room never touches
	// something it was never given (.npmrc, node_modules).
	private async _judgeOwnerPath(root: URI, path: string, keptOut: boolean): Promise<{ readonly uri?: URI; readonly inside: boolean; readonly exists: boolean; readonly reason?: string }> {
		const problem = roomPathProblem(path) ?? (keptOut ? this._exclusionRule(path) : undefined);
		if (problem) { return { inside: false, exists: false, reason: problem }; }
		const containment = await this._containmentFor(root);
		if (!containment) { return { inside: false, exists: false, reason: 'could not resolve the shared folder' }; }
		if (isUnderWithheld(path, containment.withheldLinks)) { return { inside: false, exists: false, reason: 'under a link the room never sees' }; }
		const judged = await judgeDiskPath(this._disk, containment.root, path);
		if (!judged.inside) { return { inside: false, exists: judged.exists, reason: judged.detail ?? 'outside the shared folder' }; }
		return { uri: URI.joinPath(root, ...path.split('/')), inside: true, exists: judged.exists };
	}

	// Where a create or delete from the room may land on the owner's real
	// disk, or undefined if it must not be applied there (_judgeOwnerPath).
	// The room's tree keeps the change; this disk does not.
	private async _remoteDiskTarget(root: URI, path: string, what: string, keptOut: boolean): Promise<URI | undefined> {
		const judged = await this._judgeOwnerPath(root, path, keptOut);
		if (judged.inside) { return judged.uri; }
		lcLog.warn(`[LiveCollab] remote ${what} NOT applied to this disk — ${judged.reason}: ${path}`);
		this._notices.prompt(Severity.Warning, localize('livecollab.remoteNotApplied', "A change from the room to '{0}' wasn't made on this computer: that path is outside the shared folder, a link, or kept out of the room.", path), [this._showLogChoice()]);
		return undefined;
	}

	// Stopgap until the server refuses such moves itself (STATUS): a move whose
	// destination is outside the shared folder is sent straight back, so the
	// room's tree matches this disk again, and its mover's own window reports
	// it (_reportIfMyMoveUndone). Only when the file can go back to a source
	// on this disk. Every refused move is undone, however soon after the last;
	// the owner's own undo coming back is recognised (MoveCorrections).
	private _undoRefusedMove(fileId: string, oldPath: string, newPath: string, canGoBack: boolean): void {
		if (canGoBack) {
			this._corrections.sent(fileId, newPath, oldPath);
			this._service.emitFileRename(fileId, newPath, oldPath, true);
			lcLog.warn(`[LiveCollab] move undone in the room: ${newPath} -> ${oldPath}`);
			this._notices.prompt(Severity.Warning, localize('livecollab.moveUndone.owner', "A move of '{0}' to '{1}' was undone: that place is outside the shared folder on this computer, or a name the room never shares. The member who moved it has been told.", oldPath, newPath), [this._showLogChoice()]);
			return;
		}
		this._notices.prompt(Severity.Warning, localize('livecollab.remoteNotApplied', "A change from the room to '{0}' wasn't made on this computer: that path is outside the shared folder, a link, or kept out of the room.", newPath), [this._showLogChoice()]);
	}

	// The mover's side of _undoRefusedMove: a move this window made, sent
	// straight back by the owner, is said on this screen (the standing rule:
	// no refusal is invisible to the member who caused it).
	// Matched by condition, never by time: the rename exactly reverses this
	// window's last move of the file. A server that relays the correction flag
	// (2026-10-29 batch on) says outright that it is one; an older one drops it.
	private _reportIfMyMoveUndone(fileId: string, oldPath: string, newPath: string, correction: boolean): void {
		const mine = this._myRecentMoves.get(fileId);
		if (!mine || mine.newPath !== oldPath || mine.oldPath !== newPath) { return; }
		this._myRecentMoves.delete(fileId);
		lcLog.warn(`[LiveCollab] my move of ${newPath} to ${oldPath} was undone by the owner${correction ? '' : ' (no correction flag: an older server, matched by path)'}`);
		this._notices.warn(localize('livecollab.moveUndone', "Your move of '{0}' to '{1}' was undone. That place is outside the folder the owner shared, or a name the room never shares (such as .env), so the owner's computer can't keep the file there. It is back at '{0}'.", newPath, oldPath));
	}

	// A move whose source never was on this disk inside the folder: the room's
	// copy of every file it moved is written at its new path (never over a
	// file already there), each judged again on its own.
	private async _writeRoomCopy(root: URI, newPath: string, fileId: string, isDir: boolean, sessionGone: () => boolean): Promise<void> {
		const files = isDir ? this._fileSystem.serverFilesUnder(newPath) : [[newPath, fileId] as const];
		for (const [path, id] of files) {
			const target = await this._remoteDiskTarget(root, path, 'move (write)', false);
			if (sessionGone()) { return; }
			if (!target || await this.fileService.exists(target)) { continue; }
			const text = await this._service.getRoomText(id);
			if (sessionGone()) { return; }
			this._fileSystem.recordRealPath(target.fsPath, path);
			this._markSelfApplied('create', path); // echo guard: this write is mine
			await this.fileService.writeFile(target, VSBuffer.fromString(text));
			this._persister.noteWritten(id, text);
		}
	}

	private async _detectCreate(target: URI): Promise<void> {
		const path = this._toRoomRelativePath(target);
		if (!path) { return; }
		if (this._consumeSelfApplied('create', path)) { return; } // I just applied this create
		const rule = this._exclusionRule(path);
		if (rule) {
			lcLog.warn('[LiveCollab] file NOT shared to room —', rule + ':', path);
			if (rule.startsWith('secret ')) {
				this._notices.info(localize('livecollab.createNotShared.secret', "'{0}' wasn't shared with this room: it looks like a secret.", basename(target)));
			}
			return;
		}
		let isDirectory = false;
		try {
			isDirectory = (await this.fileService.stat(target)).isDirectory;
		} catch { /* target may already be gone */ }
		if (target.scheme === Schemas.file) {
			const root = this._ownerRealFolder()?.uri;
			const judged = root ? await this._judgeOwnerPath(root, path, false) : { inside: false, reason: 'no shared folder open' };
			if (!judged.inside) {
				lcLog.warn(`[LiveCollab] file NOT shared to room — ${judged.reason}:`, path);
				this._notices.prompt(Severity.Info, localize('livecollab.createNotShared.outside', "'{0}' wasn't shared with this room: it is outside the shared folder (through a link), or LiveCollab couldn't check where it is. The reason is in the log.", basename(target)), [this._showLogChoice()]);
				return;
			}
		}
		if (isDirectory) { return; } // empty folders aren't tracked; appear when a file is created inside
		this._service.emitFileCreate(path);
	}

	private _detectDelete(target: URI): void {
		const path = this._toRoomRelativePath(target);
		if (!path) { return; }
		if (this._consumeSelfApplied('delete', path)) { return; } // I just applied this delete
		const fileId = this._fileSystem.getServerFileId(path);
		if (!fileId) { return; } // not a tracked room file — nothing to delete server-side
		this._service.emitFileDelete(fileId, path);
	}

	// A rename made here, re-judged against the share rules on both ends
	// (livecollabContainment.ts, planLocalRename).
	private _detectRename(source: URI, target: URI): void {
		const oldPath = this._toRoomRelativePath(source);
		const newPath = this._toRoomRelativePath(target);
		if (!oldPath || !newPath) { return; }
		if (this._consumeSelfApplied('move', newPath)) { return; } // I just applied this move
		const fileId = this._fileSystem.getServerFileId(oldPath);
		const destinationRule = this._exclusionRule(newPath);
		const plan = planLocalRename({ tracked: !!fileId, destinationRule, onOwnerDisk: target.scheme === Schemas.file });
		switch (plan) {
			case 'rename':
				this._myRecentMoves.set(fileId!, { oldPath, newPath, at: Date.now() });
				// The id follows the name here and now, not when the room echoes the rename back:
				// the workbench has already moved this side's open editor to the new name, and its
				// binding needs the id before anything is typed there. Waiting for the echo left
				// the renamer unbound (session finding 1); binding on the echo would replace what
				// they typed meanwhile with the room's older text. The echo's own re-key then finds
				// nothing to move. Disk paths first, since the re-key fires the binding retry. The
				// folder form of the re-key also moves the exact path, so it serves a file too.
				if (target.scheme === Schemas.file) {
					this._fileSystem.rePathRealPaths(source.fsPath, target.fsPath, oldPath, newPath);
				}
				this._fileSystem.renameServerFileId(oldPath, newPath, true);
				this._service.emitFileRename(fileId!, oldPath, newPath);
				return;
			case 'leaveRoom':
				// The room drops it (the delete's echo finds nothing at oldPath on
				// this disk); the renamed file stays here and is never bound again.
				lcLog.warn(`[LiveCollab] renamed out of the room — ${destinationRule}: ${oldPath} -> ${newPath}`);
				this._service.emitFileDelete(fileId!, oldPath);
				this._notices.warn(localize('livecollab.renameLeftRoom', "'{0}' is no longer shared with this room: its new name, '{1}', is one the room never shares ({2}). The others no longer see '{0}'. It is still on this computer.", oldPath, newPath, destinationRule));
				return;
			case 'refuse':
				lcLog.warn(`[LiveCollab] rename NOT sent to the room — ${destinationRule}: ${oldPath} -> ${newPath}; put back`);
				void this._undoLocalRename(source, target);
				this._notices.warn(localize('livecollab.renameRefused', "'{0}' can't be renamed to '{1}' in this room: the room never shares files with that name ({2}). It keeps its old name.", oldPath, newPath, destinationRule));
				return;
			case 'enterRoom':
				lcLog.info(`[LiveCollab] renamed into the room: ${oldPath} -> ${newPath}`);
				void this._detectCreateUnder(target);
				return;
			case 'ignore':
				return;
		}
	}

	/** Paths a working-copy operation here just sent: the watcher's report of them is this window's own. */
	private _noteInApp(...resources: (URI | undefined)[]): void {
		const now = Date.now();
		for (const resource of resources) {
			const path = resource && this._toRoomRelativePath(resource);
			if (path) { this._inAppPaths.set(path, now); }
		}
	}

	/**
	 * The disk watcher: changes under the owner's shared folder, collected for a batch. The
	 * workbench already watches its workspace folders recursively (the Explorer follows them), so
	 * this listens to that rather than adding a watcher of its own; a correlated watcher here
	 * would be non-recursive. Paths the room never shares are left out.
	 */
	private _onDiskChanged(e: FileChangesEvent): void {
		const root = this._ownerRealFolder()?.uri;
		if (!root || this._liveEpoch === undefined || this._liveEpoch !== this._service.roomEpoch || !this._service.isConnected) { return; }
		let any = false;
		for (const resource of [...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted]) {
			if (resource.scheme !== Schemas.file || !isEqualOrParent(resource, root)) { continue; }
			const path = this._toRoomRelativePath(resource);
			if (!path || this._exclusionRule(path)) { continue; }
			this._outsidePaths.add(path);
			any = true;
		}
		if (!any) { return; }
		const now = Date.now();
		const firstAt = this._outsideBatch?.firstAt ?? now;
		if (this._outsideBatch) { clearTimeout(this._outsideBatch.timer); }
		const delay = Math.max(0, Math.min(OUTSIDE_QUIET_MS, firstAt + OUTSIDE_MAX_WAIT_MS - now));
		this._outsideBatch = { firstAt, timer: setTimeout(() => { this._outsideBatch = undefined; void this._takeOutsideChanges(); }, delay) };
	}

	/**
	 * A batch of changes made to the owner's folder outside the app, while connected, reaches the
	 * room (Manny, 2026-11-12; ATTACH_RECONCILE_DESIGN.md, "Outside the app, live"). It's judged
	 * as the reconnect judges the owner's offline changes, on the state now rather than on the
	 * events: a missing file whose text matches exactly one new one is a rename (its id kept),
	 * other missing files are deletes, asked about first when many, new files are creates with
	 * their text, and a changed file's text goes to the room by the persister's rule. What the
	 * room itself just wrote here matches the room, so it's never sent back.
	 */
	private async _takeOutsideChanges(): Promise<void> {
		const paths = [...this._outsidePaths];
		this._outsidePaths.clear();
		const root = this._ownerRealFolder()?.uri;
		const roomId = this._service.roomId;
		const epoch = this._service.roomEpoch;
		if (!root || !roomId || this._liveEpoch !== epoch || !this._service.isConnected) { return; }
		const now = Date.now();
		for (const [path, at] of this._inAppPaths) {
			if (now - at > IN_APP_MS) { this._inAppPaths.delete(path); }
		}
		const room = new Map(this._fileSystem.allServerIds());
		const missing: { id: string; path: string }[] = [];
		const created = new Map<string, string>(); // path -> its text's hash
		const createdText = new Map<string, URI>();
		const changed = new Set<string>();
		const exists = async (path: string) => {
			try {
				return (await this.fileService.stat(URI.joinPath(root, path))).isFile;
			} catch {
				return undefined;
			}
		};
		const addNew = async (path: string, depth: number): Promise<void> => {
			if (room.has(path) || this._inAppPaths.has(path) || this._exclusionRule(path) || created.has(path)) { return; }
			const uri = URI.joinPath(root, path);
			let stat;
			try {
				stat = await this.fileService.resolve(uri);
			} catch {
				return;
			}
			if (stat.isSymbolicLink) { return; }
			if (stat.isDirectory) {
				if (depth > 4) { return; }
				for (const child of stat.children ?? []) {
					await addNew(path + '/' + child.name, depth + 1);
				}
				return;
			}
			try {
				created.set(path, hashText((await this.fileService.readFile(uri)).value.toString()));
				createdText.set(path, uri);
			} catch { /* gone again */ }
		};
		for (const path of paths) {
			if (this._inAppPaths.has(path)) { continue; }
			// A folder removed or moved is reported once, for itself: everything the room has under it counts.
			for (const [roomPath, id] of room) {
				if (roomPath !== path && !roomPath.startsWith(path + '/')) { continue; }
				if (missing.some(m => m.path === roomPath) || changed.has(id)) { continue; }
				const isFile = await exists(roomPath);
				if (isFile === undefined) {
					missing.push({ id, path: roomPath });
				} else if (isFile) {
					changed.add(id);
				}
			}
			await addNew(path, 0);
		}
		if (!this._service.isCurrentRoomSession(epoch) || this._liveEpoch !== epoch) { return; }
		const disk = new Set([...room.keys()].filter(path => !missing.some(m => m.path === path)).concat([...created.keys()]));
		const roomHashes = new Map<string, string>();
		for (const { id } of missing) {
			if (this._service.knowsRoomText(id)) { roomHashes.set(id, hashText(await this._service.getRoomText(id))); }
		}
		const reconcile: IReconcile = { leaveOut: new Set(), movedInRoom: [], removedInRoom: [], newOutside: [...created.keys()], missingOnDisk: missing, twoSided: [] };
		const plan = planOwnerOfflineChanges(reconcile, room, disk, this._persister.recordedHashes(), roomHashes, created);
		if (!this._service.isCurrentRoomSession(epoch)) { return; }
		let renamed = 0;
		for (const rename of plan.renames) {
			// The id follows the name here first, as for a rename in the Explorer (_detectRename).
			this._fileSystem.rePathRealPaths(URI.joinPath(root, rename.from).fsPath, URI.joinPath(root, rename.to).fsPath, rename.from, rename.to);
			this._fileSystem.renameServerFileId(rename.from, rename.to, true);
			if (await this._service.emitFileRename(rename.id, rename.from, rename.to)) { renamed++; }
			if (!this._service.isCurrentRoomSession(epoch)) { return; }
		}
		const renamedTo = new Set(plan.renames.map(rename => rename.to));
		const newFiles = [...createdText].filter(([path]) => !renamedTo.has(path));
		for (const [path, uri] of newFiles) {
			this._outsideCreates.add(path);
			await this._detectCreate(uri);
		}
		for (const id of changed) {
			this._persister.diskChanged(id, false);
		}
		let deleted = 0;
		if (plan.deletes.length) {
			const removed = filesRemovedBy(plan.deletes, room);
			const roomFiles = [...room.keys()].filter(path => ![...room.keys()].some(other => other.startsWith(path + '/'))).length;
			if (isLargeRemoval(removed.size, roomFiles)) {
				this._askBeforeLargeRemoval(plan.deletes, [...removed.values()].sort(), new Set(removed.keys()), epoch);
			} else {
				deleted = (await this._sendOfflineDeletes(plan.deletes, epoch)).length;
			}
		}
		this._notifyNotApplied(plan.held, [], true);
		if (renamed || deleted || newFiles.length || plan.deletes.length > deleted) {
			lcLog.info(`[LiveCollab] outside the app: ${newFiles.length} created, ${renamed} renamed, ${deleted} deleted${plan.deletes.length > deleted ? `, ${plan.deletes.length - deleted} deletes asked about or refused` : ''}, ${plan.held.length} held`);
		}
	}

	// Puts a guest's refused rename back in its virtual file system, raw (no
	// working-copy event, so nothing is sent), with any open editor following.
	private async _undoLocalRename(source: URI, target: URI): Promise<void> {
		try {
			await this._fileSystem.rename(target, source, { overwrite: false });
			await this._repointEditors(target, source);
		} catch (e) {
			lcLog.error('[LiveCollab] could not put back the refused rename', target.toString(), '->', source.toString(), e);
		}
	}

	// A file, or every file in a folder, that the room didn't have and now
	// may: each judged as a new file (_detectCreate), depth-capped like the
	// attach walk.
	private async _detectCreateUnder(target: URI, depth = 0): Promise<void> {
		let stat;
		try {
			stat = await this.fileService.resolve(target);
		} catch {
			return;
		}
		if (!stat.isDirectory) {
			await this._detectCreate(target);
			return;
		}
		if (depth > 4 || stat.isSymbolicLink) { return; }
		for (const child of stat.children ?? []) {
			if (this._exclusionRule(this._toRoomRelativePath(child.resource) ?? '')) { continue; }
			await this._detectCreateUnder(child.resource, depth + 1);
		}
	}

	/**
	 * The room-session state this contribution owns (IRoomStateOwner): cleared
	 * by the service when a room session ends, checked empty before the next.
	 */
	private _registerRoomState(): void {
		this._register(this._service.registerRoomState({
			name: 'virtual file system',
			clear: () => this._fileSystem.clear(),
			inspect: () => {
				const { count, topLevel } = this._fileSystem.describeContents();
				return count ? [`${count} entries, top level: ${topLevel.join(', ')}`] : [];
			},
		}));
		this._register(this._service.registerRoomState({
			name: 'virtual workspace folder',
			// The folder itself is removed by the onRoomLeft listener, after an
			// await; only the flag that lets the next room add its own is
			// cleared here. A folder still there from an earlier room than the
			// one just left was never removed.
			clear: () => { this._virtualFolderAdded = false; },
			inspect: ({ left, entering }) => {
				const held = this.workspaceContextService.getWorkspace().folders
					.filter(f => f.uri.scheme === LIVECOLLAB_SCHEME && f.uri.authority !== left && f.uri.authority !== entering)
					.map(f => `folder ${f.uri.toString()}`);
				if (this._virtualFolderAdded) { held.push('the folder-added flag'); }
				return held;
			},
		}));
		this._register(this._service.registerRoomState({
			name: 'once-per-room notices and the attach backstop',
			clear: () => {
				this._withheldNoticeEpoch = undefined;
				this._attachFailures = undefined;
				this._attachStoppedEpoch = undefined;
			},
			inspect: () => {
				const held: string[] = [];
				if (this._withheldNoticeEpoch !== undefined) { held.push(`withheld notice shown in session ${this._withheldNoticeEpoch}`); }
				if (this._attachFailures) { held.push(`${this._attachFailures.count} attach failures in session ${this._attachFailures.epoch}`); }
				if (this._attachStoppedEpoch !== undefined) { held.push(`attaching stopped in session ${this._attachStoppedEpoch}`); }
				return held;
			},
		}));
		this._register(this._service.registerRoomState({
			name: 'containment root and move tracking',
			clear: () => {
				this._containment = undefined;
				this._myRecentMoves.clear();
				this._corrections.clear();
			},
			inspect: () => {
				const held: string[] = [];
				if (this._containment) { held.push(`containment root ${this._containment.root.path}`); }
				if (this._myRecentMoves.size) { held.push(`${this._myRecentMoves.size} recent moves`); }
				if (this._corrections.waiting) { held.push(`${this._corrections.waiting} corrections waiting for their echo`); }
				return held;
			},
		}));
		this._register(this._service.registerRoomState({
			// A mark left from the last room could swallow a real create,
			// rename or delete of the same path in the next one as its echo.
			name: 'echo-guard marks',
			clear: () => {
				for (const timer of this._selfAppliedOps.values()) { clearTimeout(timer); }
				this._selfAppliedOps.clear();
			},
			inspect: () => this._selfAppliedOps.size ? [`${this._selfAppliedOps.size} marks (${[...this._selfAppliedOps.keys()].slice(0, 5).join(', ')})`] : [],
		}));
	}

	// The real folder this machine attached to the room, recorded on every
	// successful attach. Persisted (application scope, this machine only) so it
	// survives an app restart: the server keeps the room's folder across
	// restarts, and the attach guard must still know which local folder that
	// is. Never inferred from the workspace — after Remove Folder A + Add
	// Folder B, the workspace's first real folder is B, which the room never had.
	/** The room session in which the owner was told their folder was empty here. */
	private _emptyFolderNoticeEpoch: number | undefined;

	/** The room session whose accepted attach made the id map whole; it's saved from then on. */
	private _idsWholeEpoch: number | undefined;

	private _attachedFolderStorageKey(roomId: string): string {
		return `livecollab.attachedFolder.${roomId}`;
	}

	/**
	 * The owner's id map (room path to server id), kept across restarts so the reconcile can still
	 * tell what the room removed from what's new on disk after the app was quit
	 * (ATTACH_RECONCILE_DESIGN.md, "The restart gap"). Its own key, not the persister's record: the
	 * map is this contribution's, and it changes with the room's structure, not with writes.
	 */
	private _knownIdsStorageKey(roomId: string): string {
		return `livecollab.knownIds.${roomId}`;
	}

	/**
	 * Saves the id map for the current room, when this machine owns its attached folder and the
	 * map is whole: from this room session's accepted attach on. Before that (after a restart or
	 * re-entry) a room event can add one id to an empty map, and saving that would lose the rest.
	 */
	private _storeKnownIds(): void {
		const roomId = this._service.roomId;
		const folder = this._ownerRealFolder()?.uri;
		if (!roomId || !folder || this._idsWholeEpoch === undefined || !this._service.isCurrentRoomSession(this._idsWholeEpoch)) { return; }
		const saved: IStoredKnownIds = { folder: folder.toString(), ids: this._fileSystem.allServerIds() };
		this.storageService.store(this._knownIdsStorageKey(roomId), JSON.stringify(saved), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	/** The saved id map for `roomId`, if it was saved for this same folder. */
	private _storedKnownIds(roomId: string, folder: URI): Map<string, string> {
		try {
			const raw = this.storageService.get(this._knownIdsStorageKey(roomId), StorageScope.APPLICATION);
			const saved = raw ? JSON.parse(raw) as IStoredKnownIds : undefined;
			if (saved && saved.folder === folder.toString() && Array.isArray(saved.ids)) {
				return new Map(saved.ids);
			}
		} catch (e) {
			lcLog.error('[LiveCollab] reconcile: the saved id map for', roomId, 'is unreadable — starting without it:', toErrorMessage(e));
		}
		return new Map();
	}
	private _storedAttachedFolder(roomId: string): URI | undefined {
		const raw = this.storageService.get(this._attachedFolderStorageKey(roomId), StorageScope.APPLICATION);
		if (!raw) { return undefined; }
		try {
			return URI.revive(JSON.parse(raw) as UriComponents);
		} catch {
			return undefined;
		}
	}
	/**
	 * At a room boundary, kills the terminals left from the previous room: ones
	 * still open from earlier in this launch, and persistent ones the terminal
	 * service revives with the shared workspace (their cwd is the old room's
	 * folder). Revival finishes before whenConnected settles; a terminal the
	 * user opens in the new room meanwhile is neither, and stays.
	 */
	private _killPreviousRoomTerminals(): void {
		const openAtJoin = new Set(this.terminalService.instances);
		this.terminalService.whenConnected.then(() => {
			const previous = this.terminalService.instances.filter(instance => openAtJoin.has(instance) || instance.shellLaunchConfig.attachPersistentProcess);
			if (previous.length === 0) { return; }
			this.logService.info(`[LiveCollab] room boundary: closing ${previous.length} terminal(s) from the previous room`);
			for (const instance of previous) {
				instance.dispose(TerminalExitReason.User);
			}
		});
	}

	/**
	 * At a room boundary, closes the file editors left from the previous room.
	 * A quit in room A restores A's tabs and unsaved work with the untitled
	 * workspace; saving one in room B would write to A's path. Unsaved buffers
	 * of the previous room's files (its livecollab:// files, or files under its
	 * recorded folder) are discarded with their backups — soft revert; nothing
	 * is lost from the room, whose content lives in its documents. A file that
	 * is in no known room and has unsaved changes stays open: that buffer may
	 * be the only copy. Untitled and other non-file editors stay too.
	 */
	private async _closePreviousRoomEditors(previousRoomId: string | undefined): Promise<void> {
		const previousRoomFolder = previousRoomId ? this._storedAttachedFolder(previousRoomId) : undefined;
		const toDiscard: IEditorIdentifier[] = [];
		const toClose: IEditorIdentifier[] = [];
		for (const identifier of this.editorService.getEditors(EditorsOrder.SEQUENTIAL)) {
			const resource = identifier.editor.resource;
			if (!resource) { continue; }
			if (resource.scheme === LIVECOLLAB_SCHEME || (resource.scheme === Schemas.file && previousRoomFolder && isEqualOrParent(resource, previousRoomFolder))) {
				toDiscard.push(identifier);
			} else if (resource.scheme === Schemas.file) {
				if (identifier.editor.isDirty()) {
					this.logService.warn(`[LiveCollab] room boundary: kept an unsaved file that belongs to no known room: ${resource.toString()}`);
				} else {
					toClose.push(identifier);
				}
			}
		}
		if (toDiscard.length === 0 && toClose.length === 0) { return; }
		this.logService.info(`[LiveCollab] room boundary: closing ${toDiscard.length + toClose.length} editor(s) from the previous room (${toDiscard.length} without saving)`);
		await this._closeWithoutSaving(toDiscard);
		if (toClose.length > 0) {
			await this.editorService.closeEditors(toClose);
		}
	}

	/**
	 * Removes every real folder that is not the joined room's own folder
	 * (`roomFolder`, undefined for a guest or a room with none yet) and says so.
	 * Not restored on leave: outside a room there is no editor to return it to.
	 */
	private async _removeNonRoomFolders(roomFolder: URI | undefined): Promise<void> {
		const strays = await this._roomFolderEdits.queue(() => this._removeStrayFolders(roomFolder));
		for (const folder of strays) {
			this._notices.info(localize('livecollab.folderNotInRoom', "{0} was closed because it isn't part of this room.", folder.name));
		}
	}

	/** Removes the folders that aren't the room's, read when this runs; returns the ones removed. */
	private async _removeStrayFolders(roomFolder: URI | undefined): Promise<IWorkspaceFolder[]> {
		const strays = this.workspaceContextService.getWorkspace().folders
			.filter(f => f.uri.scheme !== LIVECOLLAB_SCHEME && !(roomFolder && isEqual(f.uri, roomFolder)) && !this._attaching.has(f.uri));
		if (strays.length === 0) { return []; }
		// Named here, so not again by the previous room's leave (_tellFoldersClosedOnLeave).
		strays.forEach(f => this._closingOnLeave?.delete(f.uri));
		this.logService.info(`[LiveCollab] closing ${strays.length} folder(s) that are not this room's: ${strays.map(f => f.uri.toString()).join(', ')}`);
		this._removingNonRoomFolders = true;
		try {
			await this.workspaceEditingService.removeFolders(strays.map(f => f.uri));
		} catch (e) {
			this.logService.error(`[LiveCollab] could not close folders that are not this room's: ${toErrorMessage(e)}`);
		} finally {
			this._removingNonRoomFolders = false;
		}
		return strays;
	}

	/**
	 * Ties a notification shown now to the current room session, so it closes when that session ends
	 * (_closeRoomNotices): a room's notices don't carry into the next room. Shown outside a room, it
	 * stays as VS Code keeps it.
	 */
	private _tieToRoom(handle: INotificationHandle): INotificationHandle {
		const roomId = this._service.roomId;
		if (!roomId) { return handle; }
		let open = this._roomNotices.get(roomId);
		if (!open) {
			open = new Set();
			this._roomNotices.set(roomId, open);
		}
		const notices = open;
		notices.add(handle);
		const closed = handle.onDidClose(() => {
			notices.delete(handle);
			closed.dispose();
		});
		return handle;
	}

	/** Closes the notifications this contribution showed in `roomId`'s session, which has ended. */
	private _closeRoomNotices(roomId: string): void {
		const open = this._roomNotices.get(roomId);
		this._roomNotices.delete(roomId);
		if (!open?.size) { return; }
		this.logService.info(`[LiveCollab] room ${roomId} session ended: ${open.size} of its notice(s) closed`);
		for (const handle of [...open]) {
			handle.close();
		}
	}

	/**
	 * Names each of `folders` that the deletion of the workspace file on leaving `roomId` closes, on the
	 * dashboard if it can (Manny, 2026-11-13). Not awaited by the leave, which is unchanged; a folder
	 * the next room's cleanup closes first is named by that instead.
	 */
	private _tellFoldersClosedOnLeave(folders: IWorkspaceFolder[], roomId: string): void {
		const pending = new ResourceSet(folders.map(f => f.uri));
		this._closingOnLeave = pending;
		const token = this._leaveNoticesEnd.token;
		whenFoldersLeave(this.workspaceContextService, folders, 10_000, token).then(closed => {
			if (this._closingOnLeave === pending) {
				this._closingOnLeave = undefined;
			}
			const told = closed.filter(f => pending.has(f.uri));
			if (token.isCancellationRequested || told.length === 0) { return; }
			const names = told.map(f => `\u201c${f.name}\u201d`).join(', ');
			const roomName = this._service.leftRoomName(roomId);
			const notice = roomName
				? (told.length === 1
					? localize('livecollab.leave.folderClosed', "{0} was closed in this window when you left \u201c{1}\u201d. Closing it didn't change or delete its files.", names, roomName)
					: localize('livecollab.leave.foldersClosed', "{0} were closed in this window when you left \u201c{1}\u201d. Closing them didn't change or delete their files.", names, roomName))
				: (told.length === 1
					? localize('livecollab.leave.folderClosed.unnamed', "{0} was closed in this window when you left the room. Closing it didn't change or delete its files.", names)
					: localize('livecollab.leave.foldersClosed.unnamed', "{0} were closed in this window when you left the room. Closing them didn't change or delete their files.", names));
			this.logService.info(`[LiveCollab] leaving room ${roomId} closed ${told.length} other folder(s) with it: ${told.map(f => f.uri.toString()).join(', ')}`);
			// On the dashboard, which is in front after a leave with no room open again; not when the
			// room ended with its own notice there (removed, deleted), which this would replace. Else,
			// and when main didn't show it, in this window, where it shows once a room is open again.
			const inWindow = (why: string) => {
				this.logService.info(`[LiveCollab] closure notice for ${roomId}: ${why}, shown in this window`);
				this.notificationService.info(notice);
			};
			if (this._lastTerminatedRoomId === roomId) {
				inWindow('the room ended with its own notice on the dashboard');
				return;
			}
			if (this._service.roomId) {
				inWindow('a room is open again');
				return;
			}
			this.logService.info(`[LiveCollab] closure notice for ${roomId}: sent to main for the dashboard`);
			// Main alone decides: shown in this window only on its "not delivered", never because its
			// answer is slow (it may still show it on the dashboard).
			const noAnswerYet = () => this.logService.info(`[LiveCollab] closure notice for ${roomId}: no answer from main in 2 seconds; delivery unknown, still waiting for main's answer, not shown in this window`);
			this._service.showOnDashboard(roomId, notice, noAnswerYet).then(answer => {
				if (token.isCancellationRequested) { return; }
				if (answer === 'shown') {
					this.logService.info(`[LiveCollab] closure notice for ${roomId}: shown on the dashboard`);
				} else {
					inWindow(answer === 'not in front' ? 'not shown on the dashboard (not in front)' : 'no dashboard in this window');
				}
			});
		});
	}

	/**
	 * Records the joined room as the one this window's workspace belongs to,
	 * and returns whether it last belonged to a different (or unknown) room —
	 * the boundary at which the previous room's state must not carry over. A
	 * rejoin of the same room (including after a quit in it) is not a boundary,
	 * so its own restored tabs and unsaved work stay.
	 */
	private _enterRoomBoundary(roomId: string): { crossed: boolean; previousRoomId: string | undefined } {
		const previous = this.storageService.get(LiveCollabFolderContribution.WORKSPACE_ROOM_KEY, StorageScope.WORKSPACE);
		this.storageService.store(LiveCollabFolderContribution.WORKSPACE_ROOM_KEY, roomId, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		if (previous === roomId) { return { crossed: false, previousRoomId: previous }; }
		lcLog.info('[LiveCollab] room boundary: this window last held', previous ?? '(no recorded room)', '— now', roomId);
		return { crossed: true, previousRoomId: previous };
	}

	private _storeAttachedFolder(roomId: string, folderUri: URI): void {
		this.storageService.store(this._attachedFolderStorageKey(roomId), JSON.stringify(folderUri.toJSON()), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	/**
	 * The join's restore: room boundary, then this room's own folder and
	 * files. A room is "ready" (the "Opening room…" cover lifts and main shows
	 * the workbench) only once this has run — see _joinRestoreDone.
	 */
	/**
	 * Ends a room session in this window: saves the room's state for its next
	 * join, closes its real editors, removes its folders and deletes the
	 * untitled workspace the folders created.
	 */
	private async _leaveRoom(leftRoomId: string): Promise<void> {
		// The next room starts covered: whatever this view holds now must not
		// show when it is next brought forward.
		livecollabRoomCover.show();
		const folders = this.workspaceContextService.getWorkspace().folders;
		// The room's OWN folder — the one this machine attached to it — never
		// just the first folder open: a folder carried in from another room's
		// session would otherwise be saved as this room's and attached to it on
		// the next join (2026-10-22, room-2a6 adopted lc-closedtab).
		const roomFolderRecord = this._storedAttachedFolder(leftRoomId);
		const realFolder = roomFolderRecord ? folders.find(f => isEqual(f.uri, roomFolderRecord)) : undefined;
		// Real (non-livecollab://) editor identifiers - needed for BOTH
		// saving (their resource URIs, for Scenario 1 restore per
		// PHASE2_OVERLAY_DESIGN.md section 6) AND closing (the full
		// identifiers, with groupId, required by closeEditors()). REAL GAP
		// found 2026-08-14: this listener previously saved state and
		// removed the folder, but never actually closed the open real file
		// tabs - confirmed by direct testing (clean leave via UI, not a
		// force-kill, the tab still persisted on next room open).
		const realEditorIdentifiers = this.editorService.getEditors(EditorsOrder.SEQUENTIAL)
			.filter(identifier => identifier.editor.resource && identifier.editor.resource.scheme !== LIVECOLLAB_SCHEME);
		const openRealEditors = realEditorIdentifiers.map(identifier => identifier.editor.resource!);
		const activeUri = this.editorService.activeEditor?.resource;
		this._service.saveRoomState(leftRoomId, {
			folderUri: realFolder?.uri,
			folderName: realFolder?.name,
			openFileUris: realFolder ? openRealEditors.filter(uri => isEqualOrParent(uri, realFolder.uri)) : [],
			activeFileUri: (activeUri && activeUri.scheme !== LIVECOLLAB_SCHEME) ? activeUri : undefined
		});
		if (realEditorIdentifiers.length > 0) {
			this.editorService.closeEditors(realEditorIdentifiers);
		}
		// Room-session invariant: everything that clears ROOM state runs
		// before this listener's first await. On a switch, the next room's
		// snapshot can land while the listener is suspended; clearing after
		// an await would wipe the NEW room's virtual FS and folder. The
		// virtual FS and the folder-added flag are registered room state
		// (constructor), cleared by the service before this event fires.
		const currentWorkspace = this.workspaceContextService.getWorkspace();
		const workspaceIdentifier: IWorkspaceIdentifier | undefined = currentWorkspace.configuration ? { id: currentWorkspace.id, configPath: currentWorkspace.configuration } : undefined;
		// Remove the left room's folders — its attached real folder and every
		// virtual livecollab:// root — by URI, captured now. By URI (not
		// index) so a folder the next room adds meanwhile is never removed.
		const roomFolderUris = folders.filter(f => f.uri.scheme === LIVECOLLAB_SCHEME || f === realFolder).map(f => f.uri);
		if (roomFolderUris.length > 0) {
			lcLog.info('[LiveCollab] room left —', leftRoomId, '— removing', roomFolderUris.length, 'room folder(s)');
			await this.workspaceEditingService.removeFolders(roomFolderUris);
		}
		// PHASE3_YJS_DESIGN.md sections 16-18: real root cause of stale room
		// folders accumulating across sessions - updateFolders() above only
		// edits the LIVE, in-memory workspace, it never touches the separate,
		// disk-persisted untitled-workspace identity VS Code creates the first
		// time a folder gets added here. That identity file is what silently
		// accumulated every room ever visited (confirmed via direct filesystem
		// read on a real machine). Real fix: explicitly delete THIS workspace's
		// own untitled-workspace identity on a clean room leave, using the
		// same id/configuration already available from getWorkspace() - no new
		// IPC needed, IWorkspacesService already exposes exactly this.
		// KNOWN, NAMED GAP: this only runs on a clean leave. A force-kill,
		// crash, or unclean exit skips this entirely, same as it always has -
		// not solved here, real fix for that case is separate future work.
		if (workspaceIdentifier) {
			// The folders still open beside the room's: deleting the workspace file closes them too.
			const beside = this.workspaceContextService.getWorkspace().folders.filter(f => f.uri.scheme !== LIVECOLLAB_SCHEME && !roomFolderUris.some(uri => isEqual(uri, f.uri)));
			try {
				await this.workspacesService.deleteUntitledWorkspace(workspaceIdentifier);
				if (beside.length) {
					this._tellFoldersClosedOnLeave(beside, leftRoomId);
				}
			} catch (e) {
				lcLog.warn('[LiveCollab] could not delete untitled workspace identity on room leave:', e);
			}
		}
	}

	private async _restoreJoinedRoom(joinedRoomId: string): Promise<void> {
		// The previous session's leave (even of this same room, opened again from
		// the dashboard) finishes first: its folder removal applies only once the
		// workspace file is written, and a check made before that sees the folder
		// as still open, attaches it, and then loses it to the removal (item 4).
		await this._roomLeaving;
		const boundary = this._enterRoomBoundary(joinedRoomId);
		if (boundary.crossed) {
			this._killPreviousRoomTerminals();
			await this._closePreviousRoomEditors(boundary.previousRoomId);
		}
		const saved = this._service.getRoomState(joinedRoomId);
		// The owner's folder: the saved state only lives until the app quits,
		// and the untitled workspace that would otherwise bring the folder
		// back across a relaunch is deleted on a clean leave. So after a
		// relaunch the folder comes from this machine's record of attaching
		// it to the room — the one restore path for both.
		const folderUri = saved?.folderUri ?? (this._service.myRole === 'owner' ? this._storedAttachedFolder(joinedRoomId) : undefined);
		// A room shows its own folder and nothing else: a real folder left in
		// the window by another room's session (a quit in that room, restored
		// with the untitled workspace) goes before anything is restored.
		await this._removeNonRoomFolders(folderUri);
		if (!saved && !folderUri) { return; }
		// Room-session invariant: a restore for this room must stop the
		// moment the session changes, or it opens this room's files into
		// the next one.
		const epoch = this._service.roomEpoch;
		const stale = () => {
			if (this._service.isCurrentRoomSession(epoch)) { return false; }
			lcLog.info('[LiveCollab] stale restore for', joinedRoomId, '— room session changed, stopped');
			return true;
		};
		// Folder first, then files - files opening from a folder that isn't
		// yet in the workspace is inconsistent even if technically possible.
		if (folderUri) {
			await this._restoreRoomFolder(folderUri, stale);
		}
		if (!saved) { return; }
		for (const uri of saved.openFileUris) {
			if (stale()) { return; }
			if (saved.activeFileUri && uri.toString() === saved.activeFileUri.toString()) { continue; } // open active file last, below
			try {
				await this.editorService.openEditor({ resource: uri, options: { pinned: true, preserveFocus: true } });
			} catch (e) {
				lcLog.warn('[LiveCollab] could not restore file (may no longer exist):', basename(uri), e);
			}
		}
		if (saved.activeFileUri && !stale()) {
			try {
				await this.editorService.openEditor({ resource: saved.activeFileUri });
			} catch (e) {
				lcLog.warn('[LiveCollab] could not restore active file (may no longer exist):', basename(saved.activeFileUri), e);
			}
		}
	}

	/** The last room leave's cleanup, which the next join's restore waits for. */
	private _roomLeaving: Promise<void> = Promise.resolve();
	private _readyEpoch: number | undefined;
	private _guestReadyTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * The join's restore has run. The owner's room is ready now; a guest's
	 * once its virtual folder is in place (the snapshot handler), or after a
	 * short wait for a room that has no folder yet.
	 */
	private _joinRestoreDone(epoch: number): void {
		if (!this._service.isCurrentRoomSession(epoch)) { return; }
		if (this._service.myRole === 'owner' || this._virtualFolderAdded) {
			this._roomReady(epoch, this._service.myRole === 'owner' ? 'owner, join restore done' : 'guest, virtual folder already in place');
			return;
		}
		if (this._guestReadyTimer) { clearTimeout(this._guestReadyTimer); }
		this._guestReadyTimer = setTimeout(() => this._roomReady(epoch, 'guest 2.5 s wait, no snapshot folder'), 2500);
	}

	/** Lift the cover and tell main to show the workbench — once per room session. */
	private _roomReady(epoch: number, reason: string): void {
		if (!this._service.isCurrentRoomSession(epoch) || this._readyEpoch === epoch) { return; }
		this._readyEpoch = epoch;
		lcLog.info('[LiveCollab] room ready:', reason);
		if (this._guestReadyTimer) { clearTimeout(this._guestReadyTimer); this._guestReadyTimer = undefined; }
		livecollabRoomCover.hide();
		const ipc = (mainWindow as unknown as { vscode?: { ipcRenderer?: IOverlayIpcRenderer } }).vscode?.ipcRenderer;
		ipc?.send('vscode:livecollab-room-ready');
	}

	/**
	 * Re-add a room's folder on join, unless it is already open (a quit while
	 * in the room restores it with the untitled workspace). A folder that is no
	 * longer on disk is never added — it would show as a dead root and its
	 * attach would walk nothing — and the user is told where it was. Adding it
	 * fires onDidChangeWorkspaceFolders, which attaches it to the room.
	 */
	private async _restoreRoomFolder(folderUri: URI, stale: () => boolean): Promise<void> {
		const isOpen = () => this.workspaceContextService.getWorkspace().folders.some(f => isEqual(f.uri, folderUri));
		// One real folder per window (_openFolderFromMain): a different one
		// already open is left alone — the attach guard tells the user.
		const otherRealFolder = () => this.workspaceContextService.getWorkspace().folders.find(f => f.uri.scheme !== LIVECOLLAB_SCHEME && !isEqual(f.uri, folderUri));
		if (!isOpen() && otherRealFolder()) {
			this.logService.info(`[LiveCollab] room folder not restored: a different folder is open: ${otherRealFolder()!.uri.toString()}`);
			return;
		}
		let exists = false;
		try {
			exists = await this.fileService.exists(folderUri);
		} catch (e) {
			lcLog.warn('[LiveCollab] could not check the room folder:', folderUri.toString(), e);
		}
		if (stale()) { return; }
		if (!exists) {
			// Already open but gone: VS Code restored it with the untitled
			// workspace, before any room, from a session that quit in the room.
			// Only this room's folder is removed — never another root.
			if (isOpen()) {
				this.logService.warn(`[LiveCollab] room folder no longer on disk — removing it from the window: ${folderUri.toString()}`);
				try {
					await this.workspaceEditingService.removeFolders([folderUri]);
				} catch (e) {
					this.logService.error(`[LiveCollab] could not remove the missing room folder: ${toErrorMessage(e)}`);
				}
			} else {
				this.logService.warn(`[LiveCollab] room folder not restored: no longer on disk: ${folderUri.toString()}`);
			}
			this._notices.warn(localize('livecollab.restoreFolder.missing', "The folder '{0}' this room shares is no longer at {1}. Put it back there to keep working in this room, or create a new room to share it from its new location.", basename(folderUri), folderUri.fsPath));
			return;
		}
		// Already open: VS Code restored it with the untitled workspace, before
		// any room, from a session that quit in the room. The folder list does
		// not change on join, so nothing attaches it — and only the attach tells
		// the owner its files' room ids: without it no editor binds and nothing
		// syncs in either direction. The server keeps existing ids and docs.
		if (isOpen()) {
			if (this._service.myRole === 'owner') {
				this.logService.info(`[LiveCollab] room folder already open — attaching it: ${folderUri.toString()}`);
				await this._attachFolderToRoom();
			}
			return;
		}
		// The check above awaited: a folder may have been opened meanwhile.
		if (otherRealFolder()) { return; }
		try {
			await this.workspaceEditingService.updateFolders(this.workspaceContextService.getWorkspace().folders.length, 0, [{ uri: folderUri }]);
		} catch (e) {
			this.logService.error(`[LiveCollab] room folder not restored: updateFolders threw for ${folderUri.toString()}: ${toErrorMessage(e)}`);
		}
		if (!isOpen() && !stale()) {
			this.logService.warn(`[LiveCollab] room folder not restored: the folder was not added: ${folderUri.toString()}`);
		}
	}

	// R2 GATE: the real folder is writable only by the room OWNER, and only the
	// folder this machine actually attached to the room. A guest — even one with
	// an unrelated local folder open — gets undefined, and so does an owner
	// whose attached folder is not open: a different folder open in its place
	// (never attached) must not receive the room's create/move/delete, or a
	// guest's delete in the room would land in that folder on the owner's disk.
	// The person is told of the change, and by whom, in livecollabRoomNotices.ts.
	private _applyRole(role: string | undefined): void {
		this._fileSystem.setViewerReadOnly(role === 'viewer'
			? { value: localize('livecollab.viewerReadOnly', "You're a viewer in this room, so you can read files but not change them. The room's owner can make you an editor.") }
			: undefined);
	}

	private _ownerRealFolder() {
		const roomId = this._service.roomId;
		if (this._service.myRole !== 'owner' || !roomId) { return undefined; }
		const attached = this._storedAttachedFolder(roomId);
		if (!attached) { return undefined; }
		return this.workspaceContextService.getWorkspace().folders.find(f => isEqual(f.uri, attached));
	}

	// Editors currently open on `uri` (or, for a directory, under it) — a
	// snapshot of the live editor list at call time.
	private _openEditorsUnder(uri: URI): IEditorIdentifier[] {
		const s = uri.toString();
		const prefix = s + '/';
		return this.editorService.getEditors(EditorsOrder.SEQUENTIAL).filter((id) => {
			const rs = id.editor.resource?.toString();
			return rs === s || (rs !== undefined && rs.startsWith(prefix));
		});
	}

	// Close editors WITHOUT saving. Soft-revert clears the dirty buffer without
	// writing it anywhere — so a save on that tab can never resurrect a path the
	// room says is gone (the 4073-line failure shape). Always closes: even if
	// the revert throws, and even if VS Code's own deleted-resource handling
	// appears to have closed the tab already.
	private async _closeWithoutSaving(identifiers: readonly IEditorIdentifier[]): Promise<void> {
		if (identifiers.length === 0) { return; }
		try {
			await this.editorService.revert(identifiers, { soft: true });
		} catch (e) {
			lcLog.error('[LiveCollab] soft-revert before close failed (closing anyway):', e);
		}
		try {
			await this.editorService.closeEditors(identifiers);
		} catch (e) {
			lcLog.error('[LiveCollab] closeEditors failed:', e);
		}
	}

	// Re-point any editor open on oldUri (or under it, for a directory move) to
	// the new URI, so an open file follows a rename and re-binds to the SAME
	// fileId's document. Snapshots the open set BEFORE opening anything, so a
	// directory cascade only ever re-points tabs that were already open — never
	// opens an unopened file. The stale old-URI editors are then closed without
	// saving, so no dirty buffer survives pointing at the vanished path.
	private async _repointEditors(oldUri: URI, newUri: URI): Promise<void> {
		const oldStr = oldUri.toString();
		const stale = this._openEditorsUnder(oldUri);
		for (const id of stale) {
			const rs = id.editor.resource!.toString();
			const target = rs === oldStr ? newUri : newUri.with({ path: newUri.path + rs.slice(oldStr.length) });
			try {
				await this.editorService.openEditor({ resource: target, options: { pinned: true, preserveFocus: true } });
			} catch (e) {
				lcLog.error('[LiveCollab] re-point openEditor failed for', rs, e);
			}
		}
		await this._closeWithoutSaving(stale);
	}

	/**
	 * LiveCollab overlay: add a folder handed over by main, in place, without
	 * reloading the workbench. Product rules (one real folder per room, owner
	 * only, no switching yet) — every refusal tells the user why.
	 */
	private async _openFolderFromMain(folderUri: URI): Promise<void> {
		const roomId = this._service.roomId;
		const folders = this.workspaceContextService.getWorkspace().folders;
		const realFolder = folders.find(f => f.uri.scheme !== LIVECOLLAB_SCHEME);
		this.logService.info(`[LiveCollab] open folder from main: ${folderUri.toString()} (room: ${roomId ?? '(none)'}, role: ${this._service.myRole ?? '(none)'})`);

		// Owner only: a guest opening a folder would upload their own machine's
		// tree into someone else's room. Whether a guest may ever attach is an
		// open product question (HANDOFF).
		if (roomId && this._service.myRole !== 'owner') {
			this.logService.info('[LiveCollab] open folder refused: not the room owner');
			this._notices.info(localize('livecollab.openFolder.ownerOnly', "Only the room owner can attach a folder to this room."));
			return;
		}

		// One real folder: switching a room's folder is not supported yet — a
		// second room:attach for the same room has unverified server semantics.
		if (realFolder) {
			if (isEqual(realFolder.uri, folderUri)) {
				this.logService.info('[LiveCollab] open folder: already open, nothing to do');
				return;
			}
			this.logService.info(`[LiveCollab] open folder refused: a folder is already open: ${realFolder.uri.toString()}`);
			this._notices.info(roomId
				? localize('livecollab.openFolder.roomHasFolder', "This room already has the folder '{0}' attached. Changing a room's folder is not supported yet.", realFolder.name)
				: localize('livecollab.openFolder.folderOpen', "The folder '{0}' is already open. Opening a different folder is not supported yet.", realFolder.name));
			return;
		}

		// Append at the end. No REAL folder is open here (returned above); any
		// entry left is a livecollab:// virtual root, which only a guest has —
		// refused above while in a room.
		try {
			await this.workspaceEditingService.updateFolders(folders.length, 0, [{ uri: folderUri }]);
		} catch (e) {
			this.logService.error(`[LiveCollab] open folder: updateFolders threw for ${folderUri.toString()}: ${toErrorMessage(e)}`);
		}
		// updateFolders can return without adding (e.g. the extension host
		// refused to stop) — the check decides, not the absence of a throw.
		if (!this.workspaceContextService.getWorkspace().folders.some(f => isEqual(f.uri, folderUri))) {
			this.logService.warn(`[LiveCollab] open folder: the folder was not added: ${folderUri.toString()}`);
			this._notices.warn(localize('livecollab.openFolder.notAdded', "The folder '{0}' could not be opened.", basename(folderUri)));
		}
	}

	private async _attachFolderToRoom(): Promise<void> {
		// lc/1: rooms are born on the dashboard. A folder NEVER creates a room —
		// it only attaches content to the room you are already in.
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (!folders || folders.length === 0) {
			// No folder open — clear file state only, room and members stay
			this._service.clearFolder();
			return;
		}

		// Virtual livecollab:// folder — guest viewing a broadcast, nothing to attach
		if (folders.some(f => f.uri.scheme === LIVECOLLAB_SCHEME)) {
			lcLog.info('[LiveCollab] virtual folder detected — content attach not applicable');
			return;
		}

		const roomId = this._service.roomId;
		if (!roomId) {
			lcLog.info('[LiveCollab] folder open with no active room — not attaching (rooms are born on the dashboard)');
			return;
		}

		// Captured with roomId, before the room-folder check and the (slow) disk
		// walk: both must only ever act for the room session they started in.
		const epoch = this._service.roomEpoch;
		if (this._attachStoppedEpoch === epoch) {
			lcLog.info('[LiveCollab] not attaching: attaching stopped for this room session after repeated failures');
			return;
		}
		// One folder per room (until "After 0.3.6"): the room's own, if it's open here, else the first.
		// Every other folder in the window is never shared, and is marked and named, never left unsaid.
		const attached = this._storedAttachedFolder(roomId);
		const folder = (attached && folders.find(f => isEqual(f.uri, attached))) ?? folders[0];
		// Opened in this room session, not left from another room's: the join's restore leaves it be
		// while its attach (the question included) is under way.
		this._attaching.add(folder.uri);
		try {
			// Before the room acks this connection's join, the server refuses an
			// attach and this client doesn't know its role yet, so the owner check
			// below would refuse the owner and tell them they aren't the owner (a
			// folder opened while the join is on its way). Wait for the ack.
			if (!await this._service.whenJoinConfirmed(epoch) || !this._service.isCurrentRoomSession(epoch)) { return; }
			if (this._service.myRole === 'owner') {
				this._tellExtraFolders(folders.filter(f => f !== folder), roomId);
			}
			if (!await this._mayAttach(folder.uri, folder.name, roomId, epoch)) { return; }
			lcLog.info('[LiveCollab] attaching folder content to room:', roomId, 'folderName:', folder.name);
			await this._attachFolder(folder.uri, epoch, roomId, folder.name);
		} finally {
			this._attaching.delete(folder.uri);
		}
		// Approved but not shared (too large, empty, refused, or the session moved on): the computer's
		// record mustn't name this room as sharing a folder it doesn't, and the next attempt asks again.
		if (!this._storedAttachedFolder(roomId)) {
			this._shareAnswers.delete(folder.uri.toString());
			try {
				await this._folderClaims.release(roomId);
			} catch (e) {
				this.logService.warn(`[LiveCollab] could not release the folder record for ${roomId} after an attach that didn't complete: ${toErrorMessage(e)}`);
			}
		}
	}

	/**
	 * The attach guard. Every attach — Open Folder, Add/Remove Folder, the
	 * Scenario-1 restore, a reconnect — reaches the server through
	 * _attachFolderToRoom, so this is the one place the rules hold:
	 * - owner only (the server also accepts editors; guests never attach);
	 * - a room that already has a folder accepts only that same folder again,
	 *   as recorded on this machine. A second, different folder would reuse the
	 *   first one's file ids by relative path and bind its stale text into the
	 *   new folder's editors (HANDOFF, "switching a room's folder").
	 * Fails closed: if the room's folder cannot be determined, or the room has
	 * one but this machine has no record of attaching it (another computer,
	 * cleared storage, a moved folder), the attach is refused with a message
	 * saying what to do. Refusal leaves the folder open locally but unshared —
	 * it is never walked, its files get no ids, and _ownerRealFolder() does
	 * not return it.
	 */
	private async _mayAttach(folderUri: URI, folderName: string, roomId: string, epoch: number): Promise<boolean> {
		if (this._service.myRole !== 'owner') {
			this.logService.info(`[LiveCollab] attach refused: not the room owner (role: ${this._service.myRole ?? '(none)'}): ${folderUri.toString()}`);
			this._notices.warn(localize('livecollab.attach.ownerOnly', "Only the room owner can share a folder in this room. The folder '{0}' was not shared.", folderName));
			this._markNotShared(folderUri);
			return false;
		}
		const roomFolder = await this._service.getRoomFolder();
		if (!this._service.isCurrentRoomSession(epoch)) {
			this.logService.info(`[LiveCollab] attach check for ${roomId} is stale — room session changed, not attached`);
			return false;
		}
		if (!roomFolder) {
			this.logService.warn(`[LiveCollab] attach refused: could not determine whether room ${roomId} already has a folder: ${folderUri.toString()}`);
			this._notices.warn(localize('livecollab.attach.unknown', "LiveCollab could not confirm which folder this room uses, so the folder '{0}' was not shared. Leave the room and enter it again to retry.", folderName));
			this._markNotShared(folderUri);
			return false;
		}
		const attached = this._storedAttachedFolder(roomId);
		// Shared in this room before, from this computer: not asked again (re-entry, a reconnect, a relaunch).
		if (attached && isEqual(attached, folderUri)) {
			void this._recordAuthorizedShare(folderUri, folderName, roomId, epoch);
			return true;
		}
		if (roomFolder.hasFolder) {
			this.logService.warn(`[LiveCollab] attach refused: room ${roomId} already has folder '${roomFolder.folderName ?? '(unnamed)'}'; this machine's record: ${attached?.toString() ?? '(none)'}; refused: ${folderUri.toString()}`);
			this._notices.warn(roomFolder.folderName
				? localize('livecollab.attach.differentFolder', "This room is already sharing a different folder ('{0}'), so the folder '{1}' was not shared. To keep working in this room, open '{0}' on the computer that first shared it. To share '{1}', create a new room.", roomFolder.folderName, folderName)
				: localize('livecollab.attach.differentFolderUnnamed', "This room is already sharing a different folder, so the folder '{0}' was not shared. To keep working in this room, open the original folder on the computer that first shared it. To share '{0}', create a new room.", folderName));
			this._markNotShared(folderUri);
			return false;
		}
		return this._askToShare(folderUri, folderName, roomId, epoch);
	}

	/**
	 * "Share … with …?" (ATTACH_RECONCILE_DESIGN.md, "Sharing asks first"): asked once per attempt
	 * in a room session, before anything of the folder reaches the room. Every route that adds a
	 * folder comes here. Several events for one attempt get the same answer.
	 */
	private _askToShare(folderUri: URI, folderName: string, roomId: string, epoch: number): Promise<boolean> {
		if (this._shareAnswersEpoch !== epoch) {
			this._shareAnswers.clear();
			this._shareAnswersEpoch = epoch;
		}
		const key = folderUri.toString();
		let answer = this._shareAnswers.get(key);
		if (!answer) {
			answer = this._decideShare(folderUri, folderName, roomId, epoch);
			this._shareAnswers.set(key, answer);
		} else {
			this.logService.info(`[LiveCollab] share: already asked about ${folderUri.toString()} in this room session`);
		}
		return answer;
	}

	private async _decideShare(folderUri: URI, folderName: string, roomId: string, epoch: number): Promise<boolean> {
		const roomName = this._service.roomName ?? roomId;
		const stillWanted = () => this._service.isCurrentRoomSession(epoch) && this.workspaceContextService.getWorkspace().folders.some(f => isEqual(f.uri, folderUri));
		let rooms: ILiveCollabFolderClaim[];
		try {
			rooms = await this._liveOverlaps(folderUri, roomId);
		} catch (e) {
			return this._couldNotCheck(folderUri, folderName, e);
		}
		const told = new Set<string>();
		let ask = true;
		// Asked again only if another room's overlapping share was recorded while the question was open.
		for (let round = 0; round < 3; round++) {
			if (!stillWanted()) { return false; }
			if (ask) {
				const answer = await this._confirmShare(folderName, roomName, rooms, this._shareQuestionsEnd.token);
				if (answer === 'closed') { return false; }
				if (!answer) {
					this.logService.info(`[LiveCollab] share declined: ${folderUri.toString()} stays on this computer only (room ${roomId}${rooms.length ? `; overlaps ${rooms.map(room => room.roomId).join(', ')}` : ''})`);
					this._markNotShared(folderUri);
					return false;
				}
				rooms.forEach(room => told.add(room.roomId));
				if (!stillWanted()) { return false; }
			}
			let result;
			try {
				result = await this._folderClaims.claim({ path: folderUri.fsPath, roomId, roomName: this._service.roomName, userId: this._service.myUserId, acknowledged: [...told], known: this._knownFolders() });
			} catch (e) {
				return this._couldNotCheck(folderUri, folderName, e);
			}
			if (result.ok) {
				this.logService.info(`[LiveCollab] share approved: ${folderUri.toString()} with room ${roomId}${told.size ? ` (overlaps ${[...told].join(', ')}, shared anyway)` : ''}`);
				if (told.size) { this._overlapToldEpoch = epoch; }
				return true;
			}
			this.logService.info(`[LiveCollab] share: an overlapping share was recorded while the question was open: ${result.rooms.map(room => room.roomId).join(', ')}`);
			try {
				rooms = await this._withoutGoneRooms(result.rooms);
			} catch (e) {
				return this._couldNotCheck(folderUri, folderName, e);
			}
			ask = rooms.some(room => !told.has(room.roomId));
		}
		this.logService.warn(`[LiveCollab] share: not recorded after repeated overlapping shares; ${folderUri.toString()} not shared`);
		this._markNotShared(folderUri);
		return false;
	}

	/**
	 * The question itself: true for Share or Share anyway; 'closed' if its room session ended
	 * while it was open or waiting (it closes as Don't Share). Always in-page (`custom`), like
	 * the Workspace Trust question, so it can be closed: a native one can't.
	 */
	private async _confirmShare(folderName: string, roomName: string, rooms: readonly ILiveCollabFolderClaim[], sessionEnd: CancellationToken): Promise<boolean | 'closed'> {
		this._openShareQuestions++;
		try {
			const confirmed = await this._askShareQuestion(folderName, roomName, rooms, sessionEnd);
			return sessionEnd.isCancellationRequested ? 'closed' : confirmed;
		} finally {
			this._openShareQuestions--;
		}
	}

	/** Closes the open share questions as Don't Share: the room session they were asked in ended. */
	private _closeShareQuestions(roomId: string): void {
		if (this._openShareQuestions) {
			this.logService.info(`[LiveCollab] share: ${this._openShareQuestions} open question(s) closed as Don't Share: the room session ended (room ${roomId})`);
		}
		this._shareQuestionsEnd.dispose(true);
		this._shareQuestionsEnd = new CancellationTokenSource();
	}

	private async _askShareQuestion(folderName: string, roomName: string, rooms: readonly ILiveCollabFolderClaim[], token: CancellationToken): Promise<boolean> {
		const permissions = localize('livecollab.share.detail', "Members will have access to these files according to their room permissions. Edits change the files on this computer.");
		const message = localize('livecollab.share.message', "Share \u201c{0}\u201d with \u201c{1}\u201d?", folderName, roomName);
		if (!rooms.length) {
			const { confirmed } = await this.dialogService.confirm({
				type: Severity.Info,
				message,
				detail: permissions,
				primaryButton: localize({ key: 'livecollab.share.share', comment: ['&& denotes a mnemonic'] }, "&&Share"),
				cancelButton: localize('livecollab.share.dontShare', "Don't Share"),
				custom: true,
				token,
			});
			return confirmed;
		}
		const names = this._roomNames(rooms);
		const { confirmed } = await this.dialogService.confirm({
			type: Severity.Warning,
			message,
			detail: `${permissions}\n\n${localize('livecollab.share.overlap', "This folder is also shared in {0}. Edits and deletions affect the same files on this computer and can appear in both rooms. To keep the work separate, cancel and share a separate copy.", names)}`,
			primaryButton: localize({ key: 'livecollab.share.shareAnyway', comment: ['&& denotes a mnemonic'] }, "Share &&Anyway"),
			cancelButton: localize('livecollab.share.cancel', "Cancel"),
			custom: true,
			token,
		});
		return confirmed;
	}

	/**
	 * An attachment already authorized (shared before from this computer): recorded for the
	 * computer, and if it overlaps another room's folder the owner is told once per entry
	 * (ATTACH_RECONCILE_DESIGN.md, Ruling 2). Nothing is detached, and this never stops the attach.
	 */
	private async _recordAuthorizedShare(folderUri: URI, folderName: string, roomId: string, epoch: number): Promise<void> {
		try {
			const rooms = await this._liveOverlaps(folderUri, roomId);
			await this._folderClaims.claim({ path: folderUri.fsPath, roomId, roomName: this._service.roomName, userId: this._service.myUserId, acknowledged: rooms.map(room => room.roomId), known: this._knownFolders() });
			if (!rooms.length || this._overlapToldEpoch === epoch || !this._service.isCurrentRoomSession(epoch)) { return; }
			this._overlapToldEpoch = epoch;
			this.logService.warn(`[LiveCollab] overlapping folders: ${folderUri.toString()} (room ${roomId}) is also shared in ${rooms.map(room => room.roomId).join(', ')}`);
			const names = this._roomNames(rooms);
			this._notices.warn(localize('livecollab.share.overlapOnEntry', "\u201c{0}\u201d is also shared in {1}. Edits and deletions in either room change the same files on this computer: they reach the other room automatically while both are open, and through Use Disk Version when you switch rooms. This warning doesn't stop that. To keep the work separate, share a separate copy instead.", folderName, names));
		} catch (e) {
			this.logService.warn(`[LiveCollab] could not check ${folderUri.toString()} against this computer's other shared folders: ${toErrorMessage(e)}`);
		}
	}

	/** The other rooms on this computer whose folder overlaps `folderUri`, less any the server confirms no longer apply. */
	private async _liveOverlaps(folderUri: URI, roomId: string): Promise<ILiveCollabFolderClaim[]> {
		const { rooms } = await this._folderClaims.overlaps(folderUri.fsPath, roomId, this._knownFolders());
		return this._withoutGoneRooms(rooms);
	}

	/**
	 * Drops, and forgets, the rooms the server confirms are deleted, or no longer this account's
	 * own. A failed or unanswered request proves nothing: that room still counts.
	 */
	private async _withoutGoneRooms(rooms: readonly ILiveCollabFolderClaim[]): Promise<ILiveCollabFolderClaim[]> {
		const live: ILiveCollabFolderClaim[] = [];
		for (const room of rooms) {
			const access = await this._service.roomAccess(room.roomId);
			const mine = room.userId === this._service.myUserId;
			const gone = access === 'missing' || (mine && (access === 'noAccess' || access === 'editor' || access === 'viewer'));
			if (gone) {
				this.logService.info(`[LiveCollab] folder record for ${room.roomId} released: ${access === 'missing' ? 'the room is deleted' : `this account's ownership ended (${access})`}`);
				await this._folderClaims.release(room.roomId);
				continue;
			}
			if (access === undefined) {
				this.logService.info(`[LiveCollab] could not confirm room ${room.roomId}; its folder record still counts`);
			}
			live.push(room);
		}
		return this._named(live);
	}

	/**
	 * Fills in the names of rooms recorded before 0.3.6, which kept none, from the server's list of
	 * this account's rooms. With no answer in 5 seconds a room stays unnamed, and is shown by the
	 * folder it shares.
	 */
	private async _named(rooms: ILiveCollabFolderClaim[]): Promise<ILiveCollabFolderClaim[]> {
		if (rooms.every(room => room.roomName)) {
			return rooms;
		}
		const listed = await raceTimeout(this._service.listMyRooms(), 5000) ?? [];
		const names = new Map<string, string>();
		for (const entry of listed) {
			const { id, name } = (entry ?? {}) as { id?: unknown; name?: unknown };
			if (typeof id === 'string' && typeof name === 'string' && name) {
				names.set(id, name);
			}
		}
		return rooms.map(room => room.roomName || !names.has(room.roomId) ? room : { ...room, roomName: names.get(room.roomId) });
	}

	/** The rooms as the person knows them: by name, or, unnamed, by the folder each shares. Never by an ID. */
	private _roomNames(rooms: readonly ILiveCollabFolderClaim[]): string {
		return rooms.map(room => room.roomName
			? localize('livecollab.share.roomName', "\u201c{0}\u201d", room.roomName)
			: localize('livecollab.share.unnamedRoom', "another of your rooms (the one sharing \u201c{0}\u201d)", room.path)).join(', ');
	}

	/** This window's records from before 0.3.6, for the computer's record to adopt. */
	private _knownFolders(): ILiveCollabKnownFolder[] {
		const prefix = this._attachedFolderStorageKey('');
		return this.storageService.keys(StorageScope.APPLICATION, StorageTarget.MACHINE)
			.filter(key => key.startsWith(prefix))
			.map(key => ({ roomId: key.slice(prefix.length), uri: this._storedAttachedFolder(key.slice(prefix.length)) }))
			.filter((folder): folder is { roomId: string; uri: URI } => !!folder.uri && folder.uri.scheme === Schemas.file)
			.map(folder => ({ roomId: folder.roomId, path: folder.uri.fsPath }));
	}

	private _couldNotCheck(folderUri: URI, folderName: string, e: unknown): false {
		this.logService.error(`[LiveCollab] share: could not check ${folderUri.toString()} against this computer's other shared folders, not shared: ${toErrorMessage(e)}`);
		this._notices.warn(localize('livecollab.share.couldNotCheck', "LiveCollab couldn't check whether '{0}' is shared in another of your rooms, so it wasn't shared. Remove it and add it again to retry.", folderName));
		this._markNotShared(folderUri);
		return false;
	}

	/** The room's shared folder holding `resource`: the owner's real folder, or a member's view of the room. */
	private _sharedLocationOf(resource: URI): IRoomSharedLocation | undefined {
		const roomId = this._service.roomId;
		if (!roomId) { return undefined; }
		const roomName = this._service.roomName ?? roomId;
		const folder = resource.scheme === LIVECOLLAB_SCHEME
			? this.workspaceContextService.getWorkspace().folders.find(f => f.uri.scheme === LIVECOLLAB_SCHEME)
			: this._ownerRealFolder();
		return folder && isEqualOrParent(resource, folder.uri) ? { folderName: folder.name, roomName } : undefined;
	}

	/** Marks folders beyond the room's one as not shared, naming the newly marked ones in one message. */
	private _tellExtraFolders(extras: readonly IWorkspaceFolder[], roomId: string): void {
		const fresh = extras.filter(f => !this._notShared.has(f.uri));
		if (!fresh.length) { return; }
		fresh.forEach(f => this._markNotShared(f.uri));
		this.logService.info(`[LiveCollab] share: one folder per room; not shared with room ${roomId}: ${fresh.map(f => f.uri.toString()).join(', ')}`);
		const names = fresh.map(f => `\u201c${f.name}\u201d`).join(', ');
		this._notices.info(fresh.length === 1
			? localize('livecollab.share.extraFolder', "Only one folder can be shared in a room. {0} is open on this computer only.", names)
			: localize('livecollab.share.extraFolders', "Only one folder can be shared in a room. {0} are open on this computer only.", names));
	}

	private _markNotShared(folderUri: URI): void {
		if (!this._notShared.has(folderUri)) {
			this._notShared.add(folderUri);
			this._onDidChangeNotShared.fire([folderUri]);
		}
	}

	/** Forgets answers and marks for `folders` (removed from the window), or for all (the room session ended). */
	private _forgetShareAnswers(folders?: readonly URI[]): void {
		const forgotten = folders ?? [...this._notShared];
		for (const folder of forgotten) {
			this._shareAnswers.delete(folder.toString());
			this._notShared.delete(folder);
		}
		if (!folders) { this._shareAnswers.clear(); }
		if (forgotten.length) { this._onDidChangeNotShared.fire(forgotten); }
	}

	// PHASE4 replicate-on-join: read the folder ONCE with real contents and
	// the section-7 guards, then attach it to the room in a single message. The
	// server seeds one authoritative Y.Doc per file and returns the
	// id-assigned tree, which the host stores to map its own file:// files.
	/**
	 * The owner's offline renames and deletes (ATTACH_RECONCILE_DESIGN.md): matched against the
	 * persister's record of each file's text, and the room's text now, for the files missing on disk.
	 */
	private async _planOwnerOfflineChanges(reconcile: IReconcile, room: ReadonlyMap<string, string>, disk: ReadonlySet<string>, tree: readonly IAttachTreeItem[]): Promise<IOwnerOfflineChanges> {
		const contents = walkContents(tree);
		const newOnDisk = new Map(reconcile.newOutside.flatMap(path => {
			const content = contents.get(path);
			return content === undefined ? [] : [[path, hashText(content)] as const];
		}));
		const roomHashes = new Map<string, string>();
		for (const { id } of [...reconcile.missingOnDisk, ...reconcile.twoSided]) {
			if (id && this._service.knowsRoomText(id)) {
				roomHashes.set(id, hashText(await this._service.getRoomText(id)));
			}
		}
		return planOwnerOfflineChanges(reconcile, room, disk, this._persister.recordedHashes(), roomHashes, newOnDisk);
	}

	/**
	 * After an accepted re-attach: the room's moves made while away are made on this disk and its
	 * removals go to this disk's Trash, as a move or delete heard from the room does; then this
	 * owner's offline renames and deletes are sent to the room, each waiting for the room's answer
	 * (by which time this client's own handler has applied it to the id map), so the persister's
	 * catch-up that follows sees the room as it now is. A large removal is asked about first. The
	 * owner is told what changed, and what wasn't applied.
	 * @returns the file ids the catch-up must leave alone: removals waiting on the owner's answer
	 */
	private async _applyReconcile(reconcile: IReconcile, offline: IOwnerOfflineChanges, removals: IRoomRemovals, room: ReadonlyMap<string, string>, root: URI, tree: readonly IAttachTreeItem[], epoch: number): Promise<ReadonlySet<string>> {
		const roomId = this._service.roomId;
		const none: ReadonlySet<string> = new Set();
		if (!roomId) { return none; }
		const sessionGone = this._sessionGuard('reconcile', roomId);
		const done: IReconcileOutcome = { movedInRoom: [], removedInRoom: [], keptChanged: removals.sendBack.map(({ path }) => path), renamedHere: [], deletedHere: [] };
		const folders = new Set(walkFolders(tree));
		for (const move of outermostMoves(reconcile.movedInRoom)) {
			this._markSelfApplied('move', move.to);
			try {
				await this._moveOnOwnerDisk(root, move.id, move.from, move.to, folders.has(move.from), false, sessionGone);
				done.movedInRoom.push(move);
			} catch (e) {
				lcLog.error('[LiveCollab] reconcile: moving', move.from, '->', move.to, 'on this disk failed:', toErrorMessage(e));
			}
			if (sessionGone()) { return none; }
		}
		const removedIds = new Map(reconcile.removedInRoom.map(({ id, path }) => [path, id]));
		let closedAny = false;
		for (const path of removals.trash) {
			closedAny = await this._applyRoomDelete(root, roomId, removedIds.get(path), path, sessionGone) || closedAny;
			lcLog.info('[LiveCollab] reconcile: removed in the room while away — moved to the Trash on this disk:', path);
			done.removedInRoom.push(path);
			if (sessionGone()) { return none; }
		}
		if (closedAny) {
			this._notices.info(localize('livecollab.fileDeleted', "A file open in your editor was deleted in this room."));
		}
		for (const rename of offline.renames) {
			const accepted = await this._service.emitFileRename(rename.id, rename.from, rename.to);
			lcLog.info(`[LiveCollab] reconcile: this owner's offline rename ${rename.from} -> ${rename.to} ${accepted ? 'applied to the room' : 'not applied (no answer, or refused)'}`);
			if (accepted) { done.renamedHere.push(rename); }
			if (!this._service.isCurrentRoomSession(epoch)) { return none; }
		}
		// Files added inside a folder the room moved: neither sent nor sent back this time.
		const sentBack = new Set(removals.sendBack.map(({ path }) => path));
		const addedInMoved = reconcile.twoSided.filter(change => change.id === undefined && !sentBack.has(change.path)).map(({ path }) => path);
		const removed = filesRemovedBy(offline.deletes, room);
		const roomFiles = [...room.keys()].filter(path => ![...room.keys()].some(other => other.startsWith(path + '/'))).length;
		let waiting: ReadonlySet<string> = none;
		if (offline.deletes.length && isLargeRemoval(removed.size, roomFiles)) {
			waiting = new Set(removed.keys());
			this._askBeforeLargeRemoval(offline.deletes, [...removed.values()].sort(), waiting, epoch);
		} else {
			done.deletedHere.push(...await this._sendOfflineDeletes(offline.deletes, epoch));
			if (!this._service.isCurrentRoomSession(epoch)) { return none; }
		}
		this._notifyReconciled(done);
		this._notifyNotApplied(offline.held, addedInMoved);
		this._tellRoom(done);
		return waiting;
	}

	/** Sends the owner's offline deletes, each waiting for the room's answer; returns the paths the room accepted. */
	private async _sendOfflineDeletes(deletes: IOwnerOfflineChanges['deletes'], epoch: number): Promise<string[]> {
		const accepted: string[] = [];
		for (const { id, path } of deletes) {
			const ok = await this._service.emitFileDelete(id, path);
			lcLog.info(`[LiveCollab] reconcile: this owner's offline delete of ${path} ${ok ? 'applied to the room' : 'not applied (no answer, or refused)'}`);
			if (ok) { accepted.push(path); }
			if (!this._service.isCurrentRoomSession(epoch)) { break; }
		}
		return accepted;
	}

	/**
	 * A large removal (ATTACH_RECONCILE_DESIGN.md, "The notification"): told before it's applied,
	 * once, with the count, because the room has no restore and the files would be gone for every
	 * guest. Nothing is removed until the owner chooses Remove; dismissing keeps them, and the next
	 * re-attach asks again.
	 */
	private _askBeforeLargeRemoval(deletes: IOwnerOfflineChanges['deletes'], files: readonly string[], kept: ReadonlySet<string>, epoch: number): void {
		lcLog.warn(`[LiveCollab] reconcile: ${files.length} files would leave the room — held until the owner chooses:`, files.join(', '));
		const named = files.slice(0, FILES_NAMED_IN_NOTICE).map(path => `'${path}'`).join(', ');
		this._notices.prompt(Severity.Warning, localize('livecollab.reconcile.largeRemoval', "{0} files are gone from this folder on this computer since LiveCollab last saw it (a branch switch does this), including {1}. Applying that removes them from the room for everyone, and guests can't get them back. Nothing has been removed yet.", files.length, named), [
			{
				label: localize('livecollab.reconcile.removeFromRoom', "Remove {0} Files from Room", files.length), run: async () => {
					if (!this._service.isCurrentRoomSession(epoch)) { return; }
					const accepted = await this._sendOfflineDeletes(deletes, epoch);
					const done: IReconcileOutcome = { movedInRoom: [], removedInRoom: [], keptChanged: [], renamedHere: [], deletedHere: accepted };
					this._notifyReconciled(done);
					this._tellRoom(done);
				}
			},
			{
				// The room is right: its copies come back to this disk, so the two agree and nothing asks again.
				label: localize('livecollab.reconcile.keepInRoom', "Keep in Room"), run: () => {
					if (!this._service.isCurrentRoomSession(epoch)) { return; }
					lcLog.info(`[LiveCollab] reconcile: the owner kept ${kept.size} files in the room — writing the room's copies back to this disk`);
					this._persister.writeBackFromRoom(kept);
				}
			},
			{ ...this._showLogChoice(), isSecondary: true },
		], { onCancel: () => lcLog.info('[LiveCollab] reconcile: the large removal was dismissed — nothing removed, the files stay in the room, asked again at the next re-attach') });
	}

	/**
	 * Tells everyone else in the room what this owner's offline changes did to it, once: the server
	 * passes it on as one notice (Manny's ruling: everyone is told), rather than guests piecing it
	 * together from single renames and deletes.
	 */
	private _tellRoom(done: IReconcileOutcome): void {
		if (!done.renamedHere.length && !done.deletedHere.length) { return; }
		this._service.sendReconciled({
			renamed: done.renamedHere.slice(0, FILES_NAMED_IN_NOTICE).map(({ from, to }) => ({ from, to })),
			deleted: done.deletedHere.slice(0, FILES_NAMED_IN_NOTICE),
			renamedCount: done.renamedHere.length,
			deletedCount: done.deletedHere.length,
		});
	}

	/** A guest's one notice for an owner's offline changes reaching the room. */
	private _notifyOwnerReconciled(summary: IRoomReconciledSummary & { readonly by: string }): void {
		const items = [
			...summary.renamed.map(({ from, to }) => localize('livecollab.reconciled.item.renamed', "'{0}' renamed to '{1}'", from, to)),
			...summary.deleted.map(path => localize('livecollab.reconciled.item.deleted', "'{0}' deleted", path)),
		];
		const more = summary.renamedCount + summary.deletedCount - items.length;
		const who = summary.by || localize('livecollab.reconciled.theOwner', "The room's owner");
		const named = items.join('; ');
		const message = more > 0
			? localize('livecollab.reconciled.more', "{0} reconnected, and their changes from while they were away reached the room: {1}; and {2} more.", who, named, more)
			: localize('livecollab.reconciled.done', "{0} reconnected, and their changes from while they were away reached the room: {1}.", who, named);
		this._notices.info(message);
	}

	/** One notice for what the reconcile changed, naming the first few; the full list is in the log. */
	private _notifyReconciled(done: IReconcileOutcome): void {
		const items = [
			...done.movedInRoom.map(({ from, to }) => localize('livecollab.reconcile.item.renamedInRoom', "'{0}' was renamed to '{1}' in the room", from, to)),
			...done.removedInRoom.map(path => localize('livecollab.reconcile.item.removedInRoom', "'{0}' was deleted in the room (moved to the Trash here)", path)),
			...done.keptChanged.map(path => localize('livecollab.reconcile.item.keptChanged', "'{0}' was deleted in the room, but you'd changed it, so it's back in the room", path)),
			...done.renamedHere.map(({ from, to }) => localize('livecollab.reconcile.item.renamedHere', "your rename of '{0}' to '{1}' reached the room", from, to)),
			...done.deletedHere.map(path => localize('livecollab.reconcile.item.deletedHere', "your deletion of '{0}' reached the room", path)),
		];
		if (!items.length) { return; }
		lcLog.info('[LiveCollab] reconcile: told the owner:', items.join('; '));
		const more = items.length - FILES_NAMED_IN_NOTICE;
		const named = items.slice(0, FILES_NAMED_IN_NOTICE).join('; ');
		const message = more > 0
			? localize('livecollab.reconcile.doneMore', "While you were away, this folder and the room caught up with each other: {0}; and {1} more.", named, more)
			: localize('livecollab.reconcile.done', "While you were away, this folder and the room caught up with each other: {0}.", named);
		this._notices.prompt(Severity.Info, message, [this._showLogChoice()]);
	}

	/** One warning for the owner's changes the reconcile didn't apply, in the owner's words. Nothing in the room was changed for them. */
	private _notifyNotApplied(held: IOwnerOfflineChanges['held'], addedInMoved: readonly string[], live = false): void {
		const items = [
			...held.map(change => {
				switch (change.reason) {
					case 'severalNames': return localize('livecollab.reconcile.held.severalNames', "'{0}' is gone here, and LiveCollab couldn't tell which of {1} is its new name", change.path, (change.candidates ?? []).map(c => `'${c}'`).join(', '));
					case 'sharedName': return localize('livecollab.reconcile.held.sharedName', "'{0}' is gone here, and '{1}' could be the new name of more than one missing file", change.path, change.candidates?.[0] ?? '');
					case 'noRecord': return localize('livecollab.reconcile.held.noRecord', "'{0}' is gone here, and this computer has no record of it to tell a rename from a deletion", change.path);
					case 'roomEdited': return localize('livecollab.reconcile.held.roomEdited', "'{0}' was deleted here, but someone edited it in the room since, so it wasn't deleted", change.path);
					case 'pathTaken': return localize('livecollab.reconcile.held.pathTaken', "'{0}' is a different file here than in the room", change.path);
					case 'folderKeeps': return localize('livecollab.reconcile.held.folderKeeps', "the folder '{0}' was deleted here, but files in it are still in the room", change.path);
				}
			}),
			...addedInMoved.map(path => localize('livecollab.reconcile.held.addedInMoved', "'{0}' was added inside a folder that was moved in the room; it's shared the next time you connect", path)),
		];
		if (!items.length) { return; }
		lcLog.warn('[LiveCollab] reconcile: told the owner, not applied:', items.join('; '));
		const more = items.length - FILES_NAMED_IN_NOTICE;
		const named = items.slice(0, FILES_NAMED_IN_NOTICE).join('; ');
		const message = live
			? (more > 0
				? localize('livecollab.outside.notAppliedMore', "Some changes made to this folder outside LiveCollab weren't applied to the room, and nothing was changed in the room for them: {0}; and {1} more.", named, more)
				: localize('livecollab.outside.notApplied', "Some changes made to this folder outside LiveCollab weren't applied to the room, and nothing was changed in the room for them: {0}.", named))
			: more > 0
				? localize('livecollab.reconcile.notAppliedMore', "Some of your changes from while you were away weren't applied, and nothing was changed in the room for them: {0}; and {1} more.", named, more)
				: localize('livecollab.reconcile.notApplied', "Some of your changes from while you were away weren't applied, and nothing was changed in the room for them: {0}.", named);
		this._notices.prompt(Severity.Warning, message, [this._showLogChoice()]);
	}

	/** The reconcile's findings, in the log: what was left out of the attach and why, and what's held. */
	private _logReconcile(reconcile: IReconcile, offline: IOwnerOfflineChanges, removals: IRoomRemovals): void {
		const list = (items: readonly unknown[]) => items.map(item => JSON.stringify(item)).join(', ');
		lcLog.info(`[LiveCollab] reconcile: left out ${reconcile.leaveOut.size} paths; moved in the room ${reconcile.movedInRoom.length}, removed in the room ${reconcile.removedInRoom.length}, new on disk ${reconcile.newOutside.length}, missing on disk ${reconcile.missingOnDisk.length}, changed on both sides ${reconcile.twoSided.length}`);
		if (reconcile.movedInRoom.length) { lcLog.info('[LiveCollab] reconcile: moved in the room while away (the disk keeps the old name):', list(reconcile.movedInRoom)); }
		if (reconcile.removedInRoom.length) { lcLog.info('[LiveCollab] reconcile: removed in the room while away (the disk keeps it):', list(reconcile.removedInRoom)); }
		if (reconcile.missingOnDisk.length) { lcLog.info('[LiveCollab] reconcile: missing on disk, still in the room:', list(reconcile.missingOnDisk)); }
		if (reconcile.twoSided.length) { lcLog.info('[LiveCollab] reconcile: changed on both sides while away:', list(reconcile.twoSided)); }
		if (offline.renames.length) { lcLog.info('[LiveCollab] reconcile: renamed on this disk while away, to be renamed in the room:', list(offline.renames)); }
		if (offline.deletes.length) { lcLog.info('[LiveCollab] reconcile: deleted on this disk while away, to be deleted in the room:', list(offline.deletes)); }
		if (removals.trash.length) { lcLog.info('[LiveCollab] reconcile: removed in the room while away, to go to the Trash on this disk:', list(removals.trash)); }
		if (removals.sendBack.length) { lcLog.info('[LiveCollab] reconcile: removed in the room while away but changed on this disk, sent back to the room as new:', list(removals.sendBack)); }
		if (offline.held.length) { lcLog.warn('[LiveCollab] reconcile: missing on this disk, held (left as they are in the room):', list(offline.held)); }
	}

	private async _attachFolder(folderUri: URI, epoch: number, roomId: string, folderName?: string): Promise<void> {
		this._liveEpoch = undefined; // the attach's reconcile covers the disk until it's done
		let root: IContainmentRoot;
		try {
			const realPath = await this._realpath(folderUri.fsPath);
			if (!realPath) { throw new Error('the folder is not there'); }
			root = { path: folderUri.fsPath, realPath };
		} catch (e) {
			lcLog.error('[LiveCollab] attach: could not resolve the shared folder', folderUri.fsPath, toErrorMessage(e), '— nothing shared');
			this._notices.error(localize('livecollab.attach.unresolved', "LiveCollab couldn't find where the folder '{0}' really is on this computer, so nothing was shared. The reason is in the log.", folderName ?? basename(folderUri)));
			return;
		}
		const ctx: IAttachWalkContext = { root, totalBytes: 0, skipped: new Map(), withheld: [] };
		let tree: IAttachTreeItem[];
		try {
			tree = await this._readFileTree(folderUri, 0, '', ctx);
			this._containment = { root, withheldLinks: new Set(ctx.withheld.filter(w => w.reason === 'link').map(w => w.path)) };
			if (root.realPath !== root.path) { lcLog.info('[LiveCollab] attach: the shared folder', root.path, 'is really', root.realPath); }
			// One-line summary of what the exclusion rules kept out of the room
			// (runtime creates warn per file; the bulk walk would otherwise be silent).
			const skippedTotal = Array.from(ctx.skipped.values()).reduce((a, b) => a + b, 0);
			const reasons = Array.from(ctx.skipped, ([reason, count]) => `${reason}: ${count}`).join(', ');
			lcLog.info(`[LiveCollab] attach: exclusion rules skipped ${skippedTotal} entries${skippedTotal ? ` — ${reasons}` : ''}`);
			if (ctx.withheld.length) {
				lcLog.warn(`[LiveCollab] attach: not shared with the room (links and files that look like secrets): ${ctx.withheld.map(w => `${w.path} (${w.detail})`).join(', ')}`);
			}
		} catch (e) {
			if (e instanceof Error && e.message === 'folder_too_large') {
				// All-or-nothing: a folder is never shared partially.
				const totalMb = (ctx.totalBytes / (1024 * 1024)).toFixed(1);
				this._notices.error(localize('livecollab.folderTooLarge', "This folder is too large to share live ({0} MB exceeds the {1} MB limit). Nothing was shared.", totalMb, TOTAL_FOLDER_CAP_MB));
				lcLog.error('[LiveCollab] folder too large — attach aborted past', totalMb, 'MB');
				return;
			}
			lcLog.error('[LiveCollab] failed to read file tree:', e);
			return;
		}
		// A guest joining a room runs this against its own empty workspace;
		// an empty tree is never meaningful and could only wipe real data, so
		// it is guarded out entirely.
		if (!tree || tree.length === 0) {
			lcLog.info('[LiveCollab] skipping attach of empty file tree — nothing real to share');
			// The owner's folder, attached before, now empty here: say why nothing changed in the room,
			// once per room session (ATTACH_RECONCILE_DESIGN.md, "The notification").
			if (isEqual(this._storedAttachedFolder(roomId), folderUri) && this._emptyFolderNoticeEpoch !== epoch && this._service.isCurrentRoomSession(epoch)) {
				this._emptyFolderNoticeEpoch = epoch;
				this._notices.prompt(Severity.Info, localize('livecollab.reconcile.emptyFolder', "'{0}' is empty on this computer, so nothing was removed from the room: it still has all its files, and none were put back in this folder.", folderName ?? basename(folderUri)), [this._showLogChoice()]);
			}
			return;
		}
		// Room-session invariant: the walk above can take seconds. If the room
		// session changed meanwhile, this tree belongs to the room it started
		// in and must never be attached to the current one.
		if (!this._service.isCurrentRoomSession(epoch)) {
			lcLog.info('[LiveCollab] stale attach — walk started in', roomId, ', now in', this._service.roomId ?? '(no room)', '— not attached');
			return;
		}
		// Reconcile before the attach (ATTACH_RECONCILE_DESIGN.md): with the room's
		// tree in hand, what the room moved or removed while this owner was away
		// is left out, so the server (which adds every path it lacks) doesn't put
		// it back. The ids this owner knew are read before the ack replaces them.
		const roomTree = await this._service.roomTreeAfterJoin(epoch);
		if (!this._service.isCurrentRoomSession(epoch)) { return; }
		if (roomTree === undefined) {
			lcLog.warn('[LiveCollab] attach: the room\'s tree could not be had, so nothing was compared or sent — the next connection retries');
			return;
		}
		let toSend = tree;
		let reconcile: IReconcile | undefined;
		let offline: IOwnerOfflineChanges | undefined;
		let removals: IRoomRemovals | undefined;
		let room: ReadonlyMap<string, string> = new Map();
		if (roomTree.length > 0) {
			room = roomIds(roomTree);
			const disk = new Set(walkPaths(tree));
			// The ids this owner knew: this session's, or after a restart or re-entry (which empty it),
			// the copy saved for this folder.
			const whole = this._idsWholeEpoch === epoch;
			const known = whole ? new Map(this._fileSystem.allServerIds()) : this._storedKnownIds(roomId, folderUri);
			if (!whole) { lcLog.info(`[LiveCollab] reconcile: first attach of this room session (a restart or re-entry) — using the ${known.size} ids saved for this folder`); }
			reconcile = reconcileBeforeAttach(room, known, disk);
			offline = await this._planOwnerOfflineChanges(reconcile, room, disk, tree);
			if (!this._service.isCurrentRoomSession(epoch)) { return; }
			const diskHashes = new Map([...walkContents(tree)].map(([path, content]) => [path, hashText(content)]));
			removals = planRoomRemovals(reconcile, new Set(walkFolders(tree)), this._persister.recordedHashes(), diskHashes);
			this._logReconcile(reconcile, offline, removals);
			// An offline rename's new name isn't sent as a new file: the room's file is renamed to it.
			// What the owner changed in something the room removed goes back to the room as new.
			toSend = walkWithout(tree, new Set([...reconcile.leaveOut, ...offline.renames.map(rename => rename.to)]), new Set(removals.sendBack.map(({ path }) => path)));
		}
		// Everything on disk left out: there's nothing to add, and the room's own
		// tree stands for the ack (the server refuses an empty attach).
		const result = toSend.length > 0
			? await this._service.attachFolder(toSend, epoch, folderName, ctx.withheld.map(w => w.path), ctx.withheld.filter(w => w.reason === 'link').map(w => w.path))
			: { ok: true as const, tree: roomTree };
		if (result && !result.ok) {
			this._attachFailed(result.failure, result.wireBytes, ctx.totalBytes, epoch);
			return;
		}
		const treeWithIds = result?.tree;
		// socket.to() excludes the sender, so the ack is the host's only way
		// to learn its own files' server-assigned ids. attachFolder returns
		// undefined for a stale ack, so ids from another session never land.
		if (treeWithIds) {
			this._attachFailures = undefined;
			// Recorded only on success, and before the ids land: the attach guard
			// and _ownerRealFolder() both key on this record.
			this._storeAttachedFolder(roomId, folderUri);
			// The ack is the room's whole tree, so the map becomes it. Ordering
			// (ATTACH_RECONCILE_DESIGN.md, "the race"): this runs in the ack's own
			// task (no await between the ack and here), so no room message that
			// comes after the ack can be handled before it. Messages that came
			// before it are already in the ack's tree, and their handlers' later
			// map writes repeat what it holds. Keep this free of awaits.
			this._idsWholeEpoch = epoch; // before the replace, whose change event saves the map
			this._fileSystem.replaceServerFileIds(treeWithIds);
			this._persister.setOversize(oversizePaths(tree));
			let waiting: ReadonlySet<string> = new Set();
			if (reconcile && offline && removals) {
				waiting = await this._applyReconcile(reconcile, offline, removals, room, folderUri, tree, epoch);
				if (!this._service.isCurrentRoomSession(epoch)) { return; }
			}
			this._persister.catchUp(waiting);
			// Row 27: a silent exclusion is how links went unnoticed. Say what
			// was kept back, once per room session (a socket reconnect
			// re-attaches); the full list is in the log above.
			if (ctx.withheld.length && this._withheldNoticeEpoch !== epoch) {
				this._withheldNoticeEpoch = epoch;
				this._notifyWithheld(ctx.withheld);
			}
		}
		lcLog.info('[LiveCollab] folder attached:', tree.length, 'top-level items, folderName:', folderName);
		this._liveEpoch = epoch;
	}

	// Counts a failed attach. Too large to send stops at once; a failed ack or
	// a socket that closed mid-attach stops after ATTACH_FAILURES_BEFORE_STOP
	// in a row. Stopping lasts for the room session, and the owner is told.
	private _attachFailed(failure: 'tooLarge' | 'failed' | 'closed', wireBytes: number, contentBytes: number, epoch: number): void {
		const count = this._attachFailures?.epoch === epoch ? this._attachFailures.count + 1 : 1;
		this._attachFailures = { epoch, count };
		if (failure !== 'tooLarge' && count <= ATTACH_FAILURES_BEFORE_STOP) {
			lcLog.warn(`[LiveCollab] attach failed (${failure}), ${count} in a row — the next reconnect retries`);
			return;
		}
		this._attachStoppedEpoch = epoch;
		const contentMb = (contentBytes / (1024 * 1024)).toFixed(1);
		const wireMb = (wireBytes / (1024 * 1024)).toFixed(1);
		lcLog.error(`🔴 [LiveCollab] attaching stopped for this room session: ${failure}, ${count} in a row; ${contentMb} MB of files, ${wireMb} MB to send`);
		this._notices.prompt(Severity.Error, localize('livecollab.attach.stopped', "This folder is too large to share live: {0} MB of files, {1} MB to send. It was not shared. Leave the room and enter it again to retry.", contentMb, wireMb), [this._showLogChoice()]);
	}

	// Names up to WITHHELD_NAMED_IN_NOTICE kept-back items, with a button to
	// the window log, which lists them all.
	private _notifyWithheld(withheld: readonly IWithheldItem[]): void {
		const named = withheld.slice(0, WITHHELD_NAMED_IN_NOTICE).map(w => w.reason === 'link'
			? localize('livecollab.attach.withheldLink', "{0} (link)", w.path)
			: localize('livecollab.attach.withheldSecret', "{0} (secret)", w.path)
		).join(', ');
		const more = withheld.length - WITHHELD_NAMED_IN_NOTICE;
		const message = withheld.length === 1
			? localize('livecollab.attach.withheldOne', "1 item wasn't shared with this room: {0}.", named)
			: more > 0
				? localize('livecollab.attach.withheldMore', "{0} items weren't shared with this room: {1} and {2} more.", withheld.length, named, more)
				: localize('livecollab.attach.withheldMany', "{0} items weren't shared with this room: {1}.", withheld.length, named);
		this._notices.prompt(Severity.Info, message, [this._showLogChoice()]);
	}

	// The notice button that opens the window log (renderer.log), where lcLog
	// lines land.
	private _showLogChoice() {
		return {
			label: localize('livecollab.showLog', "Show Log"),
			run: () => this.outputService.showChannel(windowLogId)
		};
	}

	private _isBinaryExt(name: string): boolean {
		const dot = name.lastIndexOf('.');
		return dot >= 0 && BINARY_EXTS.has(name.slice(dot).toLowerCase());
	}
	private _looksBinary(buf: VSBuffer): boolean {
		const bytes = buf.buffer;
		const n = Math.min(bytes.length, 8192);
		for (let i = 0; i < n; i++) { if (bytes[i] === 0) { return true; } }
		return false;
	}

	/** The text of `resource`'s open editor when it has unsaved changes, otherwise undefined. */
	private _unsavedText(resource: URI): string | undefined {
		const model = this.textFileService.files.get(resource);
		return model?.isDirty() ? model.textEditorModel?.getValue() : undefined;
	}

	// Reads the tree with real file contents. Files carry `content` (or an
	// `oversize` flag when over the per-file cap); directories carry
	// `children`. `path` is the room-relative itemPath (NOT an absolute disk
	// path) so host and guest share one identity space. Throws
	// 'folder_too_large' when the aggregate cap is passed, so the caller can
	// abort the whole attach.
	private async _readFileTree(uri: URI, depth: number, relativePath: string, ctx: IAttachWalkContext): Promise<IAttachTreeItem[]> {
		const skip = (reason: string) => ctx.skipped.set(reason, (ctx.skipped.get(reason) ?? 0) + 1);
		if (depth > 4) { skip('directory past max depth 4'); return []; } // max depth 4
		let stat;
		try {
			stat = await this.fileService.resolve(uri);
		} catch { return []; }
		if (!stat.children) { return []; }
		const items: IAttachTreeItem[] = [];
		for (const child of stat.children) {
			const name = child.name;
			const itemRelativePath = relativePath ? `${relativePath}/${name}` : name;
			// Row 27, under the containment rule: a link is never followed. One
			// leading outside the folder (or nowhere) would send files the owner
			// never shared; one leading inside is already shared under its real
			// name (livecollabContainment.ts, judgeLink). Only links are resolved.
			if (child.isSymbolicLink) {
				const link = await judgeLink(this._disk, ctx.root, child.resource.fsPath);
				skip(link.verdict === 'alias' ? 'link inside the folder' : 'link');
				ctx.withheld.push({ path: itemRelativePath, reason: 'link', detail: link.detail });
				continue;
			}
			if (EXCLUDED_DIRS.has(name) || (child.isDirectory && isEnvFolderName(name))) { skip(`excluded dir '${name}'`); continue; }
			const secret = child.isDirectory ? secretFolderRule(itemRelativePath) : secretFileRule(itemRelativePath);
			if (secret) { skip(child.isDirectory ? 'secret folder' : 'secret file'); ctx.withheld.push({ path: itemRelativePath, reason: 'secret', detail: secret }); continue; } // never share secrets
			// Map absolute disk path -> relative itemPath so the host can
			// translate its own file:// model uri to the shared server id.
			this._fileSystem.recordRealPath(child.resource.fsPath, itemRelativePath);
			if (child.isDirectory) {
				const children = await this._readFileTree(child.resource, depth + 1, itemRelativePath, ctx);
				items.push({ name, path: itemRelativePath, type: 'directory', children });
				continue;
			}
			if (this._isBinaryExt(name)) { skip('binary extension'); continue; } // never share binaries
			let size = 0;
			try { size = (await this.fileService.stat(child.resource)).size ?? 0; } catch { skip('unreadable'); continue; }
			if (size > PER_FILE_CAP_BYTES) {
				items.push({ name, path: itemRelativePath, type: 'file', oversize: true });
				continue;
			}
			let buf: VSBuffer;
			// An open file with unsaved changes: the room is seeded from what the editor shows, not
			// the disk. The binding replaces the editor's text with the room's, so seeding from the
			// disk would throw the unsaved text away. Nothing is saved here.
			const unsaved = this._unsavedText(child.resource);
			if (unsaved !== undefined) {
				buf = VSBuffer.fromString(unsaved);
				lcLog.info('[LiveCollab] attach: seeding', itemRelativePath, 'from its unsaved editor, not the disk');
			} else {
				try { buf = (await this.fileService.readFile(child.resource)).value; } catch { skip('unreadable'); continue; }
				if (this._looksBinary(buf)) { skip('binary content (null byte)'); continue; } // null-byte sniff
			}
			ctx.totalBytes += buf.byteLength;
			if (ctx.totalBytes > TOTAL_FOLDER_CAP_BYTES) { throw new Error('folder_too_large'); }
			items.push({ name, path: itemRelativePath, type: 'file', content: buf.toString() });
		}
		return items.sort((a, b) => {
			if (a.type === 'directory' && b.type === 'file') { return -1; }
			if (a.type === 'file' && b.type === 'directory') { return 1; }
			return a.name.localeCompare(b.name);
		});
	}
}
