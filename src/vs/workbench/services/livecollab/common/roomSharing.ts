/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Where a resource is shared with the window's room: the room's shared folder holding it, and the
 * room's name.
 */
export interface IRoomSharedLocation {
	readonly folderName: string;
	readonly roomName: string;
}

export const IRoomSharingService = createDecorator<IRoomSharingService>('roomSharingService');

/**
 * The room's answers, provided by the room's code.
 */
export interface IRoomSharingProvider {
	isInRoom(): boolean;
	sharedLocationOf(resource: URI): IRoomSharedLocation | undefined;
}

/**
 * LiveCollab: lets workbench features say whether the window is in a room (an editor-area drop of
 * several folders) and whether a folder is shared with it (the Explorer's Copy Folders). The room's
 * code provides the answers; without it the window is in no room and nothing is shared.
 */
export interface IRoomSharingService {
	readonly _serviceBrand: undefined;

	/** Whether the window is in a room, whether or not the room shares a folder yet. */
	isInRoom(): boolean;

	/** The room's shared folder containing `resource` (or being it), if the window is in a room that shares one. */
	sharedLocationOf(resource: URI): IRoomSharedLocation | undefined;

	/** Sets the provider of the answers, until the returned disposable is disposed. */
	setProvider(provider: IRoomSharingProvider): IDisposable;
}

class RoomSharingService implements IRoomSharingService {
	declare readonly _serviceBrand: undefined;

	private _provider: IRoomSharingProvider | undefined;

	isInRoom(): boolean {
		return this._provider?.isInRoom() ?? false;
	}

	sharedLocationOf(resource: URI): IRoomSharedLocation | undefined {
		return this._provider?.sharedLocationOf(resource);
	}

	setProvider(provider: IRoomSharingProvider): IDisposable {
		this._provider = provider;
		return toDisposable(() => {
			if (this._provider === provider) {
				this._provider = undefined;
			}
		});
	}
}

registerSingleton(IRoomSharingService, RoomSharingService, InstantiationType.Delayed);
