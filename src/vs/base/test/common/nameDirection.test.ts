/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isolatedName, nameForDisplay } from '../../common/nameDirection.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from './utils.js';

suite('LiveCollab names: shown in their own direction', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const c = (code: number) => String.fromCharCode(code);
	const [FSI, PDI, RLO, LRE, PDF, RLI, LRM, RLM, ZWJ, ZWNJ] = [0x2068, 0x2069, 0x202E, 0x202A, 0x202C, 0x2067, 0x200E, 0x200F, 0x200D, 0x200C].map(c);

	test('a name in a sentence is isolated, so a right-to-left name keeps the sentence in order; a stored name\'s own direction controls are taken out first, so none can close the isolate or carry past it', () => {
		const names = {
			latin: 'Ada',
			arabic: 'محمد علي',
			mixed: 'Ada محمد 2',
			persianZwnj: 'علی' + ZWNJ + 'رضا',
			emoji: 'Ana ' + String.fromCodePoint(0x1F469) + ZWJ + String.fromCodePoint(0x1F4BB),
			marks: 'Ana' + LRM + ' ' + 'שלום' + RLM,
			// Stored before 0.3.6 refused these: an override, an embedding left open, an isolate and a stray PDI.
			storedOverride: 'Invoice' + RLO + 'fdp.exe',
			storedEmbedding: LRE + 'abc',
			storedIsolates: 'a' + RLI + 'b' + PDI + PDI + 'c' + PDF,
		};
		assert.deepStrictEqual(Object.fromEntries(Object.entries(names).map(([key, name]) => [key, isolatedName(name)])), {
			latin: FSI + 'Ada' + PDI,
			arabic: FSI + 'محمد علي' + PDI,
			mixed: FSI + 'Ada محمد 2' + PDI,
			persianZwnj: FSI + names.persianZwnj + PDI,
			emoji: FSI + names.emoji + PDI,
			marks: FSI + names.marks + PDI,
			storedOverride: FSI + 'Invoicefdp.exe' + PDI,
			storedEmbedding: FSI + 'abc' + PDI,
			storedIsolates: FSI + 'abc' + PDI,
		});
		assert.deepStrictEqual([nameForDisplay(names.storedIsolates), nameForDisplay(names.emoji), nameForDisplay(names.marks)], ['abc', names.emoji, names.marks]);
	});
});
