/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Can the owner's path -> id map hold a stale entry? (ATTACH_RECONCILE_DESIGN.md, "Stale owner map")
// The real server code (in process, Clerk stubbed, throwaway DB, Sentry off) and the REAL
// LiveCollabFileSystemProvider from out/ (run `npm run transpile-client` first). The owner's map is
// driven with exactly the calls the folder contribution makes:
//   attach ack            -> storeServerFileIds(ack.tree)        (livecollabFolderContribution.ts:1558)
//   room:file:created     -> setServerFileId(path, id)           (:417)
//   room:file:renamed     -> renameServerFileId(old, new, isDir) (:479)
//   room:file:deleted     -> removeServerFileId(path) per file   (:578)
//   owner's own rename/delete while offline: nothing (emitFile* returns when not connected)
// A reconnect is not a new room session (livecollabService.ts:495), so the map is not cleared.
//   node livecollab-rig/staleMap.mjs   (Node 24)
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Minimal browser globals so the provider module (and the service it imports) can load in Node.
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.document = { addEventListener() { }, createElement: () => ({ style: {}, setAttribute() { }, appendChild() { } }), head: { appendChild() { } }, body: { appendChild() { } }, documentElement: { style: {} }, querySelector: () => null, querySelectorAll: () => [] };
globalThis.navigator ??= { userAgent: 'node' };
globalThis.location ??= { href: 'file:///', search: '' };

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SERVER = process.env.LC_SERVER || path.join(os.homedir(), 'Desktop/livecollab/server');
const CLIENT = process.env.LC_CLIENT || path.join(os.homedir(), 'Desktop/livecollab/node_modules/socket.io-client');
const DB = process.env.LC_DB || fs.mkdtempSync(path.join(os.tmpdir(), 'lc-stale-'));

const out = console.log;
const quiet = () => { console.log = console.warn = console.error = console.info = console.debug = () => { }; };
quiet();
const { LiveCollabFileSystemProvider } = await import(path.join(repo, 'out/vs/workbench/contrib/livecollab/browser/livecollabFileSystemProvider.js'));

const req = createRequire(path.join(SERVER, 'index.js'));
const cid = req.resolve('@clerk/backend');
req.cache[cid] = { id: cid, filename: cid, loaded: true, exports: { verifyToken: async t => ({ sub: JSON.parse(Buffer.from(t.split('.')[1], 'base64url')).sub, sid: 's' }), createClerkClient: () => ({ users: { getUser: async id => ({ id, firstName: id, emailAddresses: [{ id: 'e', emailAddress: id + '@t.invalid' }], primaryEmailAddressId: 'e', publicMetadata: {} }) } }) } };
Object.assign(process.env, { PORT: '4978', SENTRY_DSN: '', RAILWAY_VOLUME_MOUNT_PATH: DB, CLERK_SECRET_KEY: 'x' });
req('./index.js');
const { io } = createRequire(import.meta.url)(CLIENT);

const tok = u => 'x.' + Buffer.from(JSON.stringify({ sub: u, iat: 1, exp: 9e9 })).toString('base64url') + '.y';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ask = (s, e, p) => new Promise(r => { s.emit(e, p, a => r(a)); setTimeout(() => r('NO_ACK'), 1500); });
const conn = u => new Promise((r, j) => { const s = io('http://127.0.0.1:4978', { auth: { token: tok(u) }, transports: ['websocket'], reconnection: false }); s.on('connect', () => r(s)); s.on('connect_error', j); });
const f = (p, c) => ({ name: p.split('/').pop(), path: p, type: 'file', content: c ?? ('disk:' + p) });
const dir = (p, children) => ({ name: p.split('/').pop(), path: p, type: 'directory', children });
const flat = (t, o = new Map()) => { for (const n of t) { o.set(n.path, n.id); if (n.children) { flat(n.children, o); } } return o; };
const find = (t, p) => flat(t).get(p);

/** The owner's disk as a mutable list of file paths; folders are derived. */
function diskTree(files) {
	const root = [];
	for (const p of [...files].sort()) {
		const parts = p.split('/');
		let level = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const dp = parts.slice(0, i + 1).join('/');
			let d = level.find(n => n.path === dp);
			if (!d) { d = dir(dp, []); level.push(d); }
			level = d.children;
		}
		level.push(f(p));
	}
	return root;
}

/** One owner: a socket and the real provider's id map, wired as the folder contribution wires it. */
function wireOwner(socket, provider) {
	socket.on('room:file:created', ({ fileId, path: p }) => provider.setServerFileId(p, fileId));
	socket.on('room:file:renamed', ({ oldPath, newPath, type }) => provider.renameServerFileId(oldPath, newPath, type === 'directory'));
	socket.on('room:file:deleted', ({ files }) => { for (const { path: p } of files) { provider.removeServerFileId(p); } });
}

