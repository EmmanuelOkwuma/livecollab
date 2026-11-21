/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../base/common/async.js';
import { mainWindow } from '../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { fillSlots, greetingSubline, openingText, removedNotice, renderGreeting, renderRoomCard } from '../../electron-browser/workbench/livecollabDashboard.js';

/** Markup that, if it were ever parsed, would set a flag (and nothing else). */
const MARKUP = '<img src=x onerror="globalThis.__lcDashboardProof=1"><b>bold</b>';
const PUNCTUATION = 'Tom & Jerry\'s "R&D" <draft> 50% #1 @home';

declare const globalThis: { __lcDashboardProof?: number };

suite('LiveCollab dashboard: values from the server and the account are shown as text', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const doc = mainWindow.document;
	const room = (name: string, highlight?: string) => ({ id: 'room-1" onclick="x', name, role: 'Owner', accessRole: 'owner', activity: 'Edited <i>now</i>', history: 'Created &amp;', members: '5 members', unread: 2, unreadText: '2 unread', unreadTitle: '2 unread "messages"', highlight });

	test('a room name that looks like markup, or has ordinary punctuation, shows exactly as typed and runs nothing; searching marks it as text', async () => {
		delete globalThis.__lcDashboardProof;
		const cards = [room(MARKUP), room(PUNCTUATION), room(PUNCTUATION, '&')].map(r => renderRoomCard(doc, r));
		doc.body.append(...cards);
		await timeout(50);
		const seen = cards.map(card => ({
			name: card.querySelector('.rname')?.textContent,
			marked: Array.from(card.querySelectorAll('.rname mark')).map(m => m.textContent),
			elementsInName: Array.from(card.querySelectorAll('.rname *')).map(e => e.tagName),
			id: card.dataset.id,
			activity: card.querySelector('.cmeta')?.textContent,
			unreadTitle: card.querySelector<HTMLElement>('.unread')?.title,
		}));
		cards.forEach(card => card.remove());
		assert.deepStrictEqual({ seen, ran: globalThis.__lcDashboardProof ?? 0, images: cards.map(card => card.querySelectorAll('img').length) }, {
			seen: [
				{ name: MARKUP, marked: [], elementsInName: [], id: 'room-1" onclick="x', activity: 'Edited <i>now</i>', unreadTitle: '2 unread "messages"' },
				{ name: PUNCTUATION, marked: [], elementsInName: [], id: 'room-1" onclick="x', activity: 'Edited <i>now</i>', unreadTitle: '2 unread "messages"' },
				{ name: PUNCTUATION, marked: ['&', '&'], elementsInName: ['MARK', 'MARK'], id: 'room-1" onclick="x', activity: 'Edited <i>now</i>', unreadTitle: '2 unread "messages"' },
			],
			ran: 0,
			images: [0, 0, 0],
		});
	});

	test('a name is shown in its own direction, so a right-to-left name can\'t reorder the text around it', () => {
		const card = renderRoomCard(doc, room('غرفة 1'));
		// A name stored before the server refused direction controls: shown without them.
		const stored = renderRoomCard(doc, room('Invoice' + String.fromCharCode(0x202E) + 'fdp.exe'));
		const greeting = doc.createElement('div');
		renderGreeting(greeting, 'Still up, {n}?', 'علی');
		const settings = doc.createElement('div');
		settings.innerHTML = '<input data-fill="displayName"><span data-fill="email"></span>';
		fillSlots(settings, { displayName: 'علی', email: 'a@b.test' });
		assert.deepStrictEqual({
			roomName: card.querySelector<HTMLElement>('.rname')?.dir,
			storedName: stored.querySelector('.rname')?.textContent,
			greetingName: greeting.querySelector<HTMLElement>('.accent')?.dir,
			slots: Array.from(settings.querySelectorAll<HTMLElement>('[data-fill]')).map(slot => slot.dir),
		}, { roomName: 'auto', storedName: 'Invoicefdp.exe', greetingName: 'auto', slots: ['auto', 'auto'] });
	});

	test('a name inside one of the dashboard\'s sentences is isolated, so a right-to-left name keeps the sentence in order: the greeting, the removal notice and the Opening overlay; a stored name\'s direction controls are taken out first', () => {
		const [FSI, PDI, RLO] = [0x2068, 0x2069, 0x202E].map(code => String.fromCharCode(code));
		const arabic = 'محمد علي';
		const persian = 'علی';
		const room = 'غرفة 1';
		const stored = 'Invoice' + RLO + 'fdp.exe';
		const greeting = doc.createElement('div');
		renderGreeting(greeting, 'Still up, {n}?', stored);
		assert.deepStrictEqual({
			greeting: { name: greeting.querySelector('.accent')?.textContent, dir: greeting.querySelector<HTMLElement>('.accent')?.dir },
			subline: [greetingSubline('Burning the midnight oil, {n}?', arabic), greetingSubline('Burning the midnight oil, {n}?', stored), greetingSubline('Pick a room, {n}.', '$& Co')],
			removed: [removedNotice(persian, room), removedNotice(undefined, stored), removedNotice(stored, undefined), removedNotice(undefined, undefined)],
			opening: [openingText(arabic), openingText(stored), openingText(undefined)],
		}, {
			greeting: { name: 'Invoicefdp.exe', dir: 'auto' },
			subline: [`Burning the midnight oil, ${FSI}${arabic}${PDI}?`, `Burning the midnight oil, ${FSI}Invoicefdp.exe${PDI}?`, `Pick a room, ${FSI}$& Co${PDI}.`],
			removed: [`${FSI}${persian}${PDI} removed you from ${FSI}${room}${PDI}.`, `You were removed from ${FSI}Invoicefdp.exe${PDI}.`, `${FSI}Invoicefdp.exe${PDI} removed you from a room.`, 'You were removed from a room.'],
			opening: [`Opening ${FSI}${arabic}${PDI}…`, `Opening ${FSI}Invoicefdp.exe${PDI}…`, 'Opening room…'],
		});
	});

	test('a display name that looks like markup shows as typed in the greeting and the settings fields, and runs nothing', async () => {
		delete globalThis.__lcDashboardProof;
		const greeting = doc.createElement('div');
		renderGreeting(greeting, 'Still up, {n}?', MARKUP);
		const settings = doc.createElement('div');
		settings.innerHTML = '<input data-fill="displayName"><span data-fill="email"></span><span data-fill="provider"></span><span data-fill="missing">x</span>';
		fillSlots(settings, { displayName: MARKUP, email: 'a"b@<x>.test', provider: '<script>1</script>' });
		doc.body.append(greeting, settings);
		await timeout(50);
		const seen = {
			greeting: greeting.textContent,
			name: greeting.querySelector('.accent')?.textContent,
			tail: greeting.querySelector('.tail')?.textContent,
			input: settings.querySelector('input')?.value,
			slots: Array.from(settings.querySelectorAll('span')).map(s => s.textContent),
			elements: greeting.querySelectorAll('img, b').length + settings.querySelectorAll('img, b, script').length,
		};
		greeting.remove();
		settings.remove();
		assert.deepStrictEqual({ ...seen, ran: globalThis.__lcDashboardProof ?? 0 }, {
			greeting: `Still up, ${MARKUP}?`, name: MARKUP, tail: '?', input: MARKUP,
			slots: ['a"b@<x>.test', '<script>1</script>', ''], elements: 0, ran: 0,
		});
	});
});
