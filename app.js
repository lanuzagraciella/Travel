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
  // Starter inspiration posts for the ready-made cities (added once per spot,
  // so posts you remove stay removed).
  for (const t of trips) for (const sp of t.spots) {
    const starter = window.SEED_POSTS?.[sp.id];
    if (!starter || sp.starterPosts) continue;
    const have = new Set((sp.posts || []).map((x) => x.url));
    sp.posts = [...(sp.posts || []), ...starter.filter((x) => !have.has(x.url)).map((x) => ({ ...x, starter: true }))];
    sp.starterPosts = true;
  }
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
    const days = state.trip?.days;
    if (days?.list && state.trip.plan) days.list[days.current] = state.trip.plan.slice();
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
    $("btn-pin").hidden = state.view === "itinerary" || !!state.adding;
    if (state.view === "itinerary") return renderOverview();
    if (state.overview) {
      state.overview = false;
      map.setView(state.trip.center, state.trip.zoom || 14);
    }
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
        label: "🏁", color: "#7a1f5c", selected: false, done: false, showName: showNames,
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
    $("progress-text").textContent = inPlan ? `${got} of ${inPlan} shots taken` : "Plan your spots and your shots";
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
    if (btn) { btn.disabled = true; btn.innerHTML = `${ICON("sparkles")} Finding spots…`; }
    toast(`Finding popular photo spots in ${trip.name}…`, 15000);
    try {
      const center = { lat: trip.center[0], lng: trip.center[1] };
      const found = await window.WPPlaces.popularSpots(center, trip.name);
      if (state.trip !== trip) return;
      const fresh = found.filter((f) => !spotById(f.id) &&
        !spots().some((s) => s.name.toLowerCase() === f.name.toLowerCase() || meters(s, f) < 40));
      const placed = {};
      for (const f of fresh) {
        spots().push({ ...f, poses: [] });
        if (trip.days) {
          const d = placeInDays(f.id);
          placed[d] = (placed[d] || 0) + 1;
        } else if (toPlan) plan().push(f.id);
      }
      if (toPlan && !trip.days) trip.plan = optimize(plan());
      save();
      renderMarkers();
      updateHeader();
      if (state.view === "plan") showPlan(false);
      toast(fresh.length
        ? `Added ${fresh.length} popular spot${fresh.length > 1 ? "s" : ""}` + (trip.days
          ? ` to your days${placed[-1] ? ` (${placed[-1]} didn't fit)` : ""} ✨`
          : toPlan ? " to your day ✨" : ". Tap ＋ Add to put them in your day ✨")
        : "No new popular spots found nearby.");
    } catch (err) {
      toast(err.message || "Couldn't load popular spots right now.");
    } finally {
      const b = $("btn-popular");
      if (b) { b.disabled = false; b.innerHTML = `${ICON("star")} Popular spots`; }
    }
  }

  // ----- Start point (hotel, station, current location) -----
  function startHtml(start) {
    if (start && !state.editingStart) {
      return `<div class="section start-box">
        <div class="start-row"><span class="stop-letter start-letter">🏁</span>
          <span class="stop-main"><div class="stop-name">Start: ${esc(start.name)}</div>
            <div class="stop-meta">Your tour is ordered from here</div></span>
          <button class="mini text" id="start-change">Change</button>
          <button class="mini" id="start-clear" title="Remove start point" aria-label="Remove start point">${ICON("xmark")}</button></div>
      </div>`;
    }
    return `<form class="section form start-box" id="start-form">
      <h3>Where do you start?</h3>
      <p class="hint">Your hotel, the station, or where you are now. The app orders your stops into the shortest walking tour from there.</p>
      <div class="actions" style="margin-top:4px">
        <button class="btn" type="button" id="start-locate">${ICON("location")} My location</button>
        <button class="btn" type="button" id="start-pick">${ICON("pin")} Tap on map</button>
        ${start ? `<button class="btn" type="button" id="start-cancel">Cancel</button>` : ""}
      </div>
      <div class="search-row" style="margin-top:10px">
        <input id="start-q" type="search" placeholder="Hotel, station or address" autocomplete="off" />
        <button class="btn primary" type="submit">Find</button>
      </div>
      <ul class="plain results" id="start-results"></ul>
    </form>`;
  }

  // With day plans, automatically added spots go to the closest day that
  // still has time for them (or "didn't fit" if no day has room).
  function placeInDays(id) {
    const days = state.trip.days;
    const s = spotById(id);
    if (!days || !s || days.list.some((d) => d.includes(id))) return;
    save(); // keep edits to the shown day
    const startMin = toMin(days.start), endMin = toMin(days.end);
    const options = days.list
      .map((ids, d) => ({ d, dist: ids.length ? Math.min(...ids.map((x) => meters(spotById(x) || s, s))) : 1e9 }))
      .sort((a, b) => a.dist - b.dist);
    for (const { d } of options) {
      const trial = optimize([...days.list[d], id]);
      if (scheduleDay(trial, startMin).endsAt <= endMin) {
        days.list[d] = trial;
        if (d === days.current) state.trip.plan = trial.slice();
        days.leftover = days.leftover.filter((x) => x !== id);
        return d;
      }
    }
    if (!days.leftover.includes(id)) days.leftover.push(id);
    return -1;
  }

  // With a start point set, every new stop slots into the shortest tour.
  function addToPlan(id) {
    const sp = spotById(id);
    if (sp) delete sp.skip;
    if (state.trip.days) state.trip.days.leftover = state.trip.days.leftover.filter((x) => x !== id);
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
      ? state.startResults.map((r, i) => `<li data-startresult="${i}"><span class="dot" style="background:#7a1f5c"></span>
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

  // ----- RedNote (小红书) -----
  // RedNote has no public API, so the app links into RedNote searches (in
  // Chinese, the way its users write) and keeps the posts you save.
  const rednoteUrl = (q) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(q)}`;

  // Searches are about the spot only (never the whole city): its Chinese
  // name when known, otherwise its own name.
  const spotSearchName = (spot) => spot.zh || spot.name.replace(/\s*\([^)]*\)$/, "");
  const spotRednoteUrl = (spot) => rednoteUrl(`${spotSearchName(spot)} 机位`);

  function rednoteTerms(spot) {
    const base = spotSearchName(spot);
    const terms = [`${base} 机位`, `${base} 拍照姿势`, `${base} 拍照`];
    if (spot.zh) terms.push(`${spot.name} photo spot`);
    return terms;
  }

  function postSite(url) {
    let host = "";
    try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* not a URL */ }
    if (/xhslink|xiaohongshu/.test(host)) return "RedNote";
    if (/instagram/.test(host)) return "Instagram";
    if (/pinterest|pin\.it/.test(host)) return "Pinterest";
    if (/tiktok/.test(host)) return "TikTok";
    return host || "Link";
  }

  // Turn pasted share text into { url, title }. RedNote's share text looks like
  // "… 发布了一篇小红书笔记，快来看吧！ 😆 code 😆 http://xhslink.com/a/x，复制本条信息，打开【小红书】App查看精彩内容！"
  function parseShared(text) {
    const url = (text.match(/https?:\/\/[^\s，。！!）)"'】]+/) || [])[0];
    if (!url) return null;
    const bracketed = [...text.matchAll(/【([^】]+)】/g)].map((m) => m[1]).filter((t) => !/小红书/.test(t));
    const author = (text.match(/^\s*(?:\d+\s*)?(.+?)发布了一篇小红书笔记/) || [])[1];
    let title = bracketed[0] || (author && `Post by ${author.trim()}`) || text.slice(0, text.indexOf(url))
      .replace(/😆[^😆]*😆/gu, "")
      .replace(/发布了一篇小红书笔记，快来看吧！?/, "")
      .replace(/^\s*\d+\s*/, "")
      .replace(/\s+/g, " ").trim();
    if (!title) title = text.slice(text.indexOf(url) + url.length).replace(/复制本条信息.*$/s, "").replace(/\s+/g, " ").trim();
    if (!title) title = `${postSite(url)} post`;
    return { url, title: title.slice(0, 90) };
  }

  // Inspiration from other travellers: app searches, saved posts (shown as
  // official embeds) and RedNote searches in Chinese.
  const SITE_CLASS = { Pinterest: "pinterest", TikTok: "tiktok", Instagram: "instagram", RedNote: "rednote" };
  function rednoteHtml(spot) {
    const terms = rednoteTerms(spot);
    state.rnTerms = terms;
    const posts = spot.posts || [];
    const links = window.WPInspo.searchLinks(spot, spot.zh);
    return `<div class="section inspo" id="rednote">
      <h3>Inspiration from travellers</h3>
      <p class="hint">See how others photographed ${esc(spot.name)}, then save the shots you want to recreate.</p>
      <div class="app-links">${links.map((l) => `<a class="app-link ${SITE_CLASS[l.site]}" target="_blank" rel="noopener" href="${esc(l.url)}">${esc(l.site)}</a>`).join("")}</div>
      ${posts.length ? `<h4 class="posts-title">Saved posts</h4><ul class="plain posts">${posts.map((p, i) => {
        const embeddable = !!window.WPInspo.embedInfo(p.url);
        return `<li class="post">
          <div class="post-row">
            <span class="post-site ${SITE_CLASS[p.site] || ""}">${esc(p.site)}</span>
            <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>
            ${embeddable ? `<button class="mini text" data-showpost="${i}">${ICON("down")} View</button>` : ""}
            <button class="mini" data-delpost="${i}" aria-label="Remove saved post">${ICON("xmark")}</button>
          </div>
          <div class="post-embed" id="post-embed-${i}" hidden></div>
        </li>`;
      }).join("")}</ul>` : ""}
      <form class="search-row" id="post-form" style="margin-top:12px">
        <input id="post-link" placeholder="Paste a Pinterest, TikTok, Instagram or RedNote link" autocomplete="off" />
        <button class="btn" type="submit">Save</button>
      </form>
      <p class="hint">In any of these apps tap Share → Copy link, then paste it here. To get where-to-stand directions, screenshot the photo and add it to <b>Pose inspiration</b>.</p>
      <h4 class="posts-title">RedNote searches (Chinese)${spot.zh ? ` · ${esc(spot.zh)}` : ""}</h4>
      <div class="terms">${terms.map((t, i) => `<button class="term" data-rn="${i}">${esc(t)}</button>`).join("")}</div>
    </div>`;
  }

  // Free-licence photos of this spot, credited, each one savable as a pose.
  function ccHtml() {
    return `<div class="section" id="cc">
      <h3>Free-licence photos</h3>
      <div class="cc-grid" id="cc-grid"><p class="hint">Loading photos…</p></div>
      <p class="hint">Shared by photographers under Creative Commons licences, via <a href="https://openverse.org" target="_blank" rel="noopener">Openverse</a>. Tap a photo to see the original; <b>＋ Pose</b> saves it to your pose gallery with its credit.</p>
    </div>`;
  }

  async function loadFreePhotos(spot) {
    let items = [];
    try {
      items = await window.WPInspo.freePhotos(spot, state.trip.name);
    } catch (err) {
      const el = $("cc-grid");
      if (el && state.selected === spot.id) el.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
      return;
    }
    const el = $("cc-grid");
    if (!el || state.selected !== spot.id) return;
    state.ccItems = items;
    el.innerHTML = items.length
      ? items.map((x, i) => `<figure class="cc">
          <a href="${esc(x.page)}" target="_blank" rel="noopener"><img src="${esc(x.thumb)}" alt="${esc(x.title)}" loading="lazy" /></a>
          <button class="cc-add" data-ccpose="${i}">${ICON("plus")} Pose</button>
          <figcaption>${esc(x.creator)} · ${esc(x.licence)}</figcaption>
        </figure>`).join("")
      : `<p class="hint">No free-licence photos found for this spot. Try the app searches above.</p>`;
  }

  // Save a free-licence photo into the spot's pose gallery, keeping its credit.
  async function saveCcAsPose(item, spotId) {
    let blob = null;
    try {
      const r = await fetch(item.thumb, { mode: "cors" });
      if (r.ok) blob = await r.blob();
    } catch { /* keep a link to the image instead */ }
    await db.put({
      id: crypto.randomUUID(), spotId, blob, src: blob ? null : item.thumb, createdAt: Date.now(), recreated: false,
      credit: { creator: item.creator, licence: item.licence, licenceUrl: item.licenceUrl, page: item.page },
    });
    await renderGallery(spotId);
    toast("Saved to your pose gallery ✓");
  }

  // Look up a spot's Chinese name once (via its Wikipedia article, found by
  // location if needed). Resolves true when something new was learned.
  const zhLoading = new Map();   // spot id -> lookup in flight
  function spotChinese(spot) {
    if (spot.zh !== undefined) return Promise.resolve(false);
    if (zhLoading.has(spot.id)) return zhLoading.get(spot.id);
    const job = (async () => {
      try {
        if (!spot.wiki && !spot.wikiChecked) {
          spot.wikiChecked = true;
          spot.wiki = await window.WPPlaces.wikiTitleNear(spot.name, spot.lat, spot.lng) || undefined;
        }
        spot.zh = spot.wiki ? await window.WPPlaces.chineseName(spot.wiki) : null;
        save();
        return !!spot.zh;
      } catch {
        return false;   // offline: try again next time
      } finally {
        zhLoading.delete(spot.id);
      }
    })();
    zhLoading.set(spot.id, job);
    return job;
  }

  async function ensureChinese(spot) {
    if (!(await spotChinese(spot))) return;
    const box = $("rednote");
    if (box && state.selected === spot.id) box.outerHTML = rednoteHtml(spot);
    const top = $("rn-top");
    if (top && state.selected === spot.id) top.href = spotRednoteUrl(spot);
  }

  // Chinese names for every stop in the day plan, so each 📕 button searches
  // that exact spot. Runs in the background, then refreshes the list once.
  async function ensurePlanChinese() {
    const trip = state.trip;
    const todo = plan().map(spotById).filter((s) => s && s.zh === undefined);
    if (!todo.length) return;
    let learned = false;
    for (let i = 0; i < todo.length; i += 4) {
      const done = await Promise.all(todo.slice(i, i + 4).map(spotChinese));
      learned ||= done.some(Boolean);
    }
    if (learned && state.trip === trip && state.view === "plan") showPlan(false);
  }

  // ----- Getting around: walking + bus/tram/metro -----
  const LONG_WALK_MIN = 15;
  state.legs = {};

  function legHtml(from, to, key) {
    state.legs[key] = { from, to };
    const mins = walkMin(from, to);
    const long = mins >= LONG_WALK_MIN;
    return `<li class="leg"><span>${ICON("walk")} ${mins} min walk</span>
        <button class="leg-btn ${long ? "hot" : ""}" data-leg="${key}">${ICON("bus")} ${long ? "Long walk? Bus & tram" : "Transit"}</button></li>
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
        <button class="btn ${mins >= LONG_WALK_MIN ? "primary" : ""}" data-leg="${key}">${ICON("bus")} Bus, tram &amp; metro</button>
        <a class="btn" target="_blank" rel="noopener" href="${gmapsWalkUrl([from, spot])}">${ICON("walk")} Walking directions</a>
      </div>
      <div class="leg-detail" id="leg-${key}" hidden></div>
    </div>`;
  }

  const fmtDay = (d) => d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  const fmtTime = (d) => (d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

  function transitHtml(options, from, to, leg = {}) {
    const google = `<a class="btn" target="_blank" rel="noopener" href="${window.WPTransit.googleTransitUrl(from, to)}">Live times in Google Maps</a>`;
    const walk = walkMin(from, to);
    if (!options.length && leg.intercity) {
      return `<p class="hint">No train or bus found for this day. Check Google Maps or the local rail operator.</p>
        <div class="actions">${google}</div>`;
    }
    if (!options.length) {
      return `<p class="hint">No bus, tram or metro route found here. It may be quicker to walk (${walk} min), or check Google Maps.</p>
        <div class="actions">${google}</div>`;
    }
    const best = options[0];
    const verdict = leg.intercity ? "" : best.minutes + 3 < walk
      ? `<p class="verdict good">🚌 Saves about ${walk - best.minutes} min compared with walking (${walk} min).</p>`
      : `<p class="verdict">🚶 Walking (${walk} min) is about as fast. Transit is there if your feet need a break.</p>`;
    const option = (o, n) => `
      <div class="route ${n === 0 ? "best" : ""}">
        <div class="route-head"><b>${fmtMin(o.minutes)}</b>
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
      <p class="hint">Times are for ${leg.when ? `${fmtDay(leg.when)}, from 9:00` : "leaving now"}, from Transitous (free, community-run). Check the station boards and Google Maps for changes${leg.intercity ? "; buy tickets from the rail operator or at the station" : ""}.</p>`;
  }

  async function toggleTransit(key, btn) {
    const box = $(`leg-${key}`);
    const leg = state.legs[key];
    if (!box || !leg) return;
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<p class="hint">${leg.intercity ? "🚆 Finding trains and buses…" : "🚌 Finding bus, tram and metro routes…"}</p>`;
    btn.disabled = true;
    try {
      const options = await window.WPTransit.plan(leg.from, leg.to, leg.when || new Date());
      box.innerHTML = transitHtml(options, leg.from, leg.to, leg);
    } catch (err) {
      box.innerHTML = `<p class="hint">${esc(err.message)}</p>
        <div class="actions"><a class="btn" target="_blank" rel="noopener" href="${window.WPTransit.googleTransitUrl(leg.from, leg.to)}">Transit directions in Google Maps</a></div>`;
    } finally {
      btn.disabled = false;
    }
  }

  // ----- Day-by-day plan -----
  // Splits the trip's saved spots into days by area, orders each day as a
  // walking route, and times every stop. trip.days = { count, start, end,
  // list: [[spot ids]…], leftover: [spot ids], current }. The selected day is
  // mirrored in trip.plan so the map, route and transit tools all work on it.
  const VISIT_MIN = { photo: 30, sight: 60, food: 60, shop: 30, stay: 0 };
  const LUNCH_AT = 12 * 60 + 30, LUNCH_MIN = 60;
  const toMin = (hhmm) => { const [h, m] = String(hhmm || "09:00").split(":").map(Number); return h * 60 + (m || 0); };
  const fmtClock = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(Math.round(min % 60)).padStart(2, "0")}`;

  // Arrival and leaving times for a day's stops, with a lunch break if the
  // day runs through lunchtime without a food stop.
  function scheduleDay(ids, startMin) {
    const stops = ids.map(spotById).filter(Boolean);
    const hasFood = stops.some((s) => s.category === "food");
    let t = startMin, prev = state.trip.start, lunched = hasFood;
    const items = [];
    for (const s of stops) {
      if (prev) t += walkMin(prev, s);
      if (!lunched && t >= LUNCH_AT) {
        items.push({ type: "lunch", at: t });
        t += LUNCH_MIN;
        lunched = true;
      }
      const stay = VISIT_MIN[s.category] ?? 45;
      items.push({ type: "stop", id: s.id, arrive: t, leave: t + stay });
      t += stay;
      prev = s;
    }
    return { items, endsAt: t };
  }

  // Group spots into `k` areas (k-means on coordinates, seeded far apart).
  function clusterSpots(list, k) {
    if (k <= 1) return [list];
    if (list.length <= k) return Array.from({ length: k }, (_, i) => (list[i] ? [list[i]] : []));
    const centers = [list[0]];
    while (centers.length < k) {
      centers.push(list.reduce((best, s) => {
        const d = Math.min(...centers.map((c) => meters(c, s)));
        return d > best.d ? { s, d } : best;
      }, { s: list[0], d: -1 }).s);
    }
    let groups = [];
    for (let iter = 0; iter < 8; iter++) {
      groups = centers.map(() => []);
      for (const s of list) {
        let best = 0;
        centers.forEach((c, i) => { if (meters(c, s) < meters(centers[best], s)) best = i; });
        groups[best].push(s);
      }
      groups.forEach((g, i) => {
        if (g.length) centers[i] = { lat: g.reduce((a, s) => a + s.lat, 0) / g.length, lng: g.reduce((a, s) => a + s.lng, 0) / g.length };
      });
    }
    return groups;
  }

  // Returns a short summary of what changed, for the toast.
  function buildDays(count, start, end, keepDay = 0) {
    const trip = state.trip;
    const startMin = toMin(start), endMin = toMin(end);
    const before = trip.days ? JSON.stringify([trip.days.list, trip.days.leftover]) : null;
    const list = spots().filter((s) => s.category !== "stay" && !s.skip);
    const fits = (ids) => scheduleDay(ids, startMin).endsAt <= endMin;
    let days = clusterSpots(list, count).map((g) => optimize(g.map((s) => s.id)));
    const leftover = [];
    // Trim days that run past the end time, then try to fit the extras into
    // the nearest day that still has room.
    days = days.map((ids) => {
      const kept = ids.slice();
      while (kept.length && !fits(kept)) leftover.push(kept.pop());
      return kept;
    });
    for (let i = leftover.length - 1; i >= 0; i--) {
      const s = spotById(leftover[i]);
      const options = days
        .map((ids, d) => ({ d, dist: ids.length ? Math.min(...ids.map((id) => meters(spotById(id), s))) : 0 }))
        .sort((a, b) => a.dist - b.dist);
      for (const { d } of options) {
        const trial = optimize([...days[d], s.id]);
        if (fits(trial)) { days[d] = trial; leftover.splice(i, 1); break; }
      }
    }
    // Balance: move border spots from the busiest day to the lightest until
    // the days end within about an hour of each other.
    const endOf = (ids) => scheduleDay(ids, startMin).endsAt;
    const centre = (ids) => ({ lat: ids.reduce((a, id) => a + spotById(id).lat, 0) / ids.length, lng: ids.reduce((a, id) => a + spotById(id).lng, 0) / ids.length });
    for (let guard = 0; guard < 30 && days.length > 1; guard++) {
      const order = days.map((ids, i) => ({ i, end: ids.length ? endOf(ids) : startMin })).sort((a, b) => b.end - a.end);
      const busy = order[0], light = order[order.length - 1];
      if (busy.end - light.end < 75 || days[busy.i].length < 2) break;
      const target = days[light.i].length ? centre(days[light.i]) : spotById(days[busy.i][0]);
      const move = days[busy.i].slice().sort((a, b) => meters(spotById(a), target) - meters(spotById(b), target))[0];
      const newLight = optimize([...days[light.i], move]);
      const newBusy = optimize(days[busy.i].filter((id) => id !== move));
      if (!fits(newLight) || endOf(newLight) >= busy.end) break;
      days[light.i] = newLight;
      days[busy.i] = newBusy;
    }
    const current = Math.min(keepDay, count - 1);
    trip.days = { count, start, end, list: days, leftover, current };
    trip.plan = days[current].slice();
    save();
    const stops = days.reduce((n, d) => n + d.length, 0);
    return {
      changed: before !== JSON.stringify([days, leftover]),
      stops,
      text: `${stops} stop${stops === 1 ? "" : "s"} over ${count} day${count > 1 ? "s" : ""}` +
        (leftover.length ? ` · ${leftover.length} didn't fit` : ""),
    };
  }

  function selectDay(i) {
    const days = state.trip.days;
    save(); // stores edits to the current day
    days.current = i;
    state.trip.plan = days.list[i].slice();
    save();
    renderMarkers();
    updateHeader();
    showPlan();
  }

  // Dates for each day when the city is in the itinerary.
  function dayDate(i) {
    const idx = stays().findIndex((x) => x.tripId === state.trip.id);
    const dates = stayDates();
    if (idx < 0 || !dates[idx]) return null;
    return new Date(dates[idx].arrive.getTime() + i * 86400000);
  }
  function defaultDayCount() {
    const mine = stays().filter((x) => x.tripId === state.trip.id);
    return mine.length ? mine.reduce((n, x) => n + Math.max(1, Number(x.nights) || 0), 0) : 2;
  }

  function daysHtml() {
    const trip = state.trip;
    const d = trip.days;
    if (!d || state.editingDays) {
      return `<form class="section form days-box" id="days-form">
        <h3>Plan my days</h3>
        <p class="hint">The app splits your ${spots().length} saved spots into days by area, in walking order, with times for each stop and a lunch break.</p>
        <div class="days-row">
          <label>Days<input id="d-count" type="number" min="1" max="14" value="${d?.count || defaultDayCount()}" /></label>
          <label>Start<input id="d-start" type="time" value="${esc(d?.start || "09:00")}" /></label>
          <label>End<input id="d-end" type="time" value="${esc(d?.end || "19:00")}" /></label>
        </div>
        <div class="actions"><button class="btn primary" type="submit">${ICON("calendar")} Build my days</button>
          ${d ? `<button class="btn" type="button" id="days-cancel">Cancel</button>` : ""}</div>
      </form>`;
    }
    const date = dayDate(d.current);
    const sun = window.WPSun.sunTimes(date || new Date(), trip.center[0], trip.center[1]);
    const t = (x) => (x ? fmtTime(x) : "–");
    const sched = scheduleDay(plan(), toMin(d.start));
    const over = sched.endsAt > toMin(d.end);
    return `<div class="section days-box">
      <div class="day-chips">${d.list.map((ids, i) => `<button class="day-chip ${i === d.current ? "on" : ""}" data-day="${i}">Day ${i + 1}<small>${ids.length} stops</small></button>`).join("")}</div>
      <p class="day-line"><b>${date ? fmtDay(date) : `Day ${d.current + 1}`}</b> · ${esc(d.start)}–${esc(d.end)} · ${plan().length ? `ends about ${fmtClock(sched.endsAt)}` : "no stops yet"}${over ? ` <span class="warn">runs late</span>` : ""}</p>
      <p class="hint">🌅 Sunrise ${t(sun.sunrise)}, golden light until ${t(sun.goldenMorningEnd)} · 🌇 golden light from ${t(sun.goldenEveningStart)}, sunset ${t(sun.sunset)}${date ? "" : " (today)"}</p>
      ${d.leftover.length ? `<p class="hint">⚠️ ${d.leftover.length} spot${d.leftover.length > 1 ? "s" : ""} didn't fit: add a day, longer hours, or drop some. They're listed at the bottom.</p>` : ""}
      <div class="actions"><button class="btn small" id="days-edit">${ICON("clock")} Days &amp; hours</button><button class="btn small" id="days-rebuild">${ICON("refresh")} Rebuild</button></div>
    </div>`;
  }

  // Pose photos you've saved for each stop, shown right in the day list.
  async function fillRowPoses() {
    for (const el of document.querySelectorAll(".row-poses[data-poses]")) {
      const photos = (await db.byspot(el.dataset.poses).catch(() => [])).sort((a, b) => a.createdAt - b.createdAt);
      if (!photos.length || !el.isConnected) continue;
      const guided = photos.filter((p) => p.notes || p.guide).length;
      el.innerHTML = photos.slice(0, 4).map((p) => `<img src="${urlFor(p)}" alt="Pose to recreate" />`).join("") +
        `<span class="muted">${photos.length} pose${photos.length > 1 ? "s" : ""}${guided ? ` · 📍 where to stand ✓` : ` · tap ✨ for where to stand`}</span>`;
    }
  }

  // ----- My day -----
  function showPlan(open = true) {
    ensurePlanChinese();
    state.view = "plan";
    state.selected = null;
    const days = state.trip.days;
    const dDate = days ? dayDate(days.current) : null;
    setHeading(days ? `Day ${days.current + 1}${dDate ? ` · ${fmtDay(dDate)}` : ""} · ${state.trip.name}` : `My day in ${state.trip.name}`, false);
    const stops = plan().map(spotById).filter(Boolean);
    const sched = days ? scheduleDay(plan(), toMin(days.start)) : null;
    const timeOf = (id) => sched?.items.find((x) => x.type === "stop" && x.id === id);
    const lunchBefore = (id) => {
      if (!sched) return null;
      const i = sched.items.findIndex((x) => x.type === "stop" && x.id === id);
      return i > 0 && sched.items[i - 1].type === "lunch" ? sched.items[i - 1] : null;
    };
    const start = state.trip.start;
    const walk = [start, ...stops].filter(Boolean);
    let total = 0, dist = 0;
    walk.forEach((s, i) => { if (i) { total += walkMin(walk[i - 1], s); dist += meters(walk[i - 1], s) * DETOUR; } });

    const rows = stops.map((s, i) => {
      const cat = CATS[s.category] || CATS.sight;
      const prev = i ? stops[i - 1] : start;
      const leg = prev ? legHtml(prev, s, `p${i}`) : "";
      const time = timeOf(s.id);
      const lunch = lunchBefore(s.id);
      return `${leg}${lunch ? `<li class="leg lunch">🍽️ ${fmtClock(lunch.at)} Lunch break (1 h)</li>` : ""}<li data-id="${esc(s.id)}">
        <span class="stop-letter" style="background:${cat.color}">${LETTERS[i] || "•"}</span>
        <span class="stop-main"><div class="stop-name">${esc(s.name)}</div>
          <div class="stop-meta">${time ? `<b class="time">${fmtClock(time.arrive)}–${fmtClock(time.leave)}</b> · ` : ""}${cat.emoji} ${cat.label}${isDone(s.id) ? ' · <span class="stop-done">✓ shot taken</span>' : ""}</div>
          <div class="row-poses" data-poses="${esc(s.id)}"></div></span>
        <button class="mini" data-up="${i}" title="Move up" aria-label="Move up">${ICON("up")}</button>
        <button class="mini" data-down="${i}" title="Move down" aria-label="Move down">${ICON("down")}</button>
        <a class="mini rn-mini" target="_blank" rel="noopener" href="${spotRednoteUrl(s)}" title="Photo ideas for ${esc(s.name)} on RedNote" aria-label="${esc(s.name)} on RedNote">${ICON("book")}</a>
        <button class="mini" data-remove="${esc(s.id)}" title="Take out of today's plan (keeps the pin)" aria-label="Take out of today's plan">${ICON("minus")}</button>
        <button class="mini" data-delspot="${esc(s.id)}" title="Delete pin" aria-label="Delete pin">${ICON("trash")}</button>
      </li>`;
    }).join("");

    const elsewhere = new Set(days ? days.list.flat() : []);
    const unplanned = spots().filter((s) => !plan().includes(s.id) && !elsewhere.has(s.id));
    body.innerHTML = `
      ${daysHtml()}
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
          ${stops.length > (start ? 1 : 2) ? `<button class="btn primary" id="btn-optimize">${ICON("sparkles")} Optimize</button>` : ""}
          ${stops.length ? `<a class="btn" target="_blank" rel="noopener" href="${gmapsWalkUrl(walk)}">${ICON("walk")} Walk in Google Maps</a>` : ""}
          <button class="btn" id="btn-find">${ICON("search")} Add spots</button>
          <button class="btn" id="btn-drop-pin">${ICON("pin")} Drop a pin</button>
          <button class="btn" id="btn-popular">${ICON("star")} Popular spots</button>
        </div>
      </div>
      ${stops.length ? `<ul class="plain stops">${rows}</ul>`
        : `<p class="empty">Your day is empty. Search for places with “🔍 Add spots” or tap “📍 Drop a pin”${map?.kind === "google" ? ", or tap any place on the map" : ""}.</p>`}
      ${unplanned.length ? `<div class="section"><h3>${days ? (days.leftover.length ? "Didn't fit / not in any day" : "Not in any day") : "Saved, not in today's plan"}</h3><ul class="plain nearby">
        ${unplanned.map((s) => `<li data-id="${esc(s.id)}"><span class="dot" style="background:${(CATS[s.category] || CATS.sight).color}"></span>
          <span class="nearby-name">${esc(s.name)}</span><button class="mini text" data-addplan="${esc(s.id)}">${ICON("plus")} Add</button><button class="mini" data-delspot="${esc(s.id)}" title="Delete pin" aria-label="Delete pin">${ICON("trash")}</button></li>`).join("")}
      </ul></div>` : ""}`;
    if (open) openPanel();
    fillRowPoses();
  }

  // ----- Spot details -----
  function detailsHtml(s) {
    return `
      ${s.description ? `<p class="muted">${esc(s.description)}</p>` : ""}
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
          <a class="btn rn-btn" id="rn-top" target="_blank" rel="noopener" href="${spotRednoteUrl(spot)}">${ICON("book")} Ideas on RedNote</a>
          <button class="btn ${inPlan ? "" : "primary"}" id="btn-toggle-plan">${inPlan ? `${ICON("check")} In my day` : `${ICON("plus")} Add to my day`}</button>
          <a class="btn" target="_blank" rel="noopener" href="${gmapsWalkUrl([spot])}">${ICON("directions")} Directions</a>
          <a class="btn" target="_blank" rel="noopener" href="${gmapsPlaceUrl(spot)}">${ICON("map")} Google Maps</a>
          <label class="btn check"><input type="checkbox" id="chk-done" ${isDone(id) ? "checked" : ""}/> Got my shot</label>
          <button class="btn danger" id="btn-delete-spot">${ICON("trash")} Delete pin</button>
        </div>
      </div>
      <div class="section">
        <h3>Pose inspiration</h3>
        <div class="gallery" id="gallery"></div>
        <p class="hint">Save photos you love from RedNote, Instagram or Pinterest and upload them here. Tap one, then <b>Where to stand &amp; how to pose</b>.</p>
      </div>
      ${rednoteHtml(spot)}
      ${ccHtml()}
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
    ensureChinese(spot);
    loadFreePhotos(spot);

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
      spot.photoUrl && { src: spot.photoUrl, credit: spot.photoCredit || "Google Maps" },
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
  const urlFor = (p) => {
    if (!p.blob) return p.src || "";
    if (!urls.has(p.id)) urls.set(p.id, URL.createObjectURL(p.blob));
    return urls.get(p.id);
  };

  async function renderGallery(spotId) {
    const el = $("gallery");
    if (!el) return;
    const photos = (await db.byspot(spotId).catch(() => [])).sort((a, b) => a.createdAt - b.createdAt);
    if (state.selected !== spotId) return;
    el.innerHTML = photos.map((p, i) => `
      <div class="thumb" role="button" tabindex="0" data-open="${i}">
        <img src="${urlFor(p)}" alt="Pose inspiration ${i + 1}" loading="lazy" />
        ${p.recreated ? `<span class="badge">✓ Recreated</span>` : ""}
        ${p.credit ? `<span class="badge cc-badge">CC</span>` : ""}
        ${p.guide || p.notes ? `<span class="badge ai">✨ Guide</span>` : ""}
        <button class="del" data-del="${esc(p.id)}" aria-label="Delete photo">${ICON("xmark")}</button>
      </div>`).join("") +
      `<button class="thumb add" id="btn-upload">${ICON("camera")}<span>Add pose photos</span></button>`;
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
        <div class="actions"><button class="btn" type="button" id="btn-drop-pin">${ICON("pin")} Drop a pin on the map instead</button></div>
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
          ${saved ? `<span class="muted">Saved</span>` : `<button class="mini text" data-quickadd="${i}">${ICON("plus")} Add</button>`}
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
          <button class="btn primary" id="btn-add-candidate">${ICON("plus")} Add to my day</button>
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

  // ----- Multi-city itinerary -----
  // An ordered list of stays, e.g. Brussels (2 nights) → Bruges (day trip)
  // → Ghent (1 night). Each stay points at a trip (city) with its own spots.
  // The same city can appear twice, e.g. returning to base after a day trip.
  const itinerary = store.get("itinerary", { startDate: "", stays: [] });
  const saveItinerary = () => store.set("itinerary", itinerary);
  const tripById = (id) => trips.find((t) => t.id === id);
  const cityPoint = (t) => ({ name: t.name, lat: t.center[0], lng: t.center[1] });
  const stays = () => itinerary.stays.filter((x) => tripById(x.tripId));

  // Arrival date of each stay, counted from the start date.
  function stayDates() {
    if (!itinerary.startDate) return [];
    let day = new Date(`${itinerary.startDate}T12:00`);
    return stays().map((x) => {
      const arrive = new Date(day);
      const nights = Number(x.nights) || 0;
      day = new Date(day.getTime() + nights * 86400000);
      return { arrive, leave: new Date(day) };
    });
  }

  // Rough door-to-door train time, shown before live options load.
  const roughTrainMin = (km) => Math.round(25 + (km / 85) * 60);

  function showItinerary() {
    state.view = "itinerary";
    state.selected = null;
    setHeading("My itinerary");
    const list = stays();
    const dates = stayDates();
    const last = list.length ? cityPoint(tripById(list[list.length - 1].tripId)) : cityPoint(state.trip);
    const lastId = list.length ? list[list.length - 1].tripId : null;
    const candidates = trips
      .filter((t) => t.id !== lastId)
      .map((t) => ({ t, km: meters(last, cityPoint(t)) / 1000 }))
      .sort((a, b) => a.km - b.km);

    const rows = list.map((x, i) => {
      const t = tripById(x.tripId);
      const nights = Number(x.nights) || 0;
      const d = dates[i];
      let travel = "";
      if (i > 0) {
        const prev = tripById(list[i - 1].tripId);
        const from = cityPoint(prev), to = cityPoint(t);
        const km = meters(from, to) / 1000;
        const key = `c${i}`;
        const when = d ? new Date(d.arrive.getTime() - 3 * 3600000) : null; // 9:00 on travel day
        state.legs[key] = { from, to, when, intercity: true };
        travel = `<li class="leg travel-leg"><span>↓ 🚆 ${esc(prev.name)} → ${esc(t.name)} · ${Math.round(km)} km · ~${fmtMin(roughTrainMin(km))}${d ? ` · ${fmtDay(d.arrive)}` : ""}</span>
            <button class="leg-btn hot" data-leg="${key}">${ICON("train")} Trains &amp; buses</button></li>
          <li class="leg-detail" id="leg-${key}" hidden></li>`;
      }
      return `${travel}<li class="stay">
          <span class="stop-letter" style="background:var(--tint)">${i + 1}</span>
          <span class="stop-main">
            <div class="stop-name">${esc(t.name)}</div>
            <div class="stop-meta">${nights ? `${nights} night${nights > 1 ? "s" : ""}` : "Day trip"}${d ? ` · ${fmtDay(d.arrive)}${nights ? ` – ${fmtDay(d.leave)}` : ""}` : ""} · ${t.spots.length} spots</div>
            <div class="stay-tools">
              <button class="mini" data-nights="${i}" data-delta="-1" aria-label="One night less">${ICON("minus")}</button>
              <span class="nights">${nights ? `${nights} night${nights > 1 ? "s" : ""}` : "day trip"}</span>
              <button class="mini" data-nights="${i}" data-delta="1" aria-label="One night more">${ICON("plus")}</button>
              <button class="btn small primary" data-opencity="${esc(t.id)}">Open city ${ICON("right")}</button>
            </div>
          </span>
          <button class="mini" data-stayup="${i}" title="Move up" aria-label="Move up">${ICON("up")}</button>
          <button class="mini" data-staydown="${i}" title="Move down" aria-label="Move down">${ICON("down")}</button>
          <button class="mini" data-stayremove="${i}" title="Remove from itinerary" aria-label="Remove from itinerary">${ICON("xmark")}</button>
        </li>`;
    }).join("");

    const totalNights = list.reduce((n, x) => n + (Number(x.nights) || 0), 0);
    body.innerHTML = `
      <div class="section form">
        <p class="hint">Plan the cities you'll visit in order. Set how long you stay; 0 nights is a day trip. Open a city to plan its spots and photos.</p>
        <label for="it-start">Trip starts on</label>
        <input id="it-start" type="date" value="${esc(itinerary.startDate)}" />
        ${list.length ? `<p class="hint">${list.length} ${list.length > 1 ? "stops" : "stop"} · ${totalNights} night${totalNights === 1 ? "" : "s"}${dates.length ? ` · until ${fmtDay(dates[dates.length - 1].leave)}` : ""}</p>` : ""}
      </div>
      ${list.length ? `<ul class="plain stops">${rows}</ul>` : `<p class="empty">No cities yet. Add your first city below, e.g. Brussels, then Bruges or Ghent.</p>`}
      <form class="section form" id="stay-form">
        <label for="stay-city">${list.length ? "Then go to…" : "Start in…"}</label>
        <div class="search-row">
          <select id="stay-city">${candidates.map(({ t, km }) =>
            `<option value="${esc(t.id)}">${esc(t.name)}${list.length && km >= 1 ? ` (${Math.round(km)} km)` : ""}</option>`).join("")}</select>
          <select id="stay-nights" aria-label="Nights">
            <option value="0">Day trip</option>${[1, 2, 3, 4, 5, 6, 7].map((n) => `<option value="${n}" ${n === 2 ? "selected" : ""}>${n} night${n > 1 ? "s" : ""}</option>`).join("")}
          </select>
          <button class="btn primary" type="submit">Add</button>
        </div>
        <p class="hint">City not listed? <button class="linkish" type="button" id="it-newcity">Add a new city</button> first.</p>
      </form>`;
    openPanel();
    renderMarkers();
  }

  // Map overview of the whole itinerary: numbered cities joined in order.
  function renderOverview() {
    const list = stays();
    const pts = list.map((x) => cityPoint(tripById(x.tripId)));
    map.render(list.map((x, i) => {
      const t = tripById(x.tripId);
      const p = cityPoint(t);
      return { lat: p.lat, lng: p.lng, title: t.name, label: String(i + 1), color: "#7a1f5c", showName: true,
        onClick: () => { switchTrip(t); showPlan(); } };
    }));
    map.setRoute(pts);
    if (pts.length && !state.overview) map.fitPoints(pts, PHONE() ? window.innerHeight * 0.6 : 40);
    state.overview = true;
  }

  // ----- Trips (city picker) -----
  function showTrips() {
    state.view = "trips";
    state.selected = null;
    setHeading("My trips");
    const n = stays().length;
    body.innerHTML = `
      <div class="section">
        <button class="btn primary wide" id="btn-itinerary">${ICON("route")} My itinerary${n ? ` · ${n} ${n > 1 ? "stops" : "stop"}` : ""}</button>
        <p class="hint">Plan several cities in a row, e.g. Brussels → Bruges → Ghent, with trains between them.</p>
      </div>
      <ul class="plain stops">${trips.map((t) => `
        <li data-trip="${esc(t.id)}" class="${t.id === state.trip.id ? "current" : ""}">
          <span class="stop-letter" style="background:var(--tint)">${esc(t.name.slice(0, 1).toUpperCase())}</span>
          <span class="stop-main"><div class="stop-name">${esc(t.name)}</div>
            <div class="stop-meta">${t.spots.length} spots${t.plan ? ` · ${t.plan.length} in plan` : ""}${t.id === state.trip.id ? " · <b>open now</b>" : ""}</div></span>
          ${trips.length > 1 ? `<button class="mini" data-deltrip="${esc(t.id)}" title="Delete trip" aria-label="Delete trip">${ICON("trash")}</button>` : ""}
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
      ? state.cityResults.map((c, i) => `<li data-city="${i}"><span class="dot" style="background:var(--tint)"></span>
          <span class="stop-main"><div class="stop-name">${esc(c.name)}</div><div class="stop-meta">${esc(c.label)}</div></span>
          <button class="mini text" data-city="${i}">Start trip ${ICON("right")}</button></li>`).join("")
      : `<li class="empty">No cities found.</li>`;
  }

  function switchTrip(trip) {
    state.trip = trip;
    state.editingStart = false;
    state.editingDays = false;
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
    itinerary.stays = itinerary.stays.filter((x) => x.tripId !== id);
    saveItinerary();
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
    $("lb-credit").innerHTML = p.credit
      ? `Photo: <a href="${esc(p.credit.page)}" target="_blank" rel="noopener">${esc(p.credit.creator)}</a> · ${p.credit.licenceUrl ? `<a href="${esc(p.credit.licenceUrl)}" target="_blank" rel="noopener">${esc(p.credit.licence)}</a>` : esc(p.credit.licence)}`
      : "";
    $("lb-prev").hidden = photos.length < 2;
    $("lb-next").hidden = photos.length < 2;
    $("lb-ai").innerHTML = `${ICON("sparkles")} ${p.guide || p.notes ? "Show photo guide" : "Where to stand & how to pose"}`;
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
      ${g.where_to_stand ? `<h4>📍 Where to stand</h4><p>${esc(g.where_to_stand)}</p>` : ""}
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
    if (!p.blob) return false;
    try { return !!navigator.canShare?.({ files: [photoFile(p)] }); } catch { return false; }
  };
  function coachPrompt(p) {
    const spot = spotById(p.spotId);
    return window.WPAI.freePrompt({ spotName: spot?.name, cityName: state.trip.name, bestTime: spot?.bestTime, address: spot?.address, lat: spot?.lat, lng: spot?.lng });
  }

  function showFreeCoach(p) {
    const share = canShareFile(p);
    $("lb-guide").innerHTML = `
      ${p.notes ? `<h4>📝 Your photo guide: where to stand & how to pose</h4><div class="notes">${esc(p.notes)}</div>` : ""}
      <h4>✨ ${p.notes ? "Ask again" : "Where to stand & how to pose"}</h4>
      <p>Find out exactly where to stand for this background, how to pose, and the camera settings, using the free Claude app:</p>
      <ol>
        ${share
          ? "<li>Tap <b>Share to Claude</b> and pick the Claude app. The question is copied too; paste it if it doesn't appear.</li>"
          : "<li>Tap <b>Copy question &amp; open Claude</b>.</li><li>Drag this photo into the Claude chat (or save it and attach it), paste the question if it isn't there, and send.</li>"}
        <li>Copy Claude's answer and paste it below to keep it with this photo.</li>
      </ol>
      <div class="actions">
        ${share ? `<button class="btn primary" id="coach-share">${ICON("share")} Share to Claude</button>` : ""}
        <button class="btn ${share ? "" : "primary"}" id="coach-open">${ICON("copy")} Copy question &amp; open Claude</button>
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
      $("lb-ai").innerHTML = `${ICON("sparkles")} ${p.notes ? "Show photo guide" : "Where to stand & how to pose"}`;
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
    btn.innerHTML = `${ICON("sparkles")} Studying the photo…`;
    const spot = spotById(p.spotId);
    try {
      const guide = await window.WPAI.photoGuide({
        apiKey: settings.claudeKey,
        blob: p.blob || await (await fetch(p.src)).blob(),
        spotName: spot?.name,
        cityName: state.trip.name,
        bestTime: spot?.bestTime,
      });
      p.guide = guide;
      await db.put(p);
      if (state.lightbox.photos[state.lightbox.index] === p) {
        showGuide(guide);
        btn.innerHTML = `${ICON("sparkles")} Show photo guide`;
      }
      renderGallery(p.spotId);
    } catch (err) {
      toast(err.message, 7000);
      btn.innerHTML = `${ICON("sparkles")} Where to stand & how to pose`;
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
    if (state.trip.days) {
      state.trip.days.list = state.trip.days.list.map((ids) => ids.filter((x) => x !== id));
      state.trip.days.leftover = state.trip.days.leftover.filter((x) => x !== id);
    }
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
    if (e.target.id === "days-form") {
      const count = Math.max(1, Math.min(14, Number($("d-count").value) || 1));
      const start = $("d-start").value || "09:00", end = $("d-end").value || "19:00";
      if (toMin(end) <= toMin(start) + 60) return toast("Make the end time at least an hour after the start.");
      if (!spots().some((x) => x.category !== "stay" && !x.skip)) {
        return toast("Add some spots first: tap “Popular spots” or “Add spots”, then build your days.");
      }
      state.editingDays = false;
      const keep = state.trip.days && state.trip.days.count === count ? state.trip.days.current : 0;
      const res = buildDays(count, start, end, keep);
      renderMarkers(); updateHeader(); showPlan();
      return toast(`Planned ${res.text} ✨`);
    }
    if (e.target.id === "post-form") {
      const spot = spotById(state.selected);
      const post = parseShared($("post-link").value);
      if (!spot) return;
      if (!post) return toast("Paste a link that starts with http, e.g. from RedNote's Share → Copy link.");
      spot.posts = [...(spot.posts || []), { ...post, site: postSite(post.url), addedAt: Date.now() }];
      save();
      $("rednote").outerHTML = rednoteHtml(spot);
      return toast("Post saved to this spot ✓");
    }
    if (e.target.id === "stay-form") {
      itinerary.stays = stays();
      itinerary.stays.push({ id: uid("s-"), tripId: $("stay-city").value, nights: Number($("stay-nights").value) });
      saveItinerary();
      state.overview = false;
      return showItinerary();
    }
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
    if (d.day !== undefined) return selectDay(Number(d.day));
    if (t.id === "days-edit") { state.editingDays = true; return showPlan(); }
    if (t.id === "days-cancel") { state.editingDays = false; return showPlan(); }
    if (t.id === "days-rebuild") {
      const dd = state.trip.days;
      if (!spots().some((x) => x.category !== "stay" && !x.skip)) {
        return toast("There are no spots to plan yet. Tap “Popular spots” or “Add spots” first.");
      }
      const res = buildDays(dd.count, dd.start, dd.end, dd.current);
      renderMarkers(); updateHeader(); showPlan();
      return toast(res.changed
        ? `Rebuilt: ${res.text} ✨`
        : `Already the best plan for these spots (${res.text}). Add, remove or change hours, then rebuild.`, 6000);
    }
    if (d.ccpose !== undefined) {
      const item = state.ccItems?.[Number(d.ccpose)];
      if (!item) return;
      t.disabled = true;
      await saveCcAsPose(item, state.selected);
      t.innerHTML = `${ICON("check")} Saved`;
      return;
    }
    if (d.showpost !== undefined) {
      const spot = spotById(state.selected);
      const box = $(`post-embed-${d.showpost}`);
      const post = spot?.posts?.[Number(d.showpost)];
      if (!box || !post) return;
      if (box.hidden) {
        if (!box.innerHTML) box.innerHTML = window.WPInspo.embedFrame(post.url);
        box.hidden = false;
        t.innerHTML = `${ICON("up")} Hide`;
      } else {
        box.hidden = true;
        t.innerHTML = `${ICON("down")} View`;
      }
      return;
    }
    if (d.rn !== undefined) {
      const term = state.rnTerms[Number(d.rn)];
      navigator.clipboard?.writeText(term).catch(() => {});
      window.open(rednoteUrl(term), "_blank", "noopener");
      return toast(`Copied “${term}”. If RedNote opens without results, paste it into its search.`, 6000);
    }
    if (d.delpost !== undefined) {
      const spot = spotById(state.selected);
      spot.posts.splice(Number(d.delpost), 1);
      save();
      $("rednote").outerHTML = rednoteHtml(spot);
      return;
    }
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
    if (d.remove) {
      state.trip.plan = plan().filter((x) => x !== d.remove);
      if (state.trip.days) {
        const sp = spotById(d.remove);
        if (sp) sp.skip = true;   // stays out when you rebuild; ＋ Add brings it back
        toast(`${sp?.name || "Spot"} won't be planned. Tap ＋ Add to bring it back.`);
      }
      return rerender();
    }
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
    if (t.id === "btn-itinerary") return showItinerary();
    if (t.id === "it-newcity") { showTrips(); $("city-q")?.focus(); return; }
    if (d.opencity) { switchTrip(tripById(d.opencity)); return showPlan(); }
    if (d.nights !== undefined) {
      const x = stays()[Number(d.nights)];
      x.nights = Math.max(0, Math.min(30, (Number(x.nights) || 0) + Number(d.delta)));
      saveItinerary();
      return showItinerary();
    }
    if (d.stayup !== undefined || d.staydown !== undefined) {
      const list = itinerary.stays = stays();
      const i = Number(d.stayup ?? d.staydown), j = d.stayup !== undefined ? i - 1 : i + 1;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      saveItinerary();
      state.overview = false;
      return showItinerary();
    }
    if (d.stayremove !== undefined) {
      itinerary.stays = stays();
      itinerary.stays.splice(Number(d.stayremove), 1);
      saveItinerary();
      state.overview = false;
      return showItinerary();
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
  body.addEventListener("change", (e) => {
    if (e.target.id === "it-start") {
      itinerary.startDate = e.target.value;
      saveItinerary();
      showItinerary();
    }
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
    if (state.view === "itinerary") { showTrips(); return renderMarkers(); }
    showPlan(); renderMarkers();
  };
  $("btn-close").onclick = () => { setPanel("closed"); state.selected = null; renderMarkers(); };
  $("btn-expand").onclick = () => {
    const expanded = panel.dataset.state === "expanded";
    setPanel(expanded ? "open" : "expanded");
    $("btn-expand").innerHTML = ICON(expanded ? "expand" : "shrink");
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
