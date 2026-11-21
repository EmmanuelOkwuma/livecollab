/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createMonacoBaseAPI } from '../../../../../editor/common/services/editorBaseApi.js';
import { LiveCollabFileStates } from '../../browser/livecollabFileStates.js';

type YjsModule = typeof import('yjs');
type YDoc = InstanceType<YjsModule['Doc']>;

suite('LiveCollab file states (remote updates for files without a live doc)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let Y: YjsModule;

	suiteSetup(async () => {
		// The vendored bundle's y-monaco shim reads this global at module
		// evaluation — set it first, as livecollabEditorContribution does.
		(globalThis as unknown as { __livecollabMonacoAPI: unknown }).__livecollabMonacoAPI = createMonacoBaseAPI();
		// The unit runner's page (test/unit/electron/renderer.html) require()s
		// every package.json dependency for its import map, yjs among them, so
		// Yjs's already-imported flag is set before this module loads and the
		// import would print a warning the runner treats as a failure (traced
		// 2026-11-04, TEST_HARNESS_TRIAGE.md). The app loads Yjs once, from the
		// bundle; these tests use only this bundle's Y.
		delete (globalThis as unknown as Record<string, unknown>)['__ $YJS$ __'];
		// @ts-ignore — untyped vendored ESM bundle, loaded exactly as livecollabService loads it
		Y = (await import('../../browser/vendor/livecollab-yjs.esm.min.js') as { Y: YjsModule }).Y;
	});

	/** The host's seed state for a file, and an update typed on another machine after it. */
	function seedAndLaterUpdate(): { seed: Uint8Array; update: Uint8Array } {
		const source = new Y.Doc();
		source.getText('content').insert(0, 'line one\n');
		const seed = Y.encodeStateAsUpdate(source);
		const before = Y.encodeStateVector(source);
		source.getText('content').insert(9, 'CLOSED-ON-MAC 1');
		const update = Y.encodeStateAsUpdate(source, before);
		source.destroy();
		return { seed, update };
	}

	function textOf(state: Uint8Array | undefined): string | undefined {
		if (!state) {
			return undefined;
		}
		const doc = new Y.Doc();
		Y.applyUpdate(doc, state, 'remote');
		const text = doc.getText('content').toString();
		doc.destroy();
		return text;
	}

	test('a live doc receives the update directly', () => {
		const { seed, update } = seedAndLaterUpdate();
		const live = new Y.Doc();
		Y.applyUpdate(live, seed, 'remote');
		const docs = new Map<string, YDoc>([['file-1', live]]);
		const states = new LiveCollabFileStates(fileId => docs.get(fileId));
		states.setSeedState('file-1', seed);

		states.receiveRemoteUpdate(Y, 'file-1', update);

		assert.deepStrictEqual(live.getText('content').toString(), 'line one\nCLOSED-ON-MAC 1');
		live.destroy();
	});

	test('no live doc but a seed state: the update survives until the file is opened, without creating a doc', () => {
		const { seed, update } = seedAndLaterUpdate();
		const docs = new Map<string, YDoc>();
		const states = new LiveCollabFileStates(fileId => docs.get(fileId));
		states.setSeedState('file-1', seed);

		states.receiveRemoteUpdate(Y, 'file-1', update);

		assert.deepStrictEqual({ text: textOf(states.readSeedState(Y, 'file-1')), docsCreated: docs.size }, { text: 'line one\nCLOSED-ON-MAC 1', docsCreated: 0 });
	});

	test('neither: the update is held, never treated as a seed (R1), and merged when the seed arrives', () => {
		const { seed, update } = seedAndLaterUpdate();
		const states = new LiveCollabFileStates(() => undefined);

		states.receiveRemoteUpdate(Y, 'file-1', update);
		const beforeSeed = { hasSeed: states.hasSeedState('file-1'), state: states.readSeedState(Y, 'file-1') };
		states.setSeedState('file-1', seed);

		assert.deepStrictEqual({ beforeSeed, afterSeed: textOf(states.readSeedState(Y, 'file-1')) }, { beforeSeed: { hasSeed: false, state: undefined }, afterSeed: 'line one\nCLOSED-ON-MAC 1' });
	});

	test('dropping a file or clearing the room discards held updates', () => {
		const { seed, update } = seedAndLaterUpdate();
		const states = new LiveCollabFileStates(() => undefined);
		states.receiveRemoteUpdate(Y, 'file-1', update);
		states.receiveRemoteUpdate(Y, 'file-2', update);

		states.drop('file-1');
		states.clear();
		states.setSeedState('file-1', seed);
		states.setSeedState('file-2', seed);

		assert.deepStrictEqual([textOf(states.readSeedState(Y, 'file-1')), textOf(states.readSeedState(Y, 'file-2'))], ['line one\n', 'line one\n']);
	});
});
