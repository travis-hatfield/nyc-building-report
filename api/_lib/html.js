// Dependency-free HTML -> { text, links } for page fingerprinting and AI reading.
const crypto = require('crypto');

const CONSENT = /cookie|consent|gdpr|onetrust|ketch|cybot|osano|truste|termly|iubenda|didomi/i;
const BOT_WALL = /just a moment|verify(ing)? you are (a )?human|are you a robot|attention required|access denied|enable javascript and cookies|checking your browser|complete the security check|request blocked|unusual traffic/i;
const BOT_WALL_MAX_CHARS = 1500;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (ENT[e.toLowerCase()] !== undefined) return ENT[e.toLowerCase()];
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n ? String.fromCodePoint(n) : ''; }
  return m;
});

// Cloudflare scrambles emails with a fresh key on every load; undo it so the fingerprint is stable.
function cfEmail(hex) {
  try {
    const key = parseInt(hex.slice(0, 2), 16); let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
  } catch (e) { return ''; }
}

function htmlToDoc(html, baseUrl) {
  let h = String(html);
  h = h.replace(/<a[^>]*href="[^"]*\/cdn-cgi\/l\/email-protection#([0-9a-f]+)"[^>]*>/gi, (m, x) => `<a href="mailto:${cfEmail(x)}">`);
  h = h.replace(/<[^>]*data-cfemail="([0-9a-f]+)"[^>]*>[\s\S]*?<\/[a-z]+>/gi, (m, x) => cfEmail(x));
  for (const tag of ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'header', 'footer', 'nav']) {
    h = h.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'gi'), ' ');
  }
  h = h.replace(/<!--[\s\S]*?-->/g, ' ');
  // consent banners: a div/section whose id or class names a consent tool, when small
  h = h.replace(/<(div|section|aside)\b[^>]*(?:id|class)="[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, (m) => {
    const open = m.slice(0, m.indexOf('>'));
    return CONSENT.test(open) && m.length < 6000 ? ' ' : m;
  });

  const links = []; const seen = new Set();
  const base = String(baseUrl).replace(/\/$/, '');
  for (const m of h.matchAll(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let href = m[1].trim();
    if (!href || /^(#|javascript:|tel:)/i.test(href)) continue;
    try { href = new URL(decode(href), baseUrl).href; } catch (e) { continue; }
    if (seen.has(href) || href.replace(/\/$/, '') === base) continue;
    seen.add(href);
    const label = decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() || href.split('/').pop();
    links.push([label.slice(0, 120), href]);
    if (links.length >= 300) break;
  }

  const body = h.replace(/<\/(p|div|li|tr|h[1-6]|section|article|table|ul|ol|br)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  const lines = []; let prev = null;
  for (let line of decode(body).split('\n')) {
    line = line.replace(/\s+/g, ' ').trim();
    if (line && line !== prev) lines.push(line);
    prev = line;
  }
  return { text: lines.join('\n'), links };
}

// Order-insensitive: some sites shuffle their cards.
function digest(doc) {
  const parts = doc.text.split('\n').concat(doc.links.map(([l, h]) => `${l}\t${h}`)).sort();
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

function forLlm(doc, max = 24000) {
  let out = doc.text;
  if (doc.links.length) out += '\n\nLINKS ON PAGE:\n' + doc.links.map(([l, h]) => `- [${l}](${h})`).join('\n');
  return out.length > max ? out.slice(0, max) : out;
}

const isBotWall = (doc) => doc.text.length < BOT_WALL_MAX_CHARS && BOT_WALL.test(doc.text);

module.exports = { htmlToDoc, digest, forLlm, isBotWall };
