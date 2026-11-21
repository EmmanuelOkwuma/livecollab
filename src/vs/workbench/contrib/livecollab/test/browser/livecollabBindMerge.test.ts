/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mergeIntoRoomText } from '../../browser/livecollabBindMerge.js';

suite('LiveCollab bind merge (typing done before a binding lands survives it)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * Both sides after the merge: the room's text with the merge's edits applied, and the editor's,
	 * which the binding then sets to the room's (y-monaco replaces it on creation). Kept as two
	 * values so a merge that ever leaves them apart shows it.
	 */
	function merged(base: string, local: string, room: string): { room: string; editor: string } {
		let text = room;
		for (const edit of mergeIntoRoomText(base, local, room)) {
			text = text.substring(0, edit.offset) + edit.insert + text.substring(edit.offset + edit.deleteCount);
		}
		return { room: text, editor: text };
	}

	/** Both sides holding `text`. */
	function both(text: string): { room: string; editor: string } {
		return { room: text, editor: text };
	}

	test('each side\'s changes are kept, and a local deletion applies only where the room still has the text', () => {
		assert.deepStrictEqual({
			nothingTyped: merged('alpha', 'alpha', 'alpha remote'),
			typedOnly: merged('alpha', 'alpha typed', 'alpha'),
			bothAppend: merged('alpha', 'alpha typed', 'alpha remote'),
			apart: merged('one two three', 'one TYPED two three', 'one two three REMOTE'),
			localDeletes: merged('one two three', 'one three', 'one two three!'),
			roomEditedWhatLocalDeleted: merged('one two three', 'one three', 'one TWO three'),
			roomDeletedWhatLocalKept: merged('one two three', 'one two three typed', 'one three'),
		}, {
			nothingTyped: both('alpha remote'),
			typedOnly: both('alpha typed'),
			bothAppend: both('alpha remote typed'),
			apart: both('one TYPED two three REMOTE'),
			localDeletes: both('one three!'),
			roomEditedWhatLocalDeleted: both('one TWO three'),
			roomDeletedWhatLocalKept: both('one three typed'),
		});
	});

	test('where the base is wrong for the room, nothing is injected into it and nothing typed is lost', () => {
		assert.deepStrictEqual({
			// The room already deleted what the local side deleted: nothing more is deleted.
			bothDeletedTheSameRegion: merged('one two three', 'one three', 'one three'),
			// The room deleted part of what the local side deleted: the rest of the room's text stays.
			roomDeletedPartOfTheLocalDeletion: merged('one two three', 'one three', 'one tw three'),
			// The room cleared the file: the deleted text doesn't come back; what was typed does.
			roomClearedLocalTyped: merged('abc', 'abc!', ''),
			roomClearedLocalDeleted: merged('abc', 'ac', ''),
			// Both inserted at one offset: the room's first, then the local text.
			bothInsertedAtOneOffset: merged('ab', 'aXb', 'aYb'),
			// A local deletion across text the room partly changed: not applied, the room's change stays.
			localDeletionAcrossARoomChange: merged('abcdef', 'af', 'abcXef'),
			// The room replaced the whole file: the old text doesn't return, and what was typed is kept.
			// Typing inside text the room rewrote lands wherever the character diff aligns that spot
			// (here after the 'n' the room kept in place of 'old t'): kept, not at a meaningful place.
			roomReplacedTheFile: merged('old text', 'old text typed', 'new'),
			roomReplacedTheFileLocalEditedTheMiddle: merged('old text', 'old TYPED text', 'new'),
			// An empty base (a new file): both sides' text, the room's first.
			emptyBase: merged('', 'typed', 'remote'),
			emptyBaseRoomEmpty: merged('', 'typed', ''),
			// The local side deleted everything it saw while the room added: the room's addition stays.
			localClearedRoomAdded: merged('abc', '', 'abc!'),
		}, {
			bothDeletedTheSameRegion: both('one three'),
			roomDeletedPartOfTheLocalDeletion: both('one tw three'),
			roomClearedLocalTyped: both('!'),
			roomClearedLocalDeleted: both(''),
			bothInsertedAtOneOffset: both('aYXb'),
			localDeletionAcrossARoomChange: both('abcXef'),
			roomReplacedTheFile: both('new typed'),
			roomReplacedTheFileLocalEditedTheMiddle: both('nTYPED ew'),
			emptyBase: both('remotetyped'),
			emptyBaseRoomEmpty: both('typed'),
			localClearedRoomAdded: both('!'),
		});
	});

	/**
	 * Random edits on both sides, every character distinct, so each one's fate can be checked:
	 * everything either side inserted is there, in that side's order; base text both sides kept is
	 * there; base text the room deleted never comes back; nothing appears twice.
	 */
	test('random edits on both sides: nothing inserted is lost, nothing the room deleted comes back, nothing doubles', () => {
		let seed = 20261105;
		const random = (n: number) => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed % n;
		};
		let next = 0x4E00; // distinct characters from one block, never repeated
		const fresh = () => String.fromCharCode(next++);
		/** Random deletions and insertions of fresh characters, with the base characters deleted. */
		const edit = (text: string): { text: string; inserted: string; deleted: Set<string> } => {
			const out: string[] = [];
			let inserted = '';
			const deleted = new Set<string>();
			for (const char of text) {
				if (random(5) === 0) {
					const added = fresh() + (random(2) ? fresh() : '');
					out.push(added);
					inserted += added;
				}
				if (random(5) === 0) {
					deleted.add(char);
				} else {
					out.push(char);
				}
			}
			if (random(3) === 0) {
				const added = fresh();
				out.push(added);
				inserted += added;
			}
			return { text: out.join(''), inserted, deleted };
		};
		const isInOrder = (text: string, chars: string) => {
			let at = -1;
			for (const char of chars) {
				const found = text.indexOf(char, at + 1);
				if (found < 0) {
					return false;
				}
				at = found;
			}
			return true;
		};
		const failures: string[] = [];
		for (let run = 0; run < 300; run++) {
			let base = '';
			for (let i = random(12); i > 0; i--) {
				base += fresh();
			}
			const local = edit(base);
			const room = edit(base);
			const result = merged(base, local.text, room.text).room;
			const keptByBoth = [...base].filter(char => !local.deleted.has(char) && !room.deleted.has(char)).join('');
			const problems = [
				...isInOrder(result, local.inserted) ? [] : ['local insertion lost or reordered'],
				...isInOrder(result, room.inserted) ? [] : ['room insertion lost or reordered'],
				...isInOrder(result, keptByBoth) ? [] : ['base text both kept is missing'],
				...[...room.deleted].some(char => result.includes(char)) ? ['base text the room deleted came back'] : [],
				...new Set(result).size !== result.length ? ['a character appears twice'] : [],
			];
			if (problems.length) {
				failures.push(`${JSON.stringify({ base, local: local.text, room: room.text, result })}: ${problems.join(', ')}`);
			}
		}
		assert.deepStrictEqual(failures, []);
	});
});
