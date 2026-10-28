import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../server/package.json',import.meta.url));
const Database=require('better-sqlite3');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nt-planning-'));
Object.assign(process.env,{DB_PATH:path.join(dir,'fixture.db'),JWT_SECRET:'local-test-only',NODE_ENV:'test'});
const {default:db}=await import('../server/db.js');
const {planningService:s}=await import('../server/lib/planning-service.js');
const {installPlanningStorage}=await import('../server/lib/planning-storage.js');
const {convert}=await import('../server/lib/purchase-units.js');
after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
const meta=revision=>({expected_revision:revision||0,idempotency_key:randomUUID()});
function fixture(){
  const u=Number(db.prepare('INSERT INTO users(username,password_hash)VALUES(?,?)').run(randomUUID(),'synthetic').lastInsertRowid);
  const food=(name,unit='g',nutrition={calories:100,proteins:10})=>Number(db.prepare('INSERT INTO foods(user_id,name,portion,unit,nutrition)VALUES(?,?,100,?,?)').run(u,name,unit,JSON.stringify(nutrition)).lastInsertRowid);
  return {u,food,exec:(n,a)=>s.execute(u,n,a,'mcp')};
}
const slot=(type,id,servings=1)=>({slot_id:randomUUID(),type,id,servings,time:'14:00',label:'Comida'});
function template(f,slots){return f.exec('save_planning_template',{data:{name:'Prueba',starts_on:'2026-10-01',days:Array.from({length:7},()=>({slots:structuredClone(slots),day_type:'rest'}))},...meta()});}
function generate(f,t,extra={}){return f.exec('generate_shopping_list',{name:'Prueba',template_id:t.id,from:'2026-10-26',to:'2026-11-01',...meta(),...extra});}

