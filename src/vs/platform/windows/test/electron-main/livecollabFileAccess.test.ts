/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILiveCollabFileAccessCodeWindow, ILiveCollabFileAccessWindow, ILiveCollabFrameOwner, isLiveCollabAppFrame } from '../../electron-main/livecollabFileAccess.js';

suite('LiveCollab: which pages may load the app\'s own files (vscode-file://)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	class Contents implements ILiveCollabFrameOwner {
		destroyed = false;
		readonly mainFrame: { readonly processId: number };
		constructor(processId: number) { this.mainFrame = { processId }; }
		isDestroyed(): boolean { return this.destroyed; }
	}

	/**
	 * A LiveCollab window: its own page, a dashboard view and a workbench view, either of which can
	 * be taken out of the window (windowImpl.ts: sign-out and Back to Dashboard take the workbench
	 * out; a room that's ready puts it back). The workbench getter behaves as windowImpl's does.
	 */
	function liveCollabWindow(first: number) {
		const page = new Contents(first);
		const dashboard = new Contents(first + 1);
		const workbench = new Contents(first + 2);
		const state = { attached: [workbench, dashboard] as Contents[], windowDestroyed: false };
		const window: ILiveCollabFileAccessWindow = {
			webContents: page,
			get attachedViews() { return state.attached; },
		};
		const codeWindow: ILiveCollabFileAccessCodeWindow = {
			get workbenchWebContents() { return state.windowDestroyed || workbench.isDestroyed() ? undefined : workbench; },
		};
		return { page, dashboard, workbench, state, window, codeWindow };
	}

	test('a window\'s own workbench may load files while it is out of the window (signed out, or on the dashboard before its first room); nothing else gains access', () => {
		const one = liveCollabWindow(100);
		const two = liveCollabWindow(200);
		const windows = [one.window, two.window];
		const codeWindows = [one.codeWindow, two.codeWindow];
		const allowed = (processId: number) => isLiveCollabAppFrame(processId, windows, codeWindows);

		const attached = { page: allowed(100), dashboard: allowed(101), workbench: allowed(102) };
		// Sign-out (in this window or another; it reaches every window) shows the dashboard: the workbench leaves the window.
		one.state.attached = [one.dashboard];
		const signedOut = { workbench: allowed(102), dashboard: allowed(101) };
		// Entering a room: the workbench is ready before it's shown, so the dashboard leaves.
		one.state.attached = [one.workbench];
		const inRoom = { workbench: allowed(102), dashboardOutOfWindow: allowed(101) };
		// Not the app's: a webview or an iframe in its own process.
		const unrelated = allowed(999);
		// A workbench that was destroyed, and a window that was closed (destroyed: the getter answers nothing).
		two.state.attached = [two.dashboard];
		two.workbench.destroyed = true;
		const destroyedWorkbench = allowed(202);
		one.state.attached = [];
		one.state.windowDestroyed = true;
		const closedWindow = allowed(102);

		assert.deepStrictEqual({ attached, signedOut, inRoom, unrelated, destroyedWorkbench, closedWindow }, {
			attached: { page: true, dashboard: true, workbench: true },
			signedOut: { workbench: true, dashboard: true },
			inRoom: { workbench: true, dashboardOutOfWindow: false },
			unrelated: false,
			destroyedWorkbench: false,
			closedWindow: false,
		});
	});
});
