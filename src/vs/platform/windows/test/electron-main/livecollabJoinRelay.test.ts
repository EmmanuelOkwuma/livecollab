/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILiveCollabJoin, LiveCollabJoinRelay } from '../../electron-main/livecollabJoinRelay.js';

suite('LiveCollab join relay (a room opened before the workbench listens must not be lost)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function createRelay(): { relay: LiveCollabJoinRelay; sent: string[] } {
		const sent: string[] = [];
		const relay = new LiveCollabJoinRelay((join: ILiveCollabJoin) => sent.push(join.roomId), () => { });
		return { relay, sent };
	}

	test('room clicked as the window appears, before the workbench listens: delivered when it listens (iMac, 2026-10-15)', () => {
		const { relay, sent } = createRelay();

		relay.request({ roomId: 'room-closedtab', roomName: 'closedtab-test' });
		const beforeListening = [...sent];
		relay.workbenchListening();

		assert.deepStrictEqual({ beforeListening, sent }, { beforeListening: [], sent: ['room-closedtab'] });
	});

	test('workbench already listening: sent at once, delivered once', () => {
		const { relay, sent } = createRelay();

		relay.workbenchListening();
		relay.request({ roomId: 'room-a', roomName: 'a' });
		relay.workbenchListening();

		assert.deepStrictEqual(sent, ['room-a']);
	});

	test('two early clicks: only the latest is delivered', () => {
		const { relay, sent } = createRelay();

		relay.request({ roomId: 'room-a', roomName: 'a' });
		relay.request({ roomId: 'room-b', roomName: 'b' });
		relay.workbenchListening();

		assert.deepStrictEqual(sent, ['room-b']);
	});

	test('workbench view reloads: joins are held again until it listens', () => {
		const { relay, sent } = createRelay();

		relay.workbenchListening();
		relay.workbenchUnloaded();
		relay.request({ roomId: 'room-a', roomName: 'a' });
		const whileReloading = [...sent];
		relay.workbenchListening();

		assert.deepStrictEqual({ whileReloading, sent }, { whileReloading: [], sent: ['room-a'] });
	});
});
