import { writable, get } from 'svelte/store';
import { isNative, getServerUrl } from './platform.js';
const cacheKey = () => 'nt:bodySource:' + (isNative ? getServerUrl() || 'local' : (globalThis.location?.origin || 'web') + (globalThis.window?.__NT_CONFIG__?.basePath || ''));
function cached() { try { return localStorage.getItem(cacheKey()) === 'gym-log'; } catch { return false; } }
export const externalBodyMode = writable(cached());
export const bodyIsExternal = () => get(externalBodyMode);
export const isBodyMetric = key => /^(weight|height|target_weight|body_(?:fat|water|mass|muscle|score)|neck$|waist$|hips$|chest$|thighs$|biceps$|calves$|muscle_|skeletal_|lean_|fat_mass|fat_free_mass|bone_|visceral_|extracellular_water|intracellular_water|bmi$|bmr$|basal_metabolic_rate$|metabolic_age$|impedance$)/.test(key);
export function applyBodySource(source) {
  const external = source === 'gym-log';
  externalBodyMode.set(external);
  if (external && isNative) import('./db-native.js').then(async m => {await m.dbMirrorSetting('notifWeighIn',false); const n=await import('./notifications.js');await n.cancelWeighInReminder();}).catch(()=>{});
  try { localStorage.setItem(cacheKey(), external ? 'gym-log' : 'internal'); } catch {}
}
export function requireInternalBody() {
  if (bodyIsExternal()) throw new Error('Registra peso y medidas exclusivamente en Gym Log.');
}

let conflictAccount;
const conflictKey = () => cacheKey() + ':conflicts:' + (conflictAccount ?? globalThis.localStorage?.getItem('wl:userId') ?? 'local');
export const bodyConflicts = writable([]);
export const bodyConflictStorageKey = () => conflictKey();
export function loadBodyConflicts(account) {
  if (account !== undefined) conflictAccount=String(account);
  try { bodyConflicts.set(JSON.parse(localStorage.getItem(conflictKey()) || '[]')); } catch {bodyConflicts.set([]);}
}
export function retainBodyConflicts(rows, storageKey=conflictKey()) {
  if (!Array.isArray(rows) || !rows.length) return;
  let previous=[];
  try { previous=JSON.parse(localStorage.getItem(storageKey) || '[]'); } catch {}
  const all=[...new Map([...previous,...rows].map(r=>[JSON.stringify(r),r])).values()];
  // Never discard unresolved edits: storage failure makes the HTTP operation
  // retryable rather than acknowledging and losing the body portion.
  localStorage.setItem(storageKey,JSON.stringify(all));
  if (storageKey===conflictKey()) bodyConflicts.set(all);
}
export function exportBodyConflicts() {
  const blob=new Blob([JSON.stringify(get(bodyConflicts),null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='gym-body-edits-to-review.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function dismissBodyConflicts() {
  if (!confirm('¿Ya exportaste o resolviste estas medidas en Gym Log?')) return;
  localStorage.removeItem(conflictKey());bodyConflicts.set([]);
}
