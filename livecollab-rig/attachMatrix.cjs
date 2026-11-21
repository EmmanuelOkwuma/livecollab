/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// The 22-case attach matrix (ATTACH_RECONCILE_DESIGN.md): the real server code, two real sockets,
// Clerk stubbed, a throwaway database, Sentry off. Answers the room-state half only.
//   node livecollab-rig/attachMatrix.cjs            (Node 24; the server's better-sqlite3 is built for it)
//   TEXTS=1 node livecollab-rig/attachMatrix.cjs    (the texts variant of #13, #14, #16)
// Environment, with defaults: LC_SERVER=~/Desktop/livecollab/server,
// LC_CLIENT=~/Desktop/livecollab/node_modules/socket.io-client, LC_DB=a new temp directory.
const Module=require('module'),path=require('path'),os=require('os'),fs=require('fs');
process.env.LC_SERVER=process.env.LC_SERVER||path.join(os.homedir(),'Desktop/livecollab/server');
process.env.LC_CLIENT=process.env.LC_CLIENT||path.join(os.homedir(),'Desktop/livecollab/node_modules/socket.io-client');
process.env.LC_DB=process.env.LC_DB||fs.mkdtempSync(path.join(os.tmpdir(),'lc-matrix-'));
const S=process.env.LC_SERVER;const req=Module.createRequire(path.join(S,'index.js'));
const cid=req.resolve('@clerk/backend');
require.cache[cid]={id:cid,filename:cid,loaded:true,exports:{verifyToken:async t=>({sub:JSON.parse(Buffer.from(t.split('.')[1],'base64url')).sub,sid:'s'}),createClerkClient:()=>({users:{getUser:async id=>({id,firstName:id,emailAddresses:[{id:'e',emailAddress:id+'@t.invalid'}],primaryEmailAddressId:'e',publicMetadata:{}})}})}};
process.env.PORT='4979';process.env.SENTRY_DSN='';process.env.RAILWAY_VOLUME_MOUNT_PATH=process.env.LC_DB;process.env.CLERK_SECRET_KEY='x';
const out=console.log;console.log=console.warn=console.error=()=>{};
req('./index.js');
const Y=req('yjs');
const {io}=require(process.env.LC_CLIENT);
const tok=u=>'x.'+Buffer.from(JSON.stringify({sub:u,iat:1,exp:9e9})).toString('base64url')+'.y';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function conn(u){return new Promise((r,j)=>{const s=io('http://127.0.0.1:4979',{auth:{token:tok(u)},transports:['websocket'],reconnection:false});s.ev=[];
 s.on('room:file:created',p=>s.ev.push('created '+p.path));
 s.on('room:file:renamed',p=>s.ev.push('renamed '+p.oldPath+'->'+p.newPath+(p.type==='directory'?' (dir)':'')));
 s.on('room:file:deleted',p=>s.ev.push('deleted '+p.files.map(f=>f.path).join(',')));
 s.on('room:snapshot',p=>s.ev.push('snapshot['+list(p.tree).join(' ')+']'));
 s.on('yjs:update',p=>s.ev.push('yjs:update '+(pathOf(p.fileId)||p.fileId)));
 s.on('connect',()=>r(s));s.on('connect_error',j);});}
