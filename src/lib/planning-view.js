// Calendar arithmetic is anchored at UTC noon, independent of DST or device TZ.
export function shiftDate(date, days) {
  const d = new Date(date+'T12:00:00Z');
  d.setUTCDate(d.getUTCDate()+days);
  return d.toISOString().slice(0,10);
}
export function weekStart(date) {
  const index=(new Date(date+'T12:00:00Z').getUTCDay()+6)%7;
  return shiftDate(date,-index);
}
export const weekEnd=date=>shiftDate(weekStart(date),6);
export const categoryName=category=>({carnes:'Carnes',pescados:'Pescados',lácteos:'Huevos y lácteos',frutas:'Frutas',verduras:'Verduras',cereales:'Cereales',legumbres:'Legumbres',grasas:'Aceites y grasas',otros:'Otros productos'}[category]||'Otros productos');
export function matchingList(lists,template,from,to) {
  return lists.find(l=>l.payload.template_id===template && l.payload.from===from && l.payload.to===to)||null;
}

export const displayUnit=unit=>({piece:'pzas',pieces:'pzas',unit:'pzas',ml:'ml',g:'g',kg:'kg',l:'l'}[unit]||unit);
