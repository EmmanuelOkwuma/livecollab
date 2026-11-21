/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from 'crypto';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { Emitter, Event } from '../../../base/common/event.js';

/**
 * Where sign-in goes. Production values are the defaults; a development run (not a built app)
 * may point them elsewhere through the environment.
 */
export interface ILiveCollabAuthEndpoints {
	/** The LiveCollab server: /auth/exchange, /auth/token, /auth/session, /auth/logout. */
	readonly server: string;
	/** The website's sign-in page; the attempt's challenge, state and port are added to it. */
	readonly signInPage: string;
	/** Clerk's hosted Account Portal profile page. */
	readonly accountPage: string;
}

/**
 * The device credential, as kept on this device (encrypted by the caller with safeStorage).
 */
interface IStoredDeviceCredential {
	readonly credentialId: string;
	readonly credential: string;
	/** The device's P-256 private key, PKCS#8 DER, base64. Never leaves main. */
	readonly privateKey: string;
}

/**
 * How a sign-in attempt ended, in words the app can show.
 */
export type LiveCollabSignInOutcome =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: 'timeout' | 'cancelled' | 'refused' | 'unreachable' | 'listenFailed'; readonly detail?: string };

/**
 * What the sign-in needs from its surroundings. Injected so the tests can drive it.
 */
export interface ILiveCollabSignInHost {
	readonly endpoints: ILiveCollabAuthEndpoints;
	openExternal(url: string): void;
	/** POSTs JSON to the server; undefined when the server can't be reached or answers non-JSON. */
	post(path: string, body: object): Promise<Record<string, unknown> | undefined>;
	readCredential(): Promise<string | undefined>;
	writeCredential(value: string | undefined): Promise<void>;
	log(message: string): void;
}

/** How long a sign-in waits for the browser to come back: long enough for a first sign-up with its emailed code. */
export const LIVECOLLAB_SIGN_IN_WAIT_MS = 10 * 60 * 1000;
const RANDOM_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function randomToken(): string {
	return randomBytes(32).toString('base64url');
}

