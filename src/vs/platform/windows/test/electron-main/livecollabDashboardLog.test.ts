/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { toDashboardLogLine, toDashboardNotice } from '../../electron-main/livecollabDashboardLog.js';

suite('LiveCollab dashboard log (lines from the dashboard page reach main.log, checked and redacted)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('lines are tagged, redacted and cut; anything malformed is dropped', () => {
		const long = 'x'.repeat(2001);

		const results = {
			plain: toDashboardLogLine('info', '[LiveCollab] dashboard socket connected'),
			withToken: toDashboardLogLine('warn', 'mint failed eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl'),
			cutLength: toDashboardLogLine('error', long)?.line.length,
			unknownLevel: toDashboardLogLine('debug', 'x'),
			notAString: toDashboardLogLine('info', { token: 'x' }),
		};

		assert.deepStrictEqual(results, {
			plain: { level: 'info', line: '[dashboard] [LiveCollab] dashboard socket connected' },
			withToken: { level: 'warn', line: '[dashboard] mint failed [redacted-jwt]' },
			cutLength: '[dashboard] '.length + 2000 + ' …(cut)'.length,
			unknownLevel: undefined,
			notAString: undefined,
		});
	});

	test('a notice for the dashboard is a room id and some text; anything else is dropped, and a long one is cut', () => {
		assert.deepStrictEqual({
			removed: toDashboardNotice({ roomId: 'r1', notice: 'Chris removed you from f-run-sheet.' }),
			cutLength: toDashboardNotice({ roomId: 'r1', notice: 'x'.repeat(400) })?.notice.length,
			empty: toDashboardNotice({ roomId: 'r1', notice: '  ' }),
			noNotice: toDashboardNotice({ roomId: 'r1' }),
			markup: toDashboardNotice({ roomId: 'r1', notice: { html: '<b>x</b>' } }),
			nothing: toDashboardNotice(undefined),
		}, {
			removed: { roomId: 'r1', notice: 'Chris removed you from f-run-sheet.' },
			cutLength: 301,
			empty: undefined,
			noNotice: undefined,
			markup: undefined,
			nothing: undefined,
		});
	});
});
