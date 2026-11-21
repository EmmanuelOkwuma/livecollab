/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventEmitter } from 'events';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILiveCollabAccount, ILiveCollabInvokeEvent, ILiveCollabIpcHandlers, ILiveCollabIpcMain, LiveCollabPageKind, LiveCollabPages, onOwnPageMessage, registerLiveCollabAccountHandlers, registerWindowNavigation } from '../../electron-main/livecollabWindowNavigation.js';

suite('LiveCollab window navigation (opening a room affects only the window where it was clicked)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** One ipcMain for the app, as in Electron; a message carries the page that sent it. */
	class FakeIpcMain implements ILiveCollabIpcMain {
		private readonly _emitter = new EventEmitter();
		on(channel: string, listener: (event: { readonly sender: unknown }, ...args: unknown[]) => void): unknown { return this._emitter.on(channel, listener); }
		removeListener(channel: string, listener: (event: { readonly sender: unknown }, ...args: unknown[]) => void): unknown { return this._emitter.removeListener(channel, listener); }
		send(sender: unknown, channel: string, ...args: unknown[]): void { this._emitter.emit(channel, { sender }, ...args); }
		listeners(channels = ['vscode:livecollab-load-workbench', 'vscode:livecollab-load-dashboard', 'vscode:livecollab-dashboard-notice']): number { return channels.reduce((sum, channel) => sum + this._emitter.listenerCount(channel), 0); }
	}

	function twoWindows(): { ipc: FakeIpcMain; pages: Record<'a' | 'b', { dashboard: object; workbench: object }>; seen: Record<'a' | 'b', string[]>; disposables: DisposableStore; credentialDeleted: Emitter<string> } {
		const ipc = new FakeIpcMain();
		const disposables = store.add(new DisposableStore());
		// The app's one sign-in: its credential is deleted once, for every window.
		const credentialDeleted = disposables.add(new Emitter<string>());
		const pages = { a: { dashboard: {}, workbench: {} }, b: { dashboard: {}, workbench: {} } };
		const seen: Record<'a' | 'b', string[]> = { a: [], b: [] };
		for (const name of ['a', 'b'] as const) {
			disposables.add(registerWindowNavigation(ipc, pages[name], {
				openRoom: (roomId, roomName) => seen[name].push(`join ${roomId} (${roomName})`),
				showDashboard: (fromWorkbench, payload) => seen[name].push(`dashboard (from workbench: ${fromWorkbench}, notice: ${JSON.stringify(payload ?? null)})`),
				showNotice: payload => {
					seen[name].push(`notice ${JSON.stringify(payload ?? null)}`);
					return (payload as { notice?: unknown } | undefined)?.notice !== 'dashboard not in front';
				},
				toWorkbench: (channel, payload) => seen[name].push(`to workbench ${channel} ${JSON.stringify(payload)}`),
				signedOut: reason => seen[name].push(`signed out (${reason})`),
			}, credentialDeleted.event));
		}
		return { ipc, pages, seen, disposables, credentialDeleted };
	}

	test('Open on window A\'s dashboard joins in A only; B gets nothing, so its room, folder, editors and unsent draft are untouched (seen 2026-11-12: both windows joined)', () => {
		const { ipc, pages, seen } = twoWindows();

		ipc.send(pages.a.dashboard, 'vscode:livecollab-load-workbench', { roomId: 'room-1', roomName: 'One' });

		assert.deepStrictEqual(seen, { a: ['join room-1 (One)'], b: [] });
	});

	test('leaving a room in window B shows B\'s dashboard only, with B\'s notice', () => {
		const { ipc, pages, seen } = twoWindows();

		ipc.send(pages.b.workbench, 'vscode:livecollab-load-dashboard', { roomId: 'room-2', notice: { kind: 'removed' } });

		assert.deepStrictEqual(seen, { a: [], b: ['dashboard (from workbench: true, notice: {"roomId":"room-2","notice":{"kind":"removed"}})'] });
	});

	test('a notice for the dashboard alone (folders closed by a leave, after the dashboard is shown) is taken from the window\'s own workbench only: not from its dashboard, another window\'s pages or a stranger', () => {
		const { ipc, pages, seen, disposables } = twoWindows();

		ipc.send(pages.b.workbench, 'vscode:livecollab-dashboard-notice', { roomId: 'room-5', notice: 'closed', id: 1 });
		ipc.send(pages.b.workbench, 'vscode:livecollab-dashboard-notice', { roomId: 'room-5', notice: 'dashboard not in front', id: 2 });
		ipc.send(pages.a.dashboard, 'vscode:livecollab-dashboard-notice', { roomId: 'room-6', notice: 'from a dashboard' });
		ipc.send({}, 'vscode:livecollab-dashboard-notice', { roomId: 'room-7', notice: 'from a stranger' });
		disposables.dispose();
		ipc.send(pages.a.workbench, 'vscode:livecollab-dashboard-notice', { roomId: 'room-8', notice: 'after closing' });

		// The workbench is told whether it showed, so it can say it itself when it didn't.
		assert.deepStrictEqual({ seen, listeners: ipc.listeners() }, {
			seen: {
				a: [],
				b: [
					'notice {"roomId":"room-5","notice":"closed","id":1}',
					'to workbench vscode:livecollab-dashboard-notice-result {"id":1,"delivered":true}',
					'notice {"roomId":"room-5","notice":"dashboard not in front","id":2}',
					'to workbench vscode:livecollab-dashboard-notice-result {"id":2,"delivered":false}',
				],
			},
			listeners: 0,
		});
	});

	test('a page that is neither window\'s is ignored; a closed window stops listening', () => {
		const { ipc, pages, seen, disposables } = twoWindows();

		ipc.send({}, 'vscode:livecollab-load-workbench', { roomId: 'room-3', roomName: 'Three' });
		ipc.send({}, 'vscode:livecollab-load-dashboard');
		disposables.dispose();
		ipc.send(pages.a.dashboard, 'vscode:livecollab-load-workbench', { roomId: 'room-4', roomName: 'Four' });

		assert.deepStrictEqual({ seen, listeners: ipc.listeners() }, { seen: { a: [], b: [] }, listeners: 0 });
	});

	test('Sign Out on window A\'s dashboard signs out window B too: both close their connections and show the signed-out dashboard (WEBSITE_SIGNIN_DESIGN, "Sign-out across the windows of one app")', () => {
		const { ipc, pages, seen, credentialDeleted } = twoWindows();

		// What A's Sign Out does: main deletes the credential, and A's page says it signed out.
		credentialDeleted.fire('signed_out');
		ipc.send(pages.a.dashboard, 'vscode:livecollab-signed-out');

		assert.deepStrictEqual(seen, { a: ['signed out (signed_out)'], b: ['signed out (signed_out)'] });
	});

	test('a session the server ended (found by any window\'s mint) signs out every window, with the reason; a page\'s own message signs out nothing', () => {
		const { ipc, pages, seen, credentialDeleted } = twoWindows();

		ipc.send(pages.b.workbench, 'vscode:livecollab-signed-out');
		ipc.send(pages.b.dashboard, 'vscode:livecollab-signed-out');
		const byPages = JSON.parse(JSON.stringify(seen));
		credentialDeleted.fire('session_ended');

		assert.deepStrictEqual({ byPages, seen }, { byPages: { a: [], b: [] }, seen: { a: ['signed out (session_ended)'], b: ['signed out (session_ended)'] } });
	});

	test('window A\'s room-ready or first paint never acts on window B; a closed window\'s listeners are removed', () => {
		const { ipc, pages, disposables } = twoWindows();
		const seen: string[] = [];
		for (const name of ['a', 'b'] as const) {
			const own = (sender: unknown) => sender === pages[name].dashboard || sender === pages[name].workbench;
			disposables.add(onOwnPageMessage(ipc, 'vscode:livecollab-room-ready', own, () => seen.push(`${name} brought its workbench forward`)));
			disposables.add(onOwnPageMessage(ipc, 'vscode:livecollab-ready', own, () => seen.push(`${name} shown`), true));
		}

		ipc.send(pages.a.workbench, 'vscode:livecollab-room-ready');
		ipc.send(pages.a.dashboard, 'vscode:livecollab-ready');
		ipc.send(pages.a.dashboard, 'vscode:livecollab-ready');
		const listenersOpen = ipc.listeners(['vscode:livecollab-room-ready', 'vscode:livecollab-ready']);
		disposables.dispose();

		assert.deepStrictEqual({ seen, listenersOpen, listenersClosed: ipc.listeners(['vscode:livecollab-room-ready', 'vscode:livecollab-ready']) },
			{ seen: ['a brought its workbench forward', 'a shown'], listenersOpen: 3, listenersClosed: 0 });
	});

});

