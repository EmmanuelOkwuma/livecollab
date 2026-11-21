/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { ILiveCollabClaimRequest, ILiveCollabClaimResult, ILiveCollabFolderClaims, ILiveCollabFolderOverlaps, ILiveCollabKnownFolder } from '../../../../platform/windows/common/livecollabFolderClaims.js';
import { LiveCollabFileSystemProvider, livecollabFileSystemProvider } from './livecollabFileSystemProvider.js';
import { LiveCollabService, livecollabService } from './livecollabService.js';

export const ILiveCollabClient = createDecorator<ILiveCollabClient>('liveCollabClient');

/**
 * One LiveCollab client: its room service and its virtual file system.
 *
 * In the app there is one client per window, and it hands out the module
 * singletons. Layer B's harness runs several clients in one process and gives
 * each its own. Files that B's tests reach take this service instead of
 * importing the singletons (TEST_HARNESS_TRIAGE.md, "The client seam";
 * enforced by `test/node/livecollabClientSeam.test.ts`).
 */
export interface ILiveCollabClient {
	readonly _serviceBrand: undefined;
	readonly service: LiveCollabService;
	readonly fileSystem: LiveCollabFileSystemProvider;
	/** This computer's record of which folder each of the owner's rooms shares (one for every window). */
	readonly folderClaims: ILiveCollabFolderClaims;
}

/**
 * The computer's record, kept by the main process (livecollabWindowNavigation.ts). A request main
 * refuses or can't answer rejects, and the window then shares nothing.
 */
class MainFolderClaims implements ILiveCollabFolderClaims {
	private async _invoke<T>(channel: string, request: object): Promise<T> {
		const ipc = (mainWindow as unknown as { vscode?: { ipcRenderer?: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } } }).vscode?.ipcRenderer;
		if (!ipc) {
			throw new Error('no main process to ask');
		}
		const answer = await ipc.invoke(channel, request);
		if (answer === null || answer === undefined) {
			throw new Error(`${channel} was refused`);
		}
		return answer as T;
	}
	overlaps(path: string, roomId: string, known?: readonly ILiveCollabKnownFolder[]): Promise<ILiveCollabFolderOverlaps> {
		return this._invoke('vscode:livecollab-folder-overlaps', { path, roomId, known });
	}
	claim(request: ILiveCollabClaimRequest): Promise<ILiveCollabClaimResult> {
		return this._invoke('vscode:livecollab-folder-claim', request);
	}
	async release(roomId: string): Promise<void> {
		await this._invoke('vscode:livecollab-folder-release', { roomId });
	}
}

/** A client made from a room service and a virtual file system. */
export class LiveCollabClient implements ILiveCollabClient {
	declare readonly _serviceBrand: undefined;

	constructor(
		readonly service: LiveCollabService,
		readonly fileSystem: LiveCollabFileSystemProvider,
		readonly folderClaims: ILiveCollabFolderClaims,
	) { }
}

// The window's client is the module singletons, so the app is unchanged.
registerSingleton(ILiveCollabClient, new SyncDescriptor(LiveCollabClient, [livecollabService, livecollabFileSystemProvider, new MainFolderClaims()]));
