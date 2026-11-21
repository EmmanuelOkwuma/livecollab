/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const root = path.join(import.meta.dirname, '..', '..', '..');

/** Tracked files that hold code or configuration (not prose, not the lock file). */
function codeFiles(): string[] {
	const listed = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean);
	return listed.filter(file => /\.(ts|js|mjs|cjs|tsx|jsx|json|html|sh)$/.test(file) && !file.endsWith('package-lock.json') && !file.endsWith('.map') && file !== 'build/lib/test/livecollabDependencies.test.ts');
}

suite('LiveCollab: the desktop app\'s dependencies', () => {

	/**
	 * Clerk runs on the website's sign-in page, not in the app (option F, WEBSITE_SIGNIN_DESIGN.md).
	 * `@clerk/clerk-js` was a dependency left from the June localhost sign-in that nothing loaded,
	 * and packaging copies every production dependency into the app: 94 packages and 1,637 files of
	 * it in 0.3.5 (Manny, 2026-11-14: removed).
	 */
	test('@clerk/clerk-js is not a dependency, and no code or build script uses it', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
		const users = codeFiles().filter(file => {
			const full = path.join(root, file);
			return fs.existsSync(full) && fs.statSync(full).size < 8 * 1024 * 1024 && fs.readFileSync(full, 'utf8').includes('@clerk/clerk-js');
		});
		assert.deepStrictEqual({
			dependency: Object.keys(manifest.dependencies ?? {}).includes('@clerk/clerk-js'),
			optional: Object.keys(manifest.optionalDependencies ?? {}).includes('@clerk/clerk-js'),
			users,
		}, { dependency: false, optional: false, users: [] });
	});

	/**
	 * Packaging copies ThirdPartyNotices.txt and every production dependency into the app
	 * (build/gulpfile.vscode.ts). Every package that a dependency LiveCollab added brings in (the
	 * ones VS Code itself didn't have at its base, 19cce3051a1) has its own entry, as does each
	 * package inside the bundles LiveCollab vendors in livecollab/browser/vendor.
	 */
	test('every package LiveCollab adds to the app, and every package in its vendored bundles, has a notice', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
		const base = JSON.parse(execFileSync('git', ['show', '19cce3051a1:package.json'], { cwd: root, encoding: 'utf8' }));
		const added = Object.keys(manifest.dependencies ?? {}).filter(name => !Object.keys(base.dependencies ?? {}).includes(name));
		// npm ls exits non-zero when it finds anything to complain about (an extraneous or missing
		// package anywhere in the tree), and still prints the whole tree.
		let listed: string;
		try {
			listed = execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
		} catch (error) {
			listed = String((error as { stdout?: string }).stdout ?? '');
		}
		const tree = JSON.parse(listed);
		const shipped = new Map<string, string>();
		const walk = (name: string, node: { version?: string; dependencies?: Record<string, object> } | undefined) => {
			if (!node?.version || shipped.get(name + '@' + node.version)) {
				return;
			}
			shipped.set(name + '@' + node.version, `${name} ${node.version} - `);
			for (const [child, childNode] of Object.entries(node.dependencies ?? {})) {
				walk(child, childNode);
			}
		};
		for (const name of added) {
			walk(name, tree.dependencies?.[name]);
		}
		// What the vendored bundles hold (their headers, source map and the lock file when each was built).
		const bundled = ['socket.io-client 4.8.3', 'engine.io-client 6.6.5', 'engine.io-parser 5.2.3', 'socket.io-parser 4.2.6', '@socket.io/component-emitter 3.1.2', 'yjs 13.6.32', 'lib0 0.2.117', 'y-monaco 0.1.6', '@sentry/electron 7.16.0', '@sentry/core 10.67.0', '@sentry/browser 10.67.0', '@sentry/browser-utils 10.67.0', '@sentry/replay 10.67.0', '@sentry/replay-canvas 10.67.0', '@sentry/feedback 10.67.0', '@sentry/conventions 0.16.0'];
		const notices = fs.readFileSync(path.join(root, 'ThirdPartyNotices.txt'), 'utf8').replace(/\r\n/g, '\n');
		const missing = [...shipped.values(), ...bundled.map(entry => entry + ' - ')].filter(header => !notices.includes('\n' + header));
		assert.deepStrictEqual({ added: added.sort(), packages: shipped.size, missing: [...new Set(missing)] }, {
			added: ['@sentry/electron', 'socket.io-client', 'y-monaco', 'y-protocols', 'yjs'],
			packages: 49,
			missing: [],
		});
	});
});
