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
Object.assign(process.env,{DB_PATH:path.join(dir,'test.db'),NODE_ENV:'test',BODY_MEASUREMENTS_SOURCE:'gym-log',MCP_ENABLED:'1',MCP_WRITE_ENABLED:'1',MCP_DESTROY_ENABLED:'1',MCP_OAUTH_ENABLED:'1',MCP_OAUTH_RESOURCE_URL:'https://nutri.example/api/mcp',MCP_OAUTH_ISSUER:'https://issuer.example/',MCP_OAUTH_OWNER_SUB:'owner',MCP_OAUTH_CLIENT_ID:'chat-client',MCP_OAUTH_USER_ID:'1',JWT_SECRET:'synthetic-test-secret'});
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
const app=express();app.use(express.json());app.use((req,res,next)=>{req.requestId='discovery-correlation';next();});app.use(metadataRouter);app.use(bodyWritePolicy);
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

const {Client}=await import('../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const {StreamableHTTPClientTransport}=await import('../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js');
const {default:Ajv}=await import('../server/node_modules/ajv/dist/ajv.js');
const ajv=new Ajv({strict:false});
const required=['get_goals','search_foods','log_food','create_food','edit_diary_entry','delete_diary_entry'];
test('real MCP client discovers a stable Gym-only OAuth catalogue with primary auth descriptors',async()=>{
 const client=new Client({name:'nutritrace-discovery-test',version:'1.0.0'});
 const catalogues=[];
 const inspectFetch=async(input,init)=>{
  const response=await fetch(input,init);
  if(response.ok && response.headers.get('content-type')?.includes('application/json')){
   const wire=await response.clone().json();
   if(Array.isArray(wire.result?.tools))catalogues.push(wire.result.tools);
  }
  return response;
 };
 const transport=new StreamableHTTPClientTransport(new URL(base+'/api/mcp'),{fetch:inspectFetch,requestInit:{headers:{Authorization:'Bearer '+await token()}}});
 try{
  await client.connect(transport);
  assert.equal(client.getServerVersion().name,'nutritrace');
  const first=await client.listTools();const second=await client.listTools();
  assert.deepEqual(first,second);
  assert.equal(first.tools.length,43,'41 existing Gym-mode tools plus the two planned-diary tools');
  for(const name of ['get_diary_plan','record_planned_meal'])assert(first.tools.some(t=>t.name===name));
  for(const name of required)assert(first.tools.some(t=>t.name===name),name);
  assert(!first.tools.some(t=>['log_body_stat','get_body_composition'].includes(t.name)));
  assert.equal(catalogues.length,2);assert.deepEqual(catalogues[0],catalogues[1]);
  for(const tool of catalogues[0]){
   assert.equal(tool.inputSchema.type,'object');assert(ajv.validateSchema(tool.inputSchema),tool.name+': '+ajv.errorsText());ajv.compile(tool.inputSchema);
   assert.deepEqual(tool.securitySchemes,tool._meta.securitySchemes,tool.name+' lost its primary securitySchemes descriptor');
   for(const hint of ['readOnlyHint','destructiveHint','openWorldHint','idempotentHint'])assert.equal(typeof tool.annotations[hint],'boolean');
  }
 }finally{await client.close();}
});


test('missing OAuth scopes fail discovery explicitly, allowed scopes keep the catalogue stable',async()=>{
 let full;
 for(const scope of ['mcp:read mcp:write mcp:destroy','mcp:read','mcp:write','mcp:destroy']){
  const r=await rpc(await token({scope}),'tools/list');assert.equal(r.res.status,200);
  const names=r.data.result.tools.map(t=>t.name);for(const name of required)assert(names.includes(name));
  if(full)assert.deepEqual(names,full);else full=names;
 }
 const r=await rpc(await token({scope:'openid profile offline_access'}),'tools/list');
 assert.equal(r.res.status,403);assert.equal(r.data.error,'auth_scope');assert.match(r.res.headers.get('www-authenticate'),/insufficient_scope/);
});

test('safe logs distinguish the observed pre-discovery 403 reasons without claims or tokens',async()=>{
 const {logger}=await import('../server/logger.js');const original=logger.info;const logs=[];logger.info=(...args)=>logs.push(args.join(' '));
 const secretText='never-log-private-claim';const bearer=await token({sub:secretText});
 try{
  const cases=[
   [bearer,403,'owner_mismatch'],
   [await token({azp:secretText}),403,'client_mismatch'],
   [await token({aud:'https://private.example/mcp'}),401,'jwt_audience'],
   [await token({iss:'https://private.example/'}),401,'jwt_issuer'],
   [await token({exp:1}),401,'jwt_expired'],
   [await token({scope:'openid'}),403,'auth_scope'],
  ];
  for(const [jwt,status,reason] of cases){
   const r=await rpc(jwt,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:secretText,version:'1'}});assert.equal(r.res.status,status);
   const event=JSON.parse(logs.at(-1).slice('[mcp:diagnostic] '.length));assert.equal(event.reason,reason);assert.equal(event.request_id,'discovery-correlation');assert.equal(event.method,'initialize');
  }
  const userId=process.env.MCP_OAUTH_USER_ID;
  try{
   process.env.MCP_OAUTH_USER_ID='999999';assert.equal((await rpc(await token(),'tools/list')).res.status,403);
   assert.match(logs.at(-1),/local_user_missing/);
  }finally{process.env.MCP_OAUTH_USER_ID=userId;}
  assert(!logs.join('\n').includes(secretText));assert(!logs.join('\n').includes(bearer));assert(!logs.join('\n').includes('private.example'));
 }finally{logger.info=original;}
});

test('legacy Streamable HTTP negotiates versions, rejects incompatible probes and accepts initialized notification',async()=>{
 const jwt=await token();
 const send=async(method,params={},headers={})=>{
  const r=await fetch(base+'/api/mcp',{method:'POST',headers:{Authorization:'Bearer '+jwt,'Content-Type':'application/json',Accept:'application/json, text/event-stream',...headers},body:JSON.stringify({jsonrpc:'2.0',id:9,method,params})});return {r,data:await r.json()};
 };
 for(const version of ['2025-03-26','2025-06-18','2025-11-25']){
  const initialized=await send('initialize',{protocolVersion:version,capabilities:{},clientInfo:{name:'test',version:'1'}});assert.equal(initialized.r.status,200);assert.equal(initialized.data.result.protocolVersion,version);assert.match(initialized.r.headers.get('content-type'),/application\/json/);
  const listed=await send('tools/list',{}, {'MCP-Protocol-Version':version});assert.equal(listed.r.status,200);for(const name of required)assert(listed.data.result.tools.some(t=>t.name===name));assert.equal(listed.r.headers.get('mcp-session-id'),null);
 }
 const modern=await send('server/discover',{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}},{'MCP-Protocol-Version':'2026-07-28'});assert.equal(modern.r.status,400);assert.equal(modern.data.error.code,-32000);
 const unknown=await send('server/discover');assert.equal(unknown.data.error.code,-32601);
 // A dual-era client can fall back to the SDK-supported initialize version.
 const fallback=await send('initialize',{protocolVersion:'2026-07-28',capabilities:{},clientInfo:{name:'test',version:'1'}});assert.equal(fallback.data.result.protocolVersion,'2025-11-25');
 for(const Accept of ['application/json','text/event-stream'])assert.equal((await send('tools/list',{}, {Accept})).r.status,406);
 assert.equal((await send('tools/list',{}, {'Content-Type':'text/plain'})).r.status,415);
});
