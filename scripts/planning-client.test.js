import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../src/lib/planning-api.js',import.meta.url),'utf8')
  .replace(/^import .*;$/gm,'').replace(/^export /gm,'');
function client(overrides={}){
  const calls=[];
  const api=runInNewContext(source+'\n;({planningCall})',{
    isNative:false,getNativeMode:()=>null,getAuthToken:()=>null,apiUrl:p=>'/nutri'+p,
    localStorage:{getItem:()=> 'synthetic-csrf'},
    fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({id:'saved',revision:1})};},...overrides,
  });return {api,calls};
}
test('local Android mode explains the server requirement without sending a request',async()=>{
  const c=client({isNative:true,getNativeMode:()=> 'local'});
  await assert.rejects(c.api.planningCall('list_planning_templates'),/conexión con tu servidor/);assert.equal(c.calls.length,0);
});
test('the planning screen uses the shared command endpoint with BASE_URL and cookie CSRF',async()=>{
  const c=client(),r=await c.api.planningCall('list_planning_templates');assert.equal(r.revision,1);
  assert.equal(c.calls[0].url,'/nutri/api/planning/list_planning_templates');assert.equal(c.calls[0].options.headers['X-CSRF-Token'],'synthetic-csrf');assert.equal(c.calls[0].options.credentials,'include');assert.equal(c.calls[0].options.cache,'no-store');
});
test('a version conflict is surfaced instead of being silently retried or acknowledged',async()=>{
  let count=0;const c=client({fetch:async()=>{count++;return {ok:false,json:async()=>({error:'VERSION_CONFLICT'})};}});
  await assert.rejects(c.api.planningCall('save_planning_template',{expected_revision:1}),/VERSION_CONFLICT/);assert.equal(count,1);
});
test('a user retry after a lost response keeps the original idempotency key',async()=>{
  const keys=[];let count=0;const c=client({fetch:async(_url,options)=>{
    keys.push(JSON.parse(options.body).idempotency_key);if(!count++)throw new Error('Lost response');return {ok:true,json:async()=>({revision:1})};
  }});
  await assert.rejects(c.api.planningCall('save_planning_template',{data:{name:'Semana'},expected_revision:0,idempotency_key:'original-key'}),/Lost response/);
  await c.api.planningCall('save_planning_template',{data:{name:'Semana'},expected_revision:0,idempotency_key:'new-click-key'});
  assert.deepEqual(keys,['original-key','original-key']);
});
