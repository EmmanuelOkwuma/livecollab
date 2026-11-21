/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILiveCollabHandshake, ILiveCollabSocket, LiveCollabService, LiveCollabSocketFactory } from '../../browser/livecollabService.js';
import { lcLog } from '../../browser/livecollabLog.js';
import product from '../../../../../platform/product/common/product.js';

suite('LiveCollab service (constructible, for the layer B harness)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** A socket that records nothing and never connects. */
	class FakeSocket implements ILiveCollabSocket {
		readonly connected = false;
		readonly id = undefined;
		emit(): void { }
		on(): void { }
		disconnect(): void { }
	}

	test('two services in one process each open their own socket to their own server', async () => {
		const opened: string[] = [];
		const open: LiveCollabSocketFactory = async url => { opened.push(url); return new FakeSocket(); };
		const a = store.add(new LiveCollabService('http://127.0.0.1:4001', open));
		const b = store.add(new LiveCollabService('http://127.0.0.1:4002', open));
		// A token with an empty payload ({} is e30 in base64).
		a.setToken('x.e30.y');
		b.setToken('x.e30.y');
		await a.connect();
		await b.connect();
		assert.deepStrictEqual(opened, ['http://127.0.0.1:4001', 'http://127.0.0.1:4002']);
	});

	test('the handshake carries LiveCollab\'s version (product.json by default), so the server can tell which builds are connected', async () => {
		const sent: ILiveCollabHandshake[] = [];
		const open: LiveCollabSocketFactory = async (_url, options) => {
			options.auth(data => sent.push(data));
			return new FakeSocket();
		};
		const given = store.add(new LiveCollabService('http://127.0.0.1:4001', open, '9.9.9'));
		const fromProduct = store.add(new LiveCollabService('http://127.0.0.1:4002', open));
		given.setToken('x.e30.y');
		fromProduct.setToken('x.e30.y');
		await given.connect();
		await fromProduct.connect();
		// The auth callback answers after a token refresh, which asks the main process first.
		for (let waited = 0; sent.length < 2 && waited < 2000; waited += 10) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		assert.deepStrictEqual(sent, [{ token: 'x.e30.y', clientVersion: '9.9.9' }, { token: 'x.e30.y', clientVersion: product.livecollabVersion }]);
	});

	test('a connection that couldn\'t be opened (its socket library failed to load) is reported, and the next attempt opens one', async () => {
		const attempts: string[] = [];
		let fail = true;
		const open: LiveCollabSocketFactory = async url => {
			attempts.push(url);
			if (fail) {
				throw new Error('Failed to fetch dynamically imported module');
			}
			return new FakeSocket();
		};
		const logged: string[] = [];
		const echo = lcLog.echoTo({ info: () => { }, warn: line => logged.push(line), error: line => logged.push(line) });
		const service = store.add(new LiveCollabService('http://127.0.0.1:4001', open));
		service.setToken('x.e30.y');
		const first = await service.connect().then(() => 'opened', (error: Error) => error.message);
		fail = false;
		await service.connect();
		echo.dispose();
		assert.deepStrictEqual({ first, logged, attempts }, {
			first: 'Failed to fetch dynamically imported module',
			logged: ['[LiveCollab] the room connection couldn\'t be opened: Failed to fetch dynamically imported module'],
			attempts: ['http://127.0.0.1:4001', 'http://127.0.0.1:4001'],
		});
	});
});
