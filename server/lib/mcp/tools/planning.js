import { commands } from '../../planning-contracts.js';
import { planningService } from '../../planning-service.js';
import { toolResult, toolError } from '../_util.js';

const descriptions={
  list_planning_documents:'List owned planning documents of a kind. include_deleted includes retired documents so their history can be read and restored.',
  get_planning_catalog:'List owned foods and meals/recipes with server IDs, portions, units and revisions for planning. Paginate with limit and offset; never substitute local device IDs.',
  list_planning_templates:'List saved recurring weekly menu templates. Monday is days[0]. No consumption is recorded.',
  get_planning_document:'Read a template, date exception, pantry configuration or saved shopping list including its revision.',
  save_planning_template:'Create or update a recurring weekly template. days has seven days Monday–Sunday; slots reference catalogue food/meal IDs and servings. Repeats within its date bounds without generating weeks. Read first; expected_revision=0 for new documents.',
  save_planning_exception:'Change one date without changing the weekly template. Each slot_id is replaced or removed with replacement:null; skip removes the full day. Reuse the existing exception revision when modifying it.',
  delete_planning_document:'Soft-delete a planning document with confirmation and the revision read earlier. Never deletes consumption.',
  resolve_planned_menu:'Resolve a date range with recurring weekly slots and date exceptions applied. Dates must be explicit; maximum 93 days.',
  get_planned_nutrition:'Get estimated daily and range nutrient totals, current goals and composition warnings from planning, not consumption. Missing nutrients are unknown, not zero.',
  list_pantry:'Read current inventory, raw/cooked yields, categories, package sizes and optional prices.',
  save_pantry_item:'Set stock and purchasing configuration for an owned food. Provide density or cooked_yield only when known; cooked_yield is cooked mass / raw mass. Price is per package, not per gram.',
  list_shopping_lists:'List saved shopping lists with revisions and regeneration differences.',
  generate_shopping_list:'Generate or regenerate a list from the resolved planned menu, expanding recipes and applying yields, inventory and compatible units. Pass existing id and revision to regenerate; purchased quantities, manual rows and quantity overrides are retained. Review warnings and differences.',
  update_shopping_item:'Edit a saved shopping item by stable key. override_quantity is the desired total purchase amount after inventory, before purchased quantities, in the item unit; null clears it. purchased=true marks the current needed amount bought. Regeneration preserves adjustments.',
  add_shopping_item:'Add a manual item to a shopping list. It survives regeneration.',
  export_shopping_list:'Export a private saved shopping list as JSON, CSV or shareable plain text. No public link is created.',
  get_entity_versions:'Read immutable versions and reasons, including automatic manual changes. pending means no reason was supplied, not a scientific justification.',
  compare_entity_versions:'Compare two recorded versions by revision. Returns changed paths and before/after values.',
  restore_planning_version:'Restore a planning snapshot as a new revision after explicit confirmation; history is preserved.',
  restore_catalog_meal:'Restore an owned meal or recipe snapshot as a new version, preserving later history. Requires confirm:true and the current expected_revision.',
  save_catalog_meal:'Create or replace an owned saved meal or recipe. Ingredients use exactly one food_id/meal_id plus portion, unit, quantity and optional raw/cooked state. Nutrition is computed by the shared service. servings is total recipe yield, portion is amount per serving. expected_revision comes from get_meal_details; 0 creates a new meal. Does not log consumption.',
  delete_catalog_meal:'Soft-delete one owned meal/recipe after confirmation, using the revision previously read. History and diary entries are preserved.',
};
export function registerPlanningTools(server,{userId},group){
  for(const [name,cmd] of Object.entries(commands)){
    if((cmd.read?'read':cmd.destroy?'destroy':'write')!==group)continue;
    server.registerTool(name,{title:name.replaceAll('_',' '),description:descriptions[name],inputSchema:cmd.schema.shape},async input=>{
      try{const result=planningService.execute(userId,name,input,'mcp');return toolResult(Array.isArray(result)?{items:result}:result);}catch(e){return toolError(e.message);}
    });
  }
}
