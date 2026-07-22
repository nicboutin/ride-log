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

## How it works

- `index.html` / `style.css` / `app.js` — the whole frontend, no build step.
- `netlify/functions/strava-config.js` — hands the frontend your (non-secret)
  Client ID so it can build the "Connect to Strava" link.
- `netlify/functions/strava-auth.js` — the only place your Client Secret is
  used: exchanging Strava's one-time `code` for tokens, and refreshing an
  expired access token.
- `netlify/functions/strava-activities.js` — fetches your recent rides using
  the access token and returns the fields the dashboard needs.
- Your access/refresh tokens are stored in your browser's `localStorage` —
  they're yours, tied to your own device, and never touch anywhere else.

## Notes & limits

- Free tiers comfortably cover personal use: Netlify's free plan (100GB
  bandwidth, 125k function calls/month) and Strava's API limits (200
  requests/15 min, 2,000/day).
- The dashboard pulls your most recent 40 activities and filters to rides
  (regular, gravel, and virtual). Change `per_page` in `app.js` /
  `strava-activities.js` if you want more or fewer.
- Rides without GPS data (manual entries, some trainer rides) won't have a
  route to draw, but still count toward the stats.
- This is built for single-user personal use. If you ever wanted to share
  it with friends, each person would need their own Strava-connected
  session (the current design doesn't support multiple accounts).
