/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, markAsSingleton } from '../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { LiveCollabService } from './livecollabService.js';
import { createMonacoBaseAPI } from '../../../../editor/common/services/editorBaseApi.js';
import { LIVECOLLAB_SCHEME, LiveCollabFileSystemProvider } from './livecollabFileSystemProvider.js';
import { ILiveCollabClient } from './livecollabClient.js';
import { LiveCollabBindingSlot } from './livecollabBindingSlot.js';
import { mergeIntoRoomText } from './livecollabBindMerge.js';
import { lcLog } from './livecollabLog.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { localize } from '../../../../nls.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOutputService } from '../../../services/output/common/output.js';
import { windowLogId } from '../../../services/log/common/logConstants.js';
// Type-only reference (no runtime import triggered) - the actual
// runtime class is loaded via livecollabService.getMonacoBindingClass(),
// see that file's own comments for the full reasoning (yjs/y-monaco
// don't ship UMD, importAMDNodeModule can't load them - real root cause
// traced via a live two-machine test failure, see PHASE3_YJS_DESIGN.md
// sections 5-6). This file's own real, NEW responsibility: y-monaco's
// bundled code expects to import the standalone 'monaco-editor' npm
// package (which this fork doesn't use - it IS Monaco internally,
// structured differently). Our vendor bundle's build step redirects
// that unresolvable import to a small shim
// (vendor/_livecollab-monaco-shim.mjs) that reads real values from
// globalThis.__livecollabMonacoAPI - set here, once, at module load,
// using this codebase's OWN createMonacoBaseAPI(), which builds an
// object with the exact shape needed using this codebase's own real,
// live Range/Selection/SelectionDirection classes (confirmed via
// source inspection before writing this - not a guess). MUST run here,
// synchronously, at module top-level - before ANY code path in this
// file could trigger the vendor bundle's dynamic import, since the
// shim reads this global at module-evaluation time, not lazily.
type YMonacoBinding = InstanceType<typeof import('y-monaco').MonacoBinding>;
type YDocument = InstanceType<typeof import('yjs').Doc>;
type YText = InstanceType<typeof import('yjs').Text>;

/** How often an editor checks that its file is still in sync with the room. */
const SYNC_CHECK_INTERVAL_MS = 3000;
/** Consecutive failed checks before the person is told (one may be in flight). */
const SYNC_CHECK_FAILURES_TO_REPORT = 2;
/** Files already reported out of sync, per room session ("epoch:fileId"), across a client's editors. */
const reportedOutOfSync = new WeakMap<LiveCollabService, Set<string>>();

/** One client's reported set, registered with its room service the first time an editor asks. */
function reportedOutOfSyncFor(service: LiveCollabService): Set<string> {
	let reported = reportedOutOfSync.get(service);
	if (!reported) {
		const created = new Set<string>();
		// Room-session state (IRoomStateOwner), registered for the life of the
		// client like the set itself: never unregistered, by design, so marked
		// as such for the leak tracker (layer B's leak check found it unmarked).
		markAsSingleton(service.registerRoomState({
			name: 'out-of-sync notices shown',
			clear: () => created.clear(),
			inspect: () => created.size ? [`${created.size} files`] : [],
		}));
		reportedOutOfSync.set(service, created);
		reported = created;
	}
	return reported;
}

/** Text as the room compares it: no BOM, one line-ending style (Monaco normalizes both). */
function comparableText(text: string): string {
	return (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text).replace(/\r\n?/g, '\n');
}
(globalThis as unknown as { __livecollabMonacoAPI: unknown }).__livecollabMonacoAPI = createMonacoBaseAPI();

export class LiveCollabEditorContribution extends Disposable implements IEditorContribution {

	static readonly ID = 'editor.contrib.livecollab';

	// The binding for the model on screen. Gate retries on THIS model being
	// bound, not on holding any binding: the widget is reused across files and
	// room sessions, and a stale binding used to block every retry.
	private readonly _binding = new LiveCollabBindingSlot<ITextModel, YMonacoBinding>();
	// What the binding above was made from, for the sync check.
	private _bound: { readonly model: ITextModel; readonly doc: YDocument; readonly fileId: string } | undefined;
	private _syncFailures = 0;
	/**
	 * The model's text when it began waiting for its binding in this room session (a bind skipped
	 * for no id, no seed or an error). What is typed after that is merged into the room's text when
	 * the binding lands, since the binding replaces the editor's text with the room's.
	 */
	private _waiting: { readonly model: ITextModel; readonly epoch: number; readonly text: string } | undefined;
	/** The model the sync check last found left unbound, so the log says so once per model, not every check. */
	private _unboundReported: ITextModel | undefined;
	/** This client's room service and virtual file system (ILiveCollabClient). */
	private readonly _service: LiveCollabService;
	private readonly _fileSystem: LiveCollabFileSystemProvider;
	/** Files this client has already reported out of sync. */
	private readonly _reportedOutOfSync: Set<string>;

