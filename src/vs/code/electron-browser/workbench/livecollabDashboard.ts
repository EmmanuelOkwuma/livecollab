/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// LiveCollab: how the dashboard (livecollab-bootstrap.html / -dev.html) puts
// values it doesn't control on the page: room names, display names, emails and
// the rest come from the server, the identity provider or the person typing.
// Each goes in as text (textContent, an input's value, a DOM attribute), never
// as markup, so a name like `<img onerror=…>` shows as typed and runs nothing.
// The page has the app's IPC bridge (window.vscode), so markup that ran there
// could reach the app (2026-11-12, a room name ran in every member's dashboard).
// A name also keeps its own direction (dir="auto", which isolates it), so a
// right-to-left name can't reorder the text around it (Manny, 2026-11-12).
// The page imports this module directly, like redactSecrets.js: it imports
// only nameDirection.js (shipped the same way), its exports carry @skipMangle,
// and it is listed for shipping in build/gulpfile.vscode.ts and build/next/index.ts.

import { isolatedName, nameForDisplay } from '../../../base/common/nameDirection.js';

/** A room card as the dashboard shows it. Every string is shown as text. */
export interface IDashboardCard {
	readonly id: string;
	readonly name: string;
	readonly role: string;
	readonly accessRole?: string;
	readonly pinned?: boolean;
	readonly activity: string;
	readonly history?: string;
	readonly live?: boolean;
	readonly members: string;
	readonly unread?: number;
	readonly unreadText?: string;
	readonly unreadTitle?: string;
	/** The search term, marked where it appears in the name. */
	readonly highlight?: string;
}

const SVG = 'http://www.w3.org/2000/svg';

function element<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const el = doc.createElement(tag);
	if (className) {
		el.className = className;
	}
	if (text !== undefined) {
		el.textContent = text;
	}
	return el;
}

/** One of the page's own icons (an <svg> with a <use> of the page's symbol `id`). */
function icon(doc: Document, id: string, className?: string, size?: number): SVGSVGElement {
	const svg = doc.createElementNS(SVG, 'svg');
	if (className) {
		svg.setAttribute('class', className);
	}
	svg.setAttribute('viewBox', '0 0 16 16');
	if (size) {
		svg.setAttribute('width', String(size));
		svg.setAttribute('height', String(size));
	}
	const use = doc.createElementNS(SVG, 'use');
	use.setAttribute('href', '#' + id);
	svg.appendChild(use);
	return svg;
}