let n = 0;
async function run(id, title, { guest = async () => { }, ownerOffline = d => d, withheld, online = false }) {
	const provider = new LiveCollabFileSystemProvider(() => { }, { hasLiveDoc: () => false, getSnapshotText: async () => '' });
	let disk = new Set(['a.txt', 'b.txt', 'p/q/r.txt', 'p/q/s.txt']);
	let o = await conn('owner'); const g = await conn('guest');
	wireOwner(o, provider);
	const { roomId } = await ask(o, 'room:create', { name: 'stale' + (n++) });
	await ask(o, 'room:join', { roomId });
	provider.storeServerFileIds((await ask(o, 'room:attach', { roomId, folderName: 'f', tree: diskTree(disk) })).tree);
	const inv = await ask(o, 'room:invite:create', { roomId });
	await ask(g, 'room:invite:accept', { code: inv.code });
	await ask(g, 'room:join', { roomId });
	const roomIdOf = async p => find((await ask(g, 'room:request-snapshot', { roomId })).tree, p);
	if (!online) { o.disconnect(); await sleep(100); }
	await guest(g, roomId, roomIdOf);
	await sleep(200);
	if (!online) {
		disk = ownerOffline(disk);
		o = await conn('owner'); wireOwner(o, provider);
		await ask(o, 'room:join', { roomId });
		const ack = await ask(o, 'room:attach', { roomId, folderName: 'f', tree: diskTree(withheld ? [...disk].filter(p => !withheld.includes(p)) : disk), withheld });
		provider.storeServerFileIds(ack.tree);
	}
	await sleep(100);
	const room = flat((await ask(g, 'room:request-snapshot', { roomId })).tree);
	const map = provider.allServerIds();
	const stale = map.filter(([p, i]) => room.get(p) !== i);
	const ids = [...new Set(map.map(([, i]) => i))];
	const wrongPath = ids.filter(i => [...room].some(([, ri]) => ri === i)).map(i => [i, provider.getPathForServerFileId(i), [...room].find(([, ri]) => ri === i)[0]]).filter(([, mp, rp]) => mp !== rp);
	out(`\n#${id} ${title}`);
	out('  owner disk at re-attach   ' + [...disk].sort().join(' '));
	out('  room after                ' + [...room.keys()].join(' '));
	out('  stale map entries         ' + (stale.length ? stale.map(([p]) => `${p} (room: ${room.has(p) ? 'other id' : 'no such path'}; on owner disk: ${disk.has(p) ? 'yes' : 'no'})`).join(' | ') : 'none'));
	out('  persister path for an id  ' + (wrongPath.length ? wrongPath.map(([, mp, rp]) => `room file ${rp} -> getPathForServerFileId gives ${mp}`).join(' | ') : 'all match the room'));
	o.disconnect(); g.disconnect(); provider.dispose?.();
}

const rename = (from, to) => async (g, r, idOf) => ask(g, 'room:file:rename', { roomId: r, fileId: await idOf(from), oldPath: from, newPath: to });
const del = p => async (g, r, idOf) => ask(g, 'room:file:delete', { roomId: r, fileId: await idOf(p), path: p });
const without = (...ps) => d => new Set([...d].filter(p => !ps.some(x => p === x || p.startsWith(x + '/'))));
const renamedOnDisk = (from, to) => d => new Set([...d].map(p => p === from ? to : p));

out('Owner disk at the start: a.txt b.txt p/q/r.txt p/q/s.txt');
await run('C1', 'control: guest renames a.txt -> c.txt while the owner is away; owner disk unchanged', { guest: rename('a.txt', 'c.txt') });
await run('C2', 'control: owner renames a.txt -> d.txt on disk while away; guest does nothing', { ownerOffline: renamedOnDisk('a.txt', 'd.txt') });
await run('C4', 'control: owner deletes b.txt on disk while away; guest does nothing', { ownerOffline: without('b.txt') });
await run('C3', 'control: both connected, guest deletes b.txt', { guest: del('b.txt'), online: true });
await run('S1', 'owner away: guest renames a.txt -> c.txt AND owner renames a.txt -> d.txt on disk', { guest: rename('a.txt', 'c.txt'), ownerOffline: renamedOnDisk('a.txt', 'd.txt') });
await run('S2', 'owner away: guest deletes b.txt AND owner deletes b.txt on disk', { guest: del('b.txt'), ownerOffline: without('b.txt') });
await run('S3', 'owner away: guest renames a.txt -> c.txt AND owner deletes a.txt on disk', { guest: rename('a.txt', 'c.txt'), ownerOffline: without('a.txt') });
await run('S4', 'owner away: guest deletes folder p/q AND owner deletes p/q on disk', { guest: del('p/q'), ownerOffline: without('p/q') });
await run('S5', 'owner away: guest deletes b.txt AND owner renames b.txt -> e.txt on disk', { guest: del('b.txt'), ownerOffline: renamedOnDisk('b.txt', 'e.txt') });
await run('W1', 'withheld: a.txt on the owner disk becomes a link; the re-attach withholds it', { withheld: ['a.txt'] });
process.exit(0);
