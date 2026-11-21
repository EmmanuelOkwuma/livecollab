/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, raceTimeout, RunOnceScheduler, timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { Schemas } from '../../../../../base/common/network.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Handler } from '../../../../../editor/common/editorCommon.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { lcLog } from '../../browser/livecollabLog.js';
import { ILiveCollabSnapshot, ILiveCollabTreeItem, LiveCollabService } from '../../browser/livecollabService.js';
import { LIVECOLLAB_SCHEME } from '../../browser/livecollabFileSystemProvider.js';
import { IBQuestion, createBClient, IBClient, IBEditor } from './livecollabBHarness.js';
import { roomTerminatedNotice } from '../../browser/livecollabRoomNotices.js';
import { ChatPart } from '../../browser/livecollabChat.js';
import { LiveCollabChatWidget } from '../../browser/livecollabChatWidget.js';
import { IApplicationStorageValueChangeEvent, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IChatDraftStorage, IChatDrafts, IStoredChatDraft, StoredChatDrafts } from '../../browser/livecollabChatDrafts.js';

/**
 * Layer B (TEST_HARNESS_TRIAGE.md): real LiveCollab clients in one process against a local
 * server. `scripts/livecollab-b.sh` starts the server and passes its address in
 * LIVECOLLAB_B_SERVER; without it (a plain unit run, or the browser runner) these suites skip.
 */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const serverUrl = env?.LIVECOLLAB_B_SERVER;
/** Whether the server under test filters cursors (scripts/livecollab-b.sh looks). */
const serverFiltersCursors = env?.LIVECOLLAB_B_CURSOR_FILTER === '1';

/** How long any one step may take against the local server. */
const STEP_MS = 5000;

/** A token the local server's Clerk stub accepts, naming the user `sub`. */
function testToken(sub: string): string {
	const payload = btoa(JSON.stringify({ sub, iat: 1, exp: 9e9 })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	return `x.${payload}.y`;
}

/** The clients' log lines in the current test, captured instead of written to the console. */
const logLines: string[] = [];

/** Waits for `event` to fire, or fails the step after STEP_MS with the log's last lines. */
async function next<T>(event: Event<T>, what: string): Promise<T> {
	// Wrapped, because a void event resolves to undefined, as a timeout does.
	const result = await raceTimeout(Event.toPromise(Event.map(event, value => ({ value }))), STEP_MS);
	if (result === undefined) {
		throw new Error(`layer B: timed out waiting for ${what}. The clients' last log lines:\n${logLines.slice(-20).join('\n')}`);
	}
	return result.value;
}

/** Waits until `check` holds, or fails the step after STEP_MS with the log's last lines. */
async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
	const deadline = Date.now() + STEP_MS;
	while (!await check()) {
		if (Date.now() > deadline) {
			throw new Error(`layer B: timed out waiting for ${what}. The clients' last log lines:\n${logLines.slice(-20).join('\n')}`);
		}
		await timeout(25);
	}
}

/** Every file and folder under `root` on one client's file system, folders marked with a trailing slash. */
async function listed(fileService: IFileService, root: URI): Promise<string[]> {
	const walk = async (uri: URI, base: string): Promise<string[]> => {
		const stat = await fileService.resolve(uri);
		const children = [...(stat.children ?? [])].sort((a, b) => a.name.localeCompare(b.name));
		const nested = await Promise.all(children.map(child => child.isDirectory
			? walk(child.resource, `${base}${child.name}/`).then(inner => [`${base}${child.name}/`, ...inner])
			: Promise.resolve([`${base}${child.name}`])));
		return nested.flat();
	};
	return walk(root, '');
}

/** Every path in a room tree, folders marked with a trailing slash. */
function paths(tree: readonly ILiveCollabTreeItem[], base = ''): string[] {
	return tree.flatMap(item => {
		const path = base ? `${base}/${item.name}` : item.name;
		return item.type === 'directory' ? [`${path}/`, ...paths(item.children ?? [], path)] : [path];
	});
}

