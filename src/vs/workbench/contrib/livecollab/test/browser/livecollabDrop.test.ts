/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CodeDataTransfers } from '../../../../../platform/dnd/browser/dnd.js';
import { IFileService, IFileStatWithMetadata } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IWorkspaceContextService, toWorkspaceFolder, Workspace } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceFolderCreationData, IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';
import { ResourcesDropHandler } from '../../../../browser/dnd.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IRoomSharingService } from '../../../../services/livecollab/common/roomSharing.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';

suite('LiveCollab: folders dropped on the editor area', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	/** Drops l-two and l-three from Finder on the editor area of a window that has l-one open; returns what the workspace service was asked and the folders open after. */
	async function dropTwoFolders(inRoom: boolean) {
		// A window's untitled workspace (Workspaces/<id>/workspace.json), with l-one open.
		const workspace = new Workspace('window', [toWorkspaceFolder(URI.file('/rooms/l-one'))], false, URI.file('/user-data/Workspaces/1/workspace.json'), () => false);
		const calls: string[] = [];
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(IInstantiationService, instantiationService);
		instantiationService.stub(IWorkspaceContextService, { getWorkspace: () => workspace });
		instantiationService.stub(IWorkspaceEditingService, {
			addFolders: async (folders: IWorkspaceFolderCreationData[]) => {
				calls.push('addFolders');
				workspace.folders = [...workspace.folders, ...folders.map(folder => toWorkspaceFolder(folder.uri))];
			},
			createAndEnterWorkspace: async (folders: IWorkspaceFolderCreationData[]) => {
				calls.push('createAndEnterWorkspace');
				workspace.folders = folders.map(folder => toWorkspaceFolder(folder.uri));
				return undefined;
			},
		});
		instantiationService.stub(IFileService, { stat: async (resource: URI) => ({ resource, isDirectory: true }) as IFileStatWithMetadata });
		instantiationService.stub(IHostService, { focus: async () => { }, openWindow: async () => { calls.push('openWindow'); } });
		instantiationService.stub(IWorkspacesService, { addRecentlyOpened: async () => { } });
		instantiationService.stub(IEditorService, { openEditors: async () => [] });
		instantiationService.stub(IRoomSharingService, { isInRoom: () => inRoom, sharedLocationOf: () => undefined });

		const dataTransfer = new DataTransfer();
		dataTransfer.setData(CodeDataTransfers.FILES, JSON.stringify(['/drops/l-two', '/drops/l-three']));
		await instantiationService.createInstance(ResourcesDropHandler, { allowWorkspaceOpen: true }).handleDrop(new DragEvent('drop', { dataTransfer }), mainWindow);
		return { calls, open: workspace.folders.map(folder => basename(folder.uri)) };
	}

	test('several folders dropped on a room window\'s editor area are added to it: the room\'s folder stays open, the window stays in its workspace', async () => {
		// In a room, sharing l-one, or in an empty room with l-one open but not shared yet: the same.
		assert.deepStrictEqual(await dropTwoFolders(true), {
			calls: ['addFolders'],
			open: ['l-one', 'l-two', 'l-three'],
		});
	});

	test('outside a room, several folders dropped on the editor area do what VS Code does: a new workspace with them', async () => {
		assert.deepStrictEqual(await dropTwoFolders(false), {
			calls: ['createAndEnterWorkspace'],
			open: ['l-two', 'l-three'],
		});
	});
});
