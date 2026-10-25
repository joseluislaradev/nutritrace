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
const {authorizedRegistrar}=await import('../server/lib/mcp/auth-policy.js');
const {setNutritionGoalsCore}=await import('../server/lib/mcp/tools/set-nutrition-goals.js');
const {getGoalsCore}=await import('../server/lib/mcp/tools/goals.js');
const {createToken,revokeToken}=await import('../server/lib/api-tokens.js');
const {createMcpAuth}=await import('../server/middleware/mcp-auth.js');
const {handleMcpRequest}=await import('../server/lib/mcp/server.js');
const {metadataRouter}=await import('../server/routes/mcp-metadata.js');
const {bodyWritePolicy}=await import('../server/middleware/body-write-policy.js');
const {computeAdaptiveTdee}=await import('../server/lib/adaptive-tdee.js');
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
const {default:dataRoutes}=await import('../server/routes/data.js');
const {default:settingsRoutes}=await import('../server/routes/settings.js');
app.use((req,res,next)=>{req.user={id:owner,role:'admin'};next();});
app.use('/api/diary',diaryRoutes);app.use('/api/sync',syncRoutes);app.use('/api/data',dataRoutes);app.use('/api/settings',settingsRoutes);
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const base=`http://127.0.0.1:${server.address().port}`;
let callId=1;
async function rpc(bearer,method,params={}) {
 const res=await fetch(base+'/api/mcp',{method:'POST',headers:{Accept:'application/json, text/event-stream','Content-Type':'application/json',...(bearer?{Authorization:'Bearer '+bearer}:{})},body:JSON.stringify({jsonrpc:'2.0',id:callId++,method,params})});
 const data=await res.json();return {res,data};
}
const textData=r=>JSON.parse(r.data.result.content[0].text);
after(async()=>{await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});});
test('metadata root and path, no request-derived origin',async()=>{
 for(const suffix of ['', '/api/mcp']){const res=await fetch(base+'/.well-known/oauth-protected-resource'+suffix,{headers:{Host:'attacker.example'}});assert.equal(res.status,200);assert.equal((await res.json()).resource,config().resource);}
 assert.throws(()=>oauthConfig({...process.env,MCP_OAUTH_RESOURCE_URL:'http://nutri.example/api/mcp'}));
 assert.throws(()=>oauthConfig({...process.env,MCP_OAUTH_USER_ID:'0'}));
 assert.equal(resourceMetadata().bearer_methods_supported[0],'header');
});
test('OAuth signature, audience, owner, client, expiry, required claims and consent',async()=>{
 const valid=await token();assert.equal((await verifyOAuthToken(valid,config(),keys)).userId,owner);
 for(const claims of [{iss:'https://other.example/'},{aud:'https://gym.example/mcp'},{sub:'other'},{azp:'other'},{exp:1},{exp:undefined},{iat:undefined},{iat:Math.floor(Date.now()/1000)+600},{nbf:Math.floor(Date.now()/1000)+600}]) await assert.rejects(()=>token(claims).then(t=>verifyOAuthToken(t,config(),keys)));
 await assert.rejects(()=>verifyOAuthToken(valid.slice(0,-10)+'invalid',config(),keys));
 await assert.rejects(()=>verifyOAuthToken(valid,{...config(),validAfter:Date.now()/1000+10},keys));
 const scoped=await verifyOAuthToken(await token({scope:'mcp:read',permissions:['mcp:read','mcp:write']}),config(),keys);assert.deepEqual(scoped.scopes,['mcp:read']);
});
test('HTTP unauthenticated challenge; real SDK initialize/list/call and body exclusion',async()=>{
 process.env.BODY_MEASUREMENTS_SOURCE='gym-log';
 const denied=await rpc(null,'tools/list');assert.equal(denied.res.status,401);assert.match(denied.res.headers.get('www-authenticate'),/resource_metadata/);
 const jwt=await token();const init=await rpc(jwt,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}});assert.equal(init.data.result.serverInfo.name,'nutritrace');
 const listed=await rpc(jwt,'tools/list');const names=listed.data.result.tools.map(t=>t.name);
 const descriptor=listed.data.result.tools.find(t=>t.name==='get_goals');assert.equal(descriptor.annotations.readOnlyHint,true);assert.deepEqual(descriptor._meta.securitySchemes,[{type:'oauth2',scopes:['mcp:read']}]);
 for(const n of ['log_body_stat','get_body_composition'])assert(!names.includes(n));
 for(const n of ['get_goals','log_food','log_water','log_meal','set_nutrition_goals','create_food','edit_diary_entry','delete_diary_entry'])assert(names.includes(n));
 const direct=await rpc(jwt,'tools/call',{name:'log_body_stat',arguments:{}});assert(direct.data.error||direct.data.result?.isError);
});
test('OAuth read-only denies direct writes; actual food, meal, water registration and readback',async()=>{
 const read=await token({scope:'mcp:read'});const denied=await rpc(read,'tools/call',{name:'log_water',arguments:{amount_ml:250,date:'2026-10-24'}});assert(denied.data.error||denied.data.result?.isError);
 const foodId=Number(db.prepare("INSERT INTO foods(user_id,name,portion,unit,nutrition) VALUES(?,'Tortilla',30,'g',?)").run(owner,JSON.stringify({calories:65,proteins:2})).lastInsertRowid);
 const mealId=Number(db.prepare("INSERT INTO meals(user_id,name,items,is_recipe) VALUES(?,'Desayuno',?,0)").run(owner,JSON.stringify([{name:'Tortilla',nutrition:{calories:65},portion:30,quantity:1,unit:'g'}])).lastInsertRowid);
 const jwt=await token();
 for(const [name,args] of [['log_food',{food_id:foodId,quantity:1,date:'2026-10-24'}],['log_meal',{meal_id:mealId,date:'2026-10-24'}],['log_water',{amount_ml:250,date:'2026-10-24'}]]){
 const r=await rpc(jwt,'tools/call',{name,arguments:args});assert(!r.data.result?.isError,JSON.stringify(r.data));assert(r.data.result);
 }
 const readback=await rpc(jwt,'tools/call',{name:'get_daily_totals',arguments:{date:'2026-10-24'}});const totals=textData(readback);assert.equal(totals.water_ml,250);assert.equal(totals.item_count,2);
 const foreign=Number(db.prepare("INSERT INTO foods(user_id,name,nutrition)VALUES(?,'Private','{}')").run(other).lastInsertRowid);
 const deniedOther=await rpc(jwt,'tools/call',{name:'log_food',arguments:{food_id:foreign,quantity:1,date:'2026-10-24'}});assert(deniedOther.data.result.isError);
});
test('PAT scope separation, revocation and body policy, unchanged REST token format',async()=>{
 const pat=createToken({userId:owner,name:'synthetic',scopes:['mcp:write']});
 const listed=await rpc(pat.raw,'tools/list');assert(!listed.data.result.tools.some(t=>t.name==='get_goals'));
 assert(listed.data.result.tools.some(t=>t.name==='log_water'));
 assert(!listed.data.result.tools.some(t=>t.name==='log_body_stat'));
 revokeToken({userId:owner,id:pat.row.id});assert.equal((await rpc(pat.raw,'tools/list')).res.status,401);
 assert.throws(()=>createToken({userId:owner,name:'bad',scopes:['mcp:read'],expiresAt:'bad-date'}));
});
test('body policy preserves legacy values and mixed diary imports/sync, providers and nutrient goals',()=>{
 process.env.BODY_MEASUREMENTS_SOURCE='internal';
 db.prepare("INSERT INTO diary(user_id,date,items,body_stats,water,notes)VALUES(?,'2026-10-23','[]','{\"weight\":80}','[]','old')").run(owner);
 db.prepare("INSERT INTO user_settings(user_id,key,value)VALUES(?,'goals',?)").run(owner,JSON.stringify({weight:{max:70},calories:{max:2200}}));
 process.env.BODY_MEASUREMENTS_SOURCE='gym-log';
 assert.deepEqual(computeAdaptiveTdee(owner),{ready:false,tdee:null,reason:'body_source_gym_log'});
 db.prepare("UPDATE diary SET body_stats='{\"weight\":60}',water='[{\"amount\":250}]',notes='kept' WHERE user_id=? AND date='2026-10-23'").run(owner);
 let row=db.prepare("SELECT * FROM diary WHERE user_id=? AND date='2026-10-23'").get(owner);assert.equal(JSON.parse(row.body_stats).weight,80);assert.equal(row.notes,'kept');assert.equal(JSON.parse(row.water)[0].amount,250);
 db.prepare("INSERT INTO diary(user_id,date,body_stats,items)VALUES(?,'2026-10-22','{\"weight\":99}','[{\"name\":\"Snack\"}]')").run(owner);
 row=db.prepare("SELECT * FROM diary WHERE user_id=? AND date='2026-10-22'").get(owner);assert.deepEqual(JSON.parse(row.body_stats),{});assert.equal(JSON.parse(row.items)[0].name,'Snack');
 db.prepare("INSERT INTO wellness_data(user_id,date,source,metric_type,value)VALUES(?,'2026-10-24','test','weight_kg',90)").run(owner);
 db.prepare("INSERT INTO wellness_data(user_id,date,source,metric_type,value)VALUES(?,'2026-10-24','test','steps',5000)").run(owner);
 db.prepare("INSERT INTO wellness_data(user_id,date,source,metric_type,value)VALUES(?,'2026-10-24','test','body_battery_high',80)").run(owner);
 assert.equal(db.prepare("SELECT value FROM wellness_data WHERE metric_type='body_battery_high'").get().value,80);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM wellness_data WHERE metric_type='weight_kg'").get().n,0);assert.equal(db.prepare("SELECT value FROM wellness_data WHERE metric_type='steps'").get().value,5000);
 db.prepare("UPDATE user_settings SET value=? WHERE user_id=? AND key='goals'").run(JSON.stringify({weight:{max:40},proteins:{min:120}}),owner);
 const raw=JSON.parse(db.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='goals'").get(owner).value);assert.equal(raw.weight.max,70);assert.equal(raw.proteins.min,120);assert(!getGoalsCore(owner).goals.weight);
 process.env.BODY_MEASUREMENTS_SOURCE='internal';db.prepare("UPDATE diary SET body_stats='{\"weight\":81}' WHERE user_id=? AND date='2026-10-23'").run(owner);assert.equal(JSON.parse(db.prepare("SELECT body_stats FROM diary WHERE date='2026-10-23'").get().body_stats).weight,81);
 process.env.BODY_MEASUREMENTS_SOURCE='gym-log';
});
test('daily goal compare-and-set preserves micronutrients, flags and body legacy, detects conflicts',()=>{
 const previous=getGoalsCore(owner).goals.proteins;
 const result=setNutritionGoalsCore(owner,{targets:{proteins:130,water:2500},expected:{proteins:previous,water:null},confirm:true});assert.equal(result.goals.proteins.min,130);assert.equal(result.water_goal_ml,2500);
 assert.throws(()=>setNutritionGoalsCore(owner,{targets:{proteins:140},expected:{proteins:previous},confirm:true}),/CONFLICT/);
 assert.throws(()=>setNutritionGoalsCore(owner,{targets:{weight:65},expected:{weight:null},confirm:true}));
 assert.throws(()=>setNutritionGoalsCore(owner,{targets:{fat:60},expected:{fat:null},confirm:false}));
 assert.equal(JSON.parse(db.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='goals'").get(owner).value).weight.max,70);
});

test('direct body endpoint denied; mixed HTTP sync and import preserve food, water, notes and legacy',async()=>{
 const send=async(path,body,method='POST')=>{
  const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};
 };
 const denied=await send('/api/v1/body-measurements',{weight_kg:60});assert.equal(denied.status,403);
 const item={uuid:'test-sync-food',name:'Frijoles',nutrition:{calories:120},portion:100,quantity:1,unit:'g'};
 const mixed=await send('/api/sync/push',{diary:[{client_id:50,date:'2026-10-21',items:[item],body_stats:{weight:60},water:[{amount:250,uuid:'test-water'}],notes:'keep my note',updated_at:new Date().toISOString()}]});
 assert.equal(mixed.status,200,JSON.stringify(mixed.data));assert.equal(mixed.data.body_conflicts.length,1);
 const row=db.prepare("SELECT * FROM diary WHERE user_id=? AND date='2026-10-21'").get(owner);
 assert.deepEqual(JSON.parse(row.body_stats),{});assert.equal(JSON.parse(row.items)[0].name,'Frijoles');assert.equal(JSON.parse(row.water)[0].amount,250);assert.equal(row.notes,'keep my note');
 const imported=await send('/api/data/import',{diary:[{date:'2026-10-23',bodyStats:{weight:50},items:[item],water:[{amount:300}],notes:'import kept'}]});assert.equal(imported.status,200,JSON.stringify(imported.data));
 const preserved=db.prepare("SELECT * FROM diary WHERE user_id=? AND date='2026-10-23'").get(owner);assert.equal(JSON.parse(preserved.body_stats).weight,81);assert.equal(preserved.notes,'import kept');
 const fixed=await send('/api/settings',{key:'weight_kg',value:65},'PUT');assert.equal(fixed.status,403);
});
test('goals MCP scope and compare-and-set through real transport, no unrelated changes',async()=>{
 const before=getGoalsCore(owner);
 const args={targets:{fat:65},expected:{fat:null},confirm:true};
 const denied=await rpc(await token({scope:'mcp:read mcp:write'}),'tools/call',{name:'set_nutrition_goals',arguments:args});assert(denied.data.result?.isError||denied.data.error);
 const written=await rpc(await token(),'tools/call',{name:'set_nutrition_goals',arguments:args});assert(!written.data.result?.isError,JSON.stringify(written.data));
 const after=getGoalsCore(owner);assert.equal(after.goals.fat.max,65);assert.deepEqual(after.goals.proteins,before.goals.proteins);assert.equal(after.water_goal_ml,before.water_goal_ml);
 const conflict=await rpc(await token(),'tools/call',{name:'set_nutrition_goals',arguments:args});assert(conflict.data.result.isError);
});
test('Origin, preflight, unsupported methods and revocation cutoff, independently of PAT',async()=>{
 const rejected=await fetch(base+'/api/mcp',{method:'POST',headers:{Origin:'https://untrusted.example','Content-Type':'application/json'},body:'{}'});assert.equal(rejected.status,403);
 assert.equal((await fetch(base+'/api/mcp')).status,405);
 assert.equal((await fetch(base+'/api/mcp',{method:'OPTIONS'})).status,204);
 process.env.MCP_OAUTH_VALID_AFTER=new Date(Date.now()+10000).toISOString();assert.equal((await rpc(await token(),'tools/list')).res.status,401);delete process.env.MCP_OAUTH_VALID_AFTER;
 const jwt=await token();const pat=createToken({userId:owner,name:'read-pat',scopes:['mcp:read']});
 process.env.MCP_OAUTH_ENABLED='0';assert.equal((await rpc(jwt,'tools/list')).res.status,401);assert.equal((await rpc(pat.raw,'tools/list')).res.status,200);process.env.MCP_OAUTH_ENABLED='1';
 const oldId=process.env.MCP_OAUTH_USER_ID;process.env.MCP_OAUTH_USER_ID='999999';assert.equal((await rpc(jwt,'tools/list')).res.status,403);process.env.MCP_OAUTH_USER_ID=oldId;
});

test('server flags and original internal PAT destroy remain independent',async()=>{
 const auth=createMcpAuth(t=>verifyOAuthToken(t,config(),keys));
 process.env.MCP_ENABLED='0';app.use('/disabled',createMcpRouter(auth));process.env.MCP_ENABLED='1';
 process.env.MCP_WRITE_ENABLED='0';app.use('/readonly',createMcpRouter(auth));process.env.MCP_WRITE_ENABLED='1';
 assert.equal((await fetch(base+'/disabled',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,404);
 const noWrite=await fetch(base+'/readonly',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+await token()},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
 assert(!(await noWrite.json()).result.tools.some(t=>t.name==='log_water'));
 const writeOnly=await rpc(await token({scope:'mcp:write'}),'tools/call',{name:'get_goals',arguments:{}});assert(writeOnly.data.result.isError);
 process.env.BODY_MEASUREMENTS_SOURCE='internal';
 const pat=createToken({userId:owner,name:'internal-destroy',scopes:['mcp:destroy']});
 const list=await rpc(pat.raw,'tools/list');assert(list.data.result.tools.some(t=>t.name==='create_food'));assert(!list.data.result.tools.some(t=>t.name==='get_goals'));
 process.env.BODY_MEASUREMENTS_SOURCE='gym-log';
});

test('resource discovery with BASE_URL prefix and remote JWKS lookup without token URLs',async()=>{
 const {createMetadataRouter}=await import('../server/routes/mcp-metadata.js');
 process.env.BASE_URL='/nutri';process.env.MCP_OAUTH_RESOURCE_URL='https://nutri.example/nutri/api/mcp';
 app.use(createMetadataRouter());
 const response=await fetch(base+'/.well-known/oauth-protected-resource/nutri/api/mcp');assert.equal(response.status,200);assert.equal((await response.json()).resource,'https://nutri.example/nutri/api/mcp');
 delete process.env.BASE_URL;process.env.MCP_OAUTH_RESOURCE_URL='https://nutri.example/api/mcp';
 const signed=await token();const originalFetch=globalThis.fetch;const calls=[];
 try {
  globalThis.fetch=async(url)=>{
   const address=String(url);calls.push(address);
   if(address==='https://issuer.example/.well-known/openid-configuration')return new Response(JSON.stringify({issuer:'https://issuer.example/',jwks_uri:'https://issuer.example/jwks'}),{status:200,headers:{'Content-Type':'application/json'}});
   if(address==='https://issuer.example/jwks')return new Response(JSON.stringify({keys:[jwk]}),{status:200,headers:{'Content-Type':'application/json'}});
   throw new Error('Unexpected remote address');
  };
  assert.equal((await verifyOAuthToken(signed)).userId,owner);assert.deepEqual(calls,['https://issuer.example/.well-known/openid-configuration','https://issuer.example/jwks']);
 } finally {globalThis.fetch=originalFetch;}
 const hs=await new SignJWT({sub:'owner'}).setProtectedHeader({alg:'HS256'}).sign(new Uint8Array(32));await assert.rejects(()=>verifyOAuthToken(hs,config(),keys));
});
