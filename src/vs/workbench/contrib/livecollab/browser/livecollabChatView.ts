/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { getActiveWindow } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { URI } from '../../../../base/common/uri.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { StoredChatDrafts } from './livecollabChatDrafts.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILiveCollabClient } from './livecollabClient.js';
import { IChatWidgetHost, LiveCollabChatWidget } from './livecollabChatWidget.js';

/** The room chat, in the secondary sidebar (CHAT_DESIGN.md, Where things live). */
export class LiveCollabChatView extends ViewPane {

	static readonly ID = 'workbench.view.livecollab.chat';
	static readonly TITLE = localize('livecollabChat', "Chat");

	private _widget: LiveCollabChatWidget | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ILiveCollabClient private readonly _client: ILiveCollabClient,
		@IEditorService private readonly _editorService: IEditorService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const host: IChatWidgetHost = {
			openFile: (resource: URI) => { void this._editorService.openEditor({ resource }); },
			openLink: url => { void this.openerService.open(URI.parse(url)); },
			copy: text => { void this._clipboardService.writeText(text); },
			hover: (element, text) => this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), element, text),
			hasFocus: () => getActiveWindow().document.hasFocus(),
		};
		this._widget = this._register(new LiveCollabChatWidget(container, this._client.service, this._client.fileSystem, host, this._register(new StoredChatDrafts(this._storageService))));
		// Code blocks show tabs as the editor does.
		const tabSize = () => this.configurationService.getValue<number>('editor.tabSize');
		this._widget.setTabSize(tabSize());
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('editor.tabSize')) {
				this._widget?.setTabSize(tabSize());
			}
		}));
		this._widget.setVisible(this.isBodyVisible());
		this._register(this.onDidChangeBodyVisibility(visible => this._widget?.setVisible(visible)));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this._widget) {
			this._widget.element.style.height = `${height}px`;
		}
	}

	override focus(): void {
		super.focus();
		this._widget?.focusComposer();
	}
}
