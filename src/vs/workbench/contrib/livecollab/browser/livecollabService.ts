/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { localize } from '../../../../nls.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import product from '../../../../platform/product/common/product.js';
import { LIVECOLLAB_PRODUCTION_ENDPOINTS } from '../../../../platform/product/common/livecollabBuildFlavor.js';
import { URI } from '../../../../base/common/uri.js';
import { LiveCollabFileStates } from './livecollabFileStates.js';
import { mainWindow } from '../../../../base/browser/window.js';
// Phase 3 (PHASE3_YJS_DESIGN.md): 'yjs' is a real third-party npm package,
// not part of VS Code's own internal module graph. This codebase's lint
// rules require third-party npm modules to be loaded via
// importAMDNodeModule (real, actively-used pattern elsewhere in this
// fork - see markedKatexSupport.ts's use for 'katex') rather than a
// plain top-level `import`, which would type-check but fail to actually
// resolve at runtime. Real compile-vs-runtime distinction caught before
// testing, not after - a plain `import` passed TypeScript's type-checker
// completely, but would NOT have worked when the app actually ran.
// Type-only reference below (does not trigger runtime loading);
// YDoc is the actual runtime module, loaded lazily via getYjsModule().
type YDoc = InstanceType<typeof import('yjs').Doc>;

// Scenario 1 (same-session room switching) saved state. See
// PHASE2_OVERLAY_DESIGN.md section 6. Deliberately minimal - only the
// fields decided as in-scope (folder path, open files, active file), not
// cursor/scroll position (deferred) and not virtual filesystem state
// (handled separately via the existing fileSystemProvider.clear() +
// server refetch on join).
/** Why this client's membership of a room ended. */
/** The server's answer to an owner's action on a member. `error` is a sentence the server or this client wrote. */
export interface IMemberActionResult {
	readonly ok: boolean;
	readonly error?: string;
}

export type RoomTerminationReason = 'left' | 'leftElsewhere' | 'kicked' | 'ended' | 'notMember';

export interface RoomState {
	folderUri: URI | undefined;
	folderName: string | undefined;
	openFileUris: URI[];
	activeFileUri: URI | undefined;
}

import SentryWorkbench from './vendor/sentry.electron.renderer.esm.js';
import { lcLog } from './livecollabLog.js';
import { LiveCollabRoomChat } from './livecollabChat.js';
import { redactSecrets, sentryBreadcrumb } from '../../../../base/common/redactSecrets.js';
// The same filters as main's and the dashboard's: no console breadcrumbs (log lines carry room ids
// and room file paths), and everything else redacted, home folder names included (SENTRY_AUDIT.md).
SentryWorkbench.init({
	dsn: 'https://c08142a98b008018e7b40a0699031f11@o4511821873348608.ingest.us.sentry.io/4511821905854464',
	sampleRate: 1.0,
	beforeBreadcrumb: (breadcrumb: { category?: string }) => sentryBreadcrumb(breadcrumb),
	beforeSend: <T extends object>(event: T) => redactSecrets(event),
});
lcLog.info('[LiveCollab] Sentry initialized (workbench renderer)');

export interface ILiveCollabMember {
	userId: string;
	name: string;
	/**
	 * Set by the server (room_members.displayName) on member lists. Null for a
	 * member who accepted an invite but hasn't opened the room yet: the room
	 * stores the name when they first join it.
	 */
	displayName?: string | null;
	email: string;
	role: 'owner' | 'editor' | 'viewer';
	socketId: string;
}

/**
 * One entry of a room's file tree as the server sends it: structure and the
 * server-assigned id, plus (on attach only) the file's content.
 */
export interface ILiveCollabTreeItem {
	readonly name: string;
	readonly path?: string;
	readonly type: 'file' | 'directory';
	readonly id?: string;
	readonly content?: string;
	readonly oversize?: boolean;
	readonly children?: ILiveCollabTreeItem[];
}

/**
 * The socket.io client socket, as far as this service uses it (the vendored
 * ESM bundle ships no types).
 */
/**
 * The largest room:attach message sent, as encoded on the wire. The server
 * closes the socket on any message over its maxHttpBufferSize (64e6,
 * server/index.js); this stays under it with room for framing. The two
 * numbers must agree: change both together.
 */
const ATTACH_WIRE_CAP_BYTES = 60e6;
/** How long an attach waits for the room to confirm this connection's join before it isn't sent (the next connection's attach covers it). */
const JOIN_CONFIRM_WAIT_MS = 30000;
/**
 * What an owner's reconcile applied to the room after a reconnect: its offline renames and
 * deletes, at most 3 of each named, with the counts (the server caps it the same way).
 */
export interface IRoomReconciledSummary {
	readonly renamed: readonly { readonly from: string; readonly to: string }[];
	readonly deleted: readonly string[];
	readonly renamedCount: number;
	readonly deletedCount: number;
}

/** How long a file operation (a rename, a delete) waits for the room's answer before counting as unanswered. */
const FILE_OPERATION_ANSWER_MS = 10000;
/** How long the owner's reconcile waits for the snapshot that follows a join before asking for the tree. */
const ROOM_TREE_WAIT_MS = 5000;

/**
 * The largest doc whose full state is re-sent after a reconnect. Encoded as a
 * JSON number array that is ~3.5x on the wire (~700 KB here); larger docs are
 * skipped and logged, and their out-of-sync notice says so.
 */
const RESYNC_STATE_CAP_BYTES = 200 * 1024;

/**
 * How long a rejoin's convergence check (yjs:sync) waits for the server's
 * answer. A server without the check never answers: the full state is then
 * re-sent as before.
 */
const SYNC_ACK_MS = 5000;

/**
 * How long a file the room had no document for waits for the room's next
 * snapshot (the owner re-attaching) before it is checked again anyway.
 */
const SYNC_RETRY_MS = 10000;
/** How long a chat request waits for the server's answer before it is reported as unanswered. */
const CHAT_ANSWER_MS = 10000;

/**
 * Why the room refused a change: no document for the file, the change couldn't be saved, or this
 * member can't edit the room any more (made a viewer, say, while offline with changes).
 */
type RoomRefusal = 'no_doc' | 'not_saved' | 'read_only';

/** The server's answer to yjs:sync. */
interface ISyncAck {
	readonly ok: boolean;
	readonly error?: string;
	/** What this side lacks. */
	readonly update?: number[];
	/** The room's state vector, from which this side computes what the room lacks. */
	readonly stateVector?: number[];
}

/**
 * What a sent room:attach came to: the server's id-assigned tree, or why
 * there is none. `wireBytes` is the encoded message size.
 */
type AttachResult =
	| { readonly ok: true; readonly tree: ILiveCollabTreeItem[] }
	| { readonly ok: false; readonly failure: 'tooLarge' | 'failed' | 'closed'; readonly wireBytes: number };

/**
 * A piece of state that belongs to one room session. Its owner registers it
 * with registerRoomState; the service clears every registered piece when a
 * room session ends, and checks each is empty before the next one starts.
 * Before this, every owner cleared its own state on onRoomLeft, and one that
 * silently cleared nothing (the guest's virtual files, 2026-10-28) went
 * unnoticed until a guest saw another room's files.
 */
export interface IRoomStateOwner {
	/** Names this state in the log. */
	readonly name: string;
	/**
	 * Empties it, or starts emptying it, at the end of a room session (the
	 * editor close and the folder removal complete later). Left out for state
	 * with no safe clear: that state is only inspected.
	 */
	readonly clear?: () => void;
	/**
	 * Runs at the start of the session's end, before anything is cleared:
	 * the room's documents, role and ids are all still there. For state that
	 * has to capture something from the session before it goes (the room
	 * persister's unwritten files). Must not throw or wait.
	 */
	readonly beforeClear?: () => void;
	/**
	 * What it still holds, as short descriptions (never secrets); empty when
	 * clean. `rooms` names the session just left and the one being entered,
	 * so state whose clean-up is still under way for the left room is not
	 * reported as left over.
	 */
	inspect(rooms: { readonly left: string | undefined; readonly entering: string }): string[];
}

/** The server's answer to a create, rename or delete. */
interface IFileOperationAck {
	readonly ok?: boolean;
	readonly error?: string;
}

/** The room socket, as far as this service uses it (a socket.io client socket). */
export interface ILiveCollabSocket {
	readonly connected: boolean;
	readonly id: string | undefined;
	emit(event: string, ...args: unknown[]): void;
	on(event: string, listener: (...args: never[]) => void): void;
	disconnect(): void;
}

/** What the room socket sends the server as it connects. */
export interface ILiveCollabHandshake {
	readonly token: string;
	/** LiveCollab's version (product.json `livecollabVersion`); absent from 0.3.5 and older. */
	readonly clientVersion?: string;
}

/** What the service asks of the socket it opens (socket.io client options). */
export interface ILiveCollabSocketOptions {
	auth: (cb: (data: ILiveCollabHandshake) => void) => void;
	transports: string[];
	reconnection: boolean;
}

/** Opens the room socket to `url`. The vendored socket.io client by default; the layer B harness passes its own. */
export type LiveCollabSocketFactory = (url: string, options: ILiveCollabSocketOptions) => Promise<ILiveCollabSocket>;

/** The default socket factory: the vendored socket.io client, loaded on first use. */
async function openVendorSocket(url: string, options: ILiveCollabSocketOptions): Promise<ILiveCollabSocket> {
	// @ts-ignore
	const { io } = await import('./vendor/socket.io.esm.min.js');
	return io(url, options);
}

/**
 * The preload-exposed IPC renderer (window.vscode.ipcRenderer), as far as
 * this service uses it.
 */
export interface IWorkbenchIpcRenderer {
	invoke(channel: string, ...args: unknown[]): Promise<unknown>;
	send(channel: string, ...args: unknown[]): void;
	on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
	removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}
function workbenchIpc(): IWorkbenchIpcRenderer | undefined {
	return (mainWindow as unknown as { vscode?: { ipcRenderer?: IWorkbenchIpcRenderer } }).vscode?.ipcRenderer;
}

/** The server's answer to `room:join`. */
interface IRoomJoinAck {
	readonly ok?: boolean;
	readonly error?: string;
	readonly userId?: string;
	readonly role?: string;
	readonly displayName?: string;
	readonly email?: string;
}

/** A remote member's cursor position, as relayed by the server. */
interface ICursorUpdate {
	readonly socketId: string;
	readonly roomId: string;
	readonly fileId: string;
	readonly name: string;
	readonly position: { lineNumber: number; column: number };
}

// PHASE4: the full guest-facing room payload. docs carry one seeded Y.Doc
// binary state per file, keyed by the server-assigned fileId.
export interface ILiveCollabSnapshot {
	tree: ILiveCollabTreeItem[];
	roomName: string;
	folderName?: string;
	docs: Array<{ fileId: string; state: number[] }>;
}

/** Whether the current room holds an attached folder, as the server reported it. */
export interface IRoomFolderInfo {
	readonly hasFolder: boolean;
	readonly folderName: string | undefined;
}

export class LiveCollabService extends Disposable {

	private socket: ILiveCollabSocket | null = null;
	private _token: string | undefined;
	private _roomId: string | undefined;
	private _roomName: string | undefined;
	private _displayName: string = 'User';
	private _myUserId: string = '';
	private _lastMembers: ILiveCollabMember[] = [];
	/** Who is in the room right now, by user id, as the server's presence says. */
	private _online = new Set<string>();
	private _fileCache: Map<string, string> = new Map();
	private _connecting = false;
	// Tracks whether this room's file tree has arrived over the socket
	// (via the host's one-shot room:file:tree broadcast). Used to arm a
	// fallback: a guest that joins during a host extension-host crash-loop
	// never sees that broadcast, so if the tree hasn't landed shortly
	// after joining we pull it on demand via room:request-tree. Reset to
	// false on every guest join so the fallback is armed fresh each time.
	private _snapshotReceived = false;
	// Whether the current room already has a folder, per the server. Learned
	// from any snapshot (one arrives on join when a tree exists, and after
	// every attach) or asked for directly by getRoomFolder(). undefined =
	// not known yet this room session. Cleared on room-session teardown.
	private _roomFolder: IRoomFolderInfo | undefined;
	private _treeFallbackTimer: ReturnType<typeof setTimeout> | undefined;
	// PHASE3_YJS_DESIGN.md sections 11-12: the Clerk session token has a
	// confirmed 60-second lifetime (decoded directly from a real JWT).
	// This timer proactively re-mints it well before expiry, so a stale
	// token never sits waiting to cause a reactive disconnect - regardless
	// of whether that disconnect is server-triggered by expiry (not yet
	// confirmed) or something else, keeping this warm is a safe, real
	// improvement either way.
	private _tokenRefreshTimer: number | undefined;

	/** The current room's chat log. */
	readonly chat: LiveCollabRoomChat;

	private readonly _onConnected = this._register(new Emitter<void>());
	readonly onConnected: Event<void> = this._onConnected.event;

	private readonly _onDisconnected = this._register(new Emitter<void>());
	readonly onDisconnected: Event<void> = this._onDisconnected.event;

	private readonly _onMembersChanged = this._register(new Emitter<ILiveCollabMember[]>());
	readonly onMembersChanged: Event<ILiveCollabMember[]> = this._onMembersChanged.event;
	private readonly _onPresenceChanged = this._register(new Emitter<void>());
	/** Fires when who is in the room right now changes (isOnline). */
	readonly onPresenceChanged: Event<void> = this._onPresenceChanged.event;

	private readonly _onRoomState = this._register(new Emitter<{ files: Array<{ id: string; content: string }> }>());
	readonly onRoomState: Event<{ files: Array<{ id: string; content: string }> }> = this._onRoomState.event;

