import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('persistent database restarts preserve catalogue data and history with existing triggers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-planning-restart-'));
  const dbModule = new URL('../server/db.js', import.meta.url).href;
  const env = { ...process.env, DB_PATH: path.join(dir, 'persistent.db'), NODE_ENV: 'test' };
  function run(code) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import db from ${JSON.stringify(dbModule)};\n${code}\ndb.close();`],
      { env, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  }
  const snapshot = `console.log(JSON.stringify({
    foods: db.prepare('SELECT * FROM foods').all(),
    meals: db.prepare('SELECT * FROM meals').all(),
    versions: db.prepare('SELECT * FROM entity_versions ORDER BY kind, entity_id, revision').all()
  }));`;
  try {
    const before = run(`
      const u = db.prepare("INSERT INTO users(username,password_hash) VALUES('restart-owner','synthetic')").run().lastInsertRowid;
      db.prepare("INSERT INTO foods(user_id,name,nutrition,updated_at) VALUES(?,'Leche','{}','2020-01-01')").run(u);
      db.prepare("INSERT INTO meals(user_id,name,items,updated_at) VALUES(?,'Cena','[]','2020-01-02')").run(u);
      db.prepare("UPDATE meals SET name='Cena editada'").run();
      ${snapshot}
    `);
    assert.deepEqual(run(snapshot), before);
    assert.deepEqual(run(snapshot), before);
    const edited = run(`db.prepare("UPDATE foods SET name='Leche editada'").run(); ${snapshot}`);
    assert.equal(edited.foods[0].revision, before.foods[0].revision + 1);
    assert.equal(edited.versions.length, before.versions.length + 1);
    assert.deepEqual(run(snapshot), edited);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
