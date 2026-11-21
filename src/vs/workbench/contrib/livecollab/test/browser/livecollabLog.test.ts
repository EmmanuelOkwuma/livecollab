/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILiveCollabLogSink, LiveCollabLog } from '../../browser/livecollabLog.js';

suite('LiveCollab log (diagnostics reach the log file, redacted)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function recordingSink(lines: string[]): ILiveCollabLogSink {
		return { info: m => lines.push(`info ${m}`), warn: m => lines.push(`warn ${m}`), error: m => lines.push(`error ${m}`) };
	}

	test('a line with a token reaches the file and the console redacted', () => {
		const file: string[] = [];
		const consoleLines: string[] = [];
		const log = new LiveCollabLog(recordingSink(consoleLines));
		log.setSink(recordingSink(file));

		log.info('[LiveCollab] token', 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl', { roomId: 'room-a' }, 3);

		const expected = ['info [LiveCollab] token [redacted-jwt] {"roomId":"room-a"} 3'];
		assert.deepStrictEqual({ file, consoleLines }, { file: expected, consoleLines: expected });
	});

	test('lines logged before the log service is handed over are written when it is, in order', () => {
		const file: string[] = [];
		const log = new LiveCollabLog(recordingSink([]));

		log.info('early');
		log.error('early error');
		log.setSink(recordingSink(file));
		log.warn('late');

		assert.deepStrictEqual(file, ['info early', 'error early error', 'warn late']);
	});

	test('an early-line overflow keeps the newest lines and says how many were dropped', () => {
		const file: string[] = [];
		const log = new LiveCollabLog(recordingSink([]));

		for (let i = 0; i < 502; i++) {
			log.info(`line ${i}`);
		}
		log.setSink(recordingSink(file));

		assert.deepStrictEqual({ count: file.length, first: file[0], second: file[1], last: file[file.length - 1] }, { count: 501, first: 'warn [LiveCollab] 2 early log lines dropped (buffer full)', second: 'info line 2', last: 'info line 501' });
	});
});
