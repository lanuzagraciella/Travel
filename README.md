# Wanderpose 📸

A travel-planning app for people who want to see every spot on a trip **and** come
home with the photos they had in mind. It's a Google-My-Maps-style map with:

1. **A map with pins** for every sight, café, shop and photo spot. Pins in your day plan are lettered **A, B, C…** and joined by a walking route.
2. **A side panel for each spot** (tap a pin) with:
   - a cover photo of the place, the address, phone number and website
   - the best time and light for photos, plus shot ideas
   - **walking time to nearby spots**
   - a **pose-inspiration gallery** where you upload the photos you want to recreate. Tap one on location to see it full screen and tick “I recreated this shot”.
3. **An expandable panel** (⤢). On phones it becomes a bottom sheet that can go full screen.

It can also:

- **✨ Optimize route.** Reorders your day to cut down walking. The first stop stays first.
- **Walk it in Google Maps.** Opens turn-by-turn walking directions for the whole day.
- **Photo progress.** The top bar tracks how many spots you've got your shot at.
- **＋ Spot.** Tap the map to add your own hidden gems with shot ideas.

Everything stays on your device. Spots and plans are saved in the browser, and the photos
you upload are kept in the browser's IndexedDB, so nothing is uploaded anywhere.

## Run it

It's plain HTML, CSS and JavaScript with no build step:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

To use it on your phone, host the folder on any static host, such as GitHub Pages
(Settings → Pages → deploy from this branch).

## Files

| File | What it is |
| --- | --- |
| `index.html` | Page layout |
| `styles.css` | Look and feel, including the mobile bottom sheet |
| `app.js` | Map, panel, gallery, route optimizer, storage |
| `data.js` | Seed spots (Brussels) and categories. Edit it to add another city |
| `vendor/leaflet/` | [Leaflet](https://leafletjs.com) 1.9.4 map library (BSD-2) |

Map tiles © OpenStreetMap contributors. Cover photos are fetched from Wikipedia.
Walking times are estimates based on straight-line distance with a detour factor.