const ask=(s,e,p)=>new Promise(r=>{s.emit(e,p,a=>r(a));setTimeout(()=>r('NO_ACK'),1500);});
// Tree listing: dirs end in '/', files carry 4 chars of their id so a re-minted file shows.
let lastIds={};
function list(t,o=[]){for(const n of t){if(n.type==='directory'){o.push(n.path+'/'+((!n.children||!n.children.length)?'(empty)':''));if(n.children)list(n.children,o);}else{o.push(n.path+'#'+n.id.slice(5,9));lastIds[n.id]=n.path;}}return o;}
const pathOf=id=>lastIds[id];
function find(t,p){for(const n of t){if(n.path===p)return n;if(n.children){const x=find(n.children,p);if(x)return x;}}}
function text(snap,p){const n=find(snap.tree,p);if(!n)return '(no such path)';const d=(snap.docs||[]).find(x=>x.fileId===n.id);if(!d)return '(no doc)';const doc=new Y.Doc();Y.applyUpdate(doc,new Uint8Array(d.state));return JSON.stringify(doc.getText('content').toString());}
const f=(p,c)=>({name:p.split('/').pop(),path:p,type:'file',content:c??('disk:'+p)});
const dir=(p,children)=>({name:p.split('/').pop(),path:p,type:'directory',children});
// The owner's folder on disk. p/ holds only p/q/, to see whether an emptied parent is left.
const DISK=[f('a.txt'),f('b.txt'),dir('d',[f('d/c.txt'),f('d/e.txt')]),dir('p',[dir('p/q',[f('p/q/r.txt'),f('p/q/s.txt')])])];
let n=0;
var setup=async function(){
 const o=await conn('owner');const g=await conn('guest');
 const {roomId}=await ask(o,'room:create',{name:'m'+(n++)});await ask(o,'room:join',{roomId});
 await ask(o,'room:attach',{roomId,folderName:'f',tree:DISK});
 const inv=await ask(o,'room:invite:create',{roomId});await ask(g,'room:invite:accept',{code:inv.code});await ask(g,'room:join',{roomId});
 await sleep(100);o.ev=[];g.ev=[];return {o,g,roomId};
}
const snap=async(s,roomId)=>ask(s,'room:request-snapshot',{roomId});
async function idOf(s,roomId,p){return find((await snap(s,roomId)).tree,p).id;}
// The actions, as the client sends them (FolderContribution _detect* -> emitFile*).
const A={
 createFile:async(s,r)=>ask(s,'room:file:create',{roomId:r,path:'new.txt'}),
 renameFile:async(s,r)=>ask(s,'room:file:rename',{roomId:r,fileId:await idOf(s,r,'a.txt'),oldPath:'a.txt',newPath:'renamed.txt'}),
 deleteFile:async(s,r)=>ask(s,'room:file:delete',{roomId:r,fileId:await idOf(s,r,'b.txt'),path:'b.txt'}),
 // An empty folder isn't sent (_detectCreate skips directories); it reaches the room with its first file.
 createFolder:async(s,r)=>ask(s,'room:file:create',{roomId:r,path:'n/x.txt'}),
 // The Explorer deletes a folder as one operation on the folder's path.
 deleteFolder:async(s,r)=>ask(s,'room:file:delete',{roomId:r,fileId:await idOf(s,r,'p/q'),path:'p/q'}),
 editFile:async(s,r)=>{const sn=await snap(s,r);const node=find(sn.tree,'a.txt');const doc=new Y.Doc();Y.applyUpdate(doc,new Uint8Array(sn.docs.find(x=>x.fileId===node.id).state));const sv=Y.encodeStateVector(doc);const t=doc.getText('content');t.insert(t.length,' +edit');s.emit('yjs:update',{roomId:r,fileId:node.id,update:Array.from(Y.encodeStateAsUpdate(doc,sv))});await sleep(150);return 'sent';},
};
const ack=a=>a&&typeof a==='object'?(a.ok?'ok':'refused '+a.error):String(a);
function show(id,title,rows){out('\n#'+id+' '+title);for(const [k,v] of rows)out('  '+k.padEnd(28)+(Array.isArray(v)?(v.length?v.join(' | '):'(none)'):v));}
async function group1(id,title,actor,action){
 const {o,g,roomId}=await setup();const me=actor==='guest'?g:o,other=actor==='guest'?o:g;
 const a=await A[action](me,roomId);await sleep(200);const sn=await snap(o,roomId);
 show(id,title,[['actor ack',ack(a)],['room tree',list(sn.tree).join(' ')],[actor+' (actor) received',me.ev],[(actor==='guest'?'owner':'guest')+' received',other.ev],...(action==='editFile'?[['a.txt in room',text(sn,'a.txt')]]:[])]);
 o.disconnect();g.disconnect();
}
async function group2(id,title,action){
 let {o,g,roomId}=await setup();const before=list((await snap(g,roomId)).tree).join(' ');
 o.disconnect();await sleep(100);
 const a=await A[action](g,roomId);await sleep(200);const during=await snap(g,roomId);
 g.ev=[];o=await conn('owner');await ask(o,'room:join',{roomId});
 const re=await ask(o,'room:attach',{roomId,folderName:'f',tree:DISK});await sleep(200);const after=await snap(g,roomId);
 show(id,title,[['guest ack',ack(a)],['room before',before],['room while owner away',list(during.tree).join(' ')],['owner re-attach ack tree',re.ok?list(re.tree).join(' '):ack(re)],['room after re-attach',list(after.tree).join(' ')],['owner received on return',o.ev],['guest received on re-attach',g.ev],...(action==='editFile'?[['a.txt while away',text(during,'a.txt')],['a.txt after re-attach',text(after,'a.txt')]]:[]),...(process.env.TEXTS?[['texts after re-attach',['a.txt','renamed.txt','b.txt','p/q/r.txt'].map(p=>p+'='+text(after,p))]]:[])]);
 o.disconnect();g.disconnect();
}
async function group3(id,title,action){
 let {o,g,roomId}=await setup();const before=list((await snap(o,roomId)).tree).join(' ');
 g.disconnect();await sleep(100);
 const a=await A[action](o,roomId);await sleep(200);const during=await snap(o,roomId);
 g=await conn('guest');const j=await ask(g,'room:join',{roomId});const sn=await snap(g,roomId);await sleep(100);
 show(id,title,[['owner ack',ack(a)],['room before',before],['room while guest away',list(during.tree).join(' ')],['guest join ack',ack(j)],['guest snapshot on return',list(sn.tree).join(' ')],['guest received on return',g.ev],...(action==='editFile'?[['a.txt in guest snapshot',text(sn,'a.txt')]]:[])]);
 o.disconnect();g.disconnect();
}
async function editAll(s,r){for(const p of ['a.txt','b.txt','p/q/r.txt']){const sn=await snap(s,r);const node=find(sn.tree,p);const doc=new Y.Doc();Y.applyUpdate(doc,new Uint8Array(sn.docs.find(x=>x.fileId===node.id).state));const sv=Y.encodeStateVector(doc);const t=doc.getText('content');t.insert(t.length,' +room');s.emit('yjs:update',{roomId:r,fileId:node.id,update:Array.from(Y.encodeStateAsUpdate(doc,sv))});}await sleep(150);}
if(process.env.TEXTS){const orig=setup;setup=async()=>{const x=await orig();await editAll(x.g,x.roomId);return x;};
 (async()=>{out('Texts variant: room edits (+room) to a.txt, b.txt, p/q/r.txt made first, both connected');await group2(13,'guest renames a file','renameFile');await group2(14,'guest deletes a file','deleteFile');await group2(16,'guest deletes a folder with files','deleteFolder');process.exit(0);})();}
