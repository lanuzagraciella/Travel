/* Google Maps links: paste a link (or the text the Google Maps app shares)
 * and get the place back. Full links are read right here; short
 * maps.app.goo.gl links are opened by the small /api/resolve-maps function. */
(() => {
  "use strict";

  const SHORT = /^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\//i;
  const COORDS = /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/;

  const findUrl = (text) => {
    const m = String(text).match(/(?:https?:\/\/)?(?:[\w-]+\.)*(?:google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\S*/i);
    if (!m) return null;
    return /^https?:\/\//i.test(m[0]) ? m[0].replace(/^http:/i, "https:") : `https://${m[0]}`;
  };

  // Something the user pasted that we should treat as a location, not a search.
  const isLink = (text) => !!findUrl(text) || COORDS.test(String(text));

  const decode = (s) => {
    try { return decodeURIComponent(s.replace(/\+/g, " ")).trim(); } catch { return s.replace(/\+/g, " ").trim(); }
  };
  // "50°50'47.6"N 4°21'09.9"E" or "50.84, 4.35" aren't names.
  const realName = (s) => s && !/°/.test(s) && !COORDS.test(s) ? s : null;
  const okCoords = (lat, lng) => Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng);

  // Reads a full Google Maps URL. Returns {name, lat, lng, query, near}.
  function parse(href) {
    const out = {};
    let url;
    try { url = new URL(href); } catch { return out; }
    const path = url.pathname + url.hash;
    const raw = decode(path);

    // The exact pin of a place: …!3d50.8466!4d4.3528 (the last one is the place).
    const pins = [...decodeURIComponent(path).matchAll(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/g)];
    if (pins.length) {
      const [, lat, lng] = pins[pins.length - 1];
      out.lat = Number(lat); out.lng = Number(lng);
    }
    let m;
    if ((m = path.match(/\/maps\/place\/([^/@?]+)/))) {
      const n = decode(m[1]);
      const c = n.match(COORDS);
      if (c && out.lat == null) { out.lat = Number(c[1]); out.lng = Number(c[2]); }
      out.name = realName(n);
    }
    if ((m = path.match(/\/maps\/search\/([^/@?]+)/))) {
      const n = decode(m[1]);
      const c = n.match(COORDS);
      if (c) { out.lat ??= Number(c[1]); out.lng ??= Number(c[2]); } else out.query = n;
    }
    for (const key of ["q", "query", "destination", "daddr", "ll", "center", "sll"]) {
      const v = url.searchParams.get(key);
      if (!v) continue;
      const c = v.replace(/^loc:/, "").match(COORDS);
      if (c) {
        if (out.lat == null) { out.lat = Number(c[1]); out.lng = Number(c[2]); }
      } else if (!out.name && !out.query && !["ll", "center", "sll"].includes(key)) {
        out.query = v.trim();
      }
    }
    // The map view: /@50.84,4.35,17z. Close to the place, but only the view.
    if ((m = raw.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/))) {
      out.near = { lat: Number(m[1]), lng: Number(m[2]) };
      if (out.lat == null && !out.query && (out.name || !path.includes("/dir/"))) {
        out.lat = out.near.lat; out.lng = out.near.lng;
      }
    }
    if (out.lat != null && !okCoords(out.lat, out.lng)) { delete out.lat; delete out.lng; }
    return out;
  }

  // The name in text shared from the Google Maps app ("Hotel Amigo\nRue …\nhttps://…").
  function nameFromShare(text, url) {
    const before = String(text).split(/(?:https?:\/\/)?(?:[\w-]+\.)*(?:google\.|maps\.app\.goo\.gl|goo\.gl|g\.co)/i)[0];
    const first = before.split(/\n/).map((l) => l.trim()).find(Boolean) || "";
    const n = first.replace(/[,:\-–—]+$/, "").split(/,\s/)[0].trim();
    return n && n.length <= 80 && !url.includes(n) ? n : null;
  }

  async function expand(short) {
    let r;
    try {
      r = await fetch(`/api/resolve-maps?url=${encodeURIComponent(short)}`);
    } catch {
      r = null;
    }
    if (!r || !r.ok || !(r.headers.get("content-type") || "").includes("json")) return null;
    return (await r.json()).url || null;
  }

  async function reverse(lat, lng) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?${new URLSearchParams({
        format: "jsonv2", lat, lon: lng, zoom: "18" })}`,
      { headers: { "Accept-Language": navigator.language || "en" } });
      if (!r.ok) return null;
      const j = await r.json();
      return j && !j.error ? { name: j.name || null, address: j.display_name || "" } : null;
    } catch {
      return null;
    }
  }

  const spotFrom = (name, lat, lng, address = "") => ({
    id: `m-${lat.toFixed(5)},${lng.toFixed(5)}`,
    name, lat, lng, address,
    category: "sight",
    source: "link",
  });

  // Turns pasted text into {place} (exact spot) or {query, near} (search
  // for it). Throws with a helpful message when the link can't be read.
  async function resolve(text) {
    const c = String(text).match(COORDS);
    if (c && okCoords(Number(c[1]), Number(c[2]))) {
      const lat = Number(c[1]), lng = Number(c[2]);
      const rev = await reverse(lat, lng);
      return { place: spotFrom(rev?.name || "Pinned location", lat, lng, rev?.address) };
    }
    let url = findUrl(text);
    if (!url) throw new Error("That doesn't look like a Google Maps link.");
    const hint = nameFromShare(text, url);
    if (SHORT.test(url)) {
      const full = await expand(url);
      if (!full) {
        if (hint) return { query: hint };
        throw new Error("Couldn't open this short link here. In Google Maps, open the place, tap Share → Copy link, then open the link in your browser and copy the long address from the address bar. Or type the place's name.");
      }
      url = full;
    }
    const p = parse(url);
    const name = p.name || hint;
    if (p.lat != null) {
      const rev = name ? null : await reverse(p.lat, p.lng);
      return { place: spotFrom(name || rev?.name || "Pinned location", p.lat, p.lng, rev?.address || "") };
    }
    if (name || p.query) return { query: p.query || name, near: p.near };
    throw new Error("Couldn't find a place in that link. Open the place in Google Maps and share it again, or type its name.");
  }

  window.WPMapsLink = { isLink, parse, resolve };
})();
