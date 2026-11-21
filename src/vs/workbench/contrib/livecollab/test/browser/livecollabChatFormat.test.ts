/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatPart, IChatMessage } from '../../browser/livecollabChat.js';
import { CHAT_RUN_MS, chatTime, composerParts, ComposerTags, editableText, IComposerTag, mentionAt, movedTags, pastedText, startsRun, textSegments } from '../../browser/livecollabChatFormat.js';

suite('LiveCollab chat: runs, times, formatting and the composer\'s tags', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function message(id: number, authorId: string, createdAt: number, kind: IChatMessage['kind'] = 'message'): IChatMessage {
		return { id, roomId: 'R', kind, authorId, authorName: authorId, recipient: 'everyone', parts: [], createdAt, editedAt: null, revision: 0 };
	}

	test('a run is one author\'s messages within five minutes of the one before; a line or another author starts a new one', () => {
		const log = [
			message(1, 'ana', 0),
			message(2, 'ana', CHAT_RUN_MS),
			message(3, 'ana', 2 * CHAT_RUN_MS + 1),
			message(4, 'ben', 2 * CHAT_RUN_MS + 2),
			message(5, 'ben', 2 * CHAT_RUN_MS + 3, 'joined'),
			message(6, 'ben', 2 * CHAT_RUN_MS + 4),
		];
		assert.deepStrictEqual(log.map((m, i) => startsRun(log[i - 1], m)), [true, false, true, true, true, true]);
	});

	test('times are relative within a day and a date past it', () => {
		const now = Date.UTC(2026, 10, 11, 12);
		assert.deepStrictEqual({
			recent: chatTime(now - 22 * 60 * 1000, now),
			old: chatTime(now - 2 * 24 * 60 * 60 * 1000, now) === new Date(now - 2 * 24 * 60 * 60 * 1000).toLocaleDateString(),
		}, { recent: '22 mins ago', old: true });
	});

	test('text shows ```blocks```, `inline code` and http(s) links; trailing punctuation stays out of a link', () => {
		assert.deepStrictEqual(textSegments('see `a.ts`, then https://example.com/x?y=1. Done:\n```\nconst x = 1;\n```'), [
			{ kind: 'text', value: 'see ' },
			{ kind: 'code', value: 'a.ts' },
			{ kind: 'text', value: ', then ' },
			{ kind: 'link', value: 'https://example.com/x?y=1' },
			{ kind: 'text', value: '. Done:\n' },
			{ kind: 'block', value: 'const x = 1;' },
		]);
	});

	test('the composer\'s text becomes parts: each tag at its place, the rest text; two tags with the same text stay two; a tag whose text changed is text', () => {
		const d: ChatPart = { type: 'file', fileId: 'f-d' };
		const e: ChatPart = { type: 'file', fileId: 'f-e' };
		const tags: IComposerTag[] = [{ start: 0, text: '@c.txt', part: d }, { start: 7, text: '@c.txt', part: e }];
		assert.deepStrictEqual({
			both: composerParts('@c.txt @c.txt now', tags),
			editedAway: composerParts('@c.txt @c.tx now', tags),
		}, {
			both: [d, { type: 'text', text: ' ' }, e, { type: 'text', text: ' now' }],
			editedAway: [d, { type: 'text', text: ' @c.tx now' }],
		});
	});

	test('tags move with the text around them: typing before or after a tag moves or keeps it, an edit touching it drops it', () => {
		const tag = (start: number): IComposerTag => ({ start, text: '@Sam', part: { type: 'person', userId: String(start) } });
		const tags = [tag(0), tag(5)];
		const starts = (moved: IComposerTag[]) => moved.map(t => `${t.part.type === 'person' ? t.part.userId : ''}@${t.start}`);
		assert.deepStrictEqual({
			typedInFront: starts(movedTags(tags, '@Sam @Sam', 'x @Sam @Sam', 2)),
			typedAnAtInFront: starts(movedTags(tags, '@Sam @Sam', '@@Sam @Sam', 1)),
			typedRightAfter: starts(movedTags(tags, '@Sam @Sam', '@Samx @Sam', 5)),
			editedInside: starts(movedTags(tags, '@Sam @Sam', '@Sam @Sm', 7)),
			deletedOne: starts(movedTags(tags, '@Sam @Sam', ' @Sam', 0)),
		}, {
			typedInFront: ['0@2', '5@7'],
			typedAnAtInFront: ['0@1', '5@6'],
			typedRightAfter: ['0@0', '5@6'],
			editedInside: ['0@0'],
			deletedOne: ['5@1'],
		});
	});

	test('undo and redo bring back the tags the text had then', () => {
		const tags = new ComposerTags();
		const sam = (userId: string): ChatPart => ({ type: 'person', userId });
		tags.changed('@Sam ', 5, false);
		tags.add({ start: 0, text: '@Sam', part: sam('a') });
		tags.changed('@Sam @Sam ', 10, false);
		tags.add({ start: 5, text: '@Sam', part: sam('b') });
		tags.changed('@Sam  ', 5, false);
		const deleted = tags.parts('@Sam  ');
		tags.changed('@Sam @Sam ', 9, true);
		const undone = tags.parts('@Sam @Sam ');
		tags.changed('@Sam  ', 5, true);
		assert.deepStrictEqual({ deleted, undone, redone: tags.parts('@Sam  ') }, {
			deleted: [sam('a'), { type: 'text', text: '  ' }],
			undone: [sam('a'), { type: 'text', text: ' ' }, sam('b'), { type: 'text', text: ' ' }],
			redone: [sam('a'), { type: 'text', text: '  ' }],
		});
	});

	test('a message comes back into the composer as text and tags for editing', () => {
		const parts: ChatPart[] = [{ type: 'text', text: 'hi ' }, { type: 'person', userId: 'u-gina', name: 'Gina' }];
		const editable = editableText(parts, part => part.type === 'person' ? part.name ?? '' : '');
		assert.deepStrictEqual({ editable, back: composerParts(editable.text, editable.tags) }, {
			editable: { text: 'hi @Gina', tags: [{ start: 3, text: '@Gina', part: parts[1] }] },
			back: parts,
		});
	});

	test('several pasted lines go into a code block, unless they already are one; one line is pasted as is', () => {
		assert.deepStrictEqual([pastedText('a\nb\n'), pastedText('```\na\n```'), pastedText('one line')], ['```\na\nb\n```', '```\na\n```', 'one line']);
	});

	test('the @ being typed before the caret, and none inside a word or after a space', () => {
		assert.deepStrictEqual([mentionAt('hi @gi', 6), mentionAt('@', 1), mentionAt('mail@x', 6), mentionAt('hi @gi now', 10)], [{ start: 3, query: 'gi' }, { start: 0, query: '' }, undefined, undefined]);
	});
});
