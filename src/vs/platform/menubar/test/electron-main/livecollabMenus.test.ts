/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { MenuItemConstructorOptions } from 'electron';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { MenubarMenuItem } from '../../common/menubar.js';
import { liveCollabAboutPanelOptions, liveCollabAppMenuTemplate, liveCollabMenuSource, liveCollabReleaseMenuItems } from '../../electron-main/livecollabMenus.js';

suite('LiveCollab app menus (macOS): the sign-in page and the dashboard have a LiveCollab and an Edit menu from the first launch (Manny, 2026-11-19, 0.3.7)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** A template as its menu names, each with its items' roles (or "-" for a separator). */
	function outline(template: MenuItemConstructorOptions[]): Record<string, string[]> {
		const result: Record<string, string[]> = {};
		for (const menu of template) {
			const items = Array.isArray(menu.submenu) ? menu.submenu : [];
			result[String(menu.label)] = items.map(item => item.type === 'separator' ? '-' : String(item.role));
		}
		return result;
	}

	test('the app\'s own menus: LiveCollab (About, Hide, Quit) and Edit (Undo, Redo, Cut, Copy, Paste, Select All), all Electron\'s standard roles, so paste, Command-Q and About work without the workbench', () => {
		assert.deepStrictEqual(outline(liveCollabAppMenuTemplate('LiveCollab')), {
			'LiveCollab': ['about', '-', 'hide', 'hideOthers', 'unhide', '-', 'quit'],
			'Edit': ['undo', 'redo', '-', 'cut', 'copy', 'paste', 'selectAll'],
		});
	});

	test('the app\'s menus show on a fresh install (no workbench menus yet), on the sign-in page and dashboard (workbench behind them), and in a room before its workbench sends menus; a room\'s workbench menus take over only while it is in front', () => {
		const cases = [
			{ hasWorkbenchMenus: false, workbenchInFront: false },
			{ hasWorkbenchMenus: true, workbenchInFront: false },
			{ hasWorkbenchMenus: false, workbenchInFront: true },
			{ hasWorkbenchMenus: true, workbenchInFront: true },
		];
		assert.deepStrictEqual(cases.map(c => liveCollabMenuSource(c.hasWorkbenchMenus, c.workbenchInFront)), ['app', 'app', 'app', 'workbench']);
	});

	test('About shows LiveCollab\'s version from product.json and the commit, never VS Code\'s', () => {
		assert.deepStrictEqual(
			[
				liveCollabAboutPanelOptions({ nameLong: 'LiveCollab', livecollabVersion: '0.3.7', commit: 'e523918296717c65b5fa2654539e28f74e29bdd7' }),
				liveCollabAboutPanelOptions({ nameLong: 'LiveCollab', livecollabVersion: undefined, commit: undefined }),
			],
			[
				{ applicationName: 'LiveCollab', applicationVersion: '0.3.7', version: 'e523918' },
				{ applicationName: 'LiveCollab', applicationVersion: 'Unknown', version: 'Unknown' },
			]
		);
	});

	test('a release build\'s menus have no Toggle Developer Tools (and no separator left dangling); a dev build keeps it', () => {
		const help: MenubarMenuItem[] = [
			{ id: 'workbench.action.openIssueReporter', label: 'Report Issue' },
			{ id: 'vscode.menubar.separator' },
			{ id: 'workbench.action.toggleDevTools', label: 'Toggle Developer Tools' },
			{ id: 'vscode.menubar.separator' },
			{ id: 'workbench.action.showAboutDialog', label: 'About' },
		];
		const onlyDevTools: MenubarMenuItem[] = [
			{ id: 'vscode.menubar.separator' },
			{ id: 'workbench.action.toggleDevTools', label: 'Toggle Developer Tools' },
		];
		const ids = (items: MenubarMenuItem[]) => items.map(item => item.id);
		assert.deepStrictEqual({
			release: ids(liveCollabReleaseMenuItems(help, false)),
			releaseOnlyDevTools: ids(liveCollabReleaseMenuItems(onlyDevTools, false)),
			dev: ids(liveCollabReleaseMenuItems(help, true)),
		}, {
			release: ['workbench.action.openIssueReporter', 'vscode.menubar.separator', 'workbench.action.showAboutDialog'],
			releaseOnlyDevTools: [],
			dev: ids(help),
		});
	});
});
