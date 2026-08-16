#!/usr/bin/env node
/**
 * Smoke test for index.html — loads the real app in jsdom (with all network calls
 * mocked), drives it through the actual DOM the way a user would, and asserts on
 * the resulting HTML. No test framework, no build step: this app is a single
 * static file with no bundler, so the test stays the same shape.
 *
 * Run: node tests/smoke.mjs
 * (needs `jsdom` — if you don't have it, `npm install --no-save jsdom` first)
 *
 * This exists because a "fix" to fetchNearbyPOIs's error handling shipped, looked
 * correct in isolated testing, and was still wrong in production (Node's fetch and
 * the browser's fetch didn't agree on how AbortController.abort(reason) surfaces
 * to the caught error). A couple of minutes running this before every deploy is a
 * lot cheaper than that back-and-forth.
 *
 * Add a case here whenever you fix a bug that wasn't obvious from reading the code
 * — that's exactly the kind of regression this is meant to catch next time.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond){
  if(cond){ pass++; console.log(`  ok — ${name}`); }
  else { fail++; console.error(`  FAIL — ${name}`); }
}
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

function newApp(fetchImpl){
  const dom = new JSDOM(html, {
    url: 'http://localhost/index.html',
    runScripts: 'dangerously',
    resources: undefined,
    pretendToBeVisual: true,
    beforeParse(window){
      window.fetch = fetchImpl(window);
      window.matchMedia = window.matchMedia || (() => ({
        matches:false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}
      }));
    }
  });
  return dom.window;
}

async function testDobYearFilter(){
  console.log('\nDOB Complaints year filter');
  const rows = [
    {complaint_number:'1', date_entered:'2024-05-01', complaint_category:'45', status:'ACTIVE'},
    {complaint_number:'2', date_entered:'2021-01-15', complaint_category:'46', status:'CLOSED'},
  ];
  const window = newApp(() => async (url) => {
    const u = String(url);
    if(u.includes('eabe-havv')) return { ok:true, status:200, json: async () => rows };
    return { ok:true, status:200, json: async () => [] };
  });
  await wait(200);
  const doc = window.document;
  doc.getElementById('houseNumber').value = '123';
  doc.getElementById('streetName').value = 'West 45 Street';
  doc.getElementById('borough').value = 'MANHATTAN';
  doc.getElementById('searchBtn').click();
  for(let i=0;i<50;i++){ await wait(100); if(!doc.getElementById('sec-dobComplaints')?.querySelector('.loading')) break; }
  const select = doc.getElementById('dobYearFilter');
  select.value = '2024';
  select.dispatchEvent(new window.Event('change', {bubbles:true}));
  await wait(50);
  const rowCount = (doc.getElementById('dobCfDynamic').innerHTML.match(/<tr class="expandable"/g) || []).length;
  check('filtering to 2024 onward leaves exactly 1 row', rowCount === 1);
}

async function testNearbyAbortMessage(){
  console.log('\nWhat\'s Nearby: hung Overpass mirror shows a real message, not the generic browser one');
  const window = newApp(win => async (url, opts) => {
    const u = String(url);
    if(u.includes('nominatim')) return { ok:true, status:200, json: async () => ([{lat:'40.7484', lon:'-73.9857', display_name:'Test Address, Manhattan, NY'}]) };
    if(u.includes('overpass')){
      return new Promise((resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new win.DOMException('signal is aborted without reason', 'AbortError')));
      });
    }
    return { ok:true, status:200, json: async () => [] };
  });
  window.L = {
    map(){ return { setView(){return this;}, invalidateSize(){}, removeLayer(){} }; },
    tileLayer(){ return { addTo(){} }; },
    marker(){ return { bindPopup(){return this;}, addTo(){return this;} }; },
    divIcon(){ return {}; },
    layerGroup(){ return { addTo(){return this;} }; }
  };
  await wait(200);
  const doc = window.document;
  doc.querySelector('[data-tab="nearby"]').click();
  doc.getElementById('nearbyInput').value = 'Test Address';
  doc.getElementById('nearbyGoBtn').click();
  await wait(13000); // must exceed fetchNearbyPOIs's 12s per-mirror timeout
  const statusText = doc.getElementById('nearbyStatus').innerHTML;
  check('shows a specific "timed out" message', statusText.includes('timed out'));
  check('does NOT show the generic browser abort message', !statusText.includes('signal is aborted without reason'));
}

async function testMultiNeighborhoodCheckboxes(){
  console.log('\nFind Listings: multi-neighborhood checkbox dropdown');
  const window = newApp(() => async () => ({ ok:true, status:200, json: async () => [] }));
  await wait(200);
  const doc = window.document;
  doc.querySelector('[data-tab="listings"]').click();
  const btn = doc.getElementById('lsLocationBtn');
  const panel = doc.getElementById('lsLocationPanel');
  btn.click();
  const boxes = panel.querySelectorAll('input');
  boxes[0].checked = true;
  boxes[0].dispatchEvent(new window.Event('change', {bubbles:true}));
  boxes[1].checked = true;
  boxes[1].dispatchEvent(new window.Event('change', {bubbles:true}));
  check('button label reflects 2 selections', btn.textContent.includes('2 neighborhoods'));
  check('2 chips rendered', doc.querySelectorAll('#lsLocationChips .ls-location-chip').length === 2);
  doc.getElementById('lsClearBtn').click();
  check('Clear resets to zero selections', doc.querySelectorAll('#lsLocationPanel input:checked').length === 0);
}

async function testRetryButton(){
  console.log('\nCheck an Address: failed dataset section can be retried');
  let calls = 0;
  const window = newApp(() => async (url) => {
    const u = String(url);
    if(u.includes('wvxf-dwi5')){
      calls++;
      if(calls === 1) throw new TypeError('Failed to fetch');
      return { ok:true, status:200, json: async () => [{novissueddate:'2024-01-01', violationstatus:'Open', class:'B'}] };
    }
    return { ok:true, status:200, json: async () => [] };
  });
  await wait(200);
  const doc = window.document;
  doc.getElementById('houseNumber').value = '123';
  doc.getElementById('streetName').value = 'West 45 Street';
  doc.getElementById('borough').value = 'MANHATTAN';
  doc.getElementById('searchBtn').click();
  let sec;
  for(let i=0;i<50;i++){ await wait(100); sec = doc.getElementById('sec-violations'); if(sec && !sec.querySelector('.loading')) break; }
  const retryBtn = sec.querySelector('[data-retry-key="violations"]');
  check('retry button appears on failure', !!retryBtn);
  retryBtn?.click();
  for(let i=0;i<50;i++){ await wait(100); sec = doc.getElementById('sec-violations'); if(sec && !sec.querySelector('.loading')) break; }
  check('retry succeeds and renders the case-file view', sec.querySelector('.body').innerHTML.includes('case-file'));
}

(async () => {
  await testDobYearFilter();
  await testMultiNeighborhoodCheckboxes();
  await testRetryButton();
  await testNearbyAbortMessage(); // slowest (13s) — runs last

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('Smoke test crashed:', e); process.exit(1); });
