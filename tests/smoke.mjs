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

async function testGlobalYearFilter(){
  console.log('\nCheck an Address: global year filter cascades to every section at once');
  const hpdComplaints = [
    {major_category:'PLUMBING', received_date:'2022-01-01', complaint_status:'CLOSE'},
    {major_category:'HEAT/HOT WATER', received_date:'2012-01-01', complaint_status:'CLOSE'},
  ];
  const threeOneOne = [
    {unique_key:'1', created_date:'2024-06-01', complaint_type:'Noise', status:'Closed'},
    {unique_key:'2', created_date:'2016-06-01', complaint_type:'Noise', status:'Closed'},
  ];
  const window = newApp(() => async (url) => {
    const u = String(url);
    if(u.includes('ygpa-z7cr')) return { ok:true, status:200, json: async () => hpdComplaints };
    if(u.includes('erm2-nwe9')) return { ok:true, status:200, json: async () => threeOneOne };
    return { ok:true, status:200, json: async () => [] };
  });
  await wait(200);
  const doc = window.document;
  doc.getElementById('houseNumber').value = '123';
  doc.getElementById('streetName').value = 'West 45 Street';
  doc.getElementById('borough').value = 'MANHATTAN';
  doc.getElementById('searchBtn').click();
  for(let i=0;i<50;i++){ await wait(100); if(!doc.getElementById('sec-permits')?.querySelector('.loading')) break; }
  await wait(100);

  const dataRows = id => (doc.getElementById(id).innerHTML.match(/<tr[ >]/g) || []).length - 1; // minus the header row
  check('both sections start showing all their rows', dataRows('hpdComplaintsDynamic') === 2 && dataRows('threeOneOneDynamic') === 2);

  const globalSel = doc.getElementById('globalYearFilter');
  globalSel.value = '2020';
  globalSel.dispatchEvent(new window.Event('change', {bubbles:true}));
  await wait(100);
  check('setting the global filter to 2020 drops HPD Complaints to just the 2022 row', dataRows('hpdComplaintsDynamic') === 1);
  check('...and drops 311 Requests to just the 2024 row, in the same action', dataRows('threeOneOneDynamic') === 1);
  check("311's own per-section select reflects the applied year", doc.getElementById('threeOneOneYearFilter').value === '2020');

  globalSel.value = '';
  globalSel.dispatchEvent(new window.Event('change', {bubbles:true}));
  await wait(100);
  check('resetting to "full history" brings every row back in both sections', dataRows('hpdComplaintsDynamic') === 2 && dataRows('threeOneOneDynamic') === 2);
}

