/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { orderMembers, renderMemberIdentity } from '../../browser/livecollabMemberList.js';

suite('LiveCollab members panel: order and rows', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const names: Record<string, string> = { me: 'Zoe', ana: 'ana', ben: 'Ben', cal: 'Cal', dee: 'Dee', eve: 'Émile' };
	const online = new Set(['me', 'cal', 'ana']);
	const members = ['dee', 'cal', 'me', 'eve', 'ben', 'ana'].map(userId => ({ userId }));

	test('you first, then online, then offline, each alphabetical by the name shown; colors stay by room order', () => {
		const entries = orderMembers(members, 'me', userId => online.has(userId), userId => names[userId]);
		assert.deepStrictEqual(entries.map(e => `${e.name}:${e.isMe ? 'me' : e.online ? 'on' : 'off'}:${e.colorIndex}`), [
			'Zoe:me:2', 'ana:on:5', 'Cal:on:1', 'Ben:off:4', 'Dee:off:0', 'Émile:off:3',
		]);
	});

	test('a row: an online member has the dot, an offline one doesn\'t and is muted; you have a chip; initials by the shared rule', () => {
		const entries = orderMembers(members, 'me', userId => online.has(userId), userId => names[userId]);
		const shown = entries.filter(e => ['Zoe', 'Ben'].includes(e.name)).map(entry => {
			const row = mainWindow.document.createElement('div');
			renderMemberIdentity(row, entry);
			return {
				classes: row.className,
				initials: row.querySelector('.livecollab-member-initials')?.textContent,
				dot: !!row.querySelector('.livecollab-member-dot'),
				chip: row.querySelector('.livecollab-member-chip')?.textContent ?? null,
				label: row.getAttribute('aria-label'),
				direction: row.querySelector<HTMLElement>('.livecollab-member-name')?.dir,
			};
		});
		assert.deepStrictEqual(shown, [
			{ classes: 'livecollab-member online', initials: 'Z', dot: true, chip: 'You', label: 'Zoe, online', direction: 'auto' },
			{ classes: 'livecollab-member offline', initials: 'B', dot: false, chip: null, label: 'Ben, offline', direction: 'auto' },
		]);
	});
});
