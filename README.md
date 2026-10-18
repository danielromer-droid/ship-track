# Ship Track

A live ship tracker, in the spirit of TrainLive or MarineTraffic, that runs on Cloudflare and works on iPhone,
Android and Windows. It is a Progressive Web App: open the site in a browser, then install it to the home screen
(iOS: Share → Add to Home Screen; Android Chrome: Install app; Windows Edge/Chrome: the install icon in the address bar).

What it shows:
- Every ship broadcasting AIS in the visible area, worldwide, updated live as each position report arrives
- Ships coloured by type (cargo, tanker, passenger, fishing, tug & service, sailing & leisure, high speed); tap the legend to hide a type
- Moving ships as arrows pointing where they head, ships at anchor or moored as dots; zoomed right in, ships are drawn to their real size
- Tap a ship: name, flag, type, destination and ETA, navigation status, speed, course, heading, length × beam, draught,
  MMSI, IMO, call sign, last report and position
- The ship's track since you opened the map, and a Follow mode that keeps it centred
- Search by name, MMSI, IMO or call sign; nautical or metric units; your location; light and dark themes

## How it is built

```
public/              static app
  index.html         page
  app.js             map, ship layer (one canvas, so tens of thousands of ships stay smooth), ship card, demo mode
  style.css          styles (includes Leaflet's CSS)
  land.json          coastline outline, shown under the map tiles
  sw.js, manifest.webmanifest, icons/   install-as-app support
functions/api/       the Worker part (Cloudflare Pages Functions layout)
  stream.js          GET /api/stream (WebSocket) → live AIS messages for the map view
  health.js          GET /api/health → { ok, live }
lib/util.js          helpers shared by the functions
dist/worker.js       everything above bundled into one Worker file
tools/build_worker.py  rebuilds dist/worker.js (Python, no Node)
wrangler.toml        Cloudflare config for `wrangler deploy` and the GitHub workflow
.github/workflows/deploy.yml  deploys on every push to main
```

Live data comes from [aisstream.io](https://aisstream.io), a free worldwide AIS feed. The browser opens a WebSocket to
the Worker and tells it which part of the world is on screen; the Worker adds the API key, which stays a Cloudflare
secret and never reaches the browser, subscribes to aisstream.io for that area and relays the messages back.

If the page cannot reach `/api`, or the key is not set yet, it switches to a simulated demo with ships on the main sea
lanes so the interface can still be tried. The status pill at the top says "Demo data" when that happens.

## Step 1: get a free aisstream.io key

Sign in at [aisstream.io](https://aisstream.io) (with GitHub), open **API Keys** and create one.

## Step 2: deploy

Pick whichever suits you. Options 1 and 2 need nothing installed on your computer.

### Option 1: paste one file into the Cloudflare dashboard (no Node, no GitHub)

1. Sign in at dash.cloudflare.com (a free account is enough).
2. Go to **Workers & Pages → Create → Create Worker** (start from "Hello World"), name it `ship-track`, and click **Deploy**.
3. Click **Edit code**, delete everything in `worker.js`, paste the contents of `dist/worker.js`, and click **Deploy**.
4. In the Worker's **Settings → Variables and Secrets**, add a **Secret** named `AISSTREAM_API_KEY` with your key.
5. Open the address it shows, like `https://ship-track.<your-name>.workers.dev`, on your phone or PC and install it.

If you change anything in `public/` or `functions/`, rebuild the file with `python3 tools/build_worker.py` and paste it again.

### Option 2: GitHub Actions (updates itself on every push)

In the GitHub repo, open **Settings → Secrets and variables → Actions** and add:

| Secret | Where to find it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens → Create Token → template **Edit Cloudflare Workers** |
| `CLOUDFLARE_ACCOUNT_ID` | dash.cloudflare.com → Workers & Pages, right-hand column |
| `AISSTREAM_API_KEY` | your aisstream.io key (the workflow copies it into the Worker) |

Then run the **Deploy** workflow from the Actions tab (or push to `main`). The Worker appears as `ship-track` in your Cloudflare account.
Cloudflare's own **Workers & Pages → Create → Import a repository** also works with this repo, as long as the
build command is `python3 tools/build_worker.py`; add the `AISSTREAM_API_KEY` secret in the Worker's settings afterwards.

### Option 3: command line with Wrangler (needs Node.js 18+)

```bash
npm install
npx wrangler login
npx wrangler secret put AISSTREAM_API_KEY
npm run deploy           # or `npm run dev` to try it locally (put the key in .dev.vars)
```

## Data sources and their limits

| What | Source used | Cost | Notes |
|---|---|---|---|
| Ship positions, names, types, destinations | [aisstream.io](https://aisstream.io) | Free, needs a key | Built from terrestrial AIS stations run by volunteers. Coverage is excellent along most coasts, busy straits and ports (Europe, North America, East Asia), thin or absent in the open ocean, where only satellite AIS (paid) sees ships. The service is offered as is, with no uptime promise. |
| Map tiles | CARTO basemaps (OpenStreetMap) | Free for light use | For heavy or commercial traffic switch to MapTiler, Stadia or your own tiles (one line in `app.js`, `setTiles`). |

Things to know about AIS:
- A moving ship reports every 2 to 10 seconds, a ship at anchor or moored only every 3 minutes, and names and destinations
  every 6 minutes. A freshly opened map therefore fills in over a few minutes. The app remembers ships it saw in your
  browser for 30 minutes so reopening it is instant.
- Destinations and ETAs are typed in by the crew and are often abbreviated or out of date.
- Each open browser tab uses one aisstream.io connection. That is fine for personal use and a modest audience; for a
  large public site, move the upstream connection into one shared Durable Object (Workers Paid plan) so all viewers
  share a single feed.
- The Worker only relays messages, so it uses very little CPU and fits Cloudflare's free plan.

## Going further

- Ship photos and particulars by IMO number, port arrivals and departures, and voyage history need a paid AIS provider
  (Spire, MarineTraffic, VesselFinder, Datalastic); put its key in a Cloudflare secret like the aisstream.io one.
- Native store apps (App Store, Play Store, Microsoft Store) can wrap this same PWA with Capacitor or PWABuilder.