function trashIcon(doc: Document): SVGSVGElement {
	const svg = doc.createElementNS(SVG, 'svg');
	for (const [name, value] of [['viewBox', '0 0 16 16'], ['width', '13'], ['height', '13'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.3']]) {
		svg.setAttribute(name, value);
	}
	const path = doc.createElementNS(SVG, 'path');
	path.setAttribute('d', 'M2 4h12M5.5 4V2.5h5V4M12.5 4l-.7 9.5a1 1 0 0 1-1 .9H5.2a1 1 0 0 1-1-.9L3.5 4');
	svg.appendChild(path);
	return svg;
}

/**
 * Appends `text` to `parent` as text, with each case-insensitive occurrence of
 * `term` in a <mark>.
 *
 * @skipMangle imported by name from the dashboard HTML, which the mangler
 * cannot see.
 */
export function appendHighlighted(parent: HTMLElement, text: string, term?: string): void {
	const doc = parent.ownerDocument;
	const needle = (term ?? '').toLowerCase();
	if (!needle) {
		parent.appendChild(doc.createTextNode(text));
		return;
	}
	const haystack = text.toLowerCase();
	let at = 0;
	for (let found = haystack.indexOf(needle); found !== -1; found = haystack.indexOf(needle, at)) {
		if (found > at) {
			parent.appendChild(doc.createTextNode(text.slice(at, found)));
		}
		parent.appendChild(element(doc, 'mark', undefined, text.slice(found, found + needle.length)));
		at = found + needle.length;
	}
	if (at < text.length) {
		parent.appendChild(doc.createTextNode(text.slice(at)));
	}
}

/**
 * A room card: name, role, pin, delete (owners), activity, and the counts.
 *
 * @skipMangle imported by name from the dashboard HTML, which the mangler
 * cannot see.
 */
export function renderRoomCard(doc: Document, room: IDashboardCard): HTMLDivElement {
	const card = element(doc, 'div', 'card');
	card.dataset.id = room.id;
	card.dataset.role = room.accessRole ?? '';

	const top = card.appendChild(element(doc, 'div', 'ctop'));
	top.appendChild(icon(doc, 'd-grip', 'grip'));
	top.appendChild(element(doc, 'span', 'folder')).appendChild(icon(doc, 'd-folder'));
	const name = top.appendChild(element(doc, 'span', 'rname'));
	name.dir = 'auto';
	appendHighlighted(name, nameForDisplay(room.name), room.highlight);
	top.appendChild(element(doc, 'span', 'tag', room.role));
	const pin = top.appendChild(element(doc, 'span', room.pinned ? 'pin active' : 'pin'));
	pin.dataset.id = room.id;
	pin.appendChild(icon(doc, 'd-pin', undefined, 13));
	if (room.accessRole === 'owner') {
		const trash = top.appendChild(element(doc, 'span', 'rtrash'));
		trash.dataset.id = room.id;
		trash.title = 'Delete room';
		trash.appendChild(trashIcon(doc));
	}

	card.appendChild(element(doc, 'div', 'cmeta', room.activity));
	card.appendChild(element(doc, 'div', 'chist', room.history ?? ''));

	const bottom = card.appendChild(element(doc, 'div', 'cbot'));
	const open = bottom.appendChild(element(doc, 'span', 'open', 'Open '));
	open.appendChild(icon(doc, 'd-arrow', undefined, 13));
	const stats = bottom.appendChild(element(doc, 'span', 'cstats'));
	if (room.unread) {
		const unread = stats.appendChild(element(doc, 'span', 'unread', room.unreadText ?? ''));
		unread.title = room.unreadTitle ?? '';
	}
	if (room.live) {
		const dot = stats.appendChild(element(doc, 'span', 'ldot'));
		dot.setAttribute('role', 'img');
		dot.title = 'Someone is in the room now';
		dot.setAttribute('aria-label', 'Someone is in the room now');
	}
	const members = stats.appendChild(element(doc, 'span', 'members', room.members));
	members.title = 'Members of this room, online or not';
	return card;
}

/**
 * The greeting: `template` with `{n}` standing for the name. The name and what
 * follows it ("?") share one line, so the "?" never wraps alone.
 *
 * @skipMangle imported by name from the dashboard HTML, which the mangler
 * cannot see.
 */
export function renderGreeting(el: HTMLElement, template: string, name: string): void {
	const doc = el.ownerDocument;
	const at = template.indexOf('{n}');
	el.textContent = at < 0 ? template : template.slice(0, at);
	if (at >= 0) {
		const line = el.appendChild(element(doc, 'span', 'nameline'));
		line.appendChild(element(doc, 'span', 'accent', nameForDisplay(name))).dir = 'auto';
		line.appendChild(element(doc, 'span', 'tail', template.slice(at + 3)));
	}
}

/**
 * The greeting's second line: `template` with `{n}` standing for the name,
 * which goes in isolated, so a right-to-left name keeps the line in order.
 * The name is put in as it is (a function, so `$&` in a name stays `$&`).
 *
 * @skipMangle imported by name from the dashboard HTML, which the mangler
 * cannot see.
 */
export function greetingSubline(template: string, name: string): string {
	return template.replace('{n}', () => isolatedName(name));
}

/**
 * What someone removed from a room while on the dashboard is told: by whom,
 * and from which room, each name isolated. Either may be missing.
 *
 * @skipMangle imported by name from the dashboard HTML, which the mangler
 * cannot see.
 */
export function removedNotice(by: unknown, roomName: unknown): string {
	const room = typeof roomName === 'string' && roomName ? isolatedName(roomName) : 'a room';
	return typeof by === 'string' && by ? `${isolatedName(by)} removed you from ${room}.` : `You were removed from ${room}.`;
}

/**
 * The overlay shown while a room opens, its name isolated.
 *
 * @skipMangle imported by name from the dashboard HTML, which the mangler
 * cannot see.
 */
export function openingText(name: unknown): string {
	return typeof name === 'string' && name ? `Opening ${isolatedName(name)}\u2026` : 'Opening room\u2026';
}

/**
 * Fills each `[data-fill]` element under `root` from `values`: an input's
 * value, any other element's text, each in its own direction. A missing value
 * fills nothing.
 *
 * @skipMangle imported by name from the dashboard HTML, which the mangler
 * cannot see.
 */
export function fillSlots(root: ParentNode, values: Readonly<Record<string, string>>): void {
	// The page's settings pages are templates written as strings; their slots are found by attribute.
	// eslint-disable-next-line no-restricted-syntax
	for (const slot of Array.from(root.querySelectorAll<HTMLElement>('[data-fill]'))) {
		const value = values[slot.dataset.fill ?? ''] ?? '';
		slot.dir = 'auto';
		if (slot.tagName === 'INPUT') {
			(slot as HTMLInputElement).value = value;
		} else {
			slot.textContent = value;
		}
	}
}
