// Vercel serverless function: GET /api/hdc
// NYC HDC income-restricted re-rentals. HDC sends no CORS headers, so the
// browser can't call it directly; this runs server-side and is cached.
const API = 'https://www.nychdc.com/api/re-rentals';
const BASE = 'https://www.nychdc.com/';
const BOROUGH = { 'Manhattan': 'manhattan', 'Brooklyn': 'brooklyn', 'Queens': 'queens', 'The Bronx': 'bronx', 'Staten Island': 'staten island' };

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, s-maxage=1800, max-age=600');
  try {
    const cards = [];
    let page = 1, offset = 0;
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${API}?current-page=${page}&offset=${offset}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HDC answered ${r.status}`);
      const data = await r.json();
      cards.push(...(data.json || []));
      const pg = data.pagination || {};
      if (!(data.json || []).length || pg['current-page'] >= pg['page-count']) break;
      page += 1;
      offset += pg['per-page'] || (data.json || []).length;
    }
    const abs = (u) => { try { return new URL(u, BASE).href; } catch (e) { return null; } };
    res.status(200).json(cards.map((c) => ({
      id: c.nid,
      building: (c.title || '').trim(),
      address: c.address || null,
      borough: BOROUGH[c.borough] || (c.borough || 'unknown').toLowerCase(),
      bedrooms: c.bedrooms_copy || null,
      rentRange: c.rent_range || null,
      accessible: c.adaptation_copy || null,
      seniors: Boolean(c.age_restriction_copy),
      ad: (c.pdf || c.cta) ? abs(c.pdf || c.cta) : null,
      details: (c.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null,
    })));
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: e.message || 'HDC unavailable' });
  }
};
