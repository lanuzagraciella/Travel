/* Map layer. Uses Google Maps when a Google Maps API key is saved in
 * Settings, otherwise falls back to OpenStreetMap through Leaflet.
 * Both adapters expose the same small interface used by app.js:
 *   kind, setView(center, zoom), getCenter(), getZoom(), panTo(lat, lng, offsetY),
 *   render(pins), setRoute(points), resize(), destroy()
 */
(() => {
  "use strict";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // Same pin markup for both map engines. The tip of the rotated square sits
  // 6px below the box, so both adapters anchor at (15, 36).
  function pinHtml(p) {
    const cls = ["pin", p.selected && "selected", p.done && "done"].filter(Boolean).join(" ");
    return `<div class="pin-wrap"><div class="${cls}" style="background:${p.color};opacity:${p.dim ? 0.75 : 1}"><span>${esc(p.label)}</span></div>` +
      (p.showName ? `<div class="pin-name">${esc(p.title)}</div>` : "") + "</div>";
  }

  // ---------- Leaflet / OpenStreetMap ----------
  function leafletMap(el, { center, zoom, onClick, onZoom }) {
    const map = L.map(el, { zoomControl: false }).setView(center, zoom);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    map.on("click", (e) => onClick({ lat: e.latlng.lat, lng: e.latlng.lng }));
    map.on("zoomend", onZoom);
    let markers = [];
    let route = null;
    return {
      kind: "osm",
      setView: (c, z) => map.setView(c, z),
      getCenter: () => { const c = map.getCenter(); return { lat: c.lat, lng: c.lng }; },
      getZoom: () => map.getZoom(),
      panTo(lat, lng, offsetY = 0) {
        const pt = map.project([lat, lng]).add([0, offsetY]);
        map.panTo(map.unproject(pt), { animate: true });
      },
      render(pins) {
        markers.forEach((m) => m.remove());
        markers = pins.map((p) => L.marker([p.lat, p.lng], {
          icon: L.divIcon({ className: "", html: pinHtml(p), iconSize: [30, 30], iconAnchor: [15, 36] }),
          title: p.title,
          zIndexOffset: p.selected ? 1000 : 0,
        }).addTo(map).on("click", p.onClick));
      },
      setRoute(points) {
        route?.remove();
        route = points.length > 1
          ? L.polyline(points.map((p) => [p.lat, p.lng]), { color: "#2a7de1", weight: 5, opacity: 0.8, dashArray: "1 9", lineCap: "round" }).addTo(map)
          : null;
      },
      resize: () => map.invalidateSize(),
      destroy: () => map.remove(),
    };
  }

  // ---------- Google Maps ----------
  let googleLoading = null;
  let googleOk = false;
  function loadGoogle(key) {
    googleLoading ||= new Promise((resolve, reject) => {
      window.__wpGoogleReady = () => resolve(window.google);
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&libraries=marker,places&callback=__wpGoogleReady`;
      s.async = true;
      s.onerror = () => reject(new Error("Could not load Google Maps"));
      document.head.appendChild(s);
    });
    return googleLoading;
  }

  async function googleMap(el, { center, zoom, onClick, onPlaceClick, onZoom }) {
    const g = window.google.maps;
    const { AdvancedMarkerElement } = await g.importLibrary("marker");
    const map = new g.Map(el, {
      center: { lat: center[0], lng: center[1] },
      zoom,
      mapId: "DEMO_MAP_ID",          // needed for advanced markers
      clickableIcons: true,           // Google's own places can be tapped and added
      fullscreenControl: false,
      mapTypeControl: false,
      streetViewControl: true,
      zoomControlOptions: { position: g.ControlPosition.RIGHT_BOTTOM },
    });
    map.addListener("click", (e) => {
      if (e.placeId) { e.stop(); onPlaceClick(e.placeId); return; }
      onClick({ lat: e.latLng.lat(), lng: e.latLng.lng() });
    });
    map.addListener("zoom_changed", onZoom);
    let markers = [];
    let route = null;
    return {
      kind: "google",
      setView: (c, z) => { map.setCenter({ lat: c[0], lng: c[1] }); map.setZoom(z); },
      getCenter: () => { const c = map.getCenter(); return { lat: c.lat(), lng: c.lng() }; },
      getZoom: () => map.getZoom(),
      panTo(lat, lng, offsetY = 0) {
        map.panTo({ lat, lng });
        if (offsetY) map.panBy(0, offsetY);
      },
      render(pins) {
        markers.forEach((m) => { m.map = null; });
        markers = pins.map((p) => {
          const content = document.createElement("div");
          content.innerHTML = pinHtml(p);
          content.style.transform = "translateY(6px)";
          const m = new AdvancedMarkerElement({
            map, content, title: p.title,
            position: { lat: p.lat, lng: p.lng },
            zIndex: p.selected ? 1000 : undefined,
            gmpClickable: true,
          });
          m.addListener("click", p.onClick);
          return m;
        });
      },
      setRoute(points) {
        route?.setMap(null);
        route = null;
        if (points.length < 2) return;
        route = new g.Polyline({
          map,
          path: points.map((p) => ({ lat: p.lat, lng: p.lng })),
          strokeOpacity: 0,
          icons: [{ icon: { path: g.SymbolPath.CIRCLE, scale: 2.5, fillColor: "#2a7de1", fillOpacity: 0.9, strokeOpacity: 0 }, offset: "0", repeat: "11px" }],
        });
      },
      resize: () => {},               // Google Maps resizes itself
      destroy: () => { markers.forEach((m) => { m.map = null; }); route?.setMap(null); },
    };
  }

  // Create the best available map. If Google rejects the key (bad key,
  // API not enabled, billing off), onGoogleFailure is called so the app
  // can swap to OpenStreetMap.
  async function createMap(el, opts) {
    if (opts.googleKey) {
      try {
        window.gm_authFailure = () => { googleOk = false; opts.onGoogleFailure?.("Google Maps rejected the API key."); };
        await loadGoogle(opts.googleKey);
        const m = await googleMap(el, opts);
        googleOk = true;
        return m;
      } catch (err) {
        opts.onGoogleFailure?.(err.message);
      }
    }
    return leafletMap(el, opts);
  }

  window.WPMaps = { createMap, leafletMap, googleReady: () => googleOk && !!window.google?.maps?.places };
})();
