import { createHash, randomUUID } from 'node:crypto';
import { Nutrition } from '../../src/lib/nutrition.js';
import { itemsRevision } from './mcp/_entry-target.js';
import { mutateDiaryDay } from './mcp/_diary-write.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, status = 409) => { const e = new Error(message); e.status = status; throw e; };
const content = item => ({name:item.name, nutrition:item.nutrition, quantity:item.quantity, portion:item.portion, unit:item.unit, meal:item.meal, notes:item.notes, split:item._splitItems});
const sameItems = items => hash(items.map(content));
export const occurrenceId = (template, date, slot) => hash([template,date,slot]);

// Snapshots follow Diary's nutrition-per-portion × quantity convention. Recipe
// yield scales ingredient quantities, never the reusable catalogue recipe.
export function slotPreview(service, user, slot, row = service.catalog(user, slot.type === 'food' ? 'foods' : 'meals', slot.id)) {
  let items;
  if (slot.type === 'food') {
    items = [{name:row.name, brand:row.brand, food_server_id:row.id, portion:row.portion,
      unit:row.unit, nutrition:row.nutrition, quantity:slot.servings, imgUrl:row.img_url||''}];
  } else {
    const factor = slot.servings / (row.is_recipe ? (row.servings || 1) : 1);
    if (!row.items.length) fail('Esta comida no tiene ingredientes. Revisa su receta antes de registrarla.', 400);
    items = row.items.map(item => ({...item, quantity:Number(item.quantity ?? 1)*factor}));
  }
  // Present effective ingredient amounts (e.g. 4 tortillas), not a recipe's
  // batch amount multiplied by a fractional serving. This also makes portion
  // edits match the amount the person sees before confirming consumption.
  const flatten = (item, multiplier=1) => {
    const quantity=Number(item.quantity??1)*multiplier;
    if(Array.isArray(item._splitItems)&&item._splitItems.length)
      return item._splitItems.flatMap(child=>flatten(child,quantity));
    return [{...item,portion:Number(item.portion)>0?Number(item.portion)*quantity:item.portion,
      nutrition:Nutrition.calculate({...item,quantity}),quantity:1}];
  };
  items=items.flatMap(item=>flatten(item));
  return {name:row.name, catalogue_revision:row.revision, items,
    incomplete_nutrients:['calories','proteins'].filter(key=>items.some(i=>i.nutrition[key]==null)),
    nutrition:Nutrition.sum(items.map(i=>Nutrition.calculate(i)))};
}
function diary(service, user, date) {
  const row = service.db.prepare('SELECT * FROM diary WHERE user_id IS ? AND date=?').get(user||null,date);
  return {row, items:row && !row.deleted_at ? JSON.parse(row.items||'[]') : []};
}
export function diaryPlan(service, user, args) {
  const {row,items} = diary(service,user,args.date);
  const active = service.list(user,'template').filter(t=>t.payload.status==='active' &&
    t.payload.starts_on<=args.date && (!t.payload.ends_on || t.payload.ends_on>=args.date));
  const template = args.template_id ? service.get(user,'template',args.template_id) : active.length===1 ? active[0] : null;
  const states = service.list(user,'diary_plan').filter(s=>s.payload.date===args.date && (!args.template_id || s.payload.template_id===args.template_id));
  const slots = [];
  if (template) {
    const menu = service.resolve(user,{template_id:template.id,from:args.date,to:args.date});
    for (const slot of menu.days[0]?.slots||[]) {
      const id=occurrenceId(template.id,args.date,slot.slot_id), state=states.find(s=>s.id===id);
      let preview, unavailable=null;
      try { preview=slotPreview(service,user,slot); } catch(e) { unavailable=e.message; }
      const planRevision=hash({template:template.revision,exception:menu.days[0].exception,slot,preview});
      slots.push({...slot,occurrence_id:id,template_id:template.id,template_revision:template.revision,
        exception:menu.days[0].exception,plan_revision:planRevision,preview,unavailable,state});
    }
  }
  // A consumed occurrence remains visible even if its slot/template was removed.
  for (const state of states) if (!slots.some(s=>s.occurrence_id===state.id))
    slots.push({...state.payload.slot,occurrence_id:state.id,template_id:state.payload.template_id,
      preview:state.payload.preview,state,removed_from_plan:true});
  for (const slot of slots) {
    const state=slot.state;
    const linked=items.filter(i=>i.planned_meal?.occurrence_id===slot.occurrence_id || state?.payload.entry_ids?.includes(i.uuid));
    slot.changed_since_recording=!!state && state.payload.plan_revision!==slot.plan_revision && !slot.removed_from_plan;
    slot.entry_ids=linked.map(i=>i.uuid);
    slot.actual_entries=linked.map(i=>({uuid:i.uuid,name:i.name}));
    slot.state_revision=state?.revision||0;
    slot.status=state?.payload.status==='skipped' && !linked.length ? 'skipped'
      : state?.payload.status==='consumed' || linked.length
        ? sameItems(linked)===state?.payload.items_fingerprint && !state?.payload.adjusted ? 'consumed' : 'modified'
        : 'pending';
    slot.actual_nutrition=Nutrition.sum(linked.map(i=>Nutrition.calculate(i)));
    slot.missing_entries=state?.payload.status==='consumed' && !linked.length;
    delete slot.state;
  }
  return {date:args.date, template:template?{id:template.id,name:template.payload.name}:null,
    needs_selection:!args.template_id && active.length>1,
    templates:active.map(t=>({id:t.id,name:t.payload.name})),slots,
    items_revision:itemsRevision(items),day_deleted:!!row?.deleted_at,
    planned_totals:Nutrition.sum(slots.filter(s=>!s.removed_from_plan).map(s=>s.preview?.nutrition||{})),
    consumed_count:items.length,consumed_totals:Nutrition.sum(items.map(i=>Nutrition.calculate(i)))};
}
export function recordPlannedMeal(service,user,args) {
  const view=diaryPlan(service,user,{date:args.date,template_id:args.template_id});
  if(view.day_deleted)fail('El día fue eliminado. Restáuralo en Diario antes de registrar comidas.');
  const slot=view.slots.find(s=>s.slot_id===args.slot_id && !s.removed_from_plan);
  if(!slot || slot.unavailable)fail(slot?.unavailable||'La comida ya no está planificada. Vuelve a consultar.');
  if(slot.state_revision!==args.expected_revision || slot.plan_revision!==args.expected_plan_revision || view.items_revision!==args.expected_items_revision)
    fail('VERSION_CONFLICT: el menú o el diario cambiaron. Vuelve a consultar antes de registrar.');
  if(['consumed','modified'].includes(slot.status))fail('ALREADY_RECORDED: esta comida ya fue registrada. Edita sus entradas en Diario.');
  const preview=args.replacement ? slotPreview(service,user,args.replacement) : structuredClone(slot.preview);
  const items=preview.items;
  for(const change of args.adjustments||[]) {
    const item=items[change.index];
    if(!item)fail('El ingrediente seleccionado ya no existe.',400);
    if(change.portion!==undefined) {
      if(!(Number(item.portion)>0))fail('No se puede convertir una porción sin tamaño conocido.',400);
      const factor=change.portion/Number(item.portion);
      item.nutrition=Object.fromEntries(Object.entries(item.nutrition||{}).map(([k,v])=>[k,typeof v==='number'?v*factor:v]));
      item.portion=change.portion;
    }
    if(change.quantity!==undefined)item.quantity=change.quantity;
    if(change.omit)item._omit=true;
  }
  const now=new Date().toISOString();
  const actual=items.filter(i=>!i._omit).map(item=>{
    const {uuid,addedAt,updatedAt,planned_meal,_omit,...snapshot}=item;
    return {...snapshot,meal:args.meal,uuid:randomUUID(),addedAt:now,updatedAt:now,source:'planned',
      planned_meal:{occurrence_id:slot.occurrence_id,template_id:args.template_id,slot_id:args.slot_id,
        date:args.date,template_revision:slot.template_revision,exception:slot.exception,plan_revision:slot.plan_revision}};
  });
  if(args.action==='consume' && !actual.length)fail('Selecciona al menos un ingrediente o usa Omitir.',400);
  if(args.action==='consume')mutateDiaryDay(user||null,args.date,cur=>({...cur,items:[...cur.items,...actual]}),service.db);
  const state=service.put(user,'diary_plan',slot.occurrence_id,{date:args.date,template_id:args.template_id,
    slot:{slot_id:slot.slot_id,label:slot.label,time:slot.time,type:slot.type,id:slot.id,servings:slot.servings},
    preview:slot.preview,status:args.action==='skip'?'skipped':'consumed',entry_ids:args.action==='skip'?[]:actual.map(i=>i.uuid),
    items_fingerprint:args.action==='skip'?null:sameItems(actual),adjusted:!!args.replacement||!!args.adjustments?.length,
    plan_revision:slot.plan_revision},args.expected_revision);
  return {state,view:diaryPlan(service,user,{date:args.date,template_id:args.template_id})};
}
