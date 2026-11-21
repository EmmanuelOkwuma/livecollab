/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fromNow } from '../../../../base/common/date.js';
import { ChatPart, IChatMessage } from './livecollabChat.js';

/** Messages from one author within this long of the one before join into one run (CHAT_DESIGN.md, Message rendering). */
export const CHAT_RUN_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether `message` starts a new run (avatar and name shown) after `previous`. */
export function startsRun(previous: IChatMessage | undefined, message: IChatMessage): boolean {
	return !previous || previous.kind !== 'message' || message.kind !== 'message'
		|| previous.authorId !== message.authorId || message.createdAt - previous.createdAt > CHAT_RUN_MS;
}

/** How a message's time is shown: relative within a day ("22 mins ago"), a date past it. */
export function chatTime(createdAt: number, now: number = Date.now()): string {
	// fromNow measures from the real clock: give it the same age.
	return now - createdAt < DAY_MS ? fromNow(Date.now() - (now - createdAt), true) : new Date(createdAt).toLocaleDateString();
}

/** A piece of a text part as shown: plain text, inline code, a code block, or a link. */
export interface ITextSegment {
	readonly kind: 'text' | 'code' | 'block' | 'link';
	readonly value: string;
}

const SEGMENT_PATTERN = /```\n?(?<block>[\s\S]*?)\n?```|`(?<code>[^`\n]+)`|(?<link>https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** Splits text into what is shown: ```blocks```, `inline code`, and http(s) links. */
export function textSegments(text: string): ITextSegment[] {
	const segments: ITextSegment[] = [];
	let at = 0;
	for (const match of text.matchAll(SEGMENT_PATTERN)) {
		if (match.index > at) {
			segments.push({ kind: 'text', value: text.slice(at, match.index) });
		}
		const groups = match.groups!;
		segments.push(groups.block !== undefined ? { kind: 'block', value: groups.block } : groups.code !== undefined ? { kind: 'code', value: groups.code } : { kind: 'link', value: groups.link });
		at = match.index + match[0].length;
	}
	if (at < text.length) {
		segments.push({ kind: 'text', value: text.slice(at) });
	}
	return segments;
}

/** A tag placed in the composer: where its text starts, that text, and the part it stands for. */
export interface IComposerTag {
	readonly start: number;
	readonly text: string;
	readonly part: ChatPart;
}

/**
 * The parts of what the composer holds: each tag at its place, while its text
 * still stands there, becomes that tag; everything else is text. Two tags with
 * the same text stay two tags, each with its own part.
 */
export function composerParts(text: string, tags: readonly IComposerTag[]): ChatPart[] {
	const parts: ChatPart[] = [];
	const pushText = (value: string) => {
		const last = parts.at(-1);
		if (last?.type === 'text') {
			parts[parts.length - 1] = { type: 'text', text: last.text + value };
		} else if (value) {
			parts.push({ type: 'text', text: value });
		}
	};
	let at = 0;
	for (const tag of [...tags].sort((a, b) => a.start - b.start)) {
		if (tag.start < at || text.slice(tag.start, tag.start + tag.text.length) !== tag.text) {
			continue;
		}
		pushText(text.slice(at, tag.start));
		parts.push(tag.part);
		at = tag.start + tag.text.length;
	}
	pushText(text.slice(at));
	return parts;
}

/**
 * Where the tags are after the text changed from `before` to `after`, the
 * caret now at `caret`. Typing, pasting and deleting leave the caret at the end
 * of what changed, so the text after it is taken as unchanged; what is in front
 * of the change is matched from the start. A tag wholly before the change stays,
 * one wholly after it moves with it, and one the change touches is dropped: its
 * text was edited, so it is text now (as VS Code's chat input drops a reference
 * whose text changes, chatDynamicVariables.ts).
 */
export function movedTags(tags: readonly IComposerTag[], before: string, after: string, caret: number): IComposerTag[] {
	let suffix = after.length - caret;
	if (suffix < 0 || suffix > before.length || before.slice(before.length - suffix) !== after.slice(caret)) {
		suffix = 0;
		while (suffix < before.length && suffix < after.length && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
			suffix++;
		}
	}
	const unchangedEnd = Math.min(before.length, after.length) - suffix;
	let prefix = 0;
	while (prefix < unchangedEnd && before[prefix] === after[prefix]) {
		prefix++;
	}
	const changedEnd = before.length - suffix;
	const delta = after.length - before.length;
	return tags.flatMap(tag => tag.start + tag.text.length <= prefix ? [tag]
		: tag.start >= changedEnd ? [{ ...tag, start: tag.start + delta }]
			: []);
}

/** How many texts a composer remembers its tags for, for undo and redo. */
const REMEMBERED_TEXTS = 200;

/**
 * The tags in one composer, kept at their places as its text changes. Undo and
 * redo bring back the text as it was; the tags it had then come back with it.
 */
export class ComposerTags {

	private _text = '';
	private _tags: IComposerTag[] = [];
	private readonly _remembered = new Map<string, readonly IComposerTag[]>();

	constructor(text = '', tags: readonly IComposerTag[] = []) {
		this.reset(text, tags);
	}

	get tags(): readonly IComposerTag[] {
		return this._tags;
	}

	/** Starts over with `text` and its `tags` (a send, or a message opened for editing). */
	reset(text: string, tags: readonly IComposerTag[] = []): void {
		this._remembered.clear();
		this._text = text;
		this._tags = [...tags];
		this._remember();
	}

	/** The text is now `text`, the caret at `caret`; `undoOrRedo` when undo or redo changed it. */
	changed(text: string, caret: number, undoOrRedo: boolean): void {
		const then = undoOrRedo ? this._remembered.get(text) : undefined;
		this._tags = then ? [...then] : movedTags(this._tags, this._text, text, caret);
		this._text = text;
		this._remember();
	}

	/** A tag was just placed: its text now stands at its start. */
	add(tag: IComposerTag): void {
		this._tags.push(tag);
		this._remember();
	}

	/** What the composer holds, as the parts it sends. */
	parts(text: string): ChatPart[] {
		return composerParts(text, this._tags);
	}

	private _remember(): void {
		this._remembered.delete(this._text);
		this._remembered.set(this._text, [...this._tags]);
		for (const oldest of this._remembered.keys()) {
			if (this._remembered.size <= REMEMBERED_TEXTS) {
				break;
			}
			this._remembered.delete(oldest);
		}
	}
}

/** A message's parts as composer text and tags, for editing it. */
export function editableText(parts: readonly ChatPart[], nameOf: (part: ChatPart) => string): { text: string; tags: IComposerTag[] } {
	let text = '';
	const tags: IComposerTag[] = [];
	for (const part of parts) {
		if (part.type === 'text') {
			text += part.text;
		} else {
			const token = `@${nameOf(part)}`;
			tags.push({ start: text.length, text: token, part });
			text += token;
		}
	}
	return { text, tags };
}

/** A message as plain text, for copying: tags as @name. */
export function plainText(parts: readonly ChatPart[], nameOf: (part: ChatPart) => string): string {
	return editableText(parts, nameOf).text;
}

/** Pasted text as it goes into the composer: several lines of code go into a block, unless they already are one. */
export function pastedText(pasted: string): string {
	return pasted.includes('\n') && !pasted.trimStart().startsWith('```') ? '```\n' + pasted.replace(/\n$/, '') + '\n```' : pasted;
}

/** The `@` being typed just before the caret, if any: where it starts and what follows it. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | undefined {
	const before = text.slice(0, caret);
	const match = /(?:^|\s)@(?<query>[^\s@]*)$/.exec(before);
	if (!match) {
		return undefined;
	}
	const query = match.groups!.query;
	return { start: caret - query.length - 1, query };
}
