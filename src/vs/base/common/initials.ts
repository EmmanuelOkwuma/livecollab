/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// LiveCollab: the one rule for what an avatar shows, used by the chat, the
// members panel and the dashboard. The dashboard pages (livecollab-bootstrap.html
// / -dev.html) import this module directly, as they do redactSecrets.js, so it
// imports nothing, its export carries @skipMangle, and it is listed for shipping
// in build/gulpfile.vscode.ts and build/next/index.ts.

/**
 * What an avatar shows for `name` (CHAT_DESIGN.md, Presence: avatar initials).
 * Punctuation and symbols are removed first, so `_` or `.` is never the
 * letter shown; letters and digits of any script stay. Then one word gives
 * one letter, two words two, three words the first and third, four or more
 * one. A name with nothing left gives "?". A letter is taken with the marks
 * that follow it, so a decomposed accent stays on its letter.
 *
 * @skipMangle imported by name from the dashboard HTML, which the mangler
 * cannot see.
 */
export function initialsFromName(name: string): string {
	const words = name.normalize('NFC').split(/\s+/u).map(word => word.replace(/[^\p{L}\p{M}\p{N}]/gu, '')).filter(word => /^[\p{L}\p{N}]/u.test(word));
	const picked = words.length === 2 ? words : words.length === 3 ? [words[0], words[2]] : words.slice(0, 1);
	const initials = picked.map(word => /^[\p{L}\p{N}]\p{M}*/u.exec(word)?.[0] ?? '').join('').toLocaleUpperCase();
	return initials || '?';
}
