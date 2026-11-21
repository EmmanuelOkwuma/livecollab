/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { equals } from '../../../../base/common/objects.js';
import { IApplicationStorageValueChangeEvent, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IComposerTag } from './livecollabChatFormat.js';

/** What the composer held and didn't send: its text and the tags placed in it. */
export interface IChatDraft {
	readonly text: string;
	readonly tags: readonly IComposerTag[];
}

/**
 * A draft as stored. `writer` names the window that wrote it and `seq` that
 * window's count of versions; `seen` holds, for each window, the latest of
 * its versions this one was written over, its own included (a version
 * vector). Another window hears only some versions, so it tells "the same
 * draft, further on" from "written without seeing mine" by whether `seen`
 * reaches its own latest version. However many keystrokes go unheard, the
 * vector grows only with the number of windows.
 * An empty text is a draft cleared (a send, or everything deleted).
 */
export interface IStoredChatDraft extends IChatDraft {
	readonly writer: string;
	readonly seq: number;
	readonly seen: Readonly<Record<string, number>>;
	/**
	 * Whether writers were ever dropped from `seen` (past WRITERS_KEPT), here or in
	 * a version it was written over: a window that learned from it may meet a
	 * writer it can't place, and can't tell new from old.
	 */
	readonly pruned?: boolean;
}

/** How many windows a draft remembers, most recent writers kept: far more than are ever open at once. */
export const WRITERS_KEPT = 64;

/** A version's name (its writer and count), used as the id of a draft kept aside. */
export function draftVersion(draft: { readonly writer: string; readonly seq: number }): string {
	return `${draft.writer}:${draft.seq}`;
}

/** The version a name from `draftVersion` stands for, or undefined for any other id. */
export function parseDraftVersion(id: string): { writer: string; seq: number } | undefined {
	const at = id.lastIndexOf(':');
	const seq = Number(id.slice(at + 1));
	return at > 0 && Number.isInteger(seq) && seq > 0 ? { writer: id.slice(0, at), seq } : undefined;
}

/** Everything both vectors saw: each window's later count, `a`'s writers first. */
export function mergeSeen(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): Record<string, number> {
	const merged: Record<string, number> = { ...a };
	for (const [writer, seq] of Object.entries(b)) {
		merged[writer] = Math.max(merged[writer] ?? 0, seq);
	}
	return merged;
}

/** A draft kept aside when two windows changed it at once, until Discard. */
export interface IKeptChatDraft extends IChatDraft {
	readonly id: string;
}

/** Unsent drafts, one per account and room, and the drafts kept aside for them. */
export interface IChatDrafts {
	readonly onDidChange: Event<{ readonly userId: string; readonly roomId: string; readonly kind: 'draft' | 'kept' }>;
	get(userId: string, roomId: string): IStoredChatDraft | undefined;
	set(userId: string, roomId: string, draft: IStoredChatDraft): void;
	kept(userId: string, roomId: string): IKeptChatDraft[];
	/** Keeps `draft` aside under `id`; keeping the same id again changes nothing. */
	keep(userId: string, roomId: string, id: string, draft: IChatDraft): void;
	discard(userId: string, roomId: string, id: string): void;
}

/** The part of IStorageService the drafts use. */
export interface IChatDraftStorage {
	get(key: string, scope: StorageScope.APPLICATION): string | undefined;
	store(key: string, value: string, scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE): void;
	remove(key: string, scope: StorageScope.APPLICATION): void;
	keys(scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE): string[];
	onDidChangeValue(scope: StorageScope.APPLICATION, key: string | undefined, disposable: DisposableStore): Event<IApplicationStorageValueChangeEvent>;
}

const DRAFT = 'livecollab.chat.draft/';
const KEPT = 'livecollab.chat.draftKept/';

function roomPath(userId: string, roomId: string): string {
	return `${encodeURIComponent(userId)}/${encodeURIComponent(roomId)}`;
}

function isTag(value: unknown): value is IComposerTag {
	const tag = value as IComposerTag | null;
	return typeof tag === 'object' && tag !== null && typeof tag.start === 'number' && typeof tag.text === 'string' && typeof tag.part === 'object' && tag.part !== null;
}

function parseDraft(raw: string | undefined): (IChatDraft & { writer?: unknown; seq?: unknown; seen?: unknown; pruned?: unknown; rev?: unknown }) | undefined {
	if (!raw) {
		return undefined;
	}
	try {
		const draft = JSON.parse(raw) as Partial<IChatDraft> & { writer?: unknown; seq?: unknown; seen?: unknown; pruned?: unknown; rev?: unknown };
		if (typeof draft.text === 'string' && Array.isArray(draft.tags) && draft.tags.every(isTag)) {
			return { text: draft.text, tags: draft.tags, writer: draft.writer, seq: draft.seq, seen: draft.seen, pruned: draft.pruned, rev: draft.rev };
		}
	} catch {
		// Not a draft this build wrote: there is none.
	}
	return undefined;
}

