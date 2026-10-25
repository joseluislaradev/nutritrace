// One deployment capability; no schema migration and no second body history.
export function bodySource() {
  const source = process.env.BODY_MEASUREMENTS_SOURCE || 'internal';
  if (!['internal', 'gym-log'].includes(source)) throw new Error('Invalid BODY_MEASUREMENTS_SOURCE');
  return source;
}
export const externalBody = () => bodySource() === 'gym-log';
export const BODY_GOALS = new Set(['weight','weight_kg','target_weight','body_fat','body_water','body_fat_pct','body_water_pct','neck','waist','hips','chest','thighs','biceps','calves','muscle_mass_kg','lean_mass_kg']);
export const BODY_SETTINGS = new Set(['weight_kg','height_cm','target_weight','tdee']);
export function isBodyMetric(metric) {
  return BODY_GOALS.has(metric) || /^(weight|height|target_weight|body_(?:fat|water|mass|muscle|score)|neck$|waist$|hips$|chest$|thighs$|biceps$|calves$|muscle_|skeletal_|lean_|fat_mass|fat_free_mass|bone_|visceral_|extracellular_water|intracellular_water|bmi$|bmr$|basal_metabolic_rate$|metabolic_age$|impedance$)/.test(metric);
}
export function requireInternalBody() {
  if (externalBody()) {
    const e = new Error('Body measurements are recorded exclusively in Gym Log.');
    e.code = 'BODY_MEASUREMENTS_EXTERNAL';
    e.status = 403;
    throw e;
  }
}
export function nutritionGoals(goals) {
  return Object.fromEntries(Object.entries(goals || {}).filter(([k]) => !isBodyMetric(k)));
}
// Temporary guards protect *all* writers, including provider jobs, sync and
// imports. They live only on this connection and never change persisted schema.
export function installBodySourceGuards(db) {
  bodySource();
  db.function('nt_external_body', () => Number(externalBody()));
  db.function('nt_body_metric', m => Number(isBodyMetric(String(m))));
  db.function('nt_body_setting', k => Number(BODY_SETTINGS.has(k)));
  db.function('nt_body_goals', (next, old) => {
    const parse = x => { try { return JSON.parse(x || '{}') || {}; } catch { return {}; } };
    const n = parse(next), o = parse(old);
    for (const key of Object.keys(n)) if (isBodyMetric(key)) delete n[key];
    for (const [key, value] of Object.entries(o)) if (isBodyMetric(key)) n[key] = value;
    return JSON.stringify(n);
  });
  db.exec(`
    CREATE TEMP TABLE nt_body_guard (id INTEGER PRIMARY KEY);
    CREATE TEMP TRIGGER nt_diary_insert AFTER INSERT ON main.diary
    WHEN nt_external_body() AND NEW.body_stats != '{}'
    BEGIN INSERT INTO nt_body_guard VALUES (NEW.id); UPDATE diary SET body_stats='{}' WHERE id=NEW.id; DELETE FROM nt_body_guard WHERE id=NEW.id; END;
    CREATE TEMP TRIGGER nt_diary_update AFTER UPDATE OF body_stats ON main.diary
    WHEN nt_external_body() AND NEW.body_stats IS NOT OLD.body_stats AND NOT EXISTS (SELECT 1 FROM nt_body_guard WHERE id=NEW.id)
    BEGIN UPDATE diary SET body_stats=OLD.body_stats WHERE id=NEW.id; END;
    CREATE TEMP TRIGGER nt_wellness_insert BEFORE INSERT ON main.wellness_data
    WHEN nt_external_body() AND nt_body_metric(NEW.metric_type)
    BEGIN SELECT RAISE(IGNORE); END;
    CREATE TEMP TRIGGER nt_wellness_delete BEFORE DELETE ON main.wellness_data
    WHEN nt_external_body() AND nt_body_metric(OLD.metric_type)
    BEGIN SELECT RAISE(IGNORE); END;
    CREATE TEMP TRIGGER nt_wellness_update BEFORE UPDATE ON main.wellness_data
    WHEN nt_external_body() AND (nt_body_metric(NEW.metric_type) OR nt_body_metric(OLD.metric_type))
    BEGIN SELECT RAISE(IGNORE); END;
    CREATE TEMP TRIGGER nt_settings_insert BEFORE INSERT ON main.user_settings
    WHEN nt_external_body() AND nt_body_setting(NEW.key)
    BEGIN SELECT RAISE(IGNORE); END;
    CREATE TEMP TRIGGER nt_settings_update BEFORE UPDATE ON main.user_settings
    WHEN nt_external_body() AND (nt_body_setting(NEW.key) OR nt_body_setting(OLD.key))
    BEGIN SELECT RAISE(IGNORE); END;
    CREATE TEMP TRIGGER nt_goals_insert AFTER INSERT ON main.user_settings
    WHEN nt_external_body() AND NEW.key='goals'
    BEGIN INSERT OR IGNORE INTO nt_body_guard VALUES (-1); UPDATE user_settings SET value=nt_body_goals(NEW.value,NULL) WHERE user_id=NEW.user_id AND key=NEW.key; DELETE FROM nt_body_guard WHERE id=-1; END;
    CREATE TEMP TRIGGER nt_goals_update AFTER UPDATE OF value ON main.user_settings
    WHEN nt_external_body() AND NEW.key='goals' AND NOT EXISTS (SELECT 1 FROM nt_body_guard WHERE id=-1) AND NEW.value != nt_body_goals(NEW.value,OLD.value)
    BEGIN UPDATE user_settings SET value=nt_body_goals(NEW.value,OLD.value) WHERE user_id=NEW.user_id AND key=NEW.key; END;
  `);
}
