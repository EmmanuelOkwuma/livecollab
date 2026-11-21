/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A page's contents, as far as the vscode-file:// check reads them. */
export interface ILiveCollabFrameOwner {
	readonly mainFrame: { readonly processId: number };
	isDestroyed(): boolean;
}

/** An Electron window, as far as the vscode-file:// check reads it. */
export interface ILiveCollabFileAccessWindow {
	/** The window's own page. */
	readonly webContents: ILiveCollabFrameOwner;
	/** The views attached to the window now (LiveCollab: the dashboard and/or the workbench). */
	readonly attachedViews: readonly ILiveCollabFrameOwner[];
}

/** A code window, as far as the vscode-file:// check reads it. */
export interface ILiveCollabFileAccessCodeWindow {
	/** The window's own workbench, attached or not; undefined once it or its window is destroyed (windowImpl.ts). */
	readonly workbenchWebContents: ILiveCollabFrameOwner | undefined;
}

function isFrom(contents: ILiveCollabFrameOwner | undefined, processId: number): boolean {
	return !!contents && !contents.isDestroyed() && contents.mainFrame.processId === processId;
}

/**
 * Whether a vscode-file:// request from the frame in `processId` comes from one of the app's own
 * pages: a window's page, a view attached to it, or a live window's own workbench while it's out of
 * the window. Sign-out and Back to Dashboard take the workbench out, and a room's workbench is put
 * back only once the room is ready, so a workbench that hadn't connected before a sign-out loads its
 * socket library while out of the window; refused, its room never opened (walkthrough, 2026-11-14).
 * No other view out of a window counts. Embedded content (webviews, iframes) runs in other
 * processes and is refused.
 */
export function isLiveCollabAppFrame(processId: number, windows: readonly ILiveCollabFileAccessWindow[], codeWindows: readonly ILiveCollabFileAccessCodeWindow[]): boolean {
	for (const window of windows) {
		if (isFrom(window.webContents, processId)) {
			return true;
		}
		for (const view of window.attachedViews) {
			if (isFrom(view, processId)) {
				return true;
			}
		}
	}
	return codeWindows.some(window => isFrom(window.workbenchWebContents, processId));
}
