// Run: node tests/watch.test.mjs   (no dependencies; mocks fetch and Redis)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { htmlToDoc, digest, isBotWall } = require('../api/_lib/html.js');
const { normAddress } = require('../api/_lib/norm.js');
const { clean } = require('../api/_lib/extract.js');

assert.equal(normAddress('East 28th Street, Apt 4B'), normAddress('E 28 St'));
const a = htmlToDoc('<nav>x</nav><div class="cookie-banner">accept</div><p>Studio $2,100</p><p>1BR $2,400</p><a href="/ad.pdf">Ad</a><script>1</script>', 'https://x.com/p');
const b = htmlToDoc('<p>1BR $2,400</p><p>Studio $2,100</p><a href="/ad.pdf">Ad</a>', 'https://x.com/p');
assert.ok(!a.text.includes('accept') && !a.text.includes('x\n'));
assert.equal(a.links[0][1], 'https://x.com/ad.pdf');
assert.equal(digest(a), digest(b), 'reordered cards must not change the fingerprint');
assert.ok(isBotWall(htmlToDoc('<p>Just a moment...</p>', 'https://x.com')));
const l = clean({ building: 'A', unit_size: 'studio', rent_monthly: '$2,100', ami_percent: 100, income_limits: [{ household_size: null, min_income: 70000, max_income: 120000 }], status: 'bogus', detail_url: 'javascript:x' });
assert.equal(l.rent, 2100); assert.equal(l.status, 'unknown'); assert.equal(l.url, null);

// end to end: unchanged page is not re-read by the AI
const mem = new Map(); let ai = 0;
process.env.WATCH_SECRET = 's'; process.env.UPSTASH_REDIS_REST_URL = 'http://r'; process.env.UPSTASH_REDIS_REST_TOKEN = 't'; process.env.AI_API_KEY = 'k';
globalThis.fetch = async (u, o) => {
  u = String(u);
  if (u === 'http://r') {
    const c = JSON.parse(o.body);
    if (c[0] === 'GET') return { ok: true, json: async () => ({ result: mem.get(c[1]) ?? null }) };
    if (c[0] === 'MGET') return { ok: true, json: async () => ({ result: c.slice(1).map((k) => mem.get(k) ?? null) }) };
    mem.set(c[1], c[2]); return { ok: true, json: async () => ({ result: 'OK' }) };
  }
  if (u.endsWith('/robots.txt')) return { ok: false };
  if (u.includes('groq')) { ai++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ listings: [{ building: 'X', address: '1 E 28th St', unit_size: 'studio', rent_monthly: 2000, ami_percent: 80, status: 'available', listing_type: 're_rental' }] }) } }] }) }; }
  return { ok: true, status: 200, url: u, text: async () => '<p>' + 'Studio apartment available at 80% AMI. '.repeat(5) + '</p>' };
};
const watch = require('../api/watch.js');
const run = async () => { let out; await watch({ headers: { 'x-watch-secret': 's' }, query: { force: '1' } }, { setHeader() {}, status() { return this; }, json(j) { out = j; } }); return out; };
const r1 = await run();
assert.ok(r1.checked > 0 && ai > 0);
const first = ai;
for (const k of mem.keys()) { const v = JSON.parse(mem.get(k)); v.checkedAt = 0; mem.set(k, JSON.stringify(v)); }
await run();
assert.equal(ai, first, 'unchanged pages must not trigger new AI calls');
const feed = require('../api/affordable-feed.js'); let f;
await feed({}, { setHeader() {}, status() { return this; }, json(j) { f = j; } });
assert.equal(f.listings.length, 1, 'same address from many sources is de-duplicated');
console.log('watch tests passed');
