/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { redactSecretsInString } from '../../../../base/common/redactSecrets.js';
import { ILogService } from '../../../../platform/log/common/log.js';

type LiveCollabLogLevel = 'info' | 'warn' | 'error';

/** Where a formatted line goes. */
export interface ILiveCollabLogSink {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

/** Lines kept until the log service is handed over; older ones are dropped. */
const MAX_BUFFERED_LINES = 500;

function formatArgument(argument: unknown): string {
	if (typeof argument === 'string') {
		return argument;
	}
	if (argument instanceof Error) {
		return toErrorMessage(argument, true);
	}
	if (argument !== null && typeof argument === 'object') {
		try {
			return JSON.stringify(argument);
		} catch {
			return String(argument);
		}
	}
	return String(argument);
}

/**
 * LiveCollab's diagnostics. Lines go to the log service — renderer.log, on
 * disk with timestamps, readable with grep when DevTools is off (release
 * builds) — and to the console for the dev build. Every line is redacted
 * (base/common/redactSecrets.ts) before it goes anywhere: a log file is
 * something a tester hands to us, so a line must never carry a token
 * (HANDOFF "credentials are written to logs", vector 1). Callers still log
 * ids and outcomes only, never whole server replies or personal data.
 * Lines logged before the log service is handed over (module load, early
 * contributions) are buffered and written when it is.
 */
export class LiveCollabLog {

	private _sink: ILiveCollabLogSink | undefined;
	private _buffered: [LiveCollabLogLevel, string][] = [];
	private _droppedWhileBuffering = 0;

	constructor(private _console: ILiveCollabLogSink = { info: m => console.log(m), warn: m => console.warn(m), error: m => console.error(m) }) { }

	/**
	 * Echoes lines to `echo` in place of the console until the returned
	 * disposable is disposed. Layer B's tests capture the log this way: the
	 * unit-test runner fails any test that writes to the console.
	 */
	echoTo(echo: ILiveCollabLogSink): IDisposable {
		const previous = this._console;
		this._console = echo;
		return toDisposable(() => { this._console = previous; });
	}

	setSink(sink: ILiveCollabLogSink): void {
		this._sink = sink;
		if (this._droppedWhileBuffering > 0) {
			sink.warn(`[LiveCollab] ${this._droppedWhileBuffering} early log lines dropped (buffer full)`);
			this._droppedWhileBuffering = 0;
		}
		for (const [level, line] of this._buffered) {
			sink[level](line);
		}
		this._buffered = [];
	}

	info(...args: unknown[]): void { this._write('info', args); }
	warn(...args: unknown[]): void { this._write('warn', args); }
	error(...args: unknown[]): void { this._write('error', args); }

	private _write(level: LiveCollabLogLevel, args: unknown[]): void {
		const line = redactSecretsInString(args.map(formatArgument).join(' '));
		this._console[level](line);
		if (this._sink) {
			this._sink[level](line);
		} else {
			if (this._buffered.length >= MAX_BUFFERED_LINES) {
				this._buffered.shift();
				this._droppedWhileBuffering++;
			}
			this._buffered.push([level, line]);
		}
	}
}

export const lcLog = new LiveCollabLog();

/** Hands the workbench's log service to LiveCollab's diagnostics. */
export function setLiveCollabLogService(logService: ILogService): void {
	lcLog.setSink({
		info: message => logService.info(message),
		warn: message => logService.warn(message),
		error: message => logService.error(message),
	});
}