else (async()=>{
 out('DISK (owner folder, every case): '+list(DISK.map(function ids(x){return {...x,id:'file-----',children:x.children&&x.children.map(ids)};})).map(s=>s.replace('#----','')).join(' '));
 out('\n=== GROUP 1: both connected ===');
 await group1(1,'guest creates a file','guest','createFile');
 await group1(2,'owner creates a file','owner','createFile');
 await group1(3,'guest renames a file','guest','renameFile');
 await group1(4,'owner renames a file','owner','renameFile');
 await group1(5,'guest deletes a file','guest','deleteFile');
 await group1(6,'owner deletes a file','owner','deleteFile');
 await group1(7,'guest creates a folder with a file','guest','createFolder');
 await group1(8,'owner creates a folder with a file','owner','createFolder');
 await group1(9,'guest deletes a folder with files','guest','deleteFolder');
 await group1(10,'owner deletes a folder with files','owner','deleteFolder');
 out('\n=== GROUP 2: owner away, guest acts, owner re-attaches its unchanged disk ===');
 await group2(11,'guest creates a file','createFile');
 await group2(12,'guest edits a file','editFile');
 await group2(13,'guest renames a file','renameFile');
 await group2(14,'guest deletes a file','deleteFile');
 await group2(15,'guest creates a folder with a file','createFolder');
 await group2(16,'guest deletes a folder with files','deleteFolder');
 out('\n=== GROUP 3: guest away, owner acts, guest reconnects ===');
 await group3(17,'owner creates a file','createFile');
 await group3(18,'owner edits a file','editFile');
 await group3(19,'owner renames a file','renameFile');
 await group3(20,'owner deletes a file','deleteFile');
 await group3(21,'owner creates a folder with a file','createFolder');
 await group3(22,'owner deletes a folder with files','deleteFolder');
 process.exit(0);
})().catch(e=>{out('FAIL',e&&e.stack||e);process.exit(1);});
