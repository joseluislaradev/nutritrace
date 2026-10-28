import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nt-planned-diary-'));
Object.assign(process.env,{DB_PATH:path.join(dir,'fixture.db'),NODE_ENV:'test',JWT_SECRET:'synthetic-only'});
const {default:db}=await import('../server/db.js');
const {planningService:s}=await import('../server/lib/planning-service.js');
const {mutateDiaryDay}=await import('../server/lib/mcp/_diary-write.js');
const {itemsRevision}=await import('../server/lib/mcp/_entry-target.js');
after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
const date='2026-10-27',meta=revision=>({expected_revision:revision||0,idempotency_key:randomUUID()});
function fixture(user){
 const u=user??Number(db.prepare('INSERT INTO users(username,password_hash) VALUES(?,?)').run(randomUUID(),'synthetic').lastInsertRowid);
 const food=Number(db.prepare("INSERT INTO foods(user_id,name,portion,unit,nutrition) VALUES(?,'Tortillas',1,'piece',?)").run(u||null,JSON.stringify({calories:50,proteins:2})).lastInsertRowid);
 const meal=s.execute(u,'save_catalog_meal',{data:{name:'Cena',is_recipe:true,servings:2,items:[{food_id:food,portion:8,unit:'piece'}]},...meta()});
 const template=s.execute(u,'save_planning_template',{data:{name:'Plan activo',starts_on:'2026-10-01',status:'active',days:Array.from({length:7},()=>({slots:[{slot_id:'dinner',time:'21:15',label:'Cena',type:'meal',id:meal.id,servings:1}]}))},...meta()});
 const read=()=>s.execute(u,'get_diary_plan',{date});
 function args(view=read(),extra={}) {const slot=view.slots[0];return {date,template_id:template.id,slot_id:'dinner',action:'consume',meal:2,...meta(slot.state_revision),expected_plan_revision:slot.plan_revision,expected_items_revision:view.items_revision,...extra};}
 return {u,food,meal,template,read,args,exec:(a)=>s.execute(u,'record_planned_meal',a)};
}
test('reading an active menu shows recipe yield and separate totals without creating diary rows',()=>{
 const f=fixture(),v=f.read();assert.equal(v.template.name,'Plan activo');assert.equal(v.slots[0].status,'pending');assert.equal(v.slots[0].preview.items[0].quantity,1);assert.equal(v.slots[0].preview.items[0].portion,4);
 assert.equal(v.planned_totals.calories,200);assert.equal(v.consumed_totals.calories,undefined);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diary WHERE user_id=?').get(f.u).n,0);
});
test('consumption is atomic and idempotent across retries, refreshes and new keys',()=>{
 const f=fixture(),a=f.args(),r=f.exec(a);assert.equal(r.view.consumed_totals.calories,200);assert.equal(r.view.slots[0].status,'consumed');
 assert.deepEqual(f.exec(a),r);assert.throws(()=>f.exec({...a,...meta()}),/VERSION_CONFLICT/);
 assert.throws(()=>f.exec(f.args()),/ALREADY_RECORDED/);assert.equal(f.read().slots[0].entry_ids.length,1);
 const row=db.prepare('SELECT items FROM diary WHERE user_id=?').get(f.u);assert.equal(JSON.parse(row.items)[0].planned_meal.template_id,f.template.id);
 assert.equal(s.versions(f.u,'diary_plan',r.state.id)[0].reason_status,'pending');
});
test('portion and ingredient adjustments only modify consumption, not recipe or template',()=>{
 const f=fixture(),before=db.prepare('SELECT * FROM meals WHERE id=?').get(f.meal.id),t=s.get(f.u,'template',f.template.id);
 const r=f.exec(f.args(undefined,{adjustments:[{index:0,portion:3}]}));assert.equal(r.view.consumed_totals.calories,150);assert.equal(r.view.slots[0].status,'modified');
 assert.deepEqual(db.prepare('SELECT * FROM meals WHERE id=?').get(f.meal.id),before);assert.deepEqual(s.get(f.u,'template',f.template.id),t);
});
test('skipping creates no calories and can later be explicitly consumed',()=>{
 const f=fixture(),r=f.exec(f.args(undefined,{action:'skip'}));assert.equal(r.view.slots[0].status,'skipped');assert.equal(r.view.consumed_totals.calories,undefined);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diary WHERE user_id=?').get(f.u).n,0);
 assert.equal(f.exec(f.args()).view.slots[0].status,'consumed');
});
test('menu and diary conflicts reject before writing history or consumption',()=>{
 const f=fixture(),a=f.args();mutateDiaryDay(f.u,date,c=>({...c,items:[{name:'Extra',quantity:1,nutrition:{calories:25}}]}));
 assert.throws(()=>f.exec(a),/VERSION_CONFLICT/);assert.equal(f.read().consumed_totals.calories,25);
 const b=f.args();db.prepare("UPDATE meals SET name='Nueva cena' WHERE id=?").run(f.meal.id);assert.throws(()=>f.exec(b),/VERSION_CONFLICT/);
 assert.equal(s.list(f.u,'diary_plan').length,0);
});
test('date replacements apply before preview and a changed exception invalidates an old read',()=>{
 const f=fixture(),a=f.args();s.execute(f.u,'save_planning_exception',{data:{template_id:f.template.id,date,slots:[{slot_id:'dinner',replacement:{slot_id:'dinner',type:'food',id:f.food,servings:3,time:'20:00',label:'Otra cena'}}]},...meta()});
 assert.throws(()=>f.exec(a),/VERSION_CONFLICT/);const v=f.read();assert.equal(v.slots[0].time,'20:00');assert.equal(v.planned_totals.calories,150);
 assert.equal(f.exec(f.args(v)).view.consumed_totals.calories,150);
});
test('manual edits/deletions are reflected and removed slots retain their actual links',()=>{
 const f=fixture();f.exec(f.args());mutateDiaryDay(f.u,date,c=>({...c,items:c.items.map(i=>({...i,quantity:0.25}))}));assert.equal(f.read().slots[0].status,'modified');
 const data=structuredClone(f.template.payload);for(const d of data.days)d.slots=[];
 s.execute(f.u,'save_planning_template',{id:f.template.id,data,...meta(f.template.revision)});
 assert(f.read().slots[0].removed_from_plan);assert.equal(f.read().planned_totals.calories,undefined);assert.equal(f.read().consumed_totals.calories,50);
 mutateDiaryDay(f.u,date,c=>({...c,items:[]}));assert(f.read().slots[0].missing_entries);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diary_tombstones WHERE user_id=?').get(f.u).n,1);
});
test('unrelated water, notes, body stats and legacy items survive recording',()=>{
 const f=fixture();mutateDiaryDay(f.u,date,c=>({...c,items:[{name:'Anterior',nutrition:{calories:30},quantity:1}],water:[{amount:250}],notes:'Mi nota',bodyStats:{weight_kg:70}}));
 const before=db.prepare('SELECT * FROM diary WHERE user_id=?').get(f.u);f.exec(f.args());const after=db.prepare('SELECT * FROM diary WHERE user_id=?').get(f.u);
 for(const col of ['water','notes','body_stats'])assert.equal(after[col],before[col]);assert.equal(JSON.parse(after.items)[0].name,'Anterior');
 assert.equal(f.read().consumed_totals.calories,230);
});
test('replacement uses catalogue snapshot and never changes planned calories',()=>{
 const f=fixture(),r=f.exec(f.args(undefined,{replacement:{type:'food',id:f.food,servings:2}}));assert.equal(r.view.consumed_totals.calories,100);assert.equal(r.view.planned_totals.calories,200);assert.equal(r.view.slots[0].status,'modified');
});
test('no active menu and multiple active templates have explicit safe states',()=>{
 const u=Number(db.prepare('INSERT INTO users(username,password_hash) VALUES(?,?)').run(randomUUID(),'synthetic').lastInsertRowid);
 assert.equal(s.execute(u,'get_diary_plan',{date}).slots.length,0);const f=fixture(u);fixture(u);
 const v=f.read();assert(v.needs_selection);assert.equal(v.slots.length,0);
 assert.equal(s.execute(u,'get_diary_plan',{date,template_id:f.template.id}).slots.length,1);
});
test('account isolation, unavailable catalogue and tombstoned days fail closed',()=>{
 const f=fixture(),other=fixture();assert.throws(()=>s.execute(other.u,'get_diary_plan',{date,template_id:f.template.id}),/not found/);
 const a=f.args();db.prepare("UPDATE meals SET deleted_at=datetime('now') WHERE id=?").run(f.meal.id);assert(f.read().slots[0].unavailable);assert.throws(()=>f.exec(a));
 const g=fixture();db.prepare("INSERT INTO diary(user_id,date,deleted_at) VALUES(?,?,datetime('now'))").run(g.u,date);assert(g.read().day_deleted);assert.throws(()=>g.exec(g.args()),/eliminado/);
});
test('no-user-management mode records into the existing anonymous day without duplicate rows',()=>{
 const f=fixture(0);mutateDiaryDay(null,date,c=>({...c,water:[{amount:100}]}));f.exec(f.args());
 const rows=db.prepare('SELECT * FROM diary WHERE user_id IS NULL AND date=?').all(date);assert.equal(rows.length,1);assert.equal(JSON.parse(rows[0].water)[0].amount,100);
 assert.equal(itemsRevision(JSON.parse(rows[0].items)),f.read().items_revision);
});

test('an injected PlanningService database receives the entire transaction, never the default connection',async()=>{
 const f=fixture();
 const {createRequire}=await import('node:module');
 const require=createRequire(new URL('../server/package.json',import.meta.url));
 const Database=require('better-sqlite3');
 const {PlanningService}=await import('../server/lib/planning-service.js');
 const {installPlanningStorage}=await import('../server/lib/planning-storage.js');
 const clonePath=path.join(dir,'injected.db');await db.backup(clonePath);
 const clone=new Database(clonePath);
 try{
  installPlanningStorage(clone);const other=new PlanningService(clone);
  other.execute(f.u,'record_planned_meal',f.args());
  assert.equal(other.execute(f.u,'get_diary_plan',{date}).consumed_totals.calories,200);
  assert.equal(f.read().consumed_count,0);assert.equal(s.list(f.u,'diary_plan').length,0);
 }finally{clone.close();}
});