	private readonly _onCursorUpdate = this._register(new Emitter<{ socketId: string; roomId: string; fileId: string; name: string; position: { lineNumber: number; column: number } }>());
	readonly onCursorUpdate: Event<{ socketId: string; roomId: string; fileId: string; name: string; position: { lineNumber: number; column: number } }> = this._onCursorUpdate.event;

	private readonly _onCursorLeave = this._register(new Emitter<{ socketId: string }>());
	readonly onCursorLeave: Event<{ socketId: string }> = this._onCursorLeave.event;

	// Membership and ownership changes the server tells the room about (ROOM_NOTICES in
	// MEMBERS_PANEL_DESIGN.md says who is told what). `by` is the name of whoever did it.
	private readonly _onMemberJoined = this._register(new Emitter<{ name: string }>());
	private readonly _onMemberLeft = this._register(new Emitter<{ name: string }>());
	private readonly _onOwnerChanged = this._register(new Emitter<{ ownerUserId: string; ownerName: string; by: string; byUserId: string }>());
	private readonly _onFolderShared = this._register(new Emitter<{ folderName: string; by: string }>());
	// The owner changed this user's role, and who they are; not fired for a change this user made.
	private readonly _onMyRoleChangedBy = this._register(new Emitter<{ role: string; by: string }>());

	// Carries the roomId that was just left, so listeners can save that
	// room's state before it's gone. Changed from Event<void> 2026-08-14 -
	// confirmed safe, both existing listeners use zero-parameter callbacks.
	private readonly _onRoomLeft = this._register(new Emitter<string>());
	readonly onRoomLeft: Event<string> = this._onRoomLeft.event;
	// Fires when a room join succeeds, carrying the room ID, so listeners
	// (livecollabFolderContribution.ts) can restore any saved state for
	// THIS specific room. See PHASE2_OVERLAY_DESIGN.md section 6.
	private readonly _onRoomJoined = this._register(new Emitter<string>());
	readonly onRoomJoined: Event<string> = this._onRoomJoined.event;
	// Fires whenever this user's role in the current room changes: set by the
	// join ack, changed by the owner (`room:role:changed`, or this user's row
	// in a `room:members` broadcast), or cleared when the room session ends.
	// Gates that depend on the role re-evaluate here rather than once at join.
	private readonly _onDidChangeMyRole = this._register(new Emitter<{ previous: string | undefined; role: string | undefined }>());
	readonly onDidChangeMyRole: Event<{ previous: string | undefined; role: string | undefined }> = this._onDidChangeMyRole.event;
	// In-memory, per-room saved state for Scenario 1 (same-session room
	// switching). Keyed by roomId. Intentionally NOT persisted to disk -
	// lost on app quit, which is correct, documented behavior (Scenario 2,
	// cross-session persistence, is explicitly out of scope for Stage 2).
	private readonly _roomStates = new Map<string, RoomState>();
	// Every piece of room-session state, from every owner (IRoomStateOwner).
	private readonly _roomStateOwners = new Set<IRoomStateOwner>();
	// The room session that ended last, for IRoomStateOwner.inspect.
	private _lastLeftRoomId: string | undefined;
	// Phase 3 (PHASE3_YJS_DESIGN.md): one Y.Doc per file, matching the
	// existing per-file pattern already used by _fileCache. Created lazily,
	// the update->emit listener is registered ONCE here at creation time
	// (not per editor-contribution-instance) so multiple editors/panes on
	// the same file never cause duplicate emits.
	private readonly _yjsDocs = new Map<string, YDoc>();
	// PHASE4: seed states received via room:snapshot, keyed by fileId, plus the
	// remote updates that arrived for files with no live doc. A doc is created
	// from its seed state (guest) so opening a file is local and current.
	private readonly _fileStates = new LiveCollabFileStates(fileId => this._yjsDocs.get(fileId));
	// Real race guard (PHASE3_YJS_DESIGN.md section 30 follow-up):
	// getOrCreateYjsDoc() now does real, awaited network work (requesting
	// state from the server), and _setupYjsBinding() is called twice in
	// practice for a brand-new file (constructor + onDidChangeModel,
	// confirmed via real logs earlier this session) - without this,
	// two concurrent calls for the same fileId could each create their
	// own separate doc before either finishes, and the second would
	// silently overwrite the first in _yjsDocs, leaving an already-bound
	// MonacoBinding attached to an orphaned document.
	private readonly _yjsDocsLoading = new Map<string, Promise<YDoc>>();
	// PHASE3_YJS_DESIGN.md section 7 follow-up: real race found via a
	// second live test - the synchronous seed in getOrCreateYjsDoc only
	// catches content that's ALREADY in the model at binding time. If real
	// content arrives slightly AFTER binding (a genuine race, confirmed by
	// the observed symptom: file empty until the NEXT edit, which matches
	// content only ever arriving via code:change, not any working initial-
	// load path), the doc stays empty until something re-seeds it. Tracks
	// which fileIds have been seeded with real content, so trySeedYjsDoc
	// below gets a second (and third) chance without ever re-seeding once
	// real content has genuinely landed.
	private readonly _yjsDocsSeeded = new Set<string>();
	/**
	 * Files the room refused changes to because it had no document for them
	 * (yjs:not-ready, or a sync answered no_doc), and whether they have been
	 * checked again since. The changes stay in the local doc; the next
	 * snapshot (or SYNC_RETRY_MS) checks again, and a second refusal is
	 * announced (onSyncFailed).
	 */
	private readonly _syncWaiting = new Map<string, { retried: boolean; reason: RoomRefusal }>();
	private _syncRetryTimer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * Files whose room document shares no history with this window's (it was
	 * rebuilt from the owner's disk): never merged with it and never sent to
	 * it, which would duplicate the text, until this room session ends.
	 */
	private readonly _divergedDocs = new Set<string>();
	/**
	 * This window's changes to a file that the room can't take, so they are
	 * only here: still refused after a retry, because the room has no document
	 * for it ('no_doc'), couldn't save them ('not_saved') or this member may no
	 * longer edit it ('read_only'), or its document
	 * was rebuilt from the owner's disk and shares no history with this one
	 * ('rebuilt'; merging would duplicate the text).
	 */
	private readonly _onSyncFailed = this._register(new Emitter<{ fileId: string; path: string | undefined; reason: RoomRefusal | 'rebuilt' }>());
	readonly onSyncFailed: Event<{ fileId: string; path: string | undefined; reason: RoomRefusal | 'rebuilt' }> = this._onSyncFailed.event;
	readonly onMemberJoined: Event<{ name: string }> = this._onMemberJoined.event;
	readonly onMemberLeft: Event<{ name: string }> = this._onMemberLeft.event;
	readonly onOwnerChanged: Event<{ ownerUserId: string; ownerName: string; by: string; byUserId: string }> = this._onOwnerChanged.event;
	readonly onFolderShared: Event<{ folderName: string; by: string }> = this._onFolderShared.event;
	readonly onMyRoleChangedBy: Event<{ role: string; by: string }> = this._onMyRoleChangedBy.event;

	/**
	 * @param _serverUrl the LiveCollab server. By default the main process's,
	 * which is production unless a dev build names another (liveCollabEndpoints).
	 * @param _clientVersion the version the handshake reports; product.json's by default.
	 * @param _openSocket opens the room socket; the vendored socket.io client
	 * by default. Both are parameters so the layer B harness can run two or
	 * three real clients in one process against a local server.
	 * @param _ipc this window's messages to the main process, for the dashboard
	 * (preload's ipcRenderer by default; a recorder in the layer B harness).
	 */
	constructor(
		private _serverUrl: string | undefined = undefined,
		private readonly _openSocket: LiveCollabSocketFactory = openVendorSocket,
		private readonly _clientVersion: string | undefined = product.livecollabVersion,
		private readonly _ipc: IWorkbenchIpcRenderer | undefined = workbenchIpc(),
	) {
		super();
		// The room's chat log (CHAT_DESIGN.md), emptied with the room session.
		this.chat = this._register(new LiveCollabRoomChat(this));
		this._register(this.registerRoomState({
			name: 'chat',
			clear: () => this.chat.clear(),
			inspect: () => this.chat.inspect(),
		}));
		// The room session's documents, with their seed states and caches.
		this._register(this.registerRoomState({
			name: 'Yjs documents',
			clear: () => {
				for (const doc of this._yjsDocs.values()) { doc.destroy(); }
				this._yjsDocs.clear();
				this._yjsDocsSeeded.clear();
				// In-flight loads are already invalidated by the epoch bump; dropping
				// the entries stops a new session from awaiting an old session's load.
				this._yjsDocsLoading.clear();
				this._fileStates.clear();
				this._fileCache.clear();
				this._syncWaiting.clear();
				this._divergedDocs.clear();
				if (this._syncRetryTimer) { clearTimeout(this._syncRetryTimer); this._syncRetryTimer = undefined; }
			},
			inspect: () => {
				const held = this._fileStates.describe();
				if (this._yjsDocs.size) { held.push(`${this._yjsDocs.size} docs (${[...this._yjsDocs.keys()].slice(0, 5).join(', ')})`); }
				if (this._yjsDocsLoading.size) { held.push(`${this._yjsDocsLoading.size} loads in flight`); }
				if (this._yjsDocsSeeded.size) { held.push(`${this._yjsDocsSeeded.size} seeded marks`); }
				if (this._fileCache.size) { held.push(`${this._fileCache.size} cached files`); }
				return held;
			},
		}));
	}

	// PHASE4 replicate-on-join: a single snapshot event carries the whole
	// room in one shot - tree structure plus a seeded Y.Doc state for every
	// file - so opening a file needs no further network call.
	private readonly _onSnapshot = this._register(new Emitter<ILiveCollabSnapshot>());
	readonly onSnapshot: Event<ILiveCollabSnapshot> = this._onSnapshot.event;

	// PHASE4 file lifecycle (section 4b). Incoming server broadcasts, applied by
	// the folder contribution: created materializes the file + registers its id;
	// renamed re-keys the id to the new path (same doc); deleted removes the
	// file, destroys the doc, and closes the editor without saving.
	private readonly _onFileCreated = this._register(new Emitter<{ fileId: string; path: string }>());
	readonly onFileCreated: Event<{ fileId: string; path: string }> = this._onFileCreated.event;
	private readonly _onFileRenamed = this._register(new Emitter<{ fileId: string; oldPath: string; newPath: string; type: 'file' | 'directory'; correction: boolean }>());
	readonly onFileRenamed: Event<{ fileId: string; oldPath: string; newPath: string; type: 'file' | 'directory'; correction: boolean }> = this._onFileRenamed.event;
	// The server refused a create, rename or delete this window sent (its ack
	// said ok: false), so the member who made it can be told.
	private readonly _onFileOperationRefused = this._register(new Emitter<{ operation: 'create' | 'rename' | 'delete'; path: string; newPath?: string; error: string }>());
	readonly onFileOperationRefused: Event<{ operation: 'create' | 'rename' | 'delete'; path: string; newPath?: string; error: string }> = this._onFileOperationRefused.event;
	// A file's room text changed, by anyone: a local edit or one from the room.
	// The room persister writes it to the owner's disk.
	private readonly _onRoomTextChanged = this._register(new Emitter<string>());
	readonly onRoomTextChanged: Event<string> = this._onRoomTextChanged.event;
	/** The owner's reconcile summary, heard by everyone else in the room (one notice, not one per change). */
	private readonly _onRoomReconciled = this._register(new Emitter<IRoomReconciledSummary & { readonly by: string }>());
	readonly onRoomReconciled: Event<IRoomReconciledSummary & { readonly by: string }> = this._onRoomReconciled.event;
	private readonly _onFileDeleted = this._register(new Emitter<{ files: Array<{ fileId: string; path: string }> }>());
	readonly onFileDeleted: Event<{ files: Array<{ fileId: string; path: string }> }> = this._onFileDeleted.event;

	// Fires when this client's MEMBERSHIP of a room ends (left, kicked, room
	// ended) — distinct from onRoomLeft, which fires on every room-session
	// exit including a switch or a return to the dashboard. The contribution
	// notifies and navigates to the dashboard.
	// `by`: who removed this user, when they were removed.
	private readonly _onRoomTerminated = this._register(new Emitter<{ roomId: string; roomName: string | undefined; reason: RoomTerminationReason; by?: string }>());
	readonly onRoomTerminated: Event<{ roomId: string; roomName: string | undefined; reason: RoomTerminationReason; by?: string }> = this._onRoomTerminated.event;

	// Room-session epoch (LIVECOLLAB_BEHAVIORAL_SPEC.md, "Room-session
	// invariant"). Incremented on EVERY room-session entry and exit. Any async
	// operation that can mutate room-scoped state captures it before its first
	// await and must see it unchanged (isCurrentRoomSession) before committing
	// its result; otherwise the result belongs to a session that no longer
	// exists and is dropped. Clearing maps on teardown cannot stop a write that
	// is already in flight — this check does.
	private _roomEpoch = 0;
	/** Counts socket connections; a reconnect is a new one, whose room membership the server hasn't confirmed yet. */
	private _connection = 0;
	/** The connection and room session whose join the server has acked: until then it refuses room messages from this socket. */
	private _joinConfirmed: { readonly connection: number; readonly epoch: number } | undefined;
	private readonly _onJoinConfirmed = this._register(new Emitter<void>());
	/** The room's tree from the last snapshot, with the connection and room session it arrived on. */
	private _roomTree: { readonly connection: number; readonly epoch: number; readonly tree: ILiveCollabTreeItem[] } | undefined;
	private readonly _onRoomTreeRecorded = this._register(new Emitter<void>());
	get roomEpoch(): number { return this._roomEpoch; }
	isCurrentRoomSession(epoch: number): boolean { return epoch === this._roomEpoch; }

