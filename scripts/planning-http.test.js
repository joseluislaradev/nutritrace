import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../server/package.json',import.meta.url));
const express=require('express'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'nt-planning-http-'));
Object.assign(process.env,{DB_PATH:path.join(dir,'fixture.db'),JWT_SECRET:'synthetic-local-only',NODE_ENV:'test'});
const {default:db}=await import('../server/db.js');
const {default:planning}=await import('../server/routes/planning.js');
const {default:meals}=await import('../server/routes/meals.js');
const {default:sync}=await import('../server/routes/sync.js');
const {handleMcpRequest}=await import('../server/lib/mcp/server.js');
const {authorizedRegistrar}=await import('../server/lib/mcp/auth-policy.js');
const {registerPlanningTools}=await import('../server/lib/mcp/tools/planning.js');
const {commands}=await import('../server/lib/planning-contracts.js');
const owner=Number(db.prepare("INSERT INTO users(username,password_hash)VALUES('owner','synthetic')").run().lastInsertRowid);
const food=Number(db.prepare("INSERT INTO foods(user_id,name,portion,unit,nutrition)VALUES(?,'Arroz',100,'g',?)").run(owner,JSON.stringify({calories:100})).lastInsertRowid);
const app=express();app.use(express.json());
// Synthetic authenticated context; production OAuth is covered separately by
// mcp-discovery.test.js. The real SDK, transport and resource handlers run here.
app.use((req,_res,next)=>{req.user={id:owner,role:'admin'};req.mcpAuth={userId:owner,authKind:'oauth',scopes:['mcp:read','mcp:write','mcp:destroy']};req.mcpWrites=true;req.mcpDestroy=true;next();});
app.use('/api/planning',planning);app.use('/api/meals',meals);app.use('/api/sync',sync);app.post('/api/mcp',handleMcpRequest);
app.use((e,_req,res,_next)=>res.status(e.status||500).json({error:e.message}));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
const {Client}=await import('../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const {StreamableHTTPClientTransport}=await import('../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js');
const client=new Client({name:'phase-one-local-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/api/mcp')));
after(async()=>{await client.close();await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});});
const meta=revision=>({expected_revision:revision||0,idempotency_key:randomUUID()});
async function http(route,body,method='POST'){const response=await fetch(base+route,{method,headers:{'content-type':'application/json'},body:body==null?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};}
async function mcp(name,args={}){const r=await client.callTool({name,arguments:args});assert(!r.isError,JSON.stringify(r));const data=JSON.parse(r.content[0].text);return Object.keys(data).length===1&&Array.isArray(data.items)?data.items:data;}

test('every planning command is available in MCP and scopes are enforced for each call',async()=>{
  const tools=await client.listTools();for(const name of Object.keys(commands))assert(tools.tools.some(t=>t.name===name),name);
  const registered=new Map(),fake={registerTool:(name,definition,handler)=>registered.set(name,{definition,handler})};
  const registrar=authorizedRegistrar(fake,{authKind:'oauth',userId:owner,scopes:['mcp:read']});
  for(const group of ['read','write','destroy'])registerPlanningTools(registrar,{userId:owner},group);
  assert((await registered.get('save_planning_template').handler({})).isError);
  assert((await registered.get('delete_catalog_meal').handler({})).isError);
  assert.deepEqual(registered.get('list_shopping_lists').definition.securitySchemes,[{type:'oauth2',scopes:['mcp:read']}]);
});
test('UI endpoint → MCP read and MCP mutation → UI endpoint share state, versions and conflicts',async()=>{
  const data={name:'Semanal',starts_on:'2026-10-01',days:Array.from({length:7},()=>({slots:[{slot_id:'dinner',type:'food',id:food,servings:1,time:'20:00',label:'Cena'}]}))};
  const saved=await http('/api/planning/save_planning_template',{data,...meta()});assert.equal(saved.status,200);
  const read=await mcp('get_planning_document',{kind:'template',id:saved.data.id});assert.equal(read.payload.name,'Semanal');
  const updated=await mcp('save_planning_template',{id:read.id,data:{...read.payload,name:'Desde MCP'},...meta(read.revision)});
  const seen=await http('/api/planning/get_planning_document',{kind:'template',id:read.id});assert.equal(seen.data.payload.name,'Desde MCP');
  const stale=await http('/api/planning/save_planning_template',{id:read.id,data:read.payload,...meta(read.revision)});assert.equal(stale.status,409);
  const versions=await mcp('get_entity_versions',{kind:'template',id:read.id});assert.deepEqual(versions.map(v=>v.source),['mcp','manual']);assert(versions.every(v=>v.reason===null));
  const list=await mcp('generate_shopping_list',{name:'Lista',template_id:updated.id,from:'2026-10-26',to:'2026-11-01',...meta()});assert.equal(list.payload.items[0].required,700);
  const checked=await http('/api/planning/update_shopping_item',{id:list.id,patch:{key:list.payload.items[0].key,purchased:true},...meta(list.revision)});assert.equal(checked.status,200);
  const regenerated=await mcp('generate_shopping_list',{id:list.id,name:'Lista',template_id:updated.id,from:'2026-10-26',to:'2026-11-01',...meta(checked.data.revision)});assert.equal(regenerated.payload.items[0].to_buy,0);
  assert.match((await mcp('export_shopping_list',{id:list.id,format:'csv'})).content,/"Arroz"/);
});
test('original recipe editor route and MCP share calculation, history and concurrency',async()=>{
  const meal=await mcp('save_catalog_meal',{data:{name:'Receta',is_recipe:true,servings:2,items:[{food_id:food,portion:200,unit:'g'}]},...meta()});
  const body={...meal,name:'Edición manual',items:[{food_id:food,portion:400,unit:'g',quantity:1}],revision:meal.revision};
  const changed=await http('/api/meals/'+meal.id,body,'PUT');assert.equal(changed.status,200);assert.equal(changed.data.nutrition.calories,200);
  const read=await mcp('get_meal_details',{meal_id:meal.id});assert.equal(read.name,'Edición manual');assert.equal(read.revision,changed.data.revision);
  const stale=await http('/api/meals/'+meal.id,{...body,name:'Sobrescritura'},'PUT');assert.equal(stale.status,409);
  const old=await mcp('get_entity_versions',{kind:'meals',id:String(meal.id)});assert.equal(old.length,2);assert.equal(old[0].reason_status,'pending');
  const restored=await mcp('restore_catalog_meal',{id:meal.id,revision:meal.revision,...meta(changed.data.revision),confirm:true});assert.equal(restored.name,'Receta');assert.equal(restored.nutrition.calories,100);
});
test('offline push cannot overwrite an intervening MCP edit and retains the batch on conflict',async()=>{
  const meal=await mcp('save_catalog_meal',{data:{name:'Base',items:[{food_id:food,portion:100,unit:'g'}]},...meta()});
  const newer=await mcp('save_catalog_meal',{id:meal.id,data:{name:'Nueva',items:[{food_id:food,portion:200,unit:'g'}]},...meta(meal.revision)});
  const result=await http('/api/sync/push',{foods:[],meals:[{...meal,server_id:meal.id,client_id:9,name:'Offline',updated_at:new Date(Date.now()+1000).toISOString()}],diary:[],settings:[]});
  assert.equal(result.status,409);assert.match(result.data.error,/VERSION_CONFLICT/);
  assert.equal((await mcp('get_meal_details',{meal_id:meal.id})).name,newer.name);
});
test('soft-delete with stale revision is rejected and consumption is preserved',async()=>{
  const meal=await mcp('save_catalog_meal',{data:{name:'Anterior',items:[{food_id:food,portion:100,unit:'g'}]},...meta()});
  const newer=await mcp('save_catalog_meal',{id:meal.id,data:{name:'Actual',items:[{food_id:food,portion:100,unit:'g'}]},...meta(meal.revision)});
  assert.equal((await http('/api/meals/'+meal.id,{expected_revision:meal.revision},'DELETE')).status,409);
  assert.equal((await http('/api/meals/'+meal.id,{expected_revision:newer.revision},'DELETE')).status,200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diary').get().n,0);assert.equal((await mcp('get_entity_versions',{kind:'meals',id:String(meal.id)})).length,3);
});
