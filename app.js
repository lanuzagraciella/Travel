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
  // Add each ready-made trip once. One the user deletes stays deleted.
  const seeded = store.get("seeded", ["brussels"]);
  for (const t of window.SEED_TRIPS || []) {
    if (seeded.includes(t.id)) continue;
    seeded.push(t.id);
    if (!trips.some((x) => x.id === t.id)) trips.push({ ...structuredClone(t), plan: null, done: [] });
  }
  store.set("seeded", seeded);
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

  // Order the stops to minimise walking: nearest-neighbour from the trip's
  // start point (or the first stop if none is set), then 2-opt to untangle
  // crossings. The start always stays first.
  function optimize(ids, start = state.trip.start) {
    const pts = ids.map(spotById).filter(Boolean);
    if (!start && pts.length < 3) return pts.map((p) => p.id);
    const route = [start ? { id: null, lat: start.lat, lng: start.lng } : pts[0]];
    const left = start ? pts.slice() : pts.slice(1);
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
    return route.map((p) => p.id).filter((id) => id !== null);
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
      const m = /^([a-z]{2,3}):(.+)$/.exec(spot.wiki);
      const [lang, title] = m ? [m[1], m[2]] : ["en", spot.wiki];
      const r = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`);
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
      const mode = state.adding;
      setAdding(false);
      if (mode === "start") return setStart({ name: "Pinned start point", ...ll });
      state.pendingLatLng = ll;
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
    const pins = spots().map((spot) => {
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
    });
    const start = state.trip.start;
    if (start) {
      pins.push({
        lat: start.lat, lng: start.lng, title: `Start: ${start.name}`,
        label: "🏁", color: "#23161f", selected: false, done: false, showName: showNames,
        onClick: () => { showPlan(); renderMarkers(); },
      });
    }
    map.render(pins);
    map.setRoute([start, ...plan().map(spotById)].filter(Boolean));
  }

  // on: false | true (add a spot) | "start" (pick the start point)
  function setAdding(on) {
    state.adding = on;
    document.body.classList.toggle("adding", !!on);
    $("add-hint").hidden = !on;
    $("add-hint-text").textContent = on === "start" ? "Tap the map where you'll start" : "Tap the map where your spot is";
    $("btn-pin").hidden = on;
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

  // ----- Popular photo spots -----
  // toPlan: put the new spots straight into the day plan (used for new trips).
  async function addPopularSpots(toPlan) {
    const trip = state.trip;
    const btn = $("btn-popular");
    if (btn) { btn.disabled = true; btn.textContent = "✨ Finding spots…"; }
    toast(`Finding popular photo spots in ${trip.name}…`, 15000);
    try {
      const center = { lat: trip.center[0], lng: trip.center[1] };
      const found = await window.WPPlaces.popularSpots(center, trip.name);
      if (state.trip !== trip) return;
      const fresh = found.filter((f) => !spotById(f.id) &&
        !spots().some((s) => s.name.toLowerCase() === f.name.toLowerCase() || meters(s, f) < 40));
      for (const f of fresh) {
        spots().push({ ...f, poses: [] });
        if (toPlan) plan().push(f.id);
      }
      if (toPlan) trip.plan = optimize(plan());
      save();
      renderMarkers();
      updateHeader();
      if (state.view === "plan") showPlan(false);
      toast(fresh.length
        ? `Added ${fresh.length} popular spots${toPlan ? " to your day" : ". Tap ＋ Add to put them in your day"} ✨`
        : "No new popular spots found nearby.");
    } catch (err) {
      toast(err.message || "Couldn't load popular spots right now.");
    } finally {
      const b = $("btn-popular");
      if (b) { b.disabled = false; b.textContent = "✨ Find popular spots"; }
    }
  }

  // ----- Start point (hotel, station, current location) -----
  function startHtml(start) {
    if (start && !state.editingStart) {
      return `<div class="section start-box">
        <div class="start-row"><span class="stop-letter start-letter">🏁</span>
          <span class="stop-main"><div class="stop-name">Start: ${esc(start.name)}</div>
            <div class="stop-meta">Your tour is ordered from here</div></span>
          <button class="mini" id="start-change">Change</button>
          <button class="mini" id="start-clear" title="Remove start point" aria-label="Remove start point">✕</button></div>
      </div>`;
    }
    return `<form class="section form start-box" id="start-form">
      <h3>🏁 Where do you start?</h3>
      <p class="hint">Your hotel, the station, or where you are now. The app orders your stops into the shortest walking tour from there.</p>
      <div class="actions" style="margin-top:4px">
        <button class="btn" type="button" id="start-locate">📍 My location</button>
        <button class="btn" type="button" id="start-pick">Tap on map</button>
        ${start ? `<button class="btn" type="button" id="start-cancel">Cancel</button>` : ""}
      </div>
      <div class="search-row" style="margin-top:10px">
        <input id="start-q" type="search" placeholder="Hotel, station or address" autocomplete="off" />
        <button class="btn primary" type="submit">Find</button>
      </div>
      <ul class="plain results" id="start-results"></ul>
    </form>`;
  }

  // With a start point set, every new stop slots into the shortest tour.
  function addToPlan(id) {
    if (plan().includes(id)) return;
    plan().push(id);
    if (state.trip.start) state.trip.plan = optimize(plan());
  }

  function setStart(start) {
    state.trip.start = start;
    state.editingStart = false;
    state.trip.plan = optimize(plan());
    save();
    renderMarkers();
    updateHeader();
    showPlan();
    if (start) {
      map.panTo(start.lat, start.lng, PHONE() ? (window.innerHeight * 0.58) / 2 : 0);
      toast(plan().length ? `Tour optimized from ${start.name} ✨` : `Start set: ${start.name}`);
    }
  }

  async function findStart(q) {
    const el = $("start-results");
    if (!q.trim() || !el) return;
    el.innerHTML = `<li class="empty">Searching…</li>`;
    try {
      state.startResults = await window.WPPlaces.searchPlaces(q.trim(), map.getCenter());
    } catch (err) {
      state.startResults = [];
      toast(err.message || "Search failed");
    }
    el.innerHTML = state.startResults.length
      ? state.startResults.map((r, i) => `<li data-startresult="${i}"><span class="dot" style="background:#23161f"></span>
          <span class="stop-main"><div class="stop-name">${esc(r.name)}</div><div class="stop-meta">${esc(r.address)}</div></span>
          <button class="mini" data-startresult="${i}">Start here</button></li>`).join("")
      : `<li class="empty">Nothing found. Try “Tap on map” instead.</li>`;
  }

  function locateStart() {
    if (!navigator.geolocation) return toast("Your browser can't share your location.");
    toast("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => setStart({ name: "My location", lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => toast("Couldn't get your location. Allow location access, or search for your hotel instead."),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  // ----- Getting around: walking + bus/tram/metro -----
  const LONG_WALK_MIN = 15;
  state.legs = {};

  function legHtml(from, to, key) {
    state.legs[key] = { from, to };
    const mins = walkMin(from, to);
    const long = mins >= LONG_WALK_MIN;
    return `<li class="leg"><span>↓ 🚶 ${mins} min walk</span>
        <button class="leg-btn ${long ? "hot" : ""}" data-leg="${key}">${long ? "🚌 Long walk? See bus & tram" : "🚌 Transit"}</button></li>
      <li class="leg-detail" id="leg-${key}" hidden></li>`;
  }

  // On a spot's page: how to get there from the previous stop (or the start).
  function gettingHereHtml(spot) {
    const i = plan().indexOf(spot.id);
    const from = i > 0 ? spotById(plan()[i - 1]) : state.trip.start;
    if (!from || i < 0) return "";
    const key = "here";
    state.legs[key] = { from, to: spot };
    const mins = walkMin(from, spot);
    return `<div class="section">
      <h3>Getting here</h3>
      <p>From <b>${esc(from.name)}</b>: 🚶 ${mins} min walk (${fmtDist(meters(from, spot) * DETOUR)})</p>
      <div class="actions">
        <button class="btn ${mins >= LONG_WALK_MIN ? "primary" : ""}" data-leg="${key}">🚌 Bus, tram &amp; metro options</button>
        <a class="btn" target="_blank" rel="noopener" href="${gmapsWalkUrl([from, spot])}">🚶 Walking directions</a>
      </div>
      <div class="leg-detail" id="leg-${key}" hidden></div>
    </div>`;
  }

  const fmtTime = (d) => (d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

  function transitHtml(options, from, to) {
    const google = `<a class="btn" target="_blank" rel="noopener" href="${window.WPTransit.googleTransitUrl(from, to)}">Live times in Google Maps</a>`;
    const walk = walkMin(from, to);
    if (!options.length) {
      return `<p class="hint">No bus, tram or metro route found here. It may be quicker to walk (${walk} min), or check Google Maps.</p>
        <div class="actions">${google}</div>`;
    }
    const best = options[0];
    const verdict = best.minutes + 3 < walk
      ? `<p class="verdict good">🚌 Saves about ${walk - best.minutes} min compared with walking (${walk} min).</p>`
      : `<p class="verdict">🚶 Walking (${walk} min) is about as fast. Transit is there if your feet need a break.</p>`;
    const option = (o, n) => `
      <div class="route ${n === 0 ? "best" : ""}">
        <div class="route-head"><b>${o.minutes} min</b>
          <span>${fmtTime(o.departure)} → ${fmtTime(o.arrival)} · ${o.transfers ? `${o.transfers} change${o.transfers > 1 ? "s" : ""}` : "direct"}</span>
          ${n === 0 ? `<span class="chip">Fastest</span>` : ""}</div>
        <div class="route-strip">${o.legs.map((l) => l.mode === "WALK"
          ? `<span class="pill walk-pill">🚶 ${l.minutes}′</span>`
          : `<span class="pill" ${l.color ? `style="background:${esc(l.color)};color:#fff"` : ""}>${l.icon} ${esc(l.line || l.label)}</span>`).join('<span class="arrow">›</span>')}</div>
        <ol class="route-steps">${o.legs.map((l) => l.mode === "WALK"
          ? `<li>🚶 Walk ${l.minutes} min${l.to ? ` to <b>${esc(l.to)}</b>` : ""}</li>`
          : `<li>${l.icon} <b>${esc(l.label)} ${esc(l.line)}</b>${l.headsign ? ` toward ${esc(l.headsign)}` : ""}
              <div class="muted">${l.departure ? `Leaves ${fmtTime(l.departure)} from ` : "From "}${esc(l.from)} · get off at <b>${esc(l.to)}</b>${l.stops ? ` (${l.stops} stop${l.stops > 1 ? "s" : ""}, ${l.minutes} min)` : ` (${l.minutes} min)`}</div></li>`).join("")}</ol>
      </div>`;
    return `${verdict}${options.map(option).join("")}
      <div class="actions">${google}</div>
      <p class="hint">Times are for leaving now, from Transitous (free, community-run). Check signs and Google Maps for delays.</p>`;
  }

  async function toggleTransit(key, btn) {
    const box = $(`leg-${key}`);
    const leg = state.legs[key];
    if (!box || !leg) return;
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<p class="hint">🚌 Finding bus, tram and metro routes…</p>`;
    btn.disabled = true;
    try {
      const options = await window.WPTransit.plan(leg.from, leg.to);
      box.innerHTML = transitHtml(options, leg.from, leg.to);
    } catch (err) {
      box.innerHTML = `<p class="hint">${esc(err.message)}</p>
        <div class="actions"><a class="btn" target="_blank" rel="noopener" href="${window.WPTransit.googleTransitUrl(leg.from, leg.to)}">Transit directions in Google Maps</a></div>`;
    } finally {
      btn.disabled = false;
    }
  }

  // ----- My day -----
  function showPlan(open = true) {
    state.view = "plan";
    state.selected = null;
    setHeading(`My day in ${state.trip.name}`, false);
    const stops = plan().map(spotById).filter(Boolean);
    const start = state.trip.start;
    const walk = [start, ...stops].filter(Boolean);
    let total = 0, dist = 0;
    walk.forEach((s, i) => { if (i) { total += walkMin(walk[i - 1], s); dist += meters(walk[i - 1], s) * DETOUR; } });

    const rows = stops.map((s, i) => {
      const cat = CATS[s.category] || CATS.sight;
      const prev = i ? stops[i - 1] : start;
      const leg = prev ? legHtml(prev, s, `p${i}`) : "";
      return `${leg}<li data-id="${esc(s.id)}">
        <span class="stop-letter" style="background:${cat.color}">${LETTERS[i] || "•"}</span>
        <span class="stop-main"><div class="stop-name">${esc(s.name)}</div>
          <div class="stop-meta">${cat.emoji} ${cat.label}${isDone(s.id) ? ' · <span class="stop-done">✓ shot taken</span>' : ""}</div></span>
        <button class="mini" data-up="${i}" title="Move up" aria-label="Move up">▲</button>
        <button class="mini" data-down="${i}" title="Move down" aria-label="Move down">▼</button>
        <button class="mini" data-remove="${esc(s.id)}" title="Take out of today's plan (keeps the pin)" aria-label="Take out of today's plan">✕</button>
        <button class="mini" data-delspot="${esc(s.id)}" title="Delete pin" aria-label="Delete pin">🗑</button>
      </li>`;
    }).join("");

    const unplanned = spots().filter((s) => !plan().includes(s.id));
    body.innerHTML = `
      ${startHtml(start)}
      <div class="section">
        <div class="plan-summary">
          <span><b>${stops.length}</b> stops</span>
          <span><b>${fmtMin(total)}</b> walking</span>
          <span><b>${fmtDist(dist)}</b></span>
        </div>
        ${(() => {
          const long = walk.filter((x, i) => i && walkMin(walk[i - 1], x) >= LONG_WALK_MIN).length;
          return long ? `<p class="hint">🚌 ${long} long walk${long > 1 ? "s" : ""} in this tour. Tap the yellow buttons for bus, tram and metro options.</p>` : "";
        })()}
        <div class="actions">
          ${stops.length > (start ? 1 : 2) ? `<button class="btn primary" id="btn-optimize">✨ Optimize route</button>` : ""}
          ${stops.length ? `<a class="btn" target="_blank" rel="noopener" href="${gmapsWalkUrl(walk)}">Walk it in Google Maps</a>` : ""}
          <button class="btn" id="btn-find">🔍 Add spots</button>
          <button class="btn" id="btn-drop-pin">📍 Drop a pin</button>
          <button class="btn" id="btn-popular">✨ Find popular spots</button>
        </div>
      </div>
      ${stops.length ? `<ul class="plain stops">${rows}</ul>`
        : `<p class="empty">Your day is empty. Search for places with “🔍 Add spots” or tap “📍 Drop a pin”${map?.kind === "google" ? ", or tap any place on the map" : ""}.</p>`}
      ${unplanned.length ? `<div class="section"><h3>Saved, not in today's plan</h3><ul class="plain nearby">
        ${unplanned.map((s) => `<li data-id="${esc(s.id)}"><span class="dot" style="background:${(CATS[s.category] || CATS.sight).color}"></span>
          <span class="nearby-name">${esc(s.name)}</span><button class="mini" data-addplan="${esc(s.id)}">＋ Add</button><button class="mini" data-delspot="${esc(s.id)}" title="Delete pin" aria-label="Delete pin">🗑</button></li>`).join("")}
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
          <button class="btn danger" id="btn-delete-spot">🗑 Delete pin</button>
        </div>
      </div>
      <div class="section">
        <h3>Pose inspiration</h3>
        <div class="gallery" id="gallery"></div>
        <p class="hint">Save photos you love from Instagram or Pinterest and upload them here. Tap one, then <b>✨ How do I take this?</b> for step-by-step phone camera directions.</p>
      </div>
      ${spot.poses?.length ? `<div class="section"><h3>Shot ideas</h3><ul class="plain poses">${spot.poses.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}
      ${gettingHereHtml(spot)}
      ${nearby.length ? `<div class="section">
        <h3>Walking distance from here</h3>
        <ul class="plain nearby">${nearby.map(({ s, d }) => `<li data-id="${esc(s.id)}">
          <span class="dot" style="background:${(CATS[s.category] || CATS.sight).color}"></span>
          <span class="nearby-name">${esc(s.name)}</span>
          <span class="walk">🚶 ${walkMin(spot, s)} min · ${fmtDist(d * DETOUR)}</span></li>`).join("")}</ul>
      </div>` : ""}`;
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
        ${p.guide || p.notes ? `<span class="badge ai">✨ Guide</span>` : ""}
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
          : "Results come from OpenStreetMap (free)."}</p>
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
    if (toPlan) addToPlan(s.id);
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
            <div class="stop-meta">${t.spots.length} spots${t.plan ? ` · ${t.plan.length} in plan` : ""}${t.id === state.trip.id ? " · <b>open now</b>" : ""}</div></span>
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
    state.editingStart = false;
    trip.plan ||= optimize(trip.spots.filter((s) => s.category !== "stay").map((s) => s.id));
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
    const paid = settings.googleKey || settings.claudeKey;
    body.innerHTML = `
      <div class="section">
        <h3>${paid ? "Using your own API keys" : "Free mode ✓"}</h3>
        <p>${paid
          ? "Some features use your own Google or Claude API keys, which can cost money. Clear both keys below to go back to free mode."
          : "Everything in Wanderpose is free: the OpenStreetMap map and search, your trips and photos, and the AI photo coach through the free Claude app. No API keys or payment needed."}</p>
      </div>
      <form class="section form" id="settings-form">
        <details ${paid ? "open" : ""}>
          <summary><b>Advanced: use your own API keys (may cost money)</b></summary>
          <p class="hint">Only needed if you want the Google map inside the app, or photo guides without leaving the app. Both services bill your card for use beyond their free allowance.</p>

          <h3 style="margin-top:14px">Google Maps</h3>
          <p class="hint">Shows the real Google map, Google's places, photos and ratings. Create a key in
            <a href="https://console.cloud.google.com/google/maps-apis/credentials" target="_blank" rel="noopener">Google Cloud</a>,
            then enable <b>Maps JavaScript API</b> and <b>Places API (New)</b> for it. Restrict the key to your site's address.</p>
          <label for="s-google">Google Maps API key</label>
          <input id="s-google" type="password" autocomplete="off" value="${esc(settings.googleKey)}" placeholder="AIza…" />
          <p class="hint">Map now: <b>${map.kind === "google" ? "Google Maps" : "OpenStreetMap (free)"}</b></p>

          <h3 style="margin-top:14px">Claude API</h3>
          <p class="hint">Makes photo guides right inside the app instead of in the Claude app. Create a key at
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>.
            Each guide costs a few cents.</p>
          <label for="s-claude">Claude API key</label>
          <input id="s-claude" type="password" autocomplete="off" value="${esc(settings.claudeKey)}" placeholder="sk-ant-…" />

          <p class="hint">🔒 Keys are saved only in this browser on this device.</p>
          <div class="actions"><button class="btn primary" type="submit">Save keys</button></div>
        </details>
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
    $("lb-ai").textContent = p.guide || p.notes ? "✨ Show photo guide" : "✨ How do I take this?";
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

  // Free mode: send the photo and a ready-made question to the free Claude
  // app, then paste the answer back here so it stays with the photo.
  const photoFile = (p) => new File([p.blob], "inspiration.jpg", { type: p.blob.type || "image/jpeg" });
  const canShareFile = (p) => {
    try { return !!navigator.canShare?.({ files: [photoFile(p)] }); } catch { return false; }
  };
  function coachPrompt(p) {
    const spot = spotById(p.spotId);
    return window.WPAI.freePrompt({ spotName: spot?.name, cityName: state.trip.name, bestTime: spot?.bestTime });
  }

  function showFreeCoach(p) {
    const share = canShareFile(p);
    $("lb-guide").innerHTML = `
      ${p.notes ? `<h4>📝 Your photo guide</h4><div class="notes">${esc(p.notes)}</div>` : ""}
      <h4>✨ ${p.notes ? "Ask again" : "Free AI photo coach"}</h4>
      <p>Get step-by-step phone camera directions from the free Claude app:</p>
      <ol>
        ${share
          ? "<li>Tap <b>Share to Claude</b> and pick the Claude app. The question is copied too; paste it if it doesn't appear.</li>"
          : "<li>Tap <b>Copy question &amp; open Claude</b>.</li><li>Drag this photo into the Claude chat (or save it and attach it), paste the question if it isn't there, and send.</li>"}
        <li>Copy Claude's answer and paste it below to keep it with this photo.</li>
      </ol>
      <div class="actions">
        ${share ? `<button class="btn primary" id="coach-share">Share to Claude</button>` : ""}
        <button class="btn ${share ? "" : "primary"}" id="coach-open">Copy question &amp; open Claude</button>
      </div>
      <details class="prompt-box"><summary>See the question</summary><pre>${esc(coachPrompt(p))}</pre></details>
      <label class="notes-label" for="coach-notes">Claude's answer</label>
      <textarea id="coach-notes" rows="8" placeholder="Paste Claude's answer here">${esc(p.notes || "")}</textarea>
      <div class="actions"><button class="btn primary" id="coach-save">Save to this photo</button></div>
      <p class="hint">Uses your free claude.ai account. No API key or payment needed.</p>`;
    $("lb-guide").hidden = false;
    $("lb-guide").scrollTop = 0;
    $("lightbox").classList.add("with-guide");
  }

  const copyText = (text) => navigator.clipboard?.writeText(text).catch(() => {});

  $("lb-guide").addEventListener("click", async (e) => {
    const p = state.lightbox.photos[state.lightbox.index];
    const id = e.target.closest("button")?.id;
    if (!p || !id) return;
    if (id === "coach-share") {
      const prompt = coachPrompt(p);
      copyText(prompt);
      try {
        await navigator.share({ files: [photoFile(p)], text: prompt });
      } catch (err) {
        if (err?.name !== "AbortError") toast("Sharing didn't work. Try “Copy question & open Claude” instead.");
      }
    }
    if (id === "coach-open") {
      const prompt = coachPrompt(p);
      copyText(prompt);
      window.open(`https://claude.ai/new?q=${encodeURIComponent(prompt)}`, "_blank", "noopener");
      toast("Question copied. Add the photo in Claude and send.", 6000);
    }
    if (id === "coach-save") {
      p.notes = $("coach-notes").value.trim();
      await db.put(p);
      toast(p.notes ? "Saved with this photo ✓" : "Removed the saved answer");
      $("lb-ai").textContent = p.notes ? "✨ Show photo guide" : "✨ How do I take this?";
      showFreeCoach(p);
      renderGallery(p.spotId);
    }
  });

  async function aiGuide() {
    const p = state.lightbox.photos[state.lightbox.index];
    if (!p) return;
    if (p.guide) return showGuide(p.guide);
    if (!settings.claudeKey) return showFreeCoach(p);
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

  async function deleteSpot(id) {
    const spot = spotById(id);
    if (!spot || !confirm(`Delete the “${spot.name}” pin and its photos?`)) return;
    for (const p of await db.byspot(id).catch(() => [])) await db.del(p.id);
    state.trip.spots = spots().filter((s) => s.id !== id);
    state.trip.plan = plan().filter((x) => x !== id);
    setDone(id, false);
    if (state.selected === id) state.selected = null;
    save();
    renderMarkers();
    updateHeader();
    toast(`Deleted ${spot.name}`);
    showPlan();
  }

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
    if (e.target.id === "start-form") return findStart($("start-q").value);
    if (e.target.id === "settings-form") {
      const googleChanged = $("s-google").value.trim() !== settings.googleKey;
      settings.googleKey = $("s-google").value.trim();
      settings.claudeKey = $("s-claude").value.trim();
      store.set("settings", settings);
      if (googleChanged) { location.reload(); return; }
      toast(settings.claudeKey ? "Saved ✓" : "Saved ✓ Free mode is on");
      showPlan();
    }
  });

  body.addEventListener("click", async (e) => {
    const t = e.target.closest("button, a, li[data-id], li[data-result], li[data-trip], li[data-city], li[data-startresult], .thumb, input");
    if (!t || t.tagName === "A") return;
    const d = t.dataset;

    if (t.id === "btn-optimize") {
      state.trip.plan = optimize(plan());
      toast(state.trip.start ? `Shortest tour from ${state.trip.start.name} ✨` : "Route optimized ✨");
      return rerender();
    }
    if (d.leg) { e.stopPropagation(); return toggleTransit(d.leg, t); }
    if (t.id === "btn-popular") return addPopularSpots(false);
    if (t.id === "start-locate") return locateStart();
    if (t.id === "start-pick") { setAdding("start"); if (PHONE()) setPanel("closed"); return; }
    if (t.id === "start-change") { state.editingStart = true; return showPlan(); }
    if (t.id === "start-cancel") { state.editingStart = false; return showPlan(); }
    if (t.id === "start-clear") { state.trip.start = null; save(); renderMarkers(); return showPlan(); }
    if (d.startresult !== undefined) {
      const r = state.startResults[Number(d.startresult)];
      return setStart({ name: r.name, lat: r.lat, lng: r.lng, placeId: r.placeId });
    }
    if (t.id === "btn-find") return showSearch();
    if (t.id === "btn-drop-pin") { setAdding(true); if (PHONE()) setPanel("closed"); return; }
    if (t.id === "btn-upload") return $("file-input").click();
    if (t.id === "btn-toggle-plan") {
      const id = state.selected;
      if (plan().includes(id)) state.trip.plan = plan().filter((x) => x !== id);
      else addToPlan(id);
      return rerender();
    }
    if (t.id === "chk-done") { setDone(state.selected, t.checked); return rerender(); }
    if (t.id === "btn-add-candidate" || t.id === "btn-save-candidate") {
      const s = addSpot(state.candidate, t.id === "btn-add-candidate");
      toast(`${s.name} added to ${state.trip.name}`);
      return showSpot(s.id);
    }
    if (t.id === "btn-delete-spot") return deleteSpot(state.selected);
    if (d.delspot) { e.stopPropagation(); return deleteSpot(d.delspot); }
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
    if (d.addplan) { addToPlan(d.addplan); return rerender(); }
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
      showPlan();
      return addPopularSpots(true);
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
  $("btn-pin").onclick = () => {
    setAdding(!state.adding);
    if (state.adding && PHONE()) setPanel("closed");
  };

  // ---------- Boot ----------
  save();
  updateHeader();
  map = await window.WPMaps.createMap($("map"), mapOpts());
  renderMarkers();
  showPlan(!PHONE());
})();