	get isConnected(): boolean { return this.socket?.connected ?? false; }
	get roomId(): string | undefined { return this._roomId; }
	get roomName(): string | undefined { return this._roomName; }
	private _leftRoom: { readonly roomId: string; readonly roomName: string | undefined } | undefined;
	/** The name `roomId` had, if it is the room session that ended last. */
	leftRoomName(roomId: string): string | undefined { return this._leftRoom?.roomId === roomId ? this._leftRoom.roomName : undefined; }
	get myUserId(): string { return this._myUserId; }
	private _myRole: string | undefined;
	get myRole(): string | undefined { return this._myRole; }
	private _setMyRole(role: string | undefined): void {
		if (role === this._myRole) { return; }
		const previous = this._myRole;
		this._myRole = role;
		lcLog.info('[LiveCollab] my role:', previous ?? '(none)', '->', role ?? '(none)');
		this._onDidChangeMyRole.fire({ previous, role });
	}
	get token(): string | undefined { return this._token; }
	get lastMembers(): ILiveCollabMember[] { return this._lastMembers; }

	/** Whether `userId` is in the room right now: the server's presence, and this user while connected. */
	isOnline(userId: string): boolean {
		return this._online.has(userId) || (userId === this._myUserId && !!this.socket?.connected && !!this._roomId);
	}

	/**
	 * The name a member is shown by, the same in the chat, the @ list and the
	 * members panel: the name the room has for them; else `stored` (the name a
	 * chat entry was written with); else the name of their latest entry in the
	 * chat log, which every member has from the invite they accepted; else
	 * "Member". Never the email, and never nothing.
	 */
	memberName(userId: string, stored?: string): string {
		const member = this._lastMembers.find(m => m.userId === userId);
		return member?.displayName || member?.name || stored || this.chat.messages.findLast(m => m.authorId === userId)?.authorName
			|| localize('livecollab.members.unnamed', "Member");
	}

	setToken(token: string): void {
		this._token = token;
		try {
			const parts = token.split('.');
			if (parts.length === 3) {
				const payload = JSON.parse(atob(parts[1]));
				if (payload.sub) { this._myUserId = payload.sub; }
			}
		} catch { }
	}

	hasToken(): boolean { return !!this._token; }

	// Re-mint a fresh Clerk session JWT from the device credential main holds (option F).
	// Called on every socket (re)connect so the token is never stale. (#12)
	async refreshToken(): Promise<string | undefined> {
		try {
			const ipc = workbenchIpc();
			if (!ipc) { return this._token; }
			// Real fix (2026-09-02, PHASE3_YJS_DESIGN.md section 27): the
			// same caller-mismatch bug already fixed for the dashboard's
			// lcMintToken() this session, found here in a third, separate
			// caller. vscode:livecollab-mint-token returns { jwt, error,
			// serverResponse }, not a raw string - this was still treating
			// the whole object as the token itself, sending an invalid,
			// non-string auth value to the socket on every reconnect and
			// refresh, confirmed live via the real "token.split is not a
			// function" server-side error. Extract the real jwt field.
			const result = await ipc.invoke('vscode:livecollab-mint-token') as { jwt: string | null; error?: string } | null;
			if (result && result.jwt) { this._token = result.jwt; return result.jwt; }
			if (result && result.error) { lcLog.info('[LiveCollab] workbench refreshToken mint failed:', result.error); }
			return this._token;
		} catch { return this._token; }
	}
	/**
	 * The server to connect to: the one this service was given, else the one the
	 * main process signs in with, else production when it can't be asked.
	 */
	private async _server(): Promise<string> {
		if (this._serverUrl === undefined) {
			try {
				const answer = await workbenchIpc()?.invoke('vscode:livecollab-server-url');
				if (typeof answer === 'string' && answer) {
					this._serverUrl = answer;
				}
			} catch {
				// Not answered: production, asked again next time.
			}
		}
		return this._serverUrl ?? LIVECOLLAB_PRODUCTION_ENDPOINTS.server;
	}
	async connect(): Promise<void> {
		if (!this._token) { return; }
		if (this.socket?.connected) { return; }
		if (this._connecting) { return; }
		this._connecting = true;
		if (this.socket) { this.socket.disconnect(); this.socket = null; }
		let socket: ILiveCollabSocket;
		try {
			socket = await this._openSocket(await this._server(), {
				auth: async (cb: (data: ILiveCollabHandshake) => void) => {
					const fresh = await this.refreshToken();
					cb({ token: fresh || this._token || '', clientVersion: this._clientVersion });
				},
				transports: ['websocket'],
				reconnection: true,
			});
		} catch (error) {
			// Not opened (its socket library didn't load, say): this attempt is over, so the next
			// one can start. Left set, every later connect() returned at once and the window
			// couldn't join any room until it reloaded (walkthrough, 2026-11-14).
			this._connecting = false;
			lcLog.error('[LiveCollab] the room connection couldn\'t be opened:', error instanceof Error ? error.message : String(error));
			throw error;
		}
		this.socket = socket;
		socket.on('connect', () => {
			this._connecting = false;
			this._connection++;
			// The display name itself is personal data: log only whether it is still the default.
			lcLog.info('[LiveCollab] socket connected, user:', this._displayName === 'User' ? 'User (default name)' : '(named)');
			// Proactive refresh: real, 60s-confirmed token lifetime, refresh
			// at 45s to leave a genuine safety margin. Cleared/restarted here
			// (not just on first connect) so a reconnect always gets a fresh
			// timer too, never two overlapping ones.
			if (this._tokenRefreshTimer) { mainWindow.clearInterval(this._tokenRefreshTimer); }
			this._tokenRefreshTimer = mainWindow.setInterval(() => { this.refreshToken(); }, 45000);
			// If we were already in a room, this is a RECONNECT: re-join so the server
			// re-subscribes this socket to the room. room:join only fired on first connect
			// before, so after a reconnect the socket was live but not in any room. (#19)
			if (this._roomId) {
				const rid = this._roomId;
				const roomName = this._roomName;
				const epoch = this._roomEpoch; // a reconnect is NOT a new room session
				lcLog.info('[LiveCollab] reconnected — re-joining room:', rid);
				this.socket!.emit('room:join', { roomId: rid, displayName: this._displayName, colorIndex: 0 }, (res: IRoomJoinAck | undefined) => {
					if (!this.isCurrentRoomSession(epoch)) { lcLog.info('[LiveCollab] stale re-join ack for', rid, '— room session changed, dropped'); return; }
					// The room ended or our access was removed while we were
					// offline: the membership is over, tear it down.
					if (res?.error === 'room_missing' || res?.error === 'no_access') {
						lcLog.warn('[LiveCollab] re-join refused:', res.error, '— ending membership of', rid);
						this._endRoomMembership(rid, roomName, res.error === 'room_missing' ? 'ended' : 'kicked');
						return;
					}
					if (res?.userId) { this._myUserId = res.userId; }
					if (res?.role) { this._setMyRole(res.role); } // keep ownership authoritative across reconnects
					else if (res?.ok) { lcLog.error('🔴 [PHASE4 R2] re-joined room', rid, '— no role in ack; real-disk mirroring DISABLED (owner treated as guest)'); }
					lcLog.info('[LiveCollab] re-join ack:', res && res.ok);
					if (res?.ok) {
						this._confirmJoin(epoch);
						void this._syncLiveDocs(rid, epoch, [...this._yjsDocs.keys()]);
						// Whatever was said while offline: the newest page again, no gap.
						void this.chat.load();
					}
				});
			}
			this._onConnected.fire();
		});
		socket.on('connect_error', (err: Error | undefined) => {
			this._connecting = false;
			lcLog.warn('[LiveCollab] socket connect_error:', err && err.message);
		});
		socket.on('disconnect', (reason: string) => {
			this._connecting = false;
			lcLog.info('[LiveCollab] socket disconnected, reason:', reason);
			if (this._tokenRefreshTimer) { mainWindow.clearInterval(this._tokenRefreshTimer); this._tokenRefreshTimer = undefined; }
			for (const unanswered of [...this._chatWaiting]) { unanswered(); }
			// Disconnected, this window can't know who is in the room: nobody is shown there.
			this._online = new Set();
			this._onPresenceChanged.fire();
			this._onDisconnected.fire();
		});
		socket.on('room:presence', ({ roomId, users }: { roomId?: string; users?: Array<{ userId?: string }> }) => {
			if (!this._isForCurrentRoom('room:presence', roomId)) { return; }
			this._online = new Set((users ?? []).flatMap(user => user.userId ? [user.userId] : []));
			lcLog.info('[LiveCollab] room:presence received:', this._online.size, 'in the room');
			this._onPresenceChanged.fire();
		});
		socket.on('room:members', ({ members }: { members: ILiveCollabMember[] }) => {
			lcLog.info('[LiveCollab] room:members received:', members.length);
			this._lastMembers = members;
			// The broadcast carries this user's role from the server's member
			// rows; a transfer sends it before `room:role:changed`.
			const mine = this._roomId ? members.find(m => m.userId === this._myUserId) : undefined;
			if (mine?.role) { this._setMyRole(mine.role); }
			this._onMembersChanged.fire(members);
		});
		// The owner changed this user's role (role set, request approved, or a
		// transfer). Acted on at once; nothing waits for a reconnect.
		socket.on('room:role:changed', ({ roomId, role, by, byUserId }: { roomId?: string; role?: string; by?: string; byUserId?: string }) => {
			if (!roomId || roomId !== this._roomId || !role) { return; }
			this._setMyRole(role);
			if (byUserId !== this._myUserId) {
				this._onMyRoleChangedBy.fire({ role, by: by || '' });
			}
		});
		socket.on('room:owner:changed', (payload: { roomId?: string; ownerUserId?: string; ownerName?: string; by?: string; byUserId?: string }) => {
			if (!this._isForCurrentRoom('room:owner:changed', payload?.roomId)) { return; }
			this._onOwnerChanged.fire({ ownerUserId: payload.ownerUserId || '', ownerName: payload.ownerName || '', by: payload.by || '', byUserId: payload.byUserId || '' });
		});
		socket.on('room:member:left', (payload: { roomId?: string; name?: string }) => {
			if (!this._isForCurrentRoom('room:member:left', payload?.roomId)) { return; }
			this._onMemberLeft.fire({ name: payload.name || '' });
		});
		for (const event of ['chat:message', 'chat:edited', 'chat:deleted', 'chat:hidden', 'chat:unread']) {
			socket.on(event, (payload: { roomId?: string } & Parameters<LiveCollabRoomChat['receive']>[1]) => {
				if (!this._isForCurrentRoom(event, payload?.roomId)) { return; }
				this.chat.receive(event, payload);
			});
		}
		socket.on('room:folder:shared', (payload: { roomId?: string; folderName?: string; by?: string }) => {
			if (!this._isForCurrentRoom('room:folder:shared', payload?.roomId)) { return; }
			this._onFolderShared.fire({ folderName: payload.folderName || '', by: payload.by || '' });
		});
		// PHASE4: content flows over the Yjs channel only. An incoming update is
		// applied HERE, for every file, whether or not an editor has it open:
		// to the live doc if there is one (an open editor's binding renders
		// it), otherwise held and merged into the file's seed state when the
		// file is next read. Routed by server fileId, never by path. Applied
		// with origin 'remote', so the doc's own listener does not echo it.
		socket.on('yjs:update', (payload: { roomId?: string; fileId: string; update: number[] }) => {
			if (!this._isForCurrentRoom('yjs:update', payload?.roomId)) { return; }
			// A diverged file's room document is another history: its changes can't apply here.
			if (this._divergedDocs.has(payload.fileId)) { return; }
			this._fileStates.receiveRemoteUpdate(this._yjsBundle?.Y, payload.fileId, new Uint8Array(payload.update));
			this._onRoomTextChanged.fire(payload.fileId);
		});
		// The room refused a change this window sent: it has no document for
		// the file (a restarted server before the owner re-attaches). The
		// change stays in the local doc and is sent again (_waitForRoomDoc).
		socket.on('yjs:not-ready', (payload: { roomId?: string; fileId?: string }) => {
			if (!this._isForCurrentRoom('yjs:not-ready', payload?.roomId) || !payload.fileId) { return; }
			lcLog.warn('[LiveCollab] the room has no document for', payload.fileId, 'yet — a change was refused; it is sent again when the room has one');
			this._waitForRoomDoc(payload.fileId, 'no_doc');
		});
		// The room couldn't save a change this window sent, so it applied and
		// relayed none of it. Kept and sent again, the same way.
		socket.on('yjs:not-saved', (payload: { roomId?: string; fileId?: string }) => {
			if (!this._isForCurrentRoom('yjs:not-saved', payload?.roomId) || !payload.fileId) { return; }
			lcLog.warn('[LiveCollab] the room could not save a change to', payload.fileId, '— refused; it is sent again');
			this._waitForRoomDoc(payload.fileId, 'not_saved');
		});
		// The server may send cursor updates to the whole room, the sender
		// included: our own would be drawn as a second, labelled cursor on top
		// of the real caret. (Another window of the same user has its own
		// socket, so it is still shown.)
		socket.on('cursor:update', (payload: ICursorUpdate) => {
			if (payload.socketId === socket.id) { return; }
			this._onCursorUpdate.fire(payload);
		});
		socket.on('cursor:leave', (payload: { socketId: string }) => { this._onCursorLeave.fire(payload); });
		socket.on('room:member:joined', (payload: { roomId?: string; name?: string }) => {
			if (!this._isForCurrentRoom('room:member:joined', payload?.roomId)) { return; }
			this._onMemberJoined.fire({ name: payload.name || '' });
		});
		// PHASE4 replicate-on-join: the whole room arrives in one snapshot -
		// tree + a seeded Y.Doc state per file. Store the states so opening a
		// file seeds locally with no further network call, then fire so the
		// folder contribution can build the virtual filesystem with real
		// content.
		socket.on('room:snapshot', (snap: ILiveCollabSnapshot & { roomId?: string }) => {
			if (!this._isForCurrentRoom('room:snapshot', snap?.roomId)) { return; }
			const resolvedName = snap?.roomName || this._roomName || 'Shared Room';
			lcLog.info('[LiveCollab] snapshot received:', snap?.tree?.length, 'tree items,', snap?.docs?.length, 'docs, folderName:', snap?.folderName);
			this._snapshotReceived = true;
			this._recordRoomTree(snap?.tree);
			if (snap?.roomName) { this._roomName = snap.roomName; }
			this._roomFolder = { hasFolder: Array.isArray(snap?.tree) && snap.tree.length > 0, folderName: snap?.folderName };
			void this._seedThenAnnounce({ tree: snap.tree, roomName: resolvedName, folderName: snap.folderName, docs: snap.docs || [] });
		});
		// PHASE4 file lifecycle (section 4b): store the new file's seeded state
		// so getOrCreateYjsDoc can seed it locally, then let the folder
		// contribution materialize the file and register its id.
		socket.on('room:file:created', ({ roomId, fileId, path, state }: { roomId?: string; fileId: string; path: string; state: number[] }) => {
			if (!this._isForCurrentRoom('room:file:created', roomId)) { return; }
			lcLog.info('[LiveCollab] room:file:created', path, fileId);
			if (Array.isArray(state)) { this._fileStates.setSeedState(fileId, new Uint8Array(state)); }
			this._onFileCreated.fire({ fileId, path });
		});
		socket.on('room:file:renamed', (payload: { roomId?: string; fileId: string; oldPath: string; newPath: string; type: 'file' | 'directory'; correction?: boolean }) => {
			if (!this._isForCurrentRoom('room:file:renamed', payload?.roomId)) { return; }
			lcLog.info('[LiveCollab] room:file:renamed', payload.oldPath, '->', payload.newPath, payload.fileId, payload.correction ? '(a correction)' : '');
			// `correction`: the owner sent a refused move back. Relayed by servers
			// from 2026-10-29's batch on; older servers drop it (false).
			this._onFileRenamed.fire({ fileId: payload.fileId, oldPath: payload.oldPath, newPath: payload.newPath, type: payload.type, correction: payload.correction === true });
		});
		socket.on('room:reconciled', (payload: IRoomReconciledSummary & { roomId?: string; by?: string }) => {
			if (!this._isForCurrentRoom('room:reconciled', payload?.roomId)) { return; }
			lcLog.info('[LiveCollab] room:reconciled from', payload.by ?? '(unnamed)', `— ${payload.renamedCount} renamed, ${payload.deletedCount} deleted`);
			this._onRoomReconciled.fire({ by: payload.by ?? '', renamed: payload.renamed ?? [], deleted: payload.deleted ?? [], renamedCount: payload.renamedCount ?? 0, deletedCount: payload.deletedCount ?? 0 });
		});
		socket.on('room:file:deleted', ({ roomId, files }: { roomId?: string; files: Array<{ fileId: string; path: string }> }) => {
			if (!this._isForCurrentRoom('room:file:deleted', roomId)) { return; }
			lcLog.info('[LiveCollab] room:file:deleted', files?.map((f) => f.path));
			this._onFileDeleted.fire({ files: files || [] });
		});
		// Membership ended by the server. Kicked: only this user's sockets get
		// it. Ended: everyone in the room gets it, just before the server
		// detaches them.
		socket.on('room:kicked', ({ roomId, roomName, reason, by }: { roomId: string; roomName?: string; reason?: string; by?: string }) => {
			lcLog.warn('[LiveCollab] room:kicked', roomId, reason);
			this._endRoomMembership(roomId, roomName ?? (roomId === this._roomId ? this._roomName : undefined), reason === 'left' ? 'leftElsewhere' : 'kicked', by);
		});
		socket.on('room:ended', ({ roomId, roomName }: { roomId: string; roomName?: string; reason?: string }) => {
			lcLog.warn('[LiveCollab] room:ended', roomId);
			this._endRoomMembership(roomId, roomName ?? (roomId === this._roomId ? this._roomName : undefined), 'ended');
		});
		socket.on('room:state', (state: { files: Array<{ id: string; content: string }> } | undefined) => {
			if (state?.files) {
				for (const f of state.files) { this._fileCache.set(f.id, f.content || ''); }
				this._onRoomState.fire(state);
			}
		});
	}


