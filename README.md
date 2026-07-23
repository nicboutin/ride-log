# Ride Log

A small personal dashboard that connects to your Strava account and shows
your recent rides: total distance, climbing, moving time, average speed,
a map of your routes, and a ride-by-ride log.

It's a static site plus two tiny serverless functions (so your Strava
**Client Secret** never has to sit in the browser). Runs free on Netlify.

## 1. Create a Strava API application

1. Go to <https://www.strava.com/settings/api> (log in with your Strava account).
2. Fill in the form — name it anything (e.g. "Ride Log"), any category/website is fine.
3. For **Authorization Callback Domain**, put your future Netlify domain,
   e.g. `ride-log-yourname.netlify.app` (domain only, no `https://` or path).
   You can come back and edit this after you deploy and know your real domain.
4. Save. You'll get a **Client ID** and **Client Secret** — keep the secret private.

## 2. Deploy to Netlify (free)

1. Create a free account at <https://app.netlify.com>.
2. **Add new site → Deploy manually**, and drag this whole folder in.
   (Or push it to a GitHub repo and use "Import from Git" — either works.)
3. Once deployed, note your site's URL, e.g. `https://ride-log-yourname.netlify.app`.
   If it doesn't match what you entered in step 1.3, go back to Strava's API
   settings and update the Authorization Callback Domain to match.
4. In Netlify: **Site settings → Environment variables**, add:
   - `STRAVA_CLIENT_ID` — from step 1
   - `STRAVA_CLIENT_SECRET` — from step 1
5. **Deploys → Trigger deploy** so the functions pick up the new variables.

## 3. Use it

Open your site, click **Connect to Strava**, approve access, and your
dashboard loads. Click **Disconnect** any time to clear the stored session
from your browser.

- **Filter** by year, month, and week using the dropdowns at the top —
  each narrows the next (pick a year to unlock months, pick a month to
  narrow the week list).
- **Click any ride** in the log, or any route on the map, for a full
  recap: heart rate, power, cadence, calories, achievements, gear, and
  per-km splits, if your device recorded them.
- **Simulate ride** (top right of the filter bar) suggests a loop route
  of about however many km you ask for, starting near an address you
  type in. This uses two free public services — OpenStreetMap's
  Nominatim (address lookup) and a community OSRM routing server — so
  no extra API keys or setup needed. It's a *suggestion*, not routing
  guidance: always sanity-check a generated loop against traffic and
  road conditions before riding it.

## How it works

- `index.html` / `style.css` / `app.js` — the whole frontend, no build step.
- `netlify/functions/strava-config.js` — hands the frontend your (non-secret)
  Client ID so it can build the "Connect to Strava" link.
- `netlify/functions/strava-auth.js` — the only place your Client Secret is
  used: exchanging Strava's one-time `code` for tokens, and refreshing an
  expired access token.
- `netlify/functions/strava-activities.js` — fetches your ride history
  (paginated) using the access token.
- `netlify/functions/strava-activity-detail.js` — fetches the full detail
  for a single ride (heart rate, power, splits, gear, etc.) for the recap view.
- `netlify/functions/geocode.js` — turns an address into coordinates via
  Nominatim.
- `netlify/functions/simulate-route.js` — generates a real-road loop route
  of roughly the requested distance via a public OSRM server.
- Your access/refresh tokens are stored in your browser's `localStorage` —
  they're yours, tied to your own device, and never touch anywhere else.

## Notes & limits

- Free tiers comfortably cover personal use: Netlify's free plan (100GB
  bandwidth, 125k function calls/month), Strava's API limits (200
  requests/15 min, 2,000/day), and reasonable/occasional use of the
  public Nominatim and OSRM demo services.
- The dashboard pulls your full ride history (paginated, up to ~2,000
  activities) so year/month/week filters have something to filter.
- Rides without GPS data (manual entries, some trainer rides) won't have a
  route to draw, but still count toward the stats.
- Simulated routes are a rough suggestion: the loop-shaping algorithm
  scatters waypoints around your start and asks OSRM for the shortest
  way to visit them and return — it iterates a few times to land near
  your requested distance, but road layout in your area can make some
  distances easier to hit than others.
- This is built for single-user personal use. If you ever wanted to share
  it with friends, each person would need their own Strava-connected
  session (the current design doesn't support multiple accounts).
