/* Layout Planner tab — UI glue. Geometry + auto-arrange live in planner-engine.js. */
(function(){
  const E = window.PlannerEngine;
  if(!E || !document.getElementById('tab-planner')) return;
  const {CATALOG, parseDim, fmtDim, rectOf, dimsFor} = E;
  const $ = id => document.getElementById(id);
  const SAVE_KEY = 'aptPlannerState';
  const TRAY_GAP = 36;

  const S = {rooms: [], items: [], counts: {}, openings: [], deskRoom: 'living', manual: false, selected: null, history: []};
  let uid = 0;
  const nid = p => p + (++uid) + '_' + Math.floor(Math.random() * 1e4);

  // ---------- persistence ----------
  function save(){
    try{ localStorage.setItem(SAVE_KEY, JSON.stringify({rooms: S.rooms, items: S.items, counts: S.counts, openings: S.openings, deskRoom: S.deskRoom, manual: S.manual})); }catch(e){}
  }
  function load(){
    try{
      const d = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      if(d && Array.isArray(d.rooms)) Object.assign(S, {rooms: d.rooms, items: d.items || [], counts: d.counts || {}, openings: d.openings || [], deskRoom: d.deskRoom || 'living', manual: !!d.manual});
    }catch(e){}
  }

  // ---------- rooms ----------
  function setRooms(list, openings){
    S.rooms = list.map(r => ({id: nid('r'), name: String(r.name || 'Room').slice(0, 30), x: r.x, y: r.y, w: r.w, h: r.h}));
    S.openings = openings || [];
    if(S.rooms.some(r => !Number.isFinite(r.x) || !Number.isFinite(r.y))) E.packRooms(S.rooms);
    S.items = []; S.manual = false;
  }
  function renderRoomList(){
    $('plRooms').innerHTML = S.rooms.map(r => `
      <div class="pl-room" data-id="${r.id}">
        <input type="text" class="pl-rn" value="${esc(r.name)}" aria-label="Room name">
        <input type="text" class="pl-rw" value="${fmtDim(r.w)}" aria-label="Width" size="5">
        <span>×</span>
        <input type="text" class="pl-rh" value="${fmtDim(r.h)}" aria-label="Depth" size="5">
        <button type="button" class="pl-x secondary" aria-label="Remove room">✕</button>
      </div>`).join('') || '<p class="hint">No rooms yet. Paste a floor plan screenshot in the chat, or add rooms by hand.</p>';
  }
  function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c])); }

  // ---------- furniture picker ----------
  function renderPicker(){
    const cats = {};
    Object.keys(CATALOG).forEach(t => (cats[CATALOG[t].cat] = cats[CATALOG[t].cat] || []).push(t));
    $('plPicker').innerHTML = Object.keys(cats).map(cat => `
      <div class="pl-cat"><h4>${cat}</h4>
      ${cats[cat].map(t => `<div class="pl-fi" data-type="${t}">
        <span class="pl-sw" style="background:${CATALOG[t].color}"></span>
        <span class="pl-fl">${CATALOG[t].label}<small>${fmtDim(CATALOG[t].w)} × ${fmtDim(CATALOG[t].d)}</small></span>
        <button type="button" class="pl-m secondary" data-d="-1" aria-label="Fewer">−</button>
        <span class="pl-n">${S.counts[t] || 0}</span>
        <button type="button" class="pl-m secondary" data-d="1" aria-label="More">+</button>
      </div>`).join('')}</div>`).join('');
    const sel = $('plDeskRoom'); if(sel) sel.value = S.deskRoom;
  }
  function changeCount(type, delta){
    const n = Math.max(0, Math.min(8, (S.counts[type] || 0) + delta));
    if(n === (S.counts[type] || 0)) return;
    S.counts[type] = n;
    if(!S.manual && S.rooms.length) arrange(S.variant || 0, true);
    else if(delta > 0){ addToTray(type); }
    else removeOne(type);
    renderAll();
  }
  function addToTray(type){
    const b = bounds(false);
    const same = S.items.filter(i => i.tray).length;
    S.items.push({id: nid('f'), type, x: b.x + (same % 6) * 40, y: b.y + b.h + 30 + Math.floor(same / 6) * 40, rot: 0, tray: true});
    S.manual = true;
  }
  function removeOne(type){
    for(let i = S.items.length - 1; i >= 0; i--) if(S.items[i].type === type){ S.items.splice(i, 1); return; }
  }

  // ---------- arrange ----------
  function arrange(variant, quiet){
    if(!S.rooms.length){ if(!quiet) say('assistant', 'Add rooms first (paste a floor plan screenshot or use Add room).'); return; }
    S.variant = variant;
    const res = E.autoArrange(S.rooms, S.counts, {variant, deskRoom: S.deskRoom, openings: S.openings});
    S.items = res.items.map(i => ({id: i.id, type: i.type, x: i.x, y: i.y, rot: i.rot}));
    S.manual = false;
    // pieces that do not fit wait in the tray below the plan
    res.left.forEach(t => addToTray(t));
    S.manual = false;
    S.left = res.left.length;
    if(!quiet && res.left.length) say('assistant', `${res.left.length} piece(s) did not fit and are parked below the plan: ${summarize(res.left)}. Drop something or try another layout.`);
  }
  function summarize(types){
    const c = {}; types.forEach(t => c[t] = (c[t] || 0) + 1);
    return Object.keys(c).map(t => `${c[t]}× ${CATALOG[t].label}`).join(', ');
  }

  // ---------- rendering ----------
  function bounds(includeTray){
    if(!S.rooms.length) return {x: 0, y: 0, w: 480, h: 300};
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    S.rooms.forEach(r => { x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h); });
    if(includeTray) S.items.forEach(i => { const r = rectOf(i); x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h); });
    return {x: x1, y: y1, w: x2 - x1, h: y2 - y1};
  }
  function itemSVG(it, bad){
    const c = CATALOG[it.type], w = c.w, d = c.d, r = it.rot || 0;
    const cx = it.x + dimsFor(it.type, r).w / 2, cy = it.y + dimsFor(it.type, r).h / 2;
    let extra = '';
    if(/^sofa|loveseat/.test(it.type)) extra = `<rect x="${-w / 2}" y="${-d / 2}" width="${w}" height="9" rx="3" fill="rgba(0,0,0,.18)"/><rect x="${-w / 2}" y="${-d / 2 + 6}" width="7" height="${d - 6}" rx="3" fill="rgba(0,0,0,.14)"/><rect x="${w / 2 - 7}" y="${-d / 2 + 6}" width="7" height="${d - 6}" rx="3" fill="rgba(0,0,0,.14)"/>`;
    else if(/^bed/.test(it.type)){
      const two = w >= 54, pw = two ? (w - 12) / 2 - 3 : w - 14;
      extra = `<rect x="${-w / 2}" y="${-d / 2}" width="${w}" height="5" fill="rgba(0,0,0,.25)"/>` +
        (two ? `<rect x="${-w / 2 + 6}" y="${-d / 2 + 8}" width="${pw}" height="14" rx="4" fill="rgba(255,255,255,.55)"/><rect x="${6 / 2 + 3}" y="${-d / 2 + 8}" width="${pw}" height="14" rx="4" fill="rgba(255,255,255,.55)"/>`
              : `<rect x="${-pw / 2}" y="${-d / 2 + 8}" width="${pw}" height="14" rx="4" fill="rgba(255,255,255,.55)"/>`) +
        `<path d="M ${-w / 2} ${-d / 2 + 34} H ${w / 2}" stroke="rgba(0,0,0,.2)" stroke-width="1.5"/>`;
    }else if(it.type === 'armchair') extra = `<rect x="${-w / 2}" y="${-d / 2}" width="${w}" height="8" rx="3" fill="rgba(0,0,0,.18)"/>`;
    else if(it.type === 'officechair') extra = `<circle r="${w / 2 - 2}" fill="rgba(0,0,0,.12)"/>`;
    else if(it.type === 'diningchair') extra = `<rect x="${-w / 2}" y="${-d / 2}" width="${w}" height="4" fill="rgba(0,0,0,.25)"/>`;
    else if(it.type === 'plant') extra = `<circle r="${w / 2 - 1}" fill="rgba(255,255,255,.2)"/>`;
    const fs = Math.max(5, Math.min(9, (Math.min(w, d) > 30 ? w : d + 14) / (c.label.length * 0.5 + 1)));
    const sel = S.selected === it.id;
    return `<g class="pl-item${bad ? ' bad' : ''}${sel ? ' sel' : ''}${c.flat ? ' flat' : ''}" data-id="${it.id}" transform="translate(${cx} ${cy}) rotate(${r})">
      <rect x="${-w / 2}" y="${-d / 2}" width="${w}" height="${d}" rx="3" fill="${c.color}" fill-opacity="${c.flat ? .55 : 1}"/>${extra}
      <text transform="rotate(${-r})" text-anchor="middle" dominant-baseline="middle" font-size="${fs}" class="pl-lbl">${esc(c.label.replace(/ \(.*\)/, ''))}</text></g>`;
  }
  function render(){
    const svg = $('plSvg');
    const b = bounds(true), pad = 24;
    svg.setAttribute('viewBox', `${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}`);
    const bad = E.conflicts(S.items.filter(i => !i.tray), S.rooms);
    S.items.filter(i => i.tray).forEach(i => bad.delete(i.id));
    const rooms = S.rooms.map(r => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" class="pl-wall"/>`).join('');
    const labels = S.rooms.map(r => `<text x="${r.x + r.w / 2}" y="${r.y + r.h + 11}" text-anchor="middle" font-size="8" class="pl-rt">${esc(r.name)} · ${fmtDim(r.w)} × ${fmtDim(r.h)}</text>`).join('');
    const door = S.openings.map(o => {
      const r = S.rooms.find(x => x.name.toLowerCase() === String(o.room || '').toLowerCase()); if(!r) return '';
      const off = o.offset_in || 0, w = o.width_in || 32;
      const g = {n: [r.x + off, r.y, w, 4], s: [r.x + off, r.y + r.h - 2, w, 4], w: [r.x - 2, r.y + off, 4, w], e: [r.x + r.w - 2, r.y + off, 4, w]}[o.wall];
      return g ? `<rect x="${g[0]}" y="${g[1]}" width="${g[2]}" height="${g[3]}" class="pl-door"/>` : '';
    }).join('');
    const sorted = S.items.slice().sort((a, b) => (CATALOG[b.type].flat ? 1 : 0) - (CATALOG[a.type].flat ? 1 : 0));
    svg.innerHTML = rooms + door + sorted.map(i => itemSVG(i, bad.has(i.id))).join('') + labels;
    const tray = S.items.filter(i => i.tray).length;
    $('plStatus').textContent = S.rooms.length ? `${S.items.length} pieces · ${bad.size} conflicts${tray ? ` · ${tray} parked below plan` : ''}` : 'Nothing loaded yet.';
    $('plSelBtns').hidden = !S.selected;
  }
  function renderAll(){ renderRoomList(); renderPicker(); render(); save(); }

  // ---------- drag / select ----------
  let drag = null;
  function svgPoint(ev){
    const svg = $('plSvg'), pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  $('plSvg').addEventListener('pointerdown', ev => {
    const g = ev.target.closest('.pl-item');
    if(!g){ S.selected = null; render(); return; }
    const it = S.items.find(i => i.id === g.dataset.id); if(!it) return;
    S.selected = it.id;
    const p = svgPoint(ev);
    drag = {it, dx: p.x - it.x, dy: p.y - it.y};
    $('plSvg').setPointerCapture(ev.pointerId);
    render();
  });
  $('plSvg').addEventListener('pointermove', ev => {
    if(!drag) return;
    const p = svgPoint(ev), r = dimsFor(drag.it.type, drag.it.rot || 0);
    let x = p.x - drag.dx, y = p.y - drag.dy;
    // snap flush to nearest wall within 5", else to 1" grid
    const room = S.rooms.find(rm => x + r.w / 2 >= rm.x && x + r.w / 2 <= rm.x + rm.w && y + r.h / 2 >= rm.y && y + r.h / 2 <= rm.y + rm.h);
    if(room){
      if(Math.abs(x - room.x) < 5) x = room.x;
      else if(Math.abs(x + r.w - room.x - room.w) < 5) x = room.x + room.w - r.w;
      if(Math.abs(y - room.y) < 5) y = room.y;
      else if(Math.abs(y + r.h - room.y - room.h) < 5) y = room.y + room.h - r.h;
    }
    drag.it.x = Math.round(x); drag.it.y = Math.round(y);
    drag.it.tray = !room; S.manual = true;
    render();
  });
  const endDrag = () => { if(drag){ drag = null; save(); } };
  $('plSvg').addEventListener('pointerup', endDrag);
  $('plSvg').addEventListener('pointercancel', endDrag);
  $('plSvg').addEventListener('dblclick', ev => { const g = ev.target.closest('.pl-item'); if(g) rotate(g.dataset.id); });

  function rotate(id){
    const it = S.items.find(i => i.id === id); if(!it) return;
    const c = {x: it.x + dimsFor(it.type, it.rot || 0).w / 2, y: it.y + dimsFor(it.type, it.rot || 0).h / 2};
    it.rot = ((it.rot || 0) + 90) % 360;
    const d = dimsFor(it.type, it.rot);
    it.x = Math.round(c.x - d.w / 2); it.y = Math.round(c.y - d.h / 2);
    S.manual = true; render(); save();
  }
  function removeItem(id){
    const it = S.items.find(i => i.id === id); if(!it) return;
    S.items = S.items.filter(i => i.id !== id);
    S.counts[it.type] = Math.max(0, (S.counts[it.type] || 0) - 1);
    S.selected = null; S.manual = true; renderAll();
  }
  document.addEventListener('keydown', ev => {
    if(!$('tab-planner').classList.contains('active') || !S.selected) return;
    if(/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if(ev.key === 'r' || ev.key === 'R') rotate(S.selected);
    else if(ev.key === 'Delete' || ev.key === 'Backspace'){ ev.preventDefault(); removeItem(S.selected); }
  });

  // ---------- chat ----------
  const history = [];
  function say(role, text, img){
    const box = $('plChat');
    const d = document.createElement('div');
    d.className = 'pl-msg ' + role;
    if(img){ const im = document.createElement('img'); im.src = img; im.alt = 'Attached floor plan'; d.appendChild(im); }
    if(text){ const p = document.createElement('div'); p.textContent = text; d.appendChild(p); }
    box.appendChild(d); box.scrollTop = box.scrollHeight;
    if(text && role !== 'system') { history.push({role: role === 'user' ? 'user' : 'assistant', content: text}); }
  }
  let pending = null; // data URL awaiting send
  function showPending(){
    $('plAttach').innerHTML = pending ? `<img src="${pending}" alt=""><button type="button" class="secondary" id="plAttachX">Remove</button>` : '';
    if(pending) $('plAttachX').onclick = () => { pending = null; showPending(); };
  }
  function downscale(file){
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const max = 1800, k = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        let q = 0.9, out = cv.toDataURL('image/jpeg', q);
        while(out.length > 3_500_000 && q > 0.4){ q -= 0.15; out = cv.toDataURL('image/jpeg', q); }
        res(out);
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read that image.')); };
      img.src = url;
    });
  }
  async function attach(file){
    if(!file || !/^image\//.test(file.type)) return;
    try{ pending = await downscale(file); showPending(); }catch(e){ say('assistant', e.message); }
  }
  $('plFile').addEventListener('change', e => { attach(e.target.files[0]); e.target.value = ''; });
  $('plInput').addEventListener('paste', e => {
    const f = [...(e.clipboardData?.files || [])].find(x => /^image\//.test(x.type));
    if(f){ e.preventDefault(); attach(f); }
  });
  $('plInput').addEventListener('keydown', e => { if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); send(); } });
  $('plSend').addEventListener('click', send);

  async function callApi(payload){
    const r = await fetch('/api/planner-ai', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
    const data = await r.json().catch(() => ({}));
    if(!r.ok || data.error) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  }
  function stateForAI(){
    return {
      rooms: S.rooms.map(r => ({name: r.name, width_in: r.w, depth_in: r.h})),
      items: S.items.map(i => ({id: i.id, type: i.type, room: (S.rooms.find(r => E.inside(rectOf(i), r)) || {}).name || null})),
      counts: S.counts
    };
  }
  let busy = false;
  async function send(){
    if(busy) return;
    const text = $('plInput').value.trim(), img = pending;
    if(!text && !img) return;
    $('plInput').value = ''; pending = null; showPending();
    say('user', text, img);
    // Address / listing link with no screenshot: nothing to fetch (listing sites block automated access to floor plans).
    if(!img && /https?:\/\/|streeteasy|^\s*\d+\s+(?:west|east|w|e)?\.?\s*\d*\w*\s+(?:street|st|ave|avenue|road|rd|place|pl)\b/i.test(text) && !S.rooms.length){
      say('assistant', 'Listing sites block automated floor plan downloads, so I cannot pull it from the address. Open the listing, screenshot the floor plan image, and paste it here. Room dimensions on the plan are what I read.');
      return;
    }
    busy = true; $('plSend').disabled = true;
    const thinking = document.createElement('div'); thinking.className = 'pl-msg assistant'; thinking.textContent = '…'; $('plChat').appendChild(thinking);
    try{
      if(img){
        const d = await callApi({mode: 'parse', image: img, text});
        const rooms = (d.rooms || []).filter(r => r && r.width_in > 0 && r.depth_in > 0).map(r => ({
          name: r.name, w: Math.round(Math.min(600, Math.max(24, r.width_in))), h: Math.round(Math.min(600, Math.max(24, r.depth_in))),
          x: Number.isFinite(+r.x_in) ? +r.x_in : NaN, y: Number.isFinite(+r.y_in) ? +r.y_in : NaN
        }));
        if(!rooms.length) throw new Error('I could not find rooms or dimensions in that image. Try a tighter crop, or add rooms by hand.');
        setRooms(rooms, Array.isArray(d.openings) ? d.openings : []);
        thinking.remove();
        say('assistant', `Found ${rooms.length} room(s): ${rooms.map(r => `${r.name} ${fmtDim(r.w)}×${fmtDim(r.h)}`).join(', ')}.${d.notes ? ' ' + d.notes : ''} Check the sizes on the left, pick furniture, then hit Auto-arrange.`);
        renderAll();
      }else{
        const d = await callApi({mode: 'chat', text, state: stateForAI(), history: history.slice(0, -1)});
        thinking.remove();
        const note = applyActions(d.actions || []);
        say('assistant', [d.reply, note].filter(Boolean).join(' ') || 'Done.');
        renderAll();
      }
    }catch(e){
      thinking.remove();
      say('assistant', e.message);
    }
    busy = false; $('plSend').disabled = false;
  }

  function findItem(a){
    return (a.id && S.items.find(i => i.id === a.id)) || (a.type && S.items.find(i => i.type === a.type));
  }
  function applyActions(actions){
    let notes = [], needArrange = false, arrangeVariant = null;
    actions.slice(0, 20).forEach(a => {
      if(!a || typeof a !== 'object') return;
      if(a.op === 'add' && CATALOG[a.type]){
        S.counts[a.type] = Math.min(8, (S.counts[a.type] || 0) + Math.max(1, Math.min(6, a.qty | 0 || 1)));
        needArrange = true;
      }else if(a.op === 'remove'){
        const it = findItem(a);
        if(it){ S.items = S.items.filter(i => i !== it); S.counts[it.type] = Math.max(0, (S.counts[it.type] || 0) - 1); }
      }else if(a.op === 'rotate'){
        const it = findItem(a); if(it) rotate(it.id);
      }else if(a.op === 'move'){
        const it = findItem(a), room = S.rooms.find(r => r.name.toLowerCase() === String(a.room || '').toLowerCase());
        if(!it || !room) return;
        const d = dimsFor(it.type, it.rot || 0), p = String(a.place || 'center');
        let x = room.x + (room.w - d.w) / 2, y = room.y + (room.h - d.h) / 2;
        if(/-n|ne|nw/.test(p)) y = room.y; if(/-s|se|sw/.test(p)) y = room.y + room.h - d.h;
        if(/-w|nw|sw/.test(p)) x = room.x; if(/-e|ne|se/.test(p)) x = room.x + room.w - d.w;
        it.x = Math.round(x); it.y = Math.round(y); it.tray = false; S.manual = true;
      }else if(a.op === 'arrange'){ needArrange = true; arrangeVariant = Math.max(0, Math.min(2, a.variant | 0)); }
    });
    if(needArrange){
      if(S.manual && arrangeVariant === null){
        // keep manual placement; park only the new pieces
        const have = {}; S.items.forEach(i => have[i.type] = (have[i.type] || 0) + 1);
        Object.keys(S.counts).forEach(t => { for(let n = have[t] || 0; n < S.counts[t]; n++) addToTray(t); });
        notes.push('New pieces are parked below the plan; drag them in or say "arrange".');
      }else arrange(arrangeVariant === null ? 0 : arrangeVariant, true);
    }
    return notes.join(' ');
  }

  // ---------- controls ----------
  $('plPicker').addEventListener('click', e => {
    const b = e.target.closest('.pl-m'); if(!b) return;
    changeCount(b.closest('.pl-fi').dataset.type, +b.dataset.d);
  });
  $('plDeskRoom').addEventListener('change', e => { S.deskRoom = e.target.value; save(); });
  document.querySelectorAll('[data-arr]').forEach(b => b.addEventListener('click', () => { arrange(+b.dataset.arr); renderAll(); }));
  $('plRotate').addEventListener('click', () => S.selected && rotate(S.selected));
  $('plDelete').addEventListener('click', () => S.selected && removeItem(S.selected));
  $('plClearItems').addEventListener('click', () => { S.items = []; S.counts = {}; S.manual = false; S.selected = null; renderAll(); });
  $('plAddRoom').addEventListener('click', () => {
    const last = S.rooms[S.rooms.length - 1];
    S.rooms.push({id: nid('r'), name: 'Room ' + (S.rooms.length + 1), x: last ? last.x + last.w + 6 : 0, y: last ? last.y : 0, w: 144, h: 120});
    renderAll();
  });
  $('plRooms').addEventListener('change', e => {
    const row = e.target.closest('.pl-room'); if(!row) return;
    const r = S.rooms.find(x => x.id === row.dataset.id); if(!r) return;
    r.name = row.querySelector('.pl-rn').value.trim().slice(0, 30) || r.name;
    const w = parseDim(row.querySelector('.pl-rw').value), h = parseDim(row.querySelector('.pl-rh').value);
    if(w >= 24 && w <= 600) r.w = w;
    if(h >= 24 && h <= 600) r.h = h;
    // sizes changed: re-flow rooms in a row so none overlap, drop stale placements
    E.packRooms(S.rooms); S.items = []; S.manual = false;
    if(Object.values(S.counts).some(n => n)) arrange(S.variant || 0, true);
    renderAll();
  });
  $('plRooms').addEventListener('click', e => {
    if(!e.target.closest('.pl-x')) return;
    const id = e.target.closest('.pl-room').dataset.id;
    S.rooms = S.rooms.filter(r => r.id !== id); S.items = []; S.manual = false;
    if(S.rooms.length) E.packRooms(S.rooms);
    renderAll();
  });
  $('plPng').addEventListener('click', () => {
    const svg = $('plSvg').cloneNode(true), vb = svg.getAttribute('viewBox').split(' ').map(Number);
    const css = 'text{font-family:system-ui,sans-serif}.pl-wall{fill:#f6f4ef;stroke:#444;stroke-width:5}.pl-rt{fill:#555}.pl-lbl{fill:#fff;font-weight:600}.pl-door{fill:#f6f4ef}.pl-item.bad rect:first-child{stroke:#e5484d;stroke-width:3}';
    svg.insertAdjacentHTML('afterbegin', `<style>${css}</style>`);
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('width', vb[2] * 3); svg.setAttribute('height', vb[3] * 3);
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], {type: 'image/svg+xml'})), img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas'); cv.width = vb[2] * 3; cv.height = vb[3] * 3;
      const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      const a = document.createElement('a'); a.href = cv.toDataURL('image/png'); a.download = 'apartment-layout.png'; a.click();
    };
    img.src = url;
  });

  load();
  say('assistant', 'Paste or attach a floor plan screenshot and I will read the rooms. Then pick furniture and hit Auto-arrange, or ask me things like "add a king bed" or "move the desk to the northeast corner of the living room".');
  renderAll();
})();