	// THE ONLY WAY INTO A ROOM, and together with _teardownRoomSession the only
	// code that assigns _roomId. It always begins by ending the current room
	// session (if any, including the same room), so a new room can never start
	// on top of the previous room's state. Every entry path — dashboard IPC,
	// invite code, anything added later — must come through here.
	async joinExistingRoom(roomId: string, roomName?: string): Promise<void> {
		if (!this.socket?.connected) { return; }
		if (this._roomId) {
			lcLog.info('[LiveCollab] entering', roomId, '— ending current room session', this._roomId, 'first');
			this._exitRoomSession(`switching to room ${roomId}`);
		}
		this._checkRoomStateClean(roomId);
		this._roomId = roomId;
		if (roomName) { this._roomName = roomName; }
		const epoch = ++this._roomEpoch;
		return new Promise((resolve) => {
			lcLog.info('[LiveCollab] room:join sent for', roomId);
			this.socket!.emit('room:join', { roomId, displayName: this._displayName, colorIndex: 0 }, (res: IRoomJoinAck | undefined) => {
				if (!this.isCurrentRoomSession(epoch)) { lcLog.info('[LiveCollab] stale join ack for', roomId, ', now in', this._roomId ?? '(no room)', '— dropped'); resolve(); return; }
				if (!res?.ok) {
					// The server never put us in the room: don't pretend we're in it.
					lcLog.warn('[LiveCollab] join refused for', roomId, ':', res?.error);
					// Not a member (left, or removed) or the room is gone: end it the
					// way the reconnect path does — say why and go back to the
					// dashboard. Before, only the local teardown ran, leaving an
					// empty room showing just its name (2026-10-23).
					if (res?.error === 'room_missing' || res?.error === 'no_access') {
						this._endRoomMembership(roomId, roomName, res.error === 'room_missing' ? 'ended' : 'notMember');
					} else {
						this._teardownRoomSession(`join refused: ${res?.error ?? 'no answer'}`);
					}
					resolve();
					return;
				}
				if (res?.userId) { this._myUserId = res.userId; }
				// PHASE4: store the server-authoritative role so ownership gates
				// (e.g. "may this client write the real folder on disk?") are
				// reliable — a guest must NEVER hit a real-disk path (R2).
				if (res?.role) { this._setMyRole(res.role); }
				else if (res?.ok) { lcLog.error('🔴 [PHASE4 R2] joined room', roomId, '— no role in join ack; real-disk mirroring DISABLED (owner treated as guest)'); }
				// PHASE4 identity fix: adopt the server-authoritative display
				// name/email from the join ack instead of parsing our own JWT
				// (which lacks an email claim, making everyone show as "User").
				// Never the email in its place: it would be on everyone else's screen (option F scope).
				if (res?.displayName) { this._displayName = res.displayName; }
				// Arm the snapshot fallback for guests only. The owner is the
				// content's own source and attaches it; it should never pull a
				// snapshot over its real file:// folders. res.role comes from the
				// join ack. (The server also pushes a snapshot proactively on
				// join if the host has already attached - this only covers the
				// case where it hadn't yet.)
				if (res?.role && res.role !== 'owner') {
					this._snapshotReceived = false;
					this._scheduleSnapshotFallback();
				}
				// Fire onRoomJoined so listeners (livecollabFolderContribution.ts)
				// can restore any Scenario 1 saved state for THIS room. See
				// PHASE2_OVERLAY_DESIGN.md section 6.
				this._confirmJoin(epoch);
				this._onRoomJoined.fire(roomId);
				void this.chat.load();
				resolve();
			});
		});
	}


	// PHASE4: fallback for a guest whose proactive join-snapshot didn't land
	// (e.g. it joined before the host had attached). After a short delay, if
	// no snapshot has arrived, pull the server's current one on demand and
	// feed it through the SAME _onSnapshot pipeline the push uses.
	private _scheduleSnapshotFallback(): void {
		if (this._treeFallbackTimer) { clearTimeout(this._treeFallbackTimer); }
		this._treeFallbackTimer = setTimeout(() => {
			this._treeFallbackTimer = undefined;
			if (this._snapshotReceived) { return; }
			if (!this.socket?.connected || !this._roomId) { return; }
			lcLog.info('[LiveCollab] snapshot not received after join — requesting it');
			const epoch = this._roomEpoch;
			this.socket.emit('room:request-snapshot', { roomId: this._roomId }, (ack: { ok: boolean; tree?: ILiveCollabTreeItem[]; roomName?: string; folderName?: string; docs?: Array<{ fileId: string; state: number[] }> }) => {
				if (!this.isCurrentRoomSession(epoch)) { lcLog.info('[LiveCollab] stale request-snapshot ack — room session changed, dropped'); return; }
				if (this._snapshotReceived) { return; }
				if (!ack?.ok || !Array.isArray(ack.tree)) {
					lcLog.info('[LiveCollab] room:request-snapshot returned nothing');
					return;
				}
				const resolvedName = ack.roomName || this._roomName || 'Shared Room';
				lcLog.info('[LiveCollab] snapshot received via fallback:', ack.tree.length, 'tree items,', ack.docs?.length, 'docs');
				this._snapshotReceived = true;
				this._recordRoomTree(ack.tree);
				if (ack.roomName) { this._roomName = ack.roomName; }
				this._roomFolder = { hasFolder: ack.tree.length > 0, folderName: ack.folderName };
				const snap: ILiveCollabSnapshot = { tree: ack.tree, roomName: resolvedName, folderName: ack.folderName, docs: ack.docs || [] };
				void this._seedThenAnnounce(snap);
			});
		}, 1500);
	}

	/**
	 * Seeds the room's docs from a snapshot, then tells the listeners. In that order, so an editor
	 * retrying its bind on the snapshot finds its doc seeded: firing first let the retry run before
	 * the seeding, find the doc unseeded, and leave the editor unbound with nothing to retry it
	 * (TEST_HARNESS_TRIAGE.md, "Never-bind"). The event fires whether or not the seeding worked:
	 * the file tree fills from it too, and a failed seed must not cost the tree. The failure is
	 * logged; an editor whose doc it left unseeded is caught by the editor's sync-check retry.
	 */
	private async _seedThenAnnounce(snap: ILiveCollabSnapshot): Promise<void> {
		const epoch = this._roomEpoch;
		try {
			await this._applySnapshot(snap);
		} catch (e) {
			lcLog.error('[LiveCollab] seeding from the snapshot failed; the snapshot is announced anyway:', e);
		}
		if (!this.isCurrentRoomSession(epoch)) {
			lcLog.info('[LiveCollab] stale snapshot — room session changed while seeding, not announced');
			return;
		}
		this._onSnapshot.fire(snap);
		this._retryWaitingDocs();
	}

	// PHASE4: record every doc's seed state, and if a file was opened before
	// its snapshot arrived (a race), seed that already-created live doc now
	// so it stops being empty. Marks the doc seeded (R1 bind gate).
	// A live doc that is already seeded gets the server's state merged in:
	// after a reconnect that is how the edits relayed while this side was
	// offline arrive (alongside _syncLiveDocs, which sends this
	// side's own up). A Yjs merge never overwrites and ignores what the doc
	// already has; origin 'remote' keeps it from being sent back.
	private async _applySnapshot(snap: ILiveCollabSnapshot): Promise<void> {
		const docs = snap?.docs || [];
		if (docs.length === 0) { return; }
		const epoch = this._roomEpoch;
		let Y: typeof import('yjs') | undefined;
		let merged = 0;
		// Every state is recorded before any doc is seeded, so a seed that fails can't leave a later
		// file without the content the file tree and later opens read from these states.
		for (const d of docs) {
			this._fileStates.setSeedState(d.fileId, new Uint8Array(d.state));
		}
		for (const d of docs) {
			const existing = this._yjsDocs.get(d.fileId);
			if (!existing) { continue; }
			if (!Y) {
				Y = await this.getYjsModule();
				if (!this.isCurrentRoomSession(epoch)) { lcLog.info('[LiveCollab] stale _applySnapshot — room session changed, dropped'); return; }
			}
			if (this._yjsDocsSeeded.has(d.fileId)) {
				if (this._divergedDocs.has(d.fileId) || !this._sharesHistory(Y, existing, d.fileId, Y.encodeStateVectorFromUpdate(new Uint8Array(d.state)))) { continue; }
				Y.applyUpdate(existing, new Uint8Array(d.state), 'remote');
				merged++;
				continue;
			}
			const seed = this._fileStates.readSeedState(Y, d.fileId);
			if (seed) { Y.applyUpdate(existing, seed, 'remote'); }
			this._yjsDocsSeeded.add(d.fileId);
		}
		if (merged) { lcLog.info(`[LiveCollab] snapshot merged into ${merged} open files`); }
	}

