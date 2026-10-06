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

  window.WPPlaces = { searchPlaces, placeById, searchCities, enrichFromGoogle };
})();
