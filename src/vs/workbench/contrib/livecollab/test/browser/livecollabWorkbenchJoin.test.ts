/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILiveCollabJoinTarget, LiveCollabWorkbenchJoin } from '../../browser/livecollabWorkbenchJoin.js';

suite('LiveCollab workbench join (a failed startup sign-in must not kill joins)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** A server connection that succeeds or fails per attempt, in order. */
	class FakeTarget implements ILiveCollabJoinTarget {
		connected = false;
		connectCalls = 0;
		readonly joined: string[] = [];
		constructor(private readonly _outcomes: (boolean | DeferredPromise<boolean>)[]) { }
		isConnected(): boolean { return this.connected; }
		async connect(): Promise<boolean> {
			const outcome = this._outcomes[this.connectCalls++] ?? false;
			this.connected = typeof outcome === 'boolean' ? outcome : await outcome.p;
			return this.connected;
		}
		async join(roomId: string): Promise<void> { this.joined.push(roomId); }
	}

	test('startup sign-in fails, then a room is opened: it connects then and joins (iMac guest, 2026-10-14)', async () => {
		const target = new FakeTarget([false, true]);
		const join = new LiveCollabWorkbenchJoin(target);

		await join.start();
		const result = await join.join('room-closedtab', 'closedtab-test');

		assert.deepStrictEqual({ result, connectCalls: target.connectCalls, joined: target.joined }, { result: 'joined', connectCalls: 2, joined: ['room-closedtab'] });
	});

	test('one connection attempt per join, never a loop, and a failure is reported', async () => {
		const target = new FakeTarget([false, false, false]);
		const join = new LiveCollabWorkbenchJoin(target);

		await join.start();
		const first = await join.join('room-a', undefined);
		const second = await join.join('room-a', undefined);

		assert.deepStrictEqual({ first, second, connectCalls: target.connectCalls, joined: target.joined }, { first: 'notConnected', second: 'notConnected', connectCalls: 3, joined: [] });
	});

	test('already connected: joins without another sign-in', async () => {
		const target = new FakeTarget([true]);
		const join = new LiveCollabWorkbenchJoin(target);

		await join.start();
		const result = await join.join('room-a', undefined);

		assert.deepStrictEqual({ result, connectCalls: target.connectCalls, joined: target.joined }, { result: 'joined', connectCalls: 1, joined: ['room-a'] });
	});

	test('a room opened while startup is still connecting shares that attempt', async () => {
		const startup = new DeferredPromise<boolean>();
		const target = new FakeTarget([startup]);
		const join = new LiveCollabWorkbenchJoin(target);

		const started = join.start();
		const joining = join.join('room-a', undefined);
		startup.complete(true);
		await started;
		const result = await joining;

		assert.deepStrictEqual({ result, connectCalls: target.connectCalls, joined: target.joined }, { result: 'joined', connectCalls: 1, joined: ['room-a'] });
	});
});