	// ===== LiveCollab Dashboard verbs (Phase D week 1) =====
	async listMyRooms(): Promise<unknown[]> {
		if (!this.socket?.connected) { return []; }
		return new Promise((resolve) => {
			this.socket!.emit('rooms:list', {}, (res: { rooms?: unknown[] } | undefined) => {
				resolve(Array.isArray(res?.rooms) ? res.rooms : []);
			});
		});
	}
	/**
	 * What the server says this account is in `roomId`: its role, 'missing' (deleted or never
	 * existed), or 'noAccess' (not a member). undefined when it can't be told: offline, no answer
	 * in 5 seconds, or any other error. Only an answer proves a room gone; a failure never does.
	 */
	async roomAccess(roomId: string): Promise<'owner' | 'editor' | 'viewer' | 'missing' | 'noAccess' | undefined> {
		if (!this.socket?.connected) { return undefined; }
		const ack = await new Promise<{ ok?: boolean; error?: string; members?: ILiveCollabMember[] } | undefined>(resolve => {
			const timer = setTimeout(() => resolve(undefined), 5000);
			this.socket!.emit('room:members:list', { roomId }, (res: { ok?: boolean; error?: string; members?: ILiveCollabMember[] } | undefined) => {
				clearTimeout(timer);
				resolve(res);
			});
		});
		if (ack?.ok === true && Array.isArray(ack.members)) {
			const role = ack.members.find(member => member.userId === this._myUserId)?.role;
			return role === 'owner' || role === 'editor' || role === 'viewer' ? role : undefined;
		}
		if (ack?.error === 'room_missing') { return 'missing'; }
		if (ack?.error === 'no_access') { return 'noAccess'; }
		return undefined;
	}
	async createRoomNamed(name: string): Promise<string | undefined> {
		if (!this.socket?.connected) { return undefined; }
		return new Promise((resolve) => {
			this.socket!.emit('room:create', { name }, (res: { roomId?: string } | undefined) => {
				resolve(res?.roomId);
			});
		});
	}
	async deleteRoom(roomId: string): Promise<boolean> {
		if (!this.socket?.connected) { return false; }
		return new Promise((resolve) => {
			this.socket!.emit('room:delete', { roomId }, (res: { ok?: boolean } | undefined) => {
				resolve(!!res?.ok);
			});
		});
	}
	async fetchMembers(roomId: string): Promise<void> {
		if (!this.socket?.connected) { return; }
		const epoch = this._roomEpoch;
		this.socket.emit('room:members:get', { roomId }, (res: { members?: ILiveCollabMember[] } | undefined) => {
			if (!this.isCurrentRoomSession(epoch) || roomId !== this._roomId) { return; } // stale: another room session now
			if (res && Array.isArray(res.members)) {
				this._lastMembers = res.members;
				this._onMembersChanged.fire(res.members);
			}
		});
	}

	async joinByCode(code: string): Promise<{ ok: boolean; roomId?: string; error?: string }> {
		if (!this.socket?.connected) { return { ok: false, error: 'not_connected' }; }
		return new Promise((resolve) => {
			this.socket!.emit('room:invite:accept', { code }, (res: { ok?: boolean; roomId?: string; error?: string } | undefined) => {
				resolve({ ok: !!res?.ok, roomId: res?.roomId, error: res?.error });
			});
		});
	}

	clearFolder(): void {
		// Only clears file state — room, members, chat stay intact
		this._fileCache.clear();
		this._fileStates.clear();
	}
	getFileContent(fileId: string): string | undefined { return this._fileCache.get(fileId); }
	updateFileCache(fileId: string, code: string): void { this._fileCache.set(fileId, code); }
	// Phase 3 (PHASE3_YJS_DESIGN.md): one Y.Doc per file, created lazily.
	// Registers the outgoing-update listener ONCE here (not in the editor
	// contribution), so multiple editors/panes on the same file never
	// double-emit. origin !== 'remote' means "this change happened locally
	// (either real typing, captured automatically by y-monaco's own
	// MonacoBinding, or another local mechanism) - broadcast it." origin
	// === 'remote' means "this is an update WE just applied from another
	// user - do not re-broadcast it back."
	// Loads yjs+y-monaco from our own vendored bundle (real
	// yjs/y-monaco don't ship UMD - importAMDNodeModule can't load them,
	// confirmed via a live two-machine test failure and full root-cause
	// trace, see PHASE3_YJS_DESIGN.md sections 5-6). Combined into ONE
	// bundle deliberately - two separate bundles would each carry their
	// own independent copy of yjs, a real dual-package-hazard risk.
	// Loaded via plain dynamic import(), matching this project's own
	// already-proven pattern for socket.io.esm.min.js (see connect()
	// below - same directory, same technique). Cached after first load.
	private _yjsBundle: { Y: typeof import('yjs'); MonacoBinding: typeof import('y-monaco').MonacoBinding } | undefined;
	private async _loadYjsBundle(): Promise<{ Y: typeof import('yjs'); MonacoBinding: typeof import('y-monaco').MonacoBinding }> {
		if (!this._yjsBundle) {
			// @ts-ignore
			const loaded = await import('./vendor/livecollab-yjs.esm.min.js') as unknown as { Y: typeof import('yjs'); MonacoBinding: typeof import('y-monaco').MonacoBinding };
			this._yjsBundle = loaded;
			return loaded;
		}
		return this._yjsBundle;
	}
	// PUBLIC so livecollabEditorContribution.ts can reuse the SAME loaded
	// bundle rather than loading its own separate copy.
	async getYjsModule(): Promise<typeof import('yjs')> {
		return (await this._loadYjsBundle()).Y;
	}
	async getMonacoBindingClass(): Promise<typeof import('y-monaco').MonacoBinding> {
		return (await this._loadYjsBundle()).MonacoBinding;
	}
	// PHASE4 replicate-on-join: a file's doc is seeded ONLY from the server's
	// authoritative Yjs state (the snapshot the server sent every member,
	// host included). Seeding from a state - never from raw text insertion -
	// is what keeps the host's own doc mergeable with the server: applying a
	// remote update to an as-yet-unseeded doc and later applying the full
	// snapshot state merges idempotently (Yjs CRDT), whereas a text insert
	// with a fresh client id would duplicate. If no snapshot state is known
	// yet (a file opened before its snapshot landed), the doc is created
	// UNSEEDED; isSeeded() stays false so the editor's bind gate refuses to
	// attach it to a real file:// model (R1), and _applySnapshot seeds it the
	// moment the snapshot arrives.
	async getOrCreateYjsDoc(fileId: string): Promise<YDoc> {
		const existing = this._yjsDocs.get(fileId);
		if (existing) { return existing; }
		const alreadyLoading = this._yjsDocsLoading.get(fileId);
		if (alreadyLoading) { return alreadyLoading; }
		const loadPromise = this._loadYjsDoc(fileId);
		this._yjsDocsLoading.set(fileId, loadPromise);
		try {
			return await loadPromise;
		} finally {
			// Only remove OUR entry: after a room switch the map may already
			// hold a newer session's load for the same fileId.
			if (this._yjsDocsLoading.get(fileId) === loadPromise) { this._yjsDocsLoading.delete(fileId); }
		}
	}
	// True once fileId's doc holds real, seeded content. The editor's R1
	// bind gate consults this before binding a real file:// model.
	isSeeded(fileId: string): boolean {
		return this._yjsDocsSeeded.has(fileId);
	}
	// Whether fileId has a live doc in this room session (an editor has, or
	// had, the file open).
	hasLiveDoc(fileId: string): boolean {
		return this._yjsDocs.has(fileId);
	}

	/**
	 * Whether a reconnect re-sends this file's full state (see
	 * _syncLiveDocs): false for a doc over RESYNC_STATE_CAP_BYTES, which
	 * does not recover on its own.
	 */
	resyncCovers(fileId: string): boolean {
		const doc = this._yjsDocs.get(fileId);
		const Y = this._yjsBundle?.Y;
		return !!doc && !!Y && Y.encodeStateAsUpdate(doc).byteLength <= RESYNC_STATE_CAP_BYTES;
	}

	/**
	 * After a re-join ack: the convergence check, for each live doc (every
	 * file opened this room session). An edit is lost on a reconnect two ways:
	 * made while the socket was down (the doc's update listener drops it), or
	 * sent between the reconnect and the ack (the server discards updates from
	 * a socket not yet in the room). And the room may have changes this side
	 * missed. So each side learns what the other lacks: this side sends its
	 * state vector (yjs:sync), takes what the room answers it lacks, and sends
	 * back what the room lacks (yjs:sync-reply). Afterwards both hold the same
	 * text. A file the room has no document for waits for one
	 * (_waitForRoomDoc). A server that doesn't answer (one without the check)
	 * is sent the full state instead, as before. Diffs over
	 * RESYNC_STATE_CAP_BYTES are skipped and logged.
	 */
	private async _syncLiveDocs(roomId: string, epoch: number, fileIds: readonly string[]): Promise<void> {
		const Y = this._yjsBundle?.Y;
		if (!Y || !this.socket?.connected) { return; }
		const results = await Promise.all(fileIds.map(fileId => this._syncDoc(Y, roomId, epoch, fileId)));
		if (!this.isCurrentRoomSession(epoch)) { return; }
		const count = (result: string) => results.filter(r => r === result).length;
		lcLog.info(`[LiveCollab] rejoin check of ${fileIds.length} files: ${count('same')} already matched the room, ${count('merged')} merged with it, ${count('no_doc')} waiting for the room's document, ${count('not_saved')} waiting for the room to save them, ${count('rebuilt')} not merged (the room's copy was rebuilt), ${count('old_server')} sent in full (the server has no check), ${count('too_large')} too large to send, ${count('gone')} gone`);
	}

	private async _syncDoc(Y: typeof import('yjs'), roomId: string, epoch: number, fileId: string): Promise<'same' | 'merged' | RoomRefusal | 'rebuilt' | 'old_server' | 'too_large' | 'gone'> {
		const doc = this._yjsDocs.get(fileId);
		const socket = this.socket;
		if (!doc || !socket?.connected) { return 'gone'; }
		const ack = await new Promise<ISyncAck | undefined>(resolve => {
			const timer = setTimeout(() => resolve(undefined), SYNC_ACK_MS);
			socket.emit('yjs:sync', { roomId, fileId, stateVector: Array.from(Y.encodeStateVector(doc)) }, (res: ISyncAck | undefined) => { clearTimeout(timer); resolve(res); });
		});
		if (!this.isCurrentRoomSession(epoch) || this._yjsDocs.get(fileId) !== doc || !socket.connected) { return 'gone'; }
		if (!ack) {
			const state = Y.encodeStateAsUpdate(doc);
			if (state.byteLength > RESYNC_STATE_CAP_BYTES) {
				lcLog.warn(`[LiveCollab] rejoin: ${fileId} (${state.byteLength} bytes) is too large to re-send, not covered`);
				return 'too_large';
			}
			socket.emit('yjs:update', { roomId, fileId, update: Array.from(state) });
			return 'old_server';
		}
		if (!ack.ok) {
			if (ack.error === 'no_doc') {
				this._waitForRoomDoc(fileId, 'no_doc');
				return 'no_doc';
			}
			lcLog.warn('[LiveCollab] rejoin check of', fileId, 'refused:', ack.error);
			return 'gone';
		}
		// Two histories with no writer in common are two documents: Yjs would
		// keep both copies of the text. The room's was rebuilt (its document
		// lost, then seeded again from the owner's disk); this side's changes
		// can't join it.
		if (this._divergedDocs.has(fileId) || !this._sharesHistory(Y, doc, fileId, new Uint8Array(ack.stateVector ?? []))) {
			this._syncWaiting.delete(fileId);
			return 'rebuilt';
		}
		const before = doc.getText('content').toString();
		if (ack.update) {
			Y.applyUpdate(doc, new Uint8Array(ack.update), 'remote');
		}
		const roomLacks = Y.encodeStateAsUpdate(doc, new Uint8Array(ack.stateVector ?? []));
		// An update with no changes in it encodes as two zero bytes.
		const sends = roomLacks.byteLength > 2;
		if (sends && roomLacks.byteLength > RESYNC_STATE_CAP_BYTES) {
			lcLog.warn(`[LiveCollab] rejoin: what the room lacks of ${fileId} (${roomLacks.byteLength} bytes) is too large to send, not covered`);
			return 'too_large';
		}
		const received = doc.getText('content').toString() !== before;
		if (received) { this._onRoomTextChanged.fire(fileId); }
		if (sends) {
			// Acked: a reply the room refuses waits, like a refused change.
			const replied = await new Promise<{ ok: boolean; error?: string } | undefined>(resolve => {
				const timer = setTimeout(() => resolve(undefined), SYNC_ACK_MS);
				socket.emit('yjs:sync-reply', { roomId, fileId, update: Array.from(roomLacks) }, (res: { ok: boolean; error?: string } | undefined) => { clearTimeout(timer); resolve(res); });
			});
			if (!this.isCurrentRoomSession(epoch) || this._yjsDocs.get(fileId) !== doc) { return 'gone'; }
			if (!replied?.ok) {
				const reason: RoomRefusal = replied?.error === 'no_doc' || replied?.error === 'read_only' ? replied.error : 'not_saved';
				lcLog.warn('[LiveCollab] rejoin: the room refused what it lacks of', fileId, ':', replied ? replied.error : 'no answer');
				this._waitForRoomDoc(fileId, reason);
				return reason;
			}
		}
		this._syncWaiting.delete(fileId);
		return sends || received ? 'merged' : 'same';
	}

