/* Wanderpose: plan travel spots, walk them in the best order, and collect
 * pose inspiration to recreate at each one. Everything is stored on the
 * device: spots and plan in localStorage, uploaded photos in IndexedDB. */
(() => {
  "use strict";

  const CATS = window.CATEGORIES;
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const WALK_M_PER_MIN = 80;   // ~4.8 km/h
  const DETOUR = 1.3;          // streets aren't straight lines

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
      all: () => tx("readonly", (s) => s.getAll()),
      put: (photo) => tx("readwrite", (s) => s.put(photo)),
      del: (id) => tx("readwrite", (s) => s.delete(id)),
    };
  })();

  // ---------- State ----------
  const state = {
    spots: store.get("spots", null) || structuredClone(window.SEED_SPOTS),
    plan: store.get("plan", null),
    done: new Set(store.get("done", [])),
    selected: null,
    view: "plan",          // "plan" | "spot" | "add"
    adding: false,
    pendingLatLng: null,
    lightbox: { photos: [], index: 0 },
  };
  const save = () => {
    store.set("spots", state.spots);
    store.set("plan", state.plan);
    store.set("done", [...state.done]);
  };
  const spotById = (id) => state.spots.find((s) => s.id === id);
  if (!state.plan) state.plan = optimize(state.spots.filter((s) => s.category !== "stay").map((s) => s.id));

  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function meters(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const walkMin = (a, b) => Math.max(1, Math.round((meters(a, b) * DETOUR) / WALK_M_PER_MIN));
  const fmtMin = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

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

  function gmapsWalkUrl(stops) {
    const ll = (s) => `${s.lat},${s.lng}`;
    if (stops.length === 1) return `https://www.google.com/maps/dir/?api=1&destination=${ll(stops[0])}&travelmode=walking`;
    const mid = stops.slice(1, -1).slice(0, 9); // Google allows up to 9 waypoints
    return "https://www.google.com/maps/dir/?api=1&travelmode=walking" +
      `&origin=${ll(stops[0])}&destination=${ll(stops[stops.length - 1])}` +
      (mid.length ? `&waypoints=${encodeURIComponent(mid.map(ll).join("|"))}` : "");
  }

  // Cover photos come from Wikipedia's summary API, cached per title.
  const coverCache = store.get("covers", {});
  async function coverFor(spot) {
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

  // ---------- Map ----------
  const map = L.map("map", { zoomControl: false }).setView(window.SEED_CITY.center, window.SEED_CITY.zoom);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const markers = new Map();
  let routeLine = null;

  function renderMarkers() {
    markers.forEach((m) => m.remove());
    markers.clear();
    state.spots.forEach((spot) => {
      const idx = state.plan.indexOf(spot.id);
      const cat = CATS[spot.category] || CATS.sight;
      const label = idx >= 0 ? LETTERS[idx] || "•" : cat.emoji;
      const cls = ["pin", spot.id === state.selected && "selected", state.done.has(spot.id) && "done"].filter(Boolean).join(" ");
      const icon = L.divIcon({
        className: "",
        html: `<div class="${cls}" style="background:${cat.color};opacity:${idx >= 0 ? 1 : 0.75}"><span>${label}</span></div>`,
        iconSize: [30, 30], iconAnchor: [15, 30],
      });
      const m = L.marker([spot.lat, spot.lng], { icon, title: spot.name })
        .addTo(map)
        .bindTooltip(esc(spot.name), { permanent: map.getZoom() >= 16, direction: "right", offset: [12, -16], className: "pin-label" })
        .on("click", () => showSpot(spot.id));
      markers.set(spot.id, m);
    });
    routeLine?.remove();
    const pts = state.plan.map(spotById).filter(Boolean).map((s) => [s.lat, s.lng]);
    if (pts.length > 1) routeLine = L.polyline(pts, { color: "#2a7de1", weight: 5, opacity: 0.8, dashArray: "1 9", lineCap: "round" }).addTo(map);
  }
  map.on("zoomend", renderMarkers);

  map.on("click", (e) => {
    if (!state.adding) return;
    state.pendingLatLng = e.latlng;
    setAdding(false);
    showAddForm();
  });

  function setAdding(on) {
    state.adding = on;
    document.body.classList.toggle("adding", on);
    $("btn-add").classList.toggle("active", on);
    $("add-hint").hidden = !on;
  }

  // ---------- Panel ----------
  const panel = $("panel");
  const body = $("panel-body");
  const setPanel = (s) => { panel.dataset.state = s; setTimeout(() => map.invalidateSize(), 280); };
  const openPanel = () => { if (panel.dataset.state === "closed") setPanel("open"); };

  function updateProgress() {
    const inPlan = state.plan.length;
    const got = state.plan.filter((id) => state.done.has(id)).length;
    $("progress-bar").style.width = inPlan ? `${(got / inPlan) * 100}%` : "0";
    $("progress-text").textContent = inPlan ? `📸 ${got} of ${inPlan} spots photographed` : "Plan your spots and your shots";
  }

  function rerender() {
    save();
    renderMarkers();
    updateProgress();
    if (state.view === "plan") showPlan(false);
    else if (state.view === "spot" && state.selected) showSpot(state.selected, false);
  }

  function showPlan(open = true) {
    state.view = "plan";
    state.selected = null;
    $("panel-heading").textContent = `My day in ${window.SEED_CITY.name}`;
    $("btn-back").hidden = true;
    const stops = state.plan.map(spotById).filter(Boolean);
    let total = 0, dist = 0;
    stops.forEach((s, i) => { if (i) { total += walkMin(stops[i - 1], s); dist += meters(stops[i - 1], s) * DETOUR; } });

    const rows = stops.map((s, i) => {
      const cat = CATS[s.category] || CATS.sight;
      const leg = i ? `<li class="leg">↓ ${walkMin(stops[i - 1], s)} min walk</li>` : "";
      return `${leg}<li data-id="${esc(s.id)}">
        <span class="stop-letter" style="background:${cat.color}">${LETTERS[i] || "•"}</span>
        <span class="stop-main"><div class="stop-name">${esc(s.name)}</div>
          <div class="stop-meta">${cat.emoji} ${cat.label}${state.done.has(s.id) ? ' · <span class="stop-done">✓ shot taken</span>' : ""}</div></span>
        <button class="mini" data-up="${i}" title="Move up" aria-label="Move up">▲</button>
        <button class="mini" data-down="${i}" title="Move down" aria-label="Move down">▼</button>
        <button class="mini" data-remove="${esc(s.id)}" title="Remove from day" aria-label="Remove">✕</button>
      </li>`;
    }).join("");

    const unplanned = state.spots.filter((s) => !state.plan.includes(s.id));
    body.innerHTML = `
      <div class="section">
        <div class="plan-summary">
          <span><b>${stops.length}</b> stops</span>
          <span><b>${fmtMin(total)}</b> walking</span>
          <span><b>${fmtDist(dist)}</b></span>
        </div>
        <div class="actions">
          <button class="btn primary" id="btn-optimize">✨ Optimize route</button>
          ${stops.length ? `<a class="btn" target="_blank" rel="noopener" href="${gmapsWalkUrl(stops)}">Walk it in Google Maps</a>` : ""}
        </div>
      </div>
      ${stops.length ? `<ul class="plain stops">${rows}</ul>`
        : `<p class="empty">Your day is empty. Tap a pin on the map and choose “Add to my day”.</p>`}
      ${unplanned.length ? `<div class="section"><h3>Not in today's plan</h3><ul class="plain nearby">
        ${unplanned.map((s) => `<li data-id="${esc(s.id)}"><span class="dot" style="background:${(CATS[s.category] || CATS.sight).color}"></span>
          <span class="nearby-name">${esc(s.name)}</span><button class="mini" data-addplan="${esc(s.id)}">＋ Add</button></li>`).join("")}
      </ul></div>` : ""}`;
    if (open) openPanel();
  }

  async function showSpot(id, open = true) {
    const spot = spotById(id);
    if (!spot) return;
    state.view = "spot";
    state.selected = id;
    renderMarkers();
    $("panel-heading").textContent = spot.name;
    $("btn-back").hidden = false;
    const cat = CATS[spot.category] || CATS.sight;
    const inPlan = state.plan.includes(id);

    const nearby = state.spots
      .filter((s) => s.id !== id)
      .map((s) => ({ s, d: meters(spot, s) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 5);

    body.innerHTML = `
      <div class="hero" id="hero">${cat.emoji}<div class="hero-band">${esc(spot.name)}</div></div>
      <div class="section">
        <span class="chip">${cat.emoji} ${cat.label}</span>
        ${spot.address ? `<p>📍 ${esc(spot.address)}</p>` : ""}
        ${spot.phone ? `<p>📞 <a href="tel:${esc(spot.phone.replace(/\s/g, ""))}">${esc(spot.phone)}</a></p>` : ""}
        ${spot.website ? `<p>🔗 <a href="${esc(spot.website)}" target="_blank" rel="noopener">${esc(spot.website.replace(/^https?:\/\//, ""))}</a></p>` : ""}
        ${spot.bestTime ? `<p>🕒 <b>Best light:</b> ${esc(spot.bestTime)}</p>` : ""}
        <div class="actions">
          <button class="btn ${inPlan ? "" : "primary"}" id="btn-toggle-plan">${inPlan ? "✓ In my day" : "＋ Add to my day"}</button>
          <a class="btn" target="_blank" rel="noopener" href="${gmapsWalkUrl([spot])}">Directions</a>
          <label class="btn check"><input type="checkbox" id="chk-done" ${state.done.has(id) ? "checked" : ""}/> Got my shot</label>
        </div>
      </div>
      <div class="section">
        <h3>Pose inspiration</h3>
        <div class="gallery" id="gallery"></div>
        <p style="font-size:12px;color:var(--muted)">Save photos you love from Instagram or Pinterest, then upload them here. Tap one on location to see it full screen while you shoot.</p>
      </div>
      ${spot.poses?.length ? `<div class="section"><h3>Shot ideas</h3><ul class="plain poses">${spot.poses.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}
      <div class="section">
        <h3>Walking distance from here</h3>
        <ul class="plain nearby">${nearby.map(({ s, d }) => `<li data-id="${esc(s.id)}">
          <span class="dot" style="background:${(CATS[s.category] || CATS.sight).color}"></span>
          <span class="nearby-name">${esc(s.name)}</span>
          <span class="walk">🚶 ${walkMin(spot, s)} min · ${fmtDist(d * DETOUR)}</span></li>`).join("")}</ul>
      </div>
      ${spot.custom ? `<div class="section"><button class="btn danger" id="btn-delete-spot">Delete this spot</button></div>` : ""}`;
    if (open) openPanel();
    // On phones the bottom sheet covers the lower half, so centre the pin in the visible part.
    const sheetOffset = window.innerWidth <= 720 ? (window.innerHeight * 0.58) / 2 : 0;
    const target = map.project([spot.lat, spot.lng]).add([0, sheetOffset]);
    map.panTo(map.unproject(target), { animate: true });

    renderGallery(id);
    const photos = await db.byspot(id).catch(() => []);
    const src = (await coverFor(spot)) || null;
    const hero = $("hero");
    if (hero && state.selected === id) {
      const fallback = photos[0] && urlFor(photos[0]);
      const img = src || fallback;
      if (img) {
        hero.style.backgroundImage = `url("${img}")`;
        hero.firstChild.textContent = "";
        if (src) hero.insertAdjacentHTML("beforeend", `<span class="hero-credit">Wikipedia</span>`);
      }
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
        <button class="del" data-del="${esc(p.id)}" aria-label="Delete photo">✕</button>
      </div>`).join("") +
      `<button class="thumb add" id="btn-upload">＋<br/>Add inspo photos</button>`;
    state.lightbox.photos = photos;
  }

  function showAddForm() {
    state.view = "add";
    state.selected = null;
    $("panel-heading").textContent = "New spot";
    $("btn-back").hidden = false;
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
      const spot = {
        id: "c-" + Date.now().toString(36),
        custom: true,
        name: $("f-name").value.trim() || "My spot",
        category: $("f-cat").value,
        lat, lng,
        address: $("f-addr").value.trim(),
        bestTime: $("f-time").value.trim(),
        poses: $("f-poses").value.split("\n").map((s) => s.trim()).filter(Boolean),
      };
      state.spots.push(spot);
      state.plan.push(spot.id);
      save();
      showSpot(spot.id);
      updateProgress();
    });
  }

  // ---------- Lightbox ----------
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
  }
  const stepLightbox = (d) => {
    const n = state.lightbox.photos.length;
    state.lightbox.index = (state.lightbox.index + d + n) % n;
    drawLightbox();
  };
  $("lb-close").onclick = () => { $("lightbox").hidden = true; };
  $("lb-prev").onclick = () => stepLightbox(-1);
  $("lb-next").onclick = () => stepLightbox(1);
  $("lb-done").onchange = async (e) => {
    const p = state.lightbox.photos[state.lightbox.index];
    p.recreated = e.target.checked;
    await db.put(p);
    if (p.recreated) state.done.add(p.spotId);
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
    renderGallery(spotId);
  });

  body.addEventListener("click", async (e) => {
    const t = e.target.closest("button, li[data-id], .thumb, input");
    if (!t) return;
    const d = t.dataset;

    if (t.id === "btn-optimize") { state.plan = optimize(state.plan); return rerender(); }
    if (t.id === "btn-upload") return $("file-input").click();
    if (t.id === "btn-toggle-plan") {
      const id = state.selected;
      state.plan = state.plan.includes(id) ? state.plan.filter((x) => x !== id) : [...state.plan, id];
      return rerender();
    }
    if (t.id === "chk-done") {
      t.checked ? state.done.add(state.selected) : state.done.delete(state.selected);
      return rerender();
    }
    if (t.id === "btn-delete-spot") {
      if (!confirm("Delete this spot and its photos?")) return;
      const id = state.selected;
      for (const p of await db.byspot(id)) await db.del(p.id);
      state.spots = state.spots.filter((s) => s.id !== id);
      state.plan = state.plan.filter((x) => x !== id);
      state.done.delete(id);
      save();
      renderMarkers();
      updateProgress();
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
      e.stopPropagation();
      const i = Number(d.up ?? d.down), j = d.up !== undefined ? i - 1 : i + 1;
      if (j < 0 || j >= state.plan.length) return;
      [state.plan[i], state.plan[j]] = [state.plan[j], state.plan[i]];
      return rerender();
    }
    if (d.remove) { e.stopPropagation(); state.plan = state.plan.filter((x) => x !== d.remove); return rerender(); }
    if (d.addplan) { e.stopPropagation(); state.plan.push(d.addplan); return rerender(); }
    if (d.id) return showSpot(d.id);
  });
  body.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.dataset.open !== undefined) openLightbox(Number(e.target.dataset.open));
  });

  $("btn-plan").onclick = () => {
    if (state.view === "plan" && panel.dataset.state !== "closed") return setPanel("closed");
    showPlan(); renderMarkers();
  };
  $("btn-back").onclick = () => { showPlan(); renderMarkers(); };
  $("btn-close").onclick = () => { setPanel("closed"); state.selected = null; renderMarkers(); };
  $("btn-expand").onclick = () => {
    const expanded = panel.dataset.state === "expanded";
    setPanel(expanded ? "open" : "expanded");
    $("btn-expand").textContent = expanded ? "⤢" : "⤡";
    $("btn-expand").title = expanded ? "Expand" : "Shrink";
  };
  $("panel-grip").onclick = () => $("btn-expand").click();
  $("btn-add").onclick = () => setAdding(!state.adding);
  $("btn-cancel-add").onclick = () => setAdding(false);

  // ---------- Boot ----------
  $("city-name").textContent = window.SEED_CITY.name;
  save();
  renderMarkers();
  updateProgress();
  showPlan(window.innerWidth > 720);
})();
