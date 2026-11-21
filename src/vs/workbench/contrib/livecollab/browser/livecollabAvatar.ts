/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The colours a member's avatar is drawn in, by position. Shared by the members panel and the chat. */
const USER_COLORS = [
	'#93c5fd', '#60a5fa', '#38bdf8', '#3b82f6', '#2563eb', '#818cf8',
];

/** The avatar colour for the member at `index`. */
export function colorForIndex(index: number): string {
	return USER_COLORS[index % USER_COLORS.length];
}
