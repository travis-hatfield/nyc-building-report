// Vercel serverless function: GET /api/affordable-feed
// Merges what /api/watch has stored: listings from watched agent pages and Reddit,
// de-duplicated by normalized address + unit size + AMI band.
const SOURCES = require('./_lib/sources.json');
const { normAddress } = require('./_lib/norm');
const store = require('./_lib/store');

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, s-maxage=300, max-age=120');
  if (!store.configured()) return res.status(200).json({ configured: false, listings: [], sources: [] });
  try {
    const states = await store.mgetJson(SOURCES.map((s) => `aff:src:${slug(s.name)}`));
    const byKey = new Map();
    const sources = [];
    states.forEach((st, i) => {
      if (!st) { sources.push({ name: SOURCES[i].name, checked: null }); return; }
      sources.push({ name: st.name, checked: st.checkedAt, ok: !st.error, error: st.error || null });
      for (const l of st.listings || []) {
        if (l.status === 'closed' || l.type === 'market_rate') continue;
        const k = [normAddress(l.address || l.building), l.unit || '', l.unitSize, l.ami || ''].join('|');
        if (!byKey.has(k)) byKey.set(k, l);
      }
    });
    res.status(200).json({ configured: true, listings: [...byKey.values()], sources });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: e.message });
  }
};
