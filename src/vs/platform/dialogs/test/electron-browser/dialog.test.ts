/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IProductService } from '../../../product/common/productService.js';
import { createNativeAboutDialogDetails } from '../../electron-browser/dialog.js';

suite('Native About dialog (LiveCollab)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the About window shows LiveCollab\'s version from product.json, never VS Code\'s (Manny, 2026-11-18)', () => {
		const product = { nameLong: 'LiveCollab', version: '1.124.0', livecollabVersion: '0.3.6', commit: 'abc1234', date: undefined } as unknown as IProductService;
		const os = { type: 'Darwin', release: '27.0.0', arch: 'arm64', platform: 'darwin', cpus: [] };
		const { title, details, detailsToCopy } = createNativeAboutDialogDetails(product, os);
		const version = (text: string) => text.split('\n')[0];
		assert.deepStrictEqual({ title, shown: version(details), copied: version(detailsToCopy) }, { title: 'LiveCollab', shown: 'Version: 0.3.6', copied: 'Version: 0.3.6' });
	});
});
