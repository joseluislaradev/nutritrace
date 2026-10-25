import { isDeepStrictEqual } from 'node:util';
import { externalBody } from '../../body-source-policy.js';
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError, safeJson } from '../_util.js';
import { getGoalsCore } from './goals.js';
const fields = ['calories','proteins','carbohydrates','fat','water'];
const values = z.object(Object.fromEntries(fields.map(k => [k,z.number().finite().positive().max(k==='water'?10000:k==='calories'?20000:2000).optional()]))).strict();
const expected = z.object(Object.fromEntries(fields.map(k => [k,z.unknown().optional()]))).strict();
export function setNutritionGoalsCore(userId, {targets, expected: before, confirm}) {
  if (confirm !== true) throw new Error('Explicit confirmation required.');
  targets = values.parse(targets);
  if (!Object.keys(targets).length) throw new Error('At least one target is required.');
  return db.transaction(() => {
    const get = key => safeJson(db.prepare('SELECT value FROM user_settings WHERE user_id=? AND key=? AND deleted_at IS NULL').get(userId,key)?.value, null);
    const mode = get('calorieGoalMode');
    if (targets.calories !== undefined && !externalBody() && mode && mode !== 'fixed') throw new Error('Switch to fixed calorie goals explicitly in the app first.');
    const goals = get('goals') || {};
    for (const key of Object.keys(targets)) {
      const old = key==='water' ? get('waterGoalMl') : goals[key] ?? null;
      if (!before || !Object.hasOwn(before,key) || !isDeepStrictEqual(before[key],old)) throw new Error('GOAL_CONFLICT: read get_goals and supply the unchanged complete previous field (or null).');
      if (key!=='water' && old && (old.sharedGoal===false || old.isPercent || old.autoAdjust)) throw new Error('Only fixed, daily, absolute goals can be changed.');
    }
    const upsert = db.prepare(`INSERT INTO user_settings (user_id,key,value,updated_at) VALUES (?,?,?,datetime('now'))
      ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=datetime('now'),deleted_at=NULL`);
    for (const [key,value] of Object.entries(targets)) {
      if (key==='water') { upsert.run(userId,'waterGoalMl',JSON.stringify(value)); continue; }
      const previous = goals[key] || {sharedGoal:true,isMin:false,isPercent:false,autoAdjust:false,showInDiary:true,showInStats:true};
      const next = {...previous,days:Array(7).fill(value)};
      delete next.min; delete next.max;
      const isMin = previous.isMin ?? (previous.min != null && previous.max == null);
      next.isMin = isMin;
      next[isMin?'min':'max'] = value;
      goals[key] = next;
    }
    if (Object.keys(targets).some(k => k!=='water')) upsert.run(userId,'goals',JSON.stringify(goals));
    return {ok:true,...getGoalsCore(userId)};
  })();
}
export function registerSetNutritionGoals(server,{userId}) {
  server.registerTool('set_nutrition_goals', {
    title:'Set daily nutrition goals',
    description:'Explicitly update fixed daily targets in kcal, grams and ml. First read get_goals. expected must contain the complete previous goal object for each changed nutrient, previous water_goal_ml as water, or null for an absent goal. No body targets or automatic TDEE. Requires confirmation.',
    inputSchema:{targets:values,expected,confirm:z.literal(true)},
  }, async args => { try { return toolResult(setNutritionGoalsCore(userId,args)); } catch(e) { return toolError(e.message); } });
}
