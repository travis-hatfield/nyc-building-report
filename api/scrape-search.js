// Vercel serverless function: GET /api/scrape-search?url=<encoded search-results URL>
//
// Best-effort scan of a rental search-results page. Pulls listings out of
// JSON-LD (ItemList / Apartment / Offer blocks) and falls back to scanning
// listing anchors, then flags any text that mentions rent stabilization.
// No headless browser and no bot-detection evasion: if a site blocks the
// request or renders results client-side, this returns a clear error.
//
// SECURITY: same SSRF guard as scrape-listing.js, hostnames come from a fixed
// allowlist, never an arbitrary caller-supplied host.
const ALLOWED_HOSTS = new Set([
  'streeteasy.com', 'www.streeteasy.com',
  'zillow.com', 'www.zillow.com',
  'apartments.com', 'www.apartments.com',
  'padmapper.com', 'www.padmapper.com',
  'renthop.com', 'www.renthop.com',
  'nakedapartments.com', 'www.nakedapartments.com'
]);

const FETCH_TIMEOUT_MS = 10000;
const MAX_HTML_BYTES = 2_000_000;
const MAX_LISTINGS = 40;
const STAB_RE = /rent[\s-]*(stabili[sz]ed|regulated|controlled)|\bDHCR\b|\bstabili[sz]ed\b|\bJ-?51\b|\b421-?a\b/i;

function decodeEntities(s){
  if(!s) return s;
  return String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function toArray(x){ return Array.isArray(x) ? x : (x ? [x] : []); }

// Walk any JSON-LD structure and collect objects that look like a listing.
function collectJsonLd(node, out, depth = 0){
  if(!node || typeof node !== 'object' || depth > 6) return;
  if(Array.isArray(node)){ node.forEach(n => collectJsonLd(n, out, depth + 1)); return; }
  const type = toArray(node['@type']).join(',');
  if(/Apartment|Residence|House|Accommodation|RealEstateListing|SingleFamily|Product/i.test(type) && (node.address || node.name)){
    out.push(node);
  }
  if(node.itemListElement) collectJsonLd(node.itemListElement, out, depth + 1);
  if(node.item) collectJsonLd(node.item, out, depth + 1);
  if(node['@graph']) collectJsonLd(node['@graph'], out, depth + 1);
  if(node.mainEntity) collectJsonLd(node.mainEntity, out, depth + 1);
}

function addressString(a){
  if(!a) return null;
  if(typeof a === 'string') return a;
  return [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].filter(Boolean).join(', ') || null;
}

function fromJsonLd(html, base){
  const out = [];
  for(const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    try{ collectJsonLd(JSON.parse(m[1]), out); }catch(e){ /* skip bad block */ }
  }
  return out.map(n => {
    const offer = toArray(n.offers)[0] || {};
    const price = offer.price || (offer.priceSpecification && offer.priceSpecification.price) || n.price || null;
    let url = n.url || offer.url || null;
    try{ if(url) url = new URL(url, base).toString(); }catch(e){ url = null; }
    const text = [n.name, n.description].filter(Boolean).join(' ');
    return {
      title: decodeEntities(n.name) || null,
      url,
      price: price ? `$${Number(String(price).replace(/[^0-9.]/g, '')).toLocaleString('en-US')}` : null,
      address: addressString(n.address),
      beds: n.numberOfBedrooms != null ? Number(n.numberOfBedrooms) : (n.numberOfRooms != null ? Number(n.numberOfRooms) : null),
      description: decodeEntities(n.description) || null,
      stabilizedMention: STAB_RE.test(text)
    };
  });
}

// Fallback: anchors that look like listing detail pages, with nearby price text.
function fromAnchors(html, base){
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]{0,600}?)<\/a>/gi;
  let m;
  while((m = re.exec(html)) && out.length < MAX_LISTINGS){
    let href;
    try{ href = new URL(decodeEntities(m[1]), base); }catch(e){ continue; }
    if(!/\/(building|rental|rentals|listing|listings|apartment|apartments|unit|b|p)\//i.test(href.pathname)) continue;
    if(href.pathname.length < 12) continue;
    const key = href.origin + href.pathname;
    if(seen.has(key)) continue;
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const price = (text.match(/\$\s?[\d,]{3,}/) || [])[0];
    if(!price) continue;
    seen.add(key);
    out.push({
      title: text.slice(0, 140) || null,
      url: key,
      price: price.replace(/\s/g, ''),
      address: null,
      beds: null,
      description: null,
      stabilizedMention: STAB_RE.test(text)
    });
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=900');

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
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    clearTimeout(timer);
    if(!upstream.ok){
      res.status(502).json({error: `The site returned ${upstream.status}. It is probably blocking automated requests.`});
      return;
    }
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
    res.status(504).json({error: e.name === 'AbortError' ? 'The site took too long to respond.' : 'Could not reach the site.'});
    return;
  }

  let listings = fromJsonLd(html, target);
  if(!listings.length) listings = fromAnchors(html, target);
  // De-duplicate by URL (or title+price when there is no URL).
  const seen = new Set();
  listings = listings.filter(l => {
    const k = l.url || `${l.title}|${l.price}`;
    if(seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, MAX_LISTINGS);

  if(!listings.length){
    res.status(200).json({
      ok: false,
      error: 'No listings could be extracted. This site likely renders results in the browser or is blocking automated requests.',
      source: target.hostname
    });
    return;
  }
  res.status(200).json({ok: true, source: target.hostname, count: listings.length, listings, fetchedAt: new Date().toISOString()});
};
