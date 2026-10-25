import { externalBody } from '../body-source-policy.js';
import { authChallenge } from './oauth-config.js';
const readTools = new Set(['get_goals','get_profile','get_steps','get_body_composition','list_diary_entries','list_diary_entries_range','get_daily_totals','get_daily_totals_range','search_foods','get_recent_foods','search_meals','get_recent_meals','get_meal_details']);
const destroyTools = new Set(['edit_diary_entry','delete_diary_entry','create_food']);
export function authorizedRegistrar(server, auth) {
  return {registerTool(name, definition, handler) {
    if (externalBody() && ['log_body_stat','get_body_composition'].includes(name)) return;
    const read = readTools.has(name), destroy = destroyTools.has(name);
    const scopes = name === 'set_nutrition_goals' ? ['mcp:write','mcp:goals:write'] : [read ? 'mcp:read' : destroy ? 'mcp:destroy' : 'mcp:write'];
    if (auth.authKind === 'pat' && !scopes.every(s => auth.scopes.includes(s))) return;
    const oauth = auth.authKind === 'oauth' ? {securitySchemes:[{type:'oauth2',scopes}]} : {};
    server.registerTool(name, {...definition, ...oauth,
      annotations:{readOnlyHint:read, destructiveHint:destroy || name==='set_nutrition_goals' || name==='log_body_stat', openWorldHint:false, idempotentHint:read},
      _meta:{...definition._meta, ...oauth}}, async (...args) => {
        if (!scopes.every(s => auth.scopes.includes(s))) return {isError:true,content:[{type:'text',text:'Insufficient scope'}],
          _meta:{'mcp/www_authenticate':[`${authChallenge(scopes.join(' '))}, error="insufficient_scope", error_description="Additional permission required"`]}};
        return handler(...args);
      });
  }};
}