function sameText(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

interface IAttempt {
	readonly state: string;
	readonly verifier: string;
	readonly server: Server;
	readonly finish: (outcome: LiveCollabSignInOutcome) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Option F's app half (WEBSITE_SIGNIN_DESIGN.md): sign-in happens on the website in the system
 * browser, which sends a one-time code back to a loopback listener (RFC 8252, with PKCE). The code
 * is exchanged with our server for a device credential bound to a key pair made here; the
 * credential is then swapped for Clerk session tokens. Nothing about the credential reaches a
 * renderer: renderers ask main to mint, check or sign out.
 *
 * The listener's requirements, each tested: bound to 127.0.0.1 on this attempt's port only;
 * `state` compared in constant time before any other parameter is read, a mismatch answered 400
 * without ending the attempt; only GET /callback; `code` format-checked and sent only to the
 * server; no callback parameter logged; one attempt at a time, a new one cancelling the old;
 * closed after a valid callback, a cancel, or 10 minutes.
 */
export class LiveCollabSignIn {

	private readonly _onDidSignOut = new Emitter<string>();
	/** The device credential was deleted: Sign Out, or the server said the session ended. Carries the reason. */
	readonly onDidSignOut: Event<string> = this._onDidSignOut.event;
	private _attempt: IAttempt | undefined;
	private _stored: IStoredDeviceCredential | null | undefined; // undefined: not read yet

	constructor(
		private readonly _host: ILiveCollabSignInHost,
		private readonly _timeoutMs = LIVECOLLAB_SIGN_IN_WAIT_MS,
	) { }

	/** The server this sign-in talks to, which is also the one the app connects to. */
	get server(): string {
		return this._host.endpoints.server;
	}

	/**
	 * Opens the website and waits for it to send the browser back. Resolves when the attempt ends,
	 * however it ends; a credential is stored only when the exchange succeeded.
	 */
	async start(): Promise<LiveCollabSignInOutcome> {
		this.cancel();
		// Loaded here, not at startup (http is slow to load).
		const { createServer } = await import('http');
		this.cancel();
		const verifier = randomToken();
		const challenge = createHash('sha256').update(verifier).digest('base64url');
		const state = randomToken();
		return new Promise<LiveCollabSignInOutcome>(resolve => {
			const server = createServer((req, res) => this._onRequest(req, res));
			let done = false;
			const finish = (outcome: LiveCollabSignInOutcome) => {
				if (done) {
					return;
				}
				done = true;
				clearTimeout(timer);
				if (this._attempt?.server === server) {
					this._attempt = undefined;
				}
				server.close();
				server.closeAllConnections?.();
				this._host.log(`[LiveCollab] sign-in: ${outcome.ok ? 'signed in' : `ended (${outcome.reason})`}`);
				resolve(outcome);
			};
			const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), this._timeoutMs);
			this._attempt = { state, verifier, server, finish, timer };
			server.on('error', error => finish({ ok: false, reason: 'listenFailed', detail: String(error) }));
			server.listen(0, '127.0.0.1', () => {
				const port = (server.address() as AddressInfo).port;
				const url = new URL(this._host.endpoints.signInPage);
				url.searchParams.set('challenge', challenge);
				url.searchParams.set('state', state);
				url.searchParams.set('port', String(port));
				this._host.log(`[LiveCollab] sign-in: waiting for the browser (port ${port})`);
				this._host.openExternal(url.toString());
			});
		});
	}

	/**
	 * Ends the attempt in progress, if any. Its listener closes, so a late callback finds nothing.
	 */
	cancel(): void {
		this._attempt?.finish({ ok: false, reason: 'cancelled' });
	}

	private async _onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const attempt = this._attempt;
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		if (!attempt || req.method !== 'GET' || url.pathname !== '/callback') {
			res.writeHead(404).end();
			return;
		}
		// state first, and nothing else read on a mismatch; a stray request mustn't end the attempt.
		const state = url.searchParams.get('state') ?? '';
		if (!sameText(state, attempt.state)) {
			res.writeHead(400).end();
			return;
		}
		const code = url.searchParams.get('code') ?? '';
		if (!RANDOM_TOKEN.test(code)) {
			this._returnPage(res, false);
			attempt.finish({ ok: false, reason: 'refused', detail: 'bad_code' });
			return;
		}
		const outcome = await this._exchange(code, attempt.verifier);
		this._returnPage(res, outcome.ok);
		attempt.finish(outcome);
	}

	private async _exchange(code: string, verifier: string): Promise<LiveCollabSignInOutcome> {
		const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
		const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
		const answer = await this._host.post('/auth/exchange', { code, verifier, publicKey });
		if (!answer) {
			return { ok: false, reason: 'unreachable' };
		}
		if (typeof answer.credentialId !== 'string' || typeof answer.credential !== 'string') {
			return { ok: false, reason: 'refused', detail: typeof answer.refused === 'string' ? answer.refused : undefined };
		}
		const stored: IStoredDeviceCredential = {
			credentialId: answer.credentialId,
			credential: answer.credential,
			privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
		};
		await this._host.writeCredential(JSON.stringify(stored));
		this._stored = stored;
		return { ok: true };
	}

	/**
	 * The page the browser lands on: says what happened and where to go next, in the site's look.
	 */
	private _returnPage(res: ServerResponse, ok: boolean): void {
		const title = ok ? 'You\'re signed in.' : 'Sign-in didn\'t finish.';
		const line = ok ? 'Go back to LiveCollab to continue. You can close this tab.' : 'Go back to LiveCollab and choose Sign In to try again. You can close this tab.';
		res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': 'default-src \'none\'; style-src \'unsafe-inline\'' });
		// The site's look (livecollab.dev): warm charcoal, system type; a green or amber dot says which outcome.
		res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LiveCollab</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;background:#181715;color:#f1eee8;font:16px/1.55 system-ui,sans-serif;padding:16px}strong{font-size:20px;letter-spacing:-.045em}main{width:100%;max-width:440px;background:#22201e;border:1px solid #474039;border-radius:12px;padding:28px;box-shadow:0 22px 60px #0004}h1{font-size:31px;line-height:1.1;letter-spacing:-.055em;font-weight:650;margin:0 0 12px}h1::before{content:"";display:inline-block;width:9px;height:9px;border-radius:50%;background:${ok ? '#a9c9ad' : '#e5ae84'};margin-right:12px;vertical-align:.18em}p{color:#b5afa5;margin:0}b{color:#f1eee8;font-weight:650}@media(max-width:540px){h1{font-size:26px}main{padding:22px}}</style></head><body><strong>LiveCollab</strong><main><h1>${title}</h1><p>${line.replace('LiveCollab', '<b>LiveCollab</b>')}</p></main></body></html>`);
	}

	/**
	 * Whether this device holds a credential (it may still be refused at the next mint).
	 */
	async hasCredential(): Promise<boolean> {
		return !!(await this._credential());
	}

	/**
	 * A Clerk session token for the socket. A credential the server no longer knows is deleted
	 * here, and the reason returned, so the app can say why it signed out.
	 */
	async mint(): Promise<{ jwt: string | null; reason?: string }> {
		const answer = await this._signedPost('/auth/token');
		if (answer === 'signedOut') {
			return { jwt: null, reason: 'signed_out' };
		}
		if (!answer) {
			return { jwt: null, reason: 'unreachable' };
		}
		if (typeof answer.jwt === 'string' && answer.jwt) {
			return { jwt: answer.jwt };
		}
		const reason = typeof answer.reason === 'string' ? answer.reason : 'refused';
		await this._forgetIfGone(reason);
		return { jwt: null, reason };
	}

	/**
	 * Who is signed in, read fresh from our server (which reads Clerk).
	 */
	async session(): Promise<Record<string, unknown> | null> {
		const answer = await this._signedPost('/auth/session');
		if (!answer || answer === 'signedOut') {
			return null;
		}
		if (typeof answer.refused === 'string') {
			await this._forgetIfGone(answer.refused);
			return null;
		}
		return answer;
	}

	/**
	 * Sign-out on this device: the server revokes its session and deletes the credential; the copy
	 * here is deleted whatever the server answers.
	 */
	async signOut(): Promise<{ ok: boolean }> {
		const answer = await this._signedPost('/auth/logout');
		await this._forget('signed_out');
		return { ok: !!(answer && answer !== 'signedOut' && answer.ok) };
	}

	/**
	 * The display name set in the app's settings: LiveCollab's own field, which the server saves
	 * and tells every room the person is in. Clerk's own name for the account is left alone.
	 * A refusal carries the server's reason, and its detail when it gave one.
	 */
	async setDisplayName(name: string): Promise<{ ok: boolean; displayName?: string; reason?: string; detail?: string }> {
		const answer = await this._signedPost('/auth/display-name', { displayName: name });
		if (answer === 'signedOut') {
			return { ok: false, reason: 'signed_out' };
		}
		if (!answer) {
			return { ok: false, reason: 'unreachable' };
		}
		if (answer.ok === true && typeof answer.displayName === 'string') {
			return { ok: true, displayName: answer.displayName };
		}
		const reason = typeof answer.reason === 'string' ? answer.reason : 'refused';
		await this._forgetIfGone(reason);
		return typeof answer.detail === 'string' ? { ok: false, reason, detail: answer.detail.slice(0, 100) } : { ok: false, reason };
	}

	/**
	 * Clerk's Account Portal, in the browser: password, email addresses, connected accounts,
	 * two-factor, active sessions, deleting the account. The things LiveCollab doesn't own.
	 */
	openAccountPage(): void {
		this._host.openExternal(this._host.endpoints.accountPage);
	}

	private async _forgetIfGone(reason: string): Promise<void> {
		if (reason === 'session_ended' || reason === 'unknown_credential') {
			await this._forget(reason);
		}
	}

	/** Deletes the credential, and tells every window (`onDidSignOut`). */
	private async _forget(reason: string): Promise<void> {
		this._stored = null;
		await this._host.writeCredential(undefined);
		this._onDidSignOut.fire(reason);
	}

	private async _credential(): Promise<IStoredDeviceCredential | null> {
		if (this._stored === undefined) {
			try {
				const raw = await this._host.readCredential();
				const parsed = raw ? JSON.parse(raw) as Partial<IStoredDeviceCredential> : undefined;
				this._stored = parsed && typeof parsed.credentialId === 'string' && typeof parsed.credential === 'string' && typeof parsed.privateKey === 'string'
					? { credentialId: parsed.credentialId, credential: parsed.credential, privateKey: parsed.privateKey }
					: null;
			} catch {
				this._stored = null;
			}
		}
		return this._stored;
	}

	private async _signedPost(path: string, extra: Record<string, string> = {}): Promise<Record<string, unknown> | undefined | 'signedOut'> {
		const stored = await this._credential();
		if (!stored) {
			return 'signedOut';
		}
		const timestamp = Date.now();
		const nonce = randomBytes(16).toString('base64url');
		const key = createPrivateKey({ key: Buffer.from(stored.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
		const signature = sign('sha256', Buffer.from(`${stored.credentialId}.${timestamp}.${nonce}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
		return this._host.post(path, { ...extra, credentialId: stored.credentialId, credential: stored.credential, timestamp, nonce, signature });
	}
}
