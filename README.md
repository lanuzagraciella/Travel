# Wanderpose 📸

A travel-planning app for people who want to see every spot on a trip **and** come
home with the photos they had in mind.

## What it does

- **Free by default.** No API keys or payment needed: OpenStreetMap map and search, Wikipedia photos, and the AI photo coach through the free Claude app.
- **Ready-made trips:** Brussels, Bruges, Ghent, Paris, Amsterdam and Luxembourg come with popular photo spots, best-light tips and pose ideas. Tap the city name in the top bar to switch.
- **📅 Day-by-day plan.** Tell the app how many days and your hours (set per trip); it splits your saved spots into balanced days by area, orders each day as a walking route from your start point, and gives every stop a time slot, with a lunch break when needed. Each day shows its date (from your itinerary), sunrise, sunset and golden-light times. The pose photos you saved appear on each stop.
- **📍 Where to stand & how to pose.** For any pose photo, the free Claude app explains exactly where to stand at that spot to get the same (or closest) background, where the photographer stands, how to pose, and the camera settings.
- **🗺️ Multi-city itinerary.** Under the city name → **My itinerary**, list the cities in order (e.g. Brussels, 2 nights → Bruges, day trip → Ghent, 1 night). Set a start date and each stay gets its dates. Between cities the app suggests **trains and buses** for your travel day (which train, platform-to-platform times, changes), with a Google Maps link as backup. The map shows the whole route, and **Open city** jumps into that city's day plan.
- **Any other city.** Search for a city and the app automatically adds its most popular spots: nearby Wikipedia landmarks ranked by how many people read about them, with OpenStreetMap as a backup. **✨ Find popular spots** tops up any trip.
- **Your own pins.** Use **📍 Drop pin** on the map, or **＋ Spot** to search for a place. Delete any pin with 🗑, either in the list or on the spot itself.
- **🏁 Start point.** Set your hotel, the station or your current location, and the app orders your stops into the shortest walking tour from there. New stops slot into the tour automatically. **Walk it in Google Maps** opens turn-by-turn directions starting from your start point.
- **🚌 Bus, tram and metro.** Every leg of the tour has a **Transit** button showing which line to take, where to get on and off, how many stops, departure times and whether it beats walking. Long walks (15 min+) are flagged in yellow, and each spot has a **Getting here** section. Routes come from [Transitous](https://transitous.org), a free, community-run planner; a **Live times in Google Maps** link is always there as a backup.
- **A spot panel** with photo, address, best light, shot ideas and **walking time to nearby spots**. Use ⤢ to expand it; on phones it's a bottom sheet.
- **Pose-inspiration gallery.** Upload photos you want to recreate. Tap one to view it full screen while you shoot.
- **📸 Inspiration from travellers.** Every spot shows how other people photographed it, legally and without scraping:
  - **Starter posts** for all 65 spots in the six ready-made cities: real public Pinterest pins and TikTok videos (found by web search), shown with each platform's official embed and credited to their creators.
  - **Free-licence photos** load automatically from [Openverse](https://openverse.org) (Creative Commons photos from Flickr, Wikimedia and more). Tap **＋ Pose** to save one to your pose gallery; its photographer and licence are kept and shown.
  - **One-tap searches** on Pinterest, TikTok, Instagram and RedNote for that exact spot.
  - **Save any post:** paste a Pinterest, TikTok, Instagram or RedNote link and it's kept on the spot, opening as the real post where the platform allows embedding.
  - Your own pose-photo uploads work as before.
- **📕 RedNote (小红书) ideas.** Every spot has one-tap RedNote searches in Chinese, the way RedNote users write: camera spots (机位), poses (拍照姿势) and photos (拍照). Chinese place names come from Wikipedia automatically. Searches are always about that one spot, never the whole city; spots without a Wikipedia link are matched to the article at their location. Every stop in the day plan has a 📕 button, and each spot page has a **📕 Search on RedNote** button. Paste a RedNote share link to save a post to the spot. RedNote has no public API, so the app links to RedNote rather than showing its posts inside the app.
- **✨ AI photo coach.** Tap **How do I take this?** on an inspiration photo. Then share it to the free Claude app (or copy the ready-made question), and Claude explains how to recreate the shot with a phone camera. Paste the answer back to keep it with the photo.
- **Photo progress.** The top bar tracks how many spots you've got your shot at.

## Optional: your own API keys (⚙ Settings → Advanced)

Free mode covers everything. Keys are only needed for these extras, and both can cost money:

| Key | What it adds | Where to get it |
| --- | --- | --- |
| Google Maps API key | Google's map inside the app, Google place search, photos and ratings | [Google Cloud console](https://console.cloud.google.com/google/maps-apis/credentials). Enable **Maps JavaScript API** and **Places API (New)**, and restrict the key to your site's address. |
| Claude API key | Photo guides made right inside the app | [Anthropic Console](https://console.anthropic.com/settings/keys). A few cents per guide. |

Keys are saved only in your browser, never in the code or this repo.

## Run it

It's plain HTML, CSS and JavaScript with no build step:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

To use it on your phone, deploy the folder to any static host:

- **Vercel:** "Add New → Project", import this GitHub repo, and keep the defaults (no build command). Every push redeploys it.
- **GitHub Pages:** Settings → Pages → deploy from your main branch.

Then add your host's address (e.g. `https://your-app.vercel.app/*`) to the Google key's allowed websites.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Page layout |
| `styles.css` | Apple-style look (system colours, materials, inset-grouped lists, light and dark mode), including the mobile bottom sheet |
| `app.js` | Trips, panel, gallery, route optimizer, storage |
| `maps.js` | Google Maps and OpenStreetMap map layers |
| `places.js` | City and place search (Google Places or OpenStreetMap) |
| `ai.js` | AI photo coach (Claude API) |
| `transit.js` | Bus, tram and metro routes (Transitous) |
| `sun.js` | Sunrise, sunset and golden-hour times (computed on the device) |
| `icons.js` | Line icons in the style of SF Symbols |
| `inspo.js` | Free-licence photos (Openverse), official post embeds and app searches |
| `seed-posts.js` | Starter Pinterest/TikTok posts for the ready-made cities |
| `data.js` | Brussels starter spots and categories |
| `vendor/leaflet/` | [Leaflet](https://leafletjs.com) 1.9.4 map library (BSD-2) |

Your trips are saved in the browser's localStorage and your photos in IndexedDB.
Nothing syncs between devices yet. Walking times are estimates based on straight-line
distance with a detour factor.
