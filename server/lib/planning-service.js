import { randomUUID, createHash } from 'node:crypto';
import db from '../db.js';
import { commands } from './planning-contracts.js';
import { canonical, convert, practical } from './purchase-units.js';
import { changeContext } from './planning-storage.js';
import { nutritionGoals, externalBody } from './body-source-policy.js';
import { resolveGoalFor, percentGoalToGrams } from '../../src/lib/goal-resolver.js';

export function fail(message, status=400) { const e=new Error(message);e.status=status;throw e; }
const stamp=()=>new Date().toISOString();
const round=n=>Math.round(n*1e6)/1e6;
const stable=value=>JSON.stringify(value,(_k,v)=>v && typeof v==='object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v);
const parse=row=>row && {...row,payload:JSON.parse(row.payload)};
const numericNutrition=n=>Object.fromEntries(Object.entries(n||{}).filter(([k])=>k!=='_derived').map(([k,v])=>{
  if((typeof v!=='number' && (typeof v!=='string'||!v.trim()))||!Number.isFinite(Number(v))||Number(v)<0)fail('Invalid nutrient '+k);
  return [k,Number(v)];
}));
const addNutrition=(total,n,factor)=>{for(const [k,v] of Object.entries(n))total[k]=(total[k]||0)+v*factor;};

export class PlanningService {
  constructor(database=db){this.db=database;}
  catalog(u,kind,id){
    if(!['meals','foods'].includes(kind))fail('Invalid catalogue');
    const row=this.db.prepare(`SELECT * FROM ${kind} WHERE id=? AND COALESCE(user_id,0)=? AND deleted_at IS NULL`).get(id,u);
    if(!row)fail('Catalogue item not found in your account',404);
    return {...row,nutrition:JSON.parse(row.nutrition||'{}'),...(kind==='meals'?{items:JSON.parse(row.items||'[]')}:{})};
  }
  get(u,kind,id){const row=parse(this.db.prepare('SELECT * FROM planning_documents WHERE user_id=? AND kind=? AND id=? AND deleted=0').get(u,kind,id));if(!row)fail('Document not found',404);return row;}
  list(u,kind){return this.db.prepare('SELECT * FROM planning_documents WHERE user_id=? AND kind=? AND deleted=0 ORDER BY updated_at DESC,id').all(u,kind).map(parse);}
  put(u,kind,id,payload,expected,deleted=0){
    const old=this.db.prepare('SELECT * FROM planning_documents WHERE user_id=? AND kind=? AND id=?').get(u,kind,id);
    if((old?.revision||0)!==expected)fail('VERSION_CONFLICT: reread before changing this document',409);
    if(old && old.deleted===deleted && stable(JSON.parse(old.payload))===stable(payload))return parse(old);
    const revision=(old?.revision||0)+1,time=stamp();
    this.db.prepare(`INSERT INTO planning_documents VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,kind,id)
      DO UPDATE SET revision=excluded.revision,payload=excluded.payload,deleted=excluded.deleted,updated_at=excluded.updated_at`)
      .run(u,kind,id,revision,JSON.stringify(payload),deleted,time);
    const ctx=changeContext.getStore();
    this.db.prepare('INSERT INTO entity_versions VALUES(?,?,?,?,?,?,?,?,?)').run(u,kind,id,revision,
      JSON.stringify({payload,deleted}),ctx?.source||'manual',ctx?.reason||null,ctx?.reason?'provided':'pending',time);
    return {user_id:u,kind,id,revision,payload,deleted,updated_at:time};
  }
  versions(u,kind,id){return this.db.prepare('SELECT * FROM entity_versions WHERE user_id=? AND kind=? AND entity_id=? ORDER BY revision DESC').all(u,kind,id).map(r=>({...r,snapshot:JSON.parse(r.snapshot)}));}
  checkRefs(u,slots){for(const s of slots)this.catalog(u,s.type==='food'?'foods':'meals',s.id);}
  resolve(u,{template_id,from,to}){
    if(to<from || (Date.parse(to)-Date.parse(from))/86400000>92)fail('Choose a range of at most 93 days');
    const t=this.get(u,'template',template_id),exceptions=this.list(u,'exception').filter(e=>e.payload.template_id===template_id);
    const days=[];
    for(let date=from;date<=to;date=new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10)){
      if(date<t.payload.starts_on || (t.payload.ends_on && date>t.payload.ends_on))continue;
      const index=(new Date(date+'T00:00:00Z').getUTCDay()+6)%7;
      const base=t.payload.days[index],e=exceptions.find(e=>e.payload.date===date);
      const slots=new Map(base.slots.map(s=>[s.slot_id,s]));
      if(e)for(const p of e.payload.slots){slots.delete(p.slot_id);if(p.replacement)slots.set(p.replacement.slot_id,p.replacement);}
      days.push({date,day_type:e?.payload.day_type||base.day_type,
        slots:e?.payload.skip?[]:[...slots.values()].sort((a,b)=>a.time.localeCompare(b.time)||a.slot_id.localeCompare(b.slot_id)),
        template_revision:t.revision,exception:e?{id:e.id,revision:e.revision}:null});
    }
    return {template_id,template_revision:t.revision,timezone:t.payload.timezone,days};
  }
  // Canonical item snapshots preserve the composition used at save time.
  // Refreshed explicitly on an ingredient edit; historical recipes never drift.
  prepareMeal(u,data,existing,preserveSnapshots=false){
    const out={...existing,...data};
    if(typeof out.name!=='string'||!out.name.trim())fail('Name required');
    if(!Array.isArray(out.items)||out.items.length>300)fail('Invalid ingredient list');
    const total={};
    out.items=out.items.map(item=>{
      const portion=Number(item.portion),quantity=Number(item.quantity??1);
      if(!Number.isFinite(portion)||portion<=0||!Number.isFinite(quantity)||quantity<=0)fail('Ingredient quantities must be positive');
      let source,kind;
      const unchanged=existing?.items?.some(old=>stable(old)===stable(item));
      if(item.meal_id && !preserveSnapshots && !unchanged){kind='meals';source=this.catalog(u,kind,item.meal_id);}
      else if(item.food_id && !preserveSnapshots && !unchanged){kind='foods';source=this.catalog(u,kind,item.food_id);}
      // Existing UI ingredients may be shared/imported snapshots. Their
      // composition has already been scaled by the editor to item.portion.
      let nutrition;
      if(source){
        const amount=convert(portion,item.unit,source.unit,source.density_g_ml,source.alt_units);
        if(amount===null)fail('Missing ingredient unit conversion');
        nutrition=Object.fromEntries(Object.entries(numericNutrition(source.nutrition)).map(([k,v])=>[k,v*amount/source.portion]));
      } else nutrition=numericNutrition(item.nutrition);
      addNutrition(total,nutrition,quantity);
      return {...item,portion,quantity,unit:String(item.unit||'g'),nutrition,
        ...(source?{id:source.id,name:source.name,brand:source.brand||null,source_revision:source.revision,
          ...(kind==='foods'?{food_server_id:source.id}:{is_recipe:!!source.is_recipe})}:{})};
    });
    const yields=out.is_recipe?Number(out.servings??1):1;
    if(!Number.isFinite(yields)||yields<=0)fail('Recipe yield must be positive');
    if(!Number.isFinite(Number(out.portion))||Number(out.portion)<=0)fail('Portion must be positive');
    out.nutrition=out.items.length?Object.fromEntries(Object.entries(total).map(([k,v])=>[k,v/yields])):numericNutrition(out.nutrition);
    // Preserve authoritative imported rollups until ingredients change.
    if(existing?.source_app && stable(existing.items)===stable(data.items??existing.items))out.nutrition=existing.nutrition;
    if(preserveSnapshots)out.nutrition=numericNutrition(data.nutrition);
    return out;
  }
  saveMeal(u,id,data,expected,preserveSnapshots=false){
    let old=id?this.db.prepare('SELECT * FROM meals WHERE id=? AND COALESCE(user_id,0)=?').get(id,u):null;
    if(id && (!old || (old.deleted_at && !preserveSnapshots)))fail('Catalogue item not found in your account',404);
    if(old)old={...old,items:JSON.parse(old.items||'[]'),nutrition:JSON.parse(old.nutrition||'{}')};
    if((old?.revision||0)!==expected)fail('VERSION_CONFLICT: reread meal',409);
    const prepared=this.prepareMeal(u,data,old,preserveSnapshots);
    if(id){
      const result=this.db.prepare(`UPDATE meals SET name=?,items=?,nutrition=?,is_recipe=?,portion=?,unit=?,servings=?,notes=?,img_url=?,visibility=?,favorite=?,updated_at=?,deleted_at=NULL
        WHERE id=? AND COALESCE(user_id,0)=? AND revision=?`).run(prepared.name,JSON.stringify(prepared.items),JSON.stringify(prepared.nutrition),prepared.is_recipe?1:0,
          prepared.portion,prepared.unit,prepared.servings??null,prepared.notes??null,prepared.img_url??null,prepared.visibility||'private',prepared.favorite?1:0,stamp(),id,u,expected);
      if(!result.changes)fail('VERSION_CONFLICT',409);
    }else{
      id=Number(this.db.prepare(`INSERT INTO meals(user_id,name,items,nutrition,is_recipe,portion,unit,servings,notes,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(u||null,prepared.name,JSON.stringify(prepared.items),JSON.stringify(prepared.nutrition),prepared.is_recipe?1:0,prepared.portion,prepared.unit,prepared.servings??null,prepared.notes??null,stamp()).lastInsertRowid);
    }
    return this.catalog(u,'meals',id);
  }
  collect(u,menu){
    const ingredients=[],warnings=[],sources=new Map();
    const warn=message=>{if(!warnings.includes(message))warnings.push(message);};
    const expand=(type,id,servings,stack=[],state='unspecified')=>{
      const kind=type==='food'?'foods':'meals',row=this.catalog(u,kind,id),key=kind+':'+id;
      sources.set(key,{kind,id,name:row.name,revision:row.revision});
      if(stack.includes(key)||stack.length>=12)fail('Recursive recipe or nesting limit reached');
      if(kind==='foods'){
        ingredients.push({food_id:id,name:row.name,brand:row.brand,category:row.category||'otros',amount:row.portion*servings,unit:row.unit,state,alt_units:row.alt_units,density_g_ml:row.density_g_ml});return;
      }
      const factor=servings/(row.is_recipe?(row.servings||1):1);
      if(!row.items.length)warn(`Recipe ${id} has no ingredient detail`);
      for(const item of row.items){
        const portion=Number(item.portion),q=Number(item.quantity??1),s=item.state||'unspecified';
        if(!(portion>0 && q>0)){warn(`Invalid quantity in recipe ${id}`);continue;}
        const nested=item.unresolved_reference?null:item.meal_id || ((item.type==='meal'||item.is_recipe)?item.id:null);
        if(nested){
          const child=this.catalog(u,'meals',nested),amount=convert(portion,item.unit,child.unit,null);
          if(amount===null){warn(`Missing nested recipe conversion in ${id}`);continue;}
          expand('meal',nested,amount/child.portion*q*factor,[...stack,key],s);continue;
        }
        const foodId=item.food_id||item.food_server_id||item.id;
        let food;
        try{if(item.unresolved_reference)throw new Error('Unsynced ingredient');food=this.catalog(u,'foods',foodId);}catch{warn(`Unresolved ingredient ${item.name||foodId} in recipe ${id}`);}
        // Legacy local IDs are not necessarily server IDs. Never merge an
        // ambiguous old snapshot with an unrelated product of the same ID.
        if(food && !item.food_id && !item.food_server_id && item.name!==food.name){food=null;warn(`Ambiguous legacy ingredient ${item.name} in recipe ${id}`);}
        if(food)sources.set('foods:'+foodId,{kind:'foods',id:foodId,name:food.name,revision:food.revision});
        ingredients.push({food_id:food?.id||null,name:food?.name||item.name||'Unresolved ingredient',brand:food?.brand||item.brand,
          category:food?.category||'otros',amount:portion*q*factor,unit:item.unit||'g',state:s,alt_units:food?.alt_units,density_g_ml:food?.density_g_ml,
          unresolved_key:food?null:`${id}:${row.items.indexOf(item)}`});
      }
    };
    for(const day of menu.days)for(const slot of day.slots)expand(slot.type,slot.id,slot.servings);
    return {ingredients,warnings,sources:[...sources.values()]};
  }
  nutrition(u,input){
    const menu=this.resolve(u,input),days=[],weekly={},warnings=[];
    const settings=this.db.prepare("SELECT key,value FROM user_settings WHERE COALESCE(user_id,0)=? AND deleted_at IS NULL AND key IN ('goals','waterGoalMl')").all(u);
    const goals=Object.fromEntries(settings.map(r=>[r.key,JSON.parse(r.value)]));
    goals.goals=nutritionGoals(goals.goals||{});
    for(const day of menu.days){
      const total={},coverage={};
      for(const slot of day.slots){const row=this.catalog(u,slot.type==='food'?'foods':'meals',slot.id);addNutrition(total,numericNutrition(row.nutrition),slot.servings);
        for(const key of Object.keys(row.nutrition))if(!row.items?.length || row.items.every(i=>typeof i.nutrition?.[key]==='number'))coverage[key]=(coverage[key]||0)+1;}
      const unknown=[...new Set([...Object.keys(total),...Object.keys(goals.goals)])].filter(k=>!day.slots.length||coverage[k]!==day.slots.length);
      if(unknown.length)warnings.push(`${day.date}: incomplete nutrient composition: ${unknown.join(', ')}`);
      const comparison=Object.fromEntries(Object.entries(goals.goals).map(([key,goal])=>{
        let target=resolveGoalFor(goal,day.date);
        if(goal?.autoAdjust && !externalBody()){target=null;warnings.push(`${day.date}: dynamic target ${key} requires the current effective goal`);}
        if(goal?.isPercent)target=percentGoalToGrams(target,resolveGoalFor(goals.goals.calories,day.date),({proteins:4,carbohydrates:4,fat:9})[key]);
        return [key,{target,estimated:total[key]??null,complete:!unknown.includes(key),difference:target!=null&&!unknown.includes(key)?round(total[key]-target):null}];
      }));
      days.push({...day,nutrition:total,incomplete_nutrients:unknown,comparison});addNutrition(weekly,total,1);
    }
    return {...menu,days,weekly,goals,warnings,notice:'Nutrients absent from composition are unknown, not zero. Planning does not record consumption.'};
  }
  generate(u,a){
    const old=a.id?this.get(u,'shopping',a.id):null;
    if(old && old.payload.template_id!==a.template_id)fail('Cannot change the source template of an existing list');
    const menu=this.resolve(u,a),collected=this.collect(u,menu),pantry=this.list(u,'pantry'),groups=new Map();
    const warnings=[...collected.warnings];
    for(const ingredient of collected.ingredients){
      const config=pantry.find(p=>p.payload.food_id===ingredient.food_id)?.payload;
      const conversion={density_g_ml:config?.density_g_ml??ingredient.density_g_ml,alt_units:ingredient.alt_units};
      let {amount,unit}=canonical(ingredient.amount,ingredient.unit,conversion.alt_units),state=ingredient.state;
      if(conversion.density_g_ml && unit==='ml'){amount*=conversion.density_g_ml;unit='g';}
      if(config?.cooked_yield && state==='cooked' && unit==='g'){amount/=config.cooked_yield;state='raw';}
      else if(state==='cooked')warnings.push(`Raw/cooked conversion missing for ${ingredient.name}; kept as cooked`);
      const key=`${ingredient.food_id||'unresolved:'+ingredient.unresolved_key}:${state}:${unit}`;
      const current=groups.get(key);
      if(current)current.required+=amount;
      else groups.set(key,{key,food_id:ingredient.food_id,name:ingredient.name,brand:ingredient.brand||null,
        category:config?.category||ingredient.category,required:amount,unit,state,manual:false,conversion});
    }
    const items=[...groups.values()].map(item=>{
      const previous=old?.payload.items.find(i=>i.key===item.key),config=pantry.find(p=>p.payload.food_id===item.food_id)?.payload;
      let stock=0;
      if(config){
        let value=convert(config.stock,config.unit,item.unit,item.conversion.density_g_ml,item.conversion.alt_units),stockState=config.state;
        if(config.cooked_yield && stockState==='cooked' && item.state==='raw' && item.unit==='g'){
          if(value!==null)value/=config.cooked_yield;stockState='raw';
        }
        if(stockState===item.state && value!==null)stock=value;
        else if(config.stock>0)warnings.push(`Inventory cannot be converted for ${item.name}`);
      }
      return this.decorate({...item,required:round(item.required),stock:round(stock),override_quantity:previous?.override_quantity??null,
        purchased_quantity:previous?.purchased_quantity||0,name:previous?.custom_name||item.name,custom_name:previous?.custom_name,
        category:previous?.custom_category||item.category,custom_category:previous?.custom_category,package:config?{...config,...item.conversion}:null});
    });
    for(const previous of old?.payload.items||[])if(!groups.has(previous.key) && (previous.manual || previous.purchased_quantity>0 || previous.override_quantity!=null))
      items.push(this.decorate({...previous,required:previous.manual?previous.required:0,removed_from_menu:!previous.manual}));
    const differences=[];
    for(const key of new Set([...(old?.payload.items||[]).map(i=>i.key),...items.map(i=>i.key)])){
      const before=old?.payload.items.find(i=>i.key===key),after=items.find(i=>i.key===key);
      if(!before || !after || before.required!==after.required || before.to_buy!==after.to_buy || before.name!==after.name || before.brand!==after.brand || before.packages!==after.packages || before.estimated_cost!==after.estimated_cost)
        differences.push({key,name:after?.name||before.name,unit:after?.unit||before.unit,
          before_name:before?.name??null,after_name:after?.name??null,before_brand:before?.brand??null,after_brand:after?.brand??null,
          before_required:before?.required??0,after_required:after?.required??0,before_to_buy:before?.to_buy??0,after_to_buy:after?.to_buy??0});
    }
    const source_changes=collected.sources.flatMap(source=>{
      const before=old?.payload.sources.find(s=>s.kind===source.kind&&s.id===source.id);
      return !before || before.revision!==source.revision?[{...source,before_revision:before?.revision??null,after_revision:source.revision}]:[];
    });
    return this.put(u,'shopping',a.id||randomUUID(),{name:a.name,template_id:a.template_id,from:a.from,to:a.to,items,
      source_menu:menu,sources:collected.sources,pantry_revisions:pantry.map(p=>({id:p.id,revision:p.revision})),
      warnings:[...new Set(warnings)],differences,source_changes,generated_at:stamp(),budget:this.budget(items)},a.expected_revision);
  }
  decorate(item){
    const needed=item.override_quantity??Math.max(0,item.required-(item.stock||0));
    const to_buy=Math.max(0,needed-(item.purchased_quantity||0));
    let packages=null,estimated_cost=null;
    if(item.package?.package_size){
      let size=convert(item.package.package_size,item.package.package_unit,item.unit,item.package.density_g_ml,item.package.alt_units);
      let packageState=item.package.state;
      if(packageState==='cooked' && item.state==='raw' && item.unit==='g' && item.package.cooked_yield){size/=item.package.cooked_yield;packageState='raw';}
      if(size>0 && packageState===item.state){packages=Math.ceil(round(to_buy/size));if(item.package.price!=null)estimated_cost=round(packages*item.package.price);}
    }
    return {...item,needed:round(needed),to_buy:round(to_buy),display:practical(round(to_buy),item.unit),packages,estimated_cost};
  }
  budget(items){const totals={};for(const i of items)if(i.estimated_cost!=null){const c=i.package.currency;totals[c]=round((totals[c]||0)+i.estimated_cost);}return {totals,incomplete:items.some(i=>i.to_buy>0 && i.estimated_cost==null)};}
  execute(u,name,input,source='manual'){
    const cmd=commands[name];if(!cmd)fail('Unknown command',404);
    const result=cmd.schema.safeParse(input);if(!result.success)fail(result.error.message);
    const a=result.data;
    if(cmd.read)return this.db.transaction(()=>this.run(u,name,a)).deferred();
    return changeContext.run({source,reason:a.reason},()=>this.db.transaction(()=>{
      const fingerprint=createHash('sha256').update(name+stable(a)).digest('hex');
      const previous=this.db.prepare('SELECT * FROM planning_requests WHERE user_id=? AND request_key=?').get(u,a.idempotency_key);
      if(previous){if(previous.fingerprint!==fingerprint)fail('IDEMPOTENCY_KEY_REUSED',409);return JSON.parse(previous.response);}
      const response=this.run(u,name,a);
      this.db.prepare('INSERT INTO planning_requests VALUES(?,?,?,?)').run(u,a.idempotency_key,fingerprint,JSON.stringify(response));
      return response;
    }).immediate());
  }
  run(u,name,a){
    switch(name){
      case 'get_planning_catalog':return Object.fromEntries(['foods','meals'].map(kind=>[kind,this.db.prepare(`SELECT id,name,portion,unit,revision,deleted_at FROM ${kind} WHERE COALESCE(user_id,0)=? AND (?=1 OR deleted_at IS NULL) ORDER BY id LIMIT ? OFFSET ?`).all(u,Number(a.include_deleted),a.limit,a.offset)]));
      case 'list_planning_documents':return this.db.prepare('SELECT * FROM planning_documents WHERE user_id=? AND kind=? AND (?=1 OR deleted=0) ORDER BY updated_at DESC,id').all(u,a.kind,Number(a.include_deleted)).map(parse);
      case 'list_planning_templates':return this.list(u,'template');
      case 'get_planning_document':return this.get(u,a.kind,a.id);
      case 'list_pantry':return this.list(u,'pantry');
      case 'list_shopping_lists':return this.list(u,'shopping');
      case 'save_planning_template':{
        for(const day of a.data.days)this.checkRefs(u,day.slots);
        return this.put(u,'template',a.id||randomUUID(),a.data,a.expected_revision);
      }
      case 'save_planning_exception':{
        this.get(u,'template',a.data.template_id);this.checkRefs(u,a.data.slots.flatMap(s=>s.replacement?[s.replacement]:[]));
        const id=a.id||a.data.template_id+':'+a.data.date;
        const duplicate=this.list(u,'exception').find(e=>e.id!==id && e.payload.template_id===a.data.template_id && e.payload.date===a.data.date);
        if(duplicate)fail('An exception already exists for this date',409);
        return this.put(u,'exception',id,a.data,a.expected_revision);
      }
      case 'save_pantry_item':this.catalog(u,'foods',a.data.food_id);return this.put(u,'pantry',String(a.data.food_id),a.data,a.expected_revision);
      case 'delete_planning_document':{const old=this.get(u,a.kind,a.id);return this.put(u,a.kind,a.id,old.payload,a.expected_revision,1);}
      case 'resolve_planned_menu':return this.resolve(u,a);
      case 'get_planned_nutrition':return this.nutrition(u,a);
      case 'generate_shopping_list':return this.generate(u,a);
      case 'update_shopping_item':{
        const old=this.get(u,'shopping',a.id),p=old.payload,item=p.items.find(i=>i.key===a.patch.key);
        if(!item)fail('Shopping item not found',404);
        const {key,purchased,...patch}=a.patch;Object.assign(item,patch);
        if(patch.name)item.custom_name=patch.name;if(patch.category)item.custom_category=patch.category;
        if(purchased!=null)item.purchased_quantity=purchased?this.decorate(item).needed:0;
        Object.assign(item,this.decorate(item));p.budget=this.budget(p.items);
        return this.put(u,'shopping',a.id,p,a.expected_revision);
      }
      case 'add_shopping_item':{
        const old=this.get(u,'shopping',a.id),p=old.payload;
        p.items.push(this.decorate({key:'manual:'+randomUUID(),name:a.name,required:a.quantity,unit:a.unit,category:a.category,manual:true,stock:0,purchased_quantity:0,override_quantity:null}));
        p.budget=this.budget(p.items);return this.put(u,'shopping',a.id,p,a.expected_revision);
      }
      case 'export_shopping_list':{
        const doc=this.get(u,'shopping',a.id);
        if(a.format==='json')return {format:'json',content:JSON.stringify(doc,null,2)};
        const rows=doc.payload.items.slice().sort((a,b)=>a.category.localeCompare(b.category));
        const csv=v=>'"'+String(v??'').replaceAll('"','""')+'"';
        return {format:a.format,content:a.format==='csv'
          ? [['category','name','required','stock','purchased','to_buy','unit'],...rows.map(i=>[i.category,i.name,i.required,i.stock,i.purchased_quantity,i.to_buy,i.unit])].map(r=>r.map(csv).join(',')).join('\n')
          : rows.map(i=>`${i.to_buy===0?'[x]':'[ ]'} ${i.category}: ${i.name} — ${i.display.amount} ${i.display.unit}${i.packages!=null?' ('+i.packages+' '+i.package.package_label+')':''}`).join('\n')};
      }
      case 'get_entity_versions':return this.versions(u,a.kind,a.id);
      case 'compare_entity_versions':{
        const versions=this.versions(u,a.kind,a.id),left=versions.find(v=>v.revision===a.left),right=versions.find(v=>v.revision===a.right);
        if(!left||!right)fail('Version not found',404);
        const diffs=[];const walk=(l,r,path)=>{if(stable(l)===stable(r))return;if(l&&r&&typeof l==='object'&&typeof r==='object'&&!Array.isArray(l)&&!Array.isArray(r)){
          for(const k of new Set([...Object.keys(l),...Object.keys(r)]))walk(l[k],r[k],path+'/'+k);
        }else diffs.push({path,before:l??null,after:r??null});};walk(left.snapshot,right.snapshot,'');return {left,right,differences:diffs};
      }
      case 'restore_planning_version':{
        if(!this.db.prepare('SELECT 1 FROM planning_documents WHERE user_id=? AND kind=? AND id=?').get(u,a.kind,a.id))fail('Document not found',404);
        const v=this.versions(u,a.kind,a.id).find(v=>v.revision===a.revision);
        if(!v)fail('Version not found',404);
        const payload=v.snapshot.payload;
        if(a.kind==='template')for(const d of payload.days)this.checkRefs(u,d.slots);
        return this.put(u,a.kind,a.id,payload,a.expected_revision,0);
      }
      case 'save_catalog_meal':return this.saveMeal(u,a.id,a.data,a.expected_revision);
      case 'restore_catalog_meal':{
        const version=this.versions(u,'meals',String(a.id)).find(v=>v.revision===a.revision);
        if(!version)fail('Version not found',404);
        const data=version.snapshot;
        return this.saveMeal(u,a.id,{...data,items:JSON.parse(data.items||'[]'),nutrition:JSON.parse(data.nutrition||'{}')},a.expected_revision,true);
      }
      case 'delete_catalog_meal':{
        this.catalog(u,'meals',a.id);
        const result=this.db.prepare("UPDATE meals SET deleted_at=?,updated_at=? WHERE id=? AND COALESCE(user_id,0)=? AND revision=?").run(stamp(),stamp(),a.id,u,a.expected_revision);
        if(!result.changes)fail('VERSION_CONFLICT',409);return {id:a.id,deleted:true};
      }
    }
  }
}
export const planningService=new PlanningService();
