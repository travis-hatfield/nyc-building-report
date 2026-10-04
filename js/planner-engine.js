/* Layout Planner engine — pure geometry + auto-arrange, no DOM.
 * Units are inches. Origin top-left, y grows downward (SVG space).
 * An item's `rot` is 0/90/180/270 clockwise. At rot 0 its "back" is the north edge and
 * it "faces" south; x,y is the top-left of its (rotation-adjusted) bounding box.
 * Loaded in the browser as window.PlannerEngine and in Node (tests) via require().
 */
(function(root){
  // type -> {label, w, d (inches), cat, mode: 'wall' = sits back-to-wall, 'free' = anywhere}
  const CATALOG = {
    sofa3:       {label: '3-seat couch',      w: 84, d: 36, cat: 'Living', mode: 'wall', color: '#7c8fb3'},
    sofa2:       {label: '2-seat couch',      w: 62, d: 35, cat: 'Living', mode: 'wall', color: '#8a9fc4'},
    loveseat:    {label: 'Loveseat',          w: 58, d: 34, cat: 'Living', mode: 'wall', color: '#93a7c9'},
    armchair:    {label: 'Armchair',          w: 32, d: 34, cat: 'Living', mode: 'free', color: '#b08fb8'},
    coffee:      {label: 'Coffee table',      w: 44, d: 24, cat: 'Living', mode: 'free', color: '#b99a74'},
    endtable:    {label: 'End table',         w: 20, d: 20, cat: 'Living', mode: 'free', color: '#c4a97e'},
    tvstand:     {label: 'TV stand',          w: 58, d: 16, cat: 'Living', mode: 'wall', color: '#6f7a86'},
    bookshelf:   {label: 'Bookshelf',         w: 32, d: 12, cat: 'Living', mode: 'wall', color: '#a07f5c'},
    rug:         {label: 'Area rug 5x8',      w: 96, d: 60, cat: 'Living', mode: 'free', color: '#d9cdb8', flat: true},
    bedtwin:     {label: 'Twin bed',          w: 39, d: 75, cat: 'Bedroom', mode: 'wall', color: '#9cb59a'},
    bedfull:     {label: 'Full bed',          w: 54, d: 75, cat: 'Bedroom', mode: 'wall', color: '#9cb59a'},
    bedqueen:    {label: 'Queen bed',         w: 60, d: 80, cat: 'Bedroom', mode: 'wall', color: '#8fb08d'},
    bedking:     {label: 'King bed',          w: 76, d: 80, cat: 'Bedroom', mode: 'wall', color: '#82a880'},
    nightstand:  {label: 'Nightstand',        w: 18, d: 16, cat: 'Bedroom', mode: 'free', color: '#c4a97e'},
    dresser:     {label: 'Dresser',           w: 60, d: 18, cat: 'Bedroom', mode: 'wall', color: '#a88a64'},
    wardrobe:    {label: 'Wardrobe',          w: 36, d: 22, cat: 'Bedroom', mode: 'wall', color: '#9a7b58'},
    desk:        {label: 'Computer desk',     w: 48, d: 24, cat: 'Work', mode: 'wall', color: '#7fa9b5'},
    desklg:      {label: 'Large desk',        w: 60, d: 30, cat: 'Work', mode: 'wall', color: '#6f9aa6'},
    officechair: {label: 'Office chair',      w: 24, d: 24, cat: 'Work', mode: 'free', color: '#5f6b78'},
    dining4:     {label: 'Dining table (4)',  w: 48, d: 30, cat: 'Dining', mode: 'free', color: '#b99a74'},
    dining6:     {label: 'Dining table (6)',  w: 72, d: 36, cat: 'Dining', mode: 'free', color: '#b99a74'},
    diningchair: {label: 'Dining chair',      w: 18, d: 18, cat: 'Dining', mode: 'free', color: '#8c7a66'},
    bar:         {label: 'Bar cart',          w: 30, d: 16, cat: 'Other', mode: 'wall', color: '#8a8f99'},
    plant:       {label: 'Plant',             w: 16, d: 16, cat: 'Other', mode: 'free', color: '#6fae6f'}
  };

  const STEP = 6;
  const FRONT = [[0, 1], [-1, 0], [0, -1], [1, 0]];   // facing vector per rot index
  const TANG = [[1, 0], [0, 1], [-1, 0], [0, -1]];    // along-the-back vector per rot index

  // ---------- helpers ----------
  function parseDim(str){
    // "7'9\"", "7' 9", "7ft 9in", "7.5", "9'" -> inches. A bare number is feet.
    if(typeof str === 'number') return str;
    const s = String(str || '').trim().toLowerCase().replace(/[”“″]/g, '"').replace(/[’‘′]/g, "'");
    if(!s) return NaN;
    let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|inches)?)?$/);
    if(m) return Math.round(parseFloat(m[1]) * 12 + (m[2] ? parseFloat(m[2]) : 0));
    m = s.match(/^(\d+(?:\.\d+)?)\s*(?:"|in|inches)$/);
    if(m) return Math.round(parseFloat(m[1]));
    m = s.match(/^(\d+(?:\.\d+)?)$/);
    if(m) return Math.round(parseFloat(m[1]) * 12);
    return NaN;
  }
  function fmtDim(inches){
    const t = Math.round(inches);
    const f = Math.floor(t / 12), i = t % 12;
    return i ? `${f}'${i}"` : `${f}'`;
  }
  function dimsFor(type, rot){
    const c = CATALOG[type];
    return rot % 180 ? {w: c.d, h: c.w} : {w: c.w, h: c.d};
  }
  function rectOf(it){ const d = dimsFor(it.type, it.rot || 0); return {x: it.x, y: it.y, w: d.w, h: d.h}; }
  function overlap(a, b, m){
    m = m || 0;
    return a.x < b.x + b.w + m && a.x + a.w + m > b.x && a.y < b.y + b.h + m && a.y + a.h + m > b.y;
  }
  function inside(r, room){
    return r.x >= room.x - 0.01 && r.y >= room.y - 0.01 && r.x + r.w <= room.x + room.w + 0.01 && r.y + r.h <= room.y + room.h + 0.01;
  }
  function roomKind(name){
    const n = String(name || '').toLowerCase();
    if(/bath|toilet|wc|powder|closet|hall|foyer|entry|laundry|utility|storage|pantry|vestibule/.test(n)) return 'skip';
    if(/bed|master|primary|\bbr\b|nursery/.test(n)) return 'bedroom';
    if(/kitchen|dining|eat/.test(n)) return 'kitchen';
    if(/living|lounge|great|family|studio|den|office|study|sitting/.test(n)) return 'living';
    return 'other';
  }
  function assignRooms(rooms){
    // returns {living, bedroom, kitchen} room refs (any may be null)
    const usable = rooms.filter(r => roomKind(r.name) !== 'skip');
    const by = k => usable.filter(r => roomKind(r.name) === k).sort((a, b) => b.w * b.h - a.w * a.h)[0] || null;
    let living = by('living'), bedroom = by('bedroom'), kitchen = by('kitchen');
    const others = usable.filter(r => r !== living && r !== bedroom && r !== kitchen).sort((a, b) => b.w * b.h - a.w * a.h);
    if(!living) living = others.shift() || null;
    if(!bedroom && others.length) bedroom = others.shift();
    return {living, bedroom, kitchen};
  }
  function zonesFor(room, openings){
    // keep-clear zones in front of doors/openings, ~32" deep
    const D = 32, out = [];
    (openings || []).forEach(o => {
      if(String(o.room || '').toLowerCase() !== String(room.name || '').toLowerCase()) return;
      const off = Math.max(0, o.offset_in || 0), w = Math.max(24, o.width_in || 32);
      if(o.wall === 'n') out.push({x: room.x + off, y: room.y, w, h: D});
      else if(o.wall === 's') out.push({x: room.x + off, y: room.y + room.h - D, w, h: D});
      else if(o.wall === 'w') out.push({x: room.x, y: room.y + off, w: D, h: w});
      else if(o.wall === 'e') out.push({x: room.x + room.w - D, y: room.y + off, w: D, h: w});
    });
    return out;
  }

  // ---------- placement ----------
  let uid = 0;
  function newId(){ return 'f' + (++uid) + '_' + Math.floor(Math.random() * 1e4); }

  function makeCtx(room, zones){ return {room, zones: zones || [], placed: []}; }
  function fitsRect(ctx, r, flat){
    if(!inside(r, ctx.room)) return false;
    if(!flat){
      for(const z of ctx.zones) if(overlap(r, z)) return false;
      for(const p of ctx.placed){ if(!p.flat && overlap(r, p.rect, 1)) return false; }
    }
    return true;
  }
  function tryAdd(ctx, type, x, y, rot){
    const d = dimsFor(type, rot), r = {x: Math.round(x), y: Math.round(y), w: d.w, h: d.h};
    const flat = !!CATALOG[type].flat;
    if(!fitsRect(ctx, r, flat)) return null;
    const it = {id: newId(), type, x: r.x, y: r.y, rot, roomName: ctx.room.name};
    ctx.placed.push({rect: r, flat, item: it});
    return it;
  }
  // Place `type` relative to an anchor's local frame (along its back, ahead = toward its front).
  function relPlace(ctx, anchor, type, along, ahead, rotOffset){
    const ar = rectOf(anchor), rot = ((anchor.rot || 0) + (rotOffset || 0) + 360) % 360;
    const ri = (anchor.rot || 0) / 90, t = TANG[ri], f = FRONT[ri];
    const cx = ar.x + ar.w / 2 + t[0] * along + f[0] * ahead;
    const cy = ar.y + ar.h / 2 + t[1] * along + f[1] * ahead;
    const d = dimsFor(type, rot);
    return tryAdd(ctx, type, cx - d.w / 2, cy - d.h / 2, rot);
  }
  function anchorLocalDims(it){ const c = CATALOG[it.type]; return {w: c.w, d: c.d}; }

  // Candidate positions with the item's back flush to each wall.
  function wallCandidates(room, type){
    const out = [];
    for(let ri = 0; ri < 4; ri++){
      const rot = ri * 90, d = dimsFor(type, rot);
      if(d.w > room.w || d.h > room.h) continue;
      const horizontal = (ri === 0 || ri === 2);
      const span = horizontal ? room.w - d.w : room.h - d.h;
      const wallLen = horizontal ? room.w : room.h;
      const offs = new Set([0, span, Math.round(span / 2)]);
      for(let o = 0; o <= span; o += STEP) offs.add(o);
      offs.forEach(o => {
        let x, y;
        if(ri === 0){ x = room.x + o; y = room.y; }
        else if(ri === 1){ x = room.x + room.w - d.w; y = room.y + o; }
        else if(ri === 2){ x = room.x + o; y = room.y + room.h - d.h; }
        else { x = room.x; y = room.y + o; }
        const centered = -Math.abs(o - span / 2) / 8;
        out.push({x, y, rot, wallLen, score: wallLen / 24 + centered});
      });
    }
    return out;
  }
  function freeCandidates(room, type){
    const out = [];
    for(let ri = 0; ri < 4; ri++){
      const rot = ri * 90, d = dimsFor(type, rot);
      for(let x = room.x; x + d.w <= room.x + room.w + 0.01; x += STEP)
        for(let y = room.y; y + d.h <= room.y + room.h + 0.01; y += STEP)
          out.push({x, y, rot});
    }
    return out;
  }
  function crowdPenalty(ctx, r){
    let p = 0;
    ctx.placed.forEach(o => { if(!o.flat && overlap(r, o.rect, 20)) p += 4; });
    return p;
  }
  // Best generic spot for a piece; wall-mode pieces go back-to-wall, free pieces prefer walls/corners lightly.
  function placeGeneric(ctx, type){
    const c = CATALOG[type];
    let best = null;
    const cands = c.mode === 'wall' ? wallCandidates(ctx.room, type) : freeCandidates(ctx.room, type);
    for(const k of cands){
      const d = dimsFor(type, k.rot), r = {x: k.x, y: k.y, w: d.w, h: d.h};
      if(!fitsRect(ctx, r, c.flat)) continue;
      let s = (k.score || 0) - crowdPenalty(ctx, r);
      if(c.mode === 'free'){
        const edge = Math.min(r.x - ctx.room.x, r.y - ctx.room.y, ctx.room.x + ctx.room.w - r.x - r.w, ctx.room.y + ctx.room.h - r.y - r.h);
        s -= edge / 12;
      }
      if(!best || s > best.s) best = {s, x: k.x, y: k.y, rot: k.rot};
    }
    return best ? tryAdd(ctx, type, best.x, best.y, best.rot) : null;
  }

  const SOFA_TYPES = ['sofa3', 'sofa2', 'loveseat'];
  const BED_TYPES = ['bedking', 'bedqueen', 'bedfull', 'bedtwin'];
  const DESK_TYPES = ['desklg', 'desk'];
  const DINING_TYPES = ['dining6', 'dining4'];

  function takeFirst(bag, list){
    for(const t of list){ const i = bag.indexOf(t); if(i >= 0){ bag.splice(i, 1); return t; } }
    return null;
  }
  function takeAll(bag, type){
    let n = 0;
    for(let i = bag.length - 1; i >= 0; i--) if(bag[i] === type){ bag.splice(i, 1); n++; }
    return n;
  }

  function seatChairs(ctx, table, n){
    // around a (free-standing) table: long sides first, then ends
    const L = anchorLocalDims(table);
    const slots = [];
    const per = Math.ceil(n / 2);
    for(let i = 0; i < per; i++){
      const a = per === 1 ? 0 : (i - (per - 1) / 2) * Math.min(26, (L.w - 18) / Math.max(1, per - 1));
      slots.push([a, L.d / 2 + 10, 180]);          // front side, facing table
      slots.push([a, -L.d / 2 - 10, 0]);           // back side
    }
    slots.push([L.w / 2 + 10, 0, 90], [-L.w / 2 - 10, 0, 270]);
    let placed = 0;
    for(const s of slots){
      if(placed >= n) break;
      if(relPlace(ctx, table, 'diningchair', s[0], s[1], s[2])) placed++;
    }
    return placed;
  }

  // Run the whole chain for one anchor candidate. Returns {items, left, score}.
  function buildRoom(room, zones, bagIn, kind, anchorCand){
    const ctx = makeCtx(room, zones), bag = bagIn.slice(), left = [];
    let anchor = null;

    const sofa = takeFirst(bag, SOFA_TYPES), bed = takeFirst(bag, BED_TYPES);
    let main = null;
    if(kind === 'bedroom' && bed) main = bed;
    else if(sofa) main = sofa;
    else if(bed) main = bed;
    if(main){
      if(anchorCand) anchor = tryAdd(ctx, main, anchorCand.x, anchorCand.y, anchorCand.rot);
      if(!anchor) left.push(main);
    }
    // the other big piece (second couch / bed in a studio) goes generic
    const second = (main === sofa) ? bed : sofa;
    if(anchor && CATALOG[anchor.type].cat === 'Bedroom'){
      // headboard wall; nightstands flank it
      const L = anchorLocalDims(anchor);
      for(let i = 0; i < 2; i++){
        if(!bag.includes('nightstand')) break;
        takeFirst(bag, ['nightstand']);
        const side = i === 0 ? -1 : 1;
        if(!relPlace(ctx, anchor, 'nightstand', side * (L.w / 2 + 10 + 1), -L.d / 2 + 8)) left.push('nightstand');
      }
    }else if(anchor){
      const L = anchorLocalDims(anchor);
      let coffee = null;
      if(bag.includes('coffee')){
        takeFirst(bag, ['coffee']);
        coffee = relPlace(ctx, anchor, 'coffee', 0, L.d / 2 + 16 + 12);
        if(!coffee) left.push('coffee');
      }
      for(let i = 0; i < 2; i++){
        if(!bag.includes('endtable')) break;
        takeFirst(bag, ['endtable']);
        const side = i === 0 ? -1 : 1;
        if(!relPlace(ctx, anchor, 'endtable', side * (L.w / 2 + 10 + 1), -L.d / 2 + 10)) left.push('endtable');
      }
      // TV stand across the room, facing the couch
      if(bag.includes('tvstand')){
        takeFirst(bag, ['tvstand']);
        const ar = rectOf(anchor), ac = {x: ar.x + ar.w / 2, y: ar.y + ar.h / 2};
        const ri = (anchor.rot || 0) / 90, wantRot = (((anchor.rot || 0) + 180) % 360);
        let best = null;
        for(const k of wallCandidates(room, 'tvstand')){
          if(k.rot !== wantRot) continue;
          const d = dimsFor('tvstand', k.rot), r = {x: k.x, y: k.y, w: d.w, h: d.h};
          if(!fitsRect(ctx, r)) continue;
          const dist = Math.hypot(r.x + r.w / 2 - ac.x, r.y + r.h / 2 - ac.y);
          const tg = TANG[ri], lateral = (r.x + r.w / 2 - ac.x) * tg[0] + (r.y + r.h / 2 - ac.y) * tg[1];
          const s = -Math.abs(dist - 108) / 6 - Math.abs(lateral) / 10;
          if(!best || s > best.s) best = {s, k};
        }
        if(!(best && tryAdd(ctx, 'tvstand', best.k.x, best.k.y, best.k.rot))) left.push('tvstand');
      }
      // armchairs flank the coffee table, angled to it
      if(coffee){
        const CL = anchorLocalDims(coffee);
        for(let i = 0; i < 2; i++){
          if(!bag.includes('armchair')) break;
          takeFirst(bag, ['armchair']);
          const side = i === 0 ? -1 : 1;
          const a = relPlace(ctx, coffee, 'armchair', side * (CL.w / 2 + 24), 0, side === 1 ? 90 : 270)
                 || relPlace(ctx, anchor, 'armchair', side * (L.w / 2 + 26), L.d / 2 + 30, side === 1 ? 90 : 270);
          if(!a) left.push('armchair');
        }
      }
      // rug centered under coffee table (decorative, may overlap)
      if(bag.includes('rug') && coffee){
        takeFirst(bag, ['rug']);
        const cr = rectOf(coffee), ri2 = (coffee.rot || 0);
        const rd = dimsFor('rug', ri2);
        if(!tryAdd(ctx, 'rug', cr.x + cr.w / 2 - rd.w / 2, cr.y + cr.h / 2 - rd.h / 2, ri2)) left.push('rug');
      }
    }
    // desks with a chair tucked in
    let desk;
    while((desk = takeFirst(bag, DESK_TYPES))){
      const d = placeGeneric(ctx, desk);
      if(!d){ left.push(desk); if(takeFirst(bag, ['officechair'])) left.push('officechair'); continue; }
      if(bag.includes('officechair')){
        takeFirst(bag, ['officechair']);
        const L = anchorLocalDims(d);
        if(!relPlace(ctx, d, 'officechair', 0, L.d / 2 + 13, 180)) left.push('officechair');
      }
    }
    // dining
    let dt;
    while((dt = takeFirst(bag, DINING_TYPES))){
      const t = placeGeneric(ctx, dt);
      if(!t){ left.push(dt); continue; }
      const chairs = Math.min(takeAll(bag, 'diningchair'), dt === 'dining6' ? 6 : 4);
      const placedN = seatChairs(ctx, t, chairs);
      for(let i = placedN; i < chairs; i++) left.push('diningchair');
    }
    if(second) bag.unshift(second);
    // everything else, biggest first
    bag.sort((a, b) => CATALOG[b].w * CATALOG[b].d - CATALOG[a].w * CATALOG[a].d);
    bag.forEach(t => { if(!placeGeneric(ctx, t)) left.push(t); });

    // quality: placed count dominates, then open floor in the middle of the room
    let free = room.w * room.h;
    ctx.placed.forEach(p => { if(!p.flat) free -= p.rect.w * p.rect.h; });
    return {items: ctx.placed.map(p => p.item), left, score: ctx.placed.length * 1000 + free / 100};
  }

  function arrangeRoom(room, zones, types, kind, variant){
    const bag = types.slice();
    const main = takeFirst(bag.slice(), SOFA_TYPES) || takeFirst(bag.slice(), BED_TYPES);
    const first = kind === 'bedroom' ? (takeFirst(bag.slice(), BED_TYPES) || main) : main;
    if(!first) return buildRoom(room, zones, types, kind, null);
    const cands = wallCandidates(room, first).sort((a, b) => b.score - a.score);
    // best few per wall (rot), so variants really differ
    const byRot = {};
    cands.forEach(c => { (byRot[c.rot] = byRot[c.rot] || []).length < 6 && byRot[c.rot].push(c); });
    const results = [];
    Object.keys(byRot).forEach(rot => {
      let best = null;
      byRot[rot].forEach(c => {
        const r = buildRoom(room, zones, types, kind, c);
        if(!best || r.score > best.score) best = r;
      });
      if(best) results.push(best);
    });
    if(!results.length) return buildRoom(room, zones, types, kind, null);
    results.sort((a, b) => b.score - a.score);
    return results[variant % results.length];
  }

  /**
   * rooms: [{id,name,x,y,w,h}], counts: {type: n}, opts: {variant, deskRoom: 'living'|'bedroom', openings}
   * returns {items:[{id,type,x,y,rot,roomName}], left:[type]}
   */
  function autoArrange(rooms, counts, opts){
    opts = opts || {};
    const variant = opts.variant || 0;
    const slots = assignRooms(rooms);
    const bags = new Map();
    const bagFor = r => { if(!bags.has(r)) bags.set(r, []); return bags.get(r); };
    const fallback = slots.living || slots.bedroom || slots.kitchen;
    if(!fallback) return {items: [], left: expand(counts)};
    const diningHome = (slots.kitchen && slots.kitchen.w * slots.kitchen.h >= 90 * 144) ? slots.kitchen : slots.living || fallback;

    expand(counts).forEach(t => {
      const cat = CATALOG[t].cat;
      let r;
      if(cat === 'Bedroom') r = slots.bedroom || slots.living || fallback;
      else if(cat === 'Dining') r = diningHome;
      else if(cat === 'Work') r = (opts.deskRoom === 'bedroom' && slots.bedroom) ? slots.bedroom : (slots.living || fallback);
      else r = slots.living || fallback;
      bagFor(r).push(t);
    });

    const items = [], left = [];
    bags.forEach((bag, room) => {
      const kind = room === slots.bedroom ? 'bedroom' : 'living';
      const res = arrangeRoom(room, zonesFor(room, opts.openings), bag, kind, variant);
      items.push(...res.items);
      left.push(...res.left);
    });
    // spill leftovers into any other furnishable room with space
    let pairedChairs = 0;
    const spare = left.splice(0).sort((a, b) => (b.indexOf('desk') >= 0) - (a.indexOf('desk') >= 0));
    spare.forEach(t => {
      if(t === 'officechair' && pairedChairs > 0){ pairedChairs--; return; }
      let placed = false;
      const hasDesk = r => items.some(i => i.roomName === r.name && CATALOG[i.type].cat === 'Work' && i.type !== 'officechair');
      const order = rooms.slice().sort((x, y) => (hasDesk(y) - hasDesk(x)) * (t === 'officechair' ? 1 : 0));
      for(const r of order){
        const k = roomKind(r.name), cat = CATALOG[t].cat;
        if(k === 'skip') continue;
        if(k === 'kitchen' && cat !== 'Dining' && cat !== 'Work') continue;
        const ctx = makeCtx(r, zonesFor(r, opts.openings));
        items.forEach(it => { if(it.roomName === r.name) ctx.placed.push({rect: rectOf(it), flat: !!CATALOG[it.type].flat, item: it}); });
        const it = placeGeneric(ctx, t);
        if(it){
          items.push(it); placed = true;
          if(cat === 'Work' && t !== 'officechair' && spare.includes('officechair')){
            const L = anchorLocalDims(it);
            if(relPlace(ctx, it, 'officechair', 0, L.d / 2 + 13, 180)){ items.push(ctx.placed[ctx.placed.length - 1].item); pairedChairs++; }
          }
          break;
        }
      }
      if(!placed) left.push(t);
    });
    return {items, left};
  }
  function expand(counts){
    const out = [];
    Object.keys(counts || {}).forEach(t => { if(CATALOG[t]) for(let i = 0; i < counts[t]; i++) out.push(t); });
    return out;
  }
  // Which items overlap each other or poke outside every room (for red highlighting).
  function conflicts(items, rooms){
    const bad = new Set();
    const solid = items.filter(i => !CATALOG[i.type].flat);
    for(let a = 0; a < solid.length; a++)
      for(let b = a + 1; b < solid.length; b++)
        if(overlap(rectOf(solid[a]), rectOf(solid[b]), 0.5)){ bad.add(solid[a].id); bad.add(solid[b].id); }
    items.forEach(i => {
      const r = rectOf(i);
      if(!rooms.some(rm => inside(r, rm))) bad.add(i.id);
    });
    return bad;
  }
  // Row-pack rooms left to right when no positions are known.
  function packRooms(rooms){
    let x = 0;
    rooms.forEach(r => { r.x = x; r.y = 0; x += r.w + 6; });
  }

  const api = {CATALOG, parseDim, fmtDim, dimsFor, rectOf, overlap, inside, roomKind, assignRooms, autoArrange, conflicts, packRooms, wallCandidates, FRONT, TANG};
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlannerEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
