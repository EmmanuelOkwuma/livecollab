/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILiveCollabClaimStore, ILiveCollabFolderClaim, ILiveCollabFolderDisk, LiveCollabFolderClaims } from '../../common/livecollabFolderClaims.js';
import { liveCollabFolderDisk } from '../../electron-main/livecollabFolderDisk.js';
import { ILiveCollabInvokeEvent, ILiveCollabIpcHandlers, LiveCollabPages, registerLiveCollabFolderClaimHandlers } from '../../electron-main/livecollabWindowNavigation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';

suite('LiveCollab folder records (a folder shared in two rooms is named before it is shared)', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(async () => {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'lc-claims-')));
		for (const folder of ['work/app/src', 'work/other', 'elsewhere']) {
			await fs.mkdir(join(root, folder), { recursive: true });
		}
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	class MemoryStore implements ILiveCollabClaimStore {
		saved: readonly ILiveCollabFolderClaim[] = [];
		load() { return this.saved; }
		save(claims: readonly ILiveCollabFolderClaim[]) { this.saved = [...claims]; }
	}

	/** The rooms `path` overlaps, by name, once "Release planning" shares work/app. */
	async function overlapsWithReleasePlanning(path: string, disk: ILiveCollabFolderDisk = liveCollabFolderDisk): Promise<string[]> {
		const claims = new LiveCollabFolderClaims(disk, new MemoryStore());
		await claims.claim({ path: join(root, 'work/app'), roomId: 'room-release', roomName: 'Release planning', userId: 'u1', acknowledged: [] });
		return (await claims.overlaps(path, 'room-new')).rooms.map(room => room.roomName ?? room.roomId);
	}

	test('the same folder, a folder inside it, a folder containing it and the same folder through a link overlap; a different folder does not', async () => {
		await fs.symlink(join(root, 'work/app'), join(root, 'link-to-app'));
		assert.deepStrictEqual({
			same: await overlapsWithReleasePlanning(join(root, 'work/app')),
			inside: await overlapsWithReleasePlanning(join(root, 'work/app/src')),
			containing: await overlapsWithReleasePlanning(join(root, 'work')),
			throughALink: await overlapsWithReleasePlanning(join(root, 'link-to-app')),
			sibling: await overlapsWithReleasePlanning(join(root, 'work/other')),
			elsewhere: await overlapsWithReleasePlanning(join(root, 'elsewhere')),
		}, {
			same: ['Release planning'],
			inside: ['Release planning'],
			containing: ['Release planning'],
			throughALink: ['Release planning'],
			sibling: [],
			elsewhere: [],
		});
	});

	test('on a volume that ignores case, the same folder spelled with other capitals overlaps', async function () {
		// What the volume does, asked of the volume: the test's temp folder decides which case runs.
		const ignoresCase = await fs.stat(join(root, 'WORK/APP')).then(() => true, () => false);
		if (!ignoresCase) {
			this.skip();
		}
		assert.deepStrictEqual(await overlapsWithReleasePlanning(join(root, 'WORK/App')), ['Release planning']);
	});

	test('on a volume that keeps case, folders differing only by case stay distinct (the comparison, by identity)', async () => {
		// A case-sensitive volume, as the disk reports it: "App" and "app" are two folders.
		const folders = new Map([['/v', 'v'], ['/v/work', 'work'], ['/v/work/app', 'app'], ['/v/work/App', 'App'], ['/v/work/App/src', 'App-src']]);
		const disk: ILiveCollabFolderDisk = {
			realpath: async path => folders.has(path) ? path : undefined,
			identity: async path => folders.get(path),
			parent: path => path === '/v' ? undefined : path.slice(0, path.lastIndexOf('/')) || '/v',
		};
		const claims = new LiveCollabFolderClaims(disk, new MemoryStore());
		await claims.claim({ path: '/v/work/app', roomId: 'room-release', roomName: 'Release planning', userId: 'u1', acknowledged: [] });
		assert.deepStrictEqual({
			otherCase: (await claims.overlaps('/v/work/App', 'room-new')).rooms.length,
			insideOtherCase: (await claims.overlaps('/v/work/App/src', 'room-new')).rooms.length,
			same: (await claims.overlaps('/v/work/app', 'room-new')).rooms.length,
		}, { otherCase: 0, insideOtherCase: 0, same: 1 });
	});

	test('two windows sharing overlapping folders at once: one is recorded, the other is told of it before anything is recorded', async () => {
		const claims = new LiveCollabFolderClaims(liveCollabFolderDisk, new MemoryStore());
		// Both were shown the plain question (no overlap then) and both chose Share.
		const [first, second] = await Promise.all([
			claims.claim({ path: join(root, 'work/app'), roomId: 'room-a', roomName: 'A', userId: 'u1', acknowledged: [] }),
			claims.claim({ path: join(root, 'work'), roomId: 'room-b', roomName: 'B', userId: 'u1', acknowledged: [] }),
		]);
		assert.deepStrictEqual({ first, second: second.ok ? 'recorded' : second.rooms.map(room => room.roomName) }, { first: { ok: true }, second: ['A'] });
		// Told, and choosing Share anyway, it's recorded.
		assert.deepStrictEqual(await claims.claim({ path: join(root, 'work'), roomId: 'room-b', roomName: 'B', userId: 'u1', acknowledged: ['room-a'] }), { ok: true });
	});

	test('records outlive the app; a room\'s folder that is gone from disk overlaps nothing but is kept; a release forgets the room', async () => {
		const store = new MemoryStore();
		await new LiveCollabFolderClaims(liveCollabFolderDisk, store).claim({ path: join(root, 'work/app'), roomId: 'room-a', roomName: 'A', userId: 'u1', acknowledged: [] });
		await new LiveCollabFolderClaims(liveCollabFolderDisk, store).claim({ path: join(root, 'elsewhere'), roomId: 'room-gone', roomName: 'Gone', userId: 'u1', acknowledged: [] });
		await fs.rm(join(root, 'elsewhere'), { recursive: true });
		const relaunched = new LiveCollabFolderClaims(liveCollabFolderDisk, store);
		const before = (await relaunched.overlaps(join(root, 'work'), 'room-new')).rooms.map(room => room.roomName);
		await relaunched.release('room-a');
		const after = (await relaunched.overlaps(join(root, 'work'), 'room-new')).rooms.map(room => room.roomName);
		assert.deepStrictEqual({ before, after, kept: store.saved.map(claim => claim.roomId) }, { before: ['A'], after: [], kept: ['room-gone'] });
	});

	test('a folder a window recorded before 0.3.6 counts, and its room is named once a share records the name', async () => {
		const claims = new LiveCollabFolderClaims(liveCollabFolderDisk, new MemoryStore());
		const known = [{ roomId: 'room-old', path: join(root, 'work/app') }];
		const unnamed = (await claims.overlaps(join(root, 'work/app/src'), 'room-new', known)).rooms;
		await claims.claim({ path: join(root, 'work/app'), roomId: 'room-old', roomName: 'Old room', userId: 'u1', acknowledged: [], known });
		const named = (await claims.overlaps(join(root, 'work/app/src'), 'room-new', known)).rooms;
		assert.deepStrictEqual({ unnamed, named }, {
			unnamed: [{ roomId: 'room-old', path: join(root, 'work/app') }],
			named: [{ roomId: 'room-old', roomName: 'Old room', userId: 'u1', path: join(root, 'work/app') }],
		});
	});

	test('only an open window\'s workbench page may read or change the records: a dashboard, an unknown page and a malformed request get null and change nothing', async () => {
		const handlers = new Map<string, (event: ILiveCollabInvokeEvent, ...args: unknown[]) => unknown>();
		const ipc: ILiveCollabIpcHandlers = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) };
		const store = disposables.add(new DisposableStore());
		const pages = new LiveCollabPages();
		const workbench = {}, dashboard = {};
		store.add(pages.add(workbench, 'workbench'));
		store.add(pages.add(dashboard, 'dashboard'));
		const saved = new MemoryStore();
		store.add(registerLiveCollabFolderClaimHandlers(ipc, pages, new LiveCollabFolderClaims(liveCollabFolderDisk, saved), { info: () => { } }));
		const from = (sender: object): ILiveCollabInvokeEvent => ({ sender, senderFrame: { parent: null, url: 'vscode-file://vscode-app/out/vs/code/electron-browser/workbench/workbench.html' } });
		const claim = { path: join(root, 'work/app'), roomId: 'room-a', roomName: 'A', userId: 'u1', acknowledged: [] };
		const claimChannel = handlers.get('vscode:livecollab-folder-claim')!;
		const refused = {
			dashboard: await claimChannel(from(dashboard), claim),
			unknownPage: await claimChannel(from({}), claim),
			malformed: await claimChannel(from(workbench), { path: 3, roomId: 'room-a', acknowledged: [] }),
			releaseFromDashboard: await handlers.get('vscode:livecollab-folder-release')!(from(dashboard), { roomId: 'room-a' }),
			recorded: saved.saved.length,
		};
		const accepted = await claimChannel(from(workbench), claim);
		const overlaps = await handlers.get('vscode:livecollab-folder-overlaps')!(from(workbench), { path: join(root, 'work'), roomId: 'room-b' });
		assert.deepStrictEqual({ refused, accepted, overlaps }, {
			refused: { dashboard: null, unknownPage: null, malformed: null, releaseFromDashboard: null, recorded: 0 },
			accepted: { ok: true },
			overlaps: { rooms: [{ roomId: 'room-a', roomName: 'A', userId: 'u1', path: join(root, 'work/app') }] },
		});
	});
});
