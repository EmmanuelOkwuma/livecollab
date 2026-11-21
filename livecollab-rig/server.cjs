/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Layer B's local server: the real LiveCollab server code, run as its own Node 24 process
// (better-sqlite3 is built for Node, not Electron), with Clerk stubbed, a throwaway database and
// Sentry off. Started and stopped by scripts/livecollab-b.sh; not meant to be run by hand.
//   LC_SERVER  the server folder (default ~/Desktop/livecollab/server)
//   LC_DB      the database folder (required: the wrapper makes a temp one)
//   LC_PORT    the port to listen on (required: the wrapper picks a free one)
// The Clerk stub accepts any token of the form x.<base64url JSON with "sub">.y, so a test names
// its own users. It never talks to Clerk: the SDK is stubbed, and the Backend API calls go to the
// stand-in below.
// The rig runs as a supervisor and a worker. The worker is the server; the supervisor starts it,
// and starts it again after POST /__rig/restart {downMs, signal}: the worker is sent SIGTERM, as
// Railway sends it on a deploy (the server's handler runs), or SIGKILL (a crash, or Railway's kill
// after its grace period: nothing runs), and the supervisor waits downMs before starting a new
// worker on the same database and port. forgetDocs: before the new worker starts, the database
// loses every room document (yjs_docs and yjs_doc_updates; trees and members stay), as a server
// that never saved them would come back: the room has no document until the owner re-attaches.
if (process.env.LC_RIG_WORKER !== '1') {
	const { fork } = require('child_process');
	let worker;
	let restartAfterMs;
	let forgetDocs = false;
	let stopping = false;
	const forgetRoomDocs = () => {
		const serverDir = process.env.LC_SERVER || require('path').join(require('os').homedir(), 'Desktop/livecollab/server');
		const Database = require('module').createRequire(require('path').join(serverDir, 'index.js'))('better-sqlite3');
		const db = new Database(require('path').join(process.env.LC_DB, 'livecollab.sqlite'));
		const docs = db.prepare('DELETE FROM yjs_docs').run().changes;
		const hasUpdates = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'yjs_doc_updates'`).get();
		const updates = hasUpdates ? db.prepare('DELETE FROM yjs_doc_updates').run().changes : 0;
		db.close();
		console.log(`livecollab-rig: forgot ${docs} room documents and ${updates} pending changes`);
	};
	const start = () => {
		worker = fork(__filename, [], { env: { ...process.env, LC_RIG_WORKER: '1' }, stdio: 'inherit' });
		worker.on('message', message => { if (message && typeof message.restartAfterMs === 'number') { restartAfterMs = message.restartAfterMs; forgetDocs = message.forgetDocs === true; } });
		worker.on('exit', () => {
			if (stopping) { process.exit(0); }
			if (restartAfterMs === undefined) { console.error('livecollab-rig: the server exited without a restart being asked for'); process.exit(1); }
			const wait = restartAfterMs;
			restartAfterMs = undefined;
			if (forgetDocs) { forgetDocs = false; forgetRoomDocs(); }
			console.log(`livecollab-rig: server stopped; starting it again in ${wait} ms`);
			setTimeout(start, wait);
		});
	};
	for (const signal of ['SIGTERM', 'SIGINT']) {
		process.on(signal, () => {
			stopping = true;
			if (worker && worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGTERM'); } else { process.exit(0); }
		});
	}
	start();
	return;
}
const Module = require('module');
const path = require('path');
const os = require('os');

const serverDir = process.env.LC_SERVER || path.join(os.homedir(), 'Desktop/livecollab/server');
if (!process.env.LC_DB || !process.env.LC_PORT) {
	console.error('livecollab-rig/server.cjs: LC_DB and LC_PORT are required');
	process.exit(2);
}
const req = Module.createRequire(path.join(serverDir, 'index.js'));
// The people Clerk knows, as the stand-in Clerk below and the SDK stub both see them. Someone the
// rig hasn't been told about is named after their sub.
// The name fields the real Clerk instance requires (its public environment: first_name and
// last_name enabled and required). Keep in step with the instance, so a test meets its refusals.
const REQUIRED_NAME_FIELDS = ['first_name', 'last_name'];
const users = new Map(); // sub → { first_name, last_name, public_metadata }
function user(sub) {
	if (!users.has(sub)) { users.set(sub, { first_name: sub, last_name: '', public_metadata: {} }); }
	return users.get(sub);
}
function readBody(request) {
	return new Promise(resolve => { let body = ''; request.on('data', chunk => body += chunk); request.on('end', () => resolve(body ? JSON.parse(body) : {})); });
}
let lookupDelay = 0;
let docsUnavailable = false;
let failAppends = false;
let failChat = false;
let dropChatAnswers = false;
const refused = { notReady: 0, notSaved: 0 };
// docs-unavailable: the server's own answers for a missing document, given in its place.
const { Socket } = req('socket.io');
const socketOn = Socket.prototype.on;
Socket.prototype.on = function (event, handler) {
	// drop-chat-answers: a chat:send is handled (saved, sent to the room) but its answer never reaches the sender.
	if (event === 'chat:send') {
		return socketOn.call(this, event, (...args) => {
			if (!dropChatAnswers || typeof args[args.length - 1] !== 'function') { return handler(...args); }
			return handler(...args.slice(0, -1), () => { });
		});
	}
	if (event !== 'yjs:update' && event !== 'yjs:sync' && event !== 'yjs:sync-reply') {
		return socketOn.call(this, event, handler);
	}
	return socketOn.call(this, event, (...args) => {
		if (!docsUnavailable) { return handler(...args); }
		const payload = args[0] || {};
		const ack = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
		refused.notReady++;
		if (event === 'yjs:update') { this.emit('yjs:not-ready', { roomId: payload.roomId, fileId: payload.fileId }); }
		else if (ack) { ack({ ok: false, error: 'no_doc' }); }
	});
};
const http = require('http');
const createServer = http.createServer;
// The rig's own routes, answered before the server sees the request:
//   POST /__rig/name {sub, name, metadataName?}  the name Clerk has (an empty name: none; metadataName:
//                                                 an older public_metadata.displayName, as 0.3.4's onboarding wrote)
//   GET  /__rig/user?sub=…                       what Clerk has for that person
//   POST /__rig/restart {downMs, signal,         the server is sent signal (SIGTERM, a deploy, by
//                        forgetDocs}              default; or SIGKILL) and started again downMs later
//                                                 (the supervisor above), without its room documents
//                                                 if forgetDocs
//   POST /__rig/docs-unavailable {on}           while on, the server answers every document change and
//                                                 rejoin check as it does for a document it doesn't have
//                                                 (yjs:not-ready; no_doc): nothing is applied, and every
//                                                 document and its history stay as they are
//   POST /__rig/fail-appends {on}                while on, the database refuses every appended change
//   GET  /__rig/refused                          {notReady, notSaved}: how many changes were refused
//   POST /__rig/fail-chat {on}                   while on, the database refuses every chat message
//   POST /__rig/drop-chat-answers {on}           while on, a chat message is saved and sent to the room,
//                                                 but the sender's answer is never sent
//   POST /__rig/slow-names {ms}                  the SDK's user lookup (the server's name lookup on a
//                                                 cache miss) takes ms longer (0: at once again)
http.createServer = (...args) => {
	const handler = args.find(arg => typeof arg === 'function');
	return createServer.call(http, ...args.filter(arg => arg !== handler), async (request, response) => {
		if (request.method === 'POST' && request.url === '/__rig/name') {
			const { sub, name, metadataName } = await readBody(request);
			Object.assign(user(sub), { first_name: name, last_name: '', public_metadata: metadataName === undefined ? {} : { displayName: metadataName } });
			response.writeHead(204).end();
			return;
		}
		if (request.method === 'POST' && request.url === '/__rig/restart') {
			const { downMs, signal, forgetDocs } = await readBody(request);
			process.send({ restartAfterMs: Number(downMs) || 0, forgetDocs: forgetDocs === true });
			response.writeHead(204).end(() => process.kill(process.pid, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'));
			return;
		}
		if (request.method === 'POST' && request.url === '/__rig/docs-unavailable') {
			docsUnavailable = (await readBody(request)).on === true;
			response.writeHead(204).end();
			return;
		}
		if (request.method === 'POST' && request.url === '/__rig/fail-appends') {
			failAppends = (await readBody(request)).on === true;
			response.writeHead(204).end();
			return;
		}
		if (request.method === 'POST' && request.url === '/__rig/drop-chat-answers') {
			dropChatAnswers = (await readBody(request)).on === true;
			response.writeHead(204).end();
			return;
		}
		if (request.method === 'POST' && request.url === '/__rig/fail-chat') {
			failChat = (await readBody(request)).on === true;
			response.writeHead(204).end();
			return;
		}
		if (request.method === 'GET' && request.url === '/__rig/refused') {
			response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }).end(JSON.stringify(refused));
			return;
		}
		if (request.method === 'POST' && request.url === '/__rig/slow-names') {
			lookupDelay = Number((await readBody(request)).ms) || 0;
			response.writeHead(204).end();
			return;
		}
		if (request.method === 'GET' && request.url.startsWith('/__rig/user?')) {
			const sub = new URL(request.url, 'http://rig').searchParams.get('sub');
			response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }).end(JSON.stringify(user(sub)));
			return;
		}
		handler(request, response);
	});
};
// A stand-in for Clerk's Backend API (LC_CLERK_API_URL), so the server's HTTP routes run in the
// rig as they do against Clerk: users read and written, metadata merged (null removes a key),
// session tokens minted for a session id of the form <sub>, and sessions always active.
const clerkApi = createServer.call(http, async (request, response) => {
	const send = (code, body) => response.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
	const url = new URL(request.url, 'http://clerk');
	let m;
	if ((m = /^\/v1\/users\/([^/]+)\/metadata$/.exec(url.pathname)) && request.method === 'PATCH') {
		const u = user(decodeURIComponent(m[1]));
		const { public_metadata: changes = {} } = await readBody(request);
		for (const [key, value] of Object.entries(changes)) { if (value === null) { delete u.public_metadata[key]; } else { u.public_metadata[key] = value; } }
		return send(200, { id: m[1], ...u });
	}
	if ((m = /^\/v1\/users\/([^/]+)$/.exec(url.pathname))) {
		const id = decodeURIComponent(m[1]);
		const u = user(id);
		if (request.method === 'PATCH') {
			const changes = await readBody(request);
			// As the real development instance is set (2026-11-06: first and last name both required):
			// an empty one is refused as missing, and nothing is written.
			for (const key of REQUIRED_NAME_FIELDS) {
				if (key in changes && !String(changes[key] ?? '').trim()) { return send(422, { errors: [{ code: 'form_param_missing', meta: { param_name: key } }] }); }
			}
			for (const key of ['first_name', 'last_name']) { if (key in changes) { u[key] = changes[key]; } }
		}
		return send(200, { id, ...u, email_addresses: [{ id: 'e', email_address: id + '@test.invalid' }], primary_email_address_id: 'e', image_url: '' });
	}
	if ((m = /^\/v1\/sessions\/([^/]+)\/tokens$/.exec(url.pathname))) {
		const sid = decodeURIComponent(m[1]);
		return send(200, { jwt: 'x.' + Buffer.from(JSON.stringify({ sub: sid, sid })).toString('base64url') + '.y' });
	}
	if ((m = /^\/v1\/sessions\/([^/]+)\/revoke$/.exec(url.pathname))) { return send(200, { id: decodeURIComponent(m[1]), status: 'revoked' }); }
	if ((m = /^\/v1\/sessions\/([^/]+)$/.exec(url.pathname))) { return send(200, { id: decodeURIComponent(m[1]), status: 'active' }); }
	send(404, { errors: [{ code: 'resource_not_found' }] });
});
const clerkId = req.resolve('@clerk/backend');
req.cache[clerkId] = {
	id: clerkId, filename: clerkId, loaded: true, exports: {
		verifyToken: async token => { const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')); return { sub: claims.sub, sid: claims.sid || 's' }; },
		createClerkClient: () => ({ users: { getUser: async id => { if (lookupDelay) { await new Promise(resolve => setTimeout(resolve, lookupDelay)); } const u = user(id); return { id, firstName: u.first_name, lastName: u.last_name, emailAddresses: [{ id: 'e', emailAddress: id + '@test.invalid' }], primaryEmailAddressId: 'e', publicMetadata: { ...u.public_metadata } }; } } }),
	}
};
clerkApi.listen(0, '127.0.0.1', () => {
	Object.assign(process.env, {
		PORT: process.env.LC_PORT, SENTRY_DSN: '', RAILWAY_VOLUME_MOUNT_PATH: process.env.LC_DB, CLERK_SECRET_KEY: 'test-stub',
		LC_CLERK_API_URL: `http://127.0.0.1:${clerkApi.address().port}`,
	});
	// fail-appends: the server's database module, as index.js uses it, refusing appends.
	const db = req('./db');
	if (db.appendYjsUpdate) {
		const append = db.appendYjsUpdate;
		db.appendYjsUpdate = (...args) => {
			if (failAppends) { refused.notSaved++; throw new Error('livecollab-rig: appends fail'); }
			return append(...args);
		};
	}
	// fail-chat: the same module refusing chat messages.
	if (db.addChatMessage) {
		const add = db.addChatMessage;
		db.addChatMessage = (...args) => {
			if (failChat) { throw new Error('livecollab-rig: chat messages fail'); }
			return add(...args);
		};
	}
	req('./index.js');
});