suite('LiveCollab account handlers (only the top frame of an open window\'s own pages may call them)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** ipcMain's handle(): one handler per channel for the whole app, as in Electron. */
	class FakeIpcHandlers implements ILiveCollabIpcHandlers {
		private readonly _handlers = new Map<string, (event: ILiveCollabInvokeEvent, ...args: unknown[]) => unknown>();
		handle(channel: string, handler: (event: ILiveCollabInvokeEvent, ...args: unknown[]) => unknown): void {
			if (this._handlers.has(channel)) {
				throw new Error(`Attempted to register a second handler for '${channel}'`);
			}
			this._handlers.set(channel, handler);
		}
		removeHandler(channel: string): void { this._handlers.delete(channel); }
		invoke(sender: unknown, senderFrame: ILiveCollabInvokeEvent['senderFrame'], channel: string, ...args: unknown[]): unknown { return this._handlers.get(channel)?.({ sender, senderFrame }, ...args); }
		get size(): number { return this._handlers.size; }
	}

	const APP_PAGE = 'vscode-file://vscode-app/out/vs/code/electron-browser/workbench/livecollab-bootstrap.html';
	const topFrame = (url = APP_PAGE) => ({ parent: null, url });
	const childFrame = { parent: {}, url: APP_PAGE };

	/** Every handler, what it's called with, and the pages of ours that call it. */
	const CALLS: [channel: string, args: unknown[], callers: LiveCollabPageKind[]][] = [
		['vscode:livecollab-start-auth', [], ['dashboard']],
		['vscode:livecollab-cancel-auth', [], ['dashboard']],
		['vscode:livecollab-mint-token', [], ['dashboard', 'workbench', 'hidden']],
		['vscode:livecollab-server-url', [], ['dashboard', 'workbench', 'hidden']],
		['vscode:livecollab-client-version', [], ['dashboard', 'hidden']],
		['vscode:livecollab-check-session', [], ['dashboard', 'hidden']],
		['vscode:livecollab-logout', [], ['dashboard']],
		['vscode:livecollab-set-display-name', ['Ada'], ['dashboard']],
		['vscode:livecollab-open-account', [], ['dashboard']],
	];

	function setUp() {
		const ipc = new FakeIpcHandlers();
		const pages = new LiveCollabPages();
		const calls: string[] = [];
		const account: ILiveCollabAccount = {
			get server() { calls.push('server'); return 'https://server.example'; },
			start: async () => { calls.push('start'); return { ok: true }; },
			cancel: () => { calls.push('cancel'); },
			mint: async () => { calls.push('mint'); return { jwt: 'session-token' }; },
			session: async () => { calls.push('session'); return { userId: 'user-1' }; },
			signOut: async () => { calls.push('signOut'); return { ok: true }; },
			onDidSignOut: Event.None,
			setDisplayName: async name => { calls.push(`setDisplayName ${name}`); return { ok: true }; },
			openAccountPage: () => { calls.push('openAccountPage'); },
		};
		/** A window's dashboard view, its workbench view and its own (hidden) page, which loads the dashboard too. */
		const openWindow = () => {
			const window = { dashboard: {}, workbench: {}, own: {} };
			const close = new DisposableStore();
			close.add(pages.add(window.dashboard, 'dashboard'));
			close.add(pages.add(window.workbench, 'workbench'));
			close.add(pages.add(window.own, 'hidden'));
			return { ...window, close };
		};
		const log = { info: () => { }, error: () => { } };
		return { ipc, pages, calls, account, openWindow, log };
	}

	test('open A, open B, close B: every handler still works from each of A\'s pages that calls it (they hold nothing of the window that registered them)', async () => {
		const { ipc, pages, calls, account, openWindow, log } = setUp();
		const a = openWindow();
		store.add(a.close);
		const handlers = store.add(registerLiveCollabAccountHandlers(ipc, pages, account, '0.3.6', log));
		const b = openWindow();
		b.close.dispose();

		const results: Record<string, unknown[]> = {};
		for (const [channel, args, callers] of CALLS) {
			const senders = callers.map(kind => kind === 'dashboard' ? a.dashboard : kind === 'hidden' ? a.own : a.workbench);
			results[channel] = await Promise.all(senders.map(sender => ipc.invoke(sender, topFrame(), channel, ...args)));
		}
		handlers.dispose();

		assert.deepStrictEqual({ calls, results, handlersAfterDispose: ipc.size }, {
			calls: ['start', 'cancel', 'mint', 'mint', 'mint', 'server', 'server', 'server', 'session', 'session', 'signOut', 'setDisplayName Ada', 'openAccountPage'],
			results: {
				'vscode:livecollab-start-auth': [{ ok: true }],
				'vscode:livecollab-cancel-auth': [undefined],
				'vscode:livecollab-mint-token': [{ jwt: 'session-token' }, { jwt: 'session-token' }, { jwt: 'session-token' }],
				'vscode:livecollab-server-url': ['https://server.example', 'https://server.example', 'https://server.example'],
				'vscode:livecollab-client-version': ['0.3.6', '0.3.6'],
				'vscode:livecollab-check-session': [{ userId: 'user-1' }, { userId: 'user-1' }],
				'vscode:livecollab-logout': [{ ok: true }],
				'vscode:livecollab-set-display-name': [{ ok: true }],
				'vscode:livecollab-open-account': [undefined],
			},
			handlersAfterDispose: 0,
		});
	});

	test('the window\'s hidden page (its own page, loading the dashboard, never shown) may only read: check the session, mint, the server and the version (all it calls, seen in the dev app 2026-11-13); signing in, cancelling, signing out, the display name and the account page are refused and do nothing', async () => {
		const { ipc, pages, calls, account, openWindow, log } = setUp();
		const a = openWindow();
		store.add(a.close);
		store.add(registerLiveCollabAccountHandlers(ipc, pages, account, '0.3.6', log));

		const results: Record<string, unknown> = {};
		for (const [channel, args] of CALLS) {
			results[channel.replace('vscode:livecollab-', '')] = await ipc.invoke(a.own, topFrame(), channel, ...args) ?? null;
		}

		assert.deepStrictEqual({ calls, results }, {
			calls: ['mint', 'server', 'session'],
			results: {
				'start-auth': { ok: false, reason: 'refused' },
				'cancel-auth': null,
				'mint-token': { jwt: 'session-token' },
				'server-url': 'https://server.example',
				'client-version': '0.3.6',
				'check-session': { userId: 'user-1' },
				'logout': { ok: false },
				'set-display-name': { ok: false, reason: 'refused' },
				'open-account': null,
			},
		});
	});

	test('refused, doing nothing and returning no token: a page that isn\'t ours, a child frame inside an open window, a closed window, a page navigated away from the app, a frame that is gone, and our page that doesn\'t call it', async () => {
		const { ipc, pages, calls, account, openWindow, log } = setUp();
		const a = openWindow();
		store.add(a.close);
		const closed = openWindow();
		store.add(registerLiveCollabAccountHandlers(ipc, pages, account, '0.3.6', log));
		closed.close.dispose();

		const results: Record<string, unknown[]> = {};
		for (const [channel, args, callers] of CALLS) {
			const own = callers.includes('workbench') ? a.workbench : a.dashboard;
			const attempts: [sender: unknown, frame: ILiveCollabInvokeEvent['senderFrame']][] = [
				[{}, topFrame()],
				[own, childFrame],
				[closed.dashboard, topFrame()],
				[closed.workbench, topFrame()],
				[own, topFrame('https://example.com/')],
				[own, null],
			];
			if (!callers.includes('workbench')) {
				attempts.push([a.workbench, topFrame()]);
			}
			results[channel] = [...new Set((await Promise.all(attempts.map(([sender, frame]) => ipc.invoke(sender, frame, channel, ...args)))).map(result => JSON.stringify(result ?? null)))];
		}

		assert.deepStrictEqual({ calls, results }, {
			calls: [],
			results: {
				'vscode:livecollab-start-auth': ['{"ok":false,"reason":"refused"}'],
				'vscode:livecollab-cancel-auth': ['null'],
				'vscode:livecollab-mint-token': ['{"jwt":null,"error":"refused"}'],
				'vscode:livecollab-server-url': ['null'],
				'vscode:livecollab-client-version': ['null'],
				'vscode:livecollab-check-session': ['null'],
				'vscode:livecollab-logout': ['{"ok":false}'],
				'vscode:livecollab-set-display-name': ['{"ok":false,"reason":"refused"}'],
				'vscode:livecollab-open-account': ['null'],
			},
		});
	});
});
