import test from 'node:test';
import assert from 'node:assert/strict';
import {weekStart,weekEnd,shiftDate,matchingList,categoryName} from '../src/lib/planning-view.js';
test('week navigation handles month/year boundaries, Sunday and leap days',()=>{
 assert.equal(weekStart('2026-11-01'),'2026-10-26');assert.equal(weekEnd('2026-10-27'),'2026-11-01');
 assert.equal(shiftDate('2026-12-28',7),'2027-01-04');assert.equal(shiftDate('2024-02-26',6),'2024-03-03');
 assert.equal(shiftDate(shiftDate('2026-10-26',7),-7),'2026-10-26');
});
test('shopping selection matches the template and full week, with useful empty state',()=>{
 const list={id:'saved',payload:{template_id:'plan',from:'2026-10-26',to:'2026-11-01'}};
 assert.equal(matchingList([list],'plan','2026-10-26','2026-11-01'),list);
 assert.equal(matchingList([list],'other','2026-10-26','2026-11-01'),null);
 assert.equal(matchingList([list],'plan','2026-11-02','2026-11-08'),null);
 assert.equal(categoryName('pescados'),'Pescados');assert.equal(categoryName('unknown'),'Otros productos');
});
