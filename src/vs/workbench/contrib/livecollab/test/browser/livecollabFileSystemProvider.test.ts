/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType, toFileSystemProviderErrorCode } from '../../../../../platform/files/common/files.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { LiveCollabFileSystemProvider, LIVECOLLAB_SCHEME } from '../../browser/livecollabFileSystemProvider.js';
import { ILiveCollabTreeItem } from '../../browser/livecollabService.js';

suite('LiveCollab virtual file system (guest)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const uri = (path: string, room = 'room-test') => URI.from({ scheme: LIVECOLLAB_SCHEME, authority: room, path });
	const always = () => true;
	const file = (name: string) => ({ name, path: name, type: 'file' as const });
	const folder = (name: string, children: ILiveCollabTreeItem[]) => ({ name, path: name, type: 'directory' as const, children });
	const topLevel = async (provider: LiveCollabFileSystemProvider, room: string) => (await provider.readdir(uri('/', room))).map(([name]) => name).sort();

	test('a file can arrive for folders this side never saw (Sunday 2026-10-25: apply create failed, EntryNotFound)', async () => {
		const provider = store.add(new LiveCollabFileSystemProvider());
		provider.enterRoom('room-test');
		await provider.mkdir(uri('/existing'));
		await provider.ensureParentFolders(uri('/existing/lc-test-a/deeper/greet.ts'));
		await provider.ensureParentFolders(uri('/existing/lc-test-a/deeper/greet.ts')); // again: nothing to make, no error
		await provider.ensureParentFolders(uri('/top.ts')); // at the root: nothing to make
		await provider.writeFile(uri('/existing/lc-test-a/deeper/greet.ts'), VSBuffer.fromString('hi').buffer, { create: true, overwrite: false, unlock: false, atomic: false });
		assert.deepStrictEqual(
			await Promise.all(['/existing', '/existing/lc-test-a', '/existing/lc-test-a/deeper', '/existing/lc-test-a/deeper/greet.ts'].map(async p => (await provider.stat(uri(p))).type)),
			[FileType.Directory, FileType.Directory, FileType.Directory, FileType.File]
		);
	});

	test('a room shows only its own files (2026-10-28: a guest saw the previous room\'s files under the next room\'s folder)', async () => {
		const provider = store.add(new LiveCollabFileSystemProvider());
		provider.enterRoom('room-a');
		await provider.populateFromTree([folder('scheduler', [file('solver.py')]), file('run.sh')], always);
		provider.clear(); // leaving room A
		provider.enterRoom('room-b');
		await provider.populateFromTree([file('greet.ts'), file('README.md')], always);
		assert.deepStrictEqual({
			roomB: await topLevel(provider, 'room-b'),
			contents: provider.describeContents(),
		}, {
			roomB: ['README.md', 'greet.ts'],
			contents: { count: 2, topLevel: ['README.md', 'greet.ts'] },
		});
	});

	test('entering another room empties the tree even when no leave cleared it, and says so; the same room again keeps it', async () => {
		const warnings: string[] = [];
		const provider = store.add(new LiveCollabFileSystemProvider(message => warnings.push(message)));
		provider.enterRoom('room-a');
		await provider.populateFromTree([file('a.ts')], always);
		provider.enterRoom('room-a'); // a re-attach snapshot mid-session
		const sameRoom = await topLevel(provider, 'room-a');
		provider.enterRoom('room-b'); // no clear(): a way out of room A that skipped the leave
		await provider.populateFromTree([file('b.ts')], always);
		assert.deepStrictEqual({ sameRoom, nextRoom: await topLevel(provider, 'room-b'), warnings }, {
			sameRoom: ['a.ts'],
			nextRoom: ['b.ts'],
			warnings: ['[LiveCollab] virtual file system was NOT empty entering room-b: 1 entries left from room-a, top level: a.ts — emptying it'],
		});
	});

	test('two providers in one process fill from their own room docs (layer B: one client each)', async () => {
		const docs = (text: string) => ({ hasLiveDoc: () => false, getSnapshotText: async () => text });
		const a = store.add(new LiveCollabFileSystemProvider(undefined, docs('from A')));
		const b = store.add(new LiveCollabFileSystemProvider(undefined, docs('from B')));
		a.enterRoom('room-test');
		b.enterRoom('room-test');
		const withId = { ...file('a.ts'), id: 'f1' };
		await a.populateFromTree([withId], always);
		await b.populateFromTree([withId], always);
		const text = async (provider: LiveCollabFileSystemProvider) => new TextDecoder().decode(await provider.readFile(uri('/a.ts')));
		assert.deepStrictEqual({ a: await text(a), b: await text(b) }, { a: 'from A', b: 'from B' });
	});

	test('a read for another room, or with no room entered, is not found', async () => {
		const provider = store.add(new LiveCollabFileSystemProvider());
		provider.enterRoom('room-a');
		await provider.populateFromTree([file('a.ts')], always);
		const notFound = async (read: () => Promise<unknown>) => {
			try { await read(); return 'found'; } catch (e) { return toFileSystemProviderErrorCode(e as Error); }
		};
		const otherRoom = await notFound(() => provider.readFile(uri('/a.ts', 'room-b')));
		provider.clear();
		const noRoom = await notFound(() => provider.readFile(uri('/a.ts', 'room-a')));
		assert.deepStrictEqual({ otherRoom, noRoom }, { otherRoom: FileSystemProviderErrorCode.FileNotFound, noRoom: FileSystemProviderErrorCode.FileNotFound });
	});

	test('a viewer\'s room is read-only with the reason, and LiveCollab\'s own writes still land (roles audit 2026-10-29)', async () => {
		const provider = store.add(new LiveCollabFileSystemProvider());
		provider.enterRoom('room-test');
		let changes = 0;
		store.add(provider.onDidChangeCapabilities(() => changes++));
		const readonly = () => !!(provider.capabilities & FileSystemProviderCapabilities.Readonly);
		const before = readonly();
		provider.setViewerReadOnly({ value: 'viewer' });
		provider.setViewerReadOnly({ value: 'viewer' }); // the same again: no event
		const asViewer = { readonly: readonly(), message: provider.readOnlyMessage?.value };
		await provider.writeFile(uri('/from-the-room.ts'), VSBuffer.fromString('remote').buffer, { create: true, overwrite: false, unlock: false, atomic: false });
		const written = VSBuffer.wrap(await provider.readFile(uri('/from-the-room.ts'))).toString();
		provider.setViewerReadOnly(undefined);
		assert.deepStrictEqual(
			{ before, asViewer, written, after: readonly(), message: provider.readOnlyMessage, changes, openReadWriteClose: !!(provider.capabilities & FileSystemProviderCapabilities.FileOpenReadWriteClose) },
			{ before: false, asViewer: { readonly: true, message: 'viewer' }, written: 'remote', after: false, message: undefined, changes: 2, openReadWriteClose: true }
		);
	});
});
