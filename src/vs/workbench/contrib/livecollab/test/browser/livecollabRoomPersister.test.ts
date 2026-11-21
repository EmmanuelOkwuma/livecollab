/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { hashText, planOutsideChange, planPersist } from '../../browser/livecollabRoomPersister.js';

suite('LiveCollab room persister', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('writes the room text only over what LiveCollab last wrote', () => {
		const written = hashText('v1');
		assert.deepStrictEqual({
			alreadyOnDisk: planPersist('v2', 'v2', written),
			diskIsWhatWeWrote: planPersist('v2', 'v1', written),
			diskChangedOutside: planPersist('v2', 'edited in another app', written),
			deletedOutside: planPersist('v2', undefined, written),
			neverWrittenAndMissing: planPersist('v2', undefined, undefined),
			neverWrittenAndDifferent: planPersist('v2', 'v1', undefined),
			neverWrittenAndSame: planPersist('v2', 'v2', undefined),
			emptyRoomTextOverOurEmptyFile: planPersist('', '', hashText('')),
			roomEmptiedAFileWeWrote: planPersist('', 'v1', written),
		}, {
			alreadyOnDisk: 'inSync',
			diskIsWhatWeWrote: 'write',
			diskChangedOutside: 'conflict',
			deletedOutside: 'conflict',
			neverWrittenAndMissing: 'write',
			neverWrittenAndDifferent: 'conflict',
			neverWrittenAndSame: 'inSync',
			emptyRoomTextOverOurEmptyFile: 'inSync',
			roomEmptiedAFileWeWrote: 'write',
		});
	});

	test('a change made on disk outside the app goes to the room unless it is LiveCollab\'s own write or the room changed too', () => {
		const written = hashText('v1');
		assert.deepStrictEqual({
			sameAsRoom: planOutsideChange('v2', 'v2', written, false),
			ourOwnWriteWhileTheRoomMovedOn: planOutsideChange('v2', 'v1', written, false),
			editedOutsideRoomUnchanged: planOutsideChange('v1', 'edited outside', written, false),
			editedOutsideRoomChangedToo: planOutsideChange('v2', 'edited outside', written, false),
			newOutsideRoomSeededEmpty: planOutsideChange('', 'made in a shell', undefined, true),
			newOutsideRoomAlreadyHasText: planOutsideChange('typed in the room', 'made in a shell', undefined, true),
			neverWrittenAndDifferent: planOutsideChange('v2', 'v1', undefined, false),
		}, {
			sameAsRoom: 'inSync',
			ourOwnWriteWhileTheRoomMovedOn: 'echo',
			editedOutsideRoomUnchanged: 'take',
			editedOutsideRoomChangedToo: 'conflict',
			newOutsideRoomSeededEmpty: 'take',
			newOutsideRoomAlreadyHasText: 'conflict',
			neverWrittenAndDifferent: 'conflict',
		});
	});
});
