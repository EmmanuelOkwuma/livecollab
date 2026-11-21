/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { Event } from '../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { Schemas, VSCODE_AUTHORITY } from '../../../base/common/network.js';
import { ILiveCollabFolderClaims, ILiveCollabKnownFolder } from '../common/livecollabFolderClaims.js';

/** The part of Electron's ipcMain the window's room navigation uses. */
export interface ILiveCollabIpcMain {
	on(channel: string, listener: (event: { readonly sender: unknown }, ...args: unknown[]) => void): unknown;
	removeListener(channel: string, listener: (event: { readonly sender: unknown }, ...args: unknown[]) => void): unknown;
}

/** One window's two pages, as ipcMain names them in `event.sender`. */
export interface ILiveCollabWindowPages {
	readonly dashboard: unknown;
	readonly workbench: unknown;
}

/** What a window does when one of its own pages asks to change view. */
export interface ILiveCollabWindowNavigationTarget {
	/** The dashboard opened a room: hand it to this window's workbench. */
	openRoom(roomId: string, roomName: string): void;
	/** The workbench left its room: show this window's dashboard. `payload` is the workbench's notice, if any. */
	showDashboard(fromWorkbench: boolean, payload: unknown): void;
	/** The workbench has a notice for the dashboard (already shown), not changing the view: show it there if the dashboard is in front. Returns whether it was shown. */
	showNotice(payload: unknown): boolean;
	/** Sends a message to this window's workbench page. */
	toWorkbench(channel: string, payload: unknown): void;
	/**
	 * The account signed out (`reason`: 'signed_out', or 'session_ended' / 'unknown_credential'
	 * when the server ended it): close every connection of this window's pages, leave its room and
	 * show the signed-out dashboard.
	 */
	signedOut(reason: string): void;
}

/**
 * ipcMain is one for the whole app, so a listener every window registers hears
 * every window's messages. Open on a dashboard card used to reach every window
 * signed into the account (each joined the room, and each other window left its
 * own room and dropped that room's folder). Each window acts only on messages
 * from its own two pages. Disposing removes the listeners, for a closed window.
 */
export function registerWindowNavigation(ipc: ILiveCollabIpcMain, pages: ILiveCollabWindowPages, target: ILiveCollabWindowNavigationTarget, accountSignedOut: Event<string>): IDisposable {
	const ownPage = (sender: unknown) => sender === pages.dashboard || sender === pages.workbench;
	const onLoadWorkbench = (event: { readonly sender: unknown }, payload?: unknown) => {
		if (!ownPage(event.sender)) {
			return;
		}
		const room = payload as { roomId?: unknown; roomName?: unknown } | string | undefined;
		const roomId = typeof room === 'string' ? room : typeof room?.roomId === 'string' ? room.roomId : '';
		const roomName = typeof room === 'object' && typeof room?.roomName === 'string' ? room.roomName : '';
		target.openRoom(roomId, roomName);
	};
	const onLoadDashboard = (event: { readonly sender: unknown }, payload?: unknown) => {
		if (!ownPage(event.sender)) {
			return;
		}
		target.showDashboard(event.sender === pages.workbench, payload);
	};
	// Only the workbench has notices for the dashboard (as with showDashboard's).
	const onDashboardNotice = (event: { readonly sender: unknown }, payload?: unknown) => {
		if (event.sender !== pages.workbench) {
			return;
		}
		// Answered, so the workbench says it itself when the dashboard didn't (no longer in front).
		const delivered = target.showNotice(payload);
		target.toWorkbench('vscode:livecollab-dashboard-notice-result', { id: (payload as { id?: unknown } | undefined)?.id, delivered });
	};
	ipc.on('vscode:livecollab-load-workbench', onLoadWorkbench);
	ipc.on('vscode:livecollab-load-dashboard', onLoadDashboard);
	ipc.on('vscode:livecollab-dashboard-notice', onDashboardNotice);
	// Signing in is one per app, so signing out is too: when the credential is deleted (Sign Out
	// in any window, or the server ending the session), every window signs out. A page saying it
	// signed out signs out nothing; only the credential's deletion does.
	const signedOut = accountSignedOut(reason => target.signedOut(reason));
	return toDisposable(() => {
		ipc.removeListener('vscode:livecollab-load-workbench', onLoadWorkbench);
		ipc.removeListener('vscode:livecollab-load-dashboard', onLoadDashboard);
		ipc.removeListener('vscode:livecollab-dashboard-notice', onDashboardNotice);
		signedOut.dispose();
	});
}

/**
 * Listens on `channel` for messages from this window's own pages only (`isOwnPage`), until
 * disposed or, with `once`, until the first such message. ipcMain is shared by every window.
 */
