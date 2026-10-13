// Tiny Upstash Redis REST client (free tier works). Env: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
// (Vercel's Upstash integration sets KV_REST_API_URL / KV_REST_API_TOKEN, also accepted).
const URL_ = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const configured = () => Boolean(URL_() && TOKEN());

async function cmd(args) {
  const r = await fetch(URL_(), {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args), signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Redis answered ${r.status}`);
  return (await r.json()).result;
}

async function getJson(key) { const v = await cmd(['GET', key]); return v ? JSON.parse(v) : null; }
async function setJson(key, val) { await cmd(['SET', key, JSON.stringify(val)]); }
async function mgetJson(keys) {
  if (!keys.length) return [];
  return (await cmd(['MGET', ...keys])).map((v) => (v ? JSON.parse(v) : null));
}

module.exports = { configured, getJson, setJson, mgetJson };
