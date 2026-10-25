import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../server/package.json',import.meta.url));
const express=require('express');
const {generateKeyPair,SignJWT,createLocalJWKSet,exportJWK}=await import('../server/node_modules/jose/dist/webapi/index.js');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nutri-oauth-'));
Object.assign(process.env,{DB_PATH:path.join(dir,'test.db'),NODE_ENV:'test',BODY_MEASUREMENTS_SOURCE:'internal',MCP_ENABLED:'1',MCP_WRITE_ENABLED:'1',MCP_DESTROY_ENABLED:'1',MCP_OAUTH_ENABLED:'1',MCP_OAUTH_RESOURCE_URL:'https://nutri.example/api/mcp',MCP_OAUTH_ISSUER:'https://issuer.example/',MCP_OAUTH_OWNER_SUB:'owner',MCP_OAUTH_CLIENT_ID:'chat-client',MCP_OAUTH_USER_ID:'1',JWT_SECRET:'synthetic-test-secret'});
const {default:db}=await import('../server/db.js');
const owner=Number(db.prepare("INSERT INTO users(username,password_hash,role)VALUES('owner','synthetic','admin')").run().lastInsertRowid);
const other=Number(db.prepare("INSERT INTO users(username,password_hash,role)VALUES('other','synthetic','user')").run().lastInsertRowid);
process.env.MCP_OAUTH_USER_ID=String(owner);
const {oauthConfig,resourceMetadata}=await import('../server/lib/mcp/oauth-config.js');
const {verifyOAuthToken}=await import('../server/lib/mcp/oauth-auth.js');
const {createMcpAuth}=await import('../server/middleware/mcp-auth.js');
const {metadataRouter}=await import('../server/routes/mcp-metadata.js');
const {bodyWritePolicy}=await import('../server/middleware/body-write-policy.js');
const {publicKey,privateKey}=await generateKeyPair('RS256');
const jwk=await exportJWK(publicKey);jwk.kid='test';
const keys=createLocalJWKSet({keys:[jwk]});
const config=()=>oauthConfig();
const token=async(overrides={})=>{
 const now=Math.floor(Date.now()/1000);
 return new SignJWT({iss:config().issuer,aud:config().resource,sub:'owner',azp:'chat-client',iat:now,exp:now+300,scope:'mcp:read mcp:write mcp:goals:write mcp:destroy',...overrides}).setProtectedHeader({alg:'RS256',kid:'test'}).sign(privateKey);
};
const app=express();app.use(express.json());app.use(metadataRouter);app.use(bodyWritePolicy);
const {createMcpRouter}=await import('../server/routes/mcp.js');
app.use('/api/mcp',createMcpRouter(createMcpAuth(t=>verifyOAuthToken(t,config(),keys))));
const {default:diaryRoutes}=await import('../server/routes/diary.js');
const {default:syncRoutes}=await import('../server/routes/sync.js');
app.use((req,res,next)=>{req.user={id:owner,role:'admin'};next();});
app.use('/api/diary',diaryRoutes);app.use('/api/sync',syncRoutes);
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const base=`http://127.0.0.1:${server.address().port}`;
let callId=1;
async function rpc(bearer,method,params={}) {
 const res=await fetch(base+'/api/mcp',{method:'POST',headers:{Accept:'application/json, text/event-stream','Content-Type':'application/json',...(bearer?{Authorization:'Bearer '+bearer}:{})},body:JSON.stringify({jsonrpc:'2.0',id:callId++,method,params})});
 const data=await res.json();return {res,data};
}
const textData=r=>JSON.parse(r.data.result.content[0].text);
after(async()=>{await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});});
test('OAuth destroy scope and flag gate the catalogue and direct calls without elevating read/write',async()=>{
 const names=['create_food','edit_diary_entry','delete_diary_entry'];
 assert(resourceMetadata().scopes_supported.includes('mcp:destroy'));
 const discovery=await fetch(base+'/.well-known/oauth-protected-resource');assert((await discovery.json()).scopes_supported.includes('mcp:destroy'));
 const full=await token();const listed=(await rpc(full,'tools/list')).data.result.tools;
 for(const name of names){const d=listed.find(t=>t.name===name);assert(d);assert.equal(d.annotations.destructiveHint,true);assert.deepEqual(d._meta.securitySchemes,[{type:'oauth2',scopes:['mcp:destroy']}]);}
 const args={name:'Synthetic OAuth food',portion:100,unit:'g',nutrition:{calories:100},confirm:true};
 for(const claims of [{scope:'mcp:read mcp:write'}, {scope:'mcp:read mcp:write',permissions:['mcp:read','mcp:write','mcp:destroy']}, {scope:'mcp:destroy',permissions:['mcp:read']}]){
  for(const name of names){
   const arguments_=name==='create_food'?args:{entry_id:'unknown',expected_revision:'0'.repeat(64),confirm:true,patch:{quantity:2}};
   const denied=await rpc(await token(claims),'tools/call',{name,arguments:arguments_});assert(denied.data.result?.isError||denied.data.error);
  }
 }
 const only=await token({scope:'mcp:destroy'});
 for(const [name,arguments_] of [['get_goals',{}],['log_water',{amount_ml:20}]])assert((await rpc(only,'tools/call',{name,arguments:arguments_})).data.result.isError);
 const unconfirmed=await rpc(full,'tools/call',{name:'create_food',arguments:{...args,confirm:false}});assert(unconfirmed.data.result.isError);
 const created=await rpc(only,'tools/call',{name:'create_food',arguments:args});assert(!created.data.result.isError,JSON.stringify(created.data));
 assert.equal(db.prepare('SELECT user_id FROM foods WHERE name=?').get(args.name).user_id,owner);
 process.env.MCP_DESTROY_ENABLED='0';app.use('/no-destroy',createMcpRouter(createMcpAuth(t=>verifyOAuthToken(t,config(),keys))));process.env.MCP_DESTROY_ENABLED='1';
 for(const [method,params] of [['tools/list',{}],...names.map(name=>['tools/call',{name,arguments:name==='create_food'?args:{entry_id:'unknown',expected_revision:'0'.repeat(64),confirm:true,patch:{quantity:2}}}])]){
  const response=await fetch(base+'/no-destroy',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+full},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const data=await response.json();
  if(method==='tools/list')assert(!data.result.tools.some(t=>names.includes(t.name)));else assert(data.error||data.result?.isError);
 }
});

