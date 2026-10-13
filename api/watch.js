// Vercel serverless function: GET /api/watch   (header "x-watch-secret" or ?key= must equal WATCH_SECRET)
// Checks the due agent/landlord pages, fingerprints them, and asks the AI to read only pages
// that really changed. Results are stored in Upstash Redis and served by /api/affordable-feed.
// Call it every 30 minutes (see .github/workflows/watch.yml).
const SOURCES = require('./_lib/sources.json');
const { htmlToDoc, digest, forLlm, isBotWall } = require('./_lib/html');
const { extractListings, RateLimited } = require('./_lib/extract');
const store = require('./_lib/store');

const UA = 'nyc-building-report-watcher/1.0 (personal apartment search; checks each page at most every 30 min)';
const MAX_PER_RUN = 10;
const DEFAULT_EVERY_MIN = 25;
const LISTING_HINT = /re-?rental|vacan|now leasing|accepting applications|first[- ]come|\bAMI\b|\$\d,?\d{3}/i;

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const key = (s) => `aff:src:${slug(s.name)}`;

function nyHour() {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date())) % 24;
}

// Minimal robots.txt check (User-agent: * Disallow prefixes), cached per run.
const robotsCache = new Map();
async function allowed(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    let rules = [];
    try {
      const r = await fetch(u.origin + '/robots.txt', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        let applies = false;
        for (const raw of (await r.text()).split('\n')) {
          const line = raw.split('#')[0].trim(); const i = line.indexOf(':'); if (i < 0) continue;
          const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
          if (k === 'user-agent') applies = v === '*';
          else if (applies && k === 'disallow' && v) rules.push(v);
        }
      }
    } catch (e) { /* no robots.txt reachable: allowed */ }
    robotsCache.set(u.origin, rules);
  }
  return !robotsCache.get(u.origin).some((p) => (u.pathname + u.search).startsWith(p.replace(/\*$/, '')));
}

async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return { text: await r.text(), url: r.url };
}

function isDue(src, state, now) {
  if (!state || !state.checkedAt) return true;
  const every = (src.everyMinutes || DEFAULT_EVERY_MIN) * 60000;
  const backoff = state.fails ? Math.min(2 ** state.fails * 30, 480) * 60000 : 0;
  return now - state.checkedAt >= Math.max(every, backoff);
}

async function checkPage(src, state) {
  const next = Object.assign({ name: src.name, url: src.url, listings: [], fails: 0 }, state, { checkedAt: Date.now() });
  try {
    if (!(await allowed(src.url))) throw new Error('disallowed by robots.txt');
    const page = await getText(src.url);
    const doc = htmlToDoc(page.text, page.url);
    if (isBotWall(doc)) throw new Error('bot check instead of the page');
    const d = digest(doc);
    if (state && state.digest === d) { next.fails = 0; next.error = null; return next; }
    if (doc.text.length < 80) throw new Error('page has almost no text (likely needs JavaScript)');
    next.listings = (await extractListings(src.name, page.url, forLlm(doc))).map((l) => ({ ...l, source: src.name, sourceUrl: src.url }));
    next.digest = d; next.fails = 0; next.error = null; next.okAt = Date.now();
  } catch (e) {
    // Rate limits are not the page's fault: retry next run without backoff.
    next.fails = e instanceof RateLimited ? (state && state.fails) || 0 : ((state && state.fails) || 0) + 1;
    next.error = e.message;
  }
  return next;
}

async function checkRss(src, state) {
  const next = Object.assign({ name: src.name, url: src.url, listings: [], seen: [], fails: 0 }, state, { checkedAt: Date.now() });
  try {
    const feed = (await getText(src.url)).text;
    const hint = src.match ? new RegExp(src.match, 'i') : LISTING_HINT;
    const seen = new Set(next.seen);
    const fresh = [];
    for (const m of feed.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const e = m[1];
      const id = (/<id>([^<]+)<\/id>/.exec(e) || [])[1];
      if (!id || seen.has(id)) continue;
      const title = (/<title[^>]*>([\s\S]*?)<\/title>/.exec(e) || [])[1] || '';
      const link = (/<link[^>]*href="([^"]+)"/.exec(e) || [])[1] || src.url;
      const body = (/<content[^>]*>([\s\S]*?)<\/content>/.exec(e) || [])[1] || '';
      const text = (title + '\n' + body).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      fresh.push({ id, link, text });
    }
    let done = 0;
    for (const p of fresh.slice(0, 5)) { // a few posts per run keeps AI use small
      if (hint.test(p.text)) {
        const found = await extractListings(src.name, p.link, p.text.slice(0, 8000));
        next.listings.push(...found.filter((l) => l.status !== 'closed' && l.type !== 'market_rate')
          .map((l) => ({ ...l, source: src.name, sourceUrl: p.link, url: l.url || p.link })));
      }
      seen.add(p.id); done++;
    }
    next.listings = next.listings.slice(-40);
    next.seen = [...seen].slice(-300); next.fails = 0; next.error = null; next.okAt = Date.now();
    next.pending = fresh.length - done;
  } catch (e) {
    next.fails = e instanceof RateLimited ? (state && state.fails) || 0 : ((state && state.fails) || 0) + 1;
    next.error = e.message;
  }
  return next;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.WATCH_SECRET;
  const given = req.headers['x-watch-secret'] || (req.query && req.query.key);
  if (!secret || given !== secret) return res.status(401).json({ error: 'unauthorized' });
  if (!store.configured()) return res.status(500).json({ error: 'Upstash Redis is not configured' });
  if (nyHour() < 7 && !(req.query && req.query.force)) return res.status(200).json({ skipped: 'quiet hours (midnight to 7am ET)' });

  const states = await store.mgetJson(SOURCES.map(key));
  const now = Date.now();
  const due = SOURCES.map((s, i) => ({ s, st: states[i] })).filter((x) => isDue(x.s, x.st, now))
    .sort((a, b) => ((a.st && a.st.checkedAt) || 0) - ((b.st && b.st.checkedAt) || 0)).slice(0, MAX_PER_RUN);

  const results = [];
  for (let i = 0; i < due.length; i += 5) { // 5 at a time, different hosts
    const batch = await Promise.all(due.slice(i, i + 5).map(async ({ s, st }) => {
      const next = s.kind === 'rss' ? await checkRss(s, st) : await checkPage(s, st);
      await store.setJson(key(s), next);
      return { name: s.name, ok: !next.error, error: next.error || undefined, listings: next.listings.length };
    }));
    results.push(...batch);
  }
  res.status(200).json({ checked: results.length, dueRemaining: SOURCES.length - results.length, results });
};