	/**
	 * Whether the room's document (given by its state vector) and this
	 * window's are one history. Two histories with no writer in common are
	 * two documents, and Yjs would keep both copies of the text: the room's
	 * was rebuilt (lost, then seeded again from the owner's disk). Such a file
	 * is marked diverged and announced, once.
	 */
	private _sharesHistory(Y: typeof import('yjs'), doc: YDoc, fileId: string, roomStateVector: Uint8Array): boolean {
		const ours = Y.decodeStateVector(Y.encodeStateVector(doc));
		const theirs = Y.decodeStateVector(roomStateVector);
		if (ours.size === 0 || theirs.size === 0 || [...ours.keys()].some(client => theirs.has(client))) { return true; }
		if (!this._divergedDocs.has(fileId)) {
			this._divergedDocs.add(fileId);
			const path = this._roomPathOf(fileId);
			lcLog.error(`🔴 [LiveCollab] the room's document for ${fileId} (${path ?? 'not in the room\'s tree'}) shares no history with this one (rebuilt): not merged, nothing more sent; this side's text is only here`);
			this._onSyncFailed.fire({ fileId, path, reason: 'rebuilt' });
		}
		return false;
	}

	/**
	 * A file whose changes the room refused (no document for it, or it
	 * couldn't save them): they are kept here and checked again at the room's
	 * next snapshot (the owner re-attaching seeds the documents) or after
	 * SYNC_RETRY_MS. Refused again after that, the changes exist only here,
	 * and that is announced (onSyncFailed).
	 */
	private _waitForRoomDoc(fileId: string, reason: RoomRefusal): void {
		const waiting = this._syncWaiting.get(fileId);
		if (waiting?.retried) {
			this._syncWaiting.delete(fileId);
			const path = this._roomPathOf(fileId);
			lcLog.error(`🔴 [LiveCollab] the room refused ${fileId} (${path ?? 'not in the room\'s tree'}) again after a retry (${reason}): its changes here are nowhere else`);
			this._onSyncFailed.fire({ fileId, path, reason });
			return;
		}
		this._syncWaiting.set(fileId, { retried: false, reason });
		if (!this._syncRetryTimer) {
			this._syncRetryTimer = setTimeout(() => { this._syncRetryTimer = undefined; this._retryWaitingDocs(); }, SYNC_RETRY_MS);
		}
	}

	private _retryWaitingDocs(): void {
		if (this._syncWaiting.size === 0 || !this._roomId) { return; }
		if (this._syncRetryTimer) { clearTimeout(this._syncRetryTimer); this._syncRetryTimer = undefined; }
		const fileIds = [...this._syncWaiting.keys()].filter(fileId => this._yjsDocs.has(fileId));
		for (const fileId of this._syncWaiting.keys()) {
			const waiting = this._syncWaiting.get(fileId);
			if (waiting && this._yjsDocs.has(fileId)) { this._syncWaiting.set(fileId, { ...waiting, retried: true }); } else { this._syncWaiting.delete(fileId); }
		}
		void this._syncLiveDocs(this._roomId, this._roomEpoch, fileIds);
	}

	/** The room path of a file, from the tree this connection last recorded. */
	private _roomPathOf(fileId: string): string | undefined {
		const find = (items: readonly ILiveCollabTreeItem[] | undefined): string | undefined => {
			for (const item of items ?? []) {
				if (item.id === fileId) { return item.path ?? item.name; }
				const inside = find(item.children);
				if (inside) { return inside; }
			}
			return undefined;
		};
		return find(this._roomTree?.tree);
	}

	// PHASE4 file lifecycle (section 4b): tear down a file's local doc + all its
	// tracking when the room deletes it, so nothing lingers or resurrects.
	dropYjsDoc(fileId: string): void {
		const doc = this._yjsDocs.get(fileId);
		if (doc) { try { doc.destroy(); } catch { } this._yjsDocs.delete(fileId); }
		this._yjsDocsSeeded.delete(fileId);
		this._fileStates.drop(fileId);
	}
	/**
	 * The room's current text of a file: its live document when one is open
	 * here, else its seed state with the updates held for it.
	 */
	async getRoomText(fileId: string): Promise<string> {
		const doc = this._yjsDocs.get(fileId);
		return doc ? doc.getText('content').toString() : this.getSnapshotText(fileId);
	}
	/**
	 * Whether this client holds fileId's room text: a live doc or a seed
	 * state. Without either, getRoomText answers '' — which is "unknown", not
	 * "empty", and must never be written anywhere.
	 */
	knowsRoomText(fileId: string): boolean {
		return this._yjsDocs.has(fileId) || this._fileStates.hasSeedState(fileId);
	}
	/**
	 * Makes `text` fileId's room text, as an edit by this member that reaches
	 * everyone: only the changed middle is replaced, so cursors outside it
	 * stay put. False when the file's doc can't be loaded seeded (R1: an
	 * unseeded doc is never written into).
	 */
	async replaceRoomText(fileId: string, text: string): Promise<boolean> {
		const epoch = this._roomEpoch;
		let doc: YDoc;
		try {
			doc = await this.getOrCreateYjsDoc(fileId);
		} catch (e) {
			lcLog.error('[LiveCollab] replaceRoomText: could not load', fileId, e);
			return false;
		}
		if (!this.isCurrentRoomSession(epoch) || !this.isSeeded(fileId)) { return false; }
		const content = doc.getText('content');
		const current = content.toString();
		if (current === text) { return true; }
		let start = 0;
		while (start < current.length && start < text.length && current[start] === text[start]) { start++; }
		let end = 0;
		while (end < current.length - start && end < text.length - start && current[current.length - 1 - end] === text[text.length - 1 - end]) { end++; }
		doc.transact(() => {
			content.delete(start, current.length - start - end);
			content.insert(start, text.slice(start, text.length - end));
		});
		return true;
	}
	/**
	 * fileId's room text, synchronously, or undefined if this client doesn't
	 * hold it or Yjs hasn't loaded. For a room state's beforeClear, which
	 * cannot wait.
	 */
	roomTextNow(fileId: string): string | undefined {
		const doc = this._yjsDocs.get(fileId);
		if (doc) { return doc.getText('content').toString(); }
		const Y = this._yjsBundle?.Y;
		if (!Y || !this._fileStates.hasSeedState(fileId)) { return undefined; }
		const state = this._fileStates.readSeedState(Y, fileId);
		if (!state) { return undefined; }
		const scratch = new Y.Doc();
		try {
			Y.applyUpdate(scratch, state, 'remote');
			return scratch.getText('content').toString();
		} finally {
			scratch.destroy();
		}
	}
	// PHASE4: decode the seeded snapshot state for a file into plain text, so
	// the virtual filesystem can be populated with real content up front
	// (replacing the old empty-placeholder + lazy-fetch). Returns '' if no
	// snapshot state is known for this fileId yet.
	async getSnapshotText(fileId: string): Promise<string> {
		if (!this._fileStates.hasSeedState(fileId)) { return ''; }
		const Y = await this.getYjsModule();
		const state = this._fileStates.readSeedState(Y, fileId);
		if (!state) { return ''; }
		const doc = new Y.Doc();
		Y.applyUpdate(doc, state, 'remote');
		return doc.getText('content').toString();
	}
	private async _loadYjsDoc(fileId: string): Promise<YDoc> {
		const epoch = this._roomEpoch;
		const startedIn = this._roomId;
		const Y = await this.getYjsModule();
		// Room-session invariant: a load that started in a previous room
		// session must not land its doc in this session's map. Rejecting is
		// safe — both editor callers already treat a failed load as "no doc".
		if (!this.isCurrentRoomSession(epoch)) {
			lcLog.info('[LiveCollab] stale doc load for', fileId, '— started in', startedIn ?? '(no room)', ', now in', this._roomId ?? '(no room)', '— dropped');
			throw new Error('livecollab: room session changed during doc load');
		}
		const doc = new Y.Doc();
		// Seed BEFORE registering the update listener, so the seed is local
		// bootstrapping and is never broadcast back as a fake edit.
		const snapState = this._fileStates.readSeedState(Y, fileId);
		if (snapState) {
			Y.applyUpdate(doc, snapState, 'remote');
			this._yjsDocsSeeded.add(fileId);
		}
		doc.on('update', (update: Uint8Array, origin: unknown) => {
			if (origin === 'remote') { return; }
			this._onRoomTextChanged.fire(fileId);
			if (!this.socket?.connected || this._divergedDocs.has(fileId)) { return; }
			this.socket.emit('yjs:update', { roomId: this._roomId, fileId, update: Array.from(update) });
		});
		this._yjsDocs.set(fileId, doc);
		return doc;
	}
	/** The editor the room last heard this window's cursor from, until it leaves. */
	private _cursorSource: object | undefined;
	/** The last cursor message sent, and on which connection, so a repeat isn't sent twice. */
	private _cursorSent: string | undefined;

	/**
	 * Sends where this window's cursor is: in `fileId` (the room's id for the file), from the
	 * editor `source`. The server stamps the sender's name.
	 */
	emitCursorUpdate(roomId: string, fileId: string, position: { lineNumber: number; column: number }, source: object): void {
		this._cursorSource = source;
		if (!this.socket?.connected) { return; }
		const sent = JSON.stringify([this.socket.id, roomId, fileId, position.lineNumber, position.column]);
		if (sent === this._cursorSent) { return; }
		this._cursorSent = sent;
		this.socket.emit('cursor:update', { roomId, fileId, position });
	}

	/** Whether `source` is the editor the room last heard this window's cursor from. */
	isCursorSource(source: object): boolean {
		return this._cursorSource === source;
	}

	/**
	 * Takes this window's cursor out of the room, when `source` is the editor it was last sent
	 * from (another editor showing a non-room file says nothing about where the cursor is).
	 */
	emitCursorLeave(roomId: string, source: object): void {
		if (this._cursorSource !== source) { return; }
		this._cursorSource = undefined;
		this._cursorSent = undefined;
		if (!this.socket?.connected) { return; }
		this.socket.emit('cursor:leave', { roomId });
	}

	// ===== Room exit (LIVECOLLAB_BEHAVIORAL_SPEC.md, room exit model) =====
	//
	// Two teardown levels, because their lists genuinely differ:
	// - SESSION teardown (_teardownRoomSession): everything this client holds
	//   for the room it is in — ids, role, docs, snapshot states, caches,
	//   timers — and onRoomLeft, whose listeners detach folders, close
	//   editors and clear the virtual FS. Membership is untouched: the room
	//   stays on the dashboard and can be re-entered.
	// - MEMBERSHIP teardown (_endRoomMembership): session teardown if it is
	//   the current room, PLUS drop the room's saved Scenario-1 state (there
	//   is no returning to it) and onRoomTerminated (notify + dashboard).
	//
	// Neither navigates by itself except through onRoomTerminated; a switch
	// (joinExistingRoom) must stay on the workbench.

	// SESSION teardown, local only. The ONLY code besides joinExistingRoom that
	// assigns _roomId. Idempotent: a no-op when not in a room. `cause` is
	// logged, so every end of a room session says why (2026-11-12: a room
	// ended with no line naming its cause; see KNOWN_ISSUES).
	private _teardownRoomSession(cause: string): string | undefined {
		if (!this._roomId) { return undefined; }
		lcLog.info('[LiveCollab] room session ending:', this._roomId, '— cause:', cause);
		// Capture before clearing - listeners need to know WHICH room to
		// save state for (see PHASE2_OVERLAY_DESIGN.md section 6).
		const leftRoomId = this._roomId;
		for (const owner of this._roomStateOwners) {
			if (!owner.beforeClear) { continue; }
			try {
				owner.beforeClear();
			} catch (e) {
				lcLog.error(`🔴 [LiveCollab] room state '${owner.name}' failed before the end of`, leftRoomId, ':', e);
			}
		}
		// Invalidate every async operation started in this session BEFORE
		// clearing anything, so none can commit into the next one.
		this._roomEpoch++;
		this._roomId = undefined;
		this._leftRoom = leftRoomId ? { roomId: leftRoomId, roomName: this._roomName } : this._leftRoom;
		this._roomName = undefined;
		// R2: clear role on leave so a stale 'owner' from the previous room can
		// never gate real-disk writes open during a room switch, before the next
		// room's ack lands. Fail closed until re-established.
		this._setMyRole(undefined);
		this._lastMembers = [];
		this._online = new Set();
		// Disarm the snapshot fallback so it never fires into a room we've
		// already left.
		if (this._treeFallbackTimer) { clearTimeout(this._treeFallbackTimer); this._treeFallbackTimer = undefined; }
		this._snapshotReceived = false;
		this._roomFolder = undefined;
		this._roomTree = undefined;
		this._joinConfirmed = undefined;
		// Real, serious bug found via live testing (2026-08-20): Yjs docs
		// were keyed ONLY by bare filename, never room-scoped, and never
		// cleared here - meaning a file reused across a DIFFERENT room
		// later in the same running session (e.g. delete a room, create a
		// new one with a same-named file) would silently reuse the OLD
		// doc's stale content. Confirmed: a second live test showed
		// leftover characters from an unrelated earlier test appearing in
		// a brand-new room's file. Real fix: clear both Yjs maps on every
		// room leave, same as the existing room-isolation pattern already
		// used for the folder/file system state below this method's
		// callers. destroy() is Yjs's own real cleanup method, confirmed
		// via source inspection earlier this session. The docs, their seed
		// states and caches are now one registered room state (see the
		// constructor), cleared with every other owner's here.
		this._lastLeftRoomId = leftRoomId;
		for (const owner of this._roomStateOwners) {
			if (!owner.clear) { continue; }
			try {
				owner.clear();
			} catch (e) {
				lcLog.error(`🔴 [LiveCollab] room state '${owner.name}' failed to clear at the end of`, leftRoomId, ':', e);
			}
		}
		this._onMembersChanged.fire([]);
		// Fire onRoomLeft - livecollab.contribution.ts and
		// livecollabFolderContribution.ts listen and handle all teardown
		// (file system clear, editor close, and now state-save for restore)
		// in their own places, avoiding a circular import between this file
		// and livecollabFileSystemProvider.ts (which already imports THIS
		// file). See PHASE2_OVERLAY_DESIGN.md sections 4 and 6.
		this._onRoomLeft.fire(leftRoomId);
		return leftRoomId;
	}

