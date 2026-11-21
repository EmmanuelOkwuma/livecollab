/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { localize } from '../../../../nls.js';

/**
 * A neutral "Opening room…" cover over the whole workbench. The workbench is
 * only ever on screen in a room, and between entering a room and the room's
 * own content being in place it holds whatever it last had — empty views, or
 * another room's state restored at launch (STATUS: the empty-state flash,
 * flash 2). The cover is up from startup and whenever a room is left, and is
 * lifted once the room is ready, so neither ever shows.
 */
class LiveCollabRoomCover {

	private element: HTMLElement | undefined;

	show(): void {
		const doc = mainWindow.document;
		if (!this.element) {
			const cover = doc.createElement('div');
			cover.className = 'livecollab-room-cover';
			cover.style.cssText = 'position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:var(--vscode-editor-background, #1e1e1e);color:var(--vscode-descriptionForeground, #9d9d9d);font-size:13px;';
			cover.textContent = localize('livecollab.openingRoom', "Opening room…");
			this.element = cover;
		}
		if (!this.element.isConnected && doc.body) {
			doc.body.appendChild(this.element);
		}
	}

	hide(): void {
		this.element?.remove();
	}
}

export const livecollabRoomCover = new LiveCollabRoomCover();
