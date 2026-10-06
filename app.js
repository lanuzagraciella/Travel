/* Wanderpose: plan travel spots, walk them in the best order, and collect
 * pose inspiration to recreate at each one. Everything is stored on the
 * device: trips and settings in localStorage, uploaded photos in IndexedDB. */
(async () => {
  "use strict";

  const CATS = window.CATEGORIES;
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const WALK_M_PER_MIN = 80;   // ~4.8 km/h
  const DETOUR = 1.3;          // streets aren't straight lines
  const PHONE = () => window.innerWidth <= 720;

  // ---------- Persistence ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem("wp." + key); return v ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem("wp." + key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
    },
  };

  const db = (() => {
    let dbp;
    const open = () => dbp ||= new Promise((resolve, reject) => {
      const req = indexedDB.open("wanderpose", 1);
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore("photos", { keyPath: "id" });
        s.createIndex("spotId", "spotId");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = async (mode, fn) => {
      const d = await open();
      return new Promise((resolve, reject) => {
        const t = d.transaction("photos", mode);
        const r = fn(t.objectStore("photos"));
        t.oncomplete = () => resolve(r && r.result);
        t.onerror = () => reject(t.error);
      });
    };
    return {
      byspot: (spotId) => tx("readonly", (s) => s.index("spotId").getAll(spotId)),
      put: (photo) => tx("readwrite", (s) => s.put(photo)),
      del: (id) => tx("readwrite", (s) => s.delete(id)),
    };
  })();

  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function meters(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const walkMin = (a, b) => Math.max(1, Math.round((meters(a, b) * DETOUR) / WALK_M_PER_MIN));
  const fmtMin = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

  let toastTimer;
  function toast(msg, ms = 4000) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------- Trips ----------
  // Each trip is a city with its own spots, day plan and "got my shot" list.
  function seedTrip() {
    // Carry over data saved by the first version of the app (single city).
    const oldSpots = store.get("spots", null);
    return {
      id: "brussels",
      name: window.SEED_CITY.name,
      center: window.SEED_CITY.center,
      zoom: window.SEED_CITY.zoom,
      spots: oldSpots || structuredClone(window.SEED_SPOTS),
      plan: store.get("plan", null),
      done: store.get("done", []),
    };
  }

  const settings = store.get("settings", { googleKey: "", claudeKey: "" });
  const trips = store.get("trips", null) || [seedTrip()];
  const state = {
    trip: trips.find((t) => t.id === store.get("activeTrip", "")) || trips[0],
    selected: null,
    view: "plan",          // plan | spot | add | search | preview | trips | settings
    adding: false,
    pendingLatLng: null,
    candidate: null,       // place being previewed before adding
    results: [],
    lightbox: { photos: [], index: 0 },
  };

  const spots = () => state.trip.spots;
  const plan = () => state.trip.plan;
  const isDone = (id) => state.trip.done.includes(id);
  const setDone = (id, on) => {
    state.trip.done = state.trip.done.filter((x) => x !== id);
    if (on) state.trip.done.push(id);
  };
  const spotById = (id) => spots().find((s) => s.id === id);

  function save() {
    store.set("trips", trips);
    store.set("activeTrip", state.trip.id);
  }

  // Order the stops to minimise walking: nearest-neighbour from the first
  // stop, then 2-opt to untangle crossings. The first stop stays first.
  function optimize(ids) {
    const pts = ids.map(spotById).filter(Boolean);
    if (pts.length < 3) return pts.map((p) => p.id);
    const route = [pts[0]];
    const left = pts.slice(1);
    while (left.length) {
      const last = route[route.length - 1];
      let best = 0;
      left.forEach((p, i) => { if (meters(last, p) < meters(last, left[best])) best = i; });
      route.push(left.splice(best, 1)[0]);
    }
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 1; i < route.length - 1; i++) {
        for (let k = i + 1; k < route.length; k++) {
          const a = route[i - 1], b = route[i], c = route[k], d = route[k + 1];
          const before = meters(a, b) + (d ? meters(c, d) : 0);
          const after = meters(a, c) + (d ? meters(b, d) : 0);
          if (after + 0.5 < before) {
            route.splice(i, k - i + 1, ...route.slice(i, k + 1).reverse());
            improved = true;
          }
        }
      }
    }
    return route.map((p) => p.id);
  }
  if (!state.trip.plan) state.trip.plan = optimize(spots().filter((s) => s.category !== "stay").map((s) => s.id));

  function gmapsWalkUrl(stops) {
    const ll = (s) => `${s.lat},${s.lng}`;
    if (stops.length === 1) {
      const s = stops[0];
      return `https://www.google.com/maps/dir/?api=1&destination=${ll(s)}` +
        (s.placeId ? `&destination_place_id=${encodeURIComponent(s.placeId)}` : "") + "&travelmode=walking";
    }
    const mid = stops.slice(1, -1).slice(0, 9); // Google allows up to 9 waypoints
    return "https://www.google.com/maps/dir/?api=1&travelmode=walking" +
      `&origin=${ll(stops[0])}&destination=${ll(stops[stops.length - 1])}` +
      (mid.length ? `&waypoints=${encodeURIComponent(mid.map(ll).join("|"))}` : "");
  }
  const gmapsPlaceUrl = (s) => s.placeId
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.name)}&query_place_id=${encodeURIComponent(s.placeId)}`
    : `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}`;

  // Cover photo: Google place photo, else Wikipedia, else the first upload.
  const coverCache = store.get("covers", {});
  async function wikiCover(spot) {
    if (!spot.wiki) return null;
    if (coverCache[spot.wiki]) return coverCache[spot.wiki];
    try {
      const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(spot.wiki)}`);
      if (!r.ok) return null;
      const j = await r.json();
      const src = j.thumbnail?.source || j.originalimage?.source;
      if (src) { coverCache[spot.wiki] = src; store.set("covers", coverCache); }
      return src || null;
    } catch { return null; }
  }
  const imageLoads = (src) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
  });

  // ---------- Map ----------
  let map;
  const mapOpts = () => ({
    center: state.trip.center,
    zoom: state.trip.zoom || 14,
    googleKey: settings.googleKey,
    onClick: (ll) => {
      if (!state.adding) return;
      state.pendingLatLng = ll;
      setAdding(false);
      showAddForm();
    },
    onPlaceClick: (placeId) => { setAdding(false); showPreviewById(placeId); },
    onZoom: () => renderMarkers(),
    onGoogleFailure: (why) => {
      toast(`${why} Showing OpenStreetMap instead. Check your key in Settings (⚙).`, 8000);
      useOsmMap();
    },
  });
  function freshMapEl() {
    const old = $("map");
    const el = document.createElement("div");
    el.id = "map";
    el.className = "map";
    old.replaceWith(el);
    return el;
  }
  function useOsmMap() {
    const view = map ? { center: map.getCenter(), zoom: map.getZoom() } : null;
    map?.destroy();
    map = window.WPMaps.leafletMap(freshMapEl(), mapOpts());
    if (view) map.setView([view.center.lat, view.center.lng], view.zoom);
    renderMarkers();
  }

  function renderMarkers() {
    if (!map) return;
    const showNames = map.getZoom() >= 16;
    map.render(spots().map((spot) => {
      const idx = plan().indexOf(spot.id);
      const cat = CATS[spot.category] || CATS.sight;
      return {
        lat: spot.lat, lng: spot.lng, title: spot.name,
        label: idx >= 0 ? LETTERS[idx] || "•" : cat.emoji,
        color: cat.color,
        dim: idx < 0,
        selected: spot.id === state.selected,
        done: isDone(spot.id),
        showName: showNames,
        onClick: () => showSpot(spot.id),
      };
    }));
    map.setRoute(plan().map(spotById).filter(Boolean));
  }

  function setAdding(on) {
    state.adding = on;
    document.body.classList.toggle("adding", on);
    $("add-hint").hidden = !on;
  }

  // ---------- Panel ----------
  const panel = $("panel");
  const body = $("panel-body");
  const setPanel = (s) => { panel.dataset.state = s; setTimeout(() => map?.resize(), 280); };
  const openPanel = () => { if (panel.dataset.state === "closed") setPanel("open"); };
  function setHeading(text, back = true) {
    $("panel-heading").textContent = text;
    $("btn-back").hidden = !back;
  }

  function updateHeader() {
    $("city-name").textContent = state.trip.name;
    const inPlan = plan().length;
    const got = plan().filter(isDone).length;
    $("progress-bar").style.width = inPlan ? `${(got / inPlan) * 100}%` : "0";
    $("progress-text").textContent = inPlan ? `📸 ${got} of ${inPlan} spots photographed` : "Plan your spots and your shots";
  }

  function rerender() {
    save();
    renderMarkers();
    updateHeader();
    if (state.view === "plan") showPlan(false);
    else if (state.view === "spot" && state.selected) showSpot(state.selected, false, false);
  }

  // ----- My day -----
  function showPlan(open = true) {
    state.view = "plan";
    state.selected = null;
    setHeading(`My day in ${state.trip.name}`, false);
    const stops = plan().map(spotById).filter(Boolean);
    let total = 0, dist = 0;
    stops.forEach((s, i) => { if (i) { total += walkMin(stops[i - 1], s); dist += meters(stops[i - 1], s) * DETOUR; } });

    const rows = stops.map((s, i) => {
      const cat = CATS[s.category] || CATS.sight;
      const leg = i ? `<li class="leg">↓ ${walkMin(stops[i - 1], s)} min walk</li>` : "";
      return `${leg}<li data-id="${esc(s.id)}">
        <span class="stop-letter" style="background:${cat.color}">${LETTERS[i] || "•"}</span>
        <span class="stop-main"><div class="stop-name">${esc(s.name)}</div>
          <div class="stop-meta">${cat.emoji} ${cat.label}${isDone(s.id) ? ' · <span class="stop-done">✓ shot taken</span>' : ""}</div></span>
        <button class="mini" data-up="${i}" title="Move up" aria-label="Move up">▲</button>
        <button class="mini" data-down="${i}" title="Move down" aria-label="Move down">▼</button>
        <button class="mini" data-remove="${esc(s.id)}" title="Remove from day" aria-label="Remove">✕</button>
      </li>`;
    }).join("");

    const unplanned = spots().filter((s) => !plan().includes(s.id));
    body.innerHTML = `
      <div class="section">
        <div class="plan-summary">
          <span><b>${stops.length}</b> stops</span>
          <span><b>${fmtMin(total)}</b> walking</span>
          <span><b>${fmtDist(dist)}</b></span>
        </div>
        <div class="actions">
          ${stops.length > 2 ? `<button class="btn primary" id="btn-optimize">✨ Optimize route</button>` : ""}
          ${stops.length ? `<a class="btn" target="_blank" rel="noopener" href="${gmapsWalkUrl(stops)}">Walk it in Google Maps</a>` : ""}
          <button class="btn" id="btn-find">🔍 Add spots</button>
        </div>
      </div>
      ${stops.length ? `<ul class="plain stops">${rows}</ul>`
        : `<p class="empty">Your day is empty. Search for places with “🔍 Add spots”${map?.kind === "google" ? ", or tap any place on the map" : ""}.</p>`}
      ${unplanned.length ? `<div class="section"><h3>Saved, not in today's plan</h3><ul class="plain nearby">
        ${unplanned.map((s) => `<li data-id="${esc(s.id)}"><span class="dot" style="background:${(CATS[s.category] || CATS.sight).color}"></span>
          <span class="nearby-name">${esc(s.name)}</span><button class="mini" data-addplan="${esc(s.id)}">＋ Add</button></li>`).join("")}
      </ul></div>` : ""}`;
    if (open) openPanel();
  }

  // ----- Spot details -----
  function detailsHtml(s) {
    return `
      ${s.rating ? `<p>⭐ <b>${s.rating.toFixed(1)}</b>${s.ratingCount ? ` <span class="muted">(${s.ratingCount.toLocaleString()} Google reviews)</span>` : ""}</p>` : ""}
      ${s.address ? `<p>📍 ${esc(s.address)}</p>` : ""}
      ${s.phone ? `<p>📞 <a href="tel:${esc(s.phone.replace(/\s/g, ""))}">${esc(s.phone)}</a></p>` : ""}
      ${s.website ? `<p>🔗 <a href="${esc(s.website)}" target="_blank" rel="noopener">${esc(s.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a></p>` : ""}`;
  }

  async function showSpot(id, open = true, pan = true) {
    const spot = spotById(id);
    if (!spot) return;
    state.view = "spot";
    state.selected = id;
    renderMarkers();
    setHeading(spot.name);
    const cat = CATS[spot.category] || CATS.sight;
    const inPlan = plan().includes(id);

    const nearby = spots()
      .filter((s) => s.id !== id)
      .map((s) => ({ s, d: meters(spot, s) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 5);

    body.innerHTML = `
      <div class="hero" id="hero"><span class="hero-emoji">${cat.emoji}</span><div class="hero-band">${esc(spot.name)}</div></div>
      <div class="section" id="spot-details">
        <span class="chip">${cat.emoji} ${cat.label}</span>
        ${detailsHtml(spot)}
        ${spot.bestTime ? `<p>🕒 <b>Best light:</b> ${esc(spot.bestTime)}</p>` : ""}
        <div class="actions">
          <button class="btn ${inPlan ? "" : "primary"}" id="btn-toggle-plan">${inPlan ? "✓ In my day" : "＋ Add to my day"}</button>
          <a class="btn" target="_blank" rel="noopener" href="${gmapsWalkUrl([spot])}">Directions</a>
          <a class="btn" target="_blank" rel="noopener" href="${gmapsPlaceUrl(spot)}">Open in Google Maps</a>
          <label class="btn check"><input type="checkbox" id="chk-done" ${isDone(id) ? "checked" : ""}/> Got my shot</label>
        </div>
      </div>
      <div class="section">
        <h3>Pose inspiration</h3>
        <div class="gallery" id="gallery"></div>
        <p class="hint">Save photos you love from Instagram or Pinterest and upload them here. Tap one, then <b>✨ How do I take this?</b> for step-by-step phone camera directions.</p>
      </div>
      ${spot.poses?.length ? `<div class="section"><h3>Shot ideas</h3><ul class="plain poses">${spot.poses.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}
      ${nearby.length ? `<div class="section">
        <h3>Walking distance from here</h3>
        <ul class="plain nearby">${nearby.map(({ s, d }) => `<li data-id="${esc(s.id)}">
          <span class="dot" style="background:${(CATS[s.category] || CATS.sight).color}"></span>
          <span class="nearby-name">${esc(s.name)}</span>
          <span class="walk">🚶 ${walkMin(spot, s)} min · ${fmtDist(d * DETOUR)}</span></li>`).join("")}</ul>
      </div>` : ""}
      <div class="section"><button class="btn danger" id="btn-delete-spot">Remove this spot from the trip</button></div>`;
    if (open) openPanel();
    if (pan) map.panTo(spot.lat, spot.lng, PHONE() ? (window.innerHeight * 0.58) / 2 : 0);

    renderGallery(id);

    // Pull Google details for spots that don't have them yet (once per spot).
    if (await window.WPPlaces.enrichFromGoogle(spot, state.trip.name)) {
      save();
      if (state.selected !== id) return;
      showSpot(id, false, false);
      return;
    }
    setHeroImage(spot, id);
  }

  async function setHeroImage(spot, id) {
    const photos = await db.byspot(id).catch(() => []);
    const candidates = [
      spot.photoUrl && { src: spot.photoUrl, credit: "Google Maps" },
      { lazy: () => wikiCover(spot), credit: "Wikipedia" },
      photos[0] && { src: urlFor(photos[0]), credit: "" },
    ].filter(Boolean);
    for (const c of candidates) {
      const src = c.src || await c.lazy();
      if (!src || !(await imageLoads(src))) continue;
      const hero = $("hero");
      if (!hero || state.selected !== id) return;
      hero.style.backgroundImage = `url("${src}")`;
      hero.querySelector(".hero-emoji").textContent = "";
      if (c.credit) hero.insertAdjacentHTML("beforeend", `<span class="hero-credit">${c.credit}</span>`);
      return;
    }
  }

  // Object URLs for stored photos, reused so thumbnails don't flicker.
  const urls = new Map();
  const urlFor = (p) => { if (!urls.has(p.id)) urls.set(p.id, URL.createObjectURL(p.blob)); return urls.get(p.id); };

  async function renderGallery(spotId) {
    const el = $("gallery");
    if (!el) return;
    const photos = (await db.byspot(spotId).catch(() => [])).sort((a, b) => a.createdAt - b.createdAt);
    if (state.selected !== spotId) return;
    el.innerHTML = photos.map((p, i) => `
      <div class="thumb" role="button" tabindex="0" data-open="${i}">
        <img src="${urlFor(p)}" alt="Pose inspiration ${i + 1}" loading="lazy" />
        ${p.recreated ? `<span class="badge">✓ Recreated</span>` : ""}
        ${p.guide ? `<span class="badge ai">✨ Guide</span>` : ""}
        <button class="del" data-del="${esc(p.id)}" aria-label="Delete photo">✕</button>
      </div>`).join("") +
      `<button class="thumb add" id="btn-upload">＋<br/>Add inspo photos</button>`;
    state.lightbox.photos = photos;
  }

  // ----- Find places -----
  function showSearch(query = "") {
    state.view = "search";
    state.selected = null;
    renderMarkers();
    setHeading(`Add spots in ${state.trip.name}`);
    const google = map.kind === "google";
    body.innerHTML = `
      <form class="section form" id="search-form">
        <label for="q">Search places</label>
        <div class="search-row">
          <input id="q" type="search" placeholder="e.g. rooftop bar, flower market, Louvre" value="${esc(query)}" autocomplete="off" />
          <button class="btn primary" type="submit">Search</button>
        </div>
        <p class="hint">${google
          ? "Results come from Google Maps. You can also tap any place on the map to add it."
          : "Results come from OpenStreetMap. Add a Google Maps key in Settings (⚙) for Google's places, photos and ratings."}</p>
        <div class="actions"><button class="btn" type="button" id="btn-drop-pin">📍 Drop a pin on the map instead</button></div>
      </form>
      <ul class="plain results" id="results"></ul>`;
    openPanel();
    $("q").focus();
    if (state.results.length && query) renderResults();
  }

  function renderResults() {
    const el = $("results");
    if (!el) return;
    el.innerHTML = state.results.length
      ? state.results.map((r, i) => {
        const cat = CATS[r.category] || CATS.sight;
        const saved = !!spotById(r.id);
        return `<li data-result="${i}">
          <span class="dot" style="background:${cat.color}"></span>
          <span class="stop-main"><div class="stop-name">${esc(r.name)}</div>
            <div class="stop-meta">${r.rating ? `⭐ ${r.rating.toFixed(1)} · ` : ""}${esc(r.address)}</div></span>
          ${saved ? `<span class="muted">Saved</span>` : `<button class="mini" data-quickadd="${i}">＋ Add</button>`}
        </li>`;
      }).join("")
      : `<li class="empty">No places found. Try a different name.</li>`;
  }

  async function runSearch(q) {
    if (!q.trim()) return;
    $("results").innerHTML = `<li class="empty">Searching…</li>`;
    try {
      state.results = await window.WPPlaces.searchPlaces(q.trim(), map.getCenter());
      state.lastQuery = q;
    } catch (err) {
      state.results = [];
      toast(err.message || "Search failed");
    }
    renderResults();
  }

  function addSpot(spot, toPlan = true) {
    if (spotById(spot.id)) return spotById(spot.id);
    const s = { ...spot, poses: spot.poses || [] };
    spots().push(s);
    if (toPlan) plan().push(s.id);
    save();
    renderMarkers();
    updateHeader();
    return s;
  }

  // ----- Preview a place before adding it -----
  async function showPreviewById(placeId) {
    const existing = spots().find((s) => s.placeId === placeId);
    if (existing) return showSpot(existing.id);
    try {
      showPreview(await window.WPPlaces.placeById(placeId));
    } catch {
      toast("Couldn't load that place from Google Maps.");
    }
  }

  function showPreview(place) {
    state.view = "preview";
    state.candidate = place;
    state.selected = null;
    renderMarkers();
    setHeading(place.name);
    const cat = CATS[place.category] || CATS.sight;
    body.innerHTML = `
      <div class="hero" id="hero" ${place.photoUrl ? `style="background-image:url('${esc(place.photoUrl)}')"` : ""}>
        <span class="hero-emoji">${place.photoUrl ? "" : cat.emoji}</span><div class="hero-band">${esc(place.name)}</div>
        ${place.photoUrl ? `<span class="hero-credit">Google Maps</span>` : ""}
      </div>
      <div class="section">
        <span class="chip">${cat.emoji} ${cat.label}</span>
        ${detailsHtml(place)}
        <div class="actions">
          <button class="btn primary" id="btn-add-candidate">＋ Add to my day</button>
          <button class="btn" id="btn-save-candidate">Save for later</button>
          <a class="btn" target="_blank" rel="noopener" href="${gmapsPlaceUrl(place)}">Open in Google Maps</a>
        </div>
      </div>`;
    openPanel();
    map.panTo(place.lat, place.lng, PHONE() ? (window.innerHeight * 0.58) / 2 : 0);
  }

  // ----- Custom pin -----
  function showAddForm() {
    state.view = "add";
    state.selected = null;
    setHeading("New spot");
    body.innerHTML = `
      <form class="section form" id="add-form">
        <label for="f-name">Name</label>
        <input id="f-name" required placeholder="e.g. Pink door café" />
        <label for="f-cat">Type</label>
        <select id="f-cat">${Object.entries(CATS).map(([k, c]) => `<option value="${k}" ${k === "photo" ? "selected" : ""}>${c.emoji} ${c.label}</option>`).join("")}</select>
        <label for="f-addr">Address (optional)</label>
        <input id="f-addr" />
        <label for="f-time">Best time / light (optional)</label>
        <input id="f-time" placeholder="e.g. Sunrise, before the crowds" />
        <label for="f-poses">Shot ideas (one per line, optional)</label>
        <textarea id="f-poses" rows="3"></textarea>
        <div class="actions"><button class="btn primary" type="submit">Save spot</button></div>
      </form>`;
    openPanel();
    $("f-name").focus();
    $("add-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const { lat, lng } = state.pendingLatLng;
      const s = addSpot({
        id: uid("c-"),
        name: $("f-name").value.trim() || "My spot",
        category: $("f-cat").value,
        lat, lng,
        address: $("f-addr").value.trim(),
        bestTime: $("f-time").value.trim(),
        poses: $("f-poses").value.split("\n").map((x) => x.trim()).filter(Boolean),
      });
      showSpot(s.id);
    });
  }

  // ----- Trips (city picker) -----
  function showTrips() {
    state.view = "trips";
    state.selected = null;
    setHeading("My trips");
    body.innerHTML = `
      <ul class="plain stops">${trips.map((t) => `
        <li data-trip="${esc(t.id)}" class="${t.id === state.trip.id ? "current" : ""}">
          <span class="stop-letter" style="background:var(--plum)">${esc(t.name.slice(0, 1).toUpperCase())}</span>
          <span class="stop-main"><div class="stop-name">${esc(t.name)}</div>
            <div class="stop-meta">${t.spots.length} spots · ${(t.plan || []).length} in plan${t.id === state.trip.id ? " · <b>open now</b>" : ""}</div></span>
          ${trips.length > 1 ? `<button class="mini" data-deltrip="${esc(t.id)}" title="Delete trip" aria-label="Delete trip">🗑</button>` : ""}
        </li>`).join("")}
      </ul>
      <form class="section form" id="city-form">
        <label for="city-q">Plan a new trip</label>
        <div class="search-row">
          <input id="city-q" type="search" placeholder="City, e.g. Paris, Kyoto, Lisbon" autocomplete="off" />
          <button class="btn primary" type="submit">Find</button>
        </div>
      </form>
      <ul class="plain results" id="city-results"></ul>`;
    openPanel();
  }

  async function findCities(q) {
    const el = $("city-results");
    el.innerHTML = `<li class="empty">Searching…</li>`;
    try {
      state.cityResults = await window.WPPlaces.searchCities(q.trim());
    } catch (err) {
      state.cityResults = [];
      toast(err.message || "Search failed");
    }
    el.innerHTML = state.cityResults.length
      ? state.cityResults.map((c, i) => `<li data-city="${i}"><span class="dot" style="background:var(--plum)"></span>
          <span class="stop-main"><div class="stop-name">${esc(c.name)}</div><div class="stop-meta">${esc(c.label)}</div></span>
          <button class="mini" data-city="${i}">Start trip →</button></li>`).join("")
      : `<li class="empty">No cities found.</li>`;
  }

  function switchTrip(trip) {
    state.trip = trip;
    trip.plan ||= [];
    trip.done ||= [];
    state.selected = null;
    state.results = [];
    save();
    map.setView(trip.center, trip.zoom || 14);
    renderMarkers();
    updateHeader();
  }

  async function deleteTrip(id) {
    const t = trips.find((x) => x.id === id);
    if (!t || !confirm(`Delete your ${t.name} trip and its photos?`)) return;
    for (const s of t.spots) for (const p of await db.byspot(s.id).catch(() => [])) await db.del(p.id);
    trips.splice(trips.indexOf(t), 1);
    if (state.trip === t) switchTrip(trips[0]);
    save();
    showTrips();
  }

  // ----- Settings -----
  function showSettings() {
    state.view = "settings";
    state.selected = null;
    setHeading("Settings");
    body.innerHTML = `
      <form class="section form" id="settings-form">
        <h3>Google Maps</h3>
        <p class="hint">Shows the real Google map, Google's places, photos and ratings. Create a key in
          <a href="https://console.cloud.google.com/google/maps-apis/credentials" target="_blank" rel="noopener">Google Cloud</a>,
          then enable <b>Maps JavaScript API</b> and <b>Places API (New)</b> for it. Restrict the key to your site's address.</p>
        <label for="s-google">Google Maps API key</label>
        <input id="s-google" type="password" autocomplete="off" value="${esc(settings.googleKey)}" placeholder="AIza…" />
        <p class="hint">Map now: <b>${map.kind === "google" ? "Google Maps ✓" : "OpenStreetMap"}</b></p>

        <h3 style="margin-top:20px">AI photo coach</h3>
        <p class="hint">Upload an inspiration photo and Claude explains how to take it with your phone. Create a key at
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>.
          Each guide costs a few cents of API credit.</p>
        <label for="s-claude">Claude API key</label>
        <input id="s-claude" type="password" autocomplete="off" value="${esc(settings.claudeKey)}" placeholder="sk-ant-…" />

        <p class="hint">🔒 Keys are saved only in this browser on this device. They're never added to the code or uploaded anywhere except to Google and Anthropic.</p>
        <div class="actions"><button class="btn primary" type="submit">Save</button></div>
      </form>`;
    openPanel();
  }

  // ---------- Lightbox + AI photo coach ----------
  function openLightbox(i) {
    state.lightbox.index = i;
    drawLightbox();
    $("lightbox").hidden = false;
  }
  function drawLightbox() {
    const { photos, index } = state.lightbox;
    const p = photos[index];
    if (!p) return;
    $("lb-img").src = urlFor(p);
    $("lb-done").checked = !!p.recreated;
    $("lb-prev").hidden = photos.length < 2;
    $("lb-next").hidden = photos.length < 2;
    $("lb-ai").textContent = p.guide ? "✨ Show photo guide" : "✨ How do I take this?";
    $("lb-ai").disabled = false;
    $("lb-guide").hidden = true;
    $("lightbox").classList.remove("with-guide");
  }
  const stepLightbox = (d) => {
    const n = state.lightbox.photos.length;
    state.lightbox.index = (state.lightbox.index + d + n) % n;
    drawLightbox();
  };

  function guideHtml(g) {
    const items = (arr) => (arr || []).map((x) => `<li>${esc(x)}</li>`).join("");
    const c = g.camera || {};
    return `
      <div class="guide-head"><span class="chip">${esc(g.shot_type)}</span><p>${esc(g.summary)}</p></div>
      <div class="guide-grid">
        <div><span>Lens</span><b>${esc(c.lens)}</b></div>
        <div><span>Orientation</span><b>${esc(c.orientation)}</b></div>
        <div><span>Mode</span><b>${esc(c.mode)}</b></div>
        <div><span>Phone height</span><b>${esc(c.height)}</b></div>
        <div><span>Angle</span><b>${esc(c.angle)}</b></div>
        <div><span>Distance</span><b>${esc(c.distance)}</b></div>
      </div>
      <h4>📱 Phone settings</h4><ul>${items(c.settings)}</ul>
      <h4>🧍‍♀️ Pose</h4><ul>${items(g.pose)}</ul>
      <h4>🖼️ Composition</h4><ul>${items(g.composition)}</ul>
      <h4>☀️ Light</h4><p>${esc(g.lighting)}</p>
      <h4>✅ For whoever holds the phone</h4><ol>${items(g.photographer_steps)}</ol>
      <h4>🎨 Edit to match</h4><ul>${items(g.edit_tips)}</ul>
      <p class="pro-tip">💡 ${esc(g.pro_tip)}</p>
      <p class="hint">Made by Claude (AI). Double-check it on location.</p>`;
  }

  function showGuide(g) {
    $("lb-guide").innerHTML = guideHtml(g);
    $("lb-guide").hidden = false;
    $("lb-guide").scrollTop = 0;
    $("lightbox").classList.add("with-guide");
  }

  async function aiGuide() {
    const p = state.lightbox.photos[state.lightbox.index];
    if (!p) return;
    if (p.guide) return showGuide(p.guide);
    if (!settings.claudeKey) {
      $("lightbox").hidden = true;
      showSettings();
      toast("Add your Claude API key to use the AI photo coach.");
      return;
    }
    const btn = $("lb-ai");
    btn.disabled = true;
    btn.textContent = "✨ Studying the photo…";
    const spot = spotById(p.spotId);
    try {
      const guide = await window.WPAI.photoGuide({
        apiKey: settings.claudeKey,
        blob: p.blob,
        spotName: spot?.name,
        cityName: state.trip.name,
        bestTime: spot?.bestTime,
      });
      p.guide = guide;
      await db.put(p);
      if (state.lightbox.photos[state.lightbox.index] === p) {
        showGuide(guide);
        btn.textContent = "✨ Show photo guide";
      }
      renderGallery(p.spotId);
    } catch (err) {
      toast(err.message, 7000);
      btn.textContent = "✨ How do I take this?";
    } finally {
      btn.disabled = false;
    }
  }

  $("lb-close").onclick = () => { $("lightbox").hidden = true; };
  $("lb-prev").onclick = () => stepLightbox(-1);
  $("lb-next").onclick = () => stepLightbox(1);
  $("lb-ai").onclick = aiGuide;
  $("lb-done").onchange = async (e) => {
    const p = state.lightbox.photos[state.lightbox.index];
    p.recreated = e.target.checked;
    await db.put(p);
    if (p.recreated) setDone(p.spotId, true);
    rerender();
  };
  document.addEventListener("keydown", (e) => {
    if ($("lightbox").hidden) { if (e.key === "Escape" && state.adding) setAdding(false); return; }
    if (e.key === "Escape") $("lightbox").hidden = true;
    if (e.key === "ArrowLeft") stepLightbox(-1);
    if (e.key === "ArrowRight") stepLightbox(1);
  });

  // ---------- Events ----------
  $("file-input").addEventListener("change", async (e) => {
    const spotId = state.selected;
    const files = [...e.target.files];
    e.target.value = "";
    if (!spotId) return;
    for (const f of files) {
      await db.put({ id: crypto.randomUUID(), spotId, blob: f, createdAt: Date.now(), recreated: false });
    }
    await renderGallery(spotId);
    if (files.length === 1) openLightbox(state.lightbox.photos.length - 1);
  });

  body.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (e.target.id === "search-form") return runSearch($("q").value);
    if (e.target.id === "city-form") return findCities($("city-q").value);
    if (e.target.id === "settings-form") {
      const googleChanged = $("s-google").value.trim() !== settings.googleKey;
      settings.googleKey = $("s-google").value.trim();
      settings.claudeKey = $("s-claude").value.trim();
      store.set("settings", settings);
      if (googleChanged) { location.reload(); return; }
      toast("Saved ✓");
      showPlan();
    }
  });

  body.addEventListener("click", async (e) => {
    const t = e.target.closest("button, a, li[data-id], li[data-result], li[data-trip], li[data-city], .thumb, input");
    if (!t || t.tagName === "A") return;
    const d = t.dataset;

    if (t.id === "btn-optimize") { state.trip.plan = optimize(plan()); return rerender(); }
    if (t.id === "btn-find") return showSearch();
    if (t.id === "btn-drop-pin") { setAdding(true); if (PHONE()) setPanel("closed"); return; }
    if (t.id === "btn-upload") return $("file-input").click();
    if (t.id === "btn-toggle-plan") {
      const id = state.selected;
      state.trip.plan = plan().includes(id) ? plan().filter((x) => x !== id) : [...plan(), id];
      return rerender();
    }
    if (t.id === "chk-done") { setDone(state.selected, t.checked); return rerender(); }
    if (t.id === "btn-add-candidate" || t.id === "btn-save-candidate") {
      const s = addSpot(state.candidate, t.id === "btn-add-candidate");
      toast(`${s.name} added to ${state.trip.name}`);
      return showSpot(s.id);
    }
    if (t.id === "btn-delete-spot") {
      if (!confirm("Remove this spot and its photos from the trip?")) return;
      const id = state.selected;
      for (const p of await db.byspot(id)) await db.del(p.id);
      state.trip.spots = spots().filter((s) => s.id !== id);
      state.trip.plan = plan().filter((x) => x !== id);
      setDone(id, false);
      save();
      renderMarkers();
      updateHeader();
      return showPlan();
    }
    if (d.del) {
      e.stopPropagation();
      if (!confirm("Remove this photo?")) return;
      await db.del(d.del);
      URL.revokeObjectURL(urls.get(d.del)); urls.delete(d.del);
      return renderGallery(state.selected);
    }
    if (d.open !== undefined) return openLightbox(Number(d.open));
    if (d.up !== undefined || d.down !== undefined) {
      const i = Number(d.up ?? d.down), j = d.up !== undefined ? i - 1 : i + 1;
      if (j < 0 || j >= plan().length) return;
      [plan()[i], plan()[j]] = [plan()[j], plan()[i]];
      return rerender();
    }
    if (d.remove) { state.trip.plan = plan().filter((x) => x !== d.remove); return rerender(); }
    if (d.addplan) { plan().push(d.addplan); return rerender(); }
    if (d.quickadd !== undefined) {
      const s = addSpot(state.results[Number(d.quickadd)]);
      toast(`${s.name} added to your day`);
      return renderResults();
    }
    if (d.result !== undefined) {
      const r = state.results[Number(d.result)];
      return spotById(r.id) ? showSpot(r.id) : showPreview(r);
    }
    if (d.deltrip) return deleteTrip(d.deltrip);
    if (d.trip) {
      switchTrip(trips.find((x) => x.id === d.trip));
      return showPlan();
    }
    if (d.city !== undefined) {
      const c = state.cityResults[Number(d.city)];
      const trip = { id: uid("t-"), name: c.name, center: c.center, zoom: 14, spots: [], plan: [], done: [] };
      trips.push(trip);
      switchTrip(trip);
      toast(`New trip: ${trip.name}. Search for the spots you want to see.`);
      return showSearch();
    }
    if (d.id) return showSpot(d.id);
  });
  body.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.dataset.open !== undefined) openLightbox(Number(e.target.dataset.open));
  });

  const toggleView = (view, show) => () => {
    if (state.view === view && panel.dataset.state !== "closed") return setPanel("closed");
    show();
    renderMarkers();
  };
  $("btn-plan").onclick = toggleView("plan", showPlan);
  $("btn-trips").onclick = toggleView("trips", showTrips);
  $("btn-settings").onclick = toggleView("settings", showSettings);
  $("btn-add").onclick = () => { setAdding(false); showSearch(); };
  $("btn-back").onclick = () => {
    if (state.view === "preview" && state.lastQuery) return showSearch(state.lastQuery);
    showPlan(); renderMarkers();
  };
  $("btn-close").onclick = () => { setPanel("closed"); state.selected = null; renderMarkers(); };
  $("btn-expand").onclick = () => {
    const expanded = panel.dataset.state === "expanded";
    setPanel(expanded ? "open" : "expanded");
    $("btn-expand").textContent = expanded ? "⤢" : "⤡";
    $("btn-expand").title = expanded ? "Expand" : "Shrink";
  };
  $("panel-grip").onclick = () => $("btn-expand").click();
  $("btn-cancel-add").onclick = () => setAdding(false);

  // ---------- Boot ----------
  save();
  updateHeader();
  map = await window.WPMaps.createMap($("map"), mapOpts());
  renderMarkers();
  showPlan(!PHONE());
  if (!settings.googleKey && !store.get("hintShown", false)) {
    store.set("hintShown", true);
    toast("Tip: add a Google Maps key in Settings (⚙) to use the real Google map.", 7000);
  }
})();
