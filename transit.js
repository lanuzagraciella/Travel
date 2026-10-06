/* Public transport directions between two points.
 *
 * Uses Transitous (https://transitous.org), a free, community-run public
 * transport router built on open timetable data. Coverage varies by city,
 * so the app always offers a Google Maps transit link as well. */
(() => {
  "use strict";

  const API = "https://api.transitous.org/api/v1/plan";

  const MODES = {
    WALK: { icon: "🚶", label: "Walk" },
    BUS: { icon: "🚌", label: "Bus" },
    COACH: { icon: "🚌", label: "Coach" },
    TRAM: { icon: "🚊", label: "Tram" },
    SUBWAY: { icon: "🚇", label: "Metro" },
    METRO: { icon: "🚇", label: "Metro" },
    RAIL: { icon: "🚆", label: "Train" },
    REGIONAL_RAIL: { icon: "🚆", label: "Train" },
    REGIONAL_FAST_RAIL: { icon: "🚆", label: "Train" },
    SUBURBAN: { icon: "🚆", label: "Train" },
    HIGHSPEED_RAIL: { icon: "🚄", label: "High-speed train" },
    LONG_DISTANCE: { icon: "🚆", label: "Train" },
    NIGHT_RAIL: { icon: "🚆", label: "Night train" },
    FERRY: { icon: "⛴️", label: "Ferry" },
    FUNICULAR: { icon: "🚞", label: "Funicular" },
    CABLE_CAR: { icon: "🚡", label: "Cable car" },
    AERIAL_LIFT: { icon: "🚡", label: "Cable car" },
    BIKE: { icon: "🚲", label: "Bike" },
  };
  const modeInfo = (m) => MODES[m] || { icon: "🚐", label: "Transit" };

  const minutes = (secs) => Math.max(1, Math.round((secs || 0) / 60));
  const toDate = (v) => (v ? new Date(v) : null);

  function normaliseLeg(l) {
    const start = toDate(l.startTime || l.from?.departure);
    const end = toDate(l.endTime || l.to?.arrival);
    const secs = l.duration ?? (start && end ? (end - start) / 1000 : 0);
    return {
      mode: l.mode,
      ...modeInfo(l.mode),
      line: l.routeShortName || l.displayName || l.tripShortName || "",
      headsign: l.headsign || "",
      agency: l.agencyName || "",
      color: l.routeColor ? `#${l.routeColor.replace(/^#/, "")}` : null,
      from: l.from?.name || "",
      to: l.to?.name || "",
      departure: start,
      minutes: minutes(secs),
      stops: Array.isArray(l.intermediateStops) ? l.intermediateStops.length + 1 : null,
    };
  }

  // Up to 3 options for leaving now, fastest first.
  async function plan(from, to, when = new Date()) {
    const params = new URLSearchParams({
      fromPlace: `${from.lat},${from.lng}`,
      toPlace: `${to.lat},${to.lng}`,
      time: when.toISOString(),
    });
    let r;
    try {
      r = await fetch(`${API}?${params}`);
    } catch {
      throw new Error("Couldn't reach the transit planner. Check your connection.");
    }
    if (!r.ok) throw new Error("No transit routes available for this trip.");
    const data = await r.json();
    return (data.itineraries || [])
      .map((it) => {
        const legs = (it.legs || []).map(normaliseLeg);
        return {
          minutes: minutes(it.duration),
          departure: toDate(it.startTime),
          arrival: toDate(it.endTime),
          transfers: it.transfers ?? Math.max(0, legs.filter((l) => l.mode !== "WALK").length - 1),
          legs,
          walkOnly: legs.every((l) => l.mode === "WALK"),
        };
      })
      .filter((it) => it.legs.length && !it.walkOnly)
      .sort((a, b) => a.minutes - b.minutes)
      .slice(0, 3);
  }

  const googleTransitUrl = (from, to) =>
    `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}` +
    (to.placeId ? `&destination_place_id=${encodeURIComponent(to.placeId)}` : "") + "&travelmode=transit";

  window.WPTransit = { plan, googleTransitUrl, modeInfo };
})();
