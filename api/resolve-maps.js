/* Vercel serverless function: turns a Google Maps short link
 * (maps.app.goo.gl/…) into the full Google Maps URL, which holds the
 * place's name and coordinates. Browsers can't follow these redirects
 * themselves because of CORS.
 * Only Google short links are accepted and only Google redirects are
 * followed, so this can't be used as an open proxy. */
const SHORT = [
  (u) => u.hostname === "maps.app.goo.gl",
  (u) => u.hostname === "goo.gl" && u.pathname.startsWith("/maps"),
  (u) => u.hostname === "g.co" && u.pathname.startsWith("/kgs"),
];
const GOOGLE_HOST = /(^|\.)(google\.[a-z.]+|goo\.gl|g\.co)$/;
const isFullMaps = (u) => /(^|\.)google\.[a-z.]+$/.test(u.hostname) &&
  (u.pathname.startsWith("/maps") || u.hostname.startsWith("maps.")) && !u.hostname.startsWith("consent.");

module.exports = async (req, res) => {
  let url;
  try {
    url = new URL(String(req.query.url || ""));
  } catch {
    return res.status(400).json({ error: "Not a link" });
  }
  if (url.protocol !== "https:" || !SHORT.some((ok) => ok(url))) {
    return res.status(400).json({ error: "Only Google Maps share links can be opened" });
  }
  try {
    for (let hop = 0; hop < 6; hop++) {
      if (isFullMaps(url)) {
        res.setHeader("Cache-Control", "public, s-maxage=86400, max-age=3600");
        return res.status(200).json({ url: url.href });
      }
      const r = await fetch(url.href, {
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 (Wanderpose link resolver)", "Accept-Language": "en" },
      });
      const next = r.headers.get("location");
      if (!next) break;
      url = new URL(next, url);
      // EU visitors can be sent to a cookie-consent page; the real link is inside it.
      if (url.hostname.startsWith("consent.") && url.searchParams.get("continue")) {
        url = new URL(url.searchParams.get("continue"));
      }
      if (url.protocol !== "https:" || !GOOGLE_HOST.test(url.hostname)) break;
    }
  } catch {
    return res.status(502).json({ error: "Google Maps didn't answer" });
  }
  return res.status(422).json({ error: "Couldn't open that link" });
};
