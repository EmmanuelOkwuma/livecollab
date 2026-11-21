/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isLiveCollabDevToolsAllowed, LIVECOLLAB_PRODUCTION_ENDPOINTS, liveCollabEndpoints, liveCollabSentryRelease } from '../../common/livecollabBuildFlavor.js';

suite('LiveCollab build flavour (DevTools and server overrides off in release builds)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('only a dev build or a run from source allows DevTools; anything else fails closed', () => {
		assert.deepStrictEqual({
			release: isLiveCollabDevToolsAllowed(true, 'release'),
			dev: isLiveCollabDevToolsAllowed(true, 'dev'),
			noFlavour: isLiveCollabDevToolsAllowed(true, undefined),
			unknownFlavour: isLiveCollabDevToolsAllowed(true, 'Dev'),
			fromSource: isLiveCollabDevToolsAllowed(false, undefined),
		}, {
			release: false,
			dev: true,
			noFlavour: false,
			unknownFlavour: false,
			fromSource: true,
		});
	});

	test('a release build ignores the server, sign-in and account overrides entirely; a dev build or a run from source honours them', () => {
		const local = { LIVECOLLAB_SERVER_URL: 'http://127.0.0.1:4100', LIVECOLLAB_SIGNIN_URL: 'http://127.0.0.1:4101/desktop', LIVECOLLAB_ACCOUNT_URL: 'http://127.0.0.1:4101/user' };
		const overridden = { server: 'http://127.0.0.1:4100', signInPage: 'http://127.0.0.1:4101/desktop', accountPage: 'http://127.0.0.1:4101/user' };
		assert.deepStrictEqual({
			release: liveCollabEndpoints(true, 'release', local),
			noFlavour: liveCollabEndpoints(true, undefined, local),
			unknownFlavour: liveCollabEndpoints(true, 'Dev', local),
			dev: liveCollabEndpoints(true, 'dev', local),
			fromSource: liveCollabEndpoints(false, undefined, local),
			nothingSet: liveCollabEndpoints(false, undefined, {}),
			notAnAddress: liveCollabEndpoints(false, undefined, { LIVECOLLAB_SERVER_URL: 'javascript:alert(1)' }).server,
		}, {
			release: LIVECOLLAB_PRODUCTION_ENDPOINTS,
			noFlavour: LIVECOLLAB_PRODUCTION_ENDPOINTS,
			unknownFlavour: LIVECOLLAB_PRODUCTION_ENDPOINTS,
			dev: overridden,
			fromSource: overridden,
			nothingSet: LIVECOLLAB_PRODUCTION_ENDPOINTS,
			notAnAddress: LIVECOLLAB_PRODUCTION_ENDPOINTS.server,
		});
	});

	test('a release build signs in on livecollab.dev and sends people to the production Account Portal, not the development instance\'s', () => {
		assert.deepStrictEqual(liveCollabEndpoints(true, 'release', {}), {
			server: 'https://live-collab-production.up.railway.app',
			signInPage: 'https://livecollab.dev/desktop',
			accountPage: 'https://accounts.livecollab.dev/user',
		});
	});

	test('Sentry\'s release names LiveCollab\'s own version from product.json, never VS Code\'s (Manny, 2026-11-18)', () => {
		assert.deepStrictEqual({
			current: liveCollabSentryRelease('0.3.6'),
			missing: liveCollabSentryRelease(undefined),
			empty: liveCollabSentryRelease(''),
		}, {
			current: 'LiveCollab@0.3.6',
			missing: 'LiveCollab@unknown',
			empty: 'LiveCollab@unknown',
		});
	});
});
