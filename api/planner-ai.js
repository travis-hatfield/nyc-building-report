// Vercel serverless function — POST /api/planner-ai
// Powers the Layout Planner tab. Two modes, both proxied to an OpenAI-compatible
// chat API (Groq by default) so the API key never reaches the browser:
//   {mode:'parse', image:<data URL>, text?}  -> floor plan screenshot -> room geometry JSON
//   {mode:'chat', text, state, history?}     -> natural-language edit -> list of planner actions
//
// Env vars: GROQ_API_KEY (same key as the JobApp). To use another provider set
// AI_BASE_URL (full chat/completions URL) and AI_API_KEY instead. Models:
// PLANNER_VISION_MODEL (image input, parse mode) and PLANNER_CHAT_MODEL (text).
//
// SECURITY: the upstream host is fixed (never taken from the request), payload
// sizes are capped, and output is only ever returned as parsed JSON.

const DEFAULT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_VISION_MODEL = 'qwen/qwen3.8-27b';   // reads floor plan images (verified on Groq)
const DEFAULT_CHAT_MODEL = 'openai/gpt-oss-120b';   // text-only, same model the JobApp uses
const MAX_IMAGE_CHARS = 4_000_000;
const MAX_TEXT_CHARS = 2000;
const TIMEOUT_MS = 45000;

const FURNITURE_TYPES = [
  'sofa2', 'sofa3', 'loveseat', 'armchair', 'coffee', 'endtable', 'tvstand', 'bookshelf', 'rug',
  'bedtwin', 'bedfull', 'bedqueen', 'bedking', 'nightstand', 'dresser', 'wardrobe',
  'desk', 'desklg', 'officechair', 'dining4', 'dining6', 'diningchair', 'bar', 'plant'
];

const PARSE_PROMPT = `You read apartment floor plan images. Return ONLY JSON:
{"rooms":[{"name":string,"width_in":number,"depth_in":number,"x_in":number,"y_in":number}],
 "openings":[{"room":string,"wall":"n"|"s"|"e"|"w","offset_in":number,"width_in":number,"kind":"door"|"opening"}],
 "notes":string}
Rules: dimensions are labelled like 7'9" x 7'11" (width x depth, in the order shown); convert to inches.
width_in is the east-west size as drawn, depth_in the north-south size. x_in/y_in is the room's top-left
corner relative to the plan's top-left, estimated from the drawing (rooms adjacent, no overlap).
If a room is cut off or has no readable dimension, still include it, estimate, and say so in notes.
Include entry doors and doorways you can see in openings (offset_in measured from the wall's west/north end).
Do not invent rooms that are not in the image.`;

function chatPrompt(){
  return `You control an apartment furniture layout planner. Return ONLY JSON:
{"reply":string,"actions":[...]}
reply: one or two short sentences. actions: zero or more of:
{"op":"add","type":T,"qty":number,"room":string?}
{"op":"remove","type":T?,"id":string?}
{"op":"move","id":string?,"type":T?,"room":string,"place":"center"|"corner-nw"|"corner-ne"|"corner-sw"|"corner-se"|"wall-n"|"wall-s"|"wall-e"|"wall-w"}
{"op":"rotate","id":string?,"type":T?}
{"op":"arrange","variant":0|1|2}
Valid furniture types T: ${FURNITURE_TYPES.join(', ')}.
(sofa2 = 2-seat couch, sofa3 = 3-seat couch, desklg = large desk, bar = bar cart/counter stool pair.)
Use ids/rooms from the provided state. Prefer "arrange" after adding several pieces. If the user asks
something the planner cannot do, say so in reply with no actions.`;
}

function extractJson(text){
  if(!text) return null;
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if(a < 0 || b <= a) return null;
  try{ return JSON.parse(text.slice(a, b + 1)); }catch(e){ return null; }
}

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  if(req.method !== 'POST'){ res.status(405).json({error: 'POST only.'}); return; }
  const key = process.env.AI_API_KEY || process.env.GROQ_API_KEY || process.env.XAI_API_KEY;
  if(!key){ res.status(503).json({error: 'GROQ_API_KEY is not set on the server. Add it in Vercel project env vars, then redeploy.'}); return; }

  let body = req.body;
  if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch(e){ body = null; } }
  if(!body || typeof body !== 'object'){ res.status(400).json({error: 'Invalid JSON body.'}); return; }

  const mode = body.mode;
  const text = typeof body.text === 'string' ? body.text.slice(0, MAX_TEXT_CHARS) : '';
  let messages;

  if(mode === 'parse'){
    const img = body.image;
    if(typeof img !== 'string' || !/^data:image\/(png|jpe?g|webp);base64,/.test(img)){
      res.status(400).json({error: 'Send the floor plan as a PNG/JPEG/WebP data URL.'}); return;
    }
    if(img.length > MAX_IMAGE_CHARS){ res.status(413).json({error: 'Image too large; try a tighter crop.'}); return; }
    messages = [
      {role: 'system', content: PARSE_PROMPT},
      {role: 'user', content: [
        {type: 'image_url', image_url: {url: img}},
        {type: 'text', text: text || 'Extract the rooms, dimensions and openings.'}
      ]}
    ];
  }else if(mode === 'chat'){
    if(!text){ res.status(400).json({error: 'Empty message.'}); return; }
    const state = JSON.stringify(body.state || {}).slice(0, 12000);
    const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
    messages = [{role: 'system', content: chatPrompt()}];
    for(const h of history){
      if(h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string'){
        messages.push({role: h.role, content: h.content.slice(0, 1000)});
      }
    }
    messages.push({role: 'user', content: `Current planner state: ${state}\n\nRequest: ${text}`});
  }else{
    res.status(400).json({error: 'Unknown mode.'}); return;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try{
    const upstream = await fetch(process.env.AI_BASE_URL || DEFAULT_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        // Groq sits behind Cloudflare, which blocks the default Node fetch UA (same fix JobGuide needed).
        'User-Agent': 'nyc-building-report/1.0'
      },
      body: JSON.stringify({
        model: mode === 'parse'
          ? (process.env.PLANNER_VISION_MODEL || DEFAULT_VISION_MODEL)
          : (process.env.PLANNER_CHAT_MODEL || DEFAULT_CHAT_MODEL),
        messages,
        temperature: 0.1,
        response_format: {type: 'json_object'}
      })
    });
    clearTimeout(timer);
    if(!upstream.ok){
      res.status(502).json({error: `The AI provider returned ${upstream.status}. Check GROQ_API_KEY and the model name.`}); return;
    }
    const data = await upstream.json();
    const parsed = extractJson(data?.choices?.[0]?.message?.content);
    if(!parsed){ res.status(502).json({error: 'The AI returned something unreadable. Try again.'}); return; }
    res.status(200).json({ok: true, ...parsed});
  }catch(e){
    clearTimeout(timer);
    res.status(e.name === 'AbortError' ? 504 : 502).json({error: e.name === 'AbortError' ? 'The AI took too long to respond.' : 'Could not reach the AI provider.'});
  }
};
