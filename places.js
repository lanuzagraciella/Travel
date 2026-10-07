/* Place and city search. Uses Google Places (New) when Google Maps is
 * loaded, otherwise OpenStreetMap's free Nominatim search.
 * Every result is normalised to the app's spot shape. */
(() => {
  "use strict";

  const FIELDS = ["id", "displayName", "location", "formattedAddress", "photos", "rating",
    "userRatingCount", "websiteURI", "nationalPhoneNumber", "types"];
  const google = () => window.WPMaps.googleReady();

  function categoryFromTypes(types = []) {
    const has = (...t) => t.some((x) => types.includes(x));
    if (has("lodging", "hotel")) return "stay";
    if (has("restaurant", "cafe", "bakery", "bar", "food", "meal_takeaway", "coffee_shop", "ice_cream_shop")) return "food";
    if (has("store", "shopping_mall", "clothing_store", "market", "book_store", "department_store")) return "shop";
    if (has("park", "natural_feature", "viewpoint", "scenic_point", "beach", "garden")) return "photo";
    return "sight";
  }

  function fromGoogle(p) {
    let photoUrl = null;
    try { photoUrl = p.photos?.[0]?.getURI({ maxWidth: 900 }) || null; } catch { /* no photo */ }
    return {
      id: "g-" + p.id,
      placeId: p.id,
      name: p.displayName,
      lat: p.location.lat(),
      lng: p.location.lng(),
      address: p.formattedAddress || "",
      phone: p.nationalPhoneNumber || "",
      website: p.websiteURI || "",
      rating: p.rating ?? null,
      ratingCount: p.userRatingCount ?? null,
      photoUrl,
      category: categoryFromTypes(p.types),
      source: "google",
    };
  }

  function fromOsm(r) {
    const cls = r.category || r.class;
    const type = r.type;
    let category = "sight";
    if (cls === "shop") category = "shop";
    else if (["restaurant", "cafe", "bar", "pub", "fast_food", "ice_cream", "bakery"].includes(type)) category = "food";
    else if (["hotel", "hostel", "guest_house", "apartment"].includes(type)) category = "stay";
    else if (["viewpoint", "park", "garden", "artwork"].includes(type)) category = "photo";
    return {
      id: `o-${r.osm_type}${r.osm_id}`,
      name: r.name || r.display_name.split(",")[0],
      lat: Number(r.lat),
      lng: Number(r.lon),
      address: r.display_name,
      category,
      source: "osm",
    };
  }

  async function nominatim(params) {
    const url = "https://nominatim.openstreetmap.org/search?" + new URLSearchParams({ format: "jsonv2", addressdetails: "0", ...params });
    const r = await fetch(url, { headers: { "Accept-Language": navigator.language || "en" } });
    if (!r.ok) throw new Error("Search is unavailable right now");
    return r.json();
  }

  // Places near the current map view.
  async function searchPlaces(query, center) {
    if (google()) {
      const { Place } = await window.google.maps.importLibrary("places");
      const { places } = await Place.searchByText({
        textQuery: query,
        fields: FIELDS,
        locationBias: { center, radius: 20000 },
        maxResultCount: 10,
      });
      return places.map(fromGoogle);
    }
    const d = 0.15; // ~15 km box around the map centre
    const rows = await nominatim({
      q: query, limit: "10", bounded: "1",
      viewbox: [center.lng - d, center.lat + d, center.lng + d, center.lat - d].join(","),
    });
    return rows.map(fromOsm);
  }

  // A Google place the user tapped on the map.
  async function placeById(placeId) {
    const { Place } = await window.google.maps.importLibrary("places");
    const p = new Place({ id: placeId });
    await p.fetchFields({ fields: FIELDS });
    return fromGoogle(p);
  }

  // Cities for the trip picker.
  async function searchCities(query) {
    if (google()) {
      const { Place } = await window.google.maps.importLibrary("places");
      const { places } = await Place.searchByText({
        textQuery: query,
        fields: ["id", "displayName", "location", "formattedAddress", "types"],
        maxResultCount: 6,
      });
      return places.map((p) => ({
        name: p.displayName,
        label: p.formattedAddress || p.displayName,
        center: [p.location.lat(), p.location.lng()],
      }));
    }
    const rows = await nominatim({ q: query, limit: "6", featureType: "city" });
    const fallback = rows.length ? rows : await nominatim({ q: query, limit: "6" });
    return fallback.map((r) => ({
      name: r.name || r.display_name.split(",")[0],
      label: r.display_name,
      center: [Number(r.lat), Number(r.lon)],
    }));
  }

  // Fill in Google details (photo, rating, phone, website) for a spot that was
  // added some other way, e.g. the Brussels starter spots. Runs once per spot.
  async function enrichFromGoogle(spot, cityName) {
    if (!google() || spot.placeId || spot.googleChecked) return false;
    spot.googleChecked = true;
    try {
      const { Place } = await window.google.maps.importLibrary("places");
      const { places } = await Place.searchByText({
        textQuery: `${spot.name}, ${cityName}`,
        fields: FIELDS,
        locationBias: { center: { lat: spot.lat, lng: spot.lng }, radius: 300 },
        maxResultCount: 1,
      });
      if (!places[0]) return true;
      const g = fromGoogle(places[0]);
      spot.placeId = g.placeId;
      spot.photoUrl = g.photoUrl;
      spot.rating = g.rating;
      spot.ratingCount = g.ratingCount;
      spot.phone ||= g.phone;
      spot.website ||= g.website;
      spot.address ||= g.address;
    } catch { /* keep the spot as it is */ }
    return true;
  }

  // Popular photo spots around a city centre.
  // Google (with a key): Google's own ranking of landmarks.
  // Free: OpenStreetMap landmarks that have a Wikipedia article, ranked by how
  // many languages the place's name is translated into (a good fame signal).
  // Free public Overpass servers; if one is busy we try the next.
  const OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
  ];

  function osmPopularity(tags) {
    let score = Object.keys(tags).filter((k) => k.startsWith("name:")).length;
    if (tags.tourism === "attraction" || tags.tourism === "viewpoint") score += 8;
    if (tags.historic) score += 4;
    if (tags.wikidata) score += 2;
    if (tags["name:en"]) score += 2;
    return score;
  }

  function osmCategory(tags) {
    if (tags.tourism === "viewpoint" || tags.tourism === "artwork" || tags.leisure === "park" ||
      tags.leisure === "garden" || tags.bridge || tags.man_made === "bridge") return "photo";
    if (tags.amenity === "marketplace" || tags.shop) return "shop";
    return "sight";
  }

  async function popularSpotsOsm(center, radius = 2500, limit = 12) {
    const at = `(around:${radius},${center.lat},${center.lng})`;
    const query = `[out:json][timeout:25];
(
  nwr${at}["tourism"~"^(attraction|viewpoint|museum|artwork|gallery)$"]["wikipedia"];
  nwr${at}["historic"~"^(monument|castle|memorial|city_gate|palace|fort|ruins|building)$"]["wikipedia"];
  nwr${at}["building"~"^(cathedral|church|basilica|palace|castle)$"]["wikipedia"];
  nwr${at}["leisure"~"^(park|garden)$"]["wikipedia"];
  nwr${at}["place"="square"]["wikipedia"];
  nwr${at}["man_made"~"^(bridge|tower|lighthouse|windmill)$"]["wikipedia"];
  way${at}["bridge"="yes"]["wikipedia"];
);
out center tags;`;
    let elements = null;
    for (const url of OVERPASS) {
      try {
        const r = await fetch(url, { method: "POST", body: new URLSearchParams({ data: query }) });
        if (!r.ok) continue;
        elements = (await r.json()).elements || [];
        break;
      } catch { /* try the next server */ }
    }
    if (!elements) throw new Error("OpenStreetMap is busy");
    // Skip duplicates: same name (in any language we see), same Wikipedia
    // article, or practically the same spot on the map.
    const seen = new Set();
    const kept = [];
    const near = (a, b) => Math.abs(a.lat - b.lat) < 0.0004 && Math.abs(a.lon - b.lon) < 0.0006;
    return elements
      .map((el) => ({ el, tags: el.tags || {}, lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon }))
      .filter(({ tags }) => tags.name || tags["name:en"])
      .sort((a, b) => osmPopularity(b.tags) - osmPopularity(a.tags))
      .filter((x) => {
        const keys = [x.tags.name, x.tags["name:en"], x.tags.wikipedia, x.tags.wikidata].filter(Boolean).map((k) => k.toLowerCase());
        if (keys.some((k) => seen.has(k)) || kept.some((k) => near(k, x))) return false;
        keys.forEach((k) => seen.add(k));
        kept.push(x);
        return true;
      })
      .slice(0, limit)
      .map(({ el, tags }) => {
        const lat = el.lat ?? el.center?.lat;
        const lng = el.lon ?? el.center?.lon;
        const street = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ");
        return {
          id: `o-${el.type}${el.id}`,
          name: tags["name:en"] || tags.name,
          lat, lng,
          address: [street, tags["addr:city"]].filter(Boolean).join(", "),
          category: osmCategory(tags),
          wiki: tags.wikipedia,   // "lang:Title", used for the cover photo
          website: tags.website || "",
          source: "osm",
        };
      })
      .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  }

  // Free and reliable: Wikipedia articles about places near the city centre,
  // ranked by how many people read them in the last 30 days.
  const NOT_A_SPOT = new RegExp(`\\b(?:${[
    "station", "tram stop", "bus stop", "school", "college", "universit", "hospital", "clinic",
    "embassy", "consulate", "company", "corporation", "bank", "hotel", "hostel", "airport",
    "prison", "headquarters", "office", "ministry", "neighbourhood", "neighborhood",
    "municipality", "commune", "district", "suburb", "borough", "arrondissement", "ward",
    "constituency", "capital", "city in", "town in", "village", "region", "province", "country",
    "football", "stadium", "sports", "club", "apartment", "residential", "car park", "motorway",
    "tunnel", "railway", "metro line", "tram line", "bus line", "newspaper", "radio", "television",
    "record label", "band", "company", "organization", "organisation", "association", "institute",
  ].join("|")})`, "i");

  function wikiCategory(text) {
    if (/park|garden|bridge|square|viewpoint|fountain|statue|canal|lake|beach|hill|lookout|street|quay|river/i.test(text)) return "photo";
    if (/restaurant|caf[eé]|brewery|bar\b|chocolat|food hall/i.test(text)) return "food";
    if (/market|shopping|arcade|department store|gallery of shops/i.test(text)) return "shop";
    return "sight";
  }

  async function popularSpotsWiki(center, cityName, radius = 5000, limit = 12) {
    const params = new URLSearchParams({
      action: "query", format: "json", formatversion: "2", origin: "*",
      generator: "geosearch", ggscoord: `${center.lat}|${center.lng}`, ggsradius: String(radius), ggslimit: "50",
      prop: "coordinates|pageimages|description|pageviews",
      colimit: "max", piprop: "thumbnail", pithumbsize: "800", pilimit: "max", pvipdays: "30",
    });
    const r = await fetch(`https://en.wikipedia.org/w/api.php?${params}`);
    if (!r.ok) throw new Error("Wikipedia is unavailable");
    const pages = (await r.json()).query?.pages || [];
    const city = (cityName || "").toLowerCase();
    return pages
      .map((pg) => ({
        pg,
        coord: pg.coordinates?.[0],
        views: Object.values(pg.pageviews || {}).reduce((n, v) => n + (v || 0), 0),
        text: `${pg.title} ${pg.description || ""}`,
      }))
      .filter((x) => x.coord && x.pg.title.toLowerCase() !== city && !NOT_A_SPOT.test(x.pg.description || ""))
      .sort((a, b) => b.views - a.views)
      .slice(0, limit)
      .map(({ pg, coord, text }) => ({
        id: `w-${pg.pageid}`,
        name: pg.title.replace(/\s*\([^)]*\)$/, ""),   // "Old England (building)" -> "Old England"
        lat: coord.lat,
        lng: coord.lon,
        address: "",
        description: pg.description || "",
        category: wikiCategory(text),
        wiki: `en:${pg.title}`,
        photoUrl: pg.thumbnail?.source || null,
        photoCredit: "Wikipedia",
        source: "wikipedia",
      }));
  }

  async function popularSpots(center, cityName) {
    if (google()) {
      const { Place } = await window.google.maps.importLibrary("places");
      const { places } = await Place.searchByText({
        textQuery: `most famous landmarks and photo spots in ${cityName}`,
        fields: FIELDS,
        locationBias: { center, radius: 5000 },
        maxResultCount: 12,
      });
      return places.map(fromGoogle);
    }
    // Wikipedia first; top up from OpenStreetMap if Wikipedia finds too few.
    let found = [];
    let wikiError = null;
    try { found = await popularSpotsWiki(center, cityName); } catch (err) { wikiError = err; }
    if (found.length < 6) {
      try {
        const osm = await popularSpotsOsm(center);
        const near = (a, b) => Math.abs(a.lat - b.lat) < 0.0004 && Math.abs(a.lng - b.lng) < 0.0006;
        found = found.concat(osm.filter((o) => !found.some((f) => near(f, o) || f.name.toLowerCase() === o.name.toLowerCase())));
      } catch (err) {
        if (!found.length) throw new Error(`Couldn't load popular spots (${wikiError ? "Wikipedia and " : ""}OpenStreetMap busy). Check your connection and try again in a minute.`);
      }
    }
    return found.slice(0, 12);
  }

  // Chinese name of a place, from Wikipedia's language links, shown in
  // Simplified Chinese because that's what RedNote (小红书) users search with.
  // `wiki` is "Title" (English Wikipedia) or "lang:Title".
  async function chineseName(wiki) {
    if (!wiki) return null;
    const m = /^([a-z]{2,3}):(.+)$/.exec(wiki);
    const [lang, title] = m ? [m[1], m[2]] : ["en", wiki];
    let zh = lang === "zh" ? title : null;
    if (!zh) {
      const q = new URLSearchParams({
        action: "query", format: "json", formatversion: "2", origin: "*",
        titles: title.replace(/_/g, " "), prop: "langlinks", lllang: "zh", redirects: "1",
      });
      const r = await fetch(`https://${lang}.wikipedia.org/w/api.php?${q}`);
      if (!r.ok) throw new Error("Wikipedia is unavailable");
      zh = (await r.json()).query?.pages?.[0]?.langlinks?.[0]?.title;
      if (!zh) return null;
    }
    try {
      const q = new URLSearchParams({
        action: "parse", format: "json", formatversion: "2", origin: "*",
        page: zh, prop: "displaytitle", variant: "zh-cn", redirects: "1",
      });
      const r = await fetch(`https://zh.wikipedia.org/w/api.php?${q}`);
      const shown = r.ok && (await r.json()).parse?.displaytitle;
      const clean = shown && shown.replace(/<[^>]+>/g, "").trim();
      if (clean) return clean;
    } catch { /* fall back to the title as stored */ }
    return zh;
  }

  window.WPPlaces = { searchPlaces, placeById, searchCities, enrichFromGoogle, popularSpots, chineseName };
})();
