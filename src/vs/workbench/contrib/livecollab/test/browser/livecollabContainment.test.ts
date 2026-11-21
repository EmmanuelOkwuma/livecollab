/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContainmentDisk, IContainmentRoot, isUnderWithheld, judgeDiskPath, judgeLink, MoveCorrections, planLocalRename, planOwnerMove } from '../../browser/livecollabContainment.js';
import { secretFileRule } from '../../browser/livecollabShareRules.js';

/**
 * A disk with links (path prefix -> real path), the real paths that exist,
 * paths whose resolution fails (a broken link, a loop), and paths whose
 * resolution fails the way Node's realpath does when the path is still
 * readable: it hands the path back unresolved.
 */
class FakeDisk implements IContainmentDisk {
	constructor(
		private readonly links: Readonly<Record<string, string>>,
		private readonly existing: ReadonlySet<string>,
		private readonly unresolvable: ReadonlySet<string> = new Set(),
		private readonly fallsBack: ReadonlySet<string> = new Set(),
	) { }

	async isLink(path: string): Promise<boolean> {
		return Object.prototype.hasOwnProperty.call(this.links, path);
	}

	async realpath(path: string): Promise<string | undefined> {
		if (this.unresolvable.has(path)) {
			throw new Error(`ELOOP or dangling: ${path}`);
		}
		if (this.fallsBack.has(path)) {
			return path;
		}
		let resolved = path;
		for (let hops = 0; hops < 10; hops++) {
			const link = Object.keys(this.links).find(from => resolved === from || resolved.startsWith(from + '/'));
			if (!link) {
				break;
			}
			resolved = this.links[link] + resolved.slice(link.length);
		}
		return this.existing.has(resolved) ? resolved : undefined;
	}
}

// Tuesday's MacBook layout: lc-test-A with `linked` -> ~/Desktop/lc-scratch,
// plus a link inside the folder (web/current -> web/v2).
const A = '/Users/m/Desktop/lc-test-A';
const root: IContainmentRoot = { path: A, realPath: A };
const disk = new FakeDisk(
	{ [`${A}/linked`]: '/Users/m/Desktop/lc-scratch', [`${A}/web/current`]: `${A}/web/v2` },
	new Set([A, `${A}/greet.ts`, `${A}/web`, `${A}/web/v2`, `${A}/web/v2/app.js`, '/Users/m/Desktop/lc-scratch', '/Users/m/Desktop/lc-scratch/marker.txt']),
	new Set([`${A}/dangling`]),
);

