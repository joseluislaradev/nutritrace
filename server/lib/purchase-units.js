// No blanket ml=g conversion. Opaque/custom units only combine with themselves.
import { parseAltUnits } from '../../src/lib/units.js';
const mass = {g:1,kg:1000,mg:.001,oz:28.349523125,lb:453.59237};
const volume = {ml:1,l:1000,tsp:4.92892159375,tbsp:14.78676478125,cup:236.5882365,'fl oz':29.5735295625};
export function canonical(amount, unit, altUnits) {
  unit=String(unit).trim().toLowerCase();
  if (mass[unit]) return {amount:amount*mass[unit],unit:'g'};
  if (volume[unit]) return {amount:amount*volume[unit],unit:'ml'};
  const alternative=parseAltUnits(altUnits)?.find(r=>String(r.abbr).toLowerCase()===unit && Number.isFinite(Number(r.grams)) && Number(r.grams)>0);
  if(alternative)return {amount:amount*Number(alternative.grams),unit:'g'};
  return {amount,unit};
}
export function convert(amount, from, to, density, altUnits) {
  const a=canonical(amount,from,altUnits),b=canonical(1,to,altUnits);
  if(a.unit===b.unit)return a.amount/b.amount;
  if(density>0 && a.unit==='g' && b.unit==='ml')return a.amount/density/b.amount;
  if(density>0 && a.unit==='ml' && b.unit==='g')return a.amount*density/b.amount;
  return null;
}
export function practical(amount,unit) {
  return (unit==='g'||unit==='ml') && amount>=1000
    ? {amount:amount/1000,unit:unit==='g'?'kg':'l'} : {amount,unit};
}
