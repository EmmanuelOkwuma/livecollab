/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { filesRemovedBy, isLargeRemoval, outermostMoves, planOwnerOfflineChanges, planRoomRemovals, reconcileBeforeAttach } from '../../browser/livecollabReconcile.js';

suite('LiveCollab reconcile before the attach (what changed while the owner was away)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** The matrix folder's ids, as the owner knew them before going away. */
	const known = new Map([['a.txt', 'A'], ['b.txt', 'B'], ['d', 'D'], ['d/c.txt', 'C'], ['p', 'P'], ['p/q', 'Q'], ['p/q/r.txt', 'R']]);
	const disk = new Set(known.keys());

	function run(room: Map<string, string>, onDisk: Set<string> = disk) {
		const result = reconcileBeforeAttach(room, known, onDisk);
		return { ...result, leaveOut: [...result.leaveOut].sort() };
	}
	const without = (map: Map<string, string>, ...gone: string[]) => new Map([...map].filter(([path]) => !gone.includes(path)));
	const nothing = { leaveOut: [], movedInRoom: [], removedInRoom: [], newOutside: [], missingOnDisk: [], twoSided: [] };

	test('one side changed: each case lands in its row, and only what\'s new on disk is sent', () => {
		assert.deepStrictEqual({
			unchanged: run(known),
			// #13: the guest renamed a.txt to c.txt; the disk still has a.txt.
			guestRenamed: run(new Map([...without(known, 'a.txt'), ['c.txt', 'A']])),
			// #14: the guest deleted b.txt.
			guestDeleted: run(without(known, 'b.txt')),
			// #16: the guest deleted p/q/.
			guestDeletedFolder: run(without(known, 'p/q', 'p/q/r.txt')),
			// #11: the guest created new.txt: in the room, not on disk, not known (the persister writes it).
			guestCreated: run(new Map([...known, ['new.txt', 'N']])),
			// The owner created e.txt on disk while away.
			ownerCreated: run(known, new Set([...disk, 'e.txt'])),
			// #30: the owner deleted b.txt on disk while away.
			ownerDeleted: run(known, new Set([...disk].filter(path => path !== 'b.txt'))),
			// #29: the owner renamed a.txt to e.txt on disk while away.
			ownerRenamed: run(known, new Set([...[...disk].filter(path => path !== 'a.txt'), 'e.txt'])),
		}, {
			unchanged: nothing,
			guestRenamed: { ...nothing, leaveOut: ['a.txt'], movedInRoom: [{ id: 'A', from: 'a.txt', to: 'c.txt' }] },
			guestDeleted: { ...nothing, leaveOut: ['b.txt'], removedInRoom: [{ id: 'B', path: 'b.txt' }] },
			guestDeletedFolder: { ...nothing, leaveOut: ['p/q', 'p/q/r.txt'], removedInRoom: [{ id: 'Q', path: 'p/q' }, { id: 'R', path: 'p/q/r.txt' }] },
			guestCreated: nothing,
			ownerCreated: { ...nothing, newOutside: ['e.txt'] },
			ownerDeleted: { ...nothing, missingOnDisk: [{ id: 'B', path: 'b.txt' }] },
			ownerRenamed: { ...nothing, newOutside: ['e.txt'], missingOnDisk: [{ id: 'A', path: 'a.txt' }] },
		});
	});

	test('both sides changed: left as holes for the ruling, neither sent nor acted on', () => {
		assert.deepStrictEqual({
			// #23: the guest renamed a.txt to c.txt, the owner renamed it to e.txt on disk.
			twoRenames: run(new Map([...without(known, 'a.txt'), ['c.txt', 'A']]), new Set([...[...disk].filter(path => path !== 'a.txt'), 'e.txt'])),
			// #24: the guest renamed a.txt to c.txt, the owner deleted it on disk.
			renameAgainstDelete: run(new Map([...without(known, 'a.txt'), ['c.txt', 'A']]), new Set([...disk].filter(path => path !== 'a.txt'))),
			// #25: both deleted b.txt.
			bothDeleted: run(without(known, 'b.txt'), new Set([...disk].filter(path => path !== 'b.txt'))),
			// The guest deleted p/q/, the owner added p/q/new.txt on disk.
			addedInsideRemovedFolder: run(without(known, 'p/q', 'p/q/r.txt'), new Set([...disk, 'p/q/new.txt'])),
		}, {
			// The owner's e.txt is new on disk either way; whether it stands beside c.txt is the ruling.
			twoRenames: { ...nothing, newOutside: ['e.txt'], twoSided: [{ path: 'a.txt', id: 'A', roomPath: 'c.txt' }] },
			renameAgainstDelete: { ...nothing, twoSided: [{ path: 'a.txt', id: 'A', roomPath: 'c.txt' }] },
			bothDeleted: { ...nothing, twoSided: [{ path: 'b.txt', id: 'B', roomPath: undefined }] },
			addedInsideRemovedFolder: { ...nothing, leaveOut: ['p/q', 'p/q/new.txt', 'p/q/r.txt'], removedInRoom: [{ id: 'Q', path: 'p/q' }, { id: 'R', path: 'p/q/r.txt' }], twoSided: [{ path: 'p/q/new.txt' }] },
		});
	});

	/**
	 * The owner's offline changes, applied to the room. Texts by file id are their hashes here:
	 * what this computer last had (`recorded`) and the room's now.
	 */
	function offline(room: Map<string, string>, onDisk: Set<string>, newOnDisk: [string, string][], roomChanged: string[] = [], recordedAs: [string, string][] = []) {
		const recorded = new Map([['A', 'a'], ['B', 'b'], ['C', 'c'], ['R', 'r'], ...recordedAs]);
		const roomHashes = new Map([...recorded].map(([id, hash]) => [id, roomChanged.includes(id) ? 'changed' : hash]));
		return planOwnerOfflineChanges(reconcileBeforeAttach(room, known, onDisk), room, onDisk, recorded, roomHashes, new Map(newOnDisk));
	}
	const diskWithout = (...gone: string[]) => new Set([...disk].filter(path => !gone.includes(path)));

	test('the owner\'s offline changes: a rename only when the old path is gone and one file matches; a delete only when the room kept the text; otherwise held', () => {
		assert.deepStrictEqual({
			// #29: a.txt renamed to e.txt, same text.
			renamed: offline(known, new Set([...diskWithout('a.txt'), 'e.txt']), [['e.txt', 'a']]),
			// A copy: a.txt still there, e.txt has its text. Not a candidate: e.txt is just new.
			copied: offline(known, new Set([...disk, 'e.txt']), [['e.txt', 'a']]),
			// #30: b.txt deleted.
			deleted: offline(known, diskWithout('b.txt'), []),
			// Renamed and edited: no match, so the old path is deleted and the new file sent as new.
			renamedAndEdited: offline(known, new Set([...diskWithout('a.txt'), 'e.txt']), [['e.txt', 'edited']]),
			// Two files could be a.txt's new name: held, both sent as new.
			twoCandidates: offline(known, new Set([...diskWithout('a.txt'), 'e.txt', 'f.txt']), [['e.txt', 'a'], ['f.txt', 'a']]),
			// One new file could be either of two missing files with the same text: both held.
			oneFileTwoClaims: offline(known, new Set([...diskWithout('a.txt', 'b.txt'), 'e.txt']), [['e.txt', 'a']], [], [['B', 'a']]),
			// The owner deleted b.txt, but the room changed it meanwhile: held.
			deletedButRoomEdited: offline(known, diskWithout('b.txt'), [], ['B']),
			// #23: the guest renamed a.txt to c2.txt, the owner renamed it to e.txt: the owner's applies last.
			bothRenamed: offline(new Map([...without(known, 'a.txt'), ['c2.txt', 'A']]), new Set([...diskWithout('a.txt'), 'e.txt']), [['e.txt', 'a']]),
			// #24: the guest renamed a.txt to c2.txt, the owner deleted it.
			renameAgainstDelete: offline(new Map([...without(known, 'a.txt'), ['c2.txt', 'A']]), diskWithout('a.txt'), []),
			// #25: both deleted b.txt: not in the room, nothing to do.
			bothDeleted: offline(without(known, 'b.txt'), diskWithout('b.txt'), []),
			// The owner deleted p/q/: one delete, the folder, which takes r.txt.
			folderDeleted: offline(known, diskWithout('p/q', 'p/q/r.txt'), []),
			// The owner renamed p/q/ to p/z/: r.txt renamed into p/z (sent in the attach), then p/q deleted.
			folderRenamed: offline(known, new Set([...diskWithout('p/q', 'p/q/r.txt'), 'p/z', 'p/z/r.txt']), [['p/z/r.txt', 'r']]),
		}, {
			renamed: { renames: [{ id: 'A', from: 'a.txt', to: 'e.txt' }], deletes: [], held: [] },
			copied: { renames: [], deletes: [], held: [] },
			deleted: { renames: [], deletes: [{ id: 'B', path: 'b.txt' }], held: [] },
			renamedAndEdited: { renames: [], deletes: [{ id: 'A', path: 'a.txt' }], held: [] },
			twoCandidates: { renames: [], deletes: [], held: [{ id: 'A', path: 'a.txt', reason: 'severalNames', candidates: ['e.txt', 'f.txt'] }] },
			oneFileTwoClaims: { renames: [], deletes: [], held: [{ id: 'A', path: 'a.txt', reason: 'sharedName', candidates: ['e.txt'] }, { id: 'B', path: 'b.txt', reason: 'sharedName', candidates: ['e.txt'] }] },
			deletedButRoomEdited: { renames: [], deletes: [], held: [{ id: 'B', path: 'b.txt', reason: 'roomEdited' }] },
			bothRenamed: { renames: [{ id: 'A', from: 'c2.txt', to: 'e.txt' }], deletes: [], held: [] },
			renameAgainstDelete: { renames: [], deletes: [{ id: 'A', path: 'c2.txt' }], held: [] },
			bothDeleted: { renames: [], deletes: [], held: [] },
			folderDeleted: { renames: [], deletes: [{ id: 'Q', path: 'p/q' }], held: [] },
			folderRenamed: { renames: [{ id: 'R', from: 'p/q/r.txt', to: 'p/z/r.txt' }], deletes: [{ id: 'Q', path: 'p/q' }], held: [] },
		});
	});

	test('the room\'s moves made on the owner\'s disk: a folder\'s move carries its contents', () => {
		assert.deepStrictEqual(outermostMoves([
			{ id: 'D', from: 'd', to: 'e' },
			{ id: 'C', from: 'd/c.txt', to: 'e/c.txt' },
			{ id: 'A', from: 'a.txt', to: 'e/a.txt' },
			// Moved out of the folder on its own as well: kept.
			{ id: 'X', from: 'd/x.txt', to: 'x.txt' },
		]), [
			{ id: 'D', from: 'd', to: 'e' },
			{ id: 'A', from: 'a.txt', to: 'e/a.txt' },
			{ id: 'X', from: 'd/x.txt', to: 'x.txt' },
		]);
	});

	/** What the room removed, as it reaches the owner's disk. Texts are hashes, as above. */
	function removals(room: Map<string, string>, onDisk: Set<string>, editedOnDisk: string[] = [], recordedAs: [string, string][] = []) {
		const recorded = new Map([['A', 'a'], ['B', 'b'], ['C', 'c'], ['R', 'r'], ...recordedAs]);
		const ids = new Map([...known].map(([path, id]) => [path, id]));
		const diskHashes = new Map([...onDisk].map(path => [path, editedOnDisk.includes(path) ? 'edited' : (recorded.get(ids.get(path) ?? '') ?? 'new')]));
		return planRoomRemovals(reconcileBeforeAttach(room, known, onDisk), new Set(['d', 'p', 'p/q', 'p/z']), recorded, diskHashes);
	}

	test('the room\'s removals on the owner\'s disk: to the Trash, unless the owner changed it meanwhile, which goes back to the room', () => {
		assert.deepStrictEqual({
			// #14: the guest deleted b.txt; unchanged here.
			deleted: removals(without(known, 'b.txt'), disk),
			// #16: the guest deleted p/q/: the folder goes whole.
			folderDeleted: removals(without(known, 'p/q', 'p/q/r.txt'), disk),
			// The guest deleted b.txt, the owner edited it while away: the edit survives.
			deletedButEdited: removals(without(known, 'b.txt'), disk, ['b.txt']),
			// The guest deleted p/q/, the owner edited p/q/r.txt: r.txt goes back; nothing else under p/q.
			folderDeletedFileEdited: removals(without(known, 'p/q', 'p/q/r.txt'), disk, ['p/q/r.txt']),
			// The guest deleted p/q/, the owner added p/q/new.txt: it goes back; r.txt to the Trash.
			folderDeletedFileAdded: removals(without(known, 'p/q', 'p/q/r.txt'), new Set([...disk, 'p/q/new.txt'])),
			// No record of b.txt's text: a change can't be seen, so the delete applies (to the Trash).
			deletedNoRecord: planRoomRemovals(reconcileBeforeAttach(without(known, 'b.txt'), known, disk), new Set(['d', 'p', 'p/q']), new Map(), new Map([['b.txt', 'anything']])),
		}, {
			deleted: { trash: ['b.txt'], sendBack: [] },
			folderDeleted: { trash: ['p/q'], sendBack: [] },
			deletedButEdited: { trash: [], sendBack: [{ path: 'b.txt', reason: 'changed on this disk while away' }] },
			folderDeletedFileEdited: { trash: [], sendBack: [{ path: 'p/q/r.txt', reason: 'changed on this disk while away' }] },
			folderDeletedFileAdded: { trash: ['p/q/r.txt'], sendBack: [{ path: 'p/q/new.txt', reason: 'added on this disk, inside a folder the room removed' }] },
			deletedNoRecord: { trash: ['b.txt'], sendBack: [] },
		});
	});

	test('a large removal is asked about first: 25 files, half of a room of 8 or more, or all of any room; ordinary work isn\'t', () => {
		assert.deepStrictEqual({
			removedByAFolder: [...filesRemovedBy([{ id: 'Q', path: 'p/q' }, { id: 'B', path: 'b.txt' }], known).values()].sort(),
			threeOfAHundred: isLargeRemoval(3, 100),
			twentyFourOfAHundred: isLargeRemoval(24, 100),
			twentyFiveOfAHundred: isLargeRemoval(25, 100),
			fourOfEight: isLargeRemoval(4, 8),
			threeOfEight: isLargeRemoval(3, 8),
			threeOfFour: isLargeRemoval(3, 4),
			allOfFour: isLargeRemoval(4, 4),
			oneOfOne: isLargeRemoval(1, 1),
			noneOfNone: isLargeRemoval(0, 0),
		}, {
			removedByAFolder: ['b.txt', 'p/q/r.txt'],
			threeOfAHundred: false,
			twentyFourOfAHundred: false,
			twentyFiveOfAHundred: true,
			fourOfEight: true,
			threeOfEight: false,
			threeOfFour: false,
			allOfFour: true,
			oneOfOne: true,
			noneOfNone: false,
		});
	});
});
