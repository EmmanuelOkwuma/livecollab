/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../base/common/resources.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';

/**
 * Waits until each of `folders` has left the window's workspace, `within` milliseconds pass or
 * `token` is cancelled, and returns those that left. A room's leave deletes the window's untitled
 * workspace file; the workbench then reads the missing file as having no folders, so every folder
 * still open closes, a moment later and without saying so (configuration.ts,
 * FileServiceBasedWorkspaceConfiguration.load).
 */
export function whenFoldersLeave(contextService: IWorkspaceContextService, folders: readonly IWorkspaceFolder[], within: number, token: CancellationToken): Promise<IWorkspaceFolder[]> {
	const isOpen = (folder: IWorkspaceFolder) => contextService.getWorkspace().folders.some(open => isEqual(open.uri, folder.uri));
	const left = () => folders.filter(folder => !isOpen(folder));
	if (left().length === folders.length) {
		return Promise.resolve(left());
	}
	return new Promise(resolve => {
		const store = new DisposableStore();
		const done = () => {
			store.dispose();
			resolve(left());
		};
		store.add(contextService.onDidChangeWorkspaceFolders(() => {
			if (left().length === folders.length) {
				done();
			}
		}));
		store.add(token.onCancellationRequested(done));
		const timer = setTimeout(done, within);
		store.add(toDisposable(() => clearTimeout(timer)));
	});
}
