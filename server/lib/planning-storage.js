import { AsyncLocalStorage } from 'node:async_hooks';

export const changeContext = new AsyncLocalStorage();

// SQLite functions belong to a connection; persisted triggers survive restarts.
// Register these before any startup migration can write to catalogue tables.
export function registerPlanningFunctions(db) {
  db.function('nt_change_source', () => changeContext.getStore()?.source || 'manual_or_sync');
  db.function('nt_change_reason', () => changeContext.getStore()?.reason || null);
  db.function('nt_history_enabled', () => changeContext.getStore()?.suspend ? 0 : 1);
}

// Additive migration. Existing rows, IDs and sync timestamps are untouched.
export function installPlanningStorage(db) {
  registerPlanningFunctions(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS planning_documents (
      user_id INTEGER NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
      revision INTEGER NOT NULL, payload TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL, PRIMARY KEY(user_id,kind,id)
    );
    CREATE TABLE IF NOT EXISTS entity_versions (
      user_id INTEGER NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
      revision INTEGER NOT NULL, snapshot TEXT NOT NULL, source TEXT NOT NULL,
      reason TEXT, reason_status TEXT NOT NULL, recorded_at TEXT NOT NULL,
      PRIMARY KEY(user_id,kind,entity_id,revision)
    );
    CREATE TABLE IF NOT EXISTS planning_requests (
      user_id INTEGER NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
      response TEXT NOT NULL, PRIMARY KEY(user_id,request_key)
    );
  `);
  // DB-level capture also covers imports, offline sync and older REST writers.
  // Only catalogue/business fields advance the revision; usage counters do not.
  for (const table of ['meals', 'foods']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === 'revision'))
      db.exec(`ALTER TABLE ${table} ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`);
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
      .filter(c => !['revision', 'updated_at', 'changed_at', 'usage_count', 'last_used_at', 'client_key'].includes(c));
    const object = prefix => `json_object(${cols.flatMap(c => [`'${c}'`, `${prefix}."${c}"`]).join(',')})`;
    const current = `json_object(${cols.flatMap(c => [`'${c}'`, `"${c}"`]).join(',')})`;
    db.exec(`
      INSERT OR IGNORE INTO entity_versions
      SELECT COALESCE(user_id,0),'${table}',CAST(id AS TEXT),revision,${current},
        'baseline',NULL,'pending',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM ${table};
      CREATE TRIGGER IF NOT EXISTS nt_${table}_insert AFTER INSERT ON ${table} WHEN nt_history_enabled() BEGIN
        INSERT INTO entity_versions VALUES(COALESCE(NEW.user_id,0),'${table}',CAST(NEW.id AS TEXT),NEW.revision,
          ${object('NEW')},nt_change_source(),nt_change_reason(),
          CASE WHEN nt_change_reason() IS NULL THEN 'pending' ELSE 'provided' END,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TRIGGER IF NOT EXISTS nt_${table}_update AFTER UPDATE ON ${table}
      WHEN nt_history_enabled() AND ${object('OLD')} != ${object('NEW')} BEGIN
        UPDATE ${table} SET revision=OLD.revision+1 WHERE id=NEW.id;
        INSERT INTO entity_versions VALUES(COALESCE(NEW.user_id,0),'${table}',CAST(NEW.id AS TEXT),OLD.revision+1,
          ${object('NEW')},nt_change_source(),nt_change_reason(),
          CASE WHEN nt_change_reason() IS NULL THEN 'pending' ELSE 'provided' END,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
    `);
  }
}
