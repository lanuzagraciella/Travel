/* Sunrise, sunset and golden hour for a place and date, computed on the
 * device (no network). Based on the standard NOAA/SunCalc formulas. */
(() => {
  "use strict";

  const rad = Math.PI / 180;
  const DAY_MS = 86400000, J1970 = 2440588, J2000 = 2451545, J0 = 0.0009;
  const E = rad * 23.4397; // obliquity of the Earth

  const toDays = (date) => date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
  const fromJulian = (j) => new Date((j + 0.5 - J1970) * DAY_MS);
  const meanAnomaly = (d) => rad * (357.5291 + 0.98560028 * d);
  const eclipticLongitude = (M) =>
    M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
  const declination = (L) => Math.asin(Math.sin(E) * Math.sin(L));
  const approxTransit = (Ht, lw, n) => J0 + (Ht + lw) / (2 * Math.PI) + n;
  const solarTransitJ = (ds, M, L) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const hourAngle = (h, phi, dec) => Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));

  // date: any time on the local day you want; returns Dates (or null near the poles).
  function sunTimes(date, lat, lng) {
    const noonLocal = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
    const lw = rad * -lng, phi = rad * lat;
    const d = toDays(noonLocal);
    const n = Math.round(d - J0 - lw / (2 * Math.PI));
    const ds = approxTransit(0, lw, n);
    const M = meanAnomaly(ds);
    const L = eclipticLongitude(M);
    const dec = declination(L);
    const Jnoon = solarTransitJ(ds, M, L);
    const pair = (angle) => {
      const w = hourAngle(angle * rad, phi, dec);
      if (Number.isNaN(w)) return [null, null];
      const Jset = solarTransitJ(approxTransit(w, lw, n), M, L);
      return [fromJulian(Jnoon - (Jset - Jnoon)), fromJulian(Jset)];
    };
    const [sunrise, sunset] = pair(-0.833);
    const [goldenMorningEnd, goldenEveningStart] = pair(6);
    return { sunrise, sunset, goldenMorningEnd, goldenEveningStart };
  }

  window.WPSun = { sunTimes };
})();
