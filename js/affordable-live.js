// Affordable tab: live Housing Connect lotteries, HDC re-rentals, and the
// Daily apartment scout picks. Self-contained; talks only to the DOM nodes
// it injects at the top of #tab-affordable.
(function(){
  "use strict";
  const HC_API = "https://a806-housingconnectapi.nyc.gov/HPDPublicAPI/api/";
  const HC_PAGE = id => `https://housingconnect.nyc.gov/PublicWeb/details/${id}`;
  const PROFILE_KEY = "nycAptAffordProfile";
  const CACHE_KEY = "nycAptLotteryCache";
  const CACHE_MS = 30 * 60 * 1000;
  const SIZES = {"studio":"Studio","1 bedroom":"1 BR","2 bedroom":"2 BR","3 bedroom":"3 BR"};

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const money = t => { const m = /\$?\s*([\d,]+(?:\.\d+)?)/.exec(t || ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
  const cells = html => [...(html || "").matchAll(/<td>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, "").trim());
  const fmt = n => n == null ? "?" : "$" + Math.round(n).toLocaleString();

  async function getJSON(url, opts, ms){
    const r = await fetch(url, Object.assign({}, opts, {signal: AbortSignal.timeout(ms || 60000)}));
    if(!r.ok) throw new Error(r.status + " from " + new URL(url).host);
    return r.json();
  }

  async function openLotteries(){
    const found = new Map();
    const search = await getJSON(HC_API + "Lottery/SearchLotteries", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({UnitTypes:[],NearbyPlaces:[],NearbySubways:[],Amenities:[],Applied:null,HPDUserId:null,Boroughs:[],Neighborhoods:[],HouseholdSize:null,Income:"",HouseholdType:1,OwnerTypes:[],PreferanceTypes:[],LotteryTypes:[],Min:null,Max:null,RentalSubsidy:null})
    });
    (search.rentals || []).forEach(x => found.set(x.lotteryId, x));
    try {
      ((await getJSON(HC_API + "Lottery/GetLatestLotteries")) || []).forEach(x => { if(!found.has(x.lotteryId)) found.set(x.lotteryId, x); });
    } catch(e){ /* slow and flaky; search results are enough */ }
    return [...found.values()];
  }

  async function lotteryUnits(s){
    const id = s.lotteryId;
    const ad = await getJSON(HC_API + "Lottery/GetLotteryAdvertisement?lotteryId=" + id);
    const tiers = (await getJSON(HC_API + "LotteryConfig/GetAdvertisement4Rent?lotteryid=" + id)) || [];
    const b = (ad.lotteryBuildings || [{}])[0];
    const units = [];
    tiers.forEach(tier => (tier.unitTypes || []).forEach(u => {
      const sizes = cells(u.householdSize).map(c => Number((/\d+/.exec(c) || [])[0]));
      const ranges = cells(u.annualHouseholdIncome);
      units.push({
        unitSize: SIZES[(u.unitSize || "").toLowerCase()] || u.unitSize || "?",
        rent: money(u.monthlyRent), ami: money(tier.ami),
        limits: sizes.map((hh, i) => { const p = (ranges[i] || "").split("-"); return {hh, min: money(p[0]), max: money(p[1])}; })
      });
    }));
    return {
      id, name: (ad.lotteryName || s.lotteryName || "").trim(),
      address: [b.address, b.city].filter(Boolean).join(", "),
      borough: (s.borough || "").trim(), neighborhood: (s.neighborhood || "").trim(),
      deadline: (ad.endDate || "").slice(0, 10), units
    };
  }

  // true / false / null (unknown = maybe)
  function fits(unit, size, income){
    if(!size || !income) return null;
    const row = unit.limits.find(r => r.hh === size);
    if(!row) return null;
    if(row.min != null && income < row.min) return false;
    if(row.max != null && income > row.max) return false;
    return true;
  }

  function loadProfile(){ try{ return JSON.parse(localStorage.getItem(PROFILE_KEY)) || {}; }catch(e){ return {}; } }
  function saveProfile(p){ try{ localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); }catch(e){} }

  let lotteries = null; // detailed, cached

  async function loadLotteries(force){
    if(!force){
      try{
        const c = JSON.parse(localStorage.getItem(CACHE_KEY));
        if(c && Date.now() - c.t < CACHE_MS){ lotteries = c.data; return; }
      }catch(e){}
    }
    const list = await openLotteries();
    const out = [];
    for(let i = 0; i < list.length; i += 6){
      const batch = await Promise.allSettled(list.slice(i, i + 6).map(lotteryUnits));
      batch.forEach(r => { if(r.status === "fulfilled") out.push(r.value); });
    }
    lotteries = out;
    try{ localStorage.setItem(CACHE_KEY, JSON.stringify({t: Date.now(), data: out})); }catch(e){}
  }

  function lotteryHtml(l, size, income, onlyFit){
    const rows = l.units.map(u => ({u, f: fits(u, size, income)})).filter(x => !onlyFit || x.f !== false);
    if(!rows.length) return "";
    const badge = f => f === true ? '<span style="color:#2e9e5b">✓ fits</span>' : f === false ? '<span style="color:#c0392b">✗ out of range</span>' : '<span style="color:var(--muted)">? maybe</span>';
    const lim = u => { const r = u.limits.find(x => x.hh === size); return r ? `${fmt(r.min)} to ${fmt(r.max)}` : "set household size"; };
    return `<div class="aff-project">
      <div class="ap-name">${esc(l.name)}</div>
      <div class="ap-addr">${esc(l.address)}${l.neighborhood ? " · " + esc(l.neighborhood) : ""}</div>
      <div class="ap-meta"><span>${esc(l.borough)}</span>${l.deadline ? `<span>Deadline <strong>${esc(l.deadline)}</strong></span>` : ""}</div>
      <div class="ap-tiers">${rows.map(x => `<div>${esc(x.u.unitSize)} · ${fmt(x.u.rent)}/mo · ${x.u.ami || "?"}% AMI · income ${esc(lim(x.u))} ${badge(x.f)}</div>`).join("")}</div>
      <div class="ap-actions"><a href="${esc(HC_PAGE(l.id))}" target="_blank" rel="noopener">Housing Connect ↗</a></div>
    </div>`;
  }

  function renderLotteries(){
    const el = document.getElementById("liveLotteries");
    if(!lotteries){ return; }
    const size = Number(document.getElementById("liveHH").value) || null;
    const income = Number(document.getElementById("liveIncome").value) || null;
    const onlyFit = document.getElementById("liveOnlyFit").checked;
    const html = lotteries.map(l => lotteryHtml(l, size, income, onlyFit)).filter(Boolean).join("");
    el.innerHTML = html ? `<div class="aff-project-list">${html}</div>` : '<p class="hint">No open lotteries match.</p>';
  }

  async function runLotteries(force){
    const st = document.getElementById("liveStatus");
    st.innerHTML = '<span class="loading"><span class="spinner"></span> Loading open lotteries (can take up to a minute)…</span>';
    try{ await loadLotteries(force); st.textContent = lotteries.length + " open rental lotteries."; renderLotteries(); }
    catch(e){ st.innerHTML = '<span class="err">⚠ Housing Connect is slow or unavailable. Try again later.</span>'; }
  }

  async function runHdc(){
    const el = document.getElementById("liveHdc");
    el.innerHTML = '<span class="loading"><span class="spinner"></span> Loading HDC re-rentals…</span>';
    try{
      const data = await getJSON("/api/hdc", {}, 30000);
      const size = Number(document.getElementById("liveHH").value) || null;
      el.innerHTML = data.length ? `<div class="aff-project-list">${data.map(c => `<div class="aff-project">
        <div class="ap-name">${esc(c.building)}</div>
        <div class="ap-addr">${esc(c.address || "")} · ${esc(c.borough)}</div>
        <div class="ap-meta"><span>${esc(c.bedrooms || "?")}</span><span>${esc(c.rentRange || "rent n/a")}</span>${c.seniors ? "<span>Seniors only</span>" : ""}${c.accessible ? `<span>${esc(c.accessible)}</span>` : ""}</div>
        ${c.ad ? `<div class="ap-actions"><a href="${esc(c.ad)}" target="_blank" rel="noopener">Ad with income table ↗</a></div>` : ""}
      </div>`).join("")}</div>` : '<p class="hint">No HDC re-rentals listed right now.</p>';
    }catch(e){ el.innerHTML = '<span class="err">⚠ HDC unavailable right now.</span>'; }
  }

  async function runScout(){
    const el = document.getElementById("liveScout");
    el.innerHTML = '<span class="loading"><span class="spinner"></span> Loading scout picks…</span>';
    try{
      const data = await getJSON("/api/scout", {}, 20000);
      el.innerHTML = data.length ? `<div class="aff-project-list">${data.map(a => `<div class="aff-project">
        <div class="ap-name">${esc(a.address)}${a.unit ? " #" + esc(a.unit) : ""}</div>
        <div class="ap-addr">${esc(a.neighborhood)}</div>
        <div class="ap-meta"><span>${esc(a.beds)}</span><span><strong>${fmt(a.price)}</strong>/mo</span>${a.netEffective ? `<span>net ${fmt(a.netEffective)}</span>` : ""}${a.sqft ? `<span>${a.sqft} sqft</span>` : ""}${a.dateFound ? `<span>found ${esc(a.dateFound)}</span>` : ""}</div>
        ${a.notes ? `<div class="ap-tiers">${esc(a.notes)}</div>` : ""}
        ${a.link ? `<div class="ap-actions"><a href="${esc(a.link)}" target="_blank" rel="noopener">StreetEasy ↗</a></div>` : ""}
      </div>`).join("")}</div>` : '<p class="hint">No saved scout picks yet. Check Save? on rows in a daily tab and say sync saved.</p>';
    }catch(e){ el.innerHTML = '<span class="err">⚠ Scout sheet unavailable. Share it as "Anyone with the link can view".</span>'; }
  }

  function init(){
    const tab = document.getElementById("tab-affordable");
    if(!tab) return;
    const p = loadProfile();
    const box = document.createElement("div");
    box.className = "card";
    box.innerHTML = `
      <div class="section-title"><h2>Open Lotteries &amp; Re-rentals</h2></div>
      <p class="hint">Live rental lotteries from NYC Housing Connect and HDC re-rentals. Matching uses the income range for your household size, not the AMI label. Your details stay on this device.</p>
      <div class="row3" style="margin-top:14px;">
        <div class="field"><label for="liveHH">Household size</label>
          <select id="liveHH"><option value="">Any</option>${[1,2,3,4,5,6].map(n => `<option value="${n}"${p.hh == n ? " selected" : ""}>${n}</option>`).join("")}</select></div>
        <div class="field"><label for="liveIncome">Annual household income</label>
          <input type="number" id="liveIncome" min="0" step="1000" placeholder="e.g. 85000" value="${esc(p.income || "")}"></div>
        <div class="field"><label>&nbsp;</label><label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" id="liveOnlyFit"${p.onlyFit ? " checked" : ""}> Hide out of range</label></div>
      </div>
      <div class="actions"><button id="liveRefresh">Refresh lotteries</button></div>
      <div id="liveStatus" class="nearby-status"></div>
      <div id="liveLotteries"></div>
      <h3 style="margin-top:22px;">HDC re-rentals</h3>
      <div id="liveHdc"></div>
      <h3 style="margin-top:22px;">Daily apartment scout picks</h3>
      <p class="hint">Market-rate Manhattan picks saved from your daily StreetEasy scout sheet.</p>
      <div id="liveScout"></div>`;
    tab.insertBefore(box, tab.firstChild);
    const onChange = () => {
      saveProfile({hh: document.getElementById("liveHH").value, income: document.getElementById("liveIncome").value, onlyFit: document.getElementById("liveOnlyFit").checked});
      renderLotteries();
    };
    ["liveHH","liveIncome","liveOnlyFit"].forEach(id => document.getElementById(id).addEventListener("change", onChange));
    document.getElementById("liveRefresh").addEventListener("click", () => runLotteries(true));
    // Load when the tab is first opened
    let started = false;
    const start = () => { if(started) return; started = true; runLotteries(false); runHdc(); runScout(); };
    document.querySelectorAll('[data-tab="affordable"]').forEach(b => b.addEventListener("click", start));
    if(tab.classList.contains("active")) start();
  }

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  window.__affLive = {fits};
})();
