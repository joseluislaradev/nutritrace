import test from 'node:test';
import assert from 'node:assert/strict';
const storage=new Map();
globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
globalThis.location={origin:'https://nutri.example'};
const {applyBodySource,bodyIsExternal,requireInternalBody,retainBodyConflicts,loadBodyConflicts,bodyConflicts,isBodyMetric,bodyConflictStorageKey}=await import('../src/lib/body-source.js');
const {get}=await import('svelte/store');
test('external capability persists offline and can revert to the upstream mode',()=>{
 applyBodySource('gym-log');assert(bodyIsExternal());assert.throws(requireInternalBody,/Gym Log/);assert([...storage.values()].includes('gym-log'));
 applyBodySource('internal');assert(!bodyIsExternal());assert.doesNotThrow(requireInternalBody);
 for(const metric of ['weight_kg','muscle_mass_kg','body_fat_pct','waist'])assert(isBodyMetric(metric));
 for(const metric of ['steps','sleep_duration_min','water','calories_out','body_battery_high','body_battery_low'])assert(!isBodyMetric(metric));
});
test('mixed sync conflicts are durable, deduplicated and isolated by account',()=>{
 storage.set('wl:userId','1');const row={date:'2026-10-24',body_stats:{weight:80}};
 retainBodyConflicts([row]);retainBodyConflicts([row]);assert.equal(get(bodyConflicts).length,1);
 loadBodyConflicts();assert.deepEqual(get(bodyConflicts),[row]);
 storage.set('wl:userId','2');loadBodyConflicts();assert.deepEqual(get(bodyConflicts),[]);
 storage.set('wl:userId','1');loadBodyConflicts();assert.equal(get(bodyConflicts).length,1);
});

test('a response arriving after account switch retains conflicts only for its initiating account',()=>{
 loadBodyConflicts('request-owner');const captured=bodyConflictStorageKey();
 loadBodyConflicts('other-owner');retainBodyConflicts([{date:'2026-10-25',body_stats:{weight:77}}],captured);
 assert.deepEqual(get(bodyConflicts),[]);loadBodyConflicts('request-owner');assert.equal(get(bodyConflicts)[0].body_stats.weight,77);
});
