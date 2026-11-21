/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';

/**
 * One piece of a chat message, in order (CHAT_DESIGN.md; the server's chat.js).
 * The client sends tags by id only; the server fills in the name and path as
 * they were when the message was sent.
 */
export type ChatPart =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'file'; readonly fileId: string; readonly name?: string; readonly path?: string }
	| { readonly type: 'person'; readonly userId: string; readonly name?: string };

/** A line of the room's chat log: a message, or a member joining or leaving. */
export interface IChatMessage {
	readonly id: number;
	readonly roomId: string;
	readonly kind: 'message' | 'joined' | 'left';
	readonly authorId: string;
	readonly authorName: string;
	readonly recipient: string;
	readonly parts: readonly ChatPart[];
	readonly createdAt: number;
	/** When it was last edited, or null if never. */
	readonly editedAt: number | null;
	/** How many times it has been edited: an edit names the revision it was made from. */
	readonly revision: number;
	/** The key its sender sent it with, if any (a random id): matches it to a send whose answer was lost. */
	readonly requestKey?: string | null;
}

/**
 * A send this window made that isn't in the log (yet): 'sending' while it waits
 * for the answer; 'notSent' when it was refused, couldn't be sent, or had no
 * answer (it may still have been saved: retrying it with its key never posts
 * twice, and if the log shows it after all, the entry goes). Nothing is sent
 * again on its own (CHAT_DESIGN.md, Offline).
 */
export interface IChatPendingSend {
	readonly requestKey: string;
	readonly parts: readonly ChatPart[];
	readonly state: 'sending' | 'notSent';
	readonly error?: ChatError;
}

/**
 * Why a chat request failed: 'offline' (not connected, nothing sent),
 * 'no_answer' (sent, no answer in time; a send may still have been stored, and
 * retrying it with the same request key never stores it twice), or the
 * server's refusal (empty, too_long, unknown_file, unknown_person, not_yours,
 * not_found, not_saved, ...).
 */
export type ChatError = string;

/**
 * The answer to a send or an edit. A stale edit (made from an older revision:
 * the same author changed it in another window) carries the message as it now stands.
 */
export type ChatMessageResult = { readonly ok: true; readonly message: IChatMessage } | { readonly ok: false; readonly error: ChatError; readonly message?: IChatMessage };

/** The answer to a delete. */
export type ChatDeleteResult = { readonly ok: true; readonly ids: readonly number[] } | { readonly ok: false; readonly error: ChatError };

/** What the chat needs from the room connection (LiveCollabService). */
export interface ILiveCollabChatConnection {
	/** The room this window is in, if any. */
	readonly roomId: string | undefined;
	/** Changes with every room session; an answer from an earlier one is dropped. */
	readonly roomEpoch: number;
	readonly myUserId: string;
	/**
	 * Sends a request with the current room's id. Resolves with the server's
	 * answer, 'offline' if it could not be sent, or 'no_answer' if none came.
	 */
	chatRequest<T>(event: string, payload: object): Promise<T | 'offline' | 'no_answer'>;
}

/** How many pages a re-join fetches at most toward what the window already holds. */
export const RECONNECT_PAGES = 4;

interface IHistoryAnswer {
	readonly ok?: boolean;
	readonly error?: string;
	readonly messages?: IChatMessage[];
	readonly hasMore?: boolean;
	readonly readUpTo?: number;
	readonly unread?: number;
}

/**
 * The current room's chat log as this window holds it: the newest page from
 * the server, older pages as they are asked for, and every change since, as it
 * arrives. The server decides ids, times, names and what is unread; this keeps
 * a copy in id order and asks again after each (re)join.
 */
export class LiveCollabRoomChat extends Disposable {

	private _messages: IChatMessage[] = [];
	private _hasMore = false;
	private _readUpTo = 0;
	private _unread = 0;
	private _loaded = false;
	private _pending: IChatPendingSend[] = [];

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** The log changed: loaded, a message arrived, was edited, deleted or hidden, or it was cleared. */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _onDidChangeUnread = this._register(new Emitter<number>());
	/** The unread count or read position changed. */
	readonly onDidChangeUnread: Event<number> = this._onDidChangeUnread.event;