	/**
	 * Registers a piece of room-session state: cleared when every room session
	 * ends, checked empty before the next one starts. Dispose to unregister
	 * (an owner that goes away, such as an editor, must).
	 */
	registerRoomState(owner: IRoomStateOwner): IDisposable {
		this._roomStateOwners.add(owner);
		return toDisposable(() => this._roomStateOwners.delete(owner));
	}

	/**
	 * Before a room session starts: every registered state must be empty. One
	 * that isn't is named in the log with what it held, then cleared. That
	 * warning is the point: the next owner whose clean-up silently fails is
	 * found by the log, not by a tester.
	 */
	private _checkRoomStateClean(entering: string): void {
		const rooms = { left: this._lastLeftRoomId, entering };
		for (const owner of this._roomStateOwners) {
			let held: string[];
			try {
				held = owner.inspect(rooms);
			} catch (e) {
				lcLog.error(`🔴 [LiveCollab] room state '${owner.name}' could not be inspected entering`, entering, ':', e);
				continue;
			}
			if (held.length === 0) { continue; }
			lcLog.warn(`[LiveCollab] room state NOT clean entering ${entering} (last left: ${rooms.left ?? 'none'}): '${owner.name}' still holds ${held.join('; ')}${owner.clear ? ' — clearing it' : ' — no safe clear here, left as is'}`);
			if (owner.clear) {
				try {
					owner.clear();
				} catch (e) {
					lcLog.error(`🔴 [LiveCollab] room state '${owner.name}' failed to clear entering`, entering, ':', e);
				}
			}
		}
	}

	// End the current room SESSION and tell the server to detach this socket
	// (membership kept). Used for a switch and for returning to the dashboard.
	private _exitRoomSession(cause: string): void {
		const roomId = this._roomId;
		if (!roomId) { return; }
		if (this.socket?.connected) { this.socket.emit('room:detach', { roomId }); }
		this._teardownRoomSession(cause);
	}

	// MEMBERSHIP teardown. The server has already removed us (or confirmed our
	// leave), so there is nothing to tell it. Safe for a room we're not
	// currently in (e.g. kicked while viewing another room).
	private _endRoomMembership(roomId: string, roomName: string | undefined, reason: RoomTerminationReason, by?: string): void {
		if (this._roomId === roomId) { this._teardownRoomSession(`membership ended (${reason}${by ? ` by ${by}` : ''})`); }
		// After teardown: the onRoomLeft listener saves Scenario-1 state for the
		// room synchronously; a room we can't return to must not keep it.
		this._roomStates.delete(roomId);
		this._onRoomTerminated.fire({ roomId, roomName, reason, by });
	}

	/**
	 * The account signed out on the dashboard. The socket is authenticated as
	 * the account that opened it for as long as it stays connected, so it is
	 * closed, and everything that belongs to that account is dropped: token,
	 * name, user id, role and saved room states. The next room entry signs in
	 * fresh from the new account's token (LiveCollabWorkbenchJoin).
	 */
	signOut(): void {
		lcLog.info('[LiveCollab] signed out: closing the workbench connection');
		if (this._roomId) { this._exitRoomSession('signed out'); }
		if (this._tokenRefreshTimer) { mainWindow.clearInterval(this._tokenRefreshTimer); this._tokenRefreshTimer = undefined; }
		if (this.socket) { this.socket.disconnect(); this.socket = null; }
		this._connecting = false;
		this._token = undefined;
		this._displayName = 'User';
		this._myUserId = '';
		this._setMyRole(undefined);
		this._lastMembers = [];
		this._online = new Set();
		this._roomStates.clear();
	}

	// "Back to Dashboard": navigation, not leaving. Membership stays and the
	// room stays on the dashboard, but the room's workspace is torn down so it
	// cannot contaminate whichever room is entered next.
	// `source` names what asked (the activity bar's Dashboard button, the
	// command), for the log.
	returnToDashboard(source: string): void {
		this._exitRoomSession(`Back to Dashboard (${source})`);
		this._ipc?.send('vscode:livecollab-load-dashboard');
	}

	/**
	 * Asks main to show `notice` on this window's dashboard if it is in front, without bringing it
	 * forward, and returns main's answer: 'shown', 'not in front', or 'no main' (no main process to
	 * ask). Main alone decides where the notice goes: no answer within 2 seconds means delivery is
	 * unknown, not failed, so this only calls `noAnswerYet` then and keeps waiting for main's answer
	 * (until the window closes; if main never answers, the promise never settles).
	 */
	showOnDashboard(roomId: string, notice: string, noAnswerYet: () => void): Promise<'shown' | 'not in front' | 'no main'> {
		const ipc = this._ipc;
		if (!ipc) { return Promise.resolve('no main'); }
		const id = ++this._dashboardNoticeIds;
		return new Promise(resolve => {
			const waiting = new DisposableStore();
			this._dashboardNoticesWaiting.add(waiting);
			const onAnswer = (_event: unknown, answer?: unknown) => {
				const { id: answered, delivered } = (answer ?? {}) as { id?: unknown; delivered?: unknown };
				if (answered === id) {
					this._dashboardNoticesWaiting.delete(waiting);
					resolve(delivered === true ? 'shown' : 'not in front');
				}
			};
			ipc.on('vscode:livecollab-dashboard-notice-result', onAnswer);
			waiting.add(toDisposable(() => ipc.removeListener('vscode:livecollab-dashboard-notice-result', onAnswer)));
			const slow = setTimeout(noAnswerYet, 2000);
			waiting.add(toDisposable(() => clearTimeout(slow)));
			ipc.send('vscode:livecollab-dashboard-notice', { roomId, notice, id });
		});
	}
	private _dashboardNoticeIds = 0;
	/** The dashboard notices still waiting for main's answer; their listeners go with the window. */
	private readonly _dashboardNoticesWaiting = this._register(new DisposableStore());

