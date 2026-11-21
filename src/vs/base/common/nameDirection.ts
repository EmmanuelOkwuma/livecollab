/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// LiveCollab: how a person's or a room's name is shown, in its own direction
// (Manny, 2026-11-12). The server refuses the bidi embeddings, overrides and
// isolates in a new name (server/nameText.js), but names stored before that
// can still hold them; they are taken out here, so none can reorder the text
// around the name or close the isolate a sentence puts it in. The joiners and
// marks names need (ZWJ, ZWNJ, LRM, RLM) stay. The dashboard pages import this
// module directly, as they do initials.js, so it imports nothing, its exports
// carry @skipMangle, and it is listed for shipping in build/gulpfile.vscode.ts
// and build/next/index.ts.

const FSI = String.fromCharCode(0x2068);
const PDI = String.fromCharCode(0x2069);
/** LRE, RLE, PDF, LRO, RLO (U+202A-202E) and LRI, RLI, FSI, PDI (U+2066-2069). */
const DIRECTION_CONTROLS = new RegExp(`[${String.fromCharCode(0x202A)}-${String.fromCharCode(0x202E)}${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}]`, 'g');

/**
 * `name` without the direction controls a name may not hold, for showing in
 * an element of its own (which isolates it: dir="auto").
 *
 * @skipMangle imported by name from the dashboard HTML, which the mangler
 * cannot see.
 */
export function nameForDisplay(name: string): string {
	return name.replace(DIRECTION_CONTROLS, '');
}

/**
 * `name` for a sentence: cleaned as nameForDisplay does, between FSI and PDI,
 * so it takes its own direction and the sentence around it keeps its order
 * (Unicode bidi isolates, UAX #9).
 *
 * @skipMangle imported by name from the dashboard HTML, which the mangler
 * cannot see.
 */
export function isolatedName(name: string): string {
	return FSI + nameForDisplay(name) + PDI;
}