	constructor(private readonly _connection: ILiveCollabChatConnection) {
		super();
	}

	/** The log, oldest first. */
	get messages(): readonly IChatMessage[] { return this._messages; }
	/** Whether older messages exist than the oldest held. */
	get hasMore(): boolean { return this._hasMore; }
	/** The last message id this user has read. */
	get readUpTo(): number { return this._readUpTo; }
	/** Others' messages after the read position, as the server counts them. */
	get unread(): number { return this._unread; }
	/** Whether the log has been loaded in this room session. */
	get loaded(): boolean { return this._loaded; }
	/** This window's sends that aren't in the log: sending, or not sent. */
	get pending(): readonly IChatPendingSend[] { return this._pending; }

	/**
	 * Loads the log after a join or a re-join. With nothing held, the newest
	 * page. With messages held (a re-join), up to RECONNECT_PAGES pages back
	 * toward the oldest one held. If that reaches it, the pages replace what
	 * was held: whatever was said, edited or deleted while away is there. If
	 * the gap is wider, the pages fetched are the log and what was held is
	 * dropped, so nothing stale is kept: older pages load on scroll, from the
	 * server as they now stand (CHAT_DESIGN.md, Log: reconnecting).
	 */
	async load(): Promise<boolean> {
		const epoch = this._connection.roomEpoch;
		const oldestHeld = this._messages[0]?.id;
		let fetched: IChatMessage[] = [];
		let hasMore = false;
		let read: { readUpTo: number; unread: number } | undefined;
		let beforeId: number | undefined;
		let pages = 0;
		do {
			const answer = await this._connection.chatRequest<IHistoryAnswer>('chat:history', beforeId === undefined ? {} : { beforeId });
			if (epoch !== this._connection.roomEpoch || typeof answer !== 'object' || !answer?.ok) {
				return false;
			}
			const page = answer.messages ?? [];
			fetched = this._merge(fetched, page);
			hasMore = !!answer.hasMore;
			read ??= { readUpTo: answer.readUpTo ?? 0, unread: answer.unread ?? 0 };
			beforeId = page[0]?.id;
			pages++;
		} while (oldestHeld !== undefined && hasMore && beforeId !== undefined && beforeId > oldestHeld && pages < RECONNECT_PAGES);
		this._messages = fetched;
		this._hasMore = hasMore;
		this._loaded = true;
		this._dropSent();
		this._setRead(read.readUpTo, read.unread);
		this._onDidChange.fire();
		return true;
	}

	/** Loads the page before the oldest message held. */
	async loadOlder(): Promise<boolean> {
		const oldest = this._messages[0];
		if (!oldest || !this._hasMore) {
			return false;
		}
		const epoch = this._connection.roomEpoch;
		const answer = await this._connection.chatRequest<IHistoryAnswer>('chat:history', { beforeId: oldest.id });
		if (epoch !== this._connection.roomEpoch || typeof answer !== 'object' || !answer?.ok) {
			return false;
		}
		this._messages = this._merge(this._messages, answer.messages ?? []);
		this._hasMore = !!answer.hasMore;
		this._onDidChange.fire();
		return true;
	}

	/**
	 * Sends a message to everyone in the room. It shows as pending until the
	 * answer; if it fails it stays, as not sent, until retried or discarded.
	 */
	send(parts: readonly ChatPart[]): Promise<ChatMessageResult> {
		const requestKey = generateUuid();
		this._pending = [...this._pending, { requestKey, parts, state: 'sending' }];
		this._onDidChange.fire();
		return this._send(requestKey, parts);
	}

