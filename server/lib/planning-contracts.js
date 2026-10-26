import { z } from 'zod';
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(v + 'T00:00:00Z');
  return Number.isFinite(+d) && d.toISOString().slice(0,10) === v;
}, 'Invalid calendar date');
const text = z.string().trim().min(1).max(200);
const positive = z.number().finite().positive().max(1e9);
export const ref = z.object({ type: z.enum(['food','meal']), id: z.number().int().positive(), servings: positive.default(1) });
export const slot = z.object({ slot_id: text, time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), label: text, ...ref.shape });
const day = z.object({ day_type: z.enum(['training','rest','recovery']).default('rest'), slots: z.array(slot).max(30) });
export const template = z.object({
  name: text, timezone: z.string().default('America/Mexico_City').refine(v => { try {new Intl.DateTimeFormat('en',{timeZone:v});return true;} catch{return false;} }),
  starts_on: date, ends_on: date.nullable().default(null),
  status: z.enum(['proposed','approved','active','archived']).default('proposed'),
  days: z.array(day).length(7),
}).superRefine((v,c) => {
  if (v.ends_on && v.ends_on < v.starts_on) c.addIssue({code:'custom',message:'End precedes start'});
  for (const d of v.days) if (new Set(d.slots.map(s=>s.slot_id)).size !== d.slots.length) c.addIssue({code:'custom',message:'Duplicate slot IDs'});
});
export const exception = z.object({
  template_id: text, date, day_type: z.enum(['training','rest','recovery']).optional(),
  skip: z.boolean().default(false),
  // A null replacement removes just that meal. Other slots are preserved.
  slots: z.array(z.object({slot_id:text, replacement:slot.nullable()})).max(30),
}).refine(v=>new Set(v.slots.map(s=>s.slot_id)).size===v.slots.length,'Duplicate exception slot')
  .refine(v=>v.slots.every(s=>!s.replacement || s.replacement.slot_id===s.slot_id),'Replacement must preserve slot_id');
export const pantry = z.object({
  food_id:z.number().int().positive(), stock:z.number().finite().min(0).max(1e9).default(0), unit:text,
  state:z.enum(['raw','cooked','unspecified']).default('unspecified'),
  category:z.enum(['carnes','pescados','lácteos','frutas','verduras','cereales','legumbres','grasas','otros']).default('otros'),
  density_g_ml:positive.nullable().default(null),
  // cooked mass / raw mass, explicitly supplied by the user, never inferred.
  cooked_yield:positive.nullable().default(null),
  package_size:positive.nullable().default(null), package_unit:text.default('g'),
  package_label:text.default('paquete'), price: z.number().finite().min(0).max(1e9).nullable().default(null),
  currency:z.string().regex(/^[A-Z]{3}$/).default('MXN'),
});
export const writeMeta = {
  expected_revision:z.number().int().min(0), idempotency_key:z.string().min(8).max(160),
  reason:z.string().trim().min(1).max(2000).optional(),
};
export const ingredient = z.object({
  food_id:z.number().int().positive().optional(), meal_id:z.number().int().positive().optional(),
  portion:positive, unit:text, quantity:positive.default(1),
  state:z.enum(['raw','cooked','unspecified']).default('unspecified'),
}).refine(v=>!!v.food_id !== !!v.meal_id,'Choose exactly one food_id or meal_id');
export const meal = z.object({name:text, is_recipe:z.boolean().default(false),
  portion:positive.default(100), unit:text.default('g'), servings:positive.nullable().default(null),
  notes:z.string().max(10000).nullable().default(null), items:z.array(ingredient).min(1).max(300),
});
export const listPatch = z.object({
  key:text, name:text.optional(), category:pantry.shape.category.optional(),
  override_quantity:z.number().finite().min(0).max(1e9).nullable().optional(),
  purchased_quantity:z.number().finite().min(0).max(1e9).optional(),
  purchased:z.boolean().optional(),
});
export const commands = {
  get_planning_catalog:{schema:z.object({limit:z.number().int().min(1).max(500).default(200),offset:z.number().int().min(0).default(0),include_deleted:z.boolean().default(false)}),read:true},
  list_planning_documents:{schema:z.object({kind:z.enum(['template','exception','pantry','shopping']),include_deleted:z.boolean().default(false)}),read:true},
  list_planning_templates:{schema:z.object({}),read:true},
  get_planning_document:{schema:z.object({kind:z.enum(['template','exception','pantry','shopping']),id:text}),read:true},
  save_planning_template:{schema:z.object({id:text.optional(),data:template,...writeMeta})},
  save_planning_exception:{schema:z.object({id:text.optional(),data:exception,...writeMeta})},
  delete_planning_document:{schema:z.object({kind:z.enum(['template','exception','pantry','shopping']),id:text,...writeMeta,confirm:z.literal(true)}),destroy:true},
  resolve_planned_menu:{schema:z.object({template_id:text,from:date,to:date}),read:true},
  get_planned_nutrition:{schema:z.object({template_id:text,from:date,to:date}),read:true},
  list_pantry:{schema:z.object({}),read:true},
  save_pantry_item:{schema:z.object({data:pantry,...writeMeta})},
  list_shopping_lists:{schema:z.object({}),read:true},
  generate_shopping_list:{schema:z.object({id:text.optional(),name:text,template_id:text,from:date,to:date,...writeMeta})},
  update_shopping_item:{schema:z.object({id:text,patch:listPatch,...writeMeta})},
  add_shopping_item:{schema:z.object({id:text,name:text,quantity:positive,unit:text,category:pantry.shape.category.default('otros'),...writeMeta})},
  export_shopping_list:{schema:z.object({id:text,format:z.enum(['json','csv','text']).default('text')}),read:true},
  get_entity_versions:{schema:z.object({kind:z.enum(['template','exception','pantry','shopping','meals','foods']),id:text}),read:true},
  compare_entity_versions:{schema:z.object({kind:z.enum(['template','exception','pantry','shopping','meals','foods']),id:text,left:z.number().int().min(0),right:z.number().int().min(0)}),read:true},
  restore_planning_version:{schema:z.object({kind:z.enum(['template','exception','pantry','shopping']),id:text,revision:z.number().int().min(1),...writeMeta,confirm:z.literal(true)}),destroy:true},
  restore_catalog_meal:{schema:z.object({id:z.number().int().positive(),revision:z.number().int().min(0),...writeMeta,confirm:z.literal(true)}),destroy:true},
  save_catalog_meal:{schema:z.object({id:z.number().int().positive().optional(),data:meal,...writeMeta})},
  delete_catalog_meal:{schema:z.object({id:z.number().int().positive(),...writeMeta,confirm:z.literal(true)}),destroy:true},
};
