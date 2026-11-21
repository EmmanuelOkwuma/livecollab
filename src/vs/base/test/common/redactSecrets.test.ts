/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { redactSecrets, sentryBreadcrumb } from '../../common/redactSecrets.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from './utils.js';

suite('redactSecrets', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// Fake values, assembled at runtime so this file holds no static
	// key-shaped string for a secret scanner to flag.
	const jwt = 'eyJ' + 'hbGciOiJSUzI1NiJ9' + '.' + 'eyJzdWIiOiJ1c2VyXzEifQ' + '.' + 'c2lnbmF0dXJl';
	const secretKey = 'sk' + '_test_' + 'FAKEFAKE1234567890';
	const devBrowser = 'dv' + 'b_' + 'FAKE3Bc9xYz';

	test('redacts token-shaped strings at any depth and leaves everything else alone', () => {
		const error = new Error(`mint failed for ${jwt}`);
		const input = {
			message: '[MINT-DIAG] server response: ' + JSON.stringify({ jwt }),
			category: 'console',
			level: 'log',
			data: {
				arguments: [
					'[LiveCollab] Clerk session received:',
					`http://localhost/clerk-callback?__clerk_db_jwt=${devBrowser}&__clerk_handshake=${jwt}`,
					error,
				],
				env: `CLERK_SECRET_KEY=${secretKey}`,
				deepLink: `livecollab://reset-password?token=abc123&session=sess_42#x`,
				bareToken: devBrowser,
				count: 3,
				ok: true,
				nothing: null,
			},
			plain: 'room-8357de49 joined; exit code=0; tokenHash column',
		};

		const output = redactSecrets(input);

		assert.deepStrictEqual({ output, inputUnchanged: input.data.bareToken === devBrowser }, {
			output: {
				message: '[MINT-DIAG] server response: {"jwt":"[redacted-jwt]"}',
				category: 'console',
				level: 'log',
				data: {
					arguments: [
						'[LiveCollab] Clerk session received:',
						'http://localhost/clerk-callback?__clerk_db_jwt=[redacted]&__clerk_handshake=[redacted]',
						{ name: 'Error', message: 'mint failed for [redacted-jwt]', stack: output.data.arguments[2] && (output.data.arguments[2] as { stack?: string }).stack },
					],
					env: 'CLERK_SECRET_KEY=sk_test_[redacted]',
					deepLink: 'livecollab://reset-password?token=[redacted]&session=[redacted]#x',
					bareToken: 'dvb_[redacted]',
					count: 3,
					ok: true,
					nothing: null,
				},
				plain: 'room-8357de49 joined; exit code=0; tokenHash column',
			},
			inputUnchanged: true,
		});
		assert.ok(!JSON.stringify(output).includes(jwt.slice(0, 20)), 'no JWT survives anywhere, including the stack');
	});

	test('Sentry: console breadcrumbs are dropped (log lines carry room paths and ids); others keep, without the user\'s home folder name', () => {
		assert.deepStrictEqual({
			console: sentryBreadcrumb({ category: 'console', message: '[LiveCollab] apply rename failed for linked/greet.ts -> greet.ts' }),
			navigation: sentryBreadcrumb({ category: 'navigation', data: { from: 'file:///Users/ada/Library/x.html', to: 'C:\\Users\\ada\\AppData\\y.html' } }),
			event: redactSecrets({ exception: { values: [{ stacktrace: { frames: [{ filename: '/Users/ada/.livecollab-shared/a.js' }, { filename: '/home/ada/b.js' }] } }] } }),
		}, {
			console: null,
			navigation: { category: 'navigation', data: { from: 'file:///Users/[user]/Library/x.html', to: 'C:\\Users\\[user]\\AppData\\y.html' } },
			event: { exception: { values: [{ stacktrace: { frames: [{ filename: '/Users/[user]/.livecollab-shared/a.js' }, { filename: '/home/[user]/b.js' }] } }] } },
		});
	});
});