	/** Sends a not-sent message again, with the same key: it can't post twice. */
	retry(requestKey: string): Promise<ChatMessageResult> {
		const entry = this._pending.find(p => p.requestKey === requestKey);
		if (!entry || entry.state !== 'notSent') {
			return Promise.resolve({ ok: false, error: 'not_pending' });
		}
		this._setPending(requestKey, { requestKey, parts: entry.parts, state: 'sending' });
		return this._send(requestKey, entry.parts);
	}

	/** Forgets a not-sent message. */
	discard(requestKey: string): void {
		const entry = this._pending.find(p => p.requestKey === requestKey);
		if (entry?.state === 'notSent') {
			this._setPending(requestKey, undefined);
		}
	}

	private async _send(requestKey: string, parts: readonly ChatPart[]): Promise<ChatMessageResult> {
		const epoch = this._connection.roomEpoch;
		const answer = await this._connection.chatRequest<{ ok?: boolean; error?: string; message?: IChatMessage }>('chat:send', { parts, requestKey });
		const result = this._messageResult(answer);
		if (epoch !== this._connection.roomEpoch || !this._pending.some(p => p.requestKey === requestKey)) {
			return result;
		}
		if (result.ok) {
			this._setPending(requestKey, undefined);
			this._add(result.message);
		} else {
			this._setPending(requestKey, { requestKey, parts, state: 'notSent', error: result.error });
		}
		return result;
	}

	/**
	 * Replaces the parts of one of this user's messages, in place, if it is
	 * still at `revision` (the one the edit was made from). Otherwise the
	 * answer is 'stale', with the message as it now stands, which the log takes.
	 */
	async edit(id: number, parts: readonly ChatPart[], revision: number): Promise<ChatMessageResult> {
		const answer = await this._connection.chatRequest<{ ok?: boolean; error?: string; message?: IChatMessage }>('chat:edit', { id, parts, revision });
		const result = this._messageResult(answer);
		if (result.message) {
			this._replace(result.message);
		}
		return result;
	}

	/**
	 * Deletes messages: 'everyone' removes this user's own messages for the
	 * whole room (all of them or none); 'me' hides any messages from this
	 * user's view only.
	 */
	async delete(ids: readonly number[], scope: 'everyone' | 'me'): Promise<ChatDeleteResult> {
		const answer = await this._connection.chatRequest<{ ok?: boolean; error?: string; ids?: number[] }>('chat:delete', { ids, scope });
		if (typeof answer !== 'object' || !answer) {
			return { ok: false, error: answer ?? 'no_answer' };
		}
		if (!answer.ok) {
			return { ok: false, error: answer.error ?? 'unknown' };
		}
		this._remove(answer.ids ?? []);
		return { ok: true, ids: answer.ids ?? [] };
	}

	/** Moves the read position forward, to `upTo` or the newest message held. */
	async markRead(upTo: number | undefined = this._messages.at(-1)?.id): Promise<boolean> {
		if (upTo === undefined || upTo <= this._readUpTo) {
			return false;
		}
		const epoch = this._connection.roomEpoch;
		const answer = await this._connection.chatRequest<{ ok?: boolean; readUpTo?: number; unread?: number }>('chat:read', { upTo });
		if (epoch !== this._connection.roomEpoch || typeof answer !== 'object' || !answer?.ok) {
			return false;
		}
		this._setRead(answer.readUpTo ?? this._readUpTo, answer.unread ?? this._unread);
		return true;
	}

	/** A chat event from the server for the current room (the service checks the room). */
	receive(event: string, payload: { message?: IChatMessage; ids?: number[]; readUpTo?: number; unread?: number }): void {
		switch (event) {
			case 'chat:message':
				if (payload.message && this._add(payload.message) && this._isUnread(payload.message)) {
					this._setRead(this._readUpTo, this._unread + 1);
				}
				this._dropSent();
				break;
			case 'chat:edited':
				if (payload.message) {
					this._replace(payload.message);
				}
				break;
			case 'chat:deleted':
			case 'chat:hidden':
				this._remove(payload.ids ?? []);
				break;
			case 'chat:unread':
				this._setRead(payload.readUpTo ?? this._readUpTo, payload.unread ?? this._unread);
				break;
		}
	}

