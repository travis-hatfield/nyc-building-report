#!/usr/bin/env node
// Unit tests for js/planner-engine.js (pure logic, no DOM). Run: node tests/planner.test.mjs
import { createRequire } from 'node:module';
const E = createRequire(import.meta.url)('../js/planner-engine.js');
let fail = 0;
const check = (n, c) => { console.log(`  ${c ? 'ok' : 'FAIL'} — ${n}`); if(!c) fail++; };

check("parseDim 7'9\" = 93", E.parseDim("7'9\"") === 93);
check('parseDim bare feet', E.parseDim('12') === 144);
check('parseDim garbage is NaN', Number.isNaN(E.parseDim('abc')));
check('fmtDim round trip', E.fmtDim(93) === "7'9\"");

const rooms = [
  {id: 'k', name: 'Kitchen', x: 0, y: 0, w: 76, h: 95},
  {id: 'l', name: 'Living Room', x: 82, y: 0, w: 140, h: 120},
  {id: 'b', name: 'Bedroom', x: 228, y: 0, w: 130, h: 140},
  {id: 'ba', name: 'Bathroom', x: 364, y: 0, w: 60, h: 90}
];
const counts = {sofa3: 1, coffee: 1, endtable: 2, tvstand: 1, bedqueen: 1, nightstand: 2, dresser: 1, desk: 1, officechair: 1};
for(let v = 0; v < 3; v++){
  const r = E.autoArrange(rooms, counts, {variant: v});
  check(`variant ${v}: no overlaps/out-of-room`, E.conflicts(r.items, rooms).size === 0);
  check(`variant ${v}: nothing placed in bathroom`, !r.items.some(i => i.roomName === 'Bathroom'));
  check(`variant ${v}: everything accounted for`, r.items.length + r.left.length === 11);
}
const a = E.autoArrange(rooms, counts, {variant: 0}), b = E.autoArrange(rooms, counts, {variant: 1});
const sig = r => r.items.filter(i => i.type === 'sofa3').map(i => `${i.x},${i.y},${i.rot}`).join();
check('variants place the couch differently', sig(a) !== sig(b));
const tiny = E.autoArrange([{id: 'x', name: 'Living Room', x: 0, y: 0, w: 60, h: 60}], {bedking: 1}, {});
check('oversize piece reported as left, not forced', tiny.left.length === 1 && tiny.items.length === 0);
console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