/** Whether two drafts are the same text with the same tags in the same places. */
export function sameDraft(a: IChatDraft, b: IChatDraft): boolean {
	return a.text === b.text && equals(a.tags, b.tags);
}

/**
 * Drafts in the machine's application storage, so they outlive the window and
 * a restart of the app, and are kept apart by account and by room: another
 * room, or another account signed in on this machine, starts with its own.
 * Every window of the app shares that storage, each through its own copy that
 * hears of another window's writes a moment later (storage `acceptExternal`),
 * which is why a draft carries the version it was written over. A kept draft
 * is a key of its own, so two windows keeping one each can't overwrite the other.
 */
export class StoredChatDrafts extends Disposable implements IChatDrafts {

	private readonly _onDidChange = this._register(new Emitter<{ readonly userId: string; readonly roomId: string; readonly kind: 'draft' | 'kept' }>());
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly _storage: IChatDraftStorage) {
		super();
		const listeners = this._register(new DisposableStore());
		this._register(this._storage.onDidChangeValue(StorageScope.APPLICATION, undefined, listeners)(e => {
			const kind = e.key.startsWith(DRAFT) ? 'draft' : e.key.startsWith(KEPT) ? 'kept' : undefined;
			if (!kind) {
				return;
			}
			const [userId, roomId] = e.key.slice(kind === 'draft' ? DRAFT.length : KEPT.length).split('/').map(decodeURIComponent);
			if (userId && roomId) {
				this._onDidChange.fire({ userId, roomId, kind });
			}
		}));
	}

	get(userId: string, roomId: string): IStoredChatDraft | undefined {
		const draft = parseDraft(this._storage.get(DRAFT + roomPath(userId, roomId), StorageScope.APPLICATION));
		if (!draft) {
			return undefined;
		}
		if (typeof draft.writer === 'string' && typeof draft.seq === 'number' && typeof draft.seen === 'object' && draft.seen !== null) {
			const seen: Record<string, number> = {};
			for (const [writer, seq] of Object.entries(draft.seen)) {
				if (typeof seq === 'number') {
					seen[writer] = seq;
				}
			}
			return { text: draft.text, tags: draft.tags, writer: draft.writer, seq: draft.seq, seen, pruned: draft.pruned === true };
		}
		// Written by an earlier build (a version name and the names it was written over), or
		// before drafts had versions: one version of its own, over none.
		const writer = typeof draft.rev === 'string' ? draft.rev : 'unversioned';
		return { text: draft.text, tags: draft.tags, writer, seq: 1, seen: { [writer]: 1 } };
	}

	set(userId: string, roomId: string, draft: IStoredChatDraft): void {
		// The writer last, and the oldest writers dropped past WRITERS_KEPT.
		const seen = Object.entries(draft.seen).filter(([writer]) => writer !== draft.writer);
		seen.push([draft.writer, draft.seq]);
		const pruned = draft.pruned === true || seen.length > WRITERS_KEPT;
		this._storage.store(DRAFT + roomPath(userId, roomId), JSON.stringify({ writer: draft.writer, seq: draft.seq, seen: Object.fromEntries(seen.slice(-WRITERS_KEPT)), pruned, text: draft.text, tags: draft.tags }), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	kept(userId: string, roomId: string): IKeptChatDraft[] {
		const prefix = `${KEPT}${roomPath(userId, roomId)}/`;
		const kept: (IKeptChatDraft & { at: number })[] = [];
		for (const key of this._storage.keys(StorageScope.APPLICATION, StorageTarget.MACHINE)) {
			if (!key.startsWith(prefix)) {
				continue;
			}
			const draft = parseDraft(this._storage.get(key, StorageScope.APPLICATION)) as (IChatDraft & { at?: unknown }) | undefined;
			if (draft?.text) {
				kept.push({ id: decodeURIComponent(key.slice(prefix.length)), text: draft.text, tags: draft.tags, at: typeof draft.at === 'number' ? draft.at : 0 });
			}
		}
		return kept.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).map(({ id, text, tags }) => ({ id, text, tags }));
	}

	keep(userId: string, roomId: string, id: string, draft: IChatDraft): void {
		const key = `${KEPT}${roomPath(userId, roomId)}/${encodeURIComponent(id)}`;
		if (draft.text && this._storage.get(key, StorageScope.APPLICATION) === undefined) {
			this._storage.store(key, JSON.stringify({ text: draft.text, tags: draft.tags, at: Date.now() }), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
	}

	discard(userId: string, roomId: string, id: string): void {
		this._storage.remove(`${KEPT}${roomPath(userId, roomId)}/${encodeURIComponent(id)}`, StorageScope.APPLICATION);
	}
}
