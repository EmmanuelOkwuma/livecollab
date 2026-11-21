/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { join } from '../../../base/common/path.js';
import { FileAccess } from '../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { liveCollabEndpoints } from '../../../platform/product/common/livecollabBuildFlavor.js';

suite('LiveCollab dashboard page (livecollab-bootstrap.html)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every inline script parses (a syntax error left the dashboard on its sign-in page), and the two copies differ only in what they may connect to', async () => {
		const page = (name: string) => fs.readFile(FileAccess.asFileUri(`vs/code/electron-browser/workbench/${name}`).fsPath, 'utf8');
		const [built, dev] = [await page('livecollab-bootstrap.html'), await page('livecollab-bootstrap-dev.html')];
		const parse = (html: string) => Array.from(html.matchAll(/<script(?<attributes>[^>]*)>(?<body>[\s\S]*?)<\/script>/g)).filter(m => !m.groups!.attributes.includes('src=')).map(m => {
			// A module's imports aren't script syntax; the rest of it is checked as written.
			const body = m.groups!.attributes.includes('module') ? m.groups!.body.replace(/^\s*import\s[^;]*;$/gm, '') : m.groups!.body;
			try {
				// Parsed, never called.
				new Function(body);
				return 'parses';
			} catch (error) {
				return String(error);
			}
		});
		const devLines = dev.split('\n');
		const differing = built.split('\n').filter((line, index) => line !== devLines[index]).map(line => /Content-Security-Policy/.test(line) ? 'the CSP line' : line);
		assert.deepStrictEqual({ built: parse(built), dev: parse(dev), differing }, {
			built: ['parses', 'parses', 'parses', 'parses'], dev: ['parses', 'parses', 'parses', 'parses'], differing: ['the CSP line'],
		});
	});

	/**
	 * KNOWN_ISSUES ("A dev build pointed at another server"): the dev override
	 * (`LIVECOLLAB_SERVER_URL`, liveCollabEndpoints) reaches the sign-in and the
	 * workbench, but the dashboard page's connect-src lists only production and the
	 * loopback, so a dev build pointed at staging gets a dashboard that never connects
	 * (step 15 of CLERK_PRODUCTION_PLAN, 2026-11-15). Fails today; not fixed in 0.3.6
	 * (Manny, 2026-11-15), so it is skipped until the fix: remove `.skip` with it.
	 */
	test.skip('the dev dashboard page may connect to any server the dev override can name, not only production and the loopback', async () => {
		const dev = await fs.readFile(FileAccess.asFileUri('vs/code/electron-browser/workbench/livecollab-bootstrap-dev.html').fsPath, 'utf8');
		const sources = (/connect-src(?<list>[^;"]*)/.exec(dev)?.groups?.list ?? '').trim().split(/\s+/);
		const allows = (address: string) => {
			const url = new URL(address);
			return sources.some(source => {
				if (source === url.protocol) {
					return true;
				}
				const match = /^(?<scheme>[a-z]+):\/\/(?<host>[^:/]+)(?::(?<port>\*|\d+))?$/.exec(source);
				return !!match && match.groups!.scheme + ':' === url.protocol && match.groups!.host === url.hostname && (match.groups!.port === '*' || (match.groups!.port ?? '') === url.port);
			});
		};
		const server = liveCollabEndpoints(false, undefined, { LIVECOLLAB_SERVER_URL: 'https://staging.example.test' }).server;
		const socket = server.replace(/^http/, 'ws');
		assert.deepStrictEqual({ server, http: allows(server), socket: allows(socket) }, { server: 'https://staging.example.test', http: true, socket: true });
	});

	test('the sign-in page and the empty dashboard describe LiveCollab plainly, with no real-time or co-editing language (Manny, 2026-11-18)', async () => {
		const page = (name: string) => fs.readFile(FileAccess.asFileUri(`vs/code/electron-browser/workbench/${name}`).fsPath, 'utf8');
		const shown = (html: string) => ({
			tagline: html.match(/<div class="land-tag">(?<text>[^<]*)<\/div>/)?.groups?.text,
			footer: html.match(/<div class="land-foot">(?<text>[^<]*)<\/div>/)?.groups?.text,
			emptyDashboard: html.match(/<div class="t">No rooms yet<\/div>\s*<div class="x">(?<text>[^<]*)<\/div>/)?.groups?.text,
			realTimeLanguage: html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, '').match(/real[ -]?time|code together|coding together|live collaboration|collaborative (?:code )?edit/gi) ?? [],
		});
		const expected = {
			tagline: 'Sign in to LiveCollab',
			footer: 'Sign in to use your rooms.',
			emptyDashboard: 'Create your first room, or join an existing one with an invite code.',
			realTimeLanguage: [],
		};
		assert.deepStrictEqual({ built: shown(await page('livecollab-bootstrap.html')), dev: shown(await page('livecollab-bootstrap-dev.html')) }, { built: expected, dev: expected });
	});

	test('the old in-app sign-in screen and login panel are gone, and no LiveCollab workbench source shows real-time wording (Manny, 2026-11-18)', async () => {
		// Read from the sources: a transpile leaves the output of a deleted file in place.
		const browser = join(FileAccess.asFileUri('').fsPath, '..', 'src', 'vs', 'workbench', 'contrib', 'livecollab', 'browser');
		const workbench = join(FileAccess.asFileUri('').fsPath, '..', 'src', 'vs', 'code', 'electron-browser', 'workbench');
		const sources = (await fs.readdir(browser)).filter(name => name.endsWith('.ts'));
		const wording: string[] = [];
		for (const name of sources) {
			if (/Code together|in real time/.test(await fs.readFile(join(browser, name), 'utf8'))) {
				wording.push(name);
			}
		}
		assert.deepStrictEqual({
			signInScreen: sources.filter(name => /^livecollab(SignIn(Editor|Input)|LoginPanel)\.ts$/.test(name)),
			leftoverBackups: (await fs.readdir(workbench)).filter(name => name.endsWith('.bak')),
			wording,
		}, { signInScreen: [], leftoverBackups: [], wording: [] });
	});

	test('the dashboard\'s About card and Sentry\'s release show LiveCollab\'s version from product.json, never 2.0.0 or VS Code\'s (Manny, 2026-11-18)', async () => {
		const page = (name: string) => fs.readFile(FileAccess.asFileUri(`vs/code/electron-browser/workbench/${name}`).fsPath, 'utf8');
		const about = (html: string) => {
			const card = html.match(/14:\{t:'About LiveCollab',html:'(?<card>[^\n]*?)'\}/)?.groups?.card ?? '';
			return {
				hardCodedVersion: card.match(/\d+\.\d+\.\d+/g) ?? [],
				versionSlot: /<span class="st-fv" data-fill="version"><\/span>/.test(card),
				filledFromMain: /if\s*\(n===14&&window\.lcVersion\)\s*\{\s*window\.lcVersion\(\)\.then\(/.test(html) && /window\.lcVersion = lcVersion;/.test(html),
			};
		};
		const main = await fs.readFile(join(FileAccess.asFileUri('').fsPath, '..', 'src', 'main.ts'), 'utf8');
		const expected = { hardCodedVersion: [], versionSlot: true, filledFromMain: true };
		assert.deepStrictEqual({
			built: about(await page('livecollab-bootstrap.html')),
			dev: about(await page('livecollab-bootstrap-dev.html')),
			sentryRelease: /Sentry\.init\(\{[^}]*release: liveCollabSentryRelease\(product\.livecollabVersion\),/.test(main),
		}, { built: expected, dev: expected, sentryRelease: true });
	});

	test('Settings has an "About LiveCollab" row that opens the version page (stGo(14)); it was taken out with the unfinished rows in a7f6423bd69, leaving the page unreachable (Manny, 2026-11-19, 0.3.7)', async () => {
		const page = (name: string) => fs.readFile(FileAccess.asFileUri(`vs/code/electron-browser/workbench/${name}`).fsPath, 'utf8');
		const rows = (html: string) => Array.from(html.matchAll(/<div class="st-lrow" onclick="(?<action>[^"]+)"[^>]*>.*?<span class="st-ll">(?<label>[^<]+)<\/span>/g)).map(m => `${m.groups!.label}: ${m.groups!.action}`);
		const expected = ['Profile: stGo(1)', 'Password and Security: lcOpenAccount()', 'About LiveCollab: stGo(14)'];
		assert.deepStrictEqual({
			built: rows(await page('livecollab-bootstrap.html')),
			dev: rows(await page('livecollab-bootstrap-dev.html')),
		}, { built: expected, dev: expected });
	});
});
