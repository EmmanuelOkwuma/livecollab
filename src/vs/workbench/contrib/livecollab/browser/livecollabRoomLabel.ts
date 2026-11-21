/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { livecollabService } from './livecollabService.js';

/**
 * The root of the Explorer is the room: a room window is always an untitled
 * workspace, so while a room is active its label ("Untitled (Workspace)", also
 * the title bar's root name) is the room's name. Outside a room the default
 * label applies again.
 */
export class LiveCollabRoomLabelContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.livecollabRoomLabel';

	private readonly roomLabel = this._register(new MutableDisposable());

	constructor(
		@ILabelService private readonly labelService: ILabelService,
	) {
		super();

		this._register(livecollabService.onRoomJoined(() => this.update()));
		this._register(livecollabService.onRoomLeft(() => this.roomLabel.clear()));
		this.update();
	}

	private update(): void {
		const roomName = livecollabService.roomId ? livecollabService.roomName : undefined;
		this.roomLabel.value = roomName ? this.labelService.registerUntitledWorkspaceLabel(roomName) : undefined;
	}
}
