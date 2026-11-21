/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { redactSecretsInString } from '../../../base/common/redactSecrets.js';

/** Longest dashboard log line written; longer ones are cut. */
const MAX_LINE_LENGTH = 2000;

/**
 * One dashboard log line, ready for main.log.
 */
export interface ILiveCollabDashboardLogLine {
	readonly level: 'info' | 'warn' | 'error';
	readonly line: string;
}

/**
 * Checks and prepares a line the dashboard page sent for main.log. The page
 * has no log service of its own, so its diagnostics come to the main
 * process over IPC; release builds have no DevTools to read them in. The
 * message is untrusted renderer input: anything that is not a known level
 * and a string is dropped, long lines are cut, and every line is redacted
 * (base/common/redactSecrets.ts) — a log file is something a tester hands
 * to us (HANDOFF "credentials are written to logs", vector 1).
 */
export function toDashboardLogLine(level: unknown, message: unknown): ILiveCollabDashboardLogLine | undefined {
	if ((level !== 'info' && level !== 'warn' && level !== 'error') || typeof message !== 'string') {
		return undefined;
	}
	const cut = message.length > MAX_LINE_LENGTH ? `${message.slice(0, MAX_LINE_LENGTH)} …(cut)` : message;
	return { level, line: `[dashboard] ${redactSecretsInString(cut)}` };
}

/** Longest notice the dashboard is asked to show. */
const MAX_NOTICE_LENGTH = 300;

/**
 * A notice for the dashboard: why a room ended for this person.
 */
export interface ILiveCollabDashboardNotice {
	readonly roomId: string;
	readonly notice: string;
}

/**
 * Checks a notice the workbench sent for the dashboard (worded in livecollabRoomNotices.ts).
 * Untrusted renderer input: anything but a string notice and room id is dropped, and a long notice
 * is cut. The dashboard shows it as text, never as markup.
 */
export function toDashboardNotice(payload: unknown): ILiveCollabDashboardNotice | undefined {
	if (!payload || typeof payload !== 'object') {
		return undefined;
	}
	const { roomId, notice } = payload as { roomId?: unknown; notice?: unknown };
	if (typeof roomId !== 'string' || typeof notice !== 'string' || !notice.trim()) {
		return undefined;
	}
	return { roomId: roomId.slice(0, 200), notice: notice.length > MAX_NOTICE_LENGTH ? `${notice.slice(0, MAX_NOTICE_LENGTH)}…` : notice };
}