export function onOwnPageMessage(ipc: ILiveCollabIpcMain, channel: string, isOwnPage: (sender: unknown) => boolean, listener: (event: { readonly sender: unknown }, ...args: unknown[]) => void, once = false): IDisposable {
	const onMessage = (event: { readonly sender: unknown }, ...args: unknown[]) => {
		if (!isOwnPage(event.sender)) {
			return;
		}
		if (once) {
			ipc.removeListener(channel, onMessage);
		}
		listener(event, ...args);
	};
	ipc.on(channel, onMessage);
	return toDisposable(() => ipc.removeListener(channel, onMessage));
}

/** An `ipcMain.handle` message: the page that sent it and the frame within it (null once that frame is gone). */
export interface ILiveCollabInvokeEvent {
	readonly sender: unknown;
	readonly senderFrame: { readonly parent: unknown; readonly url: string } | null;
}

/** The part of Electron's ipcMain the account handlers use. */
export interface ILiveCollabIpcHandlers {
	handle(channel: string, handler: (event: ILiveCollabInvokeEvent, ...args: unknown[]) => unknown): void;
	removeHandler(channel: string): void;
}

/**
 * What a page of a window is: its dashboard view, a page running the workbench, or the window's
 * own page, which loads the dashboard too but is never shown (hidden behind the two views).
 */
export type LiveCollabPageKind = 'dashboard' | 'workbench' | 'hidden';

/**
 * The pages of every open window. Sign-in belongs to the account, not to a window,
 * so any open window's page may ask; a closed window's may not.
 */
export class LiveCollabPages {
	private readonly _pages = new Map<unknown, LiveCollabPageKind>();

	add(page: unknown, kind: LiveCollabPageKind): IDisposable {
		this._pages.set(page, kind);
		return toDisposable(() => this._pages.delete(page));
	}

	/**
	 * Whether a message came from the top frame of an open window's page of one of `kinds`,
	 * still showing the app (Electron's security guide: validate the sender of every IPC message).
	 */
	accepts(event: ILiveCollabInvokeEvent, kinds: readonly LiveCollabPageKind[]): boolean {
		const kind = this._pages.get(event.sender);
		const frame = event.senderFrame;
		return kind !== undefined && kinds.includes(kind) && !!frame && frame.parent === null && isAppPage(frame.url);
	}
}

function isAppPage(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === `${Schemas.vscodeFileResource}:` && parsed.host === VSCODE_AUTHORITY;
	} catch {
		return false;
	}
}

/** The sign-in, as the account handlers use it (LiveCollabSignIn). */
export interface ILiveCollabAccount {
	readonly server: string;
	start(): Promise<unknown>;
	cancel(): void;
	mint(): Promise<{ jwt: string | null; reason?: string }>;
	session(): Promise<Record<string, unknown> | null>;
	signOut(): Promise<{ ok: boolean }>;
	/** The device credential was deleted: Sign Out, or the server said the session ended. Carries the reason. */
	readonly onDidSignOut: Event<string>;
	setDisplayName(name: string): Promise<unknown>;
	openAccountPage(): void;
}

/**
 * The account's handlers, registered once for the app: renderers ask main to start, cancel,
 * mint, check and sign out, and never see the device credential. They hold nothing of any
 * window, so they keep working whichever window opened first or has closed.
 */
