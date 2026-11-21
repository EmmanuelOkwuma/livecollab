/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from '../../../../../base/common/path.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

/**
 * Layer B runs two LiveCollab clients in one process. Each must reach its own
 * room service and virtual file system through the injected client service
 * (`ILiveCollabClient`), never the module singletons. A file in B's reach that
 * imports a singleton would silently talk to the wrong client.
 * See TEST_HARNESS_TRIAGE.md, "The client seam".
 */

/** The modules that define the singletons. The walk stops at them. */
const SINGLETON_MODULES: Record<string, string> = {
	'livecollabService.ts': 'livecollabService',
	'livecollabFileSystemProvider.ts': 'livecollabFileSystemProvider',
};

/** The client service's own file: the one place the default wiring may name the singletons. */
const CLIENT_MODULE = 'livecollabClient.ts';

/** What layer B instantiates. Everything they import, transitively, is in B's reach. */
const B_ENTRY_FILES = ['livecollabFolderContribution.ts', 'livecollabEditorContribution.ts', 'livecollabCursorContribution.ts'];

/** The files that take the client service today. */
const SEAM_FILES = ['livecollabFolderContribution.ts', 'livecollabRoomPersister.ts', 'livecollabEditorContribution.ts', 'livecollabCursorContribution.ts'];

const IMPORT_PATTERN = /import\s+(?<clause>[^;]*?)\s+from\s+'(?<specifier>\.[^']+)'/gs;
const DYNAMIC_IMPORT_PATTERN = /import\(\s*'(?<specifier>\.[^']+)'\s*\)/g;

/** The relative imports of one source file, as file names under `dir` with their import clauses. */
function relativeImports(source: string, dir: string, fromFile: string): { file: string; clause: string | undefined }[] {
	const found: { file: string; clause: string | undefined }[] = [];
	const root = resolve(dir);
	const add = (specifier: string, clause: string | undefined) => {
		const target = resolve(root, dirname(fromFile), specifier.replace(/\.js$/, '.ts'));
		// Only files in this folder: the rest of the workbench can't hold the singletons.
		if (target.startsWith(root + '/')) {
			found.push({ file: target.slice(root.length + 1), clause });
		}
	};
	for (const match of source.matchAll(IMPORT_PATTERN)) {
		add(match.groups!.specifier, match.groups!.clause);
	}
	for (const match of source.matchAll(DYNAMIC_IMPORT_PATTERN)) {
		add(match.groups!.specifier, undefined);
	}
	return found;
}

/** The singleton names a source file imports directly ("import * as" and dynamic imports count). */
function singletonImports(source: string, dir: string, fromFile: string): string[] {
	const names: string[] = [];
	for (const { file, clause } of relativeImports(source, dir, fromFile)) {
		const singleton = SINGLETON_MODULES[file];
		if (!singleton) {
			continue;
		}
		const named = clause?.match(/\{(?<names>[^}]*)\}/)?.groups?.names.split(',').map(name => name.trim().split(/\s+as\s+/)[0]) ?? [];
		if (clause === undefined || !clause.trim().startsWith('{') || named.includes(singleton)) {
			names.push(singleton);
		}
	}
	return names;
}

/** Every file in `dir` reached from the entry files, stopping at the singleton modules and the client module. */
function reach(dir: string): string[] {
	const seen = new Set<string>();
	const pending = [...B_ENTRY_FILES];
	while (pending.length) {
		const file = pending.pop()!;
		if (seen.has(file) || SINGLETON_MODULES[file] || file === CLIENT_MODULE || !existsSync(join(dir, file))) {
			continue;
		}
		seen.add(file);
		for (const imported of relativeImports(readFileSync(join(dir, file), 'utf8'), dir, file)) {
			pending.push(imported.file);
		}
	}
	return [...seen].sort();
}

suite('LiveCollab client seam', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const browserOutDir = FileAccess.asFileUri('vs/workbench/contrib/livecollab/browser').fsPath;
	// Read the TypeScript sources: type-only imports vanish from the compiled output.
	const browserSrcDir = resolve(browserOutDir).replaceAll('\\', '/').replace('/out/vs/workbench/', '/src/vs/workbench/');

	test('files layer B reaches take the room service and the file system from the client service', () => {
		const reached = reach(browserSrcDir);
		const offenders = reached.flatMap(file => singletonImports(readFileSync(join(browserSrcDir, file), 'utf8'), browserSrcDir, file).map(name => `${file} imports ${name}`));
		assert.deepStrictEqual({
			seamFilesReached: SEAM_FILES.filter(file => reached.includes(file)),
			offenders,
		}, {
			seamFilesReached: SEAM_FILES,
			offenders: [],
		});
	});

	test('the guard catches each way of importing a singleton, and lets the rest of the module through', () => {
		const sources = {
			named: `import { livecollabService } from './livecollabService.js';`,
			renamed: `import { livecollabFileSystemProvider as files, LIVECOLLAB_SCHEME } from './livecollabFileSystemProvider.js';`,
			namespace: `import * as service from './livecollabService.js';`,
			dynamic: `const m = await import('./livecollabService.js');`,
			typesAndConstantsOnly: `import { LIVECOLLAB_SCHEME, LiveCollabFileSystemProvider } from './livecollabFileSystemProvider.js';\nimport { ILiveCollabTreeItem } from './livecollabService.js';`,
		};
		const flagged = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, singletonImports(source, browserSrcDir, 'any.ts')]));
		assert.deepStrictEqual(flagged, {
			named: ['livecollabService'],
			renamed: ['livecollabFileSystemProvider'],
			namespace: ['livecollabService'],
			dynamic: ['livecollabService'],
			typesAndConstantsOnly: [],
		});
	});
});
