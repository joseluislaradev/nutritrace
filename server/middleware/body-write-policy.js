import db from '../db.js';
import { externalBody, BODY_SETTINGS, isBodyMetric } from '../lib/body-source-policy.js';
// Explicit endpoints fail loudly. Mixed diary/sync/import requests keep their
// nutritional data; connection-level guards preserve the stored body fields.
export function bodyWritePolicy(req, res, next) {
  if (!externalBody()) return next();
  res.set('X-Body-Measurements-Source', 'gym-log');
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  const path = req.path;
  const conflicts = [];
  const candidate = (day, incoming, clientId) => {
    if (!incoming || !Object.keys(incoming).length) return;
    const u = req.user?.id ?? null;
    const row = db.prepare('SELECT body_stats FROM diary WHERE date=? AND user_id IS ?').get(day,u);
    let previous;try {previous=JSON.parse(row?.body_stats || '{}');}catch{previous={};}
    if (JSON.stringify(previous)!==JSON.stringify(incoming)) conflicts.push({date:day,clientId,body_stats:incoming});
  };
  if (/^\/api\/diary\/[^/]+$/.test(path)) candidate(path.split('/').at(-1),req.body?.body_stats || req.body?.bodyStats);
  if (/^\/api\/(sync\/push|data\/import)$/.test(path)) {
    for (const d of req.body?.diary || []) candidate(d.date,d.body_stats || d.bodyStats,d.client_id);
    for (const w of req.body?.wellness || []) if (isBodyMetric(w.metric_type)) conflicts.push({date:w.date,metric_type:w.metric_type,value:w.value,clientId:w.client_id});
  }
  if (/^\/api\/v1\/(body-measurements|diary\/[^/]+\/body-stat)(?:\/|$)/.test(path)
      || (/^\/api\/full-backup/.test(path) && /restore/.test(path))
      || (path === '/api/settings' && BODY_SETTINGS.has(req.body?.key))) {
    return res.status(403).json({error:'BODY_MEASUREMENTS_EXTERNAL', message:'Record body measurements in Gym Log.'});
  }
  const original = res.json.bind(res);
  res.json = payload => {
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && /\/api\/(diary|sync|data|settings)/.test(path)) {
      payload = {...payload, body_measurements_source:'gym-log',
        body_conflicts:conflicts,
        body_policy_notice:'Body changes are not applied; nutritional operations are processed normally. Resolve/export pending body edits in Gym Log.'};
    }
    return original(payload);
  };
  if (path.startsWith('/api/settings') && req.body?.settings) {
    req.body.settings = Object.fromEntries(Object.entries(req.body.settings).filter(([k]) => !BODY_SETTINGS.has(k)));
  }
  next();
}
