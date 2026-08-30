// Vercel serverless function — POST /api/overpass
// Body: {query: "<overpass QL string>"}
//
// This exists because Overpass's public mirrors are inconsistent about CORS —
// they respond with Access-Control-Allow-Origin on a curl OPTIONS preflight
// but strip the header on the actual POST response often enough that most
// browser searches from a production domain silently fail with "Failed to
// fetch". The client used to race the mirrors directly; when all of them
// returned CORS-blocked responses in a row, users saw an empty map with
// "Nothing found within this radius" — even for Midtown Manhattan addresses
// where hundreds of POIs genuinely exist within a few blocks.
//
// Doing the request server-to-server sidesteps that entirely (no browser CORS
// gate) and lets us also:
//   - Apply the same first-non-empty-answer-wins race we did client-side
//   - Cache popular queries at Vercel's edge for a short TTL (bbox+category
//     combos repeat across users of the same neighborhood)
//   - Return one honest error when every mirror really is down, instead of a
//     cryptic "Failed to fetch" from the browser
//
// SECURITY: this proxies an arbitrary Overpass QL query supplied by the caller,
// but the target host is fixed (never taken from the request) — so it's not an
// SSRF vector the way a "give me the URL to fetch" endpoint would be. The query
// itself is Overpass QL, which is a read-only language (no way for a query to
// mutate anything or reach outside the OSM dataset), so accepting arbitrary
// queries here is safe.

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter'
];

const MIRROR_TIMEOUT_MS = 20000; // matches the client-side timeout
const MAX_QUERY_BYTES = 8000; // Overpass queries this big should be rare — protects against abuse

// Race every mirror at once, first non-empty response wins immediately. If all
// mirrors return an empty result, resolve with the empty set (real "nothing
// found" is a valid answer, just held back until we're confident it's not a
// bad mirror). If every mirror fails, throw the last error.
function raceMirrors(query){
  return new Promise((resolve, reject) => {
    let pending = OVERPASS_MIRRORS.length;
    let settled = false;
    let fallback = null;
    let lastError = null;
    const controllers = [];
    const done = () => {
      if(pending > 0 || settled) return;
      settled = true;
      if(fallback !== null) resolve(fallback);
      else reject(lastError || new Error('All Overpass mirrors failed.'));
    };
    OVERPASS_MIRRORS.forEach(url => {
      const host = url.match(/\/\/([^/]+)/)[1];
      const controller = new AbortController();
      controllers.push(controller);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, MIRROR_TIMEOUT_MS);
      fetch(url, {
        method: 'POST',
        // A descriptive User-Agent is polite (Overpass admins can see who's
        // hitting them and reach out if there's an issue), and some mirrors
        // 406 requests that arrive without one — a common issue for the
        // default Node/undici fetch on Vercel serverless. Setting Accept
        // explicitly avoids the "not acceptable" refusal too.
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json, */*;q=0.5',
          'User-Agent': 'nyc-building-report/1.0 (https://nyc-building-report.vercel.app)'
        },
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal
      }).then(res => {
        clearTimeout(timer);
        if(!res.ok) throw new Error(`Overpass mirror ${host} returned ${res.status}`);
        return res.json();
      }).then(data => {
        if(settled) return;
        pending--;
        const elements = (data && data.elements) || [];
        if(elements.length > 0){
          settled = true;
          controllers.forEach(c => c.abort()); // stop the losers
          resolve(elements);
        } else {
          if(fallback === null) fallback = elements;
          done();
        }
      }).catch(e => {
        clearTimeout(timer);
        if(settled) return;
        pending--;
        lastError = timedOut ? new Error(`Overpass mirror ${host} timed out`) : e;
        done();
      });
    });
  });
}

module.exports = async (req, res) => {
  // Same-origin browsers don't need this, but keeping it explicit means the
  // response is uniform whether it's hit from the app or a debug curl.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS'){ res.status(204).end(); return; }
  if(req.method !== 'POST'){
    res.status(405).json({error: 'POST only'});
    return;
  }

  let body = req.body;
  // Vercel usually parses application/json for us, but be defensive — some
  // paths deliver a raw string when the client sends a non-standard content-type.
  if(typeof body === 'string'){
    try{ body = JSON.parse(body); } catch(_){ body = {}; }
  }
  const query = body && body.query;
  if(!query || typeof query !== 'string'){
    res.status(400).json({error: 'Missing query in body.'});
    return;
  }
  if(query.length > MAX_QUERY_BYTES){
    res.status(413).json({error: 'Query too large.'});
    return;
  }

  // Same-day cache — Overpass data updates every few minutes but the POIs we
  // ask for (subway stations, permanent businesses, parks) essentially never
  // change day to day. Short TTL keeps popular neighborhood queries snappy for
  // return visitors without ever serving days-stale data.
  res.setHeader('Cache-Control', 'public, s-maxage=1800, max-age=600');

  try{
    let elements;
    try{
      elements = await raceMirrors(query);
    }catch(firstErr){
      // One full retry — a mirror that's down right now often comes back a
      // second or two later, and every mirror being briefly unhappy at once is
      // rare enough that a single retry catches most of them.
      try{
        elements = await raceMirrors(query);
      }catch(secondErr){
        res.status(502).json({error: 'All Overpass mirrors failed', detail: String(secondErr && secondErr.message || secondErr)});
        return;
      }
    }
    res.status(200).json({elements});
  }catch(e){
    res.status(500).json({error: 'Unexpected error', detail: String(e && e.message || e)});
  }
};
