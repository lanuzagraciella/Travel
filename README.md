# Wanderpose 📸

A travel-planning app for people who want to see every spot on a trip **and** come
home with the photos they had in mind.

## What it does

- **Trips in any city.** Tap the city name in the top bar to switch trips, or search for a new city. Brussels comes pre-loaded as an example.
- **Google Maps.** Once you add a Google Maps key in Settings (⚙), the app shows the real Google map. You can tap any place on it, search Google's places, and see Google photos, ratings, phone numbers and websites. Without a key it uses the free OpenStreetMap map and search.
- **Pins and a day plan.** Pins in your day are lettered **A, B, C…** and joined by a walking route. **✨ Optimize route** reorders them to cut down walking, and **Walk it in Google Maps** opens turn-by-turn directions.
- **A spot panel** with photo, address, rating, best light, shot ideas and **walking time to nearby spots**. Use ⤢ to expand it; on phones it's a bottom sheet.
- **Pose-inspiration gallery.** Upload photos you want to recreate. Tap one to view it full screen while you shoot.
- **✨ AI photo coach.** Tap **How do I take this?** on an inspiration photo and Claude explains how to recreate it with a phone camera: which lens (0.5x / 1x / 2x / 3x), phone height and angle, distance, settings, the pose, composition, light, a checklist for whoever holds the phone, and editing tips. Guides are saved with the photo, so you only pay for each one once.
- **Photo progress.** The top bar tracks how many spots you've got your shot at.

## Keys (Settings ⚙)

Both are optional, and both are saved only in your browser. Neither is ever put in the code or this repo.

| Key | What it unlocks | Where to get it |
| --- | --- | --- |
| Google Maps API key | Real Google map, Google place search, photos and ratings | [Google Cloud console](https://console.cloud.google.com/google/maps-apis/credentials). Enable **Maps JavaScript API** and **Places API (New)**, and restrict the key to your site's address (HTTP referrer). Google gives a monthly free allowance. |
| Claude API key | AI photo coach | [Anthropic Console](https://console.anthropic.com/settings/keys). Each guide costs a few cents. |

The app has no server, so the AI coach calls the Claude API straight from your browser
with your own key. Don't enter your key on a shared or public computer.

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
| `styles.css` | Look and feel, including the mobile bottom sheet |
| `app.js` | Trips, panel, gallery, route optimizer, storage |
| `maps.js` | Google Maps and OpenStreetMap map layers |
| `places.js` | City and place search (Google Places or OpenStreetMap) |
| `ai.js` | AI photo coach (Claude API) |
| `data.js` | Brussels starter spots and categories |
| `vendor/leaflet/` | [Leaflet](https://leafletjs.com) 1.9.4 map library (BSD-2) |

Your trips are saved in the browser's localStorage and your photos in IndexedDB.
Nothing syncs between devices yet. Walking times are estimates based on straight-line
distance with a detour factor.
