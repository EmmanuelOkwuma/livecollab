/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { LiveCollabBindingSlot } from '../../browser/livecollabBindingSlot.js';

suite('LiveCollab binding slot (an editor re-binds after a skipped bind)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	interface IFakeBinding { readonly model: string; destroyed: boolean; destroy(): void }
	function binding(model: string): IFakeBinding {
		return { model, destroyed: false, destroy() { this.destroyed = true; } };
	}

	test('after the model changes and the bind is skipped, the retry is allowed (room re-entry)', () => {
		const slot = new LiveCollabBindingSlot<string, IFakeBinding>();
		const first = binding('README.md (first session)');
		slot.set('README.md (first session)', first);

		// The restored editor shows a new model; its bind is skipped (no id yet).
		slot.releaseUnless('README.md (re-entered)');
		// Ids arrive: the retry gate must open for the model now shown.
		const retryAllowed = !slot.isBoundTo('README.md (re-entered)');

		assert.deepStrictEqual({ retryAllowed, oldBindingDestroyed: first.destroyed }, { retryAllowed: true, oldBindingDestroyed: true });
	});

	test('the same model keeps its binding, and retries stay closed', () => {
		const slot = new LiveCollabBindingSlot<string, IFakeBinding>();
		const only = binding('a.txt');
		slot.set('a.txt', only);

		slot.releaseUnless('a.txt');

		assert.deepStrictEqual({ retryAllowed: !slot.isBoundTo('a.txt'), destroyed: only.destroyed }, { retryAllowed: false, destroyed: false });
	});

	test('binding again replaces the previous binding (two calls in flight, :74/:118)', () => {
		const slot = new LiveCollabBindingSlot<string, IFakeBinding>();
		const first = binding('a.txt');
		const second = binding('a.txt');

		slot.set('a.txt', first);
		slot.set('a.txt', second);
		slot.dispose();

		assert.deepStrictEqual({ first: first.destroyed, second: second.destroyed }, { first: true, second: true });
	});
});
