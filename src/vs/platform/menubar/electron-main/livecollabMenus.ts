/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AboutPanelOptionsOptions, MenuItemConstructorOptions } from 'electron';
import { localize } from '../../../nls.js';
import { isMenubarMenuItemSeparator, MenubarMenuItem } from '../common/menubar.js';

/**
 * Where macOS's menu bar takes its menus from: the app's own menus
 * (`liveCollabAppMenuTemplate`), or the menus a room's workbench sends.
 */
export type LiveCollabMenuSource = 'app' | 'workbench';

/**
 * Which menus the menu bar shows (macOS). The workbench's menus arrive only
 * from a room's workbench, and only once it is in front and focused: the sign-in
 * page and the dashboard (livecollab-bootstrap.html) are not the workbench and
 * send none, and while they are in front a command from the workbench's menus
 * is dropped (`CodeWindow.send`). Until 0.3.7 an install that had never opened
 * a room therefore had no menus at all, so paste, Command-Q and About did
 * nothing there. The app's own menus show unless the workbench is in front and
 * has sent its menus.
 */
export function liveCollabMenuSource(hasWorkbenchMenus: boolean, workbenchInFront: boolean): LiveCollabMenuSource {
	return hasWorkbenchMenus && workbenchInFront ? 'workbench' : 'app';
}

/**
 * The app's own menus (macOS), for the sign-in page and the dashboard: a
 * LiveCollab menu and an Edit menu, made only of Electron's standard roles so
 * that they work in any page without the workbench.
 */
export function liveCollabAppMenuTemplate(productName: string): MenuItemConstructorOptions[] {
	return [
		{
			label: productName,
			submenu: [
				{ role: 'about', label: localize('mAbout', "About {0}", productName) },
				{ type: 'separator' },
				{ role: 'hide', label: localize('mHide', "Hide {0}", productName) },
				{ role: 'hideOthers', label: localize('mHideOthers', "Hide Others") },
				{ role: 'unhide', label: localize('mShowAll', "Show All") },
				{ type: 'separator' },
				{ role: 'quit', label: localize('miQuit', "Quit {0}", productName) },
			]
		},
		{
			label: localize('mEdit', "Edit"),
			submenu: [
				{ role: 'undo', label: localize('mUndo', "Undo") },
				{ role: 'redo', label: localize('mRedo', "Redo") },
				{ type: 'separator' },
				{ role: 'cut', label: localize('mCut', "Cut") },
				{ role: 'copy', label: localize('mCopy', "Copy") },
				{ role: 'paste', label: localize('mPaste', "Paste") },
				{ role: 'selectAll', label: localize('mSelectAll', "Select All") },
			]
		},
	];
}

/**
 * What the standard About panel (the `about` role) shows: LiveCollab's own
 * version from product.json and the commit. Left to itself it reads the app
 * bundle's version, which is VS Code's.
 */
export function liveCollabAboutPanelOptions(product: { readonly nameLong: string; readonly livecollabVersion?: string; readonly commit?: string }): AboutPanelOptionsOptions {
	return {
		applicationName: product.nameLong,
		applicationVersion: product.livecollabVersion ?? 'Unknown',
		version: product.commit ? product.commit.substring(0, 7) : 'Unknown',
	};
}

const toggleDevToolsCommandId = 'workbench.action.toggleDevTools';

/**
 * A menu's items as a build may show them: a release build, where DevTools are
 * off (`isLiveCollabDevToolsAllowed`), leaves out Toggle Developer Tools, and any
 * separator that would then lead, trail or double up.
 */
export function liveCollabReleaseMenuItems(items: MenubarMenuItem[], devToolsAllowed: boolean): MenubarMenuItem[] {
	if (devToolsAllowed) {
		return items;
	}
	const result: MenubarMenuItem[] = [];
	for (const item of items) {
		if (item.id === toggleDevToolsCommandId) {
			continue;
		}
		if (isMenubarMenuItemSeparator(item) && (result.length === 0 || isMenubarMenuItemSeparator(result[result.length - 1]))) {
			continue;
		}
		result.push(item);
	}
	while (result.length > 0 && isMenubarMenuItemSeparator(result[result.length - 1])) {
		result.pop();
	}
	return result;
}
