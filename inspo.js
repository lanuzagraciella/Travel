/* Photo inspiration from other travellers, done the legal way:
 *  - free-licence (Creative Commons) photos from Openverse, with credits
 *  - official embeds for Pinterest, TikTok and Instagram post links
 *  - one-tap searches on Pinterest, TikTok, Instagram and RedNote
 * Nothing is scraped; posts stay on their own apps. */
(() => {
  "use strict";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---------- Free-licence photos (Openverse) ----------
  const OPENVERSE = "https://api.openverse.org/v1/images/";
  const CACHE_DAYS = 7;

  function cached(key) {
    try {
      const v = JSON.parse(localStorage.getItem(`wp.cc.${key}`) || "null");
      if (v && Date.now() - v.at < CACHE_DAYS * 86400000) return v.items;
    } catch { /* ignore */ }
    return null;
  }
  function remember(key, items) {
    try { localStorage.setItem(`wp.cc.${key}`, JSON.stringify({ at: Date.now(), items })); } catch { /* storage full */ }
  }

  const licenceName = (r) => r.license === "cc0" ? "CC0" : r.license === "pdm" ? "Public domain"
    : `CC ${String(r.license || "").toUpperCase()}${r.license_version ? ` ${r.license_version}` : ""}`;

  // Photos of a place, people-and-pose shots first when the search finds them.
  async function freePhotos(spot, cityName) {
    const key = spot.id;
    const hit = cached(key);
    if (hit) return hit;
    const name = spot.name.replace(/\s*\([^)]*\)$/, "");
    const queries = [`${name} portrait`, `${name} ${cityName || ""}`.trim()];
    const seen = new Set();
    const items = [];
    for (const q of queries) {
      const params = new URLSearchParams({ q, page_size: "12", mature: "false", category: "photograph" });
      const r = await fetch(`${OPENVERSE}?${params}`);
      if (!r.ok) {
        if (items.length) break;
        throw new Error(r.status === 429 ? "Too many photo searches right now. Try again in a few minutes." : "Couldn't load free photos right now.");
      }
      for (const x of (await r.json()).results || []) {
        if (seen.has(x.id) || !x.thumbnail) continue;
        seen.add(x.id);
        items.push({
          id: x.id,
          thumb: x.thumbnail,
          full: x.url,
          page: x.foreign_landing_url || x.url,
          title: x.title || name,
          creator: x.creator || "Unknown photographer",
          licence: licenceName(x),
          licenceUrl: x.license_url || "",
          source: x.source || x.provider || "",
        });
      }
      if (items.length >= 12) break;
    }
    const top = items.slice(0, 12);
    remember(key, top);
    return top;
  }

  // ---------- Official embeds ----------
  function embedInfo(url) {
    let m;
    if ((m = url.match(/tiktok\.com\/.*\/video\/(\d+)/))) {
      return { site: "TikTok", src: `https://www.tiktok.com/embed/v2/${m[1]}`, ratio: "tall" };
    }
    if ((m = url.match(/pinterest\.[a-z.]+\/pin\/(?:[^/?#]*-)?(\d{6,})/))) {
      return { site: "Pinterest", src: `https://assets.pinterest.com/ext/embed.html?id=${m[1]}`, ratio: "pin" };
    }
    if ((m = url.match(/instagram\.com\/(p|reel|tv)\/([\w-]+)/))) {
      return { site: "Instagram", src: `https://www.instagram.com/${m[1]}/${m[2]}/embed`, ratio: "tall" };
    }
    return null;
  }

  function embedFrame(url) {
    const e = embedInfo(url);
    if (!e) return "";
    return `<iframe class="embed embed-${e.ratio}" src="${esc(e.src)}" loading="lazy" allowfullscreen
      allow="encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" title="${e.site} post"></iframe>`;
  }

  // ---------- One-tap searches ----------
  function searchLinks(spot, zhName) {
    const q = `${spot.name.replace(/\s*\([^)]*\)$/, "")} photo ideas`;
    const tag = spot.name.replace(/\s*\([^)]*\)$/, "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    return [
      { site: "Pinterest", url: `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(q)}` },
      { site: "TikTok", url: `https://www.tiktok.com/search?q=${encodeURIComponent(`${spot.name} photo spot`)}` },
      { site: "Instagram", url: `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/` },
      { site: "RedNote", url: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(`${zhName || spot.name} 机位`)}` },
    ];
  }

  window.WPInspo = { freePhotos, embedInfo, embedFrame, searchLinks };
})();
