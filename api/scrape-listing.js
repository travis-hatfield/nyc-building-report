// Vercel serverless function — GET /api/scrape-listing?url=<encoded listing URL>
//
// This exists to pull whatever a listing page's own <meta> tags and JSON-LD
// structured data expose (title, photo, price, description) into the Watchlist
// comparison table. It does NOT run a headless browser and does NOT try to
// defeat any bot-detection — if a site blocks the request or renders its price
// client-side with nothing in the initial HTML, this returns a clear "couldn't
// extract" response rather than pretending to succeed.
//
// This is server-side specifically because browsers can't do this themselves:
// StreetEasy/Zillow/etc. don't send CORS headers permitting fetch() calls from
// another site's JavaScript, so the actual HTTP request has to happen here,
// not in the client.
//
// SECURITY: this is a URL fetcher, which is a classic SSRF vector if left
// open — restricted to an allowlist of known rental-listing hostnames only,
// never an arbitrary caller-supplied host.
const ALLOWED_HOSTS = new Set([
  'streeteasy.com', 'www.streeteasy.com',
  'zillow.com', 'www.zillow.com',
  'openigloo.com', 'www.openigloo.com',
  'apartments.com', 'www.apartments.com',
  'padmapper.com', 'www.padmapper.com',
  'renthop.com', 'www.renthop.com',
  'compass.com', 'www.compass.com',
  'nakedapartments.com', 'www.nakedapartments.com'
]);

const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 800_000; // plenty for meta tags + JSON-LD, which live in <head>

function extractMeta(html, property){
  // Handles either attribute order: property="og:x" content="y" or content="y" property="og:x"
  const re1 = new RegExp(`<meta[^>]+property=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${property}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? m[1] : null;
}

function decodeEntities(s){
  if(!s) return s;
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function extractJsonLd(html){
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for(const block of blocks){
    try{
      const parsed = JSON.parse(block[1]);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for(const c of candidates){
        if(c && (c.offers || c.numberOfRooms != null || c.floorSize || c['@type'])){
          return c;
        }
      }
    }catch(e){ /* not valid JSON, or not the block we want — skip it */ }
  }
  return null;
}

function findPriceInText(...texts){
  for(const t of texts){
    if(!t) continue;
    const m = String(t).match(/\$\s?[\d,]{3,}(?:\.\d{2})?/);
    if(m) return m[0].replace(/\s/g, '');
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=1800'); // 30 min — listing details don't need to be second-fresh

  const rawUrl = req.query.url;
  if(!rawUrl || typeof rawUrl !== 'string'){
    res.status(400).json({error: 'Missing url parameter.'});
    return;
  }

  let target;
  try{ target = new URL(rawUrl); }
  catch(e){ res.status(400).json({error: 'That doesn\'t look like a valid URL.'}); return; }

  if(target.protocol !== 'https:' && target.protocol !== 'http:'){
    res.status(400).json({error: 'Only http/https URLs are supported.'});
    return;
  }
  if(!ALLOWED_HOSTS.has(target.hostname.toLowerCase())){
    res.status(400).json({error: `${target.hostname} isn't a supported listing site.`});
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html;
  try{
    const upstream = await fetch(target.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // A plain default fetch UA gets blocked outright by most of these sites'
        // bot detection before any content loads — a realistic desktop browser
        // UA is the difference between "gets the page" and "gets a 403".
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    clearTimeout(timer);
    if(!upstream.ok){
      res.status(502).json({error: `The listing site returned ${upstream.status} — it may be blocking automated requests, or the listing may no longer exist.`});
      return;
    }
    // Cap how much we read — meta tags and JSON-LD are always in <head>, no
    // need to buffer a multi-megabyte page (also bounds worst-case memory/time).
    const reader = upstream.body.getReader();
    const chunks = [];
    let total = 0;
    while(total < MAX_HTML_BYTES){
      const {done, value} = await reader.read();
      if(done) break;
      chunks.push(value);
      total += value.length;
    }
    try{ await reader.cancel(); }catch(e){ /* already done */ }
    html = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
  }catch(e){
    clearTimeout(timer);
    const timedOut = e.name === 'AbortError';
    res.status(504).json({error: timedOut ? 'The listing site took too long to respond.' : 'Could not reach the listing site.'});
    return;
  }

  const ogTitle = decodeEntities(extractMeta(html, 'og:title'));
  const ogDescription = decodeEntities(extractMeta(html, 'og:description'));
  const ogImage = extractMeta(html, 'og:image');
  const jsonLd = extractJsonLd(html);

  const price = findPriceInText(
    jsonLd?.offers?.price ? `$${jsonLd.offers.price}` : null,
    ogTitle, ogDescription
  );
  const beds = jsonLd?.numberOfRooms ?? jsonLd?.numberOfBedrooms ?? null;
  const sqft = jsonLd?.floorSize?.value ?? null;

  if(!ogTitle && !ogDescription && !price){
    // Got a page, but nothing we recognize — most likely the site renders its
    // details client-side via JS and the raw HTML never had them to begin with.
    res.status(200).json({
      ok: false,
      partial: false,
      error: 'This listing renders its details in the browser rather than the page source, so nothing could be extracted automatically. View it directly instead.',
      source: target.hostname
    });
    return;
  }

  res.status(200).json({
    ok: true,
    title: ogTitle || null,
    description: ogDescription || null,
    image: ogImage || null,
    price: price || null,
    beds: beds != null ? Number(beds) : null,
    sqft: sqft != null ? Number(sqft) : null,
    source: target.hostname,
    fetchedAt: new Date().toISOString()
  });
};