suite('LiveCollab containment rule (a path is shared, or written, only if it resolves inside the shared folder)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a link out of the folder, and a broken link, are withheld', async () => {
		assert.deepStrictEqual([
			(await judgeLink(disk, root, `${A}/linked`)).verdict,
			(await judgeLink(disk, root, `${A}/dangling`)).verdict,
		], ['outside', 'outside']);
	});

	test('a link inside the folder resolves inside, and is held back as an alias of what is already shared', async () => {
		// Departs from "a link inside the folder is shared" (STATUS): sharing it
		// too would give web/v2/app.js two room paths and two documents.
		assert.deepStrictEqual(await judgeLink(disk, root, `${A}/web/current`), { verdict: 'alias', detail: 'link to web/v2, already shared under that name' });
	});

	test('a root reached through a link shares and accepts creates', async () => {
		const work: IContainmentRoot = { path: '/Users/m/Desktop/work', realPath: '/Volumes/ext/work' };
		const linkedRoot = new FakeDisk(
			{ '/Users/m/Desktop/work': '/Volumes/ext/work', '/Volumes/ext/work/out': '/Users/m/Documents' },
			new Set(['/Volumes/ext/work', '/Volumes/ext/work/src', '/Users/m/Documents']),
		);
		assert.deepStrictEqual([
			await judgeDiskPath(linkedRoot, work, 'src/new.ts'),
			await judgeDiskPath(linkedRoot, work, 'brand-new/deeper/note.ts'),
			(await judgeDiskPath(linkedRoot, work, 'out/x.txt')).inside,
		], [{ inside: true, exists: false }, { inside: true, exists: false }, false]);
	});

	test('a move out of a withheld path to a legal path is written from the room; the source is left alone', async () => {
		const source = await judgeDiskPath(disk, root, 'linked/notes.txt');
		const destination = await judgeDiskPath(disk, root, 'notes.txt');
		assert.deepStrictEqual([isUnderWithheld('linked/notes.txt', ['linked']), source.inside, planOwnerMove(source, destination)], [true, false, 'write']);
	});

	test('a move to a path outside the folder is refused, whether through a link or under one the room never sees', async () => {
		const source = await judgeDiskPath(disk, root, 'greet.ts');
		const throughLink = await judgeDiskPath(disk, root, 'linked/greet.ts');
		assert.deepStrictEqual([
			source,
			planOwnerMove(source, throughLink),
			isUnderWithheld('linked/sub/greet.ts', ['linked']),
			isUnderWithheld('linked-not/greet.ts', ['linked']),
		], [{ inside: true, exists: true }, 'refuse', true, false]);
	});

	test('a path that cannot be resolved counts as outside', async () => {
		assert.deepStrictEqual((await judgeDiskPath(disk, root, 'dangling/x.txt')).inside, false);
	});

	test('a realpath that fell back to the unresolved path counts as outside, for a write path and for a link', async () => {
		const fallingBack = new FakeDisk(
			{ [`${A}/linked`]: '/Users/m/Desktop/lc-scratch' },
			new Set([A, `${A}/greet.ts`, '/Users/m/Desktop/lc-scratch']),
			new Set(),
			new Set([`${A}/linked/notes.txt`, `${A}/linked`]),
		);
		assert.deepStrictEqual([
			await judgeDiskPath(fallingBack, root, 'linked/notes.txt'),
			(await judgeLink(fallingBack, root, `${A}/linked`)).verdict,
			await judgeDiskPath(fallingBack, root, 'greet.ts'),
		], [{ inside: false, exists: false, detail: `the link ${A}/linked could not be resolved` }, 'outside', { inside: true, exists: true }]);
	});

	test('a rename is judged against the share rules on both ends', () => {
		const plan = (tracked: boolean, newPath: string, onOwnerDisk: boolean) => planLocalRename({ tracked, destinationRule: secretFileRule(newPath), onOwnerDisk });
		assert.deepStrictEqual({
			ownerIntoSecret: plan(true, '.env', true),
			guestIntoSecret: plan(true, '.env', false),
			ownerOutOfSecret: plan(false, 'notes.txt', true),
			ordinary: plan(true, 'notes-2.txt', false),
			secretToSecret: plan(false, 'app/.env.local', true),
		}, {
			ownerIntoSecret: 'leaveRoom',
			guestIntoSecret: 'refuse',
			ownerOutOfSecret: 'enterRoom',
			ordinary: 'rename',
			secretToSecret: 'ignore',
		});
	});
	test('a move into a withheld path refused again and again is corrected every time, and the owner never applies its own correction (run J, 2026-10-29)', () => {
		const corrections = new MoveCorrections();
		const id = 'file-greet';
		// A frustrated member drags greet.ts under the link six times in a row;
		// each time the owner refuses and corrects, then hears the correction back.
		const echoes = [1, 2, 3, 4, 5, 6].map(() => {
			corrections.sent(id, 'linked/greet.ts', 'greet.ts');
			return corrections.isOwnEcho(id, 'linked/greet.ts', 'greet.ts');
		});
		assert.deepStrictEqual({
			echoes,
			// The same rename made by a member afterwards is not mistaken for an echo,
			memberMoveIsOwn: corrections.isOwnEcho(id, 'linked/greet.ts', 'greet.ts'),
			// nor is the move the member originally made.
			originalMoveIsOwn: corrections.isOwnEcho(id, 'greet.ts', 'linked/greet.ts'),
			waiting: corrections.waiting,
		}, {
			echoes: [true, true, true, true, true, true],
			memberMoveIsOwn: false,
			originalMoveIsOwn: false,
			waiting: 0,
		});
	});
});
