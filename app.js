(function () {
  "use strict";

  const STORAGE_KEY = "ridelog_tokens";
  const UNITS_KEY = "ridelog_units";
  const main = document.getElementById("main");
  const topbarStatus = document.getElementById("topbarStatus");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let currentRides = [];
  let currentUnits = localStorage.getItem(UNITS_KEY) || (navigator.language === "en-US" ? "imperial" : "metric");

  // ---------------------------------------------------------------
  // storage helpers
  // ---------------------------------------------------------------
  function getTokens() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function setTokens(tokens) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
  }
  function clearTokens() {
    localStorage.removeItem(STORAGE_KEY);
  }

  // ---------------------------------------------------------------
  // unit conversion + formatting
  // ---------------------------------------------------------------
  function fmtDistance(meters) {
    return currentUnits === "imperial"
      ? { value: (meters / 1609.344).toFixed(1), unit: "mi" }
      : { value: (meters / 1000).toFixed(1), unit: "km" };
  }
  function fmtElevation(meters) {
    return currentUnits === "imperial"
      ? { value: Math.round(meters * 3.28084).toLocaleString(), unit: "ft" }
      : { value: Math.round(meters).toLocaleString(), unit: "m" };
  }
  function fmtSpeed(mps) {
    return currentUnits === "imperial"
      ? { value: (mps * 2.23694).toFixed(1), unit: "mph" }
      : { value: (mps * 3.6).toFixed(1), unit: "km/h" };
  }
  function fmtTime(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.round((totalSeconds % 3600) / 60);
    return `${h}:${String(m).padStart(2, "0")}`;
  }
  function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });
  }

  // ---------------------------------------------------------------
  // Google encoded polyline algorithm (used by Strava's summary_polyline)
  // ---------------------------------------------------------------
  function decodePolyline(str) {
    let index = 0, lat = 0, lng = 0, coordinates = [];
    while (index < str.length) {
      let b, shift = 0, result = 0;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlat = result & 1 ? ~(result >> 1) : result >> 1;
      lat += dlat;

      shift = 0; result = 0;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlng = result & 1 ? ~(result >> 1) : result >> 1;
      lng += dlng;

      coordinates.push([lat / 1e5, lng / 1e5]);
    }
    return coordinates;
  }

  // ---------------------------------------------------------------
  // OAuth
  // ---------------------------------------------------------------
  async function beginConnect() {
    const btn = document.getElementById("connectBtn");
    const errorBox = document.getElementById("connectError");
    if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
    try {
      const res = await fetch("/.netlify/functions/strava-config");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load config");

      const redirectUri = window.location.origin + window.location.pathname;
      const url = new URL("https://www.strava.com/oauth/authorize");
      url.searchParams.set("client_id", data.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("approval_prompt", "auto");
      url.searchParams.set("scope", "activity:read_all");
      window.location.href = url.toString();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = "Connect to Strava"; }
      if (errorBox) {
        errorBox.style.display = "block";
        errorBox.textContent = err.message || String(err);
      }
    }
  }

  async function exchangeCode(code) {
    const res = await fetch("/.netlify/functions/strava-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not connect to Strava");
    setTokens(data);
    return data;
  }

  async function ensureFreshToken() {
    const tokens = getTokens();
    if (!tokens) return null;
    const now = Math.floor(Date.now() / 1000);
    if (tokens.expires_at && tokens.expires_at - now > 120) {
      return tokens.access_token;
    }
    // expired (or close to it) — refresh
    const res = await fetch("/.netlify/functions/strava-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    });
    const data = await res.json();
    if (!res.ok) {
      clearTokens();
      throw new Error(data.error || "Session expired — please reconnect");
    }
    setTokens({ ...tokens, ...data });
    return data.access_token;
  }

  // ---------------------------------------------------------------
  // rendering: connect screen
  // ---------------------------------------------------------------
  function renderConnectScreen(message) {
    topbarStatus.innerHTML = `<span class="status-dot off"></span> not connected`;
    main.innerHTML = `
      <div class="connect-screen">
        <div class="connect-card">
          <h1>Your rides, in one place</h1>
          <p>Connect your Strava account to pull in recent rides — distance, climbing,
             time, and the routes themselves on a map.</p>
          <button id="connectBtn" class="connect-btn">Connect to Strava</button>
          <div id="connectError" class="error-box" style="display:none"></div>
          <div class="setup-note">
            First time setting this up? Create an API app at
            <a href="https://www.strava.com/settings/api" target="_blank" rel="noopener">strava.com/settings/api</a>,
            then add <code>STRAVA_CLIENT_ID</code> and <code>STRAVA_CLIENT_SECRET</code>
            as environment variables on this site. See <code>README.md</code>.
          </div>
        </div>
      </div>
    `;
    if (message) {
      const box = document.getElementById("connectError");
      box.style.display = "block";
      box.textContent = message;
    }
    document.getElementById("connectBtn").addEventListener("click", beginConnect);
  }

  // ---------------------------------------------------------------
  // rendering: dashboard
  // ---------------------------------------------------------------
  function computeTotals(rides) {
    return rides.reduce(
      (acc, r) => {
        acc.distance += r.distance || 0;
        acc.elevation += r.elevation_gain || 0;
        acc.time += r.moving_time || 0;
        acc.speedSum += r.avg_speed || 0;
        acc.count += 1;
        return acc;
      },
      { distance: 0, elevation: 0, time: 0, speedSum: 0, count: 0 }
    );
  }

  function animateNumber(el, targetText) {
    // If the target isn't a plain number (e.g. "14:32"), just set it.
    const targetNum = parseFloat(targetText.replace(/,/g, ""));
    if (reduceMotion || isNaN(targetNum) || !/^[\d.,]+$/.test(targetText)) {
      el.textContent = targetText;
      return;
    }
    const duration = 700;
    const start = performance.now();
    const decimals = targetText.includes(".") ? targetText.split(".")[1].length : 0;
    function tick(now) {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const val = targetNum * eased;
      el.textContent = val.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function renderDashboard(rides, athlete) {
    currentRides = rides;
    const first = athlete && athlete.firstname ? athlete.firstname : null;
    topbarStatus.innerHTML = `<span class="status-dot"></span> ${first ? "connected as " + first : "connected"}`;

    const totals = computeTotals(rides);
    const dist = fmtDistance(totals.distance);
    const elev = fmtElevation(totals.elevation);
    const avgSpeedMps = totals.count ? totals.speedSum / totals.count : 0;
    const speed = fmtSpeed(avgSpeedMps);
    const time = fmtTime(totals.time);

    main.innerHTML = `
      <div class="hero">
        <svg class="contour" viewBox="0 0 1000 90" preserveAspectRatio="none">
          <path d="M0,70 C 60,20 120,90 180,50 S 300,10 360,55 S 480,85 540,40 S 660,5 720,45 S 840,80 900,35 S 980,15 1000,50"
                fill="none" stroke="var(--signal-dim)" stroke-width="2"/>
          <path d="M0,80 C 80,55 140,95 200,70 S 320,35 380,72 S 520,95 580,60 S 700,25 760,65 S 900,90 1000,60"
                fill="none" stroke="var(--hairline)" stroke-width="2"/>
        </svg>
        <div class="readout">
          <div class="stat">
            <div class="num" id="numDistance">0<span class="unit">${dist.unit}</span></div>
            <div class="label">Distance</div>
          </div>
          <div class="stat climb">
            <div class="num" id="numElev">0<span class="unit">${elev.unit}</span></div>
            <div class="label">Elev gain</div>
          </div>
          <div class="stat">
            <div class="num" id="numTime">${time}</div>
            <div class="label">Moving time</div>
          </div>
          <div class="stat">
            <div class="num" id="numSpeed">0<span class="unit">${speed.unit}</span></div>
            <div class="label">Avg speed</div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <h2>Routes (last ${rides.length})</h2>
          <div class="unit-toggle">
            <button data-unit="imperial" class="${currentUnits === "imperial" ? "active" : ""}">mi</button>
            <button data-unit="metric" class="${currentUnits === "metric" ? "active" : ""}">km</button>
          </div>
        </div>
        <div id="map"></div>
      </div>

      <div class="section">
        <div class="section-head"><h2>Log</h2></div>
        <div class="log-head">
          <div>Date</div><div>Ride</div>
          <div class="metric">Dist</div><div class="metric elev">Elev</div><div class="metric">Time</div>
        </div>
        <div class="log-list" id="logList"></div>
      </div>

      <div class="footer">Data from Strava · Map tiles &copy; CARTO, OpenStreetMap contributors</div>
    `;

    // animate hero numbers
    animateNumber(document.getElementById("numDistance"), dist.value);
    animateNumber(document.getElementById("numElev"), elev.value);
    animateNumber(document.getElementById("numSpeed"), speed.value);

    // log rows
    const logList = document.getElementById("logList");
    if (rides.length === 0) {
      logList.innerHTML = `<div class="log-empty">No rides found yet. Go ride, then refresh.</div>`;
    } else {
      logList.innerHTML = rides
        .map((r) => {
          const d = fmtDistance(r.distance);
          const e = fmtElevation(r.elevation_gain);
          return `
            <div class="log-row">
              <div class="date">${fmtDate(r.date)}</div>
              <div class="name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</div>
              <div class="metric">${d.value}${d.unit}</div>
              <div class="metric elev">${e.value}${e.unit}</div>
              <div class="metric">${fmtTime(r.moving_time)}</div>
            </div>`;
        })
        .join("");
    }

    // unit toggle
    document.querySelectorAll(".unit-toggle button").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentUnits = btn.dataset.unit;
        localStorage.setItem(UNITS_KEY, currentUnits);
        renderDashboard(currentRides, athlete);
      });
    });

    renderMap(rides);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }

  function renderMap(rides) {
    const mapEl = document.getElementById("map");
    const withRoutes = rides.filter((r) => r.polyline);

    if (withRoutes.length === 0) {
      mapEl.outerHTML = `<div id="map" class="map-empty">No route data on these rides (likely a manual entry or trainer ride with no GPS track).</div>`;
      return;
    }

    const map = L.map("map", { scrollWheelZoom: false });
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      {
        attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OpenStreetMap contributors',
        subdomains: "abcd",
        maxZoom: 19,
      }
    ).addTo(map);

    const allBounds = [];
    withRoutes.forEach((r) => {
      const latlngs = decodePolyline(r.polyline);
      if (!latlngs.length) return;
      const line = L.polyline(latlngs, {
        color: getComputedStyle(document.documentElement).getPropertyValue("--signal").trim() || "#93C23F",
        weight: 3,
        opacity: 0.85,
      }).addTo(map);
      line.bindTooltip(`${r.name} · ${fmtDate(r.date)}`, { sticky: true });
      allBounds.push(...latlngs);
    });

    if (allBounds.length) {
      map.fitBounds(allBounds, { padding: [24, 24] });
    } else {
      map.setView([0, 0], 2);
    }
  }

  // ---------------------------------------------------------------
  // boot
  // ---------------------------------------------------------------
  async function loadDashboard() {
    main.innerHTML = `<div class="connect-screen"><div class="connect-card"><p>Loading your rides…</p></div></div>`;
    try {
      const accessToken = await ensureFreshToken();
      if (!accessToken) return renderConnectScreen();

      const res = await fetch("/.netlify/functions/strava-activities?per_page=40", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load activities");

      const tokens = getTokens();
      renderDashboard(data.rides, tokens ? tokens.athlete : null);

      // small disconnect control in topbar
      const disc = document.createElement("button");
      disc.className = "link-btn";
      disc.style.marginLeft = "10px";
      disc.textContent = "Disconnect";
      disc.addEventListener("click", () => {
        clearTokens();
        renderConnectScreen();
      });
      topbarStatus.appendChild(disc);
    } catch (err) {
      renderConnectScreen(err.message || String(err));
    }
  }

  async function boot() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const oauthError = params.get("error");

    if (oauthError) {
      window.history.replaceState({}, "", window.location.pathname);
      return renderConnectScreen(
        oauthError === "access_denied" ? "Connection cancelled." : `Strava error: ${oauthError}`
      );
    }

    if (code) {
      main.innerHTML = `<div class="connect-screen"><div class="connect-card"><p>Connecting to Strava…</p></div></div>`;
      try {
        await exchangeCode(code);
        window.history.replaceState({}, "", window.location.pathname);
        return loadDashboard();
      } catch (err) {
        window.history.replaceState({}, "", window.location.pathname);
        return renderConnectScreen(err.message || String(err));
      }
    }

    const tokens = getTokens();
    if (tokens) return loadDashboard();

    renderConnectScreen();
  }

  boot();
})();
