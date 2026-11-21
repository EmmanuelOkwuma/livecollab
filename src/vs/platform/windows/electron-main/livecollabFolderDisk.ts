/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { dirname } from '../../../base/common/path.js';
import { ILiveCollabClaimStore, ILiveCollabFolderClaim, ILiveCollabFolderDisk } from '../common/livecollabFolderClaims.js';
import { IStateService } from '../../state/node/state.js';

/** This computer's folders, compared by device and inode: what the volume itself says is one folder. */
export const liveCollabFolderDisk: ILiveCollabFolderDisk = {
	async realpath(path) {
		try {
			return await fs.realpath(path);
		} catch {
			return undefined;
		}
	},
	async identity(path) {
		try {
			const stat = await fs.stat(path, { bigint: true });
			return `${stat.dev}:${stat.ino}`;
		} catch {
			return undefined;
		}
	},
	parent(path) {
		const parent = dirname(path);
		return parent === path ? undefined : parent;
	},
};

const CLAIMS_KEY = 'livecollab.folderClaims';

/** The records, in the main process's state file, kept across launches. */
export function liveCollabClaimStore(stateService: IStateService): ILiveCollabClaimStore {
	return {
		load: () => {
			const saved = stateService.getItem<unknown>(CLAIMS_KEY);
			return Array.isArray(saved) ? saved.filter((claim): claim is ILiveCollabFolderClaim => typeof claim?.roomId === 'string' && typeof claim?.path === 'string') : [];
		},
		save: claims => stateService.setItem(CLAIMS_KEY, claims),
	};
}
