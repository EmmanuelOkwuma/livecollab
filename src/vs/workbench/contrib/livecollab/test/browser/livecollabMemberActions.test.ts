/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfirmation } from '../../../../../platform/dialogs/common/dialogs.js';
import { IMemberActionHost, memberMenu, MemberActionId, runMemberAction } from '../../browser/livecollabMemberActions.js';

suite('LiveCollab members panel: the owner\'s menu on a member, and what is confirmed', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const chris = { userId: 'u-chris', name: 'Chris Lee', role: 'editor' };
	// Names in a sentence go in isolated: between FSI and PDI (U+2068, U+2069), in their own direction.
	const isolated = (name: string) => `${String.fromCharCode(0x2068)}${name}${String.fromCharCode(0x2069)}`;
	const [chrisShown, roomShown] = [isolated('Chris Lee'), isolated('f-run-sheet')];

	/** A host that records what reached the room and what was asked, answering the confirmation with `answer`. */
	function host(answer: boolean) {
		const done: string[] = [];
		const asked: IConfirmation[] = [];
		const record: IMemberActionHost = {
			confirm: async confirmation => { asked.push(confirmation); return answer; },
			setRole: async (userId, role) => { done.push(`role ${userId} ${role}`); return { ok: true }; },
			transfer: async userId => { done.push(`transfer ${userId}`); return { ok: true }; },
			remove: async userId => { done.push(`remove ${userId}`); return { ok: false, error: 'the room refused' }; },
			refused: message => done.push(`said: ${message}`),
		};
		return { record, done, asked };
	}

	test('only the owner has a menu, and not on their own row; roles first, then the destructive actions apart', () => {
		const labels = (menu: ReturnType<typeof memberMenu>) => menu.map(group => group.map(item => `${item.label}${item.checked ? ' (checked)' : ''}`));
		assert.deepStrictEqual({
			ownerOnEditor: labels(memberMenu('u-me', 'owner', chris)),
			ownerOnOwnRow: labels(memberMenu('u-me', 'owner', { userId: 'u-me', name: 'Me', role: 'owner' })),
			editorOnEditor: labels(memberMenu('u-me', 'editor', chris)),
			viewerOnEditor: labels(memberMenu('u-me', 'viewer', chris)),
		}, {
			ownerOnEditor: [['Editor (checked)', 'Viewer'], ['Transfer Ownership…', 'Remove from Room…']],
			ownerOnOwnRow: [],
			editorOnEditor: [],
			viewerOnEditor: [],
		});
	});

	test('a role change happens at once and asks nothing; transfer and remove ask first, naming the person, and Cancel does nothing', async () => {
		const cancelled = host(false);
		for (const id of ['viewer', 'editor', 'transfer', 'remove'] as MemberActionId[]) {
			await runMemberAction(id, chris, 'f-run-sheet', cancelled.record);
		}
		assert.deepStrictEqual({
			done: cancelled.done,
			asked: cancelled.asked.map(confirmation => ({ message: confirmation.message, detail: confirmation.detail, button: confirmation.primaryButton })),
		}, {
			done: ['role u-chris viewer'],
			asked: [
				{
					message: `Make ${chrisShown} the owner of ${roomShown}?`,
					detail: `You'll become an editor, and only ${chrisShown} can make you the owner again. Your folder will stop receiving the room's changes, and ${chrisShown} can't connect a folder to this room yet. The room keeps every file.`,
					button: '&&Transfer Ownership',
				},
				{ message: `Remove ${chrisShown} from this room?`, detail: 'They lose access now. Anyone in the room can invite them back.', button: `&&Remove ${chrisShown}` },
			],
		});
	});

	test('confirmed, transfer and remove reach the room, and a refusal is said in words', async () => {
		const confirmed = host(true);
		await runMemberAction('transfer', chris, 'f-run-sheet', confirmed.record);
		await runMemberAction('remove', chris, 'f-run-sheet', confirmed.record);
		assert.deepStrictEqual(confirmed.done, ['transfer u-chris', 'remove u-chris', 'said: That didn\'t happen: the room refused']);
	});
});