test('OAuth single-entry changes compare revisions inside the user/day transaction and preserve body legacy',async()=>{
 const date='2026-09-20',jwt=await token();
 const original=[{uuid:'owned-a',name:'A',quantity:1,nutrition:{calories:80},addedAt:'2026-09-20T01:00:00Z'},{uuid:'owned-b',name:'B',quantity:1}];
 process.env.BODY_MEASUREMENTS_SOURCE='internal';
 db.prepare('INSERT INTO diary(user_id,date,items,body_stats,water,notes)VALUES(?,?,?,?,?,?)').run(owner,date,JSON.stringify(original),'{"weight":80}','[{"uuid":"water-kept","amount":250}]','keep');
 db.prepare('INSERT INTO diary(user_id,date,items)VALUES(?,?,?)').run(other,date,JSON.stringify([{uuid:'foreign-only',name:'Private'}]));
 process.env.BODY_MEASUREMENTS_SOURCE='gym-log';
 const call=async(name,args)=>rpc(jwt,'tools/call',{name,arguments:{date,confirm:true,...args}});
 const read=async()=>textData(await call('list_diary_entries',{}));
 const row=()=>db.prepare('SELECT * FROM diary WHERE user_id=? AND date=?').get(owner,date);
 const before=row(),snapshot=await read();assert.equal(snapshot.items[0].uuid,'owned-a');assert.match(snapshot.items_revision,/^[a-f0-9]{64}$/);
 const target={entry_id:'owned-a',expected_revision:snapshot.items_revision};
 for(const name of ['edit_diary_entry','delete_diary_entry']){
  for(const args of [{...target,confirm:false},{entry_id:'owned-a'},{...target,entry_id:'foreign-only'},{...target,entry_index:1},{...target,date:'2026-09-21'}]){
   const r=await call(name,{...args,patch:{quantity:2}});assert(r.data.error||r.data.result?.isError,JSON.stringify(r.data));
  }
 }
 assert.equal(row().items,before.items);assert(!db.prepare('SELECT id FROM diary WHERE user_id=? AND date=?').get(owner,'2026-09-21'));
 // A newly inserted/reordered entry invalidates the former index and revision.
 db.prepare('UPDATE diary SET items=? WHERE user_id=? AND date=?').run(JSON.stringify([original[1],original[0]]),owner,date);
 for(const name of ['edit_diary_entry','delete_diary_entry'])assert((await call(name,{...target,entry_index:0,patch:{quantity:2}})).data.result.isError);
 const fresh=await read();const edited=await call('edit_diary_entry',{entry_id:'owned-a',expected_revision:fresh.items_revision,patch:{quantity:2,notes:'confirmed'}});assert(!edited.data.result.isError,JSON.stringify(edited.data));
 let current=JSON.parse(row().items);assert.equal(current[0].uuid,'owned-b');assert.equal(current[1].quantity,2);assert(current[1].updatedAt);
 const staleEditReplay=await fetch(base+'/api/diary/'+date,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:original,water:[]})});assert.equal(staleEditReplay.status,200);
 assert.equal(JSON.parse(row().items).find(i=>i.uuid==='owned-a').quantity,2);
 assert((await call('delete_diary_entry',{entry_id:'owned-a',expected_revision:fresh.items_revision})).data.result.isError);
 const currentSnapshot=await read();
 assert((await call('edit_diary_entry',{entry_id:'owned-a',expected_revision:currentSnapshot.items_revision,patch:{quantity:3,body_stats:{weight:50}}})).data.result?.isError);
 const removed=await call('delete_diary_entry',{entry_id:'owned-a',expected_revision:currentSnapshot.items_revision});assert(!removed.data.result.isError,JSON.stringify(removed.data));
 assert(db.prepare("SELECT uuid FROM diary_tombstones WHERE user_id=? AND date=? AND kind='item' AND uuid='owned-a'").get(owner,date));
 // Simulate an offline client replaying the entries it read before MCP edits.
 const replay=await fetch(base+'/api/diary/'+date,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:original,water:[]})});assert.equal(replay.status,200);
 assert(!JSON.parse(row().items).some(i=>i.uuid==='owned-a'));
 const syncReplay=await fetch(base+'/api/sync/push',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({diary:[{client_id:1,date,items:original,water:[],updated_at:new Date().toISOString()}]})});assert.equal(syncReplay.status,200);
 assert(!JSON.parse(row().items).some(i=>i.uuid==='owned-a'));
 const ranged=textData(await call('list_diary_entries_range',{start:date,end:date}));
 assert.equal(ranged.entries[0].items_revision,(await read()).items_revision);
 const last=await read();assert.equal(last.items.length,1);
 const erased=await call('delete_diary_entry',{entry_id:'owned-b',expected_revision:last.items_revision});assert(!erased.data.result.isError);
 assert.deepEqual(JSON.parse(row().items),[]);assert.equal(row().deleted_at,null);assert.equal(row().body_stats,before.body_stats);assert.equal(row().water,before.water);assert.equal(row().notes,before.notes);
 assert.equal(JSON.parse(db.prepare('SELECT items FROM diary WHERE user_id=? AND date=?').get(other,date).items)[0].uuid,'foreign-only');
 // Legacy indices are usable only with a matching revision; duplicate UUIDs fail closed.
 db.prepare('UPDATE diary SET items=? WHERE user_id=? AND date=?').run('[{"name":"Legacy"}]',owner,date);
 const legacy=await read();assert(!(await call('edit_diary_entry',{entry_index:0,expected_revision:legacy.items_revision,patch:{quantity:2}})).data.result.isError);
 db.prepare('UPDATE diary SET items=? WHERE user_id=? AND date=?').run('[{"uuid":"duplicate"},{"uuid":"duplicate"}]',owner,date);
 const ambiguous=await read();assert((await call('delete_diary_entry',{entry_id:'duplicate',expected_revision:ambiguous.items_revision})).data.result.isError);
 db.prepare("UPDATE diary SET deleted_at=datetime('now') WHERE user_id=? AND date=?").run(owner,date);
 assert((await call('delete_diary_entry',{entry_index:0,expected_revision:ambiguous.items_revision})).data.result.isError);
});