test('additive migration preserves every original column, ID and sync timestamp and creates no invented reasons',()=>{
  const old=new Database(':memory:');
  old.exec(`CREATE TABLE foods(id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT,updated_at TEXT);
    CREATE TABLE meals(id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT,updated_at TEXT);
    INSERT INTO foods VALUES(45,7,'Leche','2020-01-01');INSERT INTO meals VALUES(67,7,'Comida','2020-01-02');`);
  const before=old.prepare('SELECT * FROM meals').get();
  installPlanningStorage(old);installPlanningStorage(old);
  const after=old.prepare('SELECT * FROM meals').get();assert.deepEqual({...after,revision:undefined},{...before,revision:undefined});
  assert.equal(after.revision,0);assert.equal(old.prepare('SELECT COUNT(*) AS n FROM entity_versions').get().n,2);
  const version=old.prepare("SELECT * FROM entity_versions WHERE kind='meals'").get();assert.equal(version.source,'baseline');assert.equal(version.reason,null);
  old.prepare("UPDATE meals SET name='Nueva' WHERE id=67").run();
  assert.equal(old.prepare('SELECT revision FROM meals').get().revision,1);assert.equal(old.prepare('SELECT COUNT(*) AS n FROM entity_versions').get().n,3);
  old.close();
});
test('weekly templates repeat across months without materializing weeks or consumption',()=>{
  const f=fixture(),id=f.food('Arroz'),t=template(f,[slot('food',id)]);
  const r=f.exec('resolve_planned_menu',{template_id:t.id,from:'2026-10-26',to:'2026-11-08'});
  assert.equal(r.days.length,14);assert.equal(r.days[7].slots[0].slot_id,r.days[0].slots[0].slot_id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diary WHERE user_id=?').get(f.u).n,0);
  assert.equal(s.list(f.u,'template').length,1);
});
test('repeated ingredients, mass units and recipe yields are aggregated',()=>{
  const f=fixture(),rice=f.food('Arroz');
  const meal=f.exec('save_catalog_meal',{data:{name:'Tanda',is_recipe:true,portion:250,servings:4,items:[{food_id:rice,portion:1,unit:'kg'}]},...meta()});
  assert.equal(meal.nutrition.calories,250);
  const t=template(f,[slot('meal',meal.id,2),slot('food',rice)]),list=generate(f,t);
  assert.equal(list.payload.items.length,1);assert.equal(list.payload.items[0].required,4200);
  assert.equal(list.payload.items[0].display.unit,'kg');
});
test('single date replacement and removed slot are applied before shopping generation',()=>{
  const f=fixture(),a=f.food('Arroz'),b=f.food('Frijol'),dinner=slot('food',a),t=template(f,[dinner]);
  f.exec('save_planning_exception',{data:{template_id:t.id,date:'2026-10-26',slots:[{slot_id:dinner.slot_id,replacement:{...dinner,id:b}}]},...meta()});
  const list=generate(f,t);assert.equal(list.payload.items.find(i=>i.food_id===a).required,600);assert.equal(list.payload.items.find(i=>i.food_id===b).required,100);
  f.exec('save_planning_exception',{data:{template_id:t.id,date:'2026-10-27',skip:true,slots:[]},...meta()});
  assert.equal(generate(f,t).payload.items.find(i=>i.food_id===a).required,500);
});
test('inventory, packaging and price use compatible quantities only',()=>{
  const f=fixture(),milk=f.food('Leche','ml'),t=template(f,[slot('food',milk,5)]);
  f.exec('save_pantry_item',{data:{food_id:milk,stock:500,unit:'ml',category:'lácteos',package_size:1,package_unit:'l',package_label:'cartón',price:30,currency:'MXN'},...meta()});
  const list=generate(f,t),i=list.payload.items[0];assert.equal(i.required,3500);assert.equal(i.to_buy,3000);assert.equal(i.packages,3);assert.equal(i.estimated_cost,90);
  assert.deepEqual(list.payload.budget,{totals:{MXN:90},incomplete:false});
});
test('mass and volume stay separate without an explicit density',()=>{
  assert.equal(convert(100,'ml','g',null),null);assert.equal(convert(100,'ml','g',.8),80);assert.equal(convert(1,'piece','g',null),null);
  const f=fixture(),oil=f.food('Aceite','ml');
  const meal=f.exec('save_catalog_meal',{data:{name:'Aderezo',items:[{food_id:oil,portion:20,unit:'ml'}]},...meta()});
  const t=template(f,[slot('meal',meal.id)]),list=generate(f,t);assert.equal(list.payload.items[0].unit,'ml');
});
test('raw/cooked quantities require a supplied yield and retain warnings when absent',()=>{
  const f=fixture(),rice=f.food('Arroz');
  const meal=f.exec('save_catalog_meal',{data:{name:'Cocido',is_recipe:true,servings:2,items:[{food_id:rice,portion:300,unit:'g',state:'cooked'}]},...meta()});
  const t=template(f,[slot('meal',meal.id)]),list=generate(f,t);
  assert.equal(list.payload.items[0].state,'cooked');assert(list.payload.warnings.some(w=>w.includes('conversion missing')));
  f.exec('save_pantry_item',{data:{food_id:rice,stock:50,unit:'g',state:'raw',cooked_yield:3,package_size:500,package_unit:'g'},...meta()});
  const updated=generate(f,t);assert.equal(updated.payload.items[0].required,350);assert.equal(updated.payload.items[0].stock,50);assert.equal(updated.payload.items[0].to_buy,300);
});
test('regeneration preserves purchases, overrides and manual articles and reports differences',()=>{
  const f=fixture(),rice=f.food('Arroz'),t=template(f,[slot('food',rice)]);let list=generate(f,t);
  list=f.exec('update_shopping_item',{id:list.id,patch:{key:list.payload.items[0].key,override_quantity:1000,purchased_quantity:200},...meta(list.revision)});
  list=f.exec('add_shopping_item',{id:list.id,name:'Bolsas',quantity:2,unit:'piece',...meta(list.revision)});
  const data=structuredClone(t.payload);data.days[0].slots[0].servings=2;
  f.exec('save_planning_template',{id:t.id,data,...meta(t.revision)});
  list=generate(f,t,{id:list.id,...meta(list.revision)});
  const riceRow=list.payload.items.find(i=>!i.manual);assert.equal(riceRow.required,800);assert.equal(riceRow.purchased_quantity,200);assert.equal(riceRow.override_quantity,1000);assert.equal(riceRow.to_buy,800);
  assert(list.payload.items.some(i=>i.manual&&i.name==='Bolsas'));assert.equal(list.payload.differences[0].before_required,700);assert.equal(list.payload.differences[0].after_required,800);
});
test('idempotent retries do not create duplicate templates, lists or versions',()=>{
  const f=fixture(),a={data:{name:'Repetida',starts_on:'2026-10-01',days:Array.from({length:7},()=>({slots:[]}))},...meta()};
  const t=f.exec('save_planning_template',a);assert.deepEqual(f.exec('save_planning_template',a),t);assert.equal(s.versions(f.u,'template',t.id).length,1);
  assert.throws(()=>f.exec('save_planning_template',{...a,data:{...a.data,name:'Otra'}}),/IDEMPOTENCY_KEY_REUSED/);
});
test('stale changes are rejected and cannot append history or overwrite data',()=>{
  const f=fixture(),t=template(f,[]);f.exec('save_planning_template',{id:t.id,data:{...t.payload,name:'Actualizada'},...meta(t.revision)});
  assert.throws(()=>f.exec('save_planning_template',{id:t.id,data:{...t.payload,name:'Perdida'},...meta(t.revision)}),/VERSION_CONFLICT/);
  assert.equal(s.get(f.u,'template',t.id).payload.name,'Actualizada');assert.equal(s.versions(f.u,'template',t.id).length,2);
});
test('all account references and histories are isolated',()=>{
  const a=fixture(),b=fixture(),food=a.food('Privado'),t=template(a,[slot('food',food)]);
  assert.throws(()=>b.exec('get_planning_document',{kind:'template',id:t.id}),/not found/);
  assert.deepEqual(b.exec('get_entity_versions',{kind:'template',id:t.id}),[]);
  assert.throws(()=>template(b,[slot('food',food)]),/not found/);
});
test('manual SQL edits are versioned without ChatGPT or invented reasons',()=>{
  const f=fixture(),food=f.food('Anterior');db.prepare('UPDATE foods SET name=? WHERE id=?').run('Actual',food);
  const versions=f.exec('get_entity_versions',{kind:'foods',id:String(food)});assert.equal(versions.length,2);assert.equal(versions[0].reason,null);assert.equal(versions[0].reason_status,'pending');
  assert.equal(versions[0].snapshot.name,'Actual');assert.equal(versions[1].snapshot.name,'Anterior');
});
test('restoring appends a version and comparison retains later history',()=>{
  const f=fixture(),t=template(f,[]),updated=f.exec('save_planning_template',{id:t.id,data:{...t.payload,name:'Otra'},...meta(t.revision)});
  const restored=f.exec('restore_planning_version',{kind:'template',id:t.id,revision:t.revision,...meta(updated.revision),confirm:true});
  assert.equal(restored.revision,3);assert.equal(restored.payload.name,'Prueba');
  const diff=f.exec('compare_entity_versions',{kind:'template',id:t.id,left:1,right:2});assert(diff.differences.some(d=>d.path==='/payload/name'));
  assert.equal(s.versions(f.u,'template',t.id).length,3);
});
test('recipe cycles are detected before generating a partial shopping list',()=>{
  const f=fixture(),food=f.food('Arroz'),meal=f.exec('save_catalog_meal',{data:{name:'Ciclo',items:[{food_id:food,portion:100,unit:'g'}]},...meta()});
  db.prepare('UPDATE meals SET items=? WHERE id=?').run(JSON.stringify([{meal_id:meal.id,portion:100,unit:'g',quantity:1}]),meal.id);
  const t=template(f,[slot('meal',meal.id)]);assert.throws(()=>generate(f,t),/Recursive recipe/);assert.equal(s.list(f.u,'shopping').length,0);
});
test('nested recipe portions and yields are expanded once per required serving',()=>{
  const f=fixture(),rice=f.food('Arroz');
  const child=f.exec('save_catalog_meal',{data:{name:'Tanda',is_recipe:true,portion:250,servings:4,items:[{food_id:rice,portion:1000,unit:'g'}]},...meta()});
  const parent=f.exec('save_catalog_meal',{data:{name:'Dos porciones',portion:500,items:[{meal_id:child.id,portion:500,unit:'g'}]},...meta()});
  const list=generate(f,template(f,[slot('meal',parent.id)]));assert.equal(list.payload.items[0].required,3500);
});
test('unknown ingredient nutrients stay incomplete against a saved target',()=>{
  const f=fixture(),a=f.food('Con calcio','g',{calories:100,calcium:100}),b=f.food('Sin información','g',{calories:100});
  db.prepare("INSERT INTO user_settings(user_id,key,value)VALUES(?,'goals',?)").run(f.u,JSON.stringify({calcium:{min:1000,max:1000}}));
  const meal=f.exec('save_catalog_meal',{data:{name:'Mixta',items:[{food_id:a,portion:100,unit:'g'},{food_id:b,portion:100,unit:'g'}]},...meta()});
  const t=template(f,[slot('meal',meal.id)]),result=f.exec('get_planned_nutrition',{template_id:t.id,from:'2026-10-26',to:'2026-10-26'});
  assert.equal(result.days[0].nutrition.calcium,100);assert.equal(result.days[0].comparison.calcium.complete,false);assert.equal(result.days[0].comparison.calcium.difference,null);
});
test('restoring a recipe preserves its original nutrient snapshot after its food changes',()=>{
  const f=fixture(),rice=f.food('Arroz');const original=f.exec('save_catalog_meal',{data:{name:'Original',items:[{food_id:rice,portion:100,unit:'g'}]},...meta()});
  db.prepare('UPDATE foods SET nutrition=? WHERE id=?').run(JSON.stringify({calories:900}),rice);
  const updated=f.exec('save_catalog_meal',{id:original.id,data:{name:'Actualizada',items:[{food_id:rice,portion:200,unit:'g'}]},...meta(original.revision)});
  const restored=f.exec('restore_catalog_meal',{id:original.id,revision:original.revision,...meta(updated.revision),confirm:true});assert.equal(restored.nutrition.calories,100);
});
test('a retired template can be recovered from history as a new revision',()=>{
  const f=fixture(),t=template(f,[]),deleted=f.exec('delete_planning_document',{kind:'template',id:t.id,...meta(t.revision),confirm:true});
  assert.equal(f.exec('list_planning_templates',{}).length,0);assert.equal(f.exec('list_planning_documents',{kind:'template',include_deleted:true}).length,1);
  const restored=f.exec('restore_planning_version',{kind:'template',id:t.id,revision:1,...meta(deleted.revision),confirm:true});assert.equal(restored.revision,3);assert.equal(restored.deleted,0);
});
test('catalogue household units and density are reused without blanket conversion',()=>{
  const f=fixture(),bread=f.food('Pan');
  db.prepare('UPDATE foods SET alt_units=? WHERE id=?').run(JSON.stringify([{abbr:'slice',grams:35}]),bread);
  const meal=f.exec('save_catalog_meal',{data:{name:'Tostadas',items:[{food_id:bread,portion:2,unit:'slice'}]},...meta()});
  const list=generate(f,template(f,[slot('meal',meal.id)]));assert.equal(list.payload.items[0].required,490);assert.equal(list.payload.items[0].unit,'g');
  const oil=f.food('Aceite','ml');db.prepare('UPDATE foods SET density_g_ml=.8 WHERE id=?').run(oil);
  const oilList=generate(f,template(f,[slot('food',oil)]));assert.equal(oilList.payload.items[0].required,560);assert.equal(oilList.payload.items[0].unit,'g');
});
test('regenerating after a recipe edit uses the new recipe version and keeps purchases',()=>{
  const f=fixture(),rice=f.food('Arroz'),data={name:'Tanda',is_recipe:true,portion:250,servings:4,items:[{food_id:rice,portion:1000,unit:'g'}]};
  const meal=f.exec('save_catalog_meal',{data,...meta()}),t=template(f,[slot('meal',meal.id)]);let list=generate(f,t);
  list=f.exec('update_shopping_item',{id:list.id,patch:{key:list.payload.items[0].key,purchased_quantity:500},...meta(list.revision)});
  const changed=f.exec('save_catalog_meal',{id:meal.id,data:{...data,items:[{food_id:rice,portion:2000,unit:'g'}]},...meta(meal.revision)});
  list=generate(f,t,{id:list.id,...meta(list.revision)});
  assert.equal(list.payload.items[0].required,3500);assert.equal(list.payload.items[0].purchased_quantity,500);assert.equal(list.payload.items[0].to_buy,3000);
  assert.equal(list.payload.sources.find(r=>r.kind==='meals').revision,changed.revision);assert.equal(list.payload.differences[0].before_required,1750);
  assert(list.payload.source_changes.some(r=>r.kind==='meals'&&r.before_revision===meal.revision&&r.after_revision===changed.revision));
});

test('checkboxes, partial purchases and manual quantities retain the product category',()=>{
 const f=fixture(),food=f.food('Leche','ml');
 f.exec('save_pantry_item',{data:{food_id:food,stock:0,unit:'ml',category:'lácteos'},...meta()});
 const t=template(f,[slot('food',food)]);let list=generate(f,t);
 const key=list.payload.items[0].key;
 for(const patch of [{purchased:true},{purchased_quantity:100},{override_quantity:500},{name:'Leche para la semana'}]){
  list=f.exec('update_shopping_item',{id:list.id,patch:{key,...patch},...meta(list.revision)});
  assert.equal(list.payload.items[0].category,'lácteos');assert.equal(list.payload.items[0].custom_category,undefined);
 }
});