(serverUrl ? suite : suite.skip)('LiveCollab B: real clients against a local server', function () {

	// Each step has its own STEP_MS limit and names itself when it runs out; a whole test is several steps.
	this.timeout(STEP_MS * 6);

	const signedIn: LiveCollabService[] = [];
	// Every test names its own users, so nothing carries over between tests on one server.
	let run = 0;

	// Registered before the leak check, so it runs first: the clients sign out
	// (closing their sockets) while the log is still captured, then the
	// console comes back, then the leak check sees everything disposed.
	let echo: IDisposable | undefined;

	// Each test's windows and editors, disposed in teardown while the log is still captured.
	let testStore: DisposableStore | undefined;

	teardown(async () => {
		for (const service of signedIn.splice(0)) {
			service.signOut();
		}
		testStore?.dispose();
		testStore = undefined;
		// Signing out starts the room's last writes (the persister's capture) and disposing an
		// editor re-runs its binding check; both log. Let them land in the captured log, not the console.
		await timeout(20);
		echo?.dispose();
		echo = undefined;
	});

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** Signs `service` in as `user` (as the account `sub`, a new one by default) and connects it to the local server. */
	async function signIn(service: LiveCollabService, user: string, sub = `${user}-${Date.now()}-${run}`): Promise<void> {
		signedIn.push(service);
		service.setToken(testToken(sub));
		const connected = next(service.onConnected, `${user} to connect`);
		await service.connect();
		await connected;
	}

	/** A real service, with the real socket.io client, connected to the local server as `user`. */
	async function client(user: string): Promise<LiveCollabService> {
		const service = store.add(new LiveCollabService(serverUrl));
		await signIn(service, user);
		return service;
	}

	/** Each window's account, so a restart signs in as the same one. */
	const accounts = new Map<IBClient, string>();

	/** A whole client window (livecollabBHarness.ts), signed in as `user`. */
	async function windowClient(user: string): Promise<IBClient> {
		const window = createBClient(serverUrl!, testStore!);
		const sub = `${user}-${Date.now()}-${run}`;
		accounts.set(window, sub);
		await signIn(window.service, user, sub);
		return window;
	}

	/**
	 * The app quit and opened again: a new window (a new service, folder contribution and id map,
	 * all empty), on the same disk and application storage, signed in as the same account. The old
	 * window must already be disconnected (the app quit). It rejoins the room and reopens the folder,
	 * as the app does on relaunch, and waits for the attach to be accepted.
	 */
	async function restart(old: IBClient, roomId: string, folder: URI, whileTheSnapshotIsHeld?: (window: IBClient) => Promise<void>): Promise<IBClient> {
		const window = createBClient(serverUrl!, testStore!, old.kept);
		accounts.set(window, accounts.get(old)!);
		await signIn(window.service, 'owner', accounts.get(old));
		if (whileTheSnapshotIsHeld) {
			window.network.delayIncomingEvent('room:snapshot', 800);
		}
		await window.service.joinExistingRoom(roomId);
		const count = (text: string) => logLines.filter(line => line.includes(text)).length;
		const [attached, refused] = [count('folder attached:'), count('room:attach FAILED')];
		await window.workspace.updateFolders(0, 0, [{ uri: folder }]);
		if (whileTheSnapshotIsHeld) {
			await whileTheSnapshotIsHeld(window);
			assert.strictEqual(count('folder attached:') > attached, false, 'the attach was answered before the held snapshot: this case isn\'t exercised');
		}
		await until(() => count('folder attached:') > attached || count('room:attach FAILED') > refused, 'the restarted owner\'s attach to be answered');
		assert.strictEqual(count('room:attach FAILED') > refused, false, 'the restarted owner\'s attach was refused');
		return window;
	}

	/**
	 * The owner makes a room and opens a folder in their window, which shares it (the folder
	 * contribution's attach); a guest joins by invite, and their window shows the room's folder.
	 */
	async function ownerSharesGuestJoins(files: Record<string, string>, beforeGuestJoins?: (guest: IBClient) => void | Promise<void>): Promise<{ owner: IBClient; guest: IBClient; roomId: string; folder: URI }> {
		const owner = await windowClient('owner');
		const roomId = await owner.service.createRoomNamed('layer-b');
		assert.ok(roomId, 'the server created no room');
		await owner.service.joinExistingRoom(roomId);
		const folder = URI.file(`/layer-b/run-${run}/project`);
		for (const [path, content] of Object.entries(files)) {
			// A path ending in / is an empty folder.
			if (path.endsWith('/')) {
				await owner.fileService.createFolder(URI.joinPath(folder, ...path.slice(0, -1).split('/')));
			} else {
				await owner.fileService.writeFile(URI.joinPath(folder, ...path.split('/')), VSBuffer.fromString(content));
			}
		}
		await owner.workspace.updateFolders(0, 0, [{ uri: folder }]);
		await until(async () => (await owner.service.getRoomFolder())?.hasFolder === true, 'the owner\'s folder to be shared');
		const invite = await owner.service.createInviteCode();

		const guest = await windowClient('guest');
		await beforeGuestJoins?.(guest);
		const joined = await guest.service.joinByCode(invite.code ?? '');
		assert.ok(joined.ok, `the guest could not join: ${joined.error}`);
		await guest.service.joinExistingRoom(roomId);
		await until(() => guest.workspace.getWorkspace().folders.some(f => f.uri.scheme === LIVECOLLAB_SCHEME), 'the guest\'s room folder');
		return { owner, guest, roomId, folder };
	}

	/** The room as a client that joins now is given it: its snapshot. */
	async function roomSnapshot(owner: IBClient, roomId: string): Promise<ILiveCollabSnapshot> {
		const invite = await owner.service.createInviteCode();
		const observer = await client('observer');
		await observer.joinByCode(invite.code ?? '');
		const snapshot = next<ILiveCollabSnapshot>(observer.onSnapshot, 'the observer\'s snapshot');
		await observer.joinExistingRoom(roomId);
		return snapshot;
	}

	/** The room as a client that joins now is given it: every path in its snapshot. */
	async function roomPaths(owner: IBClient, roomId: string): Promise<string[]> {
		return paths((await roomSnapshot(owner, roomId)).tree).sort();
	}

	/** Every "path=id" in a room tree. */
	function idsIn(tree: readonly ILiveCollabTreeItem[], base = ''): string[] {
		return tree.flatMap(item => {
			const path = base ? `${base}/${item.name}` : item.name;
			return [...item.id ? [`${path}=${item.id}`] : [], ...idsIn(item.children ?? [], path)];
		});
	}

	/**
	 * Matrix group 1 (ATTACH_RECONCILE_DESIGN.md, "The 22-case matrix"): both sides connected, one
	 * Explorer action on one side, through IWorkingCopyFileService as in the app. Asserts the room's
	 * state (the measured baseline) and the display half: the owner's disk and the guest's files.
	 */
	const matrixFolder = { 'a.txt': 'a', 'b.txt': 'b', 'd/c.txt': 'c', 'd/e.txt': 'e', 'p/q/r.txt': 'r', 'p/q/s.txt': 's' };
	const matrixBase = ['a.txt', 'b.txt', 'd/', 'd/c.txt', 'd/e.txt', 'p/', 'p/q/', 'p/q/r.txt', 'p/q/s.txt'];
	type Side = 'guest' | 'owner';
	interface IConnectedCase {
		readonly n: number;
		readonly name: string;
		readonly actor: Side;
		act(client: IBClient, root: URI): Promise<unknown>;
		readonly expected: string[];
	}
	const without = (...gone: string[]) => matrixBase.filter(path => !gone.includes(path));
	const connectedCases: IConnectedCase[] = [];
	for (const actor of ['guest', 'owner'] as const) {
		const first = actor === 'guest' ? 1 : 2;
		connectedCases.push(
			{ n: first, name: `${actor} creates new.txt`, actor, act: (c, root) => c.workingCopyFileService.create([{ resource: URI.joinPath(root, 'new.txt') }], CancellationToken.None), expected: [...matrixBase, 'new.txt'].sort() },
			{ n: first + 2, name: `${actor} renames a.txt to renamed.txt`, actor, act: (c, root) => c.workingCopyFileService.move([{ file: { source: URI.joinPath(root, 'a.txt'), target: URI.joinPath(root, 'renamed.txt') } }], CancellationToken.None), expected: [...without('a.txt'), 'renamed.txt'].sort() },
			{ n: first + 4, name: `${actor} deletes b.txt`, actor, act: (c, root) => c.workingCopyFileService.delete([{ resource: URI.joinPath(root, 'b.txt') }], CancellationToken.None), expected: without('b.txt') },
			{
				n: first + 6, name: `${actor} creates n/x.txt (a new folder)`, actor, act: async (c, root) => {
					await c.workingCopyFileService.createFolder([{ resource: URI.joinPath(root, 'n') }], CancellationToken.None);
					await c.workingCopyFileService.create([{ resource: URI.joinPath(root, 'n', 'x.txt') }], CancellationToken.None);
				}, expected: [...matrixBase, 'n/', 'n/x.txt'].sort()
			},
			{ n: first + 8, name: `${actor} deletes p/q/ (two files; p/ is left empty)`, actor, act: (c, root) => c.workingCopyFileService.delete([{ resource: URI.joinPath(root, 'p', 'q'), recursive: true }], CancellationToken.None), expected: without('p/q/', 'p/q/r.txt', 'p/q/s.txt') },
		);
	}

	for (const matrixCase of connectedCases.sort((a, b) => a.n - b.n)) {
		test(`matrix #${matrixCase.n}: ${matrixCase.name}, both connected`, async () => {
			const { owner, guest, roomId, folder } = await ownerSharesGuestJoins(matrixFolder);
			const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
			const actorClient = matrixCase.actor === 'guest' ? guest : owner;
			await matrixCase.act(actorClient, matrixCase.actor === 'guest' ? guestRoot : folder);
			const shown = async () => ({
				ownerDisk: (await listed(owner.fileService, folder)).sort(),
				guestFiles: (await listed(guest.fileService, guestRoot)).sort(),
			});
			// Both sides converge, or the step runs out and the assertion shows which side didn't.
			await until(async () => { const s = await shown(); return [s.ownerDisk, s.guestFiles].every(l => l.join() === matrixCase.expected.join()); }, 'both sides to show the change').catch(() => { });
			assert.deepStrictEqual({ ...await shown(), room: await roomPaths(owner, roomId) }, { ownerDisk: matrixCase.expected, guestFiles: matrixCase.expected, room: matrixCase.expected });
		});
	}

	/**
	 * Matrix group 2: the owner's connection drops, the guest acts, the owner's connection comes
	 * back (the app's reconnect: re-join, then the attach of its unchanged disk). #12, an edit, needs
	 * the editor half and waits for it.
	 */
	/**
	 * A known bug: the correct outcome is asserted and expected to fail. It passes while the bug is
	 * there and fails once it's gone, so whoever fixed it makes it a normal test. Only an assertion
	 * failure counts; a timeout or an error still fails the test. `what` names it, `record` is where
	 * it's written down.
	 */
	async function knownFailure(what: string, record: string, body: () => Promise<void>): Promise<void> {
		try {
			await body();
		} catch (e) {
			if (e instanceof assert.AssertionError) {
				return;
			}
			throw e;
		}
		throw new Error(`${what} now passes: the known bug is fixed. Make it a normal test and update ${record}.`);
	}

	/**
	 * Restores `owner`'s connection and waits for its re-attach to be accepted. A refused attach
	 * fails here, outside any knownFailure, so it can't pass as the known bug: the reconcile only
	 * runs on an accepted attach.
	 */
	async function restoreAndReattach(owner: IBClient): Promise<void> {
		const count = (text: string) => logLines.filter(line => line.includes(text)).length;
		const [attached, refused] = [count('folder attached:'), count('room:attach FAILED')];
		await owner.network.restore();
		await until(() => count('folder attached:') > attached || count('room:attach FAILED') > refused, 'the owner\'s re-attach to be answered');
		assert.strictEqual(count('room:attach FAILED') > refused, false, 'the owner\'s re-attach was refused');
	}

	const awayCases: { n: number; name: string; act(guest: IBClient, root: URI): Promise<unknown>; expected: string[] }[] = [
		{ n: 11, name: 'guest creates new.txt', act: (c, root) => c.workingCopyFileService.create([{ resource: URI.joinPath(root, 'new.txt') }], CancellationToken.None), expected: [...matrixBase, 'new.txt'].sort() },
		{ n: 13, name: 'guest renames a.txt to renamed.txt', act: (c, root) => c.workingCopyFileService.move([{ file: { source: URI.joinPath(root, 'a.txt'), target: URI.joinPath(root, 'renamed.txt') } }], CancellationToken.None), expected: [...without('a.txt'), 'renamed.txt'].sort() },
		{ n: 14, name: 'guest deletes b.txt', act: (c, root) => c.workingCopyFileService.delete([{ resource: URI.joinPath(root, 'b.txt') }], CancellationToken.None), expected: without('b.txt') },
		{
			n: 15, name: 'guest creates n/x.txt', act: async (c, root) => {
				await c.workingCopyFileService.createFolder([{ resource: URI.joinPath(root, 'n') }], CancellationToken.None);
				await c.workingCopyFileService.create([{ resource: URI.joinPath(root, 'n', 'x.txt') }], CancellationToken.None);
			}, expected: [...matrixBase, 'n/', 'n/x.txt'].sort()
		},
		{ n: 16, name: 'guest deletes p/q/', act: (c, root) => c.workingCopyFileService.delete([{ resource: URI.joinPath(root, 'p', 'q'), recursive: true }], CancellationToken.None), expected: without('p/q/', 'p/q/r.txt', 'p/q/s.txt') },
	];

	for (const matrixCase of awayCases) {
		test(`matrix #${matrixCase.n}: ${matrixCase.name} while the owner is away`, async () => {
			const { owner, guest, roomId, folder } = await ownerSharesGuestJoins(matrixFolder);
			const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
			await owner.network.drop();
			await matrixCase.act(guest, guestRoot);
			// The guest's event reaches the server over its own live socket; give it time to land.
			await timeout(300);
			await restoreAndReattach(owner);
			const shown = async () => ({
				ownerDisk: (await listed(owner.fileService, folder)).sort(),
				guestFiles: (await listed(guest.fileService, guestRoot)).sort(),
			});
			await until(async () => { const s = await shown(); return [s.ownerDisk, s.guestFiles].every(l => l.join() === matrixCase.expected.join()); }, 'both sides to show the change').catch(() => { });
			// Item 0: the room and the guest kept the change (the reconcile runs before the attach), and the
			// owner's disk followed it (a move made on disk, a removal sent to the Trash).
			assert.deepStrictEqual({ ...await shown(), room: await roomPaths(owner, roomId) }, { ownerDisk: matrixCase.expected, guestFiles: matrixCase.expected, room: matrixCase.expected });
		});
	}

	/**
	 * The restart gap (ATTACH_RECONCILE_DESIGN.md): the owner quits the app, a guest deletes or
	 * renames a file, the owner opens the app again. The new window's id map is empty; the copy saved
	 * across restarts is what tells the guest's change from a file new on disk.
	 */
	test('matrix: the guest deletes b.txt while the owner\'s app is closed; after the restart it stays deleted', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins(matrixFolder);
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		await owner.network.drop();
		await guest.workingCopyFileService.delete([{ resource: URI.joinPath(guestRoot, 'b.txt') }], CancellationToken.None);
		await timeout(300);
		const restarted = await restart(owner, roomId, folder);
		const expected = without('b.txt');
		await until(async () => (await listed(restarted.fileService, folder)).sort().join() === expected.join(), 'the owner\'s disk to follow').catch(() => { });
		assert.deepStrictEqual({
			room: await roomPaths(restarted, roomId),
			guestFiles: (await listed(guest.fileService, guestRoot)).sort(),
			ownerDisk: (await listed(restarted.fileService, folder)).sort(),
		}, { room: expected, guestFiles: expected, ownerDisk: expected });
	});

	test('matrix: the guest renames a.txt while the owner\'s app is closed; after the restart the file keeps its id', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins(matrixFolder);
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		const idBefore = owner.fileSystem.getServerFileId('a.txt');
		await owner.network.drop();
		await guest.workingCopyFileService.move([{ file: { source: URI.joinPath(guestRoot, 'a.txt'), target: URI.joinPath(guestRoot, 'renamed.txt') } }], CancellationToken.None);
		await timeout(300);
		const restarted = await restart(owner, roomId, folder);
		const expected = [...without('a.txt'), 'renamed.txt'].sort();
		await until(async () => (await listed(restarted.fileService, folder)).sort().join() === expected.join(), 'the owner\'s disk to follow').catch(() => { });
		const room = await roomSnapshot(restarted, roomId);
		assert.deepStrictEqual({
			room: paths(room.tree).sort(),
			keptId: idsIn(room.tree).includes(`renamed.txt=${idBefore}`),
			ownerDisk: (await listed(restarted.fileService, folder)).sort(),
		}, { room: expected, keptId: true, ownerDisk: expected });
	});

	/**
	 * The guard on the saved id map: after a restart, a room event can reach the new window before
	 * its attach compares (here, a guest's create while the room's snapshot is held). The one-entry
	 * map it makes must neither be saved over the whole copy nor trusted by the reconcile.
	 */
	test('matrix: after a restart, a room event before the attach compares doesn\'t replace the saved ids; b.txt stays deleted', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins(matrixFolder);
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		await owner.network.drop();
		await guest.workingCopyFileService.delete([{ resource: URI.joinPath(guestRoot, 'b.txt') }], CancellationToken.None);
		await timeout(300);
		const restarted = await restart(owner, roomId, folder, async window => {
			await guest.workingCopyFileService.create([{ resource: URI.joinPath(guestRoot, 'new.txt') }], CancellationToken.None);
			await until(() => window.fileSystem.getServerFileId('new.txt') !== undefined, 'the guest\'s create to reach the restarted owner');
		});
		const expected = [...without('b.txt'), 'new.txt'].sort();
		await until(async () => (await listed(restarted.fileService, folder)).sort().join() === expected.join(), 'the owner\'s disk to follow').catch(() => { });
		assert.deepStrictEqual({ room: await roomPaths(restarted, roomId), ownerDisk: (await listed(restarted.fileService, folder)).sort() }, { room: expected, ownerDisk: expected });
	});

	/** Every notice a window showed whose text includes `text`. */
	const noticesWith = (window: IBClient, text: string) => window.notices.filter(notice => notice.message.includes(text));

	/** Sets the name Clerk has for an account (the rig's stub; an empty name: an account with none). */
	async function nameInClerk(window: IBClient, name: string, metadataName?: string): Promise<void> {
		await fetch(`${serverUrl}/__rig/name`, { method: 'POST', body: JSON.stringify({ sub: accounts.get(window), name, metadataName }) });
	}

	/** The name `window`'s members panel shows for the member `userId`. */
	function shownName(window: IBClient, userId: string | undefined): string | undefined {
		const member = window.service.lastMembers.find(m => m.userId === userId);
		return member && (member.displayName || member.name);
	}

	/**
	 * A device credential for `window`'s account, made as the app's main process makes it (option F):
	 * a code from /auth/code for a PKCE challenge, exchanged with a P-256 public key. Returns a
	 * function that sends a signed device request.
	 */
	async function deviceCredential(window: IBClient): Promise<(path: string, extra: Record<string, string>) => Promise<Record<string, unknown>>> {
		const base64url = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		const base64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
		const post = async (path: string, body: object, headers: Record<string, string> = {}) => (await fetch(`${serverUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>;
		const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
		const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
		const { code } = await post('/auth/code', { challenge }, { Authorization: `Bearer ${testToken(accounts.get(window)!)}` });
		const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
		const publicKey = base64(await crypto.subtle.exportKey('spki', keys.publicKey));
		const { credentialId, credential } = await post('/auth/exchange', { code, verifier, publicKey });
		assert.ok(credentialId && credential, 'the exchange gave no credential');
		return async (path, extra) => {
			const timestamp = Date.now();
			const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
			const signature = base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(`${credentialId}.${timestamp}.${nonce}`)));
			return post(path, { ...extra, credentialId, credential, timestamp, nonce, signature });
		};
	}

	/** What Clerk (the rig's stand-in) has for `window`'s account. */
	async function clerkHas(window: IBClient): Promise<{ first_name: string; last_name: string; public_metadata: Record<string, unknown> }> {
		return (await fetch(`${serverUrl}/__rig/user?sub=${encodeURIComponent(accounts.get(window)!)}`)).json();
	}

	test('profile: a name set in the app\'s settings is LiveCollab\'s own, reaches everyone\'s members panel at once, and leaves Clerk\'s name alone', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const ownerId = owner.service.myUserId;
		// An older LiveCollab name (0.3.4's onboarding wrote one) is replaced by the new one.
		await nameInClerk(owner, 'Ada', 'Old Onboarding Name');
		const send = await deviceCredential(owner);
		const answer = await send('/auth/display-name', { displayName: '  Ada   Lovelace King ' });
		await until(() => shownName(guest, ownerId) === 'Ada Lovelace King', 'the guest\'s members panel to show the new name').catch(() => { });
		assert.deepStrictEqual({ answer, clerk: await clerkHas(owner), guestSees: shownName(guest, ownerId), ownerSees: shownName(owner, ownerId) }, {
			answer: { ok: true, displayName: 'Ada Lovelace King' },
			clerk: { first_name: 'Ada', last_name: '', public_metadata: { displayName: 'Ada Lovelace King' } },
			guestSees: 'Ada Lovelace King',
			ownerSees: 'Ada Lovelace King',
		});
	});

	test('dashboard: a room named like markup, or with ordinary punctuation, is created, renamed and listed exactly as typed; a name that can\'t be one is refused and the room keeps its name', async () => {
		const owner = await windowClient('owner');
		const markup = '<img src=x onerror="globalThis.__lcProof=1">';
		const punctuation = 'Tom & Jerry\'s "R&D" <draft>';
		const roomId = await owner.service.createRoomNamed(markup);
		assert.ok(roomId, 'the server created no room');
		const listed = async () => ((await owner.service.listMyRooms()) as { id: string; name: string }[]).find(r => r.id === roomId)?.name;
		const created = await listed();
		owner.network.ask('room:rename', { roomId, name: punctuation });
		await until(async () => await listed() === punctuation, 'the rename to be listed').catch(() => { });
		const renamed = await listed();
		const refused = {
			create: await owner.network.ask('room:create', { name: 'x'.repeat(101) }),
			createControl: await owner.network.ask('room:create', { name: 'bell' + String.fromCharCode(7) }),
			rename: await owner.network.ask('room:rename', { roomId, name: 'x'.repeat(101) }),
		};
		assert.deepStrictEqual({ created, renamed, refused, after: await listed() }, {
			created: markup, renamed: punctuation,
			refused: { create: { ok: false, error: 'bad_name' }, createControl: { ok: false, error: 'bad_name' }, rename: { ok: false, error: 'bad_name' } },
			after: punctuation,
		});
	});

	test('profile: a nickname saves however it\'s written: one word, underscores, all lowercase, or text that looks like markup, kept exactly and shown as text (Clerk requires a first and last name; a display name doesn\'t)', async () => {
		// One device credential for every name: the server allows few sign-in attempts a minute (isRateLimited).
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const ownerId = owner.service.myUserId;
		const send = await deviceCredential(owner);
		const markup = '<img src=x onerror="globalThis.__lcProof=1"> & "Ada"';
		const answers = [];
		let markupSeen: string | undefined;
		for (const displayName of ['__Manny', markup, 'manny', 'MANNY']) {
			answers.push(await send('/auth/display-name', { displayName }));
			if (displayName === markup) {
				await until(() => shownName(guest, ownerId) === markup, 'the guest\'s members panel to show the markup-like name').catch(() => { });
				markupSeen = shownName(guest, ownerId);
			}
		}
		await until(() => shownName(guest, ownerId) === 'MANNY', 'the guest\'s members panel to show the last name').catch(() => { });
		assert.deepStrictEqual({ answers, markupSeen, guestSees: shownName(guest, ownerId) }, {
			answers: [{ ok: true, displayName: '__Manny' }, { ok: true, displayName: markup }, { ok: true, displayName: 'manny' }, { ok: true, displayName: 'MANNY' }],
			markupSeen: markup,
			guestSees: 'MANNY',
		});
	});

	test('profile: a name changed on Clerk\'s page reaches the room when no LiveCollab name is set, and doesn\'t replace one that is', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const ownerId = owner.service.myUserId;
		const send = await deviceCredential(owner);
		await nameInClerk(owner, 'Ada Renamed On Clerk');
		// What the dashboard does when the app is focused after Clerk's page.
		const before = await send('/auth/session', {});
		await until(() => shownName(guest, ownerId) === 'Ada Renamed On Clerk', 'the guest\'s members panel to show the Clerk name').catch(() => { });
		const guestSawClerkName = shownName(guest, ownerId);
		await send('/auth/display-name', { displayName: 'ada' });
		await fetch(`${serverUrl}/__rig/name`, { method: 'POST', body: JSON.stringify({ sub: accounts.get(owner), name: 'Renamed Again On Clerk', metadataName: 'ada' }) });
		const after = await send('/auth/session', {});
		await timeout(200);
		assert.deepStrictEqual({ before: before.displayName, guestSawClerkName, after: after.displayName, guestSees: shownName(guest, ownerId) }, {
			before: 'Ada Renamed On Clerk',
			guestSawClerkName: 'Ada Renamed On Clerk',
			after: 'ada',
			guestSees: 'ada',
		});
	});

	test('profile: a name that can\'t be one is refused, and a request without a device credential changes nothing', async () => {
		const { owner } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const send = await deviceCredential(owner);
		const unsigned = await (await fetch(`${serverUrl}/auth/display-name`, { method: 'POST', body: JSON.stringify({ displayName: 'Mallory' }) })).json();
		assert.deepStrictEqual({
			empty: await send('/auth/display-name', { displayName: '   ' }),
			tooLong: await send('/auth/display-name', { displayName: 'x'.repeat(65) }),
			unsigned,
			clerk: (await clerkHas(owner)).first_name,
		}, {
			empty: { ok: false, reason: 'bad_name' },
			tooLong: { ok: false, reason: 'bad_name' },
			unsigned: { ok: false, reason: 'bad_credential' },
			clerk: accounts.get(owner),
		});
	});

	test('profile: someone with no name in Clerk shows as "Member" to the room, never as their email', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' }, guest => nameInClerk(guest, ''));
		// The room's snapshots after the join can come after the members list does. This test
		// is short enough to end first, and one landing after teardown logs "room:snapshot while
		// in no room" (the known flake, PLAN 2026-11-11): it ends once they have stopped.
		let lastSnapshot = Date.now();
		for (const window of [owner, guest]) {
			window.network.rewriteIncoming('room:snapshot', (...args) => { lastSnapshot = Date.now(); return args; });
		}
		const guestId = guest.service.myUserId;
		await until(() => shownName(owner, guestId) !== undefined, 'the owner\'s members panel to list the guest');
		assert.deepStrictEqual({ ownerSees: shownName(owner, guestId) }, { ownerSees: 'Member' });
		await until(() => Date.now() - lastSnapshot > 300, 'the room\'s snapshots to stop');
	});

	/** `user` joins the owner's room by invite and enters it. */
	async function joinsByInvite(owner: IBClient, roomId: string, user: string): Promise<IBClient> {
		const invite = await owner.service.createInviteCode();
		const window = await windowClient(user);
		const joined = await window.service.joinByCode(invite.code ?? '');
		assert.ok(joined.ok, `${user} could not join: ${joined.error}`);
		await window.service.joinExistingRoom(roomId);
		await until(() => shownName(owner, window.service.myUserId) !== undefined, `the owner's members panel to list ${user}`);
		return window;
	}

	/** The dashboard's own socket for `window`'s account: connected, in no room. Records what it's told. */
	async function dashboardSocket(window: IBClient): Promise<unknown[]> {
		// @ts-ignore the vendored bundle has no types; the app loads it the same way (livecollabService.ts)
		const { io } = await import('../../browser/vendor/socket.io.esm.min.js');
		const socket = io(serverUrl, { auth: (cb: (data: { token: string }) => void) => cb({ token: testToken(accounts.get(window)!) }), transports: ['websocket'] }) as { connected: boolean; on(event: string, listener: (payload: unknown) => void): void; disconnect(): void };
		testStore!.add({ dispose: () => socket.disconnect() });
		const heard: unknown[] = [];
		socket.on('room:removed', payload => heard.push(payload));
		await until(() => socket.connected, 'the dashboard socket to connect');
		return heard;
	}

	/** The notices `window` showed about membership: who joined, left, owns the room, or changed a role. */
	const membershipNotices = (window: IBClient) => window.notices.map(notice => notice.message).filter(message => / (joined|left) the room\.$| the owner of this room| made you | shared (the|a) folder/.test(message));

	test('members: the owner removes the guest; the guest is told at once who removed them, and the room ends for them; no one else is told', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const ownerName = shownName(guest, owner.service.myUserId);
		const ownerBefore = membershipNotices(owner).length;
		const ended = next(guest.service.onRoomTerminated, 'the guest\'s room to end');
		const answer = await owner.service.kickMember(guest.service.myUserId);
		const { reason, by } = await ended;
		// A room message already on its way reaches the removed window after its room ended and is
		// dropped (and logged); let it land in this test's log, not the next test's console.
		await timeout(300);
		assert.deepStrictEqual({ answer, reason, told: roomTerminatedNotice(reason, 'f-run-sheet', by), guestInRoom: guest.service.roomId, ownerTold: membershipNotices(owner).slice(ownerBefore) }, {
			answer: { ok: true },
			reason: 'kicked',
			told: `${isolated(ownerName)} removed you from ${isolated('f-run-sheet')}.`,
			guestInRoom: undefined,
			ownerTold: [],
		});
	});

	test('members: a removed member, in the room in two windows, receives nothing the room sends after the removal, even while the server is still looking up who removed them', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha' });
		const ownerEditor = await openBound(owner, URI.joinPath(folder, 'a.txt'));
		// The guest's second window: the same account, its own connection, in the room too.
		const guestAgain = createBClient(serverUrl!, testStore!);
		accounts.set(guestAgain, accounts.get(guest)!);
		await signIn(guestAgain.service, 'guest', accounts.get(guest));
		await guestAgain.service.joinExistingRoom(roomId);
		// The kick looks up the owner's name. Setting a name empties the server's cached one, and the
		// lookup is made slow, so the server is still waiting for it while the owner types.
		const send = await deviceCredential(owner);
		await send('/auth/display-name', { displayName: 'Remover' });
		const slowNames = (ms: number) => fetch(`${serverUrl}/__rig/slow-names`, { method: 'POST', body: JSON.stringify({ ms }) });
		await slowNames(800);
		try {
			const received = { guest: 0, guestAgain: 0 };
			for (const [window, key] of [[guest, 'guest'], [guestAgain, 'guestAgain']] as const) {
				window.network.rewriteIncoming('yjs:update', (...args) => { received[key]++; return args; });
			}
			const ended = Promise.all([guest, guestAgain].map(window => next(window.service.onRoomTerminated, 'a guest window\'s room to end')));
			let answered = false;
			const kicking = owner.service.kickMember(guest.service.myUserId).then(answer => { answered = true; return answer; });
			await timeout(300);
			const stillLookingUp = !answered;
			ownerEditor.type(' after removal');
			const answer = await kicking;
			await ended;
			await timeout(100);
			assert.deepStrictEqual({ stillLookingUp, answer, received, inRoom: [guest.service.roomId, guestAgain.service.roomId] }, {
				stillLookingUp: true,
				answer: { ok: true },
				received: { guest: 0, guestAgain: 0 },
				inRoom: [undefined, undefined],
			});
		} finally {
			await slowNames(0);
		}
	});

	test('members: someone removed while on the dashboard is told there at once, and by whom', async () => {
		const { owner, guest, roomId } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const ownerName = shownName(guest, owner.service.myUserId);
		const heard = await dashboardSocket(guest);
		await owner.service.kickMember(guest.service.myUserId);
		await until(() => heard.length > 0, 'the dashboard to be told').catch(() => { });
		await timeout(300); // as above: a late room message to the removed window lands in this test
		assert.deepStrictEqual(heard, [{ roomId, roomName: 'layer-b', by: ownerName }]);
	});

	test('members: the owner makes the guest a viewer, then an editor; only the guest is told, each time by whom and to what', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const ownerName = shownName(guest, owner.service.myUserId);
		const ownerBefore = membershipNotices(owner).length;
		const viewer = await owner.service.setMemberRole(guest.service.myUserId, 'viewer');
		await until(() => membershipNotices(guest).length === 1, 'the guest to be told').catch(() => { });
		const editor = await owner.service.setMemberRole(guest.service.myUserId, 'editor');
		await until(() => membershipNotices(guest).length === 2, 'the guest to be told again').catch(() => { });
		assert.deepStrictEqual({ viewer, editor, guestTold: membershipNotices(guest), ownerTold: membershipNotices(owner).slice(ownerBefore) }, {
			viewer: { ok: true },
			editor: { ok: true },
			guestTold: [`${isolated(ownerName)} made you a viewer. You can read this room's files but not change them.`, `${isolated(ownerName)} made you an editor. You can change this room's files.`],
			ownerTold: [],
		});
	});

	/**
	 * Server viewer enforcement (PLAN, after-session-batch): a viewer's own connection sends each
	 * kind of change directly, as a modified or older client could. The server refuses each before
	 * it changes the room, saves anything or tells anyone; the room's text and files are the same
	 * in memory and, after a restart, as stored. Made an editor again, the same connection's
	 * changes are taken and relayed, and the owner's are too.
	 */
	test('members: a viewer\'s document changes and file create, rename and delete, sent directly, are refused before the room changes, saves or relays them; editors and the owner still change it', async () => {
		const { owner, guest, roomId } = await ownerSharesGuestJoins({ 'a.txt': 'alpha', 'b.txt': 'beta' });
		const third = await joinsByInvite(owner, roomId, 'third');
		// @ts-ignore the vendored bundle has no types; the app loads it the same way (livecollabService.ts)
		const { Y } = await import('../../browser/vendor/livecollab-yjs.esm.min.js') as { Y: typeof import('yjs') };
		const aId = owner.fileSystem.getServerFileId('a.txt')!;
		const bId = owner.fileSystem.getServerFileId('b.txt')!;
		// What the room sends the owner and the third member from here on.
		const relayed: string[] = [];
		const record = (who: string, event: string) => (...args: unknown[]) => { relayed.push(`${who} ${event}`); return args; };
		for (const [who, window] of [['owner', owner], ['third', third]] as const) {
			for (const event of ['yjs:update', 'room:file:created', 'room:file:renamed', 'room:file:deleted']) {
				window.network.rewriteIncoming(event, record(who, event));
			}
		}
		/** The room's text of a file, as the room answers a rejoin check with no state of its own. */
		const roomText = async (window: IBClient, fileId: string) => {
			const answer = await window.network.ask<{ ok: boolean; update?: number[] }>('yjs:sync', { roomId, fileId, stateVector: [] });
			const doc = new Y.Doc();
			Y.applyUpdate(doc, new Uint8Array(answer.update ?? []));
			return doc.getText('content').toString();
		};
		/** A change appending `text` to the room's copy of a file. */
		const change = async (window: IBClient, fileId: string, text: string) => {
			const answer = await window.network.ask<{ ok: boolean; update?: number[] }>('yjs:sync', { roomId, fileId, stateVector: [] });
			const doc = new Y.Doc();
			Y.applyUpdate(doc, new Uint8Array(answer.update ?? []));
			const before = Y.encodeStateVector(doc);
			doc.getText('content').insert(doc.getText('content').length, text);
			return Array.from(Y.encodeStateAsUpdate(doc, before));
		};
		const room = async (window: IBClient) => ({ a: await roomText(window, aId), b: await roomText(window, bId), paths: await roomPaths(window, roomId) });

		assert.deepStrictEqual(await owner.service.setMemberRole(guest.service.myUserId, 'viewer'), { ok: true });
		await until(() => guest.service.myRole === 'viewer', 'the guest to be a viewer');
		const viewerSent = {
			update: await Promise.race([guest.network.ask('yjs:update', { roomId, fileId: aId, update: await change(guest, aId, ' viewer-update') }), timeout(1000).then(() => 'no answer')]),
			syncReply: await guest.network.ask('yjs:sync-reply', { roomId, fileId: aId, update: await change(guest, aId, ' viewer-reply') }),
			create: await guest.network.ask('room:file:create', { roomId, path: 'viewer-new.txt' }),
			rename: await guest.network.ask('room:file:rename', { roomId, fileId: bId, oldPath: 'b.txt', newPath: 'viewer-renamed.txt' }),
			delete: await guest.network.ask('room:file:delete', { roomId, fileId: aId, path: 'a.txt' }),
		};
		await timeout(300);
		const inMemory = await room(owner);
		const relayedToViewer = [...relayed];
		const gone = Promise.all([owner, guest, third].map(window => next(window.service.onDisconnected, 'a window to see the server go')));
		await restartServer({ downMs: 300 });
		await gone;
		await longUntil(() => owner.service.isConnected && guest.service.isConnected && third.service.isConnected, 'everyone to reconnect');
		await longUntil(async () => (await owner.network.ask<{ ok: boolean }>('yjs:sync', { roomId, fileId: aId, stateVector: [] })).ok, 'the owner to be back in the room');
		const stored = await room(owner);

		// Made an editor again: the same connection's changes are taken and relayed; so are the owner's and the third member's.
		relayed.length = 0;
		assert.deepStrictEqual(await owner.service.setMemberRole(guest.service.myUserId, 'editor'), { ok: true });
		await until(() => guest.service.myRole === 'editor', 'the guest to be an editor again');
		guest.network.ask('yjs:update', { roomId, fileId: aId, update: await change(guest, aId, ' editor-update') });
		const editorSent = { create: await guest.network.ask('room:file:create', { roomId, path: 'editor-new.txt' }) as { ok: boolean } };
		const ownerSent = { create: await owner.network.ask('room:file:create', { roomId, path: 'owner-new.txt' }) as { ok: boolean } };
		const thirdSent = { rename: await third.network.ask('room:file:rename', { roomId, fileId: bId, oldPath: 'b.txt', newPath: 'third-renamed.txt' }) as { ok: boolean } };
		await until(() => relayed.filter(line => line.endsWith('room:file:created')).length >= 3 && relayed.includes('owner room:file:renamed'), 'the editors\' changes to be relayed').catch(() => { });
		await timeout(300);
		for (const window of [owner, third]) {
			for (const event of ['yjs:update', 'room:file:created', 'room:file:renamed', 'room:file:deleted']) {
				window.network.rewriteIncoming(event, undefined);
			}
		}
		const unchanged = { a: 'alpha', b: 'beta', paths: ['a.txt', 'b.txt'] };
		assert.deepStrictEqual({
			viewerSent, relayedToViewer, inMemory, stored,
			afterEditors: { a: await roomText(owner, aId), paths: await roomPaths(owner, roomId), editor: editorSent.create.ok, owner: ownerSent.create.ok, third: thirdSent.rename.ok, relayed: [...new Set(relayed)].sort() },
		}, {
			// The app sends yjs:update with no answer function, so for it the refusal is only the server's
			// log line; sent with one, as here, the guard answers it. (Before the change: no answer, applied.)
			viewerSent: { update: { ok: false, error: 'read_only' }, syncReply: { ok: false, error: 'read_only' }, create: { ok: false, error: 'read_only' }, rename: { ok: false, error: 'read_only' }, delete: { ok: false, error: 'read_only' } },
			relayedToViewer: [],
			inMemory: unchanged,
			stored: unchanged,
			afterEditors: {
				a: 'alpha editor-update',
				paths: ['a.txt', 'editor-new.txt', 'owner-new.txt', 'third-renamed.txt'],
				editor: true, owner: true, third: true,
				relayed: ['owner room:file:created', 'owner room:file:renamed', 'owner yjs:update', 'third room:file:created', 'third room:file:renamed', 'third yjs:update'],
			},
		});
	}).timeout(STEP_MS * 12);

	/**
	 * A member edits offline as an editor and is made a viewer before reconnecting. The room still
	 * refuses those changes (the server's viewer check), and the member is told why: they no longer
	 * have edit permission, not that the room couldn't save. The changes stay in their own window,
	 * where they can copy them; nothing reaches the room.
	 */
	test('members: changes made offline by someone made a viewer meanwhile are refused by the room, the member is told they no longer have edit permission, and the changes stay in their window to copy', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha' });
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		const ownerA = await openBound(owner, URI.joinPath(folder, 'a.txt'));
		const guestA = await openBound(guest, URI.joinPath(guestRoot, 'a.txt'));
		guestA.type(' x');
		await shows(ownerA, ' x');
		const told: Array<{ path: string | undefined; reason: string }> = [];
		testStore!.add(guest.service.onSyncFailed(({ path, reason }) => told.push({ path: path?.split('/').pop(), reason })));
		const noticesBefore = guest.notices.length;
		await guest.network.drop();
		guestA.type(' offline');
		assert.deepStrictEqual(await owner.service.setMemberRole(guest.service.myUserId, 'viewer'), { ok: true });
		await guest.network.restore();
		await longUntil(() => guest.service.isConnected && guest.service.myRole === 'viewer', 'the guest to reconnect as a viewer');
		// Refused by the rejoin check, then again by its retry: then announced.
		await longUntil(() => told.length > 0, 'the guest to be told').catch(() => { });
		const disk = async () => (await owner.fileService.readFile(URI.joinPath(folder, 'a.txt'))).value.toString();
		assert.deepStrictEqual({
			told,
			notices: guest.notices.slice(noticesBefore).map(notice => notice.message).filter(message => message.includes('a.txt')),
			guest: guestA.text(),
			owner: ownerA.text(),
			ownerDisk: await disk(),
		}, {
			told: [{ path: 'a.txt', reason: 'read_only' }],
			notices: ['You no longer have edit permission in this room, so your changes to \'a.txt\' weren\'t added to it. They are still in your window, and nowhere else: copy them somewhere before you close the file.'],
			guest: 'alpha x offline',
			owner: 'alpha x',
			ownerDisk: 'alpha x',
		});
	}).timeout(STEP_MS * 20);

	/**
	 * The owner sending a refused move back marks it `correction: true` (livecollabContainment.ts,
	 * MoveCorrections), and no client answers a flagged rename with another correction. The flag only
	 * protects anyone if the room passes it on: the server relays it in room:file:renamed, and only
	 * when it was sent as `true`.
	 */
	test('rename: a rename sent as a correction reaches the room marked as one; an ordinary rename, or a flag that isn\'t true, carries no mark', async () => {
		const { owner, guest, roomId } = await ownerSharesGuestJoins({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
		const heard: { oldPath: string; newPath: string; correction?: unknown }[] = [];
		guest.network.rewriteIncoming('room:file:renamed', (...args: unknown[]) => {
			const p = args[0] as { oldPath: string; newPath: string; correction?: unknown };
			heard.push(Object.keys(p).includes('correction') ? { oldPath: p.oldPath, newPath: p.newPath, correction: p.correction } : { oldPath: p.oldPath, newPath: p.newPath });
			return args;
		});
		const rename = (path: string, newPath: string, extra: Record<string, unknown>) => owner.network.ask<{ ok: boolean }>('room:file:rename', { roomId, fileId: owner.fileSystem.getServerFileId(path)!, oldPath: path, newPath, ...extra });
		const sent = [
			(await rename('a.txt', 'a-back.txt', { correction: true })).ok,
			(await rename('b.txt', 'b-moved.txt', {})).ok,
			(await rename('c.txt', 'c-moved.txt', { correction: 'yes' })).ok,
		];
		await until(() => heard.length >= 3, 'the guest to hear the three renames').catch(() => { });
		guest.network.rewriteIncoming('room:file:renamed', undefined);
		assert.deepStrictEqual({ sent, heard }, {
			sent: [true, true, true],
			heard: [
				{ oldPath: 'a.txt', newPath: 'a-back.txt', correction: true },
				{ oldPath: 'b.txt', newPath: 'b-moved.txt' },
				{ oldPath: 'c.txt', newPath: 'c-moved.txt' },
			],
		});
	}).timeout(STEP_MS * 4);

	test('members: the owner transfers ownership; the new owner is told by whom, the rest of the room who owns it now, and the old owner nothing', async () => {
		const { owner, guest, roomId } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const third = await joinsByInvite(owner, roomId, 'third');
		const ownerName = shownName(guest, owner.service.myUserId);
		const guestName = shownName(owner, guest.service.myUserId);
		const before = { owner: membershipNotices(owner).length, guest: membershipNotices(guest).length, third: membershipNotices(third).length };
		const answer = await owner.service.transferOwnership(guest.service.myUserId);
		await until(() => membershipNotices(guest).length > before.guest && membershipNotices(third).length > before.third, 'the new owner and the third member to be told').catch(() => { });
		await timeout(200);
		assert.deepStrictEqual({
			answer,
			roles: [owner.service.myRole, guest.service.myRole],
			newOwnerTold: membershipNotices(guest).slice(before.guest),
			thirdTold: membershipNotices(third).slice(before.third),
			oldOwnerTold: membershipNotices(owner).slice(before.owner),
		}, {
			answer: { ok: true },
			roles: ['editor', 'owner'],
			newOwnerTold: [`${isolated(ownerName)} made you the owner of this room. You now decide who's in it and what they can do. The room keeps its files; connecting a folder of yours to it isn't supported yet.`],
			thirdTold: [`${isolated(ownerName)} made ${isolated(guestName)} the owner of this room.`],
			oldOwnerTold: [],
		});
	});

	test('members: after a transfer, no folder follows the room: the old owner\'s disk stops receiving it and the new owner\'s folder is refused (what the confirmation says; host independence closes it)', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha' });
		await owner.service.transferOwnership(guest.service.myUserId);
		await until(() => guest.service.myRole === 'owner' && owner.service.myRole === 'editor', 'the roles to change');
		await guest.workingCopyFileService.create([{ resource: URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/after.txt' }) }], CancellationToken.None);
		await until(async () => (await roomPaths(owner, roomId)).includes('after.txt'), 'the new file in the room');
		await timeout(300);
		const newOwnerFolder = URI.file(`/layer-b/run-${run}/new-owner`);
		await guest.fileService.writeFile(URI.joinPath(newOwnerFolder, 'mine.txt'), VSBuffer.fromString('mine'));
		await guest.workspace.updateFolders(0, guest.workspace.getWorkspace().folders.length, [{ uri: newOwnerFolder }]);
		await until(() => noticesWith(guest, 'already sharing a different folder').length > 0, 'the new owner\'s folder to be answered').catch(() => { });
		assert.deepStrictEqual({
			oldOwnersDisk: await listed(owner.fileService, folder),
			room: await roomPaths(owner, roomId),
			newOwnerRefused: noticesWith(guest, 'already sharing a different folder').length,
		}, {
			oldOwnersDisk: ['a.txt'],
			room: ['a.txt', 'after.txt'],
			newOwnerRefused: 1,
		});
	});

	test('invites: an editor creates an invite from the members panel, and someone joins the room with it as an editor', async () => {
		const { owner, guest, roomId } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const invite = await guest.service.createInviteCode();
		const third = await windowClient('third');
		const joined = await third.service.joinByCode(invite.code ?? '');
		await third.service.joinExistingRoom(roomId);
		await until(() => shownName(owner, third.service.myUserId) !== undefined, 'the owner\'s members panel to list the newcomer').catch(() => { });
		assert.deepStrictEqual({ guestRole: guest.service.myRole, created: invite.success, joined: joined.ok, newcomerRole: third.service.myRole }, { guestRole: 'editor', created: true, joined: true, newcomerRole: 'editor' });
	});

	test('members: someone joins by invite, then leaves; everyone else in the room is told, by name, in the notification center (the chat\'s line is the visible one, so no toast covers the composer), and the one who came and went is not', async () => {
		const { owner, guest, roomId } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const before = { owner: membershipNotices(owner).length, guest: membershipNotices(guest).length };
		const third = await joinsByInvite(owner, roomId, 'third');
		const thirdName = shownName(owner, third.service.myUserId);
		await until(() => membershipNotices(guest).length > before.guest, 'the guest to be told who joined').catch(() => { });
		const left = await third.service.leaveRoom();
		await until(() => membershipNotices(guest).length > before.guest + 1 && membershipNotices(owner).length > before.owner + 1, 'both to be told who left').catch(() => { });
		const toasts = (window: IBClient) => window.notices.filter(notice => / (joined|left) the room\.$/.test(notice.message) && !notice.silent).length;
		assert.deepStrictEqual({ left: left.ok, ownerTold: membershipNotices(owner).slice(before.owner), guestTold: membershipNotices(guest).slice(before.guest), thirdTold: membershipNotices(third), toasts: toasts(owner) + toasts(guest) }, {
			left: true,
			toasts: 0,
			ownerTold: [`${isolated(thirdName)} joined the room.`, `${isolated(thirdName)} left the room.`],
			guestTold: [`${isolated(thirdName)} joined the room.`, `${isolated(thirdName)} left the room.`],
			thirdTold: [],
		});
	});

	/**
	 * A window's chat log, one line per entry: "name: text" for a message (a file tag as [path], a
	 * person tag as @name, "(edited)" once edited), "name joined" or "name left" for the lines.
	 */
	function chatLog(window: IBClient): string[] {
		return window.service.chat.messages.map(m => m.kind === 'message'
			? `${m.authorName}: ${m.parts.map(p => p.type === 'text' ? p.text : p.type === 'file' ? `[${p.path}]` : `@${p.name}`).join('')}${m.editedAt ? ' (edited)' : ''}`
			: `${m.authorName} ${m.kind}`);
	}
	/** A name as a sentence shows it: between FSI and PDI (U+2068, U+2069), in its own direction. */
	function isolated(name: string | undefined): string {
		return `${String.fromCharCode(0x2068)}${name}${String.fromCharCode(0x2069)}`;
	}
	function say(text: string): ChatPart[] {
		return [{ type: 'text', text }];
	}
	async function chatLoaded(...windows: IBClient[]): Promise<void> {
		await until(() => windows.every(w => w.service.chat.loaded), 'the chat logs to load');
	}

	test('chat: a message reaches everyone in the room once, under its author\'s name, its request key only to the author; sending marks nothing read; unread counts others\' messages until they are read', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		await chatLoaded(owner, guest);
		const [ownerName, guestName] = [shownName(guest, owner.service.myUserId), shownName(owner, guest.service.myUserId)];
		await owner.service.chat.send(say('hello'));
		await until(() => chatLog(guest).includes(`${ownerName}: hello`), 'the guest to see hello');
		await guest.service.chat.send(say('hi'));
		await until(() => chatLog(owner).includes(`${guestName}: hi`), 'the owner to see hi');
		const afterSending = { owner: owner.service.chat.unread, guest: guest.service.chat.unread };
		// A request key goes only to its sender's own windows: the guest's copy of the owner's message has none, live or from history.
		const hello = (window: IBClient) => window.service.chat.messages.find(m => m.kind === 'message' && m.authorId === owner.service.myUserId);
		const hasKey = (window: IBClient) => Object.keys(hello(window) ?? {}).includes('requestKey');
		const liveKeys = { owner: typeof hello(owner)?.requestKey, guest: hasKey(guest) };
		await guest.service.chat.load();
		const historyKey = hasKey(guest);
		await owner.service.chat.markRead();
		await guest.service.chat.markRead();
		const expected = [`${guestName} joined`, `${ownerName}: hello`, `${guestName}: hi`];
		assert.deepStrictEqual({ owner: chatLog(owner), guest: chatLog(guest), afterSending, afterReading: { owner: owner.service.chat.unread, guest: guest.service.chat.unread }, pending: owner.service.chat.pending.length + guest.service.chat.pending.length, liveKeys, historyKey }, {
			owner: expected, guest: expected, afterSending: { owner: 1, guest: 1 }, afterReading: { owner: 0, guest: 0 }, pending: 0, liveKeys: { owner: 'string', guest: false }, historyKey: false,
		});
	});

	test('chat: a send the server saved but whose answer was lost shows as not sent; once back, it is one entry everywhere, and a retry with the same key adds nothing', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		await chatLoaded(owner, guest);
		const guestName = shownName(owner, guest.service.myUserId);
		// The answer is lost, and so is the guest's own copy of the room's broadcast: the connection drops after the save.
		await rigSwitch('drop-chat-answers', true);
		guest.network.rewriteIncoming('chat:message', () => [{ roomId: 'not-this-room' }]);
		let lost: Awaited<ReturnType<typeof guest.service.chat.send>>;
		let whileAway: { state: string; error?: string; text: string }[];
		try {
			const sending = guest.service.chat.send(say('did this go?'));
			await until(() => chatLog(owner).includes(`${guestName}: did this go?`), 'the owner to see the saved message');
			await guest.network.drop();
			lost = await sending;
			whileAway = guest.service.chat.pending.map(p => ({ state: p.state, error: p.error, text: p.parts.map(part => part.type === 'text' ? part.text : '').join('') }));
		} finally {
			await rigSwitch('drop-chat-answers', false);
			guest.network.rewriteIncoming('chat:message', undefined);
		}
		const key = guest.service.chat.pending[0]?.requestKey;
		await guest.network.restore();
		await until(() => chatLog(guest).includes(`${guestName}: did this go?`) && guest.service.chat.pending.length === 0, 'the guest\'s log to show it, and the not-sent entry to go');
		const again = await guest.service.chatRequest<{ ok?: boolean }>('chat:send', { parts: say('did this go?'), requestKey: key });
		await owner.service.chat.load();
		const count = (window: IBClient) => chatLog(window).filter(line => line === `${guestName}: did this go?`).length;
		assert.deepStrictEqual({ lost: lost.ok || lost.error, whileAway, retried: typeof again === 'object' && again.ok, owner: count(owner), guest: count(guest) }, {
			lost: 'no_answer', whileAway: [{ state: 'notSent', error: 'no_answer', text: 'did this go?' }], retried: true, owner: 1, guest: 1,
		});
	});

	test('chat: back after more than a page was said, and with an edit and a delete meanwhile: the log has every message, in order, as it now stands', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		await chatLoaded(owner, guest);
		const ownerName = shownName(guest, owner.service.myUserId);
		const early = await owner.service.chat.send(say('early'));
		const doomed = await owner.service.chat.send(say('to be deleted'));
		await until(() => chatLog(guest).includes(`${ownerName}: to be deleted`), 'the guest to see the first two');
		assert.ok(early.ok && doomed.ok);
		await guest.network.drop();
		await owner.service.chat.edit(early.message.id, say('early, edited'), early.message.revision);
		await owner.service.chat.delete([doomed.message.id], 'everyone');
		for (let i = 1; i <= 60; i++) {
			await owner.service.chat.send(say(`m${i}`));
		}
		await guest.network.restore();
		await until(() => chatLog(guest).includes(`${ownerName}: m60`), 'the guest to catch up');
		const messages = (window: IBClient) => chatLog(window).filter(line => line.includes(':'));
		assert.deepStrictEqual({ guest: messages(guest), sameAsOwner: JSON.stringify(messages(guest)) === JSON.stringify(messages(owner)), unread: guest.service.chat.unread }, {
			guest: [`${ownerName}: early, edited (edited)`, ...Array.from({ length: 60 }, (_, i) => `${ownerName}: m${i + 1}`)], sameAsOwner: true, unread: 61,
		});
	});

	test('chat: joining and leaving show as lines in everyone\'s log, by name; someone who left can\'t be tagged', async () => {
		const { owner, guest, roomId } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const third = await joinsByInvite(owner, roomId, 'third');
		const thirdName = shownName(owner, third.service.myUserId);
		await chatLoaded(owner, guest, third);
		const left = await third.service.leaveRoom();
		await until(() => chatLog(owner).includes(`${thirdName} left`) && chatLog(guest).includes(`${thirdName} left`), 'both to see the left line');
		const tagTheLeaver = await guest.service.chat.send([{ type: 'person', userId: third.service.myUserId }]);
		const guestName = shownName(owner, guest.service.myUserId);
		const expected = [`${guestName} joined`, `${thirdName} joined`, `${thirdName} left`];
		assert.deepStrictEqual({ left: left.ok, owner: chatLog(owner), guest: chatLog(guest), thirdHolds: third.service.chat.messages.length, tagTheLeaver: tagTheLeaver.ok || tagTheLeaver.error }, { left: true, owner: expected, guest: expected, thirdHolds: 0, tagTheLeaver: 'unknown_person' });
	});

	test('chat: an edit shows in place for everyone; delete for everyone takes only your own; delete for me hides only from you; a re-join agrees', async () => {
		const { owner, guest, roomId } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		await chatLoaded(owner, guest);
		const [ownerName, guestName] = [shownName(guest, owner.service.myUserId), shownName(owner, guest.service.myUserId)];
		const first = await owner.service.chat.send(say('frist'));
		const second = await owner.service.chat.send(say('typo here'));
		const third = await guest.service.chat.send(say('ok'));
		assert.ok(first.ok && second.ok && third.ok);
		await owner.service.chat.edit(first.message.id, say('first'), first.message.revision);
		const notYours = await guest.service.chat.delete([second.message.id], 'everyone');
		await owner.service.chat.delete([second.message.id], 'everyone');
		await guest.service.chat.delete([first.message.id], 'me');
		await until(() => chatLog(guest).length === 2 && chatLog(owner).length === 3, 'the deletes to reach both');
		const live = { owner: chatLog(owner), guest: chatLog(guest) };
		await guest.service.leaveRoom().catch(() => undefined);
		const back = await joinsByInvite(owner, roomId, 'guest-again');
		await chatLoaded(back);
		assert.deepStrictEqual({ notYours: notYours.ok ? 'deleted' : notYours.error, live, ownerKept: owner.service.chat.messages.find(m => m.id === first.message.id)?.editedAt !== null, newcomer: chatLog(back).filter(line => line.includes(':')) }, {
			notYours: 'not_yours',
			live: { owner: [`${guestName} joined`, `${ownerName}: first (edited)`, `${guestName}: ok`], guest: [`${guestName} joined`, `${guestName}: ok`] },
			ownerKept: true,
			newcomer: [`${ownerName}: first (edited)`, `${guestName}: ok`],
		});
	});

	test('chat: a file tag carries the room\'s own path; a file the room doesn\'t have, or someone outside it, is refused', async () => {
		const { owner, guest, roomId } = await ownerSharesGuestJoins({ 'a.txt': 'a', 'd/c.txt': 'c' });
		const ids = Object.fromEntries(idsIn((await roomSnapshot(owner, roomId)).tree).map(entry => entry.split('=')));
		await chatLoaded(owner, guest);
		const ownerName = shownName(guest, owner.service.myUserId);
		const tagged = await guest.service.chat.send([{ type: 'text', text: 'see ' }, { type: 'file', fileId: ids['d/c.txt'], name: 'not-this.txt', path: 'not/this.txt' }, { type: 'text', text: ' ' }, { type: 'person', userId: owner.service.myUserId }]);
		const noFile = await guest.service.chat.send([{ type: 'file', fileId: 'no-such-file' }]);
		const noPerson = await guest.service.chat.send([{ type: 'person', userId: 'someone-else' }]);
		await until(() => chatLog(owner).some(line => line.includes('see ')), 'the owner to see the tagged message');
		assert.deepStrictEqual({ owner: chatLog(owner).filter(line => line.includes(':')), noFile: noFile.ok || noFile.error, noPerson: noPerson.ok || noPerson.error, sentOk: tagged.ok }, {
			owner: [`${shownName(owner, guest.service.myUserId)}: see [d/c.txt] @${ownerName}`], noFile: 'unknown_file', noPerson: 'unknown_person', sentOk: true,
		});
	});

	test('chat: offline, a send shows as not sent with its text and tags kept, and nothing sends it on its own; Retry posts it once, Discard drops it', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		await chatLoaded(owner, guest);
		const [ownerName, guestName] = [shownName(guest, owner.service.myUserId), shownName(owner, guest.service.myUserId)];
		await guest.network.drop();
		const offline = await guest.service.chat.send([{ type: 'text', text: 'ping ' }, { type: 'person', userId: owner.service.myUserId }]);
		await guest.service.chat.send(say('never mind'));
		await owner.service.chat.send(say('while you were out'));
		await guest.network.restore();
		await until(() => chatLog(guest).includes(`${ownerName}: while you were out`), 'the guest to see what was said while offline');
		const pendingAfterReconnect = guest.service.chat.pending.map(p => ({ state: p.state, error: p.error, parts: p.parts }));
		const [first, second] = guest.service.chat.pending.map(p => p.requestKey);
		guest.service.chat.discard(second);
		const retried = await guest.service.chat.retry(first);
		await until(() => chatLog(owner).some(line => line.startsWith(`${guestName}: ping`)), 'the owner to see the retried message');
		assert.deepStrictEqual({ offline: offline.ok || offline.error, pendingAfterReconnect, retried: retried.ok, pendingAfter: guest.service.chat.pending.length, owner: chatLog(owner).filter(line => line.includes(':')) }, {
			offline: 'offline',
			pendingAfterReconnect: [
				{ state: 'notSent', error: 'offline', parts: [{ type: 'text', text: 'ping ' }, { type: 'person', userId: owner.service.myUserId }] },
				{ state: 'notSent', error: 'offline', parts: say('never mind') },
			],
			retried: true, pendingAfter: 0,
			owner: [`${ownerName}: while you were out`, `${guestName}: ping @${ownerName}`],
		});
	});

	test('chat: a message the database fails to save is not sent (not_saved), reaches no one, and posts once when retried', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		await chatLoaded(owner, guest);
		await rigSwitch('fail-chat', true);
		let failed: Awaited<ReturnType<typeof owner.service.chat.send>>;
		try {
			failed = await owner.service.chat.send(say('not saved'));
		} finally {
			await rigSwitch('fail-chat', false);
		}
		const pending = owner.service.chat.pending.map(p => `${p.state} ${p.error}`);
		const seenBefore = chatLog(guest).filter(line => line.includes(':')).length;
		await owner.service.chat.retry(owner.service.chat.pending[0].requestKey);
		await until(() => chatLog(guest).some(line => line.endsWith(': not saved')), 'the guest to see the retried message');
		assert.deepStrictEqual({ failed: failed.ok || failed.error, pending, seenBefore, guest: chatLog(guest).filter(line => line.includes(':')).map(line => line.split(': ')[1]) }, { failed: 'not_saved', pending: ['notSent not_saved'], seenBefore: 0, guest: ['not saved'] });
	});

	/** The chat view's widget, mounted in this test window for `window`, with a host that records what it was asked to do. */
	interface IMountedChat {
		readonly widget: LiveCollabChatWidget;
		readonly opened: URI[];
		readonly copied: string[];
		readonly focus: { value: boolean };
		readonly container: HTMLElement;
	}
	function mountChat(window: IBClient, height = '480px', drafts?: IChatDrafts): IMountedChat {
		const container = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		container.style.cssText = `position: fixed; left: 0; top: 0; width: 420px; height: ${height};`;
		testStore!.add(toDisposable(() => container.remove()));
		const mounted = { opened: [] as URI[], copied: [] as string[], focus: { value: true } };
		const widget = testStore!.add(new LiveCollabChatWidget(container, window.service, window.fileSystem, {
			openFile: resource => mounted.opened.push(resource),
			openLink: () => { },
			copy: text => mounted.copied.push(text),
			hover: (element, text) => { element.title = text; return toDisposable(() => { }); },
			hasFocus: () => mounted.focus.value,
		}, drafts ?? testStore!.add(new StoredChatDrafts(window.kept.storage))));
		return { widget, container, ...mounted };
	}
	/** What the chat view shows, one entry per row: "Name: text" where a run starts, "  text" inside one; a file pill as [name|state]. */
	function shown(chat: IMountedChat): string[] {
		const textOf = (element: Element | null): string => Array.from(element?.childNodes ?? []).map(node => {
			const el = node as HTMLElement;
			if (el.classList?.contains('livecollab-chat-file')) {
				return `[${el.textContent}|${[...el.classList].find(c => c !== 'livecollab-chat-file')}]`;
			}
			return node.textContent ?? '';
		}).join('');
		return Array.from(chat.widget.element.querySelectorAll('.livecollab-chat-message, .livecollab-chat-line, .livecollab-chat-divider, .livecollab-chat-empty')).map(row => {
			if (row.classList.contains('livecollab-chat-divider')) {
				return '--- New ---';
			}
			if (row.classList.contains('livecollab-chat-empty')) {
				return `(empty) ${row.textContent}`;
			}
			if (row.classList.contains('livecollab-chat-line')) {
				return row.firstElementChild?.textContent ?? '';
			}
			const name = row.querySelector('.livecollab-chat-name')?.textContent;
			const status = row.querySelector('.livecollab-chat-status')?.textContent;
			const text = textOf(row.querySelector('.livecollab-chat-text'));
			return `${name ? `${name}: ` : '  '}${text}${status ? ` | ${status}` : ''}`;
		});
	}
	/** Clicks the button labelled `label` in the row whose text includes `text` (or in the selection bar). */
	function click(chat: IMountedChat, text: string | undefined, label: string): void {
		const scope = text === undefined
			? [chat.widget.element.querySelector('.livecollab-chat-select-bar')!]
			: Array.from(chat.widget.element.querySelectorAll('.livecollab-chat-message')).filter(row => row.querySelector('.livecollab-chat-text')?.textContent?.includes(text));
		const button = scope.flatMap(row => Array.from(row.querySelectorAll('button'))).find(b => b.textContent === label);
		assert.ok(button, `no ${label} button${text === undefined ? '' : ` on "${text}"`}`);
		button.click();
	}
	function type(chat: IMountedChat, text: string): void {
		chat.widget.insert(text);
	}

	test('chat view: no room, then the room\'s log; an unread divider and count while the reader isn\'t looking; looking reads it; the divider goes when the view is next opened', async () => {
		let guestChat: IMountedChat | undefined;
		let beforeJoining: string[] = [];
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' }, window => {
			guestChat = mountChat(window);
			beforeJoining = shown(guestChat);
		});
		const ownerChat = mountChat(owner);
		await chatLoaded(owner, guest);
		const [ownerName, guestName] = [shownName(guest, owner.service.myUserId)!, shownName(owner, guest.service.myUserId)!];
		guestChat!.focus.value = false;
		type(ownerChat, 'hello');
		ownerChat.widget.sendComposer();
		await until(() => shown(guestChat!).some(row => row.includes('hello')), 'the guest\'s view to show hello');
		const unseen = { rows: shown(guestChat!), unread: guest.service.chat.unread, jump: guestChat!.widget.element.querySelector('.livecollab-chat-jump')?.textContent };
		guestChat!.focus.value = true;
		guestChat!.widget.setVisible(true);
		await until(() => guest.service.chat.unread === 0, 'the guest\'s read position to move once they look');
		const looked = shown(guestChat!);
		guestChat!.widget.setVisible(false);
		guestChat!.widget.setVisible(true);
		assert.deepStrictEqual({ beforeJoining, unseen, looked, reopened: shown(guestChat!), owner: shown(ownerChat) }, {
			beforeJoining: ['(empty) Chat opens with a room: join or create one from the dashboard.'],
			unseen: { rows: [`${isolated(guestName)} joined the room`, '--- New ---', `${ownerName}: hello`], unread: 1, jump: '1 new ↓' },
			looked: [`${isolated(guestName)} joined the room`, '--- New ---', `${ownerName}: hello`],
			reopened: [`${isolated(guestName)} joined the room`, `${ownerName}: hello`],
			owner: [`${isolated(guestName)} joined the room`, `${ownerName}: hello`],
		});
	});

	test('chat view: offline, each send shows Not sent with why, and Retry and Discard; Retry posts it once, Discard removes it', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const [ownerChat, guestChat] = [mountChat(owner), mountChat(guest)];
		await chatLoaded(owner, guest);
		const guestName = shownName(owner, guest.service.myUserId)!;
		await guest.network.drop();
		type(guestChat, 'first');
		guestChat.widget.sendComposer();
		type(guestChat, 'second');
		guestChat.widget.sendComposer();
		await until(() => guest.service.chat.pending.every(p => p.state === 'notSent') && guest.service.chat.pending.length === 2, 'both to be not sent');
		const offline = shown(guestChat).filter(row => !row.includes('joined'));
		await guest.network.restore();
		await chatLoaded(guest);
		click(guestChat, 'second', 'Discard');
		click(guestChat, 'first', 'Retry');
		await until(() => shown(ownerChat).some(row => row.includes('first')) && guest.service.chat.pending.length === 0, 'the retried message to arrive');
		await until(() => shown(guestChat).some(row => row === `${guestName}: first`), 'the guest\'s own view to show it sent');
		assert.deepStrictEqual({ offline, guest: shown(guestChat).filter(row => !row.includes('joined')), owner: shown(ownerChat).filter(row => !row.includes('joined')) }, {
			offline: ['  first | Not sentYou\'re offline.RetryDiscard', '  second | Not sentYou\'re offline.RetryDiscard'],
			guest: [`${guestName}: first`],
			owner: [`${guestName}: first`],
		});
	});

	test('chat view: a send whose answer was lost shows Not sent with why; after the reconnect it is one message and nothing pending', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const [ownerChat, guestChat] = [mountChat(owner), mountChat(guest)];
		await chatLoaded(owner, guest);
		const guestName = shownName(owner, guest.service.myUserId)!;
		await rigSwitch('drop-chat-answers', true);
		guest.network.rewriteIncoming('chat:message', () => [{ roomId: 'not-this-room' }]);
		let away: string[];
		try {
			type(guestChat, 'did it go?');
			guestChat.widget.sendComposer();
			await until(() => shown(ownerChat).some(row => row.includes('did it go?')), 'the owner to see it');
			await guest.network.drop();
			await until(() => guest.service.chat.pending[0]?.state === 'notSent', 'the send to be not sent');
			away = shown(guestChat).filter(row => !row.includes('joined'));
		} finally {
			await rigSwitch('drop-chat-answers', false);
			guest.network.rewriteIncoming('chat:message', undefined);
		}
		await guest.network.restore();
		await until(() => guest.service.chat.pending.length === 0 && shown(guestChat).includes(`${guestName}: did it go?`), 'the guest\'s view to settle');
		assert.deepStrictEqual({ away, after: shown(guestChat).filter(row => !row.includes('joined')) }, {
			away: ['  did it go? | Not sentThe room didn\'t answer. It may have arrived; retrying won\'t post it twice.RetryDiscard'],
			after: [`${guestName}: did it go?`],
		});
	});

	test('chat view: an edit and a delete made while the guest was away show in the guest\'s view after the reconnect', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const guestChat = mountChat(guest);
		await chatLoaded(owner, guest);
		const ownerName = shownName(guest, owner.service.myUserId)!;
		const keep = await owner.service.chat.send(say('keep me'));
		const drop = await owner.service.chat.send(say('drop me'));
		assert.ok(keep.ok && drop.ok);
		await until(() => shown(guestChat).some(row => row.includes('drop me')), 'the guest to see both');
		const before = shown(guestChat).filter(row => !row.includes('joined'));
		await guest.network.drop();
		await owner.service.chat.edit(keep.message.id, say('kept, edited'), keep.message.revision);
		await owner.service.chat.delete([drop.message.id], 'everyone');
		await guest.network.restore();
		await until(() => shown(guestChat).some(row => row.includes('kept, edited')), 'the guest\'s view to reconcile');
		assert.deepStrictEqual({ before, after: shown(guestChat).filter(row => !row.includes('joined') && row !== '--- New ---') }, {
			before: [`${ownerName}: keep me`, '  drop me'],
			after: [`${ownerName}: kept, edited(edited)`],
		});
	});

	test('chat view: @ lists People then Files, with paths where names repeat; a file tag is a pill that opens the file, unavailable offline, and (deleted) once the room deletes it', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'a', 'd/c.txt': 'c', 'e/c.txt': 'c2' });
		const [ownerChat, guestChat] = [mountChat(owner), mountChat(guest)];
		await chatLoaded(owner, guest);
		await until(() => guest.fileSystem.allServerIds().length >= 5, 'the guest\'s tree ids');
		type(guestChat, '@');
		const everything = guestChat.widget.suggestions;
		guestChat.widget.insert('c');
		const filtered = guestChat.widget.suggestions;
		guestChat.widget.pickSuggestion(0);
		type(guestChat, 'please');
		guestChat.widget.sendComposer();
		await until(() => shown(ownerChat).some(row => row.includes('please')), 'the owner to see the tagged message');
		const tagged = (chat: IMountedChat) => shown(chat).find(row => row.includes('please'))!.split(': ').pop();
		const pill = (chat: IMountedChat) => chat.widget.element.querySelector<HTMLElement>('.livecollab-chat-file')!;
		const sentAs = { owner: tagged(ownerChat), guest: tagged(guestChat) };
		pill(ownerChat).click();
		pill(guestChat).click();
		await guest.network.drop();
		const offline = tagged(guestChat);
		await guest.network.restore();
		await until(() => pill(guestChat).classList.contains('resolved'), 'the guest\'s pill to come back');
		await owner.workingCopyFileService.delete([{ resource: URI.joinPath(folder, 'd', 'c.txt') }], CancellationToken.None);
		await until(() => pill(guestChat).classList.contains('deleted'), 'the guest to see the file deleted');
		const sections = everything.map(entry => entry.split(':')[0]);
		assert.deepStrictEqual({
			sections: sections.filter((section, i) => section !== sections[i - 1]),
			filtered,
			sentAs,
			opened: { owner: ownerChat.opened.map(uri => uri.toString()), guest: guestChat.opened.map(uri => uri.toString()) },
			offline,
			deleted: tagged(guestChat),
		}, {
			sections: ['people', 'files'],
			filtered: ['files: c.txt (d/c.txt)', 'files: c.txt (e/c.txt)'],
			sentAs: { owner: '[c.txt|resolved] please', guest: '[c.txt|resolved] please' },
			opened: { owner: [URI.joinPath(folder, 'd', 'c.txt').toString()], guest: [URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/d/c.txt' }).toString()] },
			offline: '[c.txt|unavailable] please',
			deleted: '[c.txt (deleted)|deleted] please',
		});
	});

	test('chat view: back after more than four pages: the newest four, an "Earlier unread messages" marker, nothing stale held; scrolling up brings the rest as it now stands, unread right throughout', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const guestChat = mountChat(guest);
		await chatLoaded(owner, guest);
		const early = await owner.service.chat.send(say('early'));
		const doomed = await owner.service.chat.send(say('doomed'));
		assert.ok(early.ok && doomed.ok);
		await until(() => guest.service.chat.messages.some(m => m.id === doomed.message.id), 'the guest to hold both');
		// The guest isn't looking: nothing is marked read by being on screen.
		guestChat.focus.value = false;
		await guest.network.drop();
		await owner.service.chat.edit(early.message.id, say('early, edited'), early.message.revision);
		await owner.service.chat.delete([doomed.message.id], 'everyone');
		for (let i = 1; i <= 210; i++) {
			await owner.service.chat.send(say(`m${i}`));
		}
		await guest.network.restore();
		await until(() => guest.service.chat.messages.at(-1)?.parts[0].type === 'text' && (guest.service.chat.messages.at(-1)!.parts[0] as { text: string }).text === 'm210', 'the guest to catch up');
		const texts = () => guest.service.chat.messages.filter(m => m.kind === 'message').map(m => (m.parts[0] as { text: string }).text);
		const back = { held: guest.service.chat.messages.length, first: texts()[0], last: texts().at(-1), hasMore: guest.service.chat.hasMore, stale: texts().some(t => t === 'early' || t === 'doomed'), unread: guest.service.chat.unread, marker: guestChat.widget.element.querySelector('.livecollab-chat-older')?.textContent };
		while (guest.service.chat.hasMore) {
			assert.ok(await guest.service.chat.loadOlder(), 'an older page loads');
		}
		guestChat.widget.render();
		const all = texts();
		assert.deepStrictEqual({ back, all: { count: all.length, first: all[0], contiguous: all.slice(1).every((t, i) => t === `m${i + 1}`), early: guest.service.chat.messages.find(m => m.id === early.message.id)?.editedAt !== null }, unread: guest.service.chat.unread, marker: guestChat.widget.element.querySelector('.livecollab-chat-older')?.textContent ?? null }, {
			back: { held: 200, first: 'm11', last: 'm210', hasMore: true, stale: false, unread: 210, marker: 'Earlier unread messages: scroll up to load them' },
			all: { count: 211, first: 'early, edited', contiguous: true, early: true },
			unread: 210,
			marker: null,
		});
	});

	test('chat view: the @ list offers People and Files, never a folder: an empty one included, on either side, after a folder rename too', async () => {
		const { owner, guest, folder } = await ownerSharesGuestJoins({ 'a.txt': 'a', 'd/c.txt': 'c', 'empty/': '' });
		const [ownerChat, guestChat] = [mountChat(owner), mountChat(guest)];
		await chatLoaded(owner, guest);
		await until(() => guest.fileSystem.allServerIds().some(([path]) => path === 'empty') && owner.fileSystem.allServerIds().some(([path]) => path === 'empty'), 'both sides to have the empty folder\'s id');
		const files = (chat: IMountedChat) => {
			chat.widget.insert('@');
			const offered = chat.widget.suggestions;
			chat.widget.insert(' ');
			return [`${offered.filter(entry => entry.startsWith('people:')).length} people`, ...offered.filter(entry => !entry.startsWith('people:'))];
		};
		const before = { owner: files(ownerChat), guest: files(guestChat) };
		await owner.workingCopyFileService.move([{ file: { source: URI.joinPath(folder, 'd'), target: URI.joinPath(folder, 'e') } }], CancellationToken.None);
		await until(() => guest.fileSystem.allServerIds().some(([path]) => path === 'e/c.txt'), 'the guest to see the rename');
		assert.deepStrictEqual({ before, after: { owner: files(ownerChat), guest: files(guestChat) } }, {
			before: { owner: ['2 people', 'files: a.txt', 'files: c.txt'], guest: ['2 people', 'files: a.txt', 'files: c.txt'] },
			after: { owner: ['2 people', 'files: a.txt', 'files: c.txt'], guest: ['2 people', 'files: a.txt', 'files: c.txt'] },
		});
	});

	test('chat view: a member who accepted an invite but hasn\'t opened the room yet is shown by the name their joined line keeps, in the log and the @ list; neither breaks', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const ownerChat = mountChat(owner);
		await chatLoaded(owner, guest);
		const [ownerName, guestName] = [shownName(guest, owner.service.myUserId)!, shownName(owner, guest.service.myUserId)!];
		const invite = await owner.service.createInviteCode();
		const pending = await windowClient('pending');
		await nameInClerk(pending, 'Pat Pending');
		assert.ok((await pending.service.joinByCode(invite.code ?? '')).ok, 'the newcomer could not accept');
		const pendingId = accounts.get(pending)!;
		await until(() => owner.service.lastMembers.some(m => m.userId === pendingId) && owner.service.chat.messages.some(m => m.authorId === pendingId), 'the owner to list the newcomer and their joined line');
		ownerChat.widget.render();
		ownerChat.widget.insert('@');
		const people = ownerChat.widget.suggestions.filter(entry => entry.startsWith('people:'));
		ownerChat.widget.insert(' ');
		assert.deepStrictEqual({ unnamed: owner.service.lastMembers.find(m => m.userId === pendingId)?.displayName ?? null, lines: shown(ownerChat).filter(row => row.endsWith('joined the room')), people }, {
			unnamed: null,
			lines: [`${isolated(guestName)} joined the room`, `${isolated('Pat Pending')} joined the room`],
			people: [`people: ${ownerName}`, `people: ${guestName}`, 'people: Pat Pending'],
		});
	});

	test('chat view: Jump to Latest shows only when the latest is out of sight, checked again when the view is laid out and resized; a reader at the latest stays there', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const chat = mountChat(owner, '0px');
		await chatLoaded(owner, guest);
		for (let i = 1; i <= 20; i++) {
			await owner.service.chat.send(say(`line ${i}`));
		}
		await until(() => shown(chat).some(row => row.endsWith('line 20')), 'the log to show every line');
		const jump = () => chat.widget.element.querySelector('.livecollab-chat-jump')!.classList.contains('visible');
		const log = chat.widget.element.querySelector<HTMLElement>('.livecollab-chat-log')!;
		const atLatest = () => log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
		const settle = () => new Promise(resolve => mainWindow.requestAnimationFrame(() => mainWindow.setTimeout(resolve, 50)));
		chat.container.style.height = '2000px';
		await settle();
		const laidOut = { jump: jump() };
		chat.container.style.height = '160px';
		await settle();
		const shrunk = { jump: jump(), atLatest: atLatest() };
		log.scrollTop = 0;
		log.dispatchEvent(new mainWindow.Event('scroll'));
		const scrolledUp = { jump: jump() };
		assert.deepStrictEqual({ laidOut, shrunk, scrolledUp }, { laidOut: { jump: false }, shrunk: { jump: false, atLatest: true }, scrolledUp: { jump: true } });
	});

	test('chat view: two tags with the same text stay two tags: same-named files and same-named people, through typing before them, editing one away, deleting one and undo and redo', async () => {
		const { owner, guest, roomId } = await ownerSharesGuestJoins({ 'd/c.txt': 'c', 'e/c.txt': 'c2' });
		const twins: IBClient[] = [];
		for (const user of ['twin-a', 'twin-b']) {
			const invite = await owner.service.createInviteCode();
			const twin = await windowClient(user);
			await nameInClerk(twin, 'Sam Lee');
			assert.ok((await twin.service.joinByCode(invite.code ?? '')).ok, `${user} could not join`);
			await twin.service.joinExistingRoom(roomId);
			twins.push(twin);
		}
		const twinIds = twins.map(twin => accounts.get(twin)!);
		const chat = mountChat(guest);
		await chatLoaded(owner, guest);
		await until(() => twinIds.every(id => guest.service.lastMembers.some(m => m.userId === id && m.displayName === 'Sam Lee')) && guest.fileSystem.allServerIds().length >= 4, 'the guest to list both twins and both files');
		const [dId, eId] = [guest.fileSystem.getServerFileId('d/c.txt')!, guest.fileSystem.getServerFileId('e/c.txt')!];
		const composer = chat.widget.element.querySelector<HTMLTextAreaElement>('textarea.livecollab-chat-input:not(.edit)')!;
		composer.focus();
		const pick = (query: string, label: string, nth = 0) => {
			chat.widget.insert(`@${query}`);
			const index = chat.widget.suggestions.map((entry, i) => entry === label ? i : -1).filter(i => i >= 0)[nth] ?? -1;
			assert.ok(index >= 0, `"${label}" (${nth}) isn't offered: ${chat.widget.suggestions.join(', ')}`);
			chat.widget.pickSuggestion(index);
		};
		const caret = (at: number, end = at) => composer.setSelectionRange(at, end);
		const tagsOf = (parts: readonly ChatPart[]) => parts.map(part => part.type === 'file' ? `file:${part.fileId === dId ? 'd' : part.fileId === eId ? 'e' : part.fileId}` : part.type === 'person' ? `person:${twinIds.indexOf(part.userId)}` : `text:${part.text}`);
		const sent = async () => {
			const before = guest.service.chat.messages.length;
			chat.widget.sendComposer();
			await until(() => guest.service.chat.messages.length > before, 'the message to be sent');
			return tagsOf(guest.service.chat.messages.at(-1)!.parts);
		};
		// Both files and both people, then typing in front of all of them.
		pick('c', 'files: c.txt (d/c.txt)');
		pick('c', 'files: c.txt (e/c.txt)');
		pick('Sam', 'people: Sam Lee', 0);
		pick('Sam', 'people: Sam Lee', 1);
		caret(0);
		chat.widget.insert('see ');
		const both = await sent();
		// Editing the second file tag's text turns it into text.
		pick('c', 'files: c.txt (d/c.txt)');
		pick('c', 'files: c.txt (e/c.txt)');
		const tail = composer.value.length - 1;
		caret(tail - 1, tail);
		mainWindow.document.execCommand('delete');
		const edited = await sent();
		// Deleting a tag, then undo brings it back as that tag, and redo takes it away again.
		pick('c', 'files: c.txt (d/c.txt)');
		pick('c', 'files: c.txt (e/c.txt)');
		const start = composer.value.indexOf('@c.txt', 1);
		caret(start, start + '@c.txt'.length);
		mainWindow.document.execCommand('delete');
		const deleted = composer.value;
		mainWindow.document.execCommand('undo');
		const undone = await sent();
		pick('c', 'files: c.txt (d/c.txt)');
		pick('c', 'files: c.txt (e/c.txt)');
		const again = composer.value.indexOf('@c.txt', 1);
		caret(again, again + '@c.txt'.length);
		mainWindow.document.execCommand('delete');
		mainWindow.document.execCommand('undo');
		mainWindow.document.execCommand('redo');
		const redone = await sent();
		assert.deepStrictEqual({ both, edited, deleted, undone, redone }, {
			both: ['text:see ', 'file:d', 'text: ', 'file:e', 'text: ', 'person:0', 'text: ', 'person:1', 'text: '],
			edited: ['file:d', 'text: @c.tx '],
			deleted: '@c.txt  ',
			undone: ['file:d', 'text: ', 'file:e', 'text: '],
			redone: ['file:d', 'text:  '],
		});
	});

	test('chat view: message text keeps a readable measure at wide widths; Retry and Discard are buttons that stay together; code blocks use the editor\'s tab size', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const chat = mountChat(guest);
		chat.container.style.width = '1400px';
		// The theme's secondary button colour, as the workbench defines it.
		chat.container.style.setProperty('--vscode-button-secondaryBackground', 'rgb(1, 2, 3)');
		await chatLoaded(owner, guest);
		chat.widget.setTabSize(2);
		await owner.service.chat.send(say('```\n\tindented\n```'));
		await until(() => shown(chat).some(row => row.includes('indented')), 'the code block to show');
		await guest.network.drop();
		chat.widget.insert('offline');
		chat.widget.sendComposer();
		await until(() => guest.service.chat.pending.some(p => p.state === 'notSent'), 'the send to be not sent');
		const text = chat.widget.element.querySelector<HTMLElement>('.livecollab-chat-message .livecollab-chat-text')!;
		const ch = (() => {
			const probe = text.appendChild(mainWindow.document.createElement('span'));
			probe.style.cssText = 'position: absolute; white-space: nowrap;';
			probe.textContent = '0'.repeat(100);
			const width = probe.getBoundingClientRect().width / 100;
			probe.remove();
			return width;
		})();
		const buttons = Array.from(chat.widget.element.querySelectorAll<HTMLButtonElement>('.not-sent button'));
		const wideMeasure = Math.round(text.getBoundingClientRect().width / ch);
		chat.container.style.width = '220px';
		const [retry, discard] = buttons.map(button => button.getBoundingClientRect());
		const block = chat.widget.element.querySelector<HTMLElement>('pre.livecollab-chat-block')!;
		const measured = {
			measure: wideMeasure,
			buttons: buttons.map(button => button.textContent),
			together: buttons[0].parentElement === buttons[1].parentElement && Math.abs(retry.top - discard.top) < 2,
			looksLikeButtons: buttons.every(button => mainWindow.getComputedStyle(button).backgroundColor === 'rgb(1, 2, 3)'),
			tabSize: mainWindow.getComputedStyle(block).tabSize,
		};
		await guest.network.restore();
		assert.deepStrictEqual(measured, { measure: 70, buttons: ['Retry', 'Discard'], together: true, looksLikeButtons: true, tabSize: '2' });
	});

	test('chat view: Edit saves in place for everyone; Copy copies; Delete opens selection, where Delete for Everyone is off (and says why) with someone else\'s message in it; Delete for Me hides it from me only', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const [ownerChat, guestChat] = [mountChat(owner), mountChat(guest)];
		await chatLoaded(owner, guest);
		const [ownerName, guestName] = [shownName(guest, owner.service.myUserId)!, shownName(owner, guest.service.myUserId)!];
		await owner.service.chat.send(say('mine'));
		await guest.service.chat.send(say('theirs'));
		await until(() => shown(ownerChat).some(row => row.includes('theirs')), 'the owner to see both');
		click(ownerChat, 'mine', 'Edit');
		const editor = ownerChat.widget.element.querySelector<HTMLTextAreaElement>('textarea.edit')!;
		editor.value = 'mine, fixed';
		editor.dispatchEvent(new InputEvent('input'));
		editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
		await until(() => shown(guestChat).some(row => row.includes('mine, fixed')), 'the guest to see the edit');
		click(ownerChat, 'theirs', 'Copy');
		click(ownerChat, 'theirs', 'Delete');
		const bar = ownerChat.widget.element.querySelector('.livecollab-chat-select-bar')!;
		const everyone = Array.from(bar.querySelectorAll('button')).find(b => b.textContent === 'Delete for Everyone')!;
		const selection = { count: bar.querySelector('.livecollab-chat-select-count')?.textContent, everyoneDisabled: everyone.disabled, why: bar.querySelector('.livecollab-chat-select-why')?.textContent };
		click(ownerChat, undefined, 'Delete for Me');
		await until(() => !shown(ownerChat).some(row => row.includes('theirs')), 'the owner\'s view to hide it');
		assert.deepStrictEqual({ copied: ownerChat.copied, selection, owner: shown(ownerChat).filter(row => !row.includes('joined')), guest: shown(guestChat).filter(row => !row.includes('joined')) }, {
			copied: ['theirs'],
			selection: { count: '1 selected', everyoneDisabled: true, why: 'Only your own messages can be deleted for everyone.' },
			owner: [`${ownerName}: mine, fixed(edited)`],
			guest: [`${ownerName}: mine, fixed(edited)`, `${guestName}: theirs`],
		});
	});

	/** The same account in a second window, in `roomId` too. */
	async function secondWindow(first: IBClient, user: string, roomId: string): Promise<IBClient> {
		const window = createBClient(serverUrl!, testStore!);
		accounts.set(window, accounts.get(first)!);
		await signIn(window.service, user, accounts.get(first));
		await window.service.joinExistingRoom(roomId);
		return window;
	}
	function editMessage(chat: IMountedChat, text: string): void {
		const editor = chat.widget.element.querySelector<HTMLTextAreaElement>('textarea.edit')!;
		editor.value = text;
		editor.dispatchEvent(new InputEvent('input'));
	}
	function saveEdit(chat: IMountedChat): void {
		chat.widget.element.querySelector<HTMLTextAreaElement>('textarea.edit')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
	}
	function editHint(chat: IMountedChat): string | null | undefined {
		return chat.widget.element.querySelector('textarea.edit')?.parentElement?.querySelector('.livecollab-chat-status')?.textContent;
	}
	function composerText(chat: IMountedChat): string {
		return chat.widget.element.querySelector<HTMLTextAreaElement>('textarea.livecollab-chat-input:not(.edit)')!.value;
	}

	test('chat view: the same author editing one message in two windows: the save made from the older version is refused and says so, what was typed stays, and saving again replaces it; nobody else can edit it', async () => {
		const { owner, guest, roomId } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const ownerAgain = await secondWindow(owner, 'owner', roomId);
		const [one, two, guestChat] = [mountChat(owner), mountChat(ownerAgain), mountChat(guest)];
		await chatLoaded(owner, ownerAgain, guest);
		const ownerName = shownName(guest, owner.service.myUserId)!;
		await owner.service.chat.send(say('first words'));
		await until(() => [two, guestChat].every(chat => shown(chat).some(row => row.includes('first words'))), 'both to see it');
		click(one, 'first words', 'Edit');
		editMessage(one, 'from window one');
		click(two, 'first words', 'Edit');
		editMessage(two, 'from window two');
		saveEdit(two);
		await until(() => shown(guestChat).some(row => row.includes('from window two')), 'the guest to see window two\'s edit');
		saveEdit(one);
		await until(() => !!editHint(one)?.includes('another window'), 'window one to be told');
		const refused = { editing: one.widget.element.querySelector<HTMLTextAreaElement>('textarea.edit')?.value, hint: editHint(one), guest: shown(guestChat).filter(row => row.startsWith(ownerName)) };
		saveEdit(one);
		await until(() => shown(guestChat).some(row => row.includes('from window one')), 'the guest to see window one\'s text');
		const message = guest.service.chat.messages.find(m => m.kind === 'message')!;
		const byGuest = await guest.service.chat.edit(message.id, say('not mine'), message.revision);
		assert.deepStrictEqual({ refused, after: { guest: shown(guestChat).filter(row => row.startsWith(ownerName)), stillEditing: !!one.widget.element.querySelector('textarea.edit') }, byGuest }, {
			refused: {
				editing: 'from window one',
				hint: 'You changed this message in another window. Enter saves this text over it; Escape keeps that version.',
				guest: [`${ownerName}: from window two(edited)`],
			},
			after: { guest: [`${ownerName}: from window one(edited)`], stillEditing: false },
			byGuest: { ok: false, error: 'not_yours' },
		});
	});

	test('chat view: a message deleted in another window while it is being edited: the text being edited stays, said so, with Copy and Discard', async () => {
		const { owner, roomId } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const ownerAgain = await secondWindow(owner, 'owner', roomId);
		const one = mountChat(owner);
		await chatLoaded(owner, ownerAgain);
		await owner.service.chat.send(say('soon gone'));
		await until(() => ownerAgain.service.chat.messages.some(m => m.kind === 'message'), 'window two to have it');
		click(one, 'soon gone', 'Edit');
		editMessage(one, 'my unsaved words');
		await ownerAgain.service.chat.delete([ownerAgain.service.chat.messages.find(m => m.kind === 'message')!.id], 'everyone');
		await until(() => !!one.widget.element.querySelector('.livecollab-chat-orphan'), 'window one to keep the text');
		const orphan = one.widget.element.querySelector('.livecollab-chat-orphan')!;
		const kept = {
			note: orphan.querySelector('.livecollab-chat-status > span')?.textContent,
			text: orphan.querySelector('.livecollab-chat-text')?.textContent,
			buttons: Array.from(orphan.querySelectorAll('button')).map(b => b.textContent),
			log: shown(one).filter(row => !row.includes('joined')),
		};
		Array.from(orphan.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === 'Copy')!.click();
		Array.from(one.widget.element.querySelectorAll<HTMLButtonElement>('.livecollab-chat-orphan button')).find(b => b.textContent === 'Discard')!.click();
		assert.deepStrictEqual({ kept, copied: one.copied, afterDiscard: !!one.widget.element.querySelector('.livecollab-chat-orphan') }, {
			kept: { note: 'This message was removed while you were editing it. Your text is kept here.', text: 'my unsaved words', buttons: ['Copy', 'Discard'], log: [] },
			copied: ['my unsaved words'],
			afterDiscard: false,
		});
	});

	test('chat view: an unsent draft belongs to its account and room: it stays out of another room, comes back with its room, tags included, and after the app restarts; another account on the same machine doesn\'t see it', async () => {
		const { owner, guest, roomId } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const other = await owner.service.createRoomNamed('drafts-other');
		assert.ok(other);
		const chat = mountChat(owner);
		await chatLoaded(owner);
		await owner.service.fetchMembers(roomId);
		await until(() => shownName(owner, guest.service.myUserId) !== undefined, 'the owner to know the guest\'s name');
		const guestName = shownName(owner, guest.service.myUserId)!;
		chat.widget.insert('half a thought for ');
		chat.widget.insert(`@${guestName.slice(0, 3)}`);
		const index = chat.widget.suggestions.findIndex(label => label === `people: ${guestName}`);
		assert.ok(index >= 0, chat.widget.suggestions.join(', '));
		chat.widget.pickSuggestion(index);
		const typed = composerText(chat);
		await owner.service.joinExistingRoom(other);
		await chatLoaded(owner);
		const inOther = composerText(chat);
		chat.widget.insert('for the other room');
		await owner.service.joinExistingRoom(roomId);
		await chatLoaded(owner);
		const back = composerText(chat);
		// The app quits and opens again on the same machine, same account.
		owner.service.signOut();
		const reopened = createBClient(serverUrl!, testStore!, owner.kept);
		accounts.set(reopened, accounts.get(owner)!);
		await signIn(reopened.service, 'owner', accounts.get(owner));
		await reopened.service.joinExistingRoom(roomId);
		const reopenedChat = mountChat(reopened);
		await chatLoaded(reopened);
		const afterRestart = composerText(reopenedChat);
		// The guest's account, signed in on the owner's machine, in the same room.
		const guestHere = createBClient(serverUrl!, testStore!, owner.kept);
		accounts.set(guestHere, accounts.get(guest)!);
		await signIn(guestHere.service, 'guest', accounts.get(guest));
		await guestHere.service.joinExistingRoom(roomId);
		const guestHereChat = mountChat(guestHere);
		await chatLoaded(guestHere);
		const forTheGuest = composerText(guestHereChat);
		reopenedChat.widget.sendComposer();
		await until(() => reopened.service.chat.messages.some(m => m.kind === 'message'), 'the draft to be sent');
		const sent = reopened.service.chat.messages.find(m => m.kind === 'message')!.parts.map(part => part.type);
		assert.deepStrictEqual({ typed, inOther, back, afterRestart, forTheGuest, sent, emptiedBySend: composerText(reopenedChat) }, {
			typed: `half a thought for @${guestName} `, inOther: '', back: `half a thought for @${guestName} `,
			afterRestart: `half a thought for @${guestName} `, forTheGuest: '', sent: ['text', 'person', 'text'], emptiedBySend: '',
		});
	});

	test('sign-out: both of the account\'s windows, told as main tells every window, leave their rooms and close their connections for good; window B\'s unsent draft stays saved under the account and room; another account signed in in B starts with none of it', async () => {
		const { owner, guest, roomId } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const windowB = await secondWindow(owner, 'owner', roomId);
		const chat = mountChat(windowB);
		await chatLoaded(windowB);
		const ownerId = owner.service.myUserId;
		await until(() => guest.service.isOnline(ownerId), 'the guest to see the owner online');
		chat.widget.insert('unsent in window B');
		// Window A signs out; main deletes the credential and tells every window's workbench.
		owner.service.signOut();
		windowB.service.signOut();
		await until(() => !guest.service.isOnline(ownerId), 'the guest to see the owner gone').catch(() => { });
		// Long enough for a reconnect, if anything were to try one.
		await timeout(1500);
		const afterSignOut = {
			connected: [owner.service.isConnected, windowB.service.isConnected],
			inRoom: [owner.service.roomId ?? null, windowB.service.roomId ?? null],
			ownerSeenOnline: guest.service.isOnline(ownerId),
			roomsListed: (await windowB.service.listMyRooms()).length,
			composer: composerText(chat),
		};
		// The guest's account signs in in window B and enters the same room.
		await signIn(windowB.service, 'guest', accounts.get(guest));
		await windowB.service.joinExistingRoom(roomId);
		await chatLoaded(windowB);
		const asGuest = { me: windowB.service.myUserId === guest.service.myUserId, composer: composerText(chat) };
		windowB.service.signOut();
		// The owner again, in window B.
		await signIn(windowB.service, 'owner', accounts.get(owner));
		await windowB.service.joinExistingRoom(roomId);
		await chatLoaded(windowB);
		await until(() => composerText(chat) !== '', 'the owner\'s draft to come back').catch(() => { });
		assert.deepStrictEqual({ afterSignOut, asGuest, ownerAgain: composerText(chat) }, {
			afterSignOut: { connected: [false, false], inRoom: [null, null], ownerSeenOnline: false, roomsListed: 0, composer: '' },
			asGuest: { me: true, composer: '' },
			ownerAgain: 'unsent in window B',
		});
	});

	/**
	 * The machine's application storage as the app's windows see it (VS Code's own timings):
	 * - a window's writes go to its own copy at once, and to the main process only after 100 ms
	 *   without another write, one value per key, the last (storage.ts: `pendingInserts`, a
	 *   `ThrottledDelayer(DEFAULT_FLUSH_DELAY = 100)` whose delay restarts on every write);
	 * - the main process tells every window, the writer included, each changed key's current value
	 *   100 ms after the changes stop (electron-main/storageIpc.ts: `Event.debounce`,
	 *   `STORAGE_CHANGE_DEBOUNCE_TIME`, `storage.get(event.key)`), so values in between are never
	 *   heard, and a window that wrote more meanwhile hears an older value of its own back
	 *   (`acceptExternal` takes any value that differs).
	 * A restart is a new copy of what the main process holds.
	 */
	class WindowsStorage {
		readonly db = new Map<string, string>();
		private readonly _windows = new Set<WindowStorage>();
		private readonly _changed = new Set<string>();
		private readonly _broadcast = testStore!.add(new RunOnceScheduler(() => {
			const keys = [...this._changed];
			this._changed.clear();
			for (const window of this._windows) {
				for (const key of keys) {
					window.accept(key, this.db.get(key));
				}
			}
		}, 100));
		open(): WindowStorage {
			const window = testStore!.add(new WindowStorage(this, new Map(this.db)));
			this._windows.add(window);
			testStore!.add(toDisposable(() => this._windows.delete(window)));
			return window;
		}
		write(key: string, value: string | undefined): void {
			if (value === undefined) {
				this.db.delete(key);
			} else {
				this.db.set(key, value);
			}
			this._changed.add(key);
			this._broadcast.schedule();
		}
	}
	class WindowStorage implements IChatDraftStorage, IDisposable {
		private readonly _onDidChange = new Emitter<IApplicationStorageValueChangeEvent>();
		private readonly _pending = new Map<string, string | undefined>();
		private readonly _flush = new RunOnceScheduler(() => {
			for (const [key, value] of this._pending) {
				this._machine.write(key, value);
			}
			this._pending.clear();
		}, 100);
		constructor(private readonly _machine: WindowsStorage, private readonly _cache: Map<string, string>) { }
		get(key: string): string | undefined { return this._cache.get(key); }
		store(key: string, value: string): void { this._write(key, value); }
		remove(key: string): void { this._write(key, undefined); }
		keys(): string[] { return [...this._cache.keys()]; }
		onDidChangeValue(_scope: StorageScope.APPLICATION, key: string | undefined, disposable: DisposableStore): Event<IApplicationStorageValueChangeEvent> {
			return Event.filter(this._onDidChange.event, e => key === undefined || e.key === key, disposable);
		}
		accept(key: string, value: string | undefined): void {
			if (this._cache.get(key) === value) {
				return;
			}
			if (value === undefined) {
				this._cache.delete(key);
			} else {
				this._cache.set(key, value);
			}
			this._onDidChange.fire({ scope: StorageScope.APPLICATION, key, target: StorageTarget.MACHINE });
		}
		private _write(key: string, value: string | undefined): void {
			if (this._cache.get(key) === value) {
				return;
			}
			this.accept(key, value);
			this._pending.set(key, value);
			this._flush.schedule();
		}
		dispose(): void { this._flush.dispose(); this._onDidChange.dispose(); }
	}

	/** Two windows of the owner's account on one machine, in one room, each with its chat view and its copy of the storage. */
	async function draftWindows() {
		const { owner, guest, roomId } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const machine = new WindowsStorage();
		const twoWindow = await secondWindow(owner, 'owner', roomId);
		const one = mountChat(owner, undefined, testStore!.add(new StoredChatDrafts(machine.open())));
		const two = mountChat(twoWindow, undefined, testStore!.add(new StoredChatDrafts(machine.open())));
		await chatLoaded(owner, twoWindow);
		// A pause long enough for a write to reach the main process and come back to every window.
		const settle = () => timeout(600);
		/** The app quits and opens again: a new window on what the machine holds. */
		const restart = async () => {
			const window = await secondWindow(owner, 'owner', roomId);
			const chat = mountChat(window, undefined, testStore!.add(new StoredChatDrafts(machine.open())));
			await chatLoaded(window);
			return chat;
		};
		return { owner, guest, roomId, one, two, settle, restart, machine };
	}
	/** The composer, and the drafts kept aside below the log (text, a tag as [@name]). */
	function drafts(chat: IMountedChat): { composer: string; kept: string[] } {
		const kept = Array.from(chat.widget.element.querySelectorAll('.livecollab-chat-kept .livecollab-chat-text')).map(text => Array.from(text.childNodes).map(node => (node as HTMLElement).classList?.contains('livecollab-chat-person') ? `[${node.textContent}]` : node.textContent).join(''));
		// Two windows can keep theirs in the same instant: compared in text order.
		return { composer: composerText(chat), kept: kept.sort() };
	}

	test('chat drafts, two windows: typing in one shows in the other, both ways, and keeps nothing aside', async () => {
		const { one, two, settle } = await draftWindows();
		one.widget.insert('hel');
		await settle();
		const twoSees = composerText(two);
		two.widget.insert('lo');
		await settle();
		assert.deepStrictEqual({ twoSees, one: drafts(one), two: drafts(two) }, { twoSees: 'hel', one: { composer: 'hello', kept: [] }, two: { composer: 'hello', kept: [] } });
	});

	test('chat drafts, two windows: ordinary typing in one, several keystrokes to a flush and its own older version heard back, keeps nothing aside in either window', async () => {
		const { one, two, settle } = await draftWindows();
		for (const key of ['h', 'e', 'l']) {
			one.widget.insert(key);
		}
		// Flushed; the main process tells every window, this one included, 100 ms later, by when it has typed on.
		await timeout(150);
		for (const key of ['l', 'o']) {
			one.widget.insert(key);
		}
		await settle();
		assert.deepStrictEqual({ one: drafts(one), two: drafts(two) }, { one: { composer: 'hello', kept: [] }, two: { composer: 'hello', kept: [] } });
	});

	test('chat drafts, two windows: typed in one, then far more than 64 keystrokes in the other with no gap to flush, its own older version heard back meanwhile: no conflict and no text reverts', async () => {
		const { one, two, settle } = await draftWindows();
		two.widget.insert('b');
		await settle();
		const typed = Array.from({ length: 310 }, (_, i) => String.fromCharCode(97 + i % 26));
		for (const key of typed.slice(0, 10)) {
			one.widget.insert(key);
		}
		// Flushed; its echo reaches this window 100 ms later, after the 300 keystrokes below.
		await timeout(150);
		for (const key of typed.slice(10)) {
			one.widget.insert(key);
		}
		await settle();
		const text = 'b' + typed.join('');
		assert.deepStrictEqual({ one: drafts(one), two: drafts(two) }, { one: { composer: text, kept: [] }, two: { composer: text, kept: [] } });
	});

	test('chat drafts, many chat views over time: within the last 64 writers continued typing is followed; past them, a draft whose history no longer shows it is kept as rows in both windows, and a delayed older version never reverts a composer', async () => {
		const { owner, roomId, one, two, settle, machine } = await draftWindows();
		const userId = owner.service.myUserId;
		// Chat views opened one after another (each app start, reload or reopen is a new writer), each typing on from the draft it loaded.
		const later = testStore!.add(new StoredChatDrafts(machine.open()));
		const typeOn = (name: string, count: number) => {
			const written: IStoredChatDraft[] = [];
			for (let i = 1; i <= count; i++) {
				const loaded = later.get(userId, roomId)!;
				const draft: IStoredChatDraft = { writer: `${name}-${i}`, seq: 1, seen: loaded.seen, text: `${loaded.text}${i % 10}`, tags: [] };
				later.set(userId, roomId, draft);
				written.push(draft);
			}
			// Written within one flush: the open windows hear only the last, after all of them.
			return written;
		};
		one.widget.insert('a');
		await settle();
		const within = typeOn('within', 60);
		await settle();
		const followed = { one: drafts(one), two: drafts(two) };

		// Neither window types now: both just show the draft as it moves on.
		const past = typeOn('past', 70);
		await settle();
		// A version from early in that run arrives again, late.
		later.set(userId, roomId, past[1]);
		await settle();

		// Past 64 writers the version each window holds is no longer in the draft's history, so both are kept;
		// the earlier one is already in the later version's text, kept as that one's row.
		const rows = [past[1].text, past[69].text].sort();
		assert.deepStrictEqual({ followed, one: drafts(one), two: drafts(two) }, {
			followed: { one: { composer: within[59].text, kept: [] }, two: { composer: within[59].text, kept: [] } },
			one: { composer: '', kept: rows },
			two: { composer: '', kept: rows },
		});
	});

	test('chat drafts, a room whose draft has dropped writers (past 64): two windows still mirror typing both ways, several keystrokes to a flush, and a send in one empties the other, with nothing kept aside', async () => {
		const { owner, roomId, one, two, settle, machine } = await draftWindows();
		const userId = owner.service.myUserId;
		const later = testStore!.add(new StoredChatDrafts(machine.open()));
		for (let i = 1; i <= 70; i++) {
			const loaded = later.get(userId, roomId);
			later.set(userId, roomId, { writer: `earlier-${i}`, seq: 1, seen: loaded?.seen ?? {}, text: '', tags: [] });
		}
		await settle();
		const marked = later.get(userId, roomId)?.pruned;
		for (const key of ['h', 'e', 'l']) {
			one.widget.insert(key);
		}
		await timeout(150);
		for (const key of ['l', 'o']) {
			one.widget.insert(key);
		}
		await settle();
		const twoSees = composerText(two);
		for (const key of [' ', 'w', 'o']) {
			two.widget.insert(key);
		}
		await timeout(150);
		for (const key of ['r', 'l', 'd']) {
			two.widget.insert(key);
		}
		await settle();
		const oneSees = drafts(one);
		one.widget.sendComposer();
		await until(() => owner.service.chat.messages.some(m => m.kind === 'message'), 'the send');
		await settle();
		assert.deepStrictEqual({ marked, twoSees, oneSees, one: drafts(one), two: drafts(two) }, {
			marked: true, twoSees: 'hello', oneSees: { composer: 'hello world', kept: [] }, one: { composer: '', kept: [] }, two: { composer: '', kept: [] },
		});
	});

	test('chat drafts, two windows: a send in one while the other has typed on from the same draft keeps the newer text aside, in both windows and after a restart; the sent one is sent once', async () => {
		const { owner, one, two, settle, restart } = await draftWindows();
		one.widget.insert('hello');
		await settle();
		two.widget.insert(' world');
		one.widget.sendComposer();
		await until(() => owner.service.chat.messages.some(m => m.kind === 'message'), 'the send');
		await settle();
		assert.deepStrictEqual({ one: drafts(one), two: drafts(two), restarted: drafts(await restart()), sent: owner.service.chat.messages.filter(m => m.kind === 'message').map(m => m.parts.map(part => part.type === 'text' ? part.text : part.type).join('')) }, {
			one: { composer: '', kept: ['hello world'] }, two: { composer: '', kept: ['hello world'] }, restarted: { composer: '', kept: ['hello world'] }, sent: ['hello'],
		});
	});

	test('chat drafts, two windows: different text typed in each before either hears of the other: both are kept, in both windows and after a restart; neither is sent', async () => {
		const { owner, one, two, settle, restart } = await draftWindows();
		// Each typed in two steps: a draft typed on keeps one row, not one per step.
		one.widget.insert('alpha');
		two.widget.insert('beta');
		one.widget.insert(' from one');
		two.widget.insert(' from two');
		await settle();
		const after = { one: drafts(one), two: drafts(two) };
		const restarted = drafts(await restart());
		assert.deepStrictEqual({ after, restarted, sent: owner.service.chat.messages.filter(m => m.kind === 'message').length }, {
			after: { one: { composer: '', kept: ['alpha from one', 'beta from two'] }, two: { composer: '', kept: ['alpha from one', 'beta from two'] } },
			restarted: { composer: '', kept: ['alpha from one', 'beta from two'] },
			sent: 0,
		});
	});

	test('chat drafts, two windows: a send in one clears the same draft in the other, which nothing brings back: not closing it, not a restart', async () => {
		const { owner, one, two, settle, restart } = await draftWindows();
		one.widget.insert('hello');
		await settle();
		const twoBefore = composerText(two);
		one.widget.sendComposer();
		await until(() => owner.service.chat.messages.some(m => m.kind === 'message'), 'the send');
		await settle();
		const twoAfter = drafts(two);
		two.widget.dispose();
		await settle();
		assert.deepStrictEqual({ twoBefore, twoAfter, one: drafts(one), restarted: drafts(await restart()), sent: owner.service.chat.messages.filter(m => m.kind === 'message').length }, {
			twoBefore: 'hello', twoAfter: { composer: '', kept: [] }, one: { composer: '', kept: [] }, restarted: { composer: '', kept: [] }, sent: 1,
		});
	});

	test('chat drafts, two windows: typing in the other window before it hears of the send keeps what it typed aside, in both windows and after a restart; the sent text is not the draft again', async () => {
		const { owner, one, two, settle, restart } = await draftWindows();
		one.widget.insert('hello');
		await settle();
		one.widget.sendComposer();
		two.widget.insert(' again');
		await until(() => owner.service.chat.messages.some(m => m.kind === 'message'), 'the send');
		await settle();
		assert.deepStrictEqual({ one: drafts(one), two: drafts(two), restarted: drafts(await restart()), sent: owner.service.chat.messages.filter(m => m.kind === 'message').length }, {
			one: { composer: '', kept: ['hello again'] }, two: { composer: '', kept: ['hello again'] }, restarted: { composer: '', kept: ['hello again'] }, sent: 1,
		});
	});

	test('chat drafts, two windows: the same text, tagged in one and plain in the other, is two drafts: both kept with their tags; Discard drops one everywhere', async () => {
		const { owner, guest, roomId, one, two, settle, restart } = await draftWindows();
		await owner.service.fetchMembers(roomId);
		await until(() => shownName(owner, guest.service.myUserId) !== undefined, 'the owner to know the guest\'s name');
		const guestName = shownName(owner, guest.service.myUserId)!;
		one.widget.insert(`for @${guestName.slice(0, 3)}`);
		const index = one.widget.suggestions.findIndex(label => label === `people: ${guestName}`);
		assert.ok(index >= 0, one.widget.suggestions.join(', '));
		one.widget.pickSuggestion(index);
		two.widget.insert(`for @${guestName} `);
		await settle();
		const both = { one: drafts(one), two: drafts(two) };
		const plain = Array.from(two.widget.element.querySelectorAll('.livecollab-chat-kept')).find(row => !row.querySelector('.livecollab-chat-person'))!;
		Array.from(plain.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === 'Discard')!.click();
		await settle();
		assert.deepStrictEqual({ both, afterDiscard: { one: drafts(one), restarted: drafts(await restart()) } }, {
			both: {
				one: { composer: '', kept: [`for @${guestName} `, `for [@${guestName}] `] },
				two: { composer: '', kept: [`for @${guestName} `, `for [@${guestName}] `] },
			},
			afterDiscard: { one: { composer: '', kept: [`for [@${guestName}] `] }, restarted: { composer: '', kept: [`for [@${guestName}] `] } },
		});
	});

	test('chat drafts, two windows: Continue Editing puts a kept draft back in the composer after a restart, its file and person tags as tags; a different draft there is kept aside first; nothing is sent until Enter', async () => {
		const { owner, guest, roomId, one, two, settle, restart } = await draftWindows();
		await owner.service.fetchMembers(roomId);
		await until(() => shownName(owner, guest.service.myUserId) !== undefined, 'the owner to know the guest\'s name');
		const guestName = shownName(owner, guest.service.myUserId)!;
		const pick = (chat: IMountedChat, typed: string, label: string) => {
			chat.widget.insert(typed);
			const index = chat.widget.suggestions.indexOf(label);
			assert.ok(index >= 0, chat.widget.suggestions.join(', '));
			chat.widget.pickSuggestion(index);
		};
		one.widget.insert('see ');
		pick(one, '@a.t', 'files: a.txt');
		one.widget.insert('with ');
		pick(one, `@${guestName.slice(0, 3)}`, `people: ${guestName}`);
		two.widget.insert('from two');
		await settle();
		const reopened = await restart();
		reopened.widget.insert('typed after the restart');
		const row = Array.from(reopened.widget.element.querySelectorAll('.livecollab-chat-kept')).find(r => r.querySelector('.livecollab-chat-person'))!;
		Array.from(row.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === 'Continue Editing')!.click();
		await settle();
		const continued = { ...drafts(reopened), sentBefore: owner.service.chat.messages.filter(m => m.kind === 'message').length };
		reopened.widget.sendComposer();
		await until(() => owner.service.chat.messages.some(m => m.kind === 'message'), 'the send');
		const sent = owner.service.chat.messages.find(m => m.kind === 'message')!.parts.map(part => part.type);
		assert.deepStrictEqual({ continued, sent }, {
			continued: { composer: `see @a.txt with @${guestName} `, kept: ['from two', 'typed after the restart'], sentBefore: 0 },
			sent: ['text', 'file', 'text', 'person', 'text'],
		});
	});

	test('members: a guest already in the room is told when the owner first shares a folder, and not again when the owner reconnects', async () => {
		const owner = await windowClient('owner');
		const roomId = await owner.service.createRoomNamed('layer-b');
		assert.ok(roomId);
		await owner.service.joinExistingRoom(roomId);
		const guest = await joinsByInvite(owner, roomId, 'guest');
		const ownerName = shownName(guest, owner.service.myUserId);
		const folder = URI.file(`/layer-b/run-${run}/project`);
		await owner.fileService.writeFile(URI.joinPath(folder, 'a.txt'), VSBuffer.fromString('a'));
		await owner.workspace.updateFolders(0, 0, [{ uri: folder }]);
		await until(() => membershipNotices(guest).length > 0, 'the guest to be told').catch(() => { });
		await owner.network.drop();
		await restoreAndReattach(owner);
		await timeout(300);
		assert.deepStrictEqual(membershipNotices(guest), [`${isolated(ownerName)} shared the folder 'project' with this room.`]);
	});

	test('notices: after the owner reconnects, one notice names what changed while away', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins(matrixFolder);
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		await owner.network.drop();
		await guest.workingCopyFileService.move([{ file: { source: URI.joinPath(guestRoot, 'a.txt'), target: URI.joinPath(guestRoot, 'renamed.txt') } }], CancellationToken.None);
		await owner.fileService.del(URI.joinPath(folder, 'b.txt'));
		await timeout(300);
		await restoreAndReattach(owner);
		await until(() => noticesWith(owner, 'caught up').length > 0, 'the notice').catch(() => { });
		assert.deepStrictEqual(noticesWith(owner, 'caught up').map(notice => notice.message), [
			'While you were away, this folder and the room caught up with each other: \'a.txt\' was renamed to \'renamed.txt\' in the room; your deletion of \'b.txt\' reached the room.',
		]);
	});

	test('notices: an offline rename that can\'t be told from a copy is held, and the owner is told; the room keeps the old name', async () => {
		const { owner, roomId, folder } = await ownerSharesGuestJoins(matrixFolder);
		await owner.network.drop();
		// a.txt gone, and two new files with its text: either could be its new name.
		await owner.fileService.writeFile(URI.joinPath(folder, 'e.txt'), VSBuffer.fromString(matrixFolder['a.txt']));
		await owner.fileService.writeFile(URI.joinPath(folder, 'f.txt'), VSBuffer.fromString(matrixFolder['a.txt']));
		await owner.fileService.del(URI.joinPath(folder, 'a.txt'));
		await timeout(300);
		await restoreAndReattach(owner);
		await until(() => noticesWith(owner, 'weren\'t applied').length > 0, 'the warning').catch(() => { });
		assert.deepStrictEqual({
			told: noticesWith(owner, 'weren\'t applied').map(notice => notice.message),
			room: await roomPaths(owner, roomId),
		}, {
			told: ['Some of your changes from while you were away weren\'t applied, and nothing was changed in the room for them: \'a.txt\' is gone here, and LiveCollab couldn\'t tell which of \'e.txt\', \'f.txt\' is its new name.'],
			room: [...matrixBase, 'e.txt', 'f.txt'].sort(),
		});
	});

	test('notices: a large offline removal is asked about before it\'s applied; nothing leaves the room until the owner chooses Remove', async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 30; i++) {
			files[`gen/f${i}.txt`] = `generated ${i}`;
		}
		files['keep.txt'] = 'keep';
		const { owner, roomId, folder } = await ownerSharesGuestJoins(files);
		await owner.network.drop();
		// A branch switch with the app away: the generated folder is gone.
		await owner.fileService.del(URI.joinPath(folder, 'gen'), { recursive: true });
		await timeout(300);
		await restoreAndReattach(owner);
		await until(() => noticesWith(owner, 'files are gone').length > 0, 'the question').catch(() => { });
		const asked = noticesWith(owner, 'files are gone');
		const roomWhileAsked = await roomPaths(owner, roomId);
		await asked[0]?.choices[0].run();
		await until(async () => (await roomPaths(owner, roomId)).join() === 'keep.txt', 'the removal to reach the room').catch(() => { });
		assert.deepStrictEqual({
			asked: asked.map(notice => ({ message: notice.message, choices: notice.choices.map(choice => choice.label) })),
			roomStillWhole: roomWhileAsked.length,
			roomAfterRemove: await roomPaths(owner, roomId),
		}, {
			asked: [{
				message: '30 files are gone from this folder on this computer since LiveCollab last saw it (a branch switch does this), including \'gen/f0.txt\', \'gen/f1.txt\', \'gen/f10.txt\'. Applying that removes them from the room for everyone, and guests can\'t get them back. Nothing has been removed yet.',
				choices: ['Remove 30 Files from Room', 'Keep in Room', 'Show Log'],
			}],
			roomStillWhole: 32,
			roomAfterRemove: ['keep.txt'],
		});
	});

	test('notices: choosing Keep in Room writes the files back to the owner\'s disk; the next reconnect asks nothing', async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 30; i++) {
			files[`gen/f${i}.txt`] = `generated ${i}`;
		}
		files['keep.txt'] = 'keep';
		const { owner, roomId, folder } = await ownerSharesGuestJoins(files);
		const everything = (await listed(owner.fileService, folder)).sort();
		await owner.network.drop();
		await owner.fileService.del(URI.joinPath(folder, 'gen'), { recursive: true });
		await timeout(300);
		await restoreAndReattach(owner);
		await until(() => noticesWith(owner, 'files are gone').length > 0, 'the question');
		await noticesWith(owner, 'files are gone')[0].choices[1].run();
		await until(async () => (await listed(owner.fileService, folder)).sort().join() === everything.join(), 'the room\'s copies to come back to the disk').catch(() => { });
		const diskAfterKeep = (await listed(owner.fileService, folder)).sort();
		// The second time through: nothing diverges, so nothing asks.
		await owner.network.drop();
		await timeout(300);
		await restoreAndReattach(owner);
		await timeout(500);
		assert.deepStrictEqual({
			diskAfterKeep: diskAfterKeep.length,
			textCameBack: await textOf(owner, URI.joinPath(folder, 'gen', 'f7.txt')),
			askedAgain: noticesWith(owner, 'files are gone').length,
			room: (await roomPaths(owner, roomId)).length,
		}, { diskAfterKeep: everything.length, textCameBack: 'generated 7', askedAgain: 1, room: 32 });
	});

	/**
	 * Every file of a small room deleted offline, the folder they were in left (a folder emptied
	 * completely is never attached at all: the attach's empty-tree guard, so nothing is removed).
	 */
	test('notices: an offline removal that would empty a small room is asked about, whatever the count', async () => {
		const { owner, roomId, folder } = await ownerSharesGuestJoins({ 'src/a.txt': 'a', 'src/b.txt': 'b', 'src/c.txt': 'c' });
		await owner.network.drop();
		for (const name of ['a.txt', 'b.txt', 'c.txt']) {
			await owner.fileService.del(URI.joinPath(folder, 'src', name));
		}
		await timeout(300);
		await restoreAndReattach(owner);
		await until(() => noticesWith(owner, 'files are gone').length > 0, 'the question').catch(() => { });
		assert.deepStrictEqual({ asked: noticesWith(owner, 'files are gone').length, room: await roomPaths(owner, roomId) }, { asked: 1, room: ['src/', 'src/a.txt', 'src/b.txt', 'src/c.txt'] });
	});

	test('notices: the guest gets one notice for the owner\'s offline changes reaching the room', async () => {
		const { owner, guest, folder } = await ownerSharesGuestJoins(matrixFolder);
		await owner.network.drop();
		await owner.fileService.move(URI.joinPath(folder, 'a.txt'), URI.joinPath(folder, 'd.txt'));
		await owner.fileService.del(URI.joinPath(folder, 'b.txt'));
		await timeout(300);
		await restoreAndReattach(owner);
		await until(() => noticesWith(guest, 'reconnected').length > 0, 'the guest\'s notice').catch(() => { });
		const told = noticesWith(guest, 'reconnected').map(notice => notice.message.substring(notice.message.indexOf(' reconnected')));
		assert.deepStrictEqual(told, [' reconnected, and their changes from while they were away reached the room: \'a.txt\' renamed to \'d.txt\'; \'b.txt\' deleted.']);
	});

	test('notices: the owner\'s folder is empty on disk at the reconnect; nothing leaves the room, and the owner is told why', async () => {
		const { owner, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'a', 'b.txt': 'b' });
		await owner.network.drop();
		await owner.fileService.del(URI.joinPath(folder, 'a.txt'));
		await owner.fileService.del(URI.joinPath(folder, 'b.txt'));
		await timeout(300);
		await owner.network.restore();
		await until(() => noticesWith(owner, 'is empty on this computer').length > 0, 'the notice').catch(() => { });
		assert.deepStrictEqual({
			told: noticesWith(owner, 'is empty on this computer').map(notice => notice.message),
			room: await roomPaths(owner, roomId),
			ownerDisk: await listed(owner.fileService, folder),
		}, {
			told: ['\'project\' is empty on this computer, so nothing was removed from the room: it still has all its files, and none were put back in this folder.'],
			room: ['a.txt', 'b.txt'],
			ownerDisk: [],
		});
	});

	/**
	 * A branch switch with the app open and connected changes an open file on disk. Under Manny's
	 * 2026-11-12 ruling (outside changes reach the room; it replaces "the disk doesn't decide"),
	 * the room takes the branch's text. Before it this was a known failure the other way.
	 */
	test('editors: a branch switch with the app connected changes an open file on disk; the room takes the branch\'s text', async () => {
		const { owner, guest, folder } = await ownerSharesGuestJoins(matrixFolder);
		await owner.openFileEditor(URI.joinPath(folder, 'a.txt'));
		await until(() => logLines.some(line => line.includes('binding created for fileId')), 'the owner\'s editor to be bound');
		// The checkout: a raw disk write, as git makes it, not an edit in the editor.
		await owner.fileService.writeFile(URI.joinPath(folder, 'a.txt'), VSBuffer.fromString('a on the branch'));
		const roomA = () => guest.service.getRoomText(guest.fileSystem.getServerFileId('a.txt')!);
		await until(async () => await roomA() === 'a on the branch', 'the branch\'s text to reach the room').catch(() => { });
		assert.deepStrictEqual({ roomA: await roomA() }, { roomA: 'a on the branch' });
	});

	/**
	 * An edit meeting a delete survives (as in Dropbox and Drive): the guest deletes b.txt while the
	 * owner is away, and the owner edits b.txt on disk meanwhile. It isn't sent to the Trash: it
	 * goes back to the room, with the owner's text, as a new file.
	 */
	test('matrix: the guest deletes b.txt while the owner is away, and the owner edits it on disk; the edit survives in the room', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins(matrixFolder);
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		await owner.network.drop();
		await guest.workingCopyFileService.delete([{ resource: URI.joinPath(guestRoot, 'b.txt') }], CancellationToken.None);
		await owner.fileService.writeFile(URI.joinPath(folder, 'b.txt'), VSBuffer.fromString('edited while away'));
		await timeout(300);
		await restoreAndReattach(owner);
		await until(async () => (await listed(guest.fileService, guestRoot)).includes('b.txt'), 'b.txt to come back to the guest').catch(() => { });
		assert.deepStrictEqual({
			room: await roomPaths(owner, roomId),
			guestFiles: (await listed(guest.fileService, guestRoot)).sort(),
			ownerDiskText: await textOf(owner, URI.joinPath(folder, 'b.txt')),
		}, { room: matrixBase, guestFiles: matrixBase, ownerDiskText: 'edited while away' });
	});

	/**
	 * The 2026-10-29 session's re-entries (TEST_HARNESS_TRIAGE.md, "The delete read"): the owner's
	 * log shows each delete arriving while the owner was in the room, then the owner going back to
	 * the dashboard and re-entering ("room left — removing 1 room folder(s)", then a re-attach from
	 * disk) at 14:19 and 15:07. A delete made before the re-entry must stay deleted after it.
	 */
	for (const deleter of ['guest', 'owner'] as const) {
		test(`matrix: the ${deleter} deletes b.txt with both connected, then the owner re-enters the room; it stays deleted`, async () => {
			const { owner, guest, roomId, folder } = await ownerSharesGuestJoins(matrixFolder);
			const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
			const [client, root] = deleter === 'guest' ? [guest, guestRoot] : [owner, folder];
			await client.workingCopyFileService.delete([{ resource: URI.joinPath(root, 'b.txt') }], CancellationToken.None);
			const expected = without('b.txt');
			const shown = async () => ({
				ownerDisk: (await listed(owner.fileService, folder)).sort(),
				guestFiles: (await listed(guest.fileService, guestRoot)).sort(),
			});
			await until(async () => { const s = await shown(); return [s.ownerDisk, s.guestFiles].every(l => l.join() === expected.join()); }, 'the delete to reach both sides');
			const attaches = () => logLines.filter(line => line.includes('folder attached:')).length;
			const before = attaches();
			owner.service.returnToDashboard('test');
			await until(() => owner.workspace.getWorkspace().folders.length === 0, 'the owner\'s room folder to be removed');
			await owner.service.joinExistingRoom(roomId);
			await until(() => attaches() > before, 'the owner\'s re-attach');
			await timeout(300);
			assert.deepStrictEqual({ ...await shown(), room: await roomPaths(owner, roomId) }, { ownerDisk: expected, guestFiles: expected, room: expected });
		});
	}

	/**
	 * The remaining matrix cases (ATTACH_RECONCILE_DESIGN.md), run before 0.3.5 under Manny's
	 * 2026-11-05 ruling: run and log, fix nothing now, except a case where a file vanishes from the
	 * room or the owner's disk. A failing case is a knownFailure here, pointing at its entry in
	 * TEST_HARNESS_TRIAGE.md, "The remaining matrix cases".
	 */
	const remaining = 'TEST_HARNESS_TRIAGE.md, "The remaining matrix cases"';
	const guestUri = (roomId: string, path: string) => URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: `/${path}` });
	const textOf = async (c: IBClient, resource: URI) => (await c.fileService.readFile(resource)).value.toString();

	/** #12: the guest types in an open file while the owner is away; the edit reaches the owner's disk on return. */
	test('matrix #12: guest edits a.txt while the owner is away', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins(matrixFolder);
		const guestEditor = await openBound(guest, guestUri(roomId, 'a.txt'));
		await owner.network.drop();
		guestEditor.type(' edit');
		await timeout(300);
		await restoreAndReattach(owner);
		await until(async () => await textOf(owner, URI.joinPath(folder, 'a.txt')) === 'a edit', 'the edit to reach the owner\'s disk').catch(() => { });
		assert.deepStrictEqual({
			guestText: guestEditor.text(),
			ownerDiskText: await textOf(owner, URI.joinPath(folder, 'a.txt')),
			room: await roomPaths(owner, roomId),
		}, { guestText: 'a edit', ownerDiskText: 'a edit', room: matrixBase });
	});

	/** Group 3: the guest is away, the owner acts in the Explorer, the guest comes back. */
	const groupThree: { n: number; name: string; act(owner: IBClient, folder: URI): Promise<unknown>; expected: string[]; text?: string }[] = [
		{ n: 17, name: 'owner creates new.txt', act: (c, f) => c.workingCopyFileService.create([{ resource: URI.joinPath(f, 'new.txt') }], CancellationToken.None), expected: [...matrixBase, 'new.txt'].sort() },
		{
			n: 18, name: 'owner edits a.txt', act: async (c, f) => {
				const editor = await openBound(c, URI.joinPath(f, 'a.txt'));
				editor.type(' edit');
			}, expected: matrixBase, text: 'a edit'
		},
		{ n: 19, name: 'owner renames a.txt to renamed.txt', act: (c, f) => c.workingCopyFileService.move([{ file: { source: URI.joinPath(f, 'a.txt'), target: URI.joinPath(f, 'renamed.txt') } }], CancellationToken.None), expected: [...without('a.txt'), 'renamed.txt'].sort() },
		{ n: 20, name: 'owner deletes b.txt', act: (c, f) => c.workingCopyFileService.delete([{ resource: URI.joinPath(f, 'b.txt') }], CancellationToken.None), expected: without('b.txt') },
		{
			n: 21, name: 'owner creates n/x.txt', act: async (c, f) => {
				await c.workingCopyFileService.createFolder([{ resource: URI.joinPath(f, 'n') }], CancellationToken.None);
				await c.workingCopyFileService.create([{ resource: URI.joinPath(f, 'n', 'x.txt') }], CancellationToken.None);
			}, expected: [...matrixBase, 'n/', 'n/x.txt'].sort()
		},
		{ n: 22, name: 'owner deletes p/q/', act: (c, f) => c.workingCopyFileService.delete([{ resource: URI.joinPath(f, 'p', 'q'), recursive: true }], CancellationToken.None), expected: without('p/q/', 'p/q/r.txt', 'p/q/s.txt') },
	];
	const groupThreeFailures = new Map<number, string>([
		[19, 'the guest still shows a.txt'],
		[20, 'the guest still shows b.txt'],
		[22, 'the guest still shows p/q/'],
	]);
	for (const matrixCase of groupThree) {
		const failure = groupThreeFailures.get(matrixCase.n);
		test(`matrix #${matrixCase.n}: ${matrixCase.name} while the guest is away${failure ? ` (known failure: ${failure})` : ''}`, async () => {
			const { owner, guest, roomId, folder } = await ownerSharesGuestJoins(matrixFolder);
			const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
			await guest.network.drop();
			await matrixCase.act(owner, folder);
			await timeout(300);
			await guest.network.restore();
			const shown = async () => ({
				ownerDisk: (await listed(owner.fileService, folder)).sort(),
				guestFiles: (await listed(guest.fileService, guestRoot)).sort(),
				...matrixCase.text ? { guestText: await textOf(guest, URI.joinPath(guestRoot, 'a.txt')).catch(() => '(none)'), ownerDiskText: await textOf(owner, URI.joinPath(folder, 'a.txt')) } : {},
			});
			const expected = { ownerDisk: matrixCase.expected, guestFiles: matrixCase.expected, ...matrixCase.text ? { guestText: matrixCase.text, ownerDiskText: matrixCase.text } : {} };
			const check = async () => {
				await until(async () => JSON.stringify(await shown()) === JSON.stringify(expected), 'both sides to show the change').catch(() => { });
				assert.deepStrictEqual({ ...await shown(), room: await roomPaths(owner, roomId) }, { ...expected, room: matrixCase.expected });
			};
			await (failure ? knownFailure(`matrix #${matrixCase.n}`, remaining, check) : check());
		});
	}

	/**
	 * #23-#30: the owner away, with changes on the owner's disk made outside the app (a direct
	 * file service write, like Finder), and on some the guest's too. Where two people changed one
	 * path, which wins isn't ruled yet, so those cases assert only what holds under any ruling:
	 * the owner's id map names nothing the room doesn't (no stale entry), and the owner's own disk
	 * change stands. Where the outcome is clear (both deleted), all three views are asserted.
	 */
	const staleCases: { n: number; name: string; guest?(c: IBClient, root: URI): Promise<unknown>; disk(c: IBClient, folder: URI): Promise<unknown>; ownerDisk: string[]; keepsId?: [string, string] }[] = [
		{
			n: 23, name: 'guest renames a.txt to c.txt, owner renames a.txt to d.txt on disk',
			guest: (c, root) => c.workingCopyFileService.move([{ file: { source: URI.joinPath(root, 'a.txt'), target: URI.joinPath(root, 'c.txt') } }], CancellationToken.None),
			disk: (c, f) => c.fileService.move(URI.joinPath(f, 'a.txt'), URI.joinPath(f, 'd.txt')),
			ownerDisk: [...without('a.txt'), 'd.txt'].sort(), keepsId: ['a.txt', 'd.txt'],
		},
		{
			n: 24, name: 'guest renames a.txt to c.txt, owner deletes a.txt on disk',
			guest: (c, root) => c.workingCopyFileService.move([{ file: { source: URI.joinPath(root, 'a.txt'), target: URI.joinPath(root, 'c.txt') } }], CancellationToken.None),
			disk: (c, f) => c.fileService.del(URI.joinPath(f, 'a.txt')),
			ownerDisk: without('a.txt'),
		},
		{
			n: 25, name: 'both delete b.txt',
			guest: (c, root) => c.workingCopyFileService.delete([{ resource: URI.joinPath(root, 'b.txt') }], CancellationToken.None),
			disk: (c, f) => c.fileService.del(URI.joinPath(f, 'b.txt')),
			ownerDisk: without('b.txt'),
		},
		{
			n: 26, name: 'both delete p/q/',
			guest: (c, root) => c.workingCopyFileService.delete([{ resource: URI.joinPath(root, 'p', 'q'), recursive: true }], CancellationToken.None),
			disk: (c, f) => c.fileService.del(URI.joinPath(f, 'p', 'q'), { recursive: true }),
			ownerDisk: without('p/q/', 'p/q/r.txt', 'p/q/s.txt'),
		},
		{
			n: 27, name: 'guest deletes b.txt, owner renames b.txt to e.txt on disk',
			guest: (c, root) => c.workingCopyFileService.delete([{ resource: URI.joinPath(root, 'b.txt') }], CancellationToken.None),
			disk: (c, f) => c.fileService.move(URI.joinPath(f, 'b.txt'), URI.joinPath(f, 'e.txt')),
			ownerDisk: [...without('b.txt'), 'e.txt'].sort(),
		},
		{
			n: 29, name: 'owner renames a.txt to d.txt on disk, guest idle',
			disk: (c, f) => c.fileService.move(URI.joinPath(f, 'a.txt'), URI.joinPath(f, 'd.txt')),
			ownerDisk: [...without('a.txt'), 'd.txt'].sort(), keepsId: ['a.txt', 'd.txt'],
		},
		{
			n: 30, name: 'owner deletes b.txt on disk, guest idle',
			disk: (c, f) => c.fileService.del(URI.joinPath(f, 'b.txt')),
			ownerDisk: without('b.txt'),
		},
	];
	// #23-#27 were known failures (stale map entries) until the map followed the attach ack.
	const staleFailures = new Map<number, string>();
	for (const matrixCase of staleCases) {
		const failure = staleFailures.get(matrixCase.n);
		test(`matrix #${matrixCase.n}: ${matrixCase.name}, while the owner is away${failure ? ` (known failure: ${failure})` : ''}`, async () => {
			const { owner, guest, roomId, folder } = await ownerSharesGuestJoins(matrixFolder);
			const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
			const idBefore = matrixCase.keepsId && owner.fileSystem.getServerFileId(matrixCase.keepsId[0]);
			await owner.network.drop();
			await matrixCase.guest?.(guest, guestRoot);
			await matrixCase.disk(owner, folder);
			await timeout(300);
			await restoreAndReattach(owner);
			// The re-attach's catch-up writes after its quiet period.
			await timeout(1500);
			const check = async () => {
				const room = await roomSnapshot(owner, roomId);
				const roomIds = idsIn(room.tree);
				const ownerMap = owner.fileSystem.allServerIds().map(([path, id]) => `${path}=${id}`);
				const ownerDisk = (await listed(owner.fileService, folder)).sort();
				const guestFiles = (await listed(guest.fileService, guestRoot)).sort();
				// A rename keeps the file's id: the room's file moved, it wasn't deleted and added again.
				const keptId = matrixCase.keepsId ? { keptId: roomIds.includes(`${matrixCase.keepsId[1]}=${idBefore}`) } : {};
				assert.deepStrictEqual(
					{ staleInOwnerMap: ownerMap.filter(entry => !roomIds.includes(entry)).sort(), ownerDisk, guestFiles, room: paths(room.tree).sort(), ...keptId },
					{ staleInOwnerMap: [], ownerDisk: matrixCase.ownerDisk, guestFiles: matrixCase.ownerDisk, room: matrixCase.ownerDisk, ...matrixCase.keepsId ? { keptId: true } : {} });
			};
			await (failure ? knownFailure(`matrix #${matrixCase.n}`, remaining, check) : check());
		});
	}

	/**
	 * Found in the real window, 2026-11-12 (CHAT_DESIGN.md, "Outside chat"): a file deleted on the
	 * owner's disk outside the app, then a reconnect. The reconcile deletes it from the room as an
	 * offline delete; a catch-up queued from a snapshot that still had the file must not write it
	 * back. (In the window the delete was made while connected; since outside changes reach the
	 * room live, the reconnect race needs the delete made while away.)
	 */
	test('matrix: the owner deletes b.txt on disk outside the app while away, then reconnects; a catch-up under way doesn\'t write it back', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins(matrixFolder);
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		await owner.network.drop();
		await owner.fileService.del(URI.joinPath(folder, 'b.txt'));
		await timeout(300);
		// A real disk takes a moment to answer realpath: a catch-up is then still writing b.txt
		// when the room's delete of it arrives, as in the window.
		owner.kept.disk.realpathDelays.set(URI.joinPath(folder, 'b.txt').path, 400);
		await restoreAndReattach(owner);
		// The re-attach's catch-up writes after its quiet period.
		await timeout(1500);
		const deletedAt = logLines.findIndex(line => line.includes('room:file:deleted ["b.txt"]'));
		assert.deepStrictEqual({
			deleteHeard: deletedAt >= 0,
			writtenAfterTheDelete: logLines.slice(deletedAt).filter(line => line.includes('persist: wrote b.txt')).length,
			ownerDisk: (await listed(owner.fileService, folder)).sort(),
			guestFiles: (await listed(guest.fileService, guestRoot)).sort(),
			room: await roomPaths(owner, roomId),
		}, { deleteHeard: true, writtenAfterTheDelete: 0, ownerDisk: without('b.txt'), guestFiles: without('b.txt'), room: without('b.txt') });
	});

	test('members: who is online follows the server\'s presence; a member whose connection drops is offline until it\'s back', async () => {
		const { owner, guest } = await ownerSharesGuestJoins(matrixFolder);
		const guestId = guest.service.myUserId;
		const seen = () => ({ guest: owner.service.isOnline(guestId), owner: owner.service.isOnline(owner.service.myUserId) });
		await until(() => owner.service.isOnline(guestId), 'the guest to be online');
		const both = seen();
		await guest.network.drop();
		await until(() => !owner.service.isOnline(guestId), 'the guest to be offline').catch(() => { });
		const dropped = seen();
		await guest.network.restore();
		await until(() => owner.service.isOnline(guestId), 'the guest to be back').catch(() => { });
		assert.deepStrictEqual({ both, dropped, back: seen() }, {
			both: { guest: true, owner: true },
			dropped: { guest: false, owner: true },
			back: { guest: true, owner: true },
		});
	});

	/**
	 * Changes made to the owner's folder outside the app while connected: a shell, Finder, git or
	 * another editor (Manny, 2026-11-12: they reach the room, deletes included; this replaces "the
	 * disk doesn't decide", ATTACH_RECONCILE_DESIGN.md). Made here with the raw file service, which
	 * no working-copy event sees, as a shell's are.
	 */
	const guestText = async (guest: IBClient, path: string) => {
		const id = guest.fileSystem.getServerFileId(path);
		return id ? guest.service.getRoomText(id) : undefined;
	};
	const outsideLines = () => logLines.filter(line => line.includes('outside the app:'));

	test('outside the app: a file created, edited, renamed and deleted on the owner\'s disk while connected reaches the room; a rename keeps its id', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins(matrixFolder);
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		const idOfA = owner.fileSystem.getServerFileId('a.txt');
		await owner.fileService.writeFile(URI.joinPath(folder, 'new.txt'), VSBuffer.fromString('made in a shell'));
		await owner.fileService.writeFile(URI.joinPath(folder, 'd/c.txt'), VSBuffer.fromString('c edited in another editor'));
		await owner.fileService.move(URI.joinPath(folder, 'a.txt'), URI.joinPath(folder, 'renamed.txt'));
		await owner.fileService.del(URI.joinPath(folder, 'b.txt'));
		const expected = [...without('a.txt', 'b.txt'), 'new.txt', 'renamed.txt'].sort();
		await until(async () => (await listed(guest.fileService, guestRoot)).sort().join() === expected.join() && await guestText(guest, 'new.txt') === 'made in a shell' && await guestText(guest, 'd/c.txt') === 'c edited in another editor', 'the outside changes to reach the guest').catch(() => { });
		const room = await roomSnapshot(owner, roomId);
		assert.deepStrictEqual({
			guestFiles: (await listed(guest.fileService, guestRoot)).sort(),
			room: paths(room.tree).sort(),
			newText: await guestText(guest, 'new.txt'),
			editedText: await guestText(guest, 'd/c.txt'),
			renameKeptId: idsIn(room.tree).includes(`renamed.txt=${idOfA}`),
			ownerDisk: (await listed(owner.fileService, folder)).sort(),
		}, { guestFiles: expected, room: expected, newText: 'made in a shell', editedText: 'c edited in another editor', renameKeptId: true, ownerDisk: expected });
	});

	test('outside the app: the room\'s own changes reaching the owner\'s disk are not sent back as outside changes', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins(matrixFolder);
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		await guest.workingCopyFileService.create([{ resource: URI.joinPath(guestRoot, 'g.txt') }], CancellationToken.None);
		await guest.workingCopyFileService.move([{ file: { source: URI.joinPath(guestRoot, 'a.txt'), target: URI.joinPath(guestRoot, 'moved.txt') } }], CancellationToken.None);
		await guest.workingCopyFileService.delete([{ resource: URI.joinPath(guestRoot, 'b.txt') }], CancellationToken.None);
		await guest.service.replaceRoomText(guest.fileSystem.getServerFileId('d/c.txt')!, 'c from the guest');
		const expected = [...without('a.txt', 'b.txt'), 'g.txt', 'moved.txt'].sort();
		await until(async () => (await listed(owner.fileService, folder)).sort().join() === expected.join(), 'the guest\'s changes to reach the owner\'s disk');
		// The persister writes after its quiet period; the watcher's batch after its own.
		await timeout(2500);
		assert.deepStrictEqual({
			outsideSent: outsideLines(),
			conflictsTold: noticesWith(owner, 'outside LiveCollab').length,
			room: await roomPaths(owner, roomId),
			ownerDiskC: (await owner.fileService.readFile(URI.joinPath(folder, 'd/c.txt'))).value.toString(),
			roomC: await guestText(guest, 'd/c.txt'),
		}, { outsideSent: [], conflictsTold: 0, room: expected, ownerDiskC: 'c from the guest', roomC: 'c from the guest' });
	});

	test('outside the app: a branch switch while connected adds its new files at once, and asks before the many it deletes leave the room', async () => {
		const files: Record<string, string> = { 'keep.txt': 'keep' };
		for (let i = 0; i < 30; i++) {
			files[`old/f${i}.txt`] = `old branch ${i}`;
		}
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins(files);
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		// git checkout: the old branch's files go, the new branch's arrive.
		await owner.fileService.del(URI.joinPath(folder, 'old'), { recursive: true });
		for (let i = 0; i < 30; i++) {
			await owner.fileService.writeFile(URI.joinPath(folder, `new/f${i}.txt`), VSBuffer.fromString(`new branch ${i}`));
		}
		await until(() => noticesWith(owner, 'files are gone').length > 0, 'the question').catch(() => { });
		const withText = async () => {
			let count = 0;
			for (let i = 0; i < 30; i++) {
				if (await guestText(guest, `new/f${i}.txt`) === `new branch ${i}`) { count++; }
			}
			return count;
		};
		await until(async () => await withText() === 30, 'the new branch\'s files, with their text, to reach the guest').catch(() => { });
		const asked = noticesWith(owner, 'files are gone');
		const whileAsked = (await listed(guest.fileService, guestRoot)).sort();
		const newWithText = await withText();
		await asked[0]?.choices[0].run();
		const after = ['keep.txt', 'new/', ...Array.from({ length: 30 }, (_, i) => `new/f${i}.txt`)].sort();
		await until(async () => (await roomPaths(owner, roomId)).join() === after.join(), 'the removal to reach the room').catch(() => { });
		assert.deepStrictEqual({
			asked: asked.map(notice => notice.choices.map(choice => choice.label)),
			oldStillThereWhileAsked: whileAsked.filter(path => path.startsWith('old/f')).length,
			newThereWhileAsked: whileAsked.filter(path => path.startsWith('new/f')).length,
			newWithText,
			roomAfterRemove: await roomPaths(owner, roomId),
			guestAfterRemove: (await listed(guest.fileService, guestRoot)).sort(),
		}, {
			asked: [['Remove 30 Files from Room', 'Keep in Room', 'Show Log']],
			oldStillThereWhileAsked: 30,
			newThereWhileAsked: 30,
			newWithText: 30,
			roomAfterRemove: after,
			guestAfterRemove: after,
		});
	});

	/**
	 * Found by #29's first run: on reconnect the folder contribution attaches as soon as the socket
	 * connects, while the service's re-join is still on its way, so the server can refuse the attach
	 * ("You are not in this room right now"). Then nothing the owner changed on disk while away
	 * reaches the room until the next reconnect. Here the re-join is held 300 ms so the attach
	 * always arrives first.
	 */
	test('matrix #29 with a slow re-join: the owner\'s re-attach is accepted and the offline rename reaches the room', async () => {
		const { owner, roomId, folder } = await ownerSharesGuestJoins(matrixFolder);
		await owner.network.drop();
		await owner.fileService.move(URI.joinPath(folder, 'a.txt'), URI.joinPath(folder, 'd.txt'));
		const count = (text: string) => logLines.filter(line => line.includes(text)).length;
		const [attached, refused] = [count('folder attached:'), count('room:attach FAILED')];
		owner.network.delayOutgoing('room:join', 300);
		await owner.network.restore();
		await until(() => count('folder attached:') > attached || count('room:attach FAILED') > refused, 'the owner\'s re-attach to be answered');
		await timeout(500);
		assert.deepStrictEqual({ attachRefused: count('room:attach FAILED') > refused, roomHasTheRename: (await roomPaths(owner, roomId)).includes('d.txt') }, { attachRefused: false, roomHasTheRename: true });
	});

	/**
	 * Item 4 (release gate): Open on the dashboard card of the room the owner is already in ends
	 * the session and joins again. The leave removes the room's folder, and the workbench applies a
	 * removal only once the workspace file is written (`changeDelay`), so the join's restore saw the
	 * folder still open, attached it, and then the removal landed: No Folder Opened, while the room
	 * thought the folder attached (CHAT_DESIGN.md, "Outside chat").
	 */
	test('windows: the owner opens the room they are already in; their folder stays open and attached', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'a' });
		const attaches = () => logLines.filter(line => line.includes('folder attached:')).length;
		const before = attaches();
		owner.workspace.changeDelay = 50;
		await owner.service.joinExistingRoom(roomId);
		await until(() => attaches() > before, 'the owner\'s attach').catch(() => { });
		await timeout(300);
		owner.workspace.changeDelay = 0;
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		assert.deepStrictEqual({
			ownerFolders: owner.workspace.getWorkspace().folders.map(f => f.uri.toString()),
			room: await roomPaths(owner, roomId),
			guestFiles: await listed(guest.fileService, guestRoot),
		}, { ownerFolders: [folder.toString()], room: ['a.txt'], guestFiles: ['a.txt'] });
	});

	/** The same leave, on a switch: from the owner's room with one folder to their room with another; the second opens. */
	test('windows: the owner switches from one of their rooms to another; the second room\'s folder opens', async () => {
		const owner = await windowClient('owner');
		const first = await owner.service.createRoomNamed('layer-b');
		const second = await owner.service.createRoomNamed('layer-b-2');
		assert.ok(first && second, 'the server created no room');
		const share = async (roomId: string, name: string) => {
			const folder = URI.file(`/layer-b/run-${run}/${name}`);
			await owner.fileService.writeFile(URI.joinPath(folder, `${name}.txt`), VSBuffer.fromString(name));
			await owner.service.joinExistingRoom(roomId);
			await owner.workspace.updateFolders(0, 0, [{ uri: folder }]);
			await until(async () => (await owner.service.getRoomFolder())?.hasFolder === true, `${name} to be shared`);
			return folder;
		};
		const secondFolder = await share(second, 'two');
		owner.service.returnToDashboard('test');
		await until(() => owner.workspace.getWorkspace().folders.length === 0, 'the second room\'s folder to be removed');
		await share(first, 'one');
		owner.workspace.changeDelay = 50;
		await owner.service.joinExistingRoom(second);
		await until(() => owner.workspace.getWorkspace().folders.some(f => isEqual(f.uri, secondFolder)), 'the second room\'s folder').catch(() => { });
		await timeout(300);
		owner.workspace.changeDelay = 0;
		assert.deepStrictEqual({ ownerFolders: owner.workspace.getWorkspace().folders.map(f => f.uri.toString()), room: await roomPaths(owner, second) }, { ownerFolders: [secondFolder.toString()], room: ['two.txt'] });
	});

	/**
	 * A guest's room window holds the room's folder and nothing else (staging, 2026-11-16: a guest
	 * window opened with a real folder kept it beside the room's, so typing there edited a file
	 * outside the room). Folder changes take effect late and are worked out from the folders seen
	 * when called, as in a single-folder or empty window, so a removal and an add that overlap can
	 * undo each other.
	 */
	for (const start of ['a real folder open', 'no folder open'] as const) {
		test(`windows: a guest joining from a window with ${start} ends up with only the room's folder`, async () => {
			const stray = URI.file(`/layer-b/run-${run}/guest-own`);
			const { guest, roomId } = await ownerSharesGuestJoins({ 'a.txt': 'a' }, async guestWindow => {
				if (start === 'a real folder open') {
					await guestWindow.fileService.writeFile(URI.joinPath(stray, 'mine.txt'), VSBuffer.fromString('mine'));
					await guestWindow.workspace.updateFolders(0, 0, [{ uri: stray }]);
				}
				guestWindow.workspace.changeDelay = 50;
				guestWindow.workspace.readsFoldersWhenCalled = true;
			});
			await timeout(300);
			guest.workspace.changeDelay = 0;
			guest.workspace.readsFoldersWhenCalled = false;
			assert.deepStrictEqual(guest.workspace.getWorkspace().folders.map(f => f.uri.toString()), [URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' }).toString()]);
		});
	}

	/**
	 * The same ordering on a first join: the folder opens while the owner's join of the room is
	 * still on its way (held 300 ms), so the attach it triggers must wait for the join's ack.
	 */
	test('windows: the owner opens a folder while the first join is still on its way; the attach waits for it and is accepted', async () => {
		const owner = await windowClient('owner');
		const roomId = await owner.service.createRoomNamed('layer-b');
		assert.ok(roomId, 'the server created no room');
		const folder = URI.file(`/layer-b/run-${run}/project`);
		await owner.fileService.writeFile(URI.joinPath(folder, 'a.txt'), VSBuffer.fromString('alpha'));
		const count = (text: string) => logLines.filter(line => line.includes(text)).length;
		owner.network.delayOutgoing('room:join', 300);
		const joined = owner.service.joinExistingRoom(roomId);
		await owner.workspace.updateFolders(0, 0, [{ uri: folder }]);
		await joined;
		owner.network.delayOutgoing('room:join', 0);
		await until(() => count('folder attached:') > 0 || count('room:attach FAILED') > 0, 'the owner\'s attach to be answered');
		assert.deepStrictEqual({ attachRefused: count('room:attach FAILED') > 0, room: await roomPaths(owner, roomId) }, { attachRefused: false, room: ['a.txt'] });
	});

	// ATTACH_RECONCILE_DESIGN.md, "Sharing asks first" (Manny, 2026-11-13).

	/** What the server holds as the room's shared files: their paths, or none. */
	async function sharedIn(window: IBClient, roomId: string): Promise<string[]> {
		const answer = await window.network.ask<{ ok?: boolean; tree?: ILiveCollabTreeItem[] }>('room:request-snapshot', { roomId });
		return answer?.ok && answer.tree ? paths(answer.tree).sort() : [];
	}
	/**
	 * What the server holds as `roomId`'s shared files, read from inside the room by `window` (the
	 * server answers a snapshot request only in the room, so a room left can't be read from outside).
	 */
	async function sharedFrom(window: IBClient, roomId: string): Promise<string[] | string> {
		await window.service.joinExistingRoom(roomId);
		await window.service.whenJoinConfirmed(window.service.roomEpoch);
		const answer = await window.network.ask<{ ok?: boolean; error?: string; tree?: ILiveCollabTreeItem[] }>('room:request-snapshot', { roomId });
		// no_snapshot: the room was never given a folder. Any other refusal is no answer at all.
		return answer?.ok ? paths(answer.tree ?? []).sort() : answer?.error === 'no_snapshot' ? [] : `not answered: ${answer?.error}`;
	}
	/** A new room of the owner's, named `name`, entered in `window` as the dashboard enters it. */
	async function ownersRoom(window: IBClient, name: string): Promise<string> {
		const roomId = await window.service.createRoomNamed(name);
		assert.ok(roomId, 'the server created no room');
		await window.service.joinExistingRoom(roomId, name);
		return roomId;
	}
	/** A folder on `window`'s disk holding `files`. */
	async function folderWith(window: IBClient, path: string, files: Record<string, string> = { 'a.txt': 'a' }): Promise<URI> {
		const folder = URI.file(`/layer-b/run-${run}/${path}`);
		for (const [file, content] of Object.entries(files)) {
			await window.fileService.writeFile(URI.joinPath(folder, ...file.split('/')), VSBuffer.fromString(content));
		}
		return folder;
	}
	/** Another window on the same computer as `first` (its disk, storage and record of shared folders), signed in as the same account. */
	async function sameComputer(first: IBClient): Promise<IBClient> {
		const window = createBClient(serverUrl!, testStore!, first.kept);
		accounts.set(window, accounts.get(first)!);
		await signIn(window.service, 'owner', accounts.get(first));
		return window;
	}
	/** Back to the dashboard: the room's folder leaves the window. */
	async function toDashboard(window: IBClient): Promise<void> {
		window.service.returnToDashboard('test');
		await until(() => window.workspace.getWorkspace().folders.length === 0, 'the room\'s folder to leave the window');
	}
	/** A question, as the person reads it: the question, the overlap paragraph if any, and the buttons. */
	function question(asked: IBQuestion): string {
		const overlap = asked.detail.split('\n\n')[1];
		return `${asked.message}${overlap ? ` | ${overlap}` : ''} [${asked.primaryButton} / ${asked.cancelButton}]`;
	}
	const asksAgain = 'Edits and deletions affect the same files on this computer and can appear in both rooms. To keep the work separate, cancel and share a separate copy.';

	test('sharing: every route that adds a folder asks "Share … with …?" before any of it reaches the room', async () => {
		const owner = await windowClient('owner');
		// What each route calls in the end (FEATURE audit, ATTACH_RECONCILE_DESIGN.md "Routes a folder takes").
		const routes: Record<string, (folder: URI) => Promise<void>> = {
			'Open Folder, Open Recent, Welcome, Finder (main hands it over: updateFolders at the end)': folder => owner.workspace.updateFolders(owner.workspace.getWorkspace().folders.length, 0, [{ uri: folder }]),
			'the Explorer\'s Open Folder and "add a folder" links (Add Folder to Workspace: addFolders)': folder => owner.workspace.addFolders([{ uri: folder }]),
			'Git\'s Add to Workspace and any extension (workspace.updateWorkspaceFolders: updateFolders)': folder => owner.workspace.updateFolders(0, 0, [{ uri: folder }]),
		};
		const seen: Record<string, unknown> = {};
		const expected: Record<string, unknown> = {};
		let n = 0;
		for (const [route, add] of Object.entries(routes)) {
			n++;
			const roomId = await ownersRoom(owner, `Route ${n}`);
			const folder = await folderWith(owner, `route-${n}`);
			const answer = new DeferredPromise<boolean>();
			owner.dialogs.answer = () => answer.p;
			const before = owner.dialogs.asked.length;
			await add(folder);
			await until(() => owner.dialogs.asked.length > before, `${route} to ask`).catch(() => { });
			await timeout(300);
			const whileAsking = await sharedIn(owner, roomId);
			answer.complete(true);
			await until(async () => (await sharedIn(owner, roomId)).length > 0, `${route} to share once answered`).catch(() => { });
			seen[route] = { asked: owner.dialogs.asked.slice(before).map(question), whileAsking, afterShare: await sharedIn(owner, roomId) };
			expected[route] = { asked: [`Share \u201croute-${n}\u201d with \u201cRoute ${n}\u201d? [Share / Don't Share]`], whileAsking: [], afterShare: ['a.txt'] };
			await toDashboard(owner);
		}
		assert.deepStrictEqual(seen, expected);
	});

	test('sharing: Don\'t Share leaves the folder open on this computer only: nothing reaches the room, not a file made in it, not a reconnect; removed and added again, it is asked about again', async () => {
		const owner = await windowClient('owner');
		const roomId = await ownersRoom(owner, 'Kept local');
		const folder = await folderWith(owner, 'local-only');
		owner.dialogs.answer = () => false;
		await owner.workspace.updateFolders(0, 0, [{ uri: folder }]);
		await until(() => owner.dialogs.asked.length > 0, 'the question').catch(() => { });
		await timeout(300);
		await owner.fileService.writeFile(URI.joinPath(folder, 'b.txt'), VSBuffer.fromString('b'));
		await owner.network.drop();
		await owner.network.restore();
		await timeout(600);
		const declined = { asked: owner.dialogs.asked.length, open: owner.workspace.getWorkspace().folders.map(f => f.uri.toString()), room: await sharedIn(owner, roomId) };
		owner.dialogs.answer = () => true;
		await owner.workspace.removeFolders([folder]);
		await owner.workspace.updateFolders(0, 0, [{ uri: folder }]);
		await until(async () => (await sharedIn(owner, roomId)).length > 0, 'the folder to be shared once Share is chosen').catch(() => { });
		assert.deepStrictEqual({ declined, again: { asked: owner.dialogs.asked.length, room: await sharedIn(owner, roomId) } }, {
			declined: { asked: 1, open: [folder.toString()], room: [] },
			again: { asked: 2, room: ['a.txt', 'b.txt'] },
		});
	});

	test('sharing: a folder this computer already shared in the room isn\'t asked about again: back to the dashboard and in again, a reconnect, a relaunch', async () => {
		const owner = await windowClient('owner');
		const roomId = await ownersRoom(owner, 'Shared before');
		const folder = await folderWith(owner, 'shared-before');
		await owner.workspace.updateFolders(0, 0, [{ uri: folder }]);
		await until(async () => (await sharedIn(owner, roomId)).length > 0, 'the first share');
		const attaches = () => logLines.filter(line => line.includes('folder attached:')).length;
		await toDashboard(owner);
		let before = attaches();
		await owner.service.joinExistingRoom(roomId, 'Shared before');
		await until(() => attaches() > before, 'the re-entry\'s attach');
		before = attaches();
		await owner.network.drop();
		await owner.network.restore();
		await until(() => attaches() > before, 'the reconnect\'s attach');
		await owner.network.drop();
		const relaunched = await restart(owner, roomId, folder);
		assert.deepStrictEqual({ firstWindow: owner.dialogs.asked.map(question), relaunched: relaunched.dialogs.asked.length, room: await sharedIn(relaunched, roomId) }, {
			firstWindow: ['Share \u201cshared-before\u201d with \u201cShared before\u201d? [Share / Don\'t Share]'],
			relaunched: 0,
			room: ['a.txt'],
		});
	});

	test('sharing: a folder overlapping one shared in another of the owner\'s rooms (the same, inside it, containing it) names that room, after a return to the dashboard too; Cancel leaves it unshared, Share Anyway shares it; a different folder gets only the plain question', async () => {
		const one = await windowClient('owner');
		const release = await ownersRoom(one, 'Release planning');
		const app = await folderWith(one, 'work/app', { 'a.txt': 'a', 'src/main.ts': 'm' });
		await folderWith(one, 'elsewhere', { 'e.txt': 'e' });
		await one.workspace.updateFolders(0, 0, [{ uri: app }]);
		await until(async () => (await sharedIn(one, release)).length > 0, 'Release planning to share work/app');
		// The record stays across a return to the dashboard.
		await toDashboard(one);
		const two = await sameComputer(one);
		const cases: [string, URI, boolean][] = [
			['same', app, false],
			['inside', URI.joinPath(app, 'src'), true],
			['containing', URI.file(`/layer-b/run-${run}/work`), true],
			['different', URI.file(`/layer-b/run-${run}/elsewhere`), true],
		];
		const seen: Record<string, unknown> = {};
		for (const [name, folder, share] of cases) {
			const roomId = await ownersRoom(two, `Room ${name}`);
			two.dialogs.answer = () => share;
			const before = two.dialogs.asked.length;
			await two.workspace.updateFolders(0, 0, [{ uri: folder }]);
			await until(() => two.dialogs.asked.length > before, `the question for ${name}`).catch(() => { });
			if (share) {
				await until(async () => (await sharedIn(two, roomId)).length > 0, `${name} to be shared`).catch(() => { });
			} else {
				await timeout(300);
			}
			seen[name] = { asked: two.dialogs.asked.slice(before).map(question), shared: (await sharedIn(two, roomId)).length > 0 };
			if (!share) {
				// A folder not shared isn't the room's, so leaving doesn't remove it (the next room's entry does).
				await two.workspace.removeFolders([folder]);
			}
			await toDashboard(two);
		}
		assert.deepStrictEqual(seen, {
			same: { asked: [`Share \u201capp\u201d with \u201cRoom same\u201d? | This folder is also shared in \u201cRelease planning\u201d. ${asksAgain} [Share Anyway / Cancel]`], shared: false },
			inside: { asked: [`Share \u201csrc\u201d with \u201cRoom inside\u201d? | This folder is also shared in \u201cRelease planning\u201d. ${asksAgain} [Share Anyway / Cancel]`], shared: true },
			containing: { asked: [`Share \u201cwork\u201d with \u201cRoom containing\u201d? | This folder is also shared in \u201cRelease planning\u201d, \u201cRoom inside\u201d. ${asksAgain} [Share Anyway / Cancel]`], shared: true },
			different: { asked: ['Share \u201celsewhere\u201d with \u201cRoom different\u201d? [Share / Don\'t Share]'], shared: true },
		});
	});

	test('sharing: two windows share overlapping folders at the same moment, each asked the plain question; the second is asked again, naming the first, before its share is recorded', async () => {
		const one = await windowClient('owner');
		const two = await sameComputer(one);
		const roomA = await ownersRoom(one, 'Room A');
		const roomB = await ownersRoom(two, 'Room B');
		const app = await folderWith(one, 'together/app');
		const answerA = new DeferredPromise<boolean>();
		const answerB = new DeferredPromise<boolean>();
		one.dialogs.answer = () => answerA.p;
		two.dialogs.answer = asked => asked.primaryButton === 'Share' ? answerB.p : true;
		await one.workspace.updateFolders(0, 0, [{ uri: app }]);
		await two.workspace.updateFolders(0, 0, [{ uri: URI.file(`/layer-b/run-${run}/together`) }]);
		await until(() => one.dialogs.asked.length > 0 && two.dialogs.asked.length > 0, 'both questions');
		answerA.complete(true);
		await until(async () => (await sharedIn(one, roomA)).length > 0, 'Room A\'s share');
		answerB.complete(true);
		await until(async () => (await sharedIn(two, roomB)).length > 0, 'Room B\'s share').catch(() => { });
		assert.deepStrictEqual({ one: one.dialogs.asked.map(question), two: two.dialogs.asked.map(question) }, {
			one: ['Share \u201capp\u201d with \u201cRoom A\u201d? [Share / Don\'t Share]'],
			two: [
				'Share \u201ctogether\u201d with \u201cRoom B\u201d? [Share / Don\'t Share]',
				`Share \u201ctogether\u201d with \u201cRoom B\u201d? | This folder is also shared in \u201cRoom A\u201d. ${asksAgain} [Share Anyway / Cancel]`,
			],
		});
	});

	test('sharing: a room check that gets no answer keeps the other room\'s record, which still counts; once that room is deleted, it no longer does', async () => {
		const one = await windowClient('owner');
		const gone = await ownersRoom(one, 'To be deleted');
		const app = await folderWith(one, 'deleted/app');
		await one.workspace.updateFolders(0, 0, [{ uri: app }]);
		await until(async () => (await sharedIn(one, gone)).length > 0, 'the first room\'s share');
		await toDashboard(one);
		const two = await sameComputer(one);
		await ownersRoom(two, 'Second');
		two.dialogs.answer = () => false;
		// The check of the first room runs out (5 s, no answer).
		two.network.delayOutgoing('room:members:list', 6000);
		await two.workspace.updateFolders(0, 0, [{ uri: app }]);
		await timeout(5600);
		await until(() => two.dialogs.asked.length > 0, 'the question after an unanswered check');
		two.network.delayOutgoing('room:members:list', 0);
		await two.workspace.removeFolders([app]);
		assert.ok(await one.service.deleteRoom(gone), 'the room was not deleted');
		await two.workspace.updateFolders(0, 0, [{ uri: app }]);
		await until(() => two.dialogs.asked.length > 1, 'the question after the deletion');
		assert.deepStrictEqual(two.dialogs.asked.map(question), [
			`Share \u201capp\u201d with \u201cSecond\u201d? | This folder is also shared in \u201cTo be deleted\u201d. ${asksAgain} [Share Anyway / Cancel]`,
			'Share \u201capp\u201d with \u201cSecond\u201d? [Share / Don\'t Share]',
		]);
	});

	test('sharing: a share question still open when its room ends (signed out in another window) doesn\'t hold up the next room\'s question; answered late, it shares nothing', async () => {
		const owner = await windowClient('owner');
		const elsewhere = await sameComputer(owner);
		const first = await ownersRoom(owner, 'Left open');
		const left = await folderWith(owner, 'left-open');
		const late = new DeferredPromise<boolean>();
		owner.dialogs.answer = () => late.p;
		await owner.workspace.updateFolders(0, 0, [{ uri: left }]);
		await until(() => owner.dialogs.asked.length > 0, 'the first room\'s question');
		// Signed out in another window: main ends this window's room (WEBSITE_SIGNIN_DESIGN, sign-out across windows).
		owner.service.signOut();
		await signIn(owner.service, 'owner', accounts.get(owner));
		owner.dialogs.answer = () => true;
		const second = await ownersRoom(owner, 'Next room');
		await owner.workspace.removeFolders([left]);
		const next = await folderWith(owner, 'next-room');
		await owner.workspace.updateFolders(0, 0, [{ uri: next }]);
		await until(async () => (await sharedIn(owner, second)).length > 0, 'the next room\'s share').catch(() => { });
		const beforeTheLateAnswer = { asked: owner.dialogs.asked.map(question), closed: owner.dialogs.closed.map(question), second: await sharedIn(owner, second) };
		late.complete(true);
		await timeout(600);
		assert.deepStrictEqual({ beforeTheLateAnswer, second: await sharedIn(owner, second), first: await sharedFrom(elsewhere, first) }, {
			beforeTheLateAnswer: {
				asked: ['Share “left-open” with “Left open”? [Share / Don\'t Share]', 'Share “next-room” with “Next room”? [Share / Don\'t Share]'],
				closed: ['Share “left-open” with “Left open”? [Share / Don\'t Share]'],
				second: ['a.txt'],
			},
			second: ['a.txt'],
			first: [],
		});
	});

	test('sharing: a share question still open at sign-out closes; another account signed in in the same window then shares its own folder, and the late answer shares nothing into either account\'s room', async () => {
		const owner = await windowClient('owner');
		const ownerElsewhere = await sameComputer(owner);
		const ownersFirst = await ownersRoom(owner, 'Owner asked');
		const folder = await folderWith(owner, 'owner-asked');
		const late = new DeferredPromise<boolean>();
		owner.dialogs.answer = () => late.p;
		await owner.workspace.updateFolders(0, 0, [{ uri: folder }]);
		await until(() => owner.dialogs.asked.length > 0, 'the question');
		owner.service.signOut();
		await signIn(owner.service, 'guest', `another-account-${Date.now()}-${run}`);
		owner.dialogs.answer = () => true;
		const othersRoom = await ownersRoom(owner, 'Another account\'s room');
		await owner.workspace.removeFolders([folder]);
		await owner.workspace.updateFolders(0, 0, [{ uri: await folderWith(owner, 'another-accounts-folder', { 'c.txt': 'c' }) }]);
		await until(async () => (await sharedIn(owner, othersRoom)).length > 0, 'the other account\'s share').catch(() => { });
		late.complete(true);
		await timeout(600);
		assert.deepStrictEqual({ closed: owner.dialogs.closed.map(question), othersRoom: await sharedIn(owner, othersRoom), ownersFirst: await sharedFrom(ownerElsewhere, ownersFirst) }, {
			closed: ['Share “owner-asked” with “Owner asked”? [Share / Don\'t Share]'],
			othersRoom: ['c.txt'],
			ownersFirst: [],
		});
	});

	test('sharing: a share question still open when its room is deleted from another window closes as Don\'t Share; the next room\'s question isn\'t held up, and the late answer shares nothing anywhere', async () => {
		const owner = await windowClient('owner');
		const other = await sameComputer(owner);
		const doomed = await ownersRoom(owner, 'Deleted while asking');
		const folder = await folderWith(owner, 'deleted-while-asking');
		const late = new DeferredPromise<boolean>();
		owner.dialogs.answer = () => late.p;
		await owner.workspace.updateFolders(0, 0, [{ uri: folder }]);
		await until(() => owner.dialogs.asked.length > 0, 'the question');
		assert.ok(await other.service.deleteRoom(doomed), 'the room was not deleted');
		await until(() => owner.dialogs.closed.length > 0, 'the question to close').catch(() => { });
		owner.dialogs.answer = () => true;
		const next = await ownersRoom(owner, 'After the deletion');
		await owner.workspace.removeFolders([folder]);
		await owner.workspace.updateFolders(0, 0, [{ uri: await folderWith(owner, 'after-the-deletion') }]);
		await until(async () => (await sharedIn(owner, next)).length > 0, 'the next room\'s share').catch(() => { });
		late.complete(true);
		await timeout(600);
		assert.deepStrictEqual({ closed: owner.dialogs.closed.map(question), asked: owner.dialogs.asked.map(question), next: await sharedIn(owner, next) }, {
			closed: ['Share “deleted-while-asking” with “Deleted while asking”? [Share / Don\'t Share]'],
			asked: ['Share “deleted-while-asking” with “Deleted while asking”? [Share / Don\'t Share]', 'Share “after-the-deletion” with “After the deletion”? [Share / Don\'t Share]'],
			next: ['a.txt'],
		});
	});

	test('sharing: several folders added at once (a drop, Add Folders to Workspace): one is shared after its question, and each of the others is asked about or named as not shared, never left open unshared without a word', async () => {
		const owner = await windowClient('owner');
		const roomId = await ownersRoom(owner, 'Dropped on');
		const first = await folderWith(owner, 'dropped-first');
		const second = await folderWith(owner, 'dropped-second', { 'b.txt': 'b' });
		const noticesBefore = owner.notices.length;
		await owner.workspace.updateFolders(0, 0, [{ uri: first }, { uri: second }]);
		await until(async () => (await sharedIn(owner, roomId)).length > 0, 'the first folder\'s share').catch(() => { });
		await timeout(600);
		const toldOf = (name: string) => owner.dialogs.asked.some(asked => asked.message.includes(name)) || owner.notices.slice(noticesBefore).some(notice => notice.message.includes(name));
		assert.deepStrictEqual({ open: owner.workspace.getWorkspace().folders.length, room: await sharedIn(owner, roomId), toldOfFirst: toldOf('dropped-first'), toldOfSecond: toldOf('dropped-second') }, {
			open: 2,
			room: ['a.txt'],
			toldOfFirst: true,
			toldOfSecond: true,
		});
	});

	test('sharing: the Explorer\'s Copy Folders choice is told when its target is the room\'s shared folder (or inside it), and only then: not for a folder open but not shared, not after leaving', async () => {
		const owner = await windowClient('owner');
		const roomId = await ownersRoom(owner, 'Copied into');
		const shared = await folderWith(owner, 'copy-target', { 'a.txt': 'a', 'src/b.txt': 'b' });
		const local = await folderWith(owner, 'copy-local');
		await owner.workspace.updateFolders(0, 0, [{ uri: shared }, { uri: local }]);
		await until(async () => (await sharedIn(owner, roomId)).length > 0, 'the share');
		const told = () => ({ root: owner.roomSharing.sharedLocationOf(shared), inside: owner.roomSharing.sharedLocationOf(URI.joinPath(shared, 'src')), local: owner.roomSharing.sharedLocationOf(local) });
		const inRoom = told();
		owner.service.returnToDashboard('test');
		await until(() => !owner.service.roomId, 'the room session to end');
		assert.deepStrictEqual({ inRoom, afterLeaving: told() }, {
			inRoom: { root: { folderName: 'copy-target', roomName: 'Copied into' }, inside: { folderName: 'copy-target', roomName: 'Copied into' }, local: undefined },
			afterLeaving: { root: undefined, inside: undefined, local: undefined },
		});
	});

	test('sharing: going back to the dashboard names, on the dashboard, each folder that was open beside the room\'s and closed with it, logged; no notice is left for the next room; their files stay', async () => {
		const owner = await windowClient('owner');
		// A desktop window: deleting its workspace file on the leave closes every folder in it.
		owner.workspace.useUntitledWorkspaceFile();
		const roomId = await ownersRoom(owner, 'Left with another open');
		const shared = await folderWith(owner, 'leave-shared', { 'a.txt': 'a' });
		const local = await folderWith(owner, 'leave-local', { 'b.txt': 'b' });
		await owner.workspace.updateFolders(0, 0, [{ uri: shared }, { uri: local }]);
		await until(async () => (await sharedIn(owner, roomId)).length > 0, 'the share');
		const noticesBefore = owner.notices.length;
		await toDashboard(owner);
		await timeout(300);
		assert.deepStrictEqual({
			dashboard: owner.toMain.filter(message => message.channel === 'vscode:livecollab-dashboard-notice').map(message => { const { roomId, notice } = message.payload as { roomId: string; notice: string }; return { roomId, notice }; }),
			inWindow: owner.notices.slice(noticesBefore).map(notice => notice.message),
			logged: owner.logged.filter(line => line.includes('leaving room') || line.includes('closure notice')),
			localFile: (await owner.fileService.readFile(URI.joinPath(local, 'b.txt'))).value.toString(),
		}, {
			dashboard: [{ roomId, notice: '\u201cleave-local\u201d was closed in this window when you left \u201cLeft with another open\u201d. Closing it didn\'t change or delete its files.' }],
			inWindow: [],
			logged: [`[LiveCollab] leaving room ${roomId} closed 1 other folder(s) with it: ${local.toString()}`, `[LiveCollab] closure notice for ${roomId}: sent to main for the dashboard`, `[LiveCollab] closure notice for ${roomId}: shown on the dashboard`],
			localFile: 'b',
		});
	});

	/** A leave's closure notices in `window`: what went to the dashboard, what showed in the window and what was logged, from `since` on. */
	function closureNotices(window: IBClient, since: { notices: number; toMain: number; logged: number }) {
		return {
			toDashboard: window.toMain.slice(since.toMain).filter(message => message.channel === 'vscode:livecollab-dashboard-notice').map(message => (message.payload as { notice: string }).notice),
			inWindow: window.notices.slice(since.notices).map(notice => notice.message).filter(message => message.includes('was closed in this window')),
			logged: window.logged.slice(since.logged).filter(line => line.includes('closure notice')).map(line => line.replace(/room-[a-f0-9-]+/g, '<room>')),
		};
	}
	const mark = (window: IBClient) => ({ notices: window.notices.length, toMain: window.toMain.length, logged: window.logged.length });

	test('sharing: when main can\'t show the closure notice on the dashboard (no longer in front), it shows once in this window instead, and the log says so', async () => {
		const owner = await windowClient('owner');
		owner.workspace.useUntitledWorkspaceFile();
		const roomId = await ownersRoom(owner, 'Not in front');
		const shared = await folderWith(owner, 'front-shared');
		const local = await folderWith(owner, 'front-local');
		await owner.workspace.updateFolders(0, 0, [{ uri: shared }, { uri: local }]);
		await until(async () => (await sharedIn(owner, roomId)).length > 0, 'the share');
		const since = mark(owner);
		// Another room opened from the dashboard before main gets the notice.
		owner.main.dashboardInFront = false;
		await toDashboard(owner);
		await timeout(300);
		const notice = '\u201cfront-local\u201d was closed in this window when you left \u201cNot in front\u201d. Closing it didn\'t change or delete its files.';
		assert.deepStrictEqual(closureNotices(owner, since), {
			toDashboard: [notice],
			inWindow: [notice],
			logged: ['[LiveCollab] closure notice for <room>: sent to main for the dashboard', '[LiveCollab] closure notice for <room>: not shown on the dashboard (not in front), shown in this window'],
		});
	});

	/** Back to the dashboard with a folder of its own open beside the room's, main slowed as `slow` says; what happened to the closure notice 3.5 seconds on. */
	async function closureWithSlowMain(name: string, slow: { handleDelay?: number; answerDelay?: number }) {
		const owner = await windowClient('owner');
		owner.workspace.useUntitledWorkspaceFile();
		const roomId = await ownersRoom(owner, name);
		const shared = await folderWith(owner, `${name}-shared`);
		const local = await folderWith(owner, `${name}-local`);
		await owner.workspace.updateFolders(0, 0, [{ uri: shared }, { uri: local }]);
		await until(async () => (await sharedIn(owner, roomId)).length > 0, 'the share');
		const since = mark(owner);
		Object.assign(owner.main, slow);
		await toDashboard(owner);
		await timeout(3500);
		const { inWindow, logged } = closureNotices(owner, since);
		return {
			onDashboard: owner.main.shown,
			inWindow,
			logged,
			// What the window asked main to show: only the dashboard of its own return, nothing else.
			navigations: owner.toMain.slice(since.toMain).map(message => message.channel).filter(channel => channel !== 'vscode:livecollab-dashboard-notice'),
		};
	}

	test('sharing: main handles the closure notice more than 2 seconds after it was sent and shows it: it is shown once, on the dashboard, and not in the window', async () => {
		const notice = '\u201cslow-handle-local\u201d was closed in this window when you left \u201cslow-handle\u201d. Closing it didn\'t change or delete its files.';
		assert.deepStrictEqual(await closureWithSlowMain('slow-handle', { handleDelay: 2500 }), {
			onDashboard: [notice],
			inWindow: [],
			logged: [
				'[LiveCollab] closure notice for <room>: sent to main for the dashboard',
				'[LiveCollab] closure notice for <room>: no answer from main in 2 seconds; delivery unknown, still waiting for main\'s answer, not shown in this window',
				'[LiveCollab] closure notice for <room>: shown on the dashboard',
			],
			navigations: ['vscode:livecollab-load-dashboard'],
		});
	});

	test('sharing: main shows the closure notice on the dashboard at once but its answer reaches the window more than 2 seconds later: it is shown once, on the dashboard, and not in the window', async () => {
		const notice = '\u201cslow-answer-local\u201d was closed in this window when you left \u201cslow-answer\u201d. Closing it didn\'t change or delete its files.';
		assert.deepStrictEqual(await closureWithSlowMain('slow-answer', { answerDelay: 2500 }), {
			onDashboard: [notice],
			inWindow: [],
			logged: [
				'[LiveCollab] closure notice for <room>: sent to main for the dashboard',
				'[LiveCollab] closure notice for <room>: no answer from main in 2 seconds; delivery unknown, still waiting for main\'s answer, not shown in this window',
				'[LiveCollab] closure notice for <room>: shown on the dashboard',
			],
			navigations: ['vscode:livecollab-load-dashboard'],
		});
	});

	test('sharing: the room deleted from another window with an unshared folder open beside the room\'s: the closure is named once, in this window (the dashboard keeps the deletion\'s notice), and nothing carries into the next room', async () => {
		const owner = await windowClient('owner');
		owner.workspace.useUntitledWorkspaceFile();
		const other = await sameComputer(owner);
		const roomId = await ownersRoom(owner, 'Deleted with another open');
		const shared = await folderWith(owner, 'gone-shared');
		const local = await folderWith(owner, 'gone-local');
		await owner.workspace.updateFolders(0, 0, [{ uri: shared }, { uri: local }]);
		await until(async () => (await sharedIn(owner, roomId)).length > 0, 'the share');
		const since = mark(owner);
		const ended = next(owner.service.onRoomTerminated, 'the room to end');
		assert.ok(await other.service.deleteRoom(roomId), 'the room was not deleted');
		const { reason } = await ended;
		await until(() => owner.workspace.getWorkspace().folders.length === 0, 'the folders to close');
		await timeout(300);
		const nextRoom = await ownersRoom(owner, 'After deleted');
		await timeout(300);
		assert.deepStrictEqual({ reason, ...closureNotices(owner, since), inNextRoom: owner.notices.filter(notice => !notice.closed && /^Only one folder|was closed in this window/.test(notice.message)).map(notice => notice.message), nextRoom: !!nextRoom }, {
			reason: 'ended',
			toDashboard: [],
			inWindow: ['\u201cgone-local\u201d was closed in this window when you left \u201cDeleted with another open\u201d. Closing it didn\'t change or delete its files.'],
			logged: ['[LiveCollab] closure notice for <room>: the room ended with its own notice on the dashboard, shown in this window'],
			inNextRoom: ['\u201cgone-local\u201d was closed in this window when you left \u201cDeleted with another open\u201d. Closing it didn\'t change or delete its files.'],
			nextRoom: true,
		});
	});

	test('sharing: a member removed with a folder of their own open beside the room\'s: the closure is named once, in their window (the dashboard keeps the removal\'s notice)', async () => {
		const { owner, guest } = await ownerSharesGuestJoins({ 'a.txt': 'a' }, window => window.workspace.useUntitledWorkspaceFile());
		const local = await folderWith(guest, 'guest-local');
		await guest.workspace.updateFolders(guest.workspace.getWorkspace().folders.length, 0, [{ uri: local }]);
		await timeout(300);
		const since = mark(guest);
		const ended = next(guest.service.onRoomTerminated, 'the guest\'s room to end');
		await owner.service.kickMember(guest.service.myUserId);
		const { reason } = await ended;
		await until(() => guest.workspace.getWorkspace().folders.length === 0, 'the guest\'s folders to close');
		await timeout(300);
		assert.deepStrictEqual({ reason, ...closureNotices(guest, since) }, {
			reason: 'kicked',
			toDashboard: [],
			inWindow: ['\u201cguest-local\u201d was closed in this window when you left \u201clayer-b\u201d. Closing it didn\'t change or delete its files.'],
			logged: ['[LiveCollab] closure notice for <room>: the room ended with its own notice on the dashboard, shown in this window'],
		});
	});

	test('sharing: a room\'s LiveCollab notices close when its room session ends, so "Only one folder can be shared…" doesn\'t carry into the next room', async () => {
		const owner = await windowClient('owner');
		const roomId = await ownersRoom(owner, 'Notices end');
		const shared = await folderWith(owner, 'notices-shared', { 'a.txt': 'a' });
		const local = await folderWith(owner, 'notices-local');
		await owner.workspace.updateFolders(0, 0, [{ uri: shared }, { uri: local }]);
		await until(async () => (await sharedIn(owner, roomId)).length > 0, 'the share');
		await until(() => owner.notices.some(notice => notice.message.startsWith('Only one folder')), 'the one-folder notice');
		const oneFolder = () => owner.notices.filter(notice => notice.message.startsWith('Only one folder')).map(notice => ({ message: notice.message, closed: notice.closed }));
		const inRoom = oneFolder();
		owner.service.returnToDashboard('test');
		await until(() => !owner.service.roomId, 'the room session to end');
		assert.deepStrictEqual({ inRoom, afterLeaving: oneFolder() }, {
			inRoom: [{ message: 'Only one folder can be shared in a room. \u201cnotices-local\u201d is open on this computer only.', closed: false }],
			afterLeaving: [{ message: 'Only one folder can be shared in a room. \u201cnotices-local\u201d is open on this computer only.', closed: true }],
		});
	});

	test('sharing: a folder recorded before 0.3.6 (no room name kept) is named by the room\'s name from the server; with no answer, by the folder it shares, never blank or an ID', async () => {
		const one = await windowClient('owner');
		const old = await ownersRoom(one, 'Shared in 0.3.5');
		const app = await folderWith(one, 'legacy/app', { 'a.txt': 'a', 'src/main.ts': 'm' });
		await one.workspace.updateFolders(0, 0, [{ uri: app }]);
		await until(async () => (await sharedIn(one, old)).length > 0, 'the first share');
		await toDashboard(one);
		// As 0.3.5 left it: the window's own record of the room's folder, and nothing in the computer's.
		await one.kept.folderClaims.release(old);
		one.dialogs.answer = () => false;
		const before = one.dialogs.asked.length;
		await ownersRoom(one, 'Named');
		await one.workspace.updateFolders(0, 0, [{ uri: URI.joinPath(app, 'src') }]);
		await until(() => one.dialogs.asked.length > before, 'the question, server answering');
		await one.workspace.removeFolders([URI.joinPath(app, 'src')]);
		await toDashboard(one).catch(() => { });
		await one.kept.folderClaims.release(old);
		await ownersRoom(one, 'Unanswered');
		one.network.delayOutgoing('rooms:list', 6000);
		await one.workspace.updateFolders(0, 0, [{ uri: URI.joinPath(app, 'src') }]);
		await timeout(5600);
		await until(() => one.dialogs.asked.length > before + 1, 'the question, server not answering');
		one.network.delayOutgoing('rooms:list', 0);
		assert.deepStrictEqual(one.dialogs.asked.slice(before).map(question), [
			`Share “src” with “Named”? | This folder is also shared in “Shared in 0.3.5”. ${asksAgain} [Share Anyway / Cancel]`,
			`Share “src” with “Unanswered”? | This folder is also shared in another of your rooms (the one sharing “${app.fsPath}”). ${asksAgain} [Share Anyway / Cancel]`,
		]);
	});

	test('sharing: entering a room whose folder overlaps another room\'s warns once, naming the other room; a reconnect doesn\'t warn again; a room with no overlap never warns', async () => {
		const one = await windowClient('owner');
		const release = await ownersRoom(one, 'Release planning');
		const app = await folderWith(one, 'warned/app', { 'a.txt': 'a', 'src/main.ts': 'm' });
		await one.workspace.updateFolders(0, 0, [{ uri: app }]);
		await until(async () => (await sharedIn(one, release)).length > 0, 'Release planning\'s share');
		await toDashboard(one);
		const two = await sameComputer(one);
		const inside = await ownersRoom(two, 'Inside');
		await two.workspace.updateFolders(0, 0, [{ uri: URI.joinPath(app, 'src') }]);
		await until(async () => (await sharedIn(two, inside)).length > 0, 'Inside\'s share, anyway');
		const plain = await ownersRoom(one, 'Plain');
		const elsewhere = await folderWith(one, 'warned-elsewhere');
		await one.workspace.updateFolders(0, 0, [{ uri: elsewhere }]);
		await until(async () => (await sharedIn(one, plain)).length > 0, 'Plain\'s share');
		const warnings = (window: IBClient) => window.notices.filter(notice => notice.message.includes('is also shared in')).map(notice => notice.message);
		const told = { atShareAnyway: warnings(two).length };
		await toDashboard(two);
		await two.service.joinExistingRoom(inside, 'Inside');
		await until(() => warnings(two).length > 0, 'the warning on entering Inside').catch(() => { });
		const attaches = () => logLines.filter(line => line.includes('folder attached:')).length;
		const before = attaches();
		await two.network.drop();
		await two.network.restore();
		await until(() => attaches() > before, 'the reconnect\'s attach');
		await timeout(300);
		await toDashboard(one);
		await one.service.joinExistingRoom(plain, 'Plain');
		await timeout(600);
		await toDashboard(one);
		await one.service.joinExistingRoom(release, 'Release planning');
		await until(() => warnings(one).length > 0, 'the warning on entering Release planning').catch(() => { });
		assert.deepStrictEqual({ ...told, inside: warnings(two), release: warnings(one) }, {
			atShareAnyway: 0,
			inside: ['\u201csrc\u201d is also shared in \u201cRelease planning\u201d. Edits and deletions in either room change the same files on this computer: they reach the other room automatically while both are open, and through Use Disk Version when you switch rooms. This warning doesn\'t stop that. To keep the work separate, share a separate copy instead.'],
			release: ['\u201capp\u201d is also shared in \u201cInside\u201d. Edits and deletions in either room change the same files on this computer: they reach the other room automatically while both are open, and through Use Disk Version when you switch rooms. This warning doesn\'t stop that. To keep the work separate, share a separate copy instead.'],
		});
	});

	/**
	 * Opens `resource` in `client`'s window and waits until the editor contribution has bound it to
	 * the room's document: its own log line, "binding created". Typing before that is overwritten
	 * when the binding lands (recorded as a lead, TEST_HARNESS_TRIAGE.md).
	 */
	async function openBound(client: IBClient, resource: URI): Promise<IBEditor> {
		const bindings = () => logLines.filter(line => line.includes('binding created for fileId')).length;
		const before = bindings();
		const editor = await client.openEditor(resource);
		await until(() => bindings() > before, `${resource.toString()} to be bound`);
		return editor;
	}

	/** Waits until `editor` shows `text`, or the step runs out (the caller's assertion then shows what it has). */
	async function shows(editor: IBEditor, text: string): Promise<void> {
		await until(() => editor.text().includes(text), `an editor to show ${JSON.stringify(text)}`).catch(() => { });
	}

	test('editors: typing in a shared file reaches the other side, both ways', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha' });
		const ownerEditor = await openBound(owner, URI.joinPath(folder, 'a.txt'));
		const guestEditor = await openBound(guest, URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/a.txt' }));
		guestEditor.type(' guest');
		await shows(ownerEditor, ' guest');
		ownerEditor.type(' owner');
		await shows(guestEditor, ' owner');
		const disk = async () => (await owner.fileService.readFile(URI.joinPath(folder, 'a.txt'))).value.toString();
		await until(async () => await disk() === 'alpha guest owner', 'the owner\'s disk to have the text').catch(() => { });
		assert.deepStrictEqual({ owner: ownerEditor.text(), guest: guestEditor.text(), ownerDisk: await disk() }, { owner: 'alpha guest owner', guest: 'alpha guest owner', ownerDisk: 'alpha guest owner' });
	});

	/**
	 * The first harness test (TEST_HARNESS_TRIAGE.md, "Sequence"), session finding 1: the person who
	 * renames has the file open, renames it, then types, and sync stopped both ways. Two timings:
	 * typing after the room has confirmed the rename (the session's case), and typing straight away,
	 * before the confirmation, which must survive whatever the binding does when it arrives.
	 */
	for (const renamer of ['guest', 'owner'] as const) {
		for (const when of ['after', 'before'] as const) {
			test(`editors: the ${renamer} renames an open file and types ${when} the room confirms it; both sides keep all the typing`, async () => {
				const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha' });
				const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
				const ownerEditor = await openBound(owner, URI.joinPath(folder, 'a.txt'));
				const guestEditor = await openBound(guest, URI.joinPath(guestRoot, 'a.txt'));
				const [mine, theirs, root, me, other, otherTarget] = renamer === 'guest'
					? [guestEditor, ownerEditor, guestRoot, guest, owner, URI.joinPath(folder, 'renamed.txt')]
					: [ownerEditor, guestEditor, folder, owner, guest, URI.joinPath(guestRoot, 'renamed.txt')];
				const target = URI.joinPath(root, 'renamed.txt');
				if (when === 'before') {
					// A slow link to the renamer: the room's confirmation takes a moment to arrive, as
					// over a real network. Against a local server it otherwise arrives within one event.
					me.network.delayIncoming(300);
				}
				await me.workingCopyFileService.move([{ file: { source: URI.joinPath(root, 'a.txt'), target } }], CancellationToken.None);
				const count = (text: string) => logLines.filter(line => line.includes(text)).length;
				const confirmationsAtRename = count('room:file:renamed');
				mine.follow(target);
				if (when === 'before') {
					// The next keystroke: a separate event, as typing always is (nothing types in the
					// same task as the workbench moving the editor). The room mustn't have confirmed
					// the rename to the renamer yet, or this case isn't being exercised.
					await timeout(0);
					// Both clients log each 'room:file:renamed' they're sent; the other side's comes at once,
					// so the renamer has heard the room only when the count has gone up by two.
					assert.strictEqual(count('room:file:renamed') >= confirmationsAtRename + 2, false, 'the room confirmed the rename to the renamer before the typing: this case isn\'t exercised');
					mine.type(' after');
					me.network.delayIncoming(0);
					// Then the confirmation lands on the renamer, and whatever it does to the binding
					// happens, before anything below is checked.
					await until(() => count('room:file:renamed') >= confirmationsAtRename + 2, 'the room\'s confirmation to reach the renamer');
					await timeout(50);
				}
				// The rename's round trip through the room: the other side has the file under its new name.
				await until(() => other.fileService.exists(otherTarget), 'the rename to reach the other side');
				if (when === 'after') {
					mine.type(' after');
				}
				await shows(theirs, ' after');
				theirs.type(' reply');
				await shows(mine, ' reply');
				assert.deepStrictEqual({ renamer: mine.text(), other: theirs.text() }, { renamer: 'alpha after reply', other: 'alpha after reply' });
			});
		}
	}

	/**
	 * Open-then-type (tier one for 0.3.5): typing into a file before its first binding, which then
	 * replaces the editor's text with the room's (y-monaco's binding does on creation). The owner has
	 * the file open from disk and types, either before sharing the folder at all, or after sharing
	 * while the room's snapshot is still on its way ("deferring bind until snapshot", the session's
	 * signature). Both sides must end up with the typing.
	 */
	for (const when of ['before sharing', 'before the snapshot seeds it'] as const) {
		test(`editors: the owner types in an open file ${when}; the typing survives the binding on both sides`, () => ownerTypesBeforeBinding());

		async function ownerTypesBeforeBinding(): Promise<void> {
			const owner = await windowClient('owner');
			const roomId = await owner.service.createRoomNamed('layer-b');
			assert.ok(roomId, 'the server created no room');
			await owner.service.joinExistingRoom(roomId);
			const folder = URI.file(`/layer-b/run-${run}/project`);
			const file = URI.joinPath(folder, 'a.txt');
			await owner.fileService.writeFile(file, VSBuffer.fromString('alpha'));
			const editor = await owner.openEditor(file);
			const count = (text: string) => logLines.filter(line => line.includes(text)).length;
			if (when === 'before sharing') {
				editor.type(' typed');
				await owner.workspace.updateFolders(0, 0, [{ uri: folder }]);
			} else {
				// A slow link to the owner: the snapshot takes a moment to arrive after the attach.
				owner.network.delayIncoming(300);
				await owner.workspace.updateFolders(0, 0, [{ uri: folder }]);
				await until(() => count('deferring bind until snapshot') > 0, 'the owner\'s editor to wait for the snapshot');
				assert.strictEqual(count('binding created for fileId'), 0, 'the owner\'s editor bound before the typing: this case isn\'t exercised');
				editor.type(' typed');
				owner.network.delayIncoming(0);
				await until(() => count('snapshot received:') > 0, 'the snapshot to reach the owner');
			}
			await until(() => count('binding created for fileId') > 0, 'the owner\'s editor to be bound');
			await timeout(50);
			await until(async () => (await owner.service.getRoomFolder())?.hasFolder === true, 'the owner\'s folder to be shared');
			const invite = await owner.service.createInviteCode();
			const guest = await windowClient('guest');
			const joined = await guest.service.joinByCode(invite.code ?? '');
			assert.ok(joined.ok, `the guest could not join: ${joined.error}`);
			await guest.service.joinExistingRoom(roomId);
			await until(() => guest.workspace.getWorkspace().folders.some(f => f.uri.scheme === LIVECOLLAB_SCHEME), 'the guest\'s room folder');
			const guestEditor = await openBound(guest, URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/a.txt' }));
			assert.deepStrictEqual({ owner: editor.text(), guest: guestEditor.text() }, { owner: 'alpha typed', guest: 'alpha typed' });
		}
	}

	/**
	 * The dirty editor (TEST_HARNESS_TRIAGE.md): the owner types in a file and doesn't save, before
	 * joining any room, then joins and opens the folder. The room is seeded from what the editor
	 * shows, not the disk, so the binding (which replaces the editor's text with the room's) loses
	 * nothing, and the guest sees the unsaved text. Nothing saves the file before the seeding.
	 */
	test('editors: the owner has unsaved typing before joining, then opens the folder; the room is seeded from the editor, not the disk', async () => {
		const owner = await windowClient('owner');
		const folder = URI.file(`/layer-b/run-${run}/project`);
		const file = URI.joinPath(folder, 'a.txt');
		await owner.fileService.writeFile(file, VSBuffer.fromString('alpha'));
		const editor = await owner.openFileEditor(file);
		editor.type(' unsaved');
		const roomId = await owner.service.createRoomNamed('layer-b');
		assert.ok(roomId, 'the server created no room');
		await owner.service.joinExistingRoom(roomId);
		const count = (text: string) => logLines.filter(line => line.includes(text)).length;
		const diskAtAttach = new Promise<string>(resolve => {
			const listener = testStore!.add(owner.service.onSnapshot(async () => { listener.dispose(); resolve((await owner.fileService.readFile(file)).value.toString()); }));
		});
		await owner.workspace.updateFolders(0, 0, [{ uri: folder }]);
		await until(async () => (await owner.service.getRoomFolder())?.hasFolder === true, 'the owner\'s folder to be shared');
		await until(() => count('binding created for fileId') > 0, 'the owner\'s editor to be bound');
		const invite = await owner.service.createInviteCode();
		const guest = await windowClient('guest');
		const joined = await guest.service.joinByCode(invite.code ?? '');
		assert.ok(joined.ok, `the guest could not join: ${joined.error}`);
		await guest.service.joinExistingRoom(roomId);
		await until(() => guest.workspace.getWorkspace().folders.some(f => f.uri.scheme === LIVECOLLAB_SCHEME), 'the guest\'s room folder');
		const guestEditor = await openBound(guest, URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/a.txt' }));
		assert.deepStrictEqual({ owner: editor.text(), guest: guestEditor.text(), diskWhenSeeded: await diskAtAttach }, { owner: 'alpha unsaved', guest: 'alpha unsaved', diskWhenSeeded: 'alpha' });
	});

	/**
	 * The Sunday 2026-10-25 reconnect sync death, as the never-bind trigger describes it: a file open
	 * on both sides, the owner's connection drops and comes back (the app re-joins and re-attaches),
	 * with the room's snapshot slower than the doc load. Then both type. Both editors and the
	 * owner's disk must end up with all of it.
	 */
	test('editors: the owner reconnects with the snapshot slow, with a file open on both sides; typing after it syncs both ways', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha' });
		const ownerEditor = await openBound(owner, URI.joinPath(folder, 'a.txt'));
		const guestEditor = await openBound(guest, URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/a.txt' }));
		const count = (text: string) => logLines.filter(line => line.includes(text)).length;
		await owner.network.drop();
		const [rejoins, answers] = [count('re-join ack'), count('folder attached:') + count('room:attach FAILED')];
		owner.network.delayIncoming(300);
		await owner.network.restore();
		// The re-join and the re-attach both answered, then the held messages, the re-join's snapshot
		// among them, delivered. The attach must be accepted.
		await until(() => count('re-join ack') > rejoins && count('folder attached:') + count('room:attach FAILED') > answers, 'the owner\'s re-join and re-attach to be answered');
		assert.strictEqual(count('room:attach FAILED'), 0, 'the owner\'s re-attach was refused');
		await timeout(400);
		owner.network.delayIncoming(0);
		await timeout(100);
		ownerEditor.type(' owner');
		await shows(guestEditor, ' owner');
		guestEditor.type(' guest');
		await shows(ownerEditor, ' guest');
		const disk = async () => (await owner.fileService.readFile(URI.joinPath(folder, 'a.txt'))).value.toString();
		await until(async () => await disk() === 'alpha owner guest', 'the owner\'s disk to have the text').catch(() => { });
		assert.deepStrictEqual({ owner: ownerEditor.text(), guest: guestEditor.text(), ownerDisk: await disk() }, { owner: 'alpha owner guest', guest: 'alpha owner guest', ownerDisk: 'alpha owner guest' });
	});

	/**
	 * Cursors (CHAT_DESIGN.md, "Cursor identity"): a cursor names its file by the room's id for it,
	 * and only a file in the room has one. Cursor messages get no reply, so a test that expects
	 * nothing to arrive sends something that must arrive afterwards, on the same socket, and waits
	 * for that.
	 */
	test('cursors: same-named files in different folders stay apart; the cursor shows only in the file it is in', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'src/index.ts': 'one\ntwo', 'test/index.ts': 'one\ntwo' });
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		const guestSrc = await openBound(guest, URI.joinPath(guestRoot, 'src', 'index.ts'));
		const guestTest = await openBound(guest, URI.joinPath(guestRoot, 'test', 'index.ts'));
		const ownerSrc = await openBound(owner, URI.joinPath(folder, 'src', 'index.ts'));
		ownerSrc.editor.setPosition({ lineNumber: 2, column: 3 });
		await until(() => guestSrc.remoteCursors().includes('2:3'), 'the owner\'s cursor in the guest\'s src/index.ts').catch(() => { });
		assert.deepStrictEqual({ src: guestSrc.remoteCursors(), test: guestTest.remoteCursors() }, { src: ['2:3'], test: [] });
	});

	test('cursors: an untitled file, the settings and a file outside the room\'s folder send nothing', async () => {
		const { owner, guest, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha' });
		const received: string[] = [];
		testStore!.add(guest.service.onCursorUpdate(update => received.push(update.fileId)));
		await owner.fileService.writeFile(URI.file('/elsewhere/a.txt'), VSBuffer.fromString('outside'));
		const outside = await owner.openEditor(URI.file('/elsewhere/a.txt'));
		const untitled = owner.openText(URI.from({ scheme: Schemas.untitled, path: 'Untitled-1' }), 'draft');
		const settings = owner.openText(URI.from({ scheme: Schemas.vscodeUserData, path: '/User/settings.json' }), '{}');
		for (const editor of [outside, untitled, settings]) {
			editor.editor.setPosition({ lineNumber: 1, column: 2 });
		}
		// What must arrive after them: a cursor in a room file.
		const roomFile = await openBound(owner, URI.joinPath(folder, 'a.txt'));
		roomFile.editor.setPosition({ lineNumber: 1, column: 3 });
		const id = owner.fileSystem.getServerFileId('a.txt');
		await until(() => received.includes(id!), 'the room file\'s cursor to reach the guest').catch(() => { });
		assert.deepStrictEqual([...new Set(received)], [id]);
	});

	test('cursors: a cursor naming its file by name, not id (what 0.3.5 sends), is ignored', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha' });
		const guestEditor = await openBound(guest, URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/a.txt' }));
		// The old client's message, as the guest receives it: the file's name where the id goes.
		guest.network.rewriteIncoming('cursor:update', update => {
			const sent = update as { position: { column: number } };
			return [sent.position.column === 2 ? { ...sent, fileId: 'a.txt' } : sent];
		});
		const old = await joinsByInvite(owner, roomId, 'old');
		await until(() => old.workspace.getWorkspace().folders.some(f => f.uri.scheme === LIVECOLLAB_SCHEME), 'the old client\'s room folder');
		const oldEditor = await openBound(old, URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/a.txt' }));
		oldEditor.editor.setPosition({ lineNumber: 1, column: 2 });
		// What must arrive after it: the owner's cursor, by the file's id.
		const ownerEditor = await openBound(owner, URI.joinPath(folder, 'a.txt'));
		ownerEditor.editor.setPosition({ lineNumber: 1, column: 4 });
		await until(() => guestEditor.remoteCursors().includes('1:4'), 'the owner\'s cursor in the guest\'s a.txt').catch(() => { });
		assert.deepStrictEqual(guestEditor.remoteCursors(), ['1:4']);
	});

	test('cursors: after a rename, each side\'s cursor still shows in the renamed file (the id stays)', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha\nbeta' });
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		const ownerEditor = await openBound(owner, URI.joinPath(folder, 'a.txt'));
		const guestEditor = await openBound(guest, URI.joinPath(guestRoot, 'a.txt'));
		await guest.workingCopyFileService.move([{ file: { source: URI.joinPath(guestRoot, 'a.txt'), target: URI.joinPath(guestRoot, 'renamed.txt') } }], CancellationToken.None);
		guestEditor.follow(URI.joinPath(guestRoot, 'renamed.txt'));
		await until(() => owner.fileSystem.getItemPathForRealPath(URI.joinPath(folder, 'renamed.txt').fsPath) === 'renamed.txt', 'the rename to reach the owner');
		ownerEditor.follow(URI.joinPath(folder, 'renamed.txt'));
		ownerEditor.editor.setPosition({ lineNumber: 2, column: 3 });
		guestEditor.editor.setPosition({ lineNumber: 1, column: 2 });
		await until(() => guestEditor.remoteCursors().includes('2:3') && ownerEditor.remoteCursors().includes('1:2'), 'each cursor on the other side').catch(() => { });
		assert.deepStrictEqual({ guestSees: guestEditor.remoteCursors(), ownerSees: ownerEditor.remoteCursors() }, { guestSees: ['2:3'], ownerSees: ['1:2'] });
	});

	test('cursors: switching the editor to another file moves the cursor there; closing it takes the cursor away', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha', 'b.txt': 'beta' });
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		const guestA = await openBound(guest, URI.joinPath(guestRoot, 'a.txt'));
		const guestB = await openBound(guest, URI.joinPath(guestRoot, 'b.txt'));
		const shown = () => ({ a: guestA.remoteCursors(), b: guestB.remoteCursors() });
		const ownerEditor = await openBound(owner, URI.joinPath(folder, 'a.txt'));
		ownerEditor.editor.setPosition({ lineNumber: 1, column: 3 });
		await until(() => guestA.remoteCursors().includes('1:3'), 'the owner\'s cursor in a.txt').catch(() => { });
		const inA = shown();
		ownerEditor.switchTo(URI.joinPath(folder, 'b.txt'), 'beta');
		await until(() => guestB.remoteCursors().length > 0, 'the owner\'s cursor in b.txt').catch(() => { });
		const switched = shown();
		ownerEditor.close();
		await until(() => guestB.remoteCursors().length === 0, 'the owner\'s cursor to go').catch(() => { });
		assert.deepStrictEqual({ inA, switched, closed: shown() }, { inA: { a: ['1:3'], b: [] }, switched: { a: [], b: ['1:1'] }, closed: { a: [], b: [] } });
	});

	test('cursors: reconnecting brings a member\'s cursor back; one who was away keeps no cursor that left meanwhile', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha' });
		const guestEditor = await openBound(guest, URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/a.txt' }));
		const ownerEditor = await openBound(owner, URI.joinPath(folder, 'a.txt'));
		ownerEditor.editor.setPosition({ lineNumber: 1, column: 3 });
		await until(() => guestEditor.remoteCursors().includes('1:3'), 'the owner\'s cursor').catch(() => { });
		const before = guestEditor.remoteCursors();
		await owner.network.drop();
		await until(() => guestEditor.remoteCursors().length === 0, 'the owner\'s cursor to go').catch(() => { });
		const ownerAway = guestEditor.remoteCursors();
		await restoreAndReattach(owner);
		await until(() => guestEditor.remoteCursors().includes('1:3'), 'the owner\'s cursor to come back').catch(() => { });
		const ownerBack = guestEditor.remoteCursors();
		await guest.network.drop();
		ownerEditor.close();
		await guest.network.restore();
		// What must arrive after the restore: someone else's cursor in the guest's file.
		const other = await joinsByInvite(owner, roomId, 'other');
		await until(() => other.workspace.getWorkspace().folders.some(f => f.uri.scheme === LIVECOLLAB_SCHEME), 'the other member\'s room folder');
		const otherEditor = await openBound(other, URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/a.txt' }));
		otherEditor.editor.setPosition({ lineNumber: 1, column: 5 });
		await until(() => guestEditor.remoteCursors().includes('1:5'), 'the other member\'s cursor').catch(() => { });
		assert.deepStrictEqual({ before, ownerAway, ownerBack, guestBack: guestEditor.remoteCursors() }, { before: ['1:3'], ownerAway: [], ownerBack: ['1:3'], guestBack: ['1:5'] });
	});

	test('cursors: someone else\'s edit that shifts the caret in a background editor doesn\'t move the cursor to that file', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha', 'b.txt': 'beta' });
		const guestB = await openBound(guest, URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/b.txt' }));
		const received: string[] = [];
		testStore!.add(guest.service.onCursorUpdate(update => received.push(update.fileId)));
		const ownerB = await openBound(owner, URI.joinPath(folder, 'b.txt'));
		ownerB.editor.setPosition({ lineNumber: 1, column: 3 });
		const ownerA = await openBound(owner, URI.joinPath(folder, 'a.txt'));
		ownerA.editor.setPosition({ lineNumber: 1, column: 4 });
		const aId = owner.fileSystem.getServerFileId('a.txt')!;
		await until(() => received.at(-1) === aId, 'the owner\'s cursor in a.txt').catch(() => { });
		const mark = received.length;
		// The guest types a line at the top of b.txt: the owner's caret there, in the background, moves down.
		guestB.editor.setPosition({ lineNumber: 1, column: 1 });
		guestB.editor.trigger('keyboard', Handler.Type, { text: 'x\n' });
		await shows(ownerB, 'x\nbeta');
		const shifted = ownerB.editor.getPosition()?.toString();
		// What must arrive after anything the shift sent: the owner's cursor moving in a.txt.
		ownerA.editor.setPosition({ lineNumber: 1, column: 5 });
		await until(() => received.length > mark && received.at(-1) === aId, 'the owner\'s next move in a.txt').catch(() => { });
		assert.deepStrictEqual({ shifted, afterTheEdit: received.slice(mark) }, { shifted: '(2,3)', afterTheEdit: [aId] });
	});

	test('cursors: the cursor follows the active editor: switching editor groups moves it to that group\'s file, with no caret move', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha', 'b.txt': 'beta' });
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		const guestA = await openBound(guest, URI.joinPath(guestRoot, 'a.txt'));
		const guestB = await openBound(guest, URI.joinPath(guestRoot, 'b.txt'));
		const shown = () => ({ a: guestA.remoteCursors(), b: guestB.remoteCursors() });
		const ownerA = await openBound(owner, URI.joinPath(folder, 'a.txt'));
		ownerA.editor.setPosition({ lineNumber: 1, column: 3 });
		const ownerB = await openBound(owner, URI.joinPath(folder, 'b.txt'));
		ownerB.editor.setPosition({ lineNumber: 1, column: 2 });
		await until(() => guestB.remoteCursors().includes('1:2'), 'the owner\'s cursor in b.txt').catch(() => { });
		const inB = shown();
		ownerA.activate();
		await until(() => guestA.remoteCursors().includes('1:3'), 'the owner\'s cursor back in a.txt').catch(() => { });
		const backInA = shown();
		assert.deepStrictEqual({ inB, backInA }, { inB: { a: [], b: ['1:2'] }, backInA: { a: ['1:3'], b: [] } });
	});

	test('cursors: closing the active editor moves the cursor to the editor that becomes active', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha', 'b.txt': 'beta' });
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		const guestA = await openBound(guest, URI.joinPath(guestRoot, 'a.txt'));
		const guestB = await openBound(guest, URI.joinPath(guestRoot, 'b.txt'));
		const ownerA = await openBound(owner, URI.joinPath(folder, 'a.txt'));
		ownerA.editor.setPosition({ lineNumber: 1, column: 3 });
		const ownerB = await openBound(owner, URI.joinPath(folder, 'b.txt'));
		ownerB.editor.setPosition({ lineNumber: 1, column: 2 });
		await until(() => guestB.remoteCursors().includes('1:2'), 'the owner\'s cursor in b.txt').catch(() => { });
		ownerB.close();
		await until(() => guestA.remoteCursors().includes('1:3'), 'the owner\'s cursor in a.txt').catch(() => { });
		assert.deepStrictEqual({ a: guestA.remoteCursors(), b: guestB.remoteCursors() }, { a: ['1:3'], b: [] });
	});

	test('cursors: switching to another app (the window losing focus) neither moves nor clears the cursor', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha' });
		const guestA = await openBound(guest, URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/a.txt' }));
		const left: string[] = [];
		testStore!.add(guest.service.onCursorLeave(payload => left.push(payload.socketId)));
		const ownerA = await openBound(owner, URI.joinPath(folder, 'a.txt'));
		ownerA.editor.setPosition({ lineNumber: 1, column: 3 });
		await until(() => guestA.remoteCursors().includes('1:3'), 'the owner\'s cursor').catch(() => { });
		mainWindow.dispatchEvent(new FocusEvent('blur'));
		await timeout(300);
		const away = guestA.remoteCursors();
		mainWindow.dispatchEvent(new FocusEvent('focus'));
		await timeout(100);
		assert.deepStrictEqual({ away, back: guestA.remoteCursors(), left }, { away: ['1:3'], back: ['1:3'], left: [] });
	});

	/**
	 * A server restart, in the rig: the server is sent `signal` (SIGTERM, as Railway sends on a
	 * deploy, or SIGKILL: a crash, or Railway's kill after its grace period, where nothing runs) and
	 * comes back on the same database. The files were shared just now, so nothing has been folded
	 * into a saved state yet: only the changes the server appended as it applied them can bring
	 * them back. Edits made just before, edits made while it's down, and edits whose author quits
	 * instead of reconnecting must all end up, once each, in both editors, on the owner's disk and
	 * in the room as saved (read after a second restart, SIGKILL, with every app closed).
	 * Synchronized on the server having the edits (relayed to another window, or written to the
	 * owner's disk from the room), never on a wait.
	 */
	async function restartScenario(signal: 'SIGTERM' | 'SIGKILL') {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha', 'b.txt': 'beta' });
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		const ownerA = await openBound(owner, URI.joinPath(folder, 'a.txt'));
		const guestA = await openBound(guest, URI.joinPath(guestRoot, 'a.txt'));
		const quitter = await joinsByInvite(owner, roomId, 'quitter');
		await until(() => quitter.workspace.getWorkspace().folders.some(f => f.uri.scheme === LIVECOLLAB_SCHEME), 'the quitter\'s room folder');
		const quitterA = await openBound(quitter, URI.joinPath(guestRoot, 'a.txt'));
		// b.txt is open only in the quitter's window.
		const quitterB = await openBound(quitter, URI.joinPath(guestRoot, 'b.txt'));
		const disk = async (name: string) => (await owner.fileService.readFile(URI.joinPath(folder, name))).value.toString();

		// Before the restart: the server has these (the owner wrote b.txt's to disk from the room;
		// the owner shows a.txt's, relayed after the server applied and appended them, so they are
		// under a second old, not yet compacted, when the signal comes).
		quitterB.type(' quitB');
		await until(async () => (await disk('b.txt')).includes(' quitB'), 'the owner\'s disk to have the quitter\'s b.txt edit');
		guestA.type(' before');
		quitterA.type(' quitA');
		await shows(ownerA, ' quitA');
		await shows(ownerA, ' before');
		const gone = Promise.all([owner, guest, quitter].map(w => next(w.service.onDisconnected, 'a window to see the server go')));
		await restartServer({ downMs: 2500, signal });
		await gone;
		// The quitter quits instead of reconnecting; the other two type while the server is down.
		quitter.service.signOut();
		ownerA.type(' ownerDown');
		guestA.type(' guestDown');
		await longUntil(() => owner.service.isConnected && guest.service.isConnected, 'both windows to reconnect');
		const fragments = [' before', ' quitA', ' ownerDown', ' guestDown'];
		await longUntil(() => fragments.every(f => ownerA.text().includes(f) && guestA.text().includes(f)), 'both editors to have every edit').catch(() => { });
		await longUntil(async () => (await disk('a.txt')) === ownerA.text(), 'the owner\'s disk to match its editor').catch(() => { });
		const live = { ownerA: ownerA.text(), guestA: guestA.text(), ownerDiskA: await disk('a.txt'), ownerDiskB: await disk('b.txt') };

		const [savedA, savedB] = await savedAfterKill(owner, [guest], roomId, ['a.txt', 'b.txt']);
		const saved = { a: savedA, b: savedB };

		const once = (text: string, list: string[]) => list.filter(f => text.split(f).length === 2);
		return {
			fragments,
			a: { sameEverywhere: new Set([live.ownerA, live.guestA, live.ownerDiskA, saved.a]).size === 1, onceEach: once(saved.a, fragments), startsAlpha: saved.a.startsWith('alpha') },
			b: { sameEverywhere: live.ownerDiskB === saved.b, onceEach: once(saved.b, [' quitB']), startsBeta: saved.b.startsWith('beta') },
		};
	}

	/**
	 * The room as saved: every app closed (`owner` and `others` sign out), the server killed at
	 * once with SIGKILL (nothing gets to run), and someone new joins the restarted server and
	 * reads `names`.
	 */
	async function savedAfterKill(owner: IBClient, others: IBClient[], roomId: string, names: string[]): Promise<string[]> {
		const invite = await owner.service.createInviteCode();
		owner.service.signOut();
		for (const other of others) { other.service.signOut(); }
		await restartServer({ downMs: 0, signal: 'SIGKILL' });
		const observer = await windowClient('observer');
		await longUntil(async () => (await observer.service.joinByCode(invite.code ?? '')).ok === true, 'the observer to join after the restart');
		await observer.service.joinExistingRoom(roomId);
		await until(() => observer.workspace.getWorkspace().folders.some(f => f.uri.scheme === LIVECOLLAB_SCHEME), 'the observer\'s room folder');
		const root = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		const texts: string[] = [];
		for (const name of names) { texts.push((await openBound(observer, URI.joinPath(root, name))).text()); }
		return texts;
	}

	/** Turns one of the rig's refusals on or off (livecollab-rig/server.cjs), and reads how many changes it refused. */
	async function rigSwitch(route: 'docs-unavailable' | 'fail-appends' | 'fail-chat' | 'drop-chat-answers', on: boolean): Promise<void> {
		await fetch(`${serverUrl}/__rig/${route}`, { method: 'POST', body: JSON.stringify({ on }) });
	}
	async function rigRefused(): Promise<{ notReady: number; notSaved: number }> {
		return (await fetch(`${serverUrl}/__rig/refused`)).json();
	}

	/** Restarts the rig's server (see livecollab-rig/server.cjs, /__rig/restart). */
	function restartServer(how: { downMs: number; signal?: 'SIGTERM' | 'SIGKILL'; forgetDocs?: boolean }): Promise<Response> {
		return fetch(`${serverUrl}/__rig/restart`, { method: 'POST', body: JSON.stringify(how) });
	}

	/** Waits up to four steps: a reconnect waits out socket.io's backoff. */
	async function longUntil(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
		for (let attempt = 1; ; attempt++) {
			try { return await until(check, what); } catch (e) { if (attempt === 4) { throw e; } }
		}
	}

	test('restart: a deploy (SIGTERM) loses nothing: edits just before it, edits made while it is down, and the last edits of someone who quits, in a file open nowhere else, are everywhere once each', async () => {
		const { fragments, a, b } = await restartScenario('SIGTERM');
		assert.deepStrictEqual({ a, b }, { a: { sameEverywhere: true, onceEach: fragments, startsAlpha: true }, b: { sameEverywhere: true, onceEach: [' quitB'], startsBeta: true } });
	}).timeout(STEP_MS * 20);

	test('restart: a crash (SIGKILL: no shutdown runs) loses nothing either: the changes appended as they were applied bring back files shared just before it', async () => {
		const { fragments, a, b } = await restartScenario('SIGKILL');
		assert.deepStrictEqual({ a, b }, { a: { sameEverywhere: true, onceEach: fragments, startsAlpha: true }, b: { sameEverywhere: true, onceEach: [' quitB'], startsBeta: true } });
	}).timeout(STEP_MS * 20);

	test('restart: a server that comes back without its documents (rebuilt from the owner\'s disk): a guest\'s offline edit is announced to the guest, never merged into the room as a second copy of the text', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha' });
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		const ownerA = await openBound(owner, URI.joinPath(folder, 'a.txt'));
		const guestA = await openBound(guest, URI.joinPath(guestRoot, 'a.txt'));
		guestA.type(' x');
		await shows(ownerA, ' x');
		const told: Array<{ path: string | undefined; reason: string }> = [];
		testStore!.add(guest.service.onSyncFailed(({ path, reason }) => told.push({ path: path?.split('/').pop(), reason })));
		const gone = Promise.all([owner, guest].map(w => next(w.service.onDisconnected, 'a window to see the server go')));
		await restartServer({ downMs: 2500, signal: 'SIGKILL', forgetDocs: true });
		await gone;
		guestA.type(' guestDown');
		await longUntil(() => owner.service.isConnected && guest.service.isConnected, 'both windows to reconnect');
		const disk = async () => (await owner.fileService.readFile(URI.joinPath(folder, 'a.txt'))).value.toString();
		await longUntil(() => told.length > 0, 'the guest to be told').catch(() => { });
		await longUntil(async () => (await disk()) === ownerA.text(), 'the owner\'s disk to match its editor').catch(() => { });
		// Anything the guest still sent would have arrived by now.
		ownerA.type(' after');
		await longUntil(async () => (await disk()).includes(' after'), 'the owner\'s disk to have a later edit');
		assert.deepStrictEqual({ told, owner: ownerA.text(), ownerDisk: await disk() }, { told: [{ path: 'a.txt', reason: 'rebuilt' }], owner: 'alpha x after', ownerDisk: 'alpha x after' });
	}).timeout(STEP_MS * 20);

	/**
	 * The room answers "not ready" (no document for the file) while its document, history and
	 * all, is still there, then becomes available again: the guest's refused changes, both from
	 * its rejoin check and from typing afterwards, are kept, sent again by the retry, and end up
	 * once each in both editors, on the owner's disk and in the room as saved. Nothing else brings
	 * them back: no reconnect, no snapshot, so only the retry can.
	 */
	test('restart: "not ready", then ready again: the guest\'s refused changes are retried and arrive once each everywhere', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha' });
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		const ownerA = await openBound(owner, URI.joinPath(folder, 'a.txt'));
		const guestA = await openBound(guest, URI.joinPath(guestRoot, 'a.txt'));
		guestA.type(' x');
		await shows(ownerA, ' x');
		const before = await rigRefused();
		await rigSwitch('docs-unavailable', true);
		await guest.network.drop();
		guestA.type(' offline');
		await guest.network.restore();
		await longUntil(() => guest.service.isConnected, 'the guest to reconnect');
		guestA.type(' live');
		// Refused twice: the rejoin check, and the change typed after it.
		await longUntil(async () => (await rigRefused()).notReady >= before.notReady + 2, 'the room to refuse both');
		const whileRefused = ownerA.text();
		await rigSwitch('docs-unavailable', false);
		const fragments = [' x', ' offline', ' live'];
		await longUntil(() => fragments.every(f => ownerA.text().includes(f)), 'the owner to have the retried changes').catch(() => { });
		const disk = async () => (await owner.fileService.readFile(URI.joinPath(folder, 'a.txt'))).value.toString();
		await longUntil(async () => (await disk()) === ownerA.text(), 'the owner\'s disk to match its editor').catch(() => { });
		const live = { owner: ownerA.text(), guest: guestA.text(), ownerDisk: await disk() };
		const [saved] = await savedAfterKill(owner, [guest], roomId, ['a.txt']);
		const once = (text: string) => fragments.filter(f => text.split(f).length === 2);
		assert.deepStrictEqual(
			{ whileRefused, sameEverywhere: new Set([live.owner, live.guest, live.ownerDisk, saved]).size === 1, onceEach: once(saved), saved },
			{ whileRefused: 'alpha x', sameEverywhere: true, onceEach: fragments, saved: 'alpha x offline live' });
	}).timeout(STEP_MS * 20);

	/**
	 * The database refuses the server's append: the change is neither applied nor relayed (no one
	 * sees an edit the room hasn't saved), the guest keeps it, and once the database takes appends
	 * again the retry brings it, once, to the owner's editor, disk and the room as saved.
	 */
	test('restart: a change the database fails to save is not relayed; it is retried once saving works and arrives once everywhere', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha' });
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		const ownerA = await openBound(owner, URI.joinPath(folder, 'a.txt'));
		const guestA = await openBound(guest, URI.joinPath(guestRoot, 'a.txt'));
		guestA.type(' x');
		await shows(ownerA, ' x');
		const before = await rigRefused();
		await rigSwitch('fail-appends', true);
		guestA.type(' unsaved');
		await longUntil(async () => (await rigRefused()).notSaved > before.notSaved, 'the database to refuse the change');
		// The server relays a change only after saving it: by now, a relayed one would have arrived.
		ownerA.type(' owner');
		await longUntil(async () => (await rigRefused()).notSaved > before.notSaved + 1, 'the database to refuse the owner\'s change too');
		const whileFailing = { owner: ownerA.text(), guestHasOwners: guestA.text().includes(' owner') };
		await rigSwitch('fail-appends', false);
		const fragments = [' x', ' unsaved', ' owner'];
		await longUntil(() => fragments.every(f => ownerA.text().includes(f) && guestA.text().includes(f)), 'both editors to have every change').catch(() => { });
		const disk = async () => (await owner.fileService.readFile(URI.joinPath(folder, 'a.txt'))).value.toString();
		await longUntil(async () => (await disk()) === ownerA.text(), 'the owner\'s disk to match its editor').catch(() => { });
		const live = { owner: ownerA.text(), guest: guestA.text(), ownerDisk: await disk() };
		const [saved] = await savedAfterKill(owner, [guest], roomId, ['a.txt']);
		const once = (text: string) => fragments.filter(f => text.split(f).length === 2);
		assert.deepStrictEqual(
			{ whileFailing, sameEverywhere: new Set([live.owner, live.guest, live.ownerDisk, saved]).size === 1, onceEach: once(saved) },
			{ whileFailing: { owner: 'alpha x owner', guestHasOwners: false }, sameEverywhere: true, onceEach: fragments });
	}).timeout(STEP_MS * 20);

	/**
	 * The server's cursor filter: a cursor is relayed only when it names one of the room's current
	 * files by id. Run only against a server that has it (branch cursor-filter).
	 */
	const filterTest = serverFiltersCursors ? test : test.skip;

	filterTest('cursor filter: the server relays a cursor only in one of the room\'s files: not a name, not a deleted file\'s id; a created file\'s id, and ids after the owner re-attaches, are', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha', 'b.txt': 'beta' });
		const received: string[] = [];
		testStore!.add(guest.service.onCursorUpdate(update => received.push(update.fileId)));
		const source = {};
		const at = (fileId: string, column: number) => owner.service.emitCursorUpdate(roomId, fileId, { lineNumber: 1, column }, source);
		const [aId, bId] = [owner.fileSystem.getServerFileId('a.txt')!, owner.fileSystem.getServerFileId('b.txt')!];
		// What 0.3.5 sends: the base name.
		at('a.txt', 1);
		// A deleted file's id.
		await guest.workingCopyFileService.delete([{ resource: URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/b.txt' }) }], CancellationToken.None);
		await until(async () => !(await owner.fileService.exists(URI.joinPath(folder, 'b.txt'))), 'the delete to reach the owner');
		at(bId, 2);
		// A file created in the room.
		await owner.workingCopyFileService.create([{ resource: URI.joinPath(folder, 'new.txt') }], CancellationToken.None);
		await until(() => owner.fileSystem.getServerFileId('new.txt') !== undefined, 'the new file\'s id');
		const newId = owner.fileSystem.getServerFileId('new.txt')!;
		at(newId, 3);
		// After a reconnect and re-attach, the room's ids still count.
		await owner.network.drop();
		await restoreAndReattach(owner);
		at(aId, 4);
		await until(() => received.includes(aId), 'the a.txt cursor after the re-attach').catch(() => { });
		assert.deepStrictEqual(received, [newId, aId]);
	});

	filterTest('cursor filter: a client that sends base-name cursors (0.3.5) still edits shared code, both ways; only its cursors are dropped', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha' });
		const ownerEditor = await openBound(owner, URI.joinPath(folder, 'a.txt'));
		const guestEditor = await openBound(guest, URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/a.txt' }));
		const ownerReceived: string[] = [];
		testStore!.add(owner.service.onCursorUpdate(update => ownerReceived.push(update.fileId)));
		const source = {};
		guest.service.emitCursorUpdate(roomId, 'a.txt', { lineNumber: 1, column: 2 }, source);
		guestEditor.type(' old');
		guest.service.emitCursorUpdate(roomId, 'a.txt', { lineNumber: 1, column: 9 }, source);
		await shows(ownerEditor, ' old');
		ownerEditor.type(' new');
		await shows(guestEditor, ' new');
		assert.deepStrictEqual({ owner: ownerEditor.text(), guest: guestEditor.text(), baseNames: ownerReceived.filter(id => id === 'a.txt') }, { owner: 'alpha old new', guest: 'alpha old new', baseNames: [] });
	});

	setup(() => {
		testStore = store.add(new DisposableStore());
		run++;
		logLines.length = 0;
		echo = lcLog.echoTo({ info: line => logLines.push(line), warn: line => logLines.push(`WARN ${line}`), error: line => logLines.push(`ERROR ${line}`) });
	});

	test('plumbing: the owner creates a room and attaches a folder; a guest joins by invite and receives the tree', async () => {
		const owner = await client('owner');
		const roomId = await owner.createRoomNamed('layer-b');
		assert.ok(roomId, 'the server created no room');
		await owner.joinExistingRoom(roomId);
		const tree: ILiveCollabTreeItem[] = [
			{ name: 'a.txt', path: 'a.txt', type: 'file', content: 'alpha' },
			{ name: 'd', path: 'd', type: 'directory', children: [{ name: 'c.txt', path: 'd/c.txt', type: 'file', content: 'gamma' }] },
		];
		const attached = await owner.attachFolder(tree, owner.roomEpoch, 'folder', [], []);
		const invite = await owner.createInviteCode();

		const guest = await client('guest');
		const joined = await guest.joinByCode(invite.code ?? '');
		const snapshot = next<ILiveCollabSnapshot>(guest.onSnapshot, 'the guest\'s snapshot');
		await guest.joinExistingRoom(roomId);
		const received = await snapshot;

		assert.deepStrictEqual({
			attached: attached?.ok,
			invite: invite.success,
			joined: joined.ok,
			guestRole: guest.myRole,
			guestTree: paths(received.tree),
		}, {
			attached: true,
			invite: true,
			joined: true,
			guestRole: 'editor',
			guestTree: ['a.txt', 'd/', 'd/c.txt'],
		});
	});

	test('windows: a folder the owner opens is shared, and the guest\'s window shows it', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha', 'd/c.txt': 'gamma' });
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		assert.deepStrictEqual({
			ownerFolders: owner.workspace.getWorkspace().folders.map(f => f.uri.toString()),
			guestFolders: guest.workspace.getWorkspace().folders.map(f => ({ uri: f.uri.toString(), name: f.name })),
			guestFiles: await listed(guest.fileService, guestRoot),
			guestText: (await guest.fileService.readFile(URI.joinPath(guestRoot, 'd', 'c.txt'))).value.toString(),
		}, {
			ownerFolders: [folder.toString()],
			guestFolders: [{ uri: guestRoot.toString(), name: 'project' }],
			guestFiles: ['a.txt', 'd/', 'd/c.txt'],
			guestText: 'gamma',
		});
	});

	test('windows: the guest\'s file tree fills even when seeding from the snapshot fails', async () => {
		// A malformed doc entry makes the seeding throw (the never-bind fix's first condition: the
		// snapshot is announced after seeding, and must be announced however the seeding ends).
		const { guest, roomId } = await ownerSharesGuestJoins({ 'a.txt': 'alpha', 'd/c.txt': 'gamma' }, guest =>
			guest.network.rewriteIncoming('room:snapshot', (snap: unknown) => [{ ...snap as object, docs: [...(snap as { docs: unknown[] }).docs, null] }]));
		const guestRoot = URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/' });
		assert.deepStrictEqual({
			seedingFailed: logLines.some(line => line.includes('seeding from the snapshot failed')),
			guestFiles: await listed(guest.fileService, guestRoot),
			guestText: (await guest.fileService.readFile(URI.joinPath(guestRoot, 'd', 'c.txt'))).value.toString(),
		}, {
			seedingFailed: true,
			guestFiles: ['a.txt', 'd/', 'd/c.txt'],
			guestText: 'gamma',
		});
	});

	test('windows: a file the guest creates reaches the owner\'s disk', async () => {
		const { owner, guest, roomId, folder } = await ownerSharesGuestJoins({ 'a.txt': 'alpha' });
		await guest.workingCopyFileService.create([{ resource: URI.from({ scheme: LIVECOLLAB_SCHEME, authority: roomId, path: '/new.txt' }) }], CancellationToken.None);
		await until(() => owner.fileService.exists(URI.joinPath(folder, 'new.txt')), 'the guest\'s file on the owner\'s disk');
		assert.deepStrictEqual(await listed(owner.fileService, folder), ['a.txt', 'new.txt']);
	});
});
