# Ship Track

A live ship tracker with the same look and controls as TrainLive (trainlive.cc), running on Cloudflare. It works on
iPhone, Android and Windows and installs as an app (iOS: Share → Add to Home Screen; Android Chrome: Install app;
Windows Edge/Chrome: the install icon in the address bar).

What it shows:
- Every ship broadcasting AIS in the visible area, worldwide, moving live: arrows for ships under way (pointing where
  they head), dots for ships at anchor or moored, faded when a ship has not reported for 12 minutes
- Chips to show or hide each ship type (cargo, tanker, passenger, fishing, tug & service, leisure, high-speed, other),
  with the number of each in view
- Tap a ship: name, flag, type, live speed and course, destination with ETA countdown, navigation status, size,
  draught, MMSI, IMO, call sign, position and last report; the track it sailed since you opened the map; Follow mode
- Search ships by name, MMSI, IMO or call sign, and ports or places by name
- Satellite view, and weather at the map centre with wind in knots, wave height and the rain radar
- Light, dark or automatic theme; opens on your country's coast

## How it is built

```
public/              the page, served as static files by Cloudflare
  index.html, style.css, app.js     MapLibre map (OpenFreeMap tiles), panel, search, filters, demo mode
  data/ports.json, data/sea.json   seaports (UN/LOCODE) and world shipping lanes, for routes to the destination
  sw.js, manifest.webmanifest, icons/   install-as-app support
tools/make_sea_data.py   rebuilds the two data files from their sources
src/worker.js        the Worker: /api/stream (live AIS WebSocket), /api/health, /api/search, /api/where
wrangler.toml        Cloudflare config (Worker + static assets)
.github/workflows/deploy.yml  optional deploy from GitHub Actions
```

Live data comes from [aisstream.io](https://aisstream.io), a free worldwide AIS feed. The browser opens a WebSocket to
the Worker and tells it which part of the world is on screen; the Worker adds the API key, which stays a Cloudflare
secret and never reaches the browser, subscribes to aisstream.io for that area and relays the messages back.
`/api/health?check=1` opens a test connection and says whether aisstream.io accepts the key.

If the page cannot reach `/api`, or the key is not set yet, it runs a simulated demo with ships on the main sea lanes.

## Deploy

1. Get a free key at [aisstream.io](https://aisstream.io) (sign in with GitHub, then **API Keys**).
2. In the Cloudflare dashboard: **Workers & Pages → Create application → Import a repository**, pick this repo and keep
   the deploy command `npx wrangler deploy` (no build command is needed).
3. In the Worker's **Settings → Variables and Secrets**, add a **Secret** named `AISSTREAM_API_KEY` with your key.

Every push to `main` then redeploys. With the command line instead: `npm install`, `npx wrangler login`,
`npx wrangler secret put AISSTREAM_API_KEY`, `npm run deploy` (or `npm run dev` with the key in `.dev.vars`).

## Data sources and their limits

| What | Source used | Cost | Notes |
|---|---|---|---|
| Ship positions, names, types, destinations | [aisstream.io](https://aisstream.io) | Free, needs a key | Built from terrestrial AIS stations run by volunteers. Coverage is excellent along most coasts, busy straits and ports (Europe, North America, East Asia), thin or absent in the open ocean, where only satellite AIS (paid) sees ships. The service is offered as is, with no uptime promise. |
| Map | [OpenFreeMap](https://openfreemap.org) (OpenStreetMap) | Free, no key | Same base map as TrainLive. Satellite imagery from Esri. |
| Weather, waves | [Open-Meteo](https://open-meteo.com), [RainViewer](https://www.rainviewer.com) | Free, no key | Fetched by the browser only when the weather button is on. |
| Port search | [Photon](https://photon.komoot.io) (OpenStreetMap) | Free, no key | Cached for a day by the Worker. |
| Ports | [UN/LOCODE](https://unece.org/trade/cefact/unlocode-code-list-country-and-territory) via [datasets/un-locode](https://github.com/datasets/un-locode) | Free | Turns destinations such as `NL RTM` into a place on the map. |
| Shipping lanes | Eurostat MARNET, as packaged by [searoute](https://github.com/johnx25bd/searoute) (MIT) | Free | The dashed route follows these lanes, so it is an estimate, not the crew's passage plan. |

Things to know about AIS:
- A moving ship reports every 2 to 10 seconds, a ship at anchor or moored only every 3 minutes, and names and destinations
  every 6 minutes. A freshly opened map therefore fills in over a few minutes. The app remembers ships it saw in your
  browser for 30 minutes, and their names and types for a week, so reopening it is instant and ships are coloured at once.
- Destinations and ETAs are typed in by the crew and are often abbreviated or out of date.
- AIS never says where a voyage started. Tapping a ship shows its track since the map first saw it (solid) and an
  estimated sea route to its destination (dashed); tap the destination box to see the whole route.
- Ships are drawn as hulls turned to their heading; close in, ships that send their size are drawn to scale.
- Each open browser tab uses one aisstream.io connection. That is fine for personal use and a modest audience; for a
  large public site, move the upstream connection into one shared Durable Object (Workers Paid plan) so all viewers
  share a single feed.
- The Worker only relays messages, so it uses very little CPU and fits Cloudflare's free plan.

## Going further

- Ship photos and particulars by IMO number, port arrivals and departures, and voyage history need a paid AIS provider
  (Spire, MarineTraffic, VesselFinder, Datalastic); put its key in a Cloudflare secret like the aisstream.io one.
- Native store apps (App Store, Play Store, Microsoft Store) can wrap this same PWA with Capacitor or PWABuilder.
