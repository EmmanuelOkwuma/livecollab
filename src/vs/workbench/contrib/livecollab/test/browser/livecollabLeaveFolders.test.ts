/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { NullPolicyService } from '../../../../../platform/policy/common/policy.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { FileUserDataProvider } from '../../../../../platform/userData/common/fileUserDataProvider.js';
import { UserDataProfilesService } from '../../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent, toWorkspaceFolder, Workspace } from '../../../../../platform/workspace/common/workspace.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { WorkspaceService } from '../../../../services/configuration/browser/configurationService.js';
import { IConfigurationCache } from '../../../../services/configuration/common/configuration.js';
import { IJSONEditingService } from '../../../../services/configuration/common/jsonEditing.js';
import { JSONEditingService } from '../../../../services/configuration/common/jsonEditingService.js';
import { RemoteAgentService } from '../../../../services/remote/browser/remoteAgentService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { TextModelResolverService } from '../../../../services/textmodelResolver/common/textModelResolverService.js';
import { UserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfileService.js';
import { TestEnvironmentService, TestTextFileService, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { whenFoldersLeave } from '../../browser/livecollabLeaveFolders.js';

const ROOT = URI.file('tests').with({ scheme: 'vscode-tests' });

class NoConfigurationCache implements IConfigurationCache {
	needsCaching(): boolean { return false; }
	async read(): Promise<string> { return ''; }
	async write(): Promise<void> { }
	async remove(): Promise<void> { }
}

suite('LiveCollab: folders closed by a room\'s leave, with the workbench\'s WorkspaceService', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('deleting the window\'s workspace file closes the folder open beside the room\'s a moment later; whenFoldersLeave sees it go', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const logService = new NullLogService();
		const fileService = disposables.add(new FileService(logService));
		const provider = disposables.add(new InMemoryFileSystemProvider());
		disposables.add(fileService.registerProvider(ROOT.scheme, provider));
		const room = joinPath(ROOT, 'leave-shared');
		const local = joinPath(ROOT, 'leave-local');
		// The window's untitled workspace, as a desktop window has once a folder is open.
		const configuration = joinPath(ROOT, 'Workspaces', '1', 'workspace.json');
		await fileService.createFolder(joinPath(ROOT, 'user'));
		await fileService.createFolder(room);
		await fileService.createFolder(local);
		await fileService.writeFile(joinPath(local, 'b.txt'), VSBuffer.fromString('b'));
		await fileService.writeFile(configuration, VSBuffer.fromString(JSON.stringify({ folders: [{ path: room.path }, { path: local.path }] })));

		const instantiationService = workbenchInstantiationService(undefined, disposables);
		const remoteAgentService = disposables.add(instantiationService.createInstance(RemoteAgentService));
		const uriIdentityService = disposables.add(new UriIdentityService(fileService));
		const profiles = disposables.add(new UserDataProfilesService(TestEnvironmentService, fileService, uriIdentityService, logService));
		disposables.add(fileService.registerProvider(Schemas.vscodeUserData, disposables.add(new FileUserDataProvider(ROOT.scheme, provider, Schemas.vscodeUserData, profiles, uriIdentityService, logService))));
		const workspace = disposables.add(new WorkspaceService({ configurationCache: new NoConfigurationCache() }, TestEnvironmentService, disposables.add(new UserDataProfileService(profiles.defaultProfile)), profiles, fileService, remoteAgentService, uriIdentityService, logService, new NullPolicyService()));
		instantiationService.stub(IFileService, fileService);
		instantiationService.stub(IWorkspaceContextService, workspace);
		instantiationService.stub(IConfigurationService, workspace);
		await workspace.initialize({ id: 'room-window', configPath: configuration });
		instantiationService.stub(ITextFileService, disposables.add(instantiationService.createInstance(TestTextFileService)));
		instantiationService.stub(ITextModelService, disposables.add(instantiationService.createInstance(TextModelResolverService)));
		instantiationService.stub(IJSONEditingService, instantiationService.createInstance(JSONEditingService));
		workspace.acquireInstantiationService(instantiationService);
		const open = () => workspace.getWorkspace().folders.map(folder => basename(folder.uri));
		const beside = workspace.getWorkspace().folders.filter(folder => basename(folder.uri) === 'leave-local');

		// The leave (livecollabFolderContribution.ts, _leaveRoom): the room's folder removed, then the workspace file deleted.
		await workspace.removeFolders([room]);
		await fileService.del(configuration);
		const rightAfterDelete = open();
		const closed = await whenFoldersLeave(workspace, beside, 10_000, CancellationToken.None);

		assert.deepStrictEqual({
			rightAfterDelete,
			closed: closed.map(folder => basename(folder.uri)),
			after: open(),
			fileKept: (await fileService.readFile(joinPath(local, 'b.txt'))).value.toString(),
		}, {
			rightAfterDelete: ['leave-local'],
			closed: ['leave-local'],
			after: [],
			fileKept: 'b',
		});
	}));

	test('the wait is 10 seconds: only folders seen to close within it are named; one that closes later, or never, isn\'t', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const changed = disposables.add(new Emitter<IWorkspaceFoldersChangeEvent>());
		const workspace = new Workspace('room-window', ['one', 'two', 'three'].map(name => toWorkspaceFolder(joinPath(ROOT, name))), false, null, () => false);
		const context = { getWorkspace: () => workspace, onDidChangeWorkspaceFolders: changed.event } as Pick<IWorkspaceContextService, 'getWorkspace' | 'onDidChangeWorkspaceFolders'> as IWorkspaceContextService;
		const close = (name: string) => {
			const removed = workspace.folders.filter(folder => basename(folder.uri) === name);
			workspace.folders = workspace.folders.filter(folder => basename(folder.uri) !== name);
			changed.fire({ added: [], removed, changed: [] });
		};
		const [one, two, three] = workspace.folders;
		// "one" closes after 3 seconds, "two" after 12 (past the wait), "three" never.
		const some = whenFoldersLeave(context, [one, two, three], 10_000, CancellationToken.None);
		setTimeout(() => close('one'), 3_000);
		setTimeout(() => close('two'), 12_000);
		const named = (await some).map(folder => basename(folder.uri));
		// None closes within the wait.
		const none = await whenFoldersLeave(context, [three], 10_000, CancellationToken.None);
		assert.deepStrictEqual({ named, none: none.map(folder => basename(folder.uri)), openAfter: workspace.folders.map(folder => basename(folder.uri)) }, {
			named: ['one'],
			none: [],
			openAfter: ['three'],
		});
	}));
});
