/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { initialsFromName } from '../../common/initials.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from './utils.js';

suite('LiveCollab avatars: initials from a display name', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('punctuation goes first; then one word gives one letter, two give two, three the first and third, four or more one; the dashboard\'s own rule showed "MA" for manny-dev', () => {
		const names = [
			'Manny', 'ada lovelace', 'Mary Ann Smith', 'A B C D', '  spaced   out  ',
			'_0', '_ana', '.dot name', '9lives', 'jean-luc picard', '___', '', '🦊 Fox',
			'山田 太郎', 'محمد علي', 'Đặng Thị Mai', 'émile zola', 'Ölaf', 'ภาษา ไทย', 'manny-dev', 'Cafe\u0301 noir',
		];
		assert.deepStrictEqual(Object.fromEntries(names.map(name => [name, initialsFromName(name)])), {
			'Manny': 'M', 'ada lovelace': 'AL', 'Mary Ann Smith': 'MS', 'A B C D': 'A', '  spaced   out  ': 'SO',
			'_0': '0', '_ana': 'A', '.dot name': 'DN', '9lives': '9', 'jean-luc picard': 'JP', '___': '?', '': '?', '🦊 Fox': 'F',
			'山田 太郎': '山太', 'محمد علي': 'مع', 'Đặng Thị Mai': 'ĐM', 'émile zola': 'ÉZ', 'Ölaf': 'Ö', 'ภาษา ไทย': 'ภไ', 'manny-dev': 'M', 'Cafe\u0301 noir': 'CN',
		});
	});
});
