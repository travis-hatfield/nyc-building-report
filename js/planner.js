/* Layout Planner tab — UI glue. Geometry + auto-arrange live in planner-engine.js. */
(function(){
  const E = window.PlannerEngine;
  if(!E || !document.getElementById('tab-planner')) return;
  const {CATALOG, parseDim, fmtDim, rectOf, dimsFor} = E;
  const $ = id => document.getElementById(id);
  const SAVE_KEY = 'aptPlannerState';
  const TRAY_GAP = 36;

  const S = {rooms: [], items: [], counts: {}, openings: [], deskRoom: 'living', manual: false, selected: null, history: [], bg: null, legend: [], calib: null};
  let uid = 0;
  const nid = p => p + (++uid) + '_' + Math.floor(Math.random() * 1e4);

  // ---------- persistence ----------
  function save(){
    try{ localStorage.setItem(SAVE_KEY, JSON.stringify({rooms: S.rooms, items: S.items, counts: S.counts, openings: S.openings, deskRoom: S.deskRoom, manual: S.manual, legend: S.legend})); }catch(e){}
    try{ if(S.bg) localStorage.setItem(SAVE_KEY + 'Bg', S.bg); else localStorage.removeItem(SAVE_KEY + 'Bg'); }catch(e){}
  }
  function load(){
    try{
      const d = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      if(d && Array.isArray(d.rooms)) Object.assign(S, {rooms: d.rooms, items: d.items || [], counts: d.counts || {}, openings: d.openings || [], deskRoom: d.deskRoom || 'living', manual: !!d.manual, legend: d.legend || []});
      S.bg = S.rooms.length === 1 && S.legend.length ? localStorage.getItem(SAVE_KEY + 'Bg') : null;
    }catch(e){}
  }

  // ---------- undo / redo ----------
  const undoStack = [], redoStack = [];
  const snapshot = () => JSON.stringify({rooms: S.rooms, items: S.items, counts: S.counts, openings: S.openings, manual: S.manual, variant: S.variant});
  function pushUndo(){
    undoStack.push(snapshot()); if(undoStack.length > 50) undoStack.shift();
    redoStack.length = 0;
  }
  function restore(str){ Object.assign(S, JSON.parse(str), {selected: null}); renderAll(); }
  function undo(){ if(!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
  function redo(){ if(!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }

  // ---------- rooms ----------
  function setRooms(list, openings){
    S.rooms = list.map(r => ({id: nid('r'), name: String(r.name || 'Room').slice(0, 30), x: r.x, y: r.y, w: r.w, h: r.h}));
    S.openings = openings || []; S.bg = null; S.legend = [];
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
    pushUndo();
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
  const legendH = () => S.legend.length * 12 + 10;
  function bounds(includeTray){
    if(!S.rooms.length) return {x: 0, y: 0, w: 480, h: 300};
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    S.rooms.forEach(r => { x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h); });
    if(S.bg) y2 += legendH();
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
    const useBg = !!(S.bg && S.rooms.length === 1);
    const rooms = useBg ? `<image href="${S.bg}" x="${S.rooms[0].x}" y="${S.rooms[0].y}" width="${S.rooms[0].w}" height="${S.rooms[0].h}" preserveAspectRatio="none" style="mix-blend-mode:multiply"/>`
      : S.rooms.map(r => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" class="pl-wall"/>`).join('');
    const calib = S.calib ? S.calib.pts.map(q => `<circle cx="${q.x}" cy="${q.y}" r="4" fill="#e5484d"/>`).join('') + (S.calib.pts.length === 2 ? `<line x1="${S.calib.pts[0].x}" y1="${S.calib.pts[0].y}" x2="${S.calib.pts[1].x}" y2="${S.calib.pts[1].y}" stroke="#e5484d" stroke-width="2"/>` : '') : '';
    const labels = useBg ? S.legend.map((r, i) => `<text x="${S.rooms[0].x + S.rooms[0].w / 2}" y="${S.rooms[0].y + S.rooms[0].h + 14 + i * 12}" text-anchor="middle" font-size="8" class="pl-rt">${esc(r.name)} · ${fmtDim(r.w)} × ${fmtDim(r.h)}</text>`).join('') : S.rooms.map(r => `<text x="${r.x + r.w / 2}" y="${r.y + r.h + 11}" text-anchor="middle" font-size="8" class="pl-rt">${esc(r.name)} · ${fmtDim(r.w)} × ${fmtDim(r.h)}</text>`).join('');
    const door = S.openings.map(o => {
      const r = S.rooms.find(x => x.name.toLowerCase() === String(o.room || '').toLowerCase()); if(!r) return '';
      const off = o.offset_in || 0, w = o.width_in || 32;
      const g = {n: [r.x + off, r.y, w, 4], s: [r.x + off, r.y + r.h - 2, w, 4], w: [r.x - 2, r.y + off, 4, w], e: [r.x + r.w - 2, r.y + off, 4, w]}[o.wall];
      return g ? `<rect x="${g[0]}" y="${g[1]}" width="${g[2]}" height="${g[3]}" class="pl-door"/>` : '';
    }).join('');
    const sorted = S.items.slice().sort((a, b) => (CATALOG[b.type].flat ? 1 : 0) - (CATALOG[a.type].flat ? 1 : 0));
    svg.innerHTML = rooms + (useBg ? '' : door) + sorted.map(i => itemSVG(i, bad.has(i.id))).join('') + labels + calib;
    const tray = S.items.filter(i => i.tray).length;
    $('plStatus').textContent = S.rooms.length ? (S.calib ? (S.calib.pts.length ? 'Click the second end…' : 'Click one end of a wall whose length you know…') : '') || `${S.items.length} pieces · ${bad.size} conflicts${tray ? ` · ${tray} parked below plan` : ''}` : 'Nothing loaded yet.';
    $('plSelBtns').hidden = !S.selected;
  }
  function renderAll(){ renderRoomList(); renderPicker(); render(); save(); }

  // ---------- drag / select ----------
  let drag = null, lastTap = {id: null, t: 0};
  function svgPoint(ev){
    const svg = $('plSvg'), pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  $('plSvg').addEventListener('pointerdown', ev => {
    if(S.calib){ calibClick(svgPoint(ev)); return; }
    const g = ev.target.closest('.pl-item');
    if(!g){ S.selected = null; render(); return; }
    const it = S.items.find(i => i.id === g.dataset.id); if(!it) return;
    // double-click/tap detection here: render() rebuilds the SVG, so native dblclick loses its target
    const now = Date.now();
    if(lastTap.id === it.id && now - lastTap.t < 400){
      lastTap = {id: null, t: 0}; drag = null; rotate(it.id); return;
    }
    lastTap = {id: it.id, t: now};
    S.selected = it.id;
    const p = svgPoint(ev);
    drag = {it, dx: p.x - it.x, dy: p.y - it.y, undone: false};
    $('plSvg').setPointerCapture(ev.pointerId);
    render();
  });
  $('plSvg').addEventListener('pointermove', ev => {
    if(!drag) return;
    if(!drag.undone){ const q = snapshot(); drag.undone = true; undoStack.push(q); redoStack.length = 0; }
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

  function rotate(id){
    const it = S.items.find(i => i.id === id); if(!it) return;
    pushUndo();
    const c = {x: it.x + dimsFor(it.type, it.rot || 0).w / 2, y: it.y + dimsFor(it.type, it.rot || 0).h / 2};
    it.rot = ((it.rot || 0) + 90) % 360;
    const d = dimsFor(it.type, it.rot);
    it.x = Math.round(c.x - d.w / 2); it.y = Math.round(c.y - d.h / 2);
    S.manual = true; render(); save();
  }
  function removeItem(id){
    const it = S.items.find(i => i.id === id); if(!it) return;
    pushUndo();
    S.items = S.items.filter(i => i.id !== id);
    S.counts[it.type] = Math.max(0, (S.counts[it.type] || 0) - 1);
    S.selected = null; S.manual = true; renderAll();
  }
  function duplicate(id){
    const it = S.items.find(i => i.id === id); if(!it) return;
    pushUndo();
    const n = {id: nid('f'), type: it.type, x: it.x + 12, y: it.y + 12, rot: it.rot || 0, tray: it.tray};
    S.items.push(n); S.counts[it.type] = (S.counts[it.type] || 0) + 1;
    S.selected = n.id; S.manual = true; renderAll();
  }
  let lastNudge = 0;
  function nudge(id, dx, dy){
    const it = S.items.find(i => i.id === id); if(!it) return;
    const now = Date.now(); if(now - lastNudge > 800) pushUndo(); lastNudge = now;
    it.x += dx; it.y += dy; S.manual = true; render(); save();
  }
  document.addEventListener('keydown', ev => {
    if(!$('tab-planner').classList.contains('active')) return;
    if(/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    const mod = ev.ctrlKey || ev.metaKey, k = ev.key.toLowerCase();
    if(mod && k === 'z'){ ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
    if(mod && k === 'y'){ ev.preventDefault(); redo(); return; }
    if(!S.selected) return;
    if(mod && k === 'd'){ ev.preventDefault(); duplicate(S.selected); return; }
    const step = ev.shiftKey ? 6 : 1, arrows = {ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step]};
    if(arrows[ev.key]){ ev.preventDefault(); nudge(S.selected, ...arrows[ev.key]); return; }
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
        const seen = new Set();
        const rooms = (d.rooms || []).filter(r => r && r.width_in > 0 && r.depth_in > 0 && !seen.has(String(r.name).toLowerCase()) && seen.add(String(r.name).toLowerCase())).map(r => ({
          name: r.name, w: Math.round(Math.min(600, Math.max(24, r.width_in))), h: Math.round(Math.min(600, Math.max(24, r.depth_in))), x: NaN, y: NaN
        }));
        if(!rooms.length) throw new Error('I could not find rooms or dimensions in that image. Try a tighter crop, or add rooms by hand.');
        pushUndo();
        setRooms(rooms, Array.isArray(d.openings) ? d.openings : []);
        thinking.textContent = 'Cleaning up the plan image…';
        let usedBg = false;
        try{ usedBg = await useImageAsPlan(img, rooms); }catch(e){ usedBg = false; }
        if(!usedBg){ thinking.textContent = 'Working out how the rooms connect…'; await layoutPasses(img); }
        thinking.remove();
        say('assistant', `Found ${rooms.length} room(s): ${rooms.map(r => `${r.name} ${fmtDim(r.w)}×${fmtDim(r.h)}`).join(', ')}.${d.notes ? ' ' + d.notes : ''} ${usedBg ? 'Your plan is now the backdrop. Calibrate the scale: click both ends of a wall you know the length of, then enter it.' : 'Check the sizes on the left, pick furniture, then hit Auto-arrange.'}`);
        if(usedBg) startCalib();
        renderAll();
      }else{
        const d = await callApi({mode: 'chat', text, state: stateForAI(), history: history.slice(0, -1)});
        thinking.remove();
        pushUndo();
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

  // ---------- use the pasted screenshot as the plan backdrop ----------
  function loadImg(src){ return new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => no(new Error('image')); im.src = src; }); }
  // erase small dark blobs (text, fixtures), crop to the walls, return {src, w, h} in pixels
  async function cleanPlan(src){
    const im = await loadImg(src), k = Math.min(1, 1600 / Math.max(im.width, im.height));
    const W = Math.round(im.width * k), H = Math.round(im.height * k);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const cx = cv.getContext('2d', {willReadFrequently: true}); cx.fillStyle = '#fff'; cx.fillRect(0, 0, W, H); cx.drawImage(im, 0, 0, W, H);
    const id = cx.getImageData(0, 0, W, H), px = id.data, N = W * H;
    const lum = new Uint8Array(N), dark = new Uint8Array(N);
    for(let i = 0; i < N; i++){ const l = (px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11) | 0; lum[i] = l; dark[i] = l < 150 ? 1 : 0; }
    const lab = new Int32Array(N), keep = new Uint8Array(N), erase = new Uint8Array(N), lim = 0.045 * Math.max(W, H), stack = [];
    let n = 0;
    for(let s0 = 0; s0 < N; s0++){
      if(!dark[s0] || lab[s0]) continue;
      n++; lab[s0] = n; stack.length = 0; stack.push(s0);
      const comp = []; let x1 = W, y1 = H, x2 = 0, y2 = 0;
      while(stack.length){
        const p = stack.pop(); comp.push(p);
        const x = p % W, y = (p / W) | 0;
        if(x < x1) x1 = x; if(x > x2) x2 = x; if(y < y1) y1 = y; if(y > y2) y2 = y;
        for(let dy = -1; dy <= 1; dy++) for(let dx = -1; dx <= 1; dx++){
          const nx = x + dx, ny = y + dy; if(nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx; if(dark[q] && !lab[q]){ lab[q] = n; stack.push(q); }
        }
      }
      const big = Math.max(x2 - x1, y2 - y1) >= lim;
      comp.forEach(p => { if(big) keep[p] = 1; else erase[p] = 1; });
    }
    let bx1 = W, by1 = H, bx2 = 0, by2 = 0, kept = 0;
    for(let p = 0; p < N; p++){
      if(keep[p]){ kept++; const x = p % W, y = (p / W) | 0; if(x < bx1) bx1 = x; if(x > bx2) bx2 = x; if(y < by1) by1 = y; if(y > by2) by2 = y; }
    }
    if(kept < N * 0.002 || bx2 - bx1 < 40 || by2 - by1 < 40) throw new Error('no walls found');
    for(let p = 0; p < N; p++){
      if(keep[p] || lum[p] >= 235) continue;
      const x = p % W, y = (p / W) | 0; let near = erase[p];
      for(let dy = -2; dy <= 2 && !near; dy++) for(let dx = -2; dx <= 2; dx++){
        const nx = x + dx, ny = y + dy; if(nx >= 0 && ny >= 0 && nx < W && ny < H && erase[ny * W + nx]){ near = 1; break; }
      }
      if(near){ px[p * 4] = px[p * 4 + 1] = px[p * 4 + 2] = 255; px[p * 4 + 3] = 255; }
    }
    const pad = 10, cw = Math.min(W, bx2 + pad) - Math.max(0, bx1 - pad), ch = Math.min(H, by2 + pad) - Math.max(0, by1 - pad);
    cx.putImageData(id, 0, 0);
    const out = document.createElement('canvas'); out.width = cw; out.height = ch;
    out.getContext('2d').drawImage(cv, Math.max(0, bx1 - pad), Math.max(0, by1 - pad), cw, ch, 0, 0, cw, ch);
    return {src: out.toDataURL('image/png'), w: cw, h: ch};
  }
  async function useImageAsPlan(img, rooms){
    const c = await cleanPlan(img);
    // rough starting scale: plan area is about the sum of room areas (+ walls/halls), content fills about 55% of its box
    const area = rooms.reduce((a, r) => a + r.w * r.h, 0) * 1.15, sc = Math.sqrt(area / (0.55 * c.w * c.h));
    S.legend = rooms.map(r => ({name: r.name, w: r.w, h: r.h}));
    S.rooms = [{id: nid('r'), name: 'Plan', x: 0, y: 0, w: Math.round(Math.min(600, c.w * sc)), h: Math.round(Math.min(600, c.h * sc))}];
    S.openings = []; S.items = []; S.manual = false; S.bg = c.src; S.deskRoom = 'living';
    return true;
  }
  function startCalib(){ if(!S.bg) return; S.calib = {pts: []}; render(); }
  function calibClick(p){
    S.calib.pts.push({x: Math.round(p.x), y: Math.round(p.y)});
    if(S.calib.pts.length < 2){ render(); return; }
    const [a, b] = S.calib.pts, dist = Math.hypot(b.x - a.x, b.y - a.y);
    render();
    setTimeout(() => {
      const ans = window.prompt('Real length between the two points you clicked? (e.g. 13\'3")', S.legend[0] ? fmtDim(S.legend[0].w) : '');
      const real = ans ? parseDim(ans) : NaN;
      if(real > 0 && dist > 4){
        const r = S.rooms[0], f = Math.min(real / dist, 600 / Math.max(r.w, r.h));
        pushUndo(); r.w = Math.round(r.w * f); r.h = Math.round(r.h * f); S.items = []; S.manual = false;
        say('assistant', `Scale set. The plan is now ${fmtDim(r.w)} × ${fmtDim(r.h)}. Click Calibrate scale to redo it, then pick furniture and place it.`);
      }
      S.calib = null; renderAll();
    }, 30);
  }
  $('plCalib').addEventListener('click', startCalib);

  // ---------- multi-pass layout: AI describes which rooms touch (reliable), we compute positions ----------
  function solveLayout(rooms, rels){
    const by = n => rooms.find(r => r.name.toLowerCase() === String(n || '').toLowerCase());
    const opp = {e: 'w', w: 'e', n: 's', s: 'n'};
    const list = (rels || []).map(r => ({a: by(r.a), b: by(r.b), side: r.side, align: r.align || 'start'})).filter(r => r.a && r.b && r.a !== r.b && opp[r.side]);
    rooms.forEach(r => { r.x = r.y = NaN; });
    const placed = new Set(), put = (r, x, y) => { r.x = Math.round(x); r.y = Math.round(y); placed.add(r); };
    const off = (al, A, B) => al === 'center' ? (A - B) / 2 : al === 'end' ? A - B : 0;
    const place = (anchor, mover, side, al) => {   // mover sits on `side` of anchor
      if(side === 'e') put(mover, anchor.x + anchor.w, anchor.y + off(al, anchor.h, mover.h));
      else if(side === 'w') put(mover, anchor.x - mover.w, anchor.y + off(al, anchor.h, mover.h));
      else if(side === 'n') put(mover, anchor.x + off(al, anchor.w, mover.w), anchor.y - mover.h);
      else put(mover, anchor.x + off(al, anchor.w, mover.w), anchor.y + anchor.h);
    };
    const unplaced = () => rooms.filter(r => !placed.has(r));
    while(unplaced().length){
      if(!placed.size){ const first = list.length ? list[0].a : rooms[0]; put(first, 0, 0); }
      let moved = true;
      while(moved){
        moved = false;
        list.forEach(r => {
          if(placed.has(r.a) && !placed.has(r.b)){ place(r.a, r.b, r.side, r.align); moved = true; }
          else if(placed.has(r.b) && !placed.has(r.a)){   // invert: a is on the opposite side of b; alignment mirrors
            place(r.b, r.a, opp[r.side], r.align); moved = true;
          }
        });
      }
      const rest = unplaced();
      if(rest.length){   // disconnected leftovers: park to the right of everything placed
        const right = Math.max(...[...placed].map(r => r.x + r.w)) + 6;
        put(rest[0], right, Math.min(...[...placed].map(r => r.y)));
      }
    }
    const mx = Math.min(...rooms.map(r => r.x)), my = Math.min(...rooms.map(r => r.y));
    rooms.forEach(r => { r.x -= mx; r.y -= my; });
    return list.length;
  }
  async function layoutPasses(img){
    // pass 2: relations; pass 3 and 4: verify/refine against the image
    const payloadRooms = () => S.rooms.map(r => ({name: r.name, width_in: r.w, depth_in: r.h}));
    let rels = null;
    try{
      for(let pass = 0; pass < 3; pass++){
        const d = await callApi({mode: 'layout', image: img, rooms: payloadRooms(), relations: rels || undefined});
        if(Array.isArray(d.relations) && d.relations.length) rels = d.relations; else break;
      }
    }catch(e){ if(!rels) return false; }
    if(!rels) return false;
    S.relations = rels;
    return solveLayout(S.rooms, rels) > 0;
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
  document.querySelectorAll('[data-arr]').forEach(b => b.addEventListener('click', () => { pushUndo(); arrange(+b.dataset.arr); renderAll(); }));
  $('plRotate').addEventListener('click', () => S.selected && rotate(S.selected));
  $('plDuplicate').addEventListener('click', () => S.selected && duplicate(S.selected));
  $('plUndo').addEventListener('click', undo);
  $('plRedo').addEventListener('click', redo);
  $('plDelete').addEventListener('click', () => S.selected && removeItem(S.selected));
  $('plClearItems').addEventListener('click', () => { pushUndo(); S.items = []; S.counts = {}; S.manual = false; S.selected = null; renderAll(); });
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
