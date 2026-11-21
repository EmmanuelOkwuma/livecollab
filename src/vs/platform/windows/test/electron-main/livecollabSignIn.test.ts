/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash, createPublicKey, randomBytes, verify } from 'crypto';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILiveCollabSignInHost, LIVECOLLAB_SIGN_IN_WAIT_MS, LiveCollabSignIn, LiveCollabSignInOutcome } from '../../electron-main/livecollabSignIn.js';

suite('LiveCollab sign-in on the website (option F): the loopback listener and the device credential', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * A fake server that checks what the real one checks: S256(verifier) against the challenge the
	 * browser was given, and each request's signature against the public key from the exchange.
	 */
	function createWorld(options: { exchange?: 'ok' | 'refuse' | 'unreachable'; mint?: 'ok' | 'ended' } = {}) {
		const opened: string[] = [];
		const posted: string[] = [];
		const logs: string[] = [];
		let stored: string | undefined;
		let publicKey: string | undefined;
		const host: ILiveCollabSignInHost = {
			endpoints: { server: 'https://server.invalid', signInPage: 'https://site.invalid/desktop', accountPage: 'https://accounts.invalid/user' },
			openExternal: url => opened.push(url),
			post: async (path, body) => {
				posted.push(path);
				const b = body as Record<string, string | number>;
				if (path === '/auth/exchange') {
					if (options.exchange === 'unreachable') {
						return undefined;
					}
					const challenge = new URL(opened[opened.length - 1]).searchParams.get('challenge');
					if (options.exchange === 'refuse' || createHash('sha256').update(String(b.verifier)).digest('base64url') !== challenge) {
						return { refused: 'wrong_verifier' };
					}
					publicKey = String(b.publicKey);
					return { credentialId: 'dc_1', credential: randomBytes(32).toString('base64url') };
				}
				const key = createPublicKey({ key: Buffer.from(publicKey!, 'base64'), format: 'der', type: 'spki' });
				const good = verify('sha256', Buffer.from(`${b.credentialId}.${b.timestamp}.${b.nonce}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(String(b.signature), 'base64'));
				if (!good) {
					return { jwt: null, reason: 'bad_signature' };
				}
				if (path === '/auth/token') {
					return options.mint === 'ended' ? { jwt: null, reason: 'session_ended' } : { jwt: 'jwt-1' };
				}
				if (path === '/auth/display-name') {
					return b.displayName === 'refused by Clerk' ? { ok: false, reason: 'clerk_failed', detail: 'form_param_missing' } : { ok: true, displayName: String(b.displayName) };
				}
				return { ok: true };
			},
			readCredential: async () => stored,
			writeCredential: async value => { stored = value; },
			log: message => logs.push(message),
		};
		return { host, opened, posted, logs, stored: () => stored };
	}

	/** The browser's side: wait for the app to open the website, then return to the loopback. */
	async function browserReturns(opened: string[], query: (site: URLSearchParams) => string, path = '/callback', method = 'GET'): Promise<{ status: number; text: string }> {
		while (!opened.length) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		const site = new URL(opened[opened.length - 1]).searchParams;
		const response = await fetch(`http://127.0.0.1:${site.get('port')}${path}?${query(site)}`, { method });
		return { status: response.status, text: await response.text() };
	}

	const goodCode = randomBytes(32).toString('base64url');
	const valid = (site: URLSearchParams) => `code=${goodCode}&state=${site.get('state')}`;

	test('the whole flow: the website is opened with challenge, state and port; the callback is exchanged; the page says so; mint signs', async () => {
		const world = createWorld();
		const signIn = new LiveCollabSignIn(world.host);
		const outcome = signIn.start();
		const page = await browserReturns(world.opened, valid);
		const site = new URL(world.opened[0]);
		assert.deepStrictEqual({
			outcome: await outcome,
			opened: `${site.origin}${site.pathname}`,
			params: [...site.searchParams.keys()].sort(),
			page: { status: page.status, said: page.text.includes('You\'re signed in.') && page.text.includes('Go back to') },
			stored: !!world.stored(),
			mint: await signIn.mint(),
			posted: world.posted,
		}, {
			outcome: { ok: true },
			opened: 'https://site.invalid/desktop',
			params: ['challenge', 'port', 'state'],
			page: { status: 200, said: true },
			stored: true,
			mint: { jwt: 'jwt-1' },
			posted: ['/auth/exchange', '/auth/token'],
		});
	});

	test('a wrong or missing state is refused before anything else is read, and the attempt carries on', async () => {
		const world = createWorld();
		const signIn = new LiveCollabSignIn(world.host);
		const outcome = signIn.start();
		const wrong = await browserReturns(world.opened, () => `code=${goodCode}&state=${randomBytes(32).toString('base64url')}`);
		const missing = await browserReturns(world.opened, () => `code=${goodCode}`);
		const postedAfterStrays = [...world.posted];
		await browserReturns(world.opened, valid);
		assert.deepStrictEqual({ wrong: wrong.status, missing: missing.status, postedAfterStrays, outcome: await outcome }, { wrong: 400, missing: 400, postedAfterStrays: [], outcome: { ok: true } });
	});

	test('only GET /callback is answered; anything else is 404 and ignored', async () => {
		const world = createWorld();
		const signIn = new LiveCollabSignIn(world.host);
		const outcome = signIn.start();
		const otherPath = await browserReturns(world.opened, valid, '/other');
		const otherMethod = await browserReturns(world.opened, valid, '/callback', 'POST');
		const postedAfter = [...world.posted];
		signIn.cancel();
		assert.deepStrictEqual({ otherPath: otherPath.status, otherMethod: otherMethod.status, postedAfter, outcome: await outcome }, { otherPath: 404, otherMethod: 404, postedAfter: [], outcome: { ok: false, reason: 'cancelled' } });
	});

	test('a malformed code is never sent to the server; the attempt ends and the page says it didn\'t finish', async () => {
		const world = createWorld();
		const signIn = new LiveCollabSignIn(world.host);
		const outcome = signIn.start();
		const page = await browserReturns(world.opened, site => `code=not-a-code&state=${site.get('state')}`);
		assert.deepStrictEqual({ outcome: await outcome, status: page.status, said: page.text.includes('Sign-in didn\'t finish.'), posted: world.posted }, { outcome: { ok: false, reason: 'refused', detail: 'bad_code' }, status: 400, said: true, posted: [] });
	});

	test('the exchange refused, or the server unreachable: the reason is returned and nothing is stored', async () => {
		const outcomes: LiveCollabSignInOutcome[] = [];
		const storedAfter: boolean[] = [];
		for (const exchange of ['refuse', 'unreachable'] as const) {
			const world = createWorld({ exchange });
			const signIn = new LiveCollabSignIn(world.host);
			const outcome = signIn.start();
			await browserReturns(world.opened, valid);
			outcomes.push(await outcome);
			storedAfter.push(!!world.stored());
		}
		assert.deepStrictEqual({ outcomes, storedAfter }, { outcomes: [{ ok: false, reason: 'refused', detail: 'wrong_verifier' }, { ok: false, reason: 'unreachable' }], storedAfter: [false, false] });
	});

	test('the app waits 10 minutes for the browser: enough for a first sign-up with the bot check and an emailed code', () => {
		// 3 minutes ran out during a real sign-up on staging (Manny, 2026-11-16).
		assert.strictEqual(LIVECOLLAB_SIGN_IN_WAIT_MS, 10 * 60 * 1000);
	});

	test('a browser that never comes back: the attempt ends as timed out and the listener is closed', async () => {
		const world = createWorld();
		const signIn = new LiveCollabSignIn(world.host, 100);
		const outcome = await signIn.start();
		const late = await browserReturns(world.opened, valid).then(() => 'answered', () => 'refused');
		assert.deepStrictEqual({ outcome, late }, { outcome: { ok: false, reason: 'timeout' }, late: 'refused' });
	});

	test('a new sign-in cancels the old attempt; the old tab\'s late callback finds no listener', async () => {
		const world = createWorld();
		const signIn = new LiveCollabSignIn(world.host);
		const first = signIn.start();
		while (!world.opened.length) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		const firstSite = world.opened[0];
		const second = signIn.start();
		const firstOutcome = await first;
		const late = await fetch(`http://127.0.0.1:${new URL(firstSite).searchParams.get('port')}/callback?${valid(new URL(firstSite).searchParams)}`).then(() => 'answered', () => 'refused');
		while (world.opened.length < 2) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		await browserReturns(world.opened, valid);
		assert.deepStrictEqual({ firstOutcome, late, second: await second }, { firstOutcome: { ok: false, reason: 'cancelled' }, late: 'refused', second: { ok: true } });
	});

	test('the listener is on 127.0.0.1 only, not on the IPv6 loopback', async () => {
		const world = createWorld();
		const signIn = new LiveCollabSignIn(world.host);
		const outcome = signIn.start();
		while (!world.opened.length) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		const site = new URL(world.opened[0]).searchParams;
		const ipv6 = await fetch(`http://[::1]:${site.get('port')}/callback?${valid(site)}`).then(() => 'answered', () => 'refused');
		signIn.cancel();
		assert.deepStrictEqual({ ipv6, outcome: await outcome }, { ipv6: 'refused', outcome: { ok: false, reason: 'cancelled' } });
	});

	test('no callback parameter reaches the log', async () => {
		const world = createWorld();
		const signIn = new LiveCollabSignIn(world.host);
		const outcome = signIn.start();
		await browserReturns(world.opened, valid);
		await outcome;
		const state = new URL(world.opened[0]).searchParams.get('state')!;
		assert.deepStrictEqual(world.logs.filter(line => line.includes(goodCode) || line.includes(state)), []);
	});

	test('an ended Clerk session at mint: the credential here is deleted and the app is signed out', async () => {
		const world = createWorld({ mint: 'ended' });
		const signIn = new LiveCollabSignIn(world.host);
		const outcome = signIn.start();
		await browserReturns(world.opened, valid);
		await outcome;
		const told: string[] = [];
		const listener = signIn.onDidSignOut(reason => told.push(reason));
		assert.deepStrictEqual({ first: await signIn.mint(), stored: world.stored(), second: await signIn.mint(), told }, { first: { jwt: null, reason: 'session_ended' }, stored: undefined, second: { jwt: null, reason: 'signed_out' }, told: ['session_ended'] });
		listener.dispose();
	});

	test('a display name set in the app goes to the server as a signed device request', async () => {
		const world = createWorld();
		const signIn = new LiveCollabSignIn(world.host);
		const before = await signIn.setDisplayName('Ada Lovelace');
		const outcome = signIn.start();
		await browserReturns(world.opened, valid);
		await outcome;
		assert.deepStrictEqual({ before, after: await signIn.setDisplayName('Ada Lovelace'), posted: world.posted }, {
			before: { ok: false, reason: 'signed_out' },
			after: { ok: true, displayName: 'Ada Lovelace' },
			posted: ['/auth/exchange', '/auth/display-name'],
		});
	});

	test('a name the server couldn\'t save comes back with the reason it gave, so the app can say what went wrong', async () => {
		const world = createWorld();
		const signIn = new LiveCollabSignIn(world.host);
		const outcome = signIn.start();
		await browserReturns(world.opened, valid);
		await outcome;
		assert.deepStrictEqual(await signIn.setDisplayName('refused by Clerk'), { ok: false, reason: 'clerk_failed', detail: 'form_param_missing' });
	});

	test('sign-out deletes the credential here whatever the server answers', async () => {
		const world = createWorld();
		const signIn = new LiveCollabSignIn(world.host);
		const outcome = signIn.start();
		await browserReturns(world.opened, valid);
		await outcome;
		const told: string[] = [];
		const listener = signIn.onDidSignOut(reason => told.push(reason));
		assert.deepStrictEqual({ out: await signIn.signOut(), stored: world.stored(), has: await signIn.hasCredential(), told }, { out: { ok: true }, stored: undefined, has: false, told: ['signed_out'] });
		listener.dispose();
	});
});