async function testNearbyOverpassRetrySucceeds(){
  console.log('\nWhat\'s Nearby: a fully-failed first round of mirrors gets retried once before erroring');
  // Real public Overpass mirrors were observed to be transiently flaky (verified
  // live via curl — different mirrors failed vs. succeeded on runs seconds
  // apart), so a genuine "all 5 mirrors failed" moment doesn't necessarily mean
  // the data is unreachable — it's worth one full retry before giving up.
  let overpassCalls = 0;
  const window = newApp(() => async (url) => {
    const u = String(url);
    if(u.includes('nominatim')) return { ok:true, status:200, json: async () => ([{lat:'40.7484', lon:'-73.9857', display_name:'Test Address, Manhattan, NY'}]) };
    if(u.includes('overpass')){
      overpassCalls++;
      if(overpassCalls <= 5) return Promise.reject(new TypeError('Failed to fetch')); // whole first round fails
      return { ok:true, status:200, json: async () => ({elements: []}) }; // second round succeeds
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
  await wait(500);
  check('all 5 mirrors were hit twice (one retry round)', overpassCalls === 10);
  const statusText = doc.getElementById('nearbyStatus').innerHTML;
  check('search still succeeds after the retry', statusText.includes('Centered on') && !statusText.includes('err'));
}

async function testWatchlistListingScraper(){
  console.log('\nWatchlist: listing-link scraper add/success/remove flow');
  const window = newApp(() => async (url) => {
    const u = String(url);
    if(u.includes('wvxf-dwi5')) return { ok:true, status:200, json: async () => [{novissueddate:'2024-01-01', violationstatus:'Open', class:'B'}] };
    if(u.includes('/api/scrape-listing')){
      return { ok:true, status:200, json: async () => ({
        ok:true, title:'Cute 1BR', image:'https://example.com/img.jpg', price:'$2,800', beds:1, sqft:600, source:'openigloo.com', fetchedAt:new Date().toISOString()
      })};
    }
    return { ok:true, status:200, json: async () => [] };
  });
  window.prompt = () => 'https://www.openigloo.com/listing/abc123';
  await wait(200);
  const doc = window.document;
  doc.getElementById('houseNumber').value = '123';
  doc.getElementById('streetName').value = 'West 45 Street';
  doc.getElementById('borough').value = 'MANHATTAN';
  doc.getElementById('searchBtn').click();
  for(let i=0;i<50;i++){ await wait(100); if(!doc.getElementById('sec-permits')?.querySelector('.loading')) break; }
  await wait(100);
  doc.getElementById('saveWatchlistBtn').click();
  doc.querySelector('[data-tab="watchlist"]').click();
  await wait(100);

  const addBtn = doc.querySelector('.add-listing-btn');
  check('"+ Add link" button shows for a watchlist item with no listing yet', !!addBtn);
  addBtn.click(); // triggers mocked window.prompt -> setWatchlistListingUrl -> fetchListingDetails
  await wait(200);
  check('a successful scrape renders a listing card', !!doc.querySelector('.cmp-listing-card'));
  check('extracted price/beds/sqft show in the card', doc.querySelector('.cmp-listing-price')?.textContent.includes('$2,800'));
  check('extracted image renders', doc.querySelector('.cmp-listing-card img')?.src === 'https://example.com/img.jpg');
  check('Monthly Rent auto-fills from the extracted price ($2,800 -> 2800)', doc.querySelector('.cmp-rent')?.value === '2800');

  doc.querySelector('.remove-listing-btn').click();
  await wait(100);
  check('removing the listing link reverts to the "+ Add link" state', !!doc.querySelector('.add-listing-btn') && !doc.querySelector('.cmp-listing-card'));

  // A rent the user already typed in on purpose (e.g. a negotiated figure)
  // must never get silently overwritten by a later scrape.
  const rentInput = doc.querySelector('.cmp-rent');
  rentInput.value = '3500';
  rentInput.dispatchEvent(new window.Event('change', {bubbles:true}));
  await wait(50);
  doc.querySelector('.add-listing-btn').click();
  await wait(200);
  check('an already-typed rent is NOT overwritten by a scraped price', doc.querySelector('.cmp-rent')?.value === '3500');
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
  await wait(41000); // must exceed BOTH retry rounds (20s timeout x 2, since fetchNearbyPOIs retries once)
  const statusText = doc.getElementById('nearbyStatus').innerHTML;
  check('shows a specific "timed out" message', statusText.includes('timed out'));
  check('does NOT show the generic browser abort message', !statusText.includes('signal is aborted without reason'));
}

async function testNearbyFetchesOnlySelectedCategories(){
  console.log('\nWhat\'s Nearby: initial search fetches only checked categories, toggle fetches on demand');
  const overpassQueries = [];
  const window = newApp(() => async (url, opts) => {
    const u = String(url);
    if(u.includes('nominatim')) return { ok:true, status:200, json: async () => ([{lat:'40.7484', lon:'-73.9857', display_name:'Test Address, Manhattan, NY'}]) };
    if(u.includes('overpass')){
      overpassQueries.push(opts.body);
      return { ok:true, status:200, json: async () => ({elements: []}) };
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
  await wait(500);
  // Each logical "fetch this category" call races all 4 Overpass mirrors in
  // parallel (first to answer wins) — so one fetch = 4 queries, all carrying
  // the same body. That's expected; what matters is the body content and how
  // many *distinct* fetch calls happened (queries.length / MIRROR_COUNT).
  const MIRROR_COUNT = 5;
  check(`initial search fires exactly one round of mirror queries (${MIRROR_COUNT} requests)`, overpassQueries.length === MIRROR_COUNT);
  check('initial query excludes an unchecked category (parks)', !overpassQueries[0]?.includes('leisure'));
  check('initial query includes a checked category (cafe)', overpassQueries[0]?.includes('amenity') && overpassQueries[0]?.includes('cafe'));

  const parksToggle = doc.querySelector('.nearby-toggle input[data-cat="parks"]');
  parksToggle.checked = true;
  parksToggle.dispatchEvent(new window.Event('change', {bubbles:true}));
  await wait(500);
  check(`toggling on Parks fires exactly one more round (${MIRROR_COUNT * 2} requests total)`, overpassQueries.length === MIRROR_COUNT * 2);
  const parksQuery = overpassQueries[MIRROR_COUNT];
  check('that follow-up round only asks for parks, not everything again', parksQuery?.includes('leisure') && !parksQuery?.includes('shop'));

  // Toggling it back on again later shouldn't refetch — already cached.
  parksToggle.checked = false;
  parksToggle.dispatchEvent(new window.Event('change', {bubbles:true}));
  parksToggle.checked = true;
  parksToggle.dispatchEvent(new window.Event('change', {bubbles:true}));
  await wait(500);
  check('re-toggling an already-fetched category does not refetch', overpassQueries.length === MIRROR_COUNT * 2);
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
  await testGlobalYearFilter();
  await testMultiNeighborhoodCheckboxes();
  await testRetryButton();
  await testWatchlistListingScraper();
  await testNearbyFetchesOnlySelectedCategories();
  await testNearbyOverpassRetrySucceeds();
  await testNearbyAbortMessage(); // slowest (~41s) — runs last

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('Smoke test crashed:', e); process.exit(1); });