	/** Empties the log at the end of a room session. */
	clear(): void {
		const had = this._messages.length > 0 || this._loaded || this._pending.length > 0;
		this._messages = [];
		this._pending = [];
		this._hasMore = false;
		this._loaded = false;
		this._setRead(0, 0);
		if (had) {
			this._onDidChange.fire();
		}
	}

	/** What is held, for the room-state check between sessions. */
	inspect(): string[] {
		return [
			...this._messages.length ? [`${this._messages.length} chat message(s) of ${this._messages[0].roomId}`] : [],
			...this._pending.length ? [`${this._pending.length} unsent chat message(s)`] : [],
		];
	}

	private _setPending(requestKey: string, entry: IChatPendingSend | undefined): void {
		this._pending = entry
			? this._pending.map(p => p.requestKey === requestKey ? entry : p)
			: this._pending.filter(p => p.requestKey !== requestKey);
		this._onDidChange.fire();
	}

	/** Pending sends the log shows after all (an answer lost, the message saved): no longer pending. */
	private _dropSent(): void {
		const sent = new Set(this._messages.filter(m => m.authorId === this._connection.myUserId && m.requestKey).map(m => m.requestKey));
		if (this._pending.some(p => sent.has(p.requestKey))) {
			this._pending = this._pending.filter(p => !sent.has(p.requestKey));
			this._onDidChange.fire();
		}
	}

	private _messageResult(answer: { ok?: boolean; error?: string; message?: IChatMessage } | 'offline' | 'no_answer' | undefined): ChatMessageResult {
		if (typeof answer !== 'object' || !answer) {
			return { ok: false, error: answer ?? 'no_answer' };
		}
		if (answer.ok && answer.message) {
			return { ok: true, message: answer.message };
		}
		return answer.error === 'stale' && answer.message ? { ok: false, error: 'stale', message: answer.message } : { ok: false, error: answer.error ?? 'unknown' };
	}

	private _isUnread(message: IChatMessage): boolean {
		return message.kind === 'message' && message.authorId !== this._connection.myUserId && message.id > this._readUpTo;
	}

	/** Adds a message not yet held, in id order. Returns whether it was new. */
	private _add(message: IChatMessage): boolean {
		if (message.roomId !== this._connection.roomId || this._messages.some(m => m.id === message.id)) {
			return false;
		}
		this._messages = this._merge(this._messages, [message]);
		this._onDidChange.fire();
		return true;
	}

	private _replace(message: IChatMessage): void {
		const at = this._messages.findIndex(m => m.id === message.id);
		if (at < 0) {
			return;
		}
		this._messages = [...this._messages.slice(0, at), message, ...this._messages.slice(at + 1)];
		this._onDidChange.fire();
	}

	private _remove(ids: readonly number[]): void {
		const gone = new Set(ids);
		const removed = this._messages.filter(m => gone.has(m.id));
		if (removed.length === 0) {
			return;
		}
		this._messages = this._messages.filter(m => !gone.has(m.id));
		const wereUnread = removed.filter(m => this._isUnread(m)).length;
		if (wereUnread) {
			this._setRead(this._readUpTo, Math.max(0, this._unread - wereUnread));
		}
		this._onDidChange.fire();
	}

	private _merge(held: readonly IChatMessage[], incoming: readonly IChatMessage[]): IChatMessage[] {
		const byId = new Map<number, IChatMessage>();
		for (const message of held) {
			byId.set(message.id, message);
		}
		for (const message of incoming) {
			byId.set(message.id, message);
		}
		return [...byId.values()].sort((a, b) => a.id - b.id);
	}

	private _setRead(readUpTo: number, unread: number): void {
		if (readUpTo === this._readUpTo && unread === this._unread) {
			return;
		}
		this._readUpTo = readUpTo;
		this._unread = unread;
		this._onDidChangeUnread.fire(unread);
	}
}