	// "Leave Room": voluntary end of membership. Only tears down once the server
	// confirms the leave actually completed (membership removed, socket
	// detached); on failure the client stays in the room and reports why.
	async leaveRoom(): Promise<{ ok: boolean; error?: string }> {
		const roomId = this._roomId;
		if (!roomId || !this.socket?.connected) { return { ok: false, error: 'not_in_room' }; }
		const roomName = this._roomName;
		const res = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
			const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 5000);
			this.socket!.emit('room:leave', { roomId }, (ack: { ok: boolean; error?: string } | undefined) => {
				clearTimeout(timer);
				resolve(ack ?? { ok: false, error: 'no_ack' });
			});
		});
		if (!res.ok) {
			lcLog.error('[LiveCollab] leave room', roomId, 'failed:', res.error);
			return res;
		}
		this._endRoomMembership(roomId, roomName, 'left');
		return res;
	}

	// Push events carry the roomId they belong to; drop anything addressed to
	// a room we're not in. A missing roomId (server not yet deployed with it)
	// is accepted while we ARE in a room, so this client keeps working
	// against the current server.
	private _isForCurrentRoom(event: string, roomId: string | undefined): boolean {
		if (!this._roomId) { lcLog.info('[LiveCollab]', event, 'while in no room — dropped'); return false; }
		if (roomId !== undefined && roomId !== this._roomId) { lcLog.info('[LiveCollab]', event, 'for room', roomId, 'while in', this._roomId, '— dropped'); return false; }
		return true;
	}
	// Scenario 1 save/restore access (PHASE2_OVERLAY_DESIGN.md section 6).
	// This class only STORES the data - the actual save/restore ACTIONS
	// (reading/writing real folders and editors) live in
	// livecollabFolderContribution.ts, which has the needed service
	// injections this plain class does not.
	saveRoomState(roomId: string, state: RoomState): void {
		this._roomStates.set(roomId, state);
	}
	getRoomState(roomId: string): RoomState | undefined {
		return this._roomStates.get(roomId);
	}
	// PHASE4 file lifecycle (section 4b, piece 1 — outgoing). The client never
	// mints an id; it reports the user's structural file op with a room-relative
	// path and the server mints/renames/deletes and broadcasts the result back.
	// Each reads the server's ack: a refusal (ok: false) fires
	// onFileOperationRefused. No ack, or ok: true, is success as before.
	emitFileCreate(path: string): void {
		if (!this.socket?.connected || !this._roomId) { return; }
		this.socket.emit('room:file:create', { roomId: this._roomId, path }, (ack?: IFileOperationAck) => this._reportIfRefused(ack, { operation: 'create', path }));
	}
	/**
	 * @param correction true for an owner's correction (a refused move sent
	 * back): flagged in the message so no client ever answers it with one.
	 * @returns whether the room accepted it. The room tells everyone, this client included, before
	 * it answers, so by then this client's own handler has the rename.
	 */
	emitFileRename(fileId: string, oldPath: string, newPath: string, correction: boolean = false): Promise<boolean> {
		return this._emitFileOperation('room:file:rename', { fileId, oldPath, newPath, ...(correction ? { correction: true } : {}) }, { operation: 'rename', path: oldPath, newPath });
	}
	/** Tells the rest of the room what this owner's reconcile applied (the server passes it on; owner only). */
	async sendReconciled(summary: IRoomReconciledSummary): Promise<boolean> {
		const socket = this.socket;
		if (!socket?.connected || !this._roomId) { return false; }
		return new Promise<boolean>(resolve => {
			// No answer: a server from before this event (it registers no handler, so it never acks).
			// The owner's own notice doesn't depend on it, so nothing is shown.
			const unanswered = setTimeout(() => {
				lcLog.info('[LiveCollab] no answer to the reconcile summary (a server from before room:reconciled?) — guests weren\'t told');
				resolve(false);
			}, FILE_OPERATION_ANSWER_MS);
			socket.emit('room:reconciled', { roomId: this._roomId, summary }, (ack?: IFileOperationAck) => {
				clearTimeout(unanswered);
				if (ack?.ok === false) { lcLog.warn('[LiveCollab] the room refused the reconcile summary:', ack.error ?? 'unknown'); }
				resolve(ack?.ok !== false);
			});
		});
	}
	/** @returns whether the room accepted it, as for a rename. */
	emitFileDelete(fileId: string, path: string): Promise<boolean> {
		return this._emitFileOperation('room:file:delete', { fileId, path }, { operation: 'delete', path });
	}
	/** Sends a file operation; resolves with the room's answer, or false when there is none in time. */
	private _emitFileOperation(event: string, payload: object, operation: { operation: 'rename' | 'delete'; path: string; newPath?: string }): Promise<boolean> {
		const socket = this.socket;
		if (!socket?.connected || !this._roomId) { return Promise.resolve(false); }
		return new Promise<boolean>(resolve => {
			const unanswered = setTimeout(() => {
				lcLog.warn(`[LiveCollab] no answer from the room to the ${operation.operation} of ${operation.path}`);
				resolve(false);
			}, FILE_OPERATION_ANSWER_MS);
			socket.emit(event, { roomId: this._roomId, ...payload }, (ack?: IFileOperationAck) => {
				clearTimeout(unanswered);
				this._reportIfRefused(ack, operation);
				resolve(ack?.ok !== false);
			});
		});
	}
	private _reportIfRefused(ack: IFileOperationAck | undefined, operation: { operation: 'create' | 'rename' | 'delete'; path: string; newPath?: string }): void {
		if (ack?.ok !== false) { return; }
		const error = ack.error ?? 'unknown';
		lcLog.warn(`[LiveCollab] room refused ${operation.operation} of ${operation.path}${operation.newPath ? ' -> ' + operation.newPath : ''}: ${error}`);
		this._onFileOperationRefused.fire({ ...operation, error });
	}

	/** Removes a member from the room (owner only). Resolves with the server's answer. */
	kickMember(userId: string): Promise<IMemberActionResult> {
		return this._memberAction('room:kick', { userId });
	}

	/** Makes a member a viewer or an editor (owner only). Resolves with the server's answer. */
	setMemberRole(userId: string, role: 'editor' | 'viewer'): Promise<IMemberActionResult> {
		return this._memberAction('room:role:set', { userId, role });
	}

	/** Makes a member the room's owner; this user becomes an editor. Resolves with the server's answer. */
	transferOwnership(userId: string): Promise<IMemberActionResult> {
		return this._memberAction('room:owner:transfer', { userId });
	}

	/**
	 * A chat request for the current room (livecollabChat.ts). Always resolves:
	 * with the answer, 'offline' when it could not be sent, or 'no_answer'
	 * when none came within CHAT_ANSWER_MS or the connection dropped first
	 * (socket.io never answers a request cut off by a disconnect).
	 */
	chatRequest<T>(event: string, payload: object): Promise<T | 'offline' | 'no_answer'> {
		return new Promise(resolve => {
			if (!this.socket?.connected || !this._roomId) {
				resolve('offline');
				return;
			}
			const unanswered = () => finish('no_answer');
			const finish = (answer: T | 'no_answer') => {
				clearTimeout(timer);
				this._chatWaiting.delete(unanswered);
				resolve(answer);
			};
			const timer = setTimeout(unanswered, CHAT_ANSWER_MS);
			this._chatWaiting.add(unanswered);
			this.socket.emit(event, { ...payload, roomId: this._roomId }, (answer: T) => finish(answer));
		});
	}
	/** Chat requests waiting for an answer: each answered 'no_answer' when the connection drops. */
	private readonly _chatWaiting = new Set<() => void>();

	private _memberAction(event: string, args: Record<string, string>): Promise<IMemberActionResult> {
		return new Promise(resolve => {
			if (!this.socket?.connected || !this._roomId) {
				resolve({ ok: false, error: localize('livecollab.memberAction.offline', "You're not connected to the room.") });
				return;
			}
			this.socket.emit(event, { roomId: this._roomId, ...args }, (ack: { ok?: boolean; error?: string } | undefined) => {
				resolve(ack?.ok ? { ok: true } : { ok: false, error: ack?.error || localize('livecollab.memberAction.noAnswer', "The room didn't answer.") });
			});
		});
	}

	async createInviteCode(): Promise<{ success: boolean; code?: string; error?: string }> {
		return new Promise((resolve) => {
			if (!this.socket?.connected || !this._roomId) { resolve({ success: false, error: 'Not in a room' }); return; }
			this.socket.emit('room:invite:create', { roomId: this._roomId }, (res: { code?: string; error?: string } | undefined) => {
				if (res?.code) { resolve({ success: true, code: res.code }); }
				else { resolve({ success: false, error: res?.error || 'Could not create invite code' }); }
			});
		});
	}



	/**
	 * Whether the current room already has a folder attached, per the server:
	 * from this room session's snapshot if one arrived, otherwise asked for
	 * directly (`room:request-snapshot` answers `no_snapshot` for a room with
	 * no tree). Returns undefined when it cannot be determined — offline, no
	 * answer, or the room session changed meanwhile — and callers must then
	 * fail closed.
	 */
	async getRoomFolder(): Promise<IRoomFolderInfo | undefined> {
		if (this._roomFolder) { return this._roomFolder; }
		if (!this.socket?.connected || !this._roomId) { return undefined; }
		const roomId = this._roomId;
		const epoch = this._roomEpoch;
		const ack = await new Promise<{ ok: boolean; error?: string; tree?: unknown[]; folderName?: string } | undefined>((resolve) => {
			const timer = setTimeout(() => resolve(undefined), 5000);
			this.socket!.emit('room:request-snapshot', { roomId }, (res: { ok: boolean; error?: string; tree?: unknown[]; folderName?: string } | undefined) => {
				clearTimeout(timer);
				resolve(res);
			});
		});
		if (!this.isCurrentRoomSession(epoch)) { lcLog.info('[LiveCollab] stale room-folder check for', roomId, '— room session changed, dropped'); return undefined; }
		if (this._roomFolder) { return this._roomFolder; } // a snapshot landed while we asked
		if (ack?.ok && Array.isArray(ack.tree)) {
			this._roomFolder = { hasFolder: ack.tree.length > 0, folderName: ack.folderName };
		} else if (ack?.error === 'no_snapshot') {
			this._roomFolder = { hasFolder: false, folderName: undefined };
		} else {
			lcLog.warn('[LiveCollab] could not determine whether room', roomId, 'has a folder:', ack?.error ?? 'no answer');
		}
		return this._roomFolder;
	}

	// PHASE4 replicate-on-join: the host attaches its folder ONCE, sending
	// the tree WITH real file contents inline. The server assigns stable ids,
	// seeds one authoritative Y.Doc per file, and returns the id-assigned
	// (content-stripped) tree - which the host stores so it can map its own
	// file:// files to server ids (it never receives its own snapshot back).
	// `epoch` is the room session the caller's disk walk started in: a walk that
	// began in room A must never be attached to room B (room-session invariant).
	// Resolves undefined when nothing was sent (not connected, stale) or the
	// ack is stale; otherwise the tree or why there is none.
	async attachFolder(tree: ILiveCollabTreeItem[], epoch: number, folderName: string | undefined, withheld: readonly string[], withheldPrefixes: readonly string[]): Promise<AttachResult | undefined> {
		if (!this.socket?.connected || !this._roomId) { return undefined; }
		if (!this.isCurrentRoomSession(epoch)) { lcLog.info('[LiveCollab] stale attach — room session changed during the walk, not sent'); return undefined; }
		// The server refuses an attach from a socket whose (re-)join it hasn't
		// acked ("not in this room"), and a reconnect's attach used to race the
		// re-join that way, leaving the owner's offline changes out of the room
		// and the room's new files off their disk until the next reconnect
		// (TEST_HARNESS_TRIAGE.md, "#11 and #15: the cause").
		if (!await this.whenJoinConfirmed(epoch)) { return undefined; }
		if (!this.socket?.connected || !this.isCurrentRoomSession(epoch)) { return undefined; }
		const roomId = this._roomId;
		// withheld: room-relative paths of links and secret-looking items
		// left out of `tree`, so the server can drop any content an older
		// attach sent for them (row 27). Used for that only, never stored.
		// withheldPrefixes: the links among them (livecollabContainment.ts), for
		// the server half of the containment rule (CONTAINMENT_DESIGN.md): it
		// is to refuse any create or rename whose destination falls under one,
		// so no member's view takes a path this folder can't. A server without
		// that half ignores the field.
		const payload = { roomId, tree, folderName, withheld, withheldPrefixes };
		// Measured as sent: socket.io encodes the message as JSON, where file
		// text is ~1x but a control character takes 6 bytes. A message over
		// the server's limit closes the socket, and every reconnect re-attaches.
		const wireBytes = VSBuffer.fromString(JSON.stringify(payload)).byteLength;
		if (wireBytes > ATTACH_WIRE_CAP_BYTES) {
			lcLog.error('🔴 [LiveCollab] room:attach NOT SENT for room', roomId, ':', wireBytes, 'bytes encoded, over the', ATTACH_WIRE_CAP_BYTES, 'limit');
			return { ok: false, failure: 'tooLarge', wireBytes };
		}
		lcLog.info('[LiveCollab] attaching folder, roomName:', this._roomName, 'folderName:', folderName, 'top-level items:', tree.length, 'bytes:', wireBytes);
		return new Promise((resolve) => {
			// socket.io never calls the ack of a message lost to a disconnect:
			// without this the attach would wait forever.
			const closed = this.onDisconnected(() => {
				closed.dispose();
				lcLog.error('🔴 [LiveCollab] room:attach FAILED for room', roomId, ': the socket closed before the ack,', wireBytes, 'bytes');
				resolve({ ok: false, failure: 'closed', wireBytes });
			});
			this.socket!.emit('room:attach', payload, (ack: { ok: boolean; tree?: ILiveCollabTreeItem[]; error?: string }) => {
				closed.dispose();
				// Failed and stale are logged here, distinctly: a real failure
				// loudly, a stale ack as routine.
				if (!ack?.ok) { lcLog.error('🔴 [LiveCollab] room:attach FAILED for room', roomId, ':', ack?.error ?? 'no ack'); }
				if (!this.isCurrentRoomSession(epoch)) { lcLog.info('[LiveCollab] stale attach ack — attached to', roomId, ', now in', this._roomId ?? '(no room)', '— ids dropped'); resolve(undefined); return; }
				if (ack?.ok) { this._roomFolder = { hasFolder: true, folderName }; }
				resolve(ack?.ok && ack.tree ? { ok: true, tree: ack.tree } : { ok: false, failure: 'failed', wireBytes });
			});
		});
	}

	private _recordRoomTree(tree: ILiveCollabTreeItem[] | undefined): void {
		this._roomTree = { connection: this._connection, epoch: this._roomEpoch, tree: Array.isArray(tree) ? tree : [] };
		this._onRoomTreeRecorded.fire();
	}

	/**
	 * The room's tree as this connection found it after its join, for the owner's reconcile
	 * before an attach (ATTACH_RECONCILE_DESIGN.md, "Reconcile before the attach"). The server
	 * acks a join and then pushes the snapshot (index.js, room:join), so the ack alone doesn't
	 * mean the tree is here: this waits for the snapshot that follows it. A room known to hold
	 * no folder sends none, and answers [] at once (a first attach). If the push doesn't come in
	 * time, the tree is asked for. Undefined when it can't be had (disconnected, session changed).
	 */
	async roomTreeAfterJoin(epoch: number): Promise<ILiveCollabTreeItem[] | undefined> {
		const recorded = () => this._roomTree?.connection === this._connection && this._roomTree.epoch === epoch ? this._roomTree.tree : undefined;
		const now = recorded();
		if (now) { return now; }
		if (this._roomFolder?.hasFolder === false) { return []; }
		const store = new DisposableStore();
		try {
			const pushed = await new Promise<ILiveCollabTreeItem[] | undefined | 'late'>(resolve => {
				store.add(this._onRoomTreeRecorded.event(() => { const tree = recorded(); if (tree) { resolve(tree); } }));
				store.add(this.onDisconnected(() => resolve(undefined)));
				store.add(this.onRoomLeft(() => resolve(undefined)));
				const timer = setTimeout(() => resolve('late'), ROOM_TREE_WAIT_MS);
				store.add(toDisposable(() => clearTimeout(timer)));
			});
			if (pushed !== 'late') { return pushed; }
		} finally {
			store.dispose();
		}
		lcLog.warn('[LiveCollab] the room\'s snapshot did not follow the join in time — asking for the tree');
		if (!this.socket?.connected || !this._roomId || !this.isCurrentRoomSession(epoch)) { return undefined; }
		const roomId = this._roomId;
		const ack = await new Promise<{ ok: boolean; error?: string; tree?: ILiveCollabTreeItem[] } | undefined>(resolve => {
			const timer = setTimeout(() => resolve(undefined), 5000);
			this.socket!.emit('room:request-snapshot', { roomId }, (res: { ok: boolean; error?: string; tree?: ILiveCollabTreeItem[] } | undefined) => {
				clearTimeout(timer);
				resolve(res);
			});
		});
		if (!this.isCurrentRoomSession(epoch)) { return undefined; }
		if (ack?.ok && Array.isArray(ack.tree)) { return ack.tree; }
		if (ack?.error === 'no_snapshot') { return []; }
		return undefined;
	}

	private _confirmJoin(epoch: number): void {
		this._joinConfirmed = { connection: this._connection, epoch };
		this._onJoinConfirmed.fire();
	}

	/**
	 * Resolves true once the server has acked this connection's join of room session `epoch`,
	 * false if the connection drops, the session changes or no ack comes in time first (an
	 * attach is then not sent: the next connection's attach covers it).
	 */
	async whenJoinConfirmed(epoch: number): Promise<boolean> {
		const confirmed = () => this._joinConfirmed?.connection === this._connection && this._joinConfirmed.epoch === epoch;
		if (confirmed()) { return true; }
		lcLog.info('[LiveCollab] attach waits for the room to confirm this connection\'s join');
		const store = new DisposableStore();
		try {
			const outcome = await new Promise<boolean>(resolve => {
				store.add(this._onJoinConfirmed.event(() => { if (confirmed()) { resolve(true); } }));
				store.add(this.onDisconnected(() => resolve(false)));
				store.add(this.onRoomLeft(() => resolve(false)));
				const timer = setTimeout(() => resolve(false), JOIN_CONFIRM_WAIT_MS);
				store.add(toDisposable(() => clearTimeout(timer)));
			});
			if (!outcome) { lcLog.warn('[LiveCollab] attach not sent: the room did not confirm this connection\'s join (disconnected, left, or no ack in time)'); }
			return outcome;
		} finally {
			store.dispose();
		}
	}

	// Accepting an invite grants membership; entering the room then goes
	// through joinExistingRoom like every other entry, so the current room is
	// torn down first. (It used to assign _roomId directly, skipping both the
	// teardown and the socket join.)
	async joinRoom(inviteCode: string): Promise<{ success: boolean; roomId?: string; error?: string }> {
		const accepted = await new Promise<{ roomId?: string; error?: string }>((resolve) => {
			if (!this.socket?.connected) { resolve({ error: 'Not connected' }); return; }
			this.socket!.emit('room:invite:accept', { code: inviteCode }, (res: { roomId?: string; error?: string } | undefined) => {
				resolve({ roomId: res?.roomId, error: res?.error });
			});
		});
		if (!accepted.roomId) { return { success: false, error: accepted.error || 'Invalid invite code' }; }
		await this.joinExistingRoom(accepted.roomId);
		if (this._roomId !== accepted.roomId) { return { success: false, roomId: accepted.roomId, error: 'Could not enter the room' }; }
		return { success: true, roomId: accepted.roomId };
	}

	async login(email: string, password: string): Promise<{ success: boolean; error?: string }> {
		const server = await this._server();
		return new Promise((resolve) => {
			const xhr = new XMLHttpRequest();
			xhr.open('POST', `${server}/auth/login`, true);
			xhr.setRequestHeader('Content-Type', 'application/json');
			xhr.onload = () => {
				try {
					const data = JSON.parse(xhr.responseText);
					if (data.token) { this.setToken(data.token); resolve({ success: true }); }
					else { resolve({ success: false, error: data.error || 'Invalid email or password' }); }
				} catch { resolve({ success: false, error: 'Invalid server response' }); }
			};
			xhr.onerror = () => resolve({ success: false, error: 'Could not connect to server' });
			xhr.send(JSON.stringify({ email, password }));
		});
	}

	setRequestService(_requestService: IRequestService): void { }

}

export const livecollabService = new LiveCollabService();