	// Real fix (PHASE3_YJS_DESIGN.md section 30, Option A - decided
	// explicitly: server assigns identity, not clients). Translates a
	// model's own uri into the real, server-assigned file id, the same
	// one every machine in the room agrees on - a livecollab:// file's
	// path is already the relative itemPath used as the lookup key
	// directly; a real file:// file's absolute disk path must first be
	// translated back to that same itemPath via the map recorded when
	// the tree was read. Returns undefined if no server id exists yet
	// (e.g. file not yet broadcast/id-assigned) - callers must treat
	// that as "can't sync yet", not fall back to a client-computed
	// identity, since that's the exact class of bug this fix replaces.
	private _getServerFileId(model: { uri: { scheme: string; path: string; fsPath: string } }): string | undefined {
		const itemPath = model.uri.scheme === LIVECOLLAB_SCHEME
			? model.uri.path.replace(/^\//, '')
			: this._fileSystem.getItemPathForRealPath(model.uri.fsPath);
		if (!itemPath) { return undefined; }
		return this._fileSystem.getServerFileId(itemPath);
	}

	constructor(
		private readonly editor: ICodeEditor,
		@INotificationService private readonly notificationService: INotificationService,
		@IOutputService private readonly outputService: IOutputService,
		@ILiveCollabClient client: ILiveCollabClient,
	) {
		super();
		this._service = client.service;
		this._fileSystem = client.fileSystem;
		this._reportedOutOfSync = reportedOutOfSyncFor(this._service);

		// This editor's binding belongs to one room session (IRoomStateOwner):
		// released when it ends, since the session's docs are destroyed then.
		this._register(this._service.registerRoomState({
			name: `Yjs binding (editor ${this.editor.getId()})`,
			clear: () => {
				this._binding.dispose();
				this._bound = undefined;
				this._waiting = undefined;
				this._unboundReported = undefined;
			},
			inspect: () => [...this._bound ? [`bound to ${this._bound.fileId}`] : [], ...this._waiting ? ['waiting to bind'] : []],
		}));

		// Sunday 2026-10-25: a file went out of sync one way and nobody could
		// tell. Until the protocol can repair it (state-vector resync), a
		// broken file must at least say so.
		this._register(new IntervalTimer()).cancelAndSet(() => this._checkSync(), SYNC_CHECK_INTERVAL_MS);

		// Real fix (PHASE3_YJS_DESIGN.md section 29): _setupYjsBinding()
		// was previously only called inside onDidChangeModel, which only
		// fires when switching to a DIFFERENT file. A file already open
		// in the editor when this contribution is constructed - the
		// common case on room join - never got a Yjs binding at all,
		// confirmed with real evidence: the old code:change path fired
		// dozens of times in a live two-machine test while Yjs/y-monaco/
		// MonacoBinding never appeared anywhere in the captured logs.
		// Call it here too so the very first file gets bound as well.
		this._setupYjsBinding();

		// Real fix (PHASE3_YJS_DESIGN.md section 30 follow-up, real race
		// condition caught and closed before testing): the attempt above
		// can genuinely find no server-assigned id yet if this file opens
		// before the tree has finished being read/broadcast. Without this,
		// that first file would silently never get a Yjs binding for the
		// rest of the session, since the only other call site is a file-
		// switch that may never happen. Retrying here, once ids actually
		// become available, closes that gap.
		this._register(this._fileSystem.onFileIdsAvailable(() => {
			if (!this._binding.isBoundTo(this.editor.getModel())) { this._setupYjsBinding(); }
		}));

		// PHASE4: content is Yjs-only. y-monaco's MonacoBinding syncs the
		// model to the shared doc automatically, so there is no manual
		// keystroke->socket emit and no code:change apply here (that path
		// keyed on model.uri.path, which cross-wired same-named files across
		// machines - the /app/page.tsx vs app/room/[id]/page.tsx misroute).
		// On a file switch, (re)bind the newly-active model.
		this._register(this.editor.onDidChangeModel(() => this._setupYjsBinding()));

		// A snapshot can arrive AFTER a file was opened (guest race, or the
		// host right after attach). Its docs seed the file's Y.Doc; retry the
		// binding the R1 bind gate previously skipped as unseeded.
		this._register(this._service.onSnapshot(() => {
			if (!this._binding.isBoundTo(this.editor.getModel())) { this._setupYjsBinding(); }
		}));

		// Remote Yjs updates are applied by livecollabService for every file,
		// open or not (an update applied only here was lost whenever no editor
		// had the file open). The binding renders whatever reaches the doc.

		// Set up the Yjs binding for whatever file is already open at
		// construction time - onDidChangeModel above only fires on
		// SUBSEQUENT switches, not for the model that's already attached.
		this._setupYjsBinding();

		// MonacoBinding doesn't follow VS Code's IDisposable convention (it
		// has .destroy(), not .dispose() - confirmed directly in y-monaco's
		// source before writing this). The slot's dispose() destroys it, so
		// _register's normal disposal mechanism still cleans it up correctly.
		this._register(this._binding);
	}

	// Async because both the Y.Doc and MonacoBinding module may need to
	// load. Real race guard: if the user switches files again before this
	// resolves, the fileId captured at the start is checked against the
	// CURRENT model before committing the binding, so an older, slower-
	// resolving call can never overwrite a newer one with a stale binding.
	private async _setupYjsBinding(): Promise<void> {
		// Real, precise diagnostic (PHASE3_YJS_DESIGN.md section 29
		// follow-up): this function had zero logging of its own, so a
		// live two-machine test showing no Yjs-related console activity
		// was genuinely ambiguous - could mean this never gets called,
		// or it runs completely silently either way. Also called
		// without await/catch at its call sites, so any real thrown
		// error here would become a silent unhandled rejection. Logging
		// entry, progress, and any real failure removes the ambiguity
		// with real evidence instead of guessing further.
		lcLog.info('[LiveCollab] _setupYjsBinding called');
		const modelAtStart = this.editor.getModel();
		// A binding made for another model (the previous file, or this file in
		// a previous room session) is released now, even if this bind is then
		// skipped — so the retries above can run when the id or seed arrives.
		this._binding.releaseUnless(modelAtStart);
		if (!modelAtStart) { lcLog.info('[LiveCollab] _setupYjsBinding: no model, aborting'); return; }
		const fileId = this._getServerFileId(modelAtStart);
		if (!fileId) {
			lcLog.info('[LiveCollab] _setupYjsBinding: no server-assigned id yet for this file, skipping');
			this._noteWaiting(modelAtStart);
			return;
		}

		try {
			const doc = await this._service.getOrCreateYjsDoc(fileId);
			// R1 BIND GATE: never attach the shared doc to a model until it has
			// been seeded from the server's authoritative state. Binding an
			// unseeded (empty) doc is exactly what let a 2-char doc overwrite a
			// 179911-byte file on disk. An unseeded doc is left unbound; the
			// onSnapshot listener retries the moment it seeds.
			if (!this._service.isSeeded(fileId)) {
				lcLog.info('[LiveCollab] _setupYjsBinding: doc not seeded yet for', fileId, '- deferring bind until snapshot');
				this._noteWaiting(modelAtStart);
				return;
			}
			const MonacoBindingClass = await this._service.getMonacoBindingClass();

			const modelNow = this.editor.getModel();
			if (!modelNow || modelNow !== modelAtStart) { lcLog.info('[LiveCollab] _setupYjsBinding: stale, model changed while loading'); return; } // stale - user switched files again while we were loading

			const ytext = doc.getText('content');
			this._mergeTypingWhileWaiting(modelNow, doc, ytext);
			this._binding.set(modelNow, new MonacoBindingClass(ytext, modelNow, new Set([this.editor])));
			this._bound = { model: modelNow, doc, fileId };
			this._syncFailures = 0;
			lcLog.info('[LiveCollab] _setupYjsBinding: binding created for fileId:', fileId);
		} catch (e) {
			lcLog.warn('[LiveCollab] _setupYjsBinding: real error:', e);
			this._noteWaiting(modelAtStart);
		}
	}

	/** Records `model`'s text as it begins waiting for its binding, once per model and room session. */
	private _noteWaiting(model: ITextModel): void {
		if (!this._service.roomId || model.isDisposed()) { return; }
		const epoch = this._service.roomEpoch;
		if (this._waiting?.model === model && this._waiting.epoch === epoch) { return; }
		this._waiting = { model, epoch, text: model.getValue() };
	}

	/**
	 * y-monaco's binding replaces the editor's text with the room's when it is created, so typing
	 * done while this editor waited for its binding would vanish (open-then-type, tier one for
	 * 0.3.5). It is put into the room's text first, as edits from this side, which the room then
	 * shares as any typing. Never drops either side's text (livecollabBindMerge.ts).
	 */
	private _mergeTypingWhileWaiting(model: ITextModel, doc: YDocument, ytext: YText): void {
		const waiting = this._waiting;
		this._waiting = undefined;
		if (!waiting || waiting.model !== model || waiting.epoch !== this._service.roomEpoch) { return; }
		const edits = mergeIntoRoomText(waiting.text, model.getValue(), ytext.toString());
		if (edits.length === 0) { return; }
		doc.transact(() => {
			for (const edit of edits) {
				if (edit.deleteCount > 0) { ytext.delete(edit.offset, edit.deleteCount); }
				if (edit.insert) { ytext.insert(edit.offset, edit.insert); }
			}
		});
		lcLog.info('[LiveCollab] _setupYjsBinding: kept', edits.length, 'changes typed while waiting to bind');
	}

	/**
	 * The state an editor should never be in: in a room, showing a room file (it has the room's
	 * id), and not bound, so nothing typed in it syncs and nothing says so. Every bind attempt is
	 * driven by an event (ids, snapshot, model change); one that runs too early and finds nothing
	 * after it left the editor unbound for good (the late-snapshot bind, TEST_HARNESS_TRIAGE.md
	 * "Never-bind"). The sync check is the net under all of them: it retries the bind. True when
	 * it did, so the rest of the check waits for a binding.
	 */
	private _retryIfLeftUnbound(model: ITextModel | null): boolean {
		if (!model || model.isDisposed() || !this._service.roomId || this._binding.isBoundTo(model)) {
			return false;
		}
		const fileId = this._getServerFileId(model);
		if (!fileId) {
			return false;
		}
		if (this._unboundReported !== model) {
			this._unboundReported = model;
			lcLog.warn(`[LiveCollab] sync check: ${model.uri.path} (${fileId}) is open in the room but not bound — retrying the bind`);
		}
		this._setupYjsBinding();
		return true;
	}

	// A bound file is out of sync when Yjs holds updates it cannot apply
	// (something they depend on never arrived, so every later edit from that
	// person waits forever), or when the editor's text and the shared text
	// differ (an edit reached one and not the other). Either way the person
	// is told once per file per room session; the details go to the log.
	private _checkSync(): void {
		const model = this.editor.getModel();
		if (this._retryIfLeftUnbound(model)) {
			return;
		}
		const bound = this._bound;
		if (!bound || bound.model !== model || !this._binding.isBoundTo(model) || model.isDisposed()) {
			this._syncFailures = 0;
			return;
		}
		const store = bound.doc.store;
		const pending = store.pendingStructs !== null || store.pendingDs !== null;
		const shared = bound.doc.getText('content').toString();
		const differs = comparableText(model.getValue()) !== comparableText(shared);
		if (!pending && !differs) {
			this._syncFailures = 0;
			return;
		}
		if (++this._syncFailures < SYNC_CHECK_FAILURES_TO_REPORT) { return; }
		const key = `${this._service.roomEpoch}:${bound.fileId}`;
		if (this._reportedOutOfSync.has(key)) { return; }
		this._reportedOutOfSync.add(key);
		lcLog.error(`🔴 [LiveCollab] OUT OF SYNC: ${bound.fileId} (${model.uri.path}) — updates waiting on missing ones: ${pending}${pending ? ` (missing from clients ${JSON.stringify(Array.from(store.pendingStructs?.missing ?? new Map()))})` : ''}; editor text differs from shared text: ${differs} (editor ${model.getValueLength()} chars, shared ${shared.length})`);
		const name = model.uri.path.split('/').pop() ?? model.uri.path;
		// Only the person whose changes are missing can supply them, and a
		// reconnect re-sends them only for a file under the resync cap.
		const message = this._service.resyncCovers(bound.fileId)
			? localize('livecollab.outOfSync', "'{0}' is out of sync with the room: some changes haven't arrived, so what you see may not match what others see. It recovers when the connection of the person who made them does.", name)
			: localize('livecollab.outOfSync.tooLarge', "'{0}' is out of sync with the room: some changes haven't arrived, so what you see may not match what others see. This file is too large to recover on its own and needs to be recreated.", name);
		this.notificationService.prompt(Severity.Error, message, [{
			label: localize('livecollab.outOfSync.showLog', "Show Log"),
			run: () => this.outputService.showChannel(windowLogId)
		}]);
	}
}

registerEditorContribution(
	LiveCollabEditorContribution.ID,
	LiveCollabEditorContribution,
	EditorContributionInstantiation.AfterFirstRender
);