export function registerLiveCollabAccountHandlers(ipc: ILiveCollabIpcHandlers, pages: LiveCollabPages, account: ILiveCollabAccount, clientVersion: string | null, log: { info(message: string): void; error(message: string): void }): IDisposable {
	const channels: string[] = [];
	// Each handler answers only the kinds of page of ours that call it; anything else is
	// refused, does nothing, and gets `refused` back.
	const handle = (channel: string, callers: readonly LiveCollabPageKind[], refused: unknown, handler: (event: ILiveCollabInvokeEvent, ...args: unknown[]) => unknown) => {
		ipc.removeHandler(channel);
		ipc.handle(channel, (event, ...args) => {
			if (!pages.accepts(event, callers)) {
				log.info(`[LiveCollab] refused ${channel}: not the top frame of an open window's ${callers.join(' or ')} page`);
				return refused;
			}
			return handler(event, ...args);
		});
		channels.push(channel);
	};
	// The account's actions: only the dashboard the person sees.
	const dashboard: LiveCollabPageKind[] = ['dashboard'];
	// Reads the window's hidden page makes too: it connects as the dashboard does (when it loads
	// signed in) and lists the rooms, and calls nothing else (dev app, 2026-11-13).
	const readers: LiveCollabPageKind[] = ['dashboard', 'hidden'];
	const anyPage: LiveCollabPageKind[] = ['dashboard', 'workbench', 'hidden'];
	handle('vscode:livecollab-start-auth', dashboard, { ok: false, reason: 'refused' }, () => account.start());
	handle('vscode:livecollab-cancel-auth', dashboard, undefined, () => account.cancel());
	handle('vscode:livecollab-mint-token', anyPage, { jwt: null, error: 'refused' }, async () => {
		try {
			const out = await account.mint();
			// Outcome and reason only: out.jwt is a session token.
			log.info(`[MINT-DIAG] ${out.jwt ? 'ok (jwt present)' : `no jwt, reason: ${out.reason}`}`);
			return out.jwt ? { jwt: out.jwt } : { jwt: null, error: out.reason };
		} catch (e) {
			log.error(`[MINT-DIAG] exception: ${toErrorMessage(e)}`);
			return { jwt: null, error: 'exception' };
		}
	});
	// The server the dashboard and the workbench connect to: the same one the sign-in uses.
	handle('vscode:livecollab-server-url', anyPage, null, () => account.server);
	// LiveCollab's version, which the dashboard's own connection reports in its handshake as the
	// workbench's does: without it the server counted every dashboard as 0.3.5 or older, and gave
	// it the room names escaped for 0.3.5's dashboard (server/legacyDashboard.js).
	handle('vscode:livecollab-client-version', readers, null, () => clientVersion);
	handle('vscode:livecollab-check-session', readers, null, async () => {
		try { return await account.session(); } catch { return null; }
	});
	handle('vscode:livecollab-logout', dashboard, { ok: false }, async () => {
		try { return await account.signOut(); } catch { return { ok: false }; }
	});
	handle('vscode:livecollab-set-display-name', dashboard, { ok: false, reason: 'refused' }, async (_event, name) => {
		if (typeof name !== 'string') { return { ok: false, reason: 'refused' }; }
		try { return await account.setDisplayName(name); } catch { return { ok: false, reason: 'unreachable' }; }
	});
	handle('vscode:livecollab-open-account', dashboard, undefined, () => account.openAccountPage());
	return toDisposable(() => channels.forEach(channel => ipc.removeHandler(channel)));
}

function knownFolders(value: unknown): ILiveCollabKnownFolder[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((folder): folder is ILiveCollabKnownFolder => typeof folder?.roomId === 'string' && typeof folder?.path === 'string');
}

/**
 * The computer's record of shared folders (ATTACH_RECONCILE_DESIGN.md, "Sharing asks first"), for
 * the workbench of any open window. Refused, or sent something malformed, a request records
 * nothing and gets null, which the window takes as "couldn't check" and shares nothing.
 */
export function registerLiveCollabFolderClaimHandlers(ipc: ILiveCollabIpcHandlers, pages: LiveCollabPages, claims: ILiveCollabFolderClaims, log: { info(message: string): void }): IDisposable {
	const channels: string[] = [];
	const handle = (channel: string, handler: (request: Record<string, unknown>) => unknown) => {
		ipc.removeHandler(channel);
		ipc.handle(channel, (event, request) => {
			if (!pages.accepts(event, ['workbench'])) {
				log.info(`[LiveCollab] refused ${channel}: not the top frame of an open window's workbench page`);
				return null;
			}
			if (typeof request !== 'object' || request === null || typeof (request as { roomId?: unknown }).roomId !== 'string') {
				log.info(`[LiveCollab] refused ${channel}: malformed request`);
				return null;
			}
			return handler(request as Record<string, unknown>);
		});
		channels.push(channel);
	};
	handle('vscode:livecollab-folder-overlaps', request => typeof request.path === 'string'
		? claims.overlaps(request.path, request.roomId as string, knownFolders(request.known))
		: null);
	handle('vscode:livecollab-folder-claim', request => typeof request.path === 'string' && Array.isArray(request.acknowledged)
		? claims.claim({
			path: request.path,
			roomId: request.roomId as string,
			roomName: typeof request.roomName === 'string' ? request.roomName : undefined,
			userId: typeof request.userId === 'string' ? request.userId : undefined,
			acknowledged: request.acknowledged.filter((roomId): roomId is string => typeof roomId === 'string'),
			known: knownFolders(request.known),
		})
		: null);
	handle('vscode:livecollab-folder-release', async request => {
		await claims.release(request.roomId as string);
		log.info(`[LiveCollab] folder record released for ${request.roomId}`);
		return true;
	});
	return toDisposable(() => channels.forEach(channel => ipc.removeHandler(channel)));
}
