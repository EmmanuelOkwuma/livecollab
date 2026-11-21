/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The one Yjs binding an editor holds, together with the model it was made
 * for. An editor widget is reused across files and room sessions, so "holds
 * a binding" is not the same as "the model on screen is bound": the editor
 * used to keep the previous model's binding after a skipped bind (no id yet,
 * not seeded), and its retries — gated on holding no binding at all — never
 * ran again (HANDOFF, "an editor that was ever bound never re-binds after a
 * skip", seen on hardware 2026-10-11). Gate on the model instead.
 */
export class LiveCollabBindingSlot<TModel, TBinding extends { destroy(): void }> {

	private _binding: TBinding | undefined;
	private _model: TModel | undefined;

	/** Whether the binding held is the one for `model`. */
	isBoundTo(model: TModel | null | undefined): boolean {
		return !!this._binding && model !== null && model !== undefined && this._model === model;
	}

	/** Destroys the binding held unless it was made for `model`. */
	releaseUnless(model: TModel | null | undefined): void {
		if (this._binding && !this.isBoundTo(model)) {
			this.dispose();
		}
	}

	/** Holds `binding` for `model`, destroying any binding held before. */
	set(model: TModel, binding: TBinding): void {
		this.dispose();
		this._binding = binding;
		this._model = model;
	}

	dispose(): void {
		const binding = this._binding;
		this._binding = undefined;
		this._model = undefined;
		binding?.destroy();
	}
}
