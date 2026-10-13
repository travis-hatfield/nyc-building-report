// Vercel serverless function: GET /api/scout
// Reads the "Saved apartments" tab of the Daily apartment scout Google Sheet
// (the scheduled run that searches StreetEasy writes there; rows you check
// "Save?" on are synced into this tab). The sheet must be shared as "Anyone
// with the link can view". Set SCOUT_SHEET_ID in Vercel to override the id.
const SHEET_ID = process.env.SCOUT_SHEET_ID || '19_xzTrwy8S4NC0fyKZz9uy_zmpPHm7jX815hVrBVMcM';
const TAB = process.env.SCOUT_SHEET_TAB || 'Saved apartments';

function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function fetchTab(tab) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const text = await r.text();
  if (!r.ok || /^\s*<(!doctype|html)/i.test(text)) return null;
  return parseCsv(text);
}

// Daily tabs are named like "Oct 4, 2026" (Pacific). Google serves the first
// sheet when a tab name doesn't exist, so a real daily tab is recognised by
// its "Save?" header column.
async function fetchLatestDaily() {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric' });
  for (let back = 0; back < 8; back++) {
    const name = fmt.format(new Date(Date.now() - back * 86400000));
    const rows = await fetchTab(name);
    if (rows && rows.some((r) => /^save\?$/i.test((r[0] || '').trim()))) return { rows, name };
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, s-maxage=60, max-age=30');
  try {
    const latest = req.query && req.query.tab === 'latest';
    let rows, tabName = null;
    if (latest) {
      const d = await fetchLatestDaily();
      if (!d) return res.status(200).json([]);
      rows = d.rows; tabName = d.name;
    } else {
      rows = await fetchTab(TAB);
    }
    if (!rows) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: 'Sheet not readable. Share it as "Anyone with the link can view".' });
    }
    const hi = rows.findIndex((r) => r.some((c) => /^neighborhood$/i.test(c.trim())));
    if (hi < 0) return res.status(200).json([]);
    const head = rows[hi].map((h) => h.trim().toLowerCase());
    const col = (re) => head.findIndex((h) => re.test(h));
    const ix = {
      hood: col(/^neighborhood/), addr: col(/^address/), unit: col(/^unit/), beds: col(/^beds/),
      price: col(/^monthly price|^price/), net: col(/^net effective/), sqft: col(/^sq ?ft/),
      wd: col(/w\/d/), dom: col(/days on market/), link: col(/streeteasy link|^link/),
      notes: col(/^notes/), found: col(/date found/), status: col(/^status/),
    };
    const get = (r, k) => (ix[k] >= 0 ? (r[ix[k]] || '').trim() : '');
    const num = (s) => { const n = Number(String(s).replace(/[^0-9.]/g, '')); return s && n ? n : null; };
    const out = rows.slice(hi + 1).filter((r) => get(r, 'addr')).map((r) => ({
      neighborhood: get(r, 'hood'), address: get(r, 'addr'), unit: get(r, 'unit').replace(/^'/, ''),
      beds: get(r, 'beds'), price: num(get(r, 'price')), netEffective: num(get(r, 'net')),
      sqft: num(get(r, 'sqft')), washerDryer: get(r, 'wd'), daysOnMarket: get(r, 'dom'),
      link: /^https:\/\/(www\.)?streeteasy\.com\//.test(get(r, 'link')) ? get(r, 'link') : null,
      notes: get(r, 'notes'), dateFound: get(r, 'found') || tabName || '', status: get(r, 'status'),
    }));
    res.status(200).json(out);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: e.message || 'Scout sheet unavailable' });
  }
};
