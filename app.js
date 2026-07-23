(function () {
  "use strict";

  const STORAGE_KEY = "ridelog_tokens";
  const main = document.getElementById("main");
  const topbarStatus = document.getElementById("topbarStatus");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let allRides = [];
  let athleteInfo = null;
  let filters = { year: "all", month: "all", week: "all" };
  let activeModalMap = null; // Leaflet instance inside whichever modal is open
  let simCache = null; // { lat, lon, displayName, address } from the last successful geocode

  const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

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
  // formatting (metric only)
  // ---------------------------------------------------------------
  function fmtDistance(meters) {
    return { value: (meters / 1000).toFixed(1), unit: "km" };
  }
  function fmtElevation(meters) {
    return { value: Math.round(meters).toLocaleString(), unit: "m" };
  }
  function fmtSpeed(mps) {
    return { value: (mps * 3.6).toFixed(1), unit: "km/h" };
  }
  function fmtPace(mps) {
    if (!mps) return "–";
    const secPerKm = 1000 / mps;
    const m = Math.floor(secPerKm / 60);
    const s = Math.round(secPerKm % 60);
    return `${m}:${String(s).padStart(2, "0")} /km`;
  }
  function fmtTime(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.round((totalSeconds % 3600) / 60);
    return `${h}:${String(m).padStart(2, "0")}`;
  }
  function fmtClock(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.round(totalSeconds % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  }
  function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });
  }
  function fmtFullDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  }
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }

  // ---------------------------------------------------------------
  // Google encoded polyline algorithm (Strava *_polyline fields, and
  // OSRM's geometries=polyline output use the same encoding)
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
  // week / month / year helpers (Monday-start weeks, local time)
  // ---------------------------------------------------------------
  function getWeekStart(d) {
    const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = date.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    date.setDate(date.getDate() + diffToMonday);
    return date;
  }
  function weekKey(d) {
    const ws = getWeekStart(d);
    return `${ws.getFullYear()}-${String(ws.getMonth() + 1).padStart(2, "0")}-${String(ws.getDate()).padStart(2, "0")}`;
  }
  function formatWeekLabel(weekStart) {
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 6);
    const sameMonth = weekStart.getMonth() === end.getMonth();
    const startStr = weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const endStr = end.toLocaleDateString(undefined, sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" });
    return `${startStr}–${endStr}`;
  }
  function getAvailableYears(rides) {
    return [...new Set(rides.map((r) => new Date(r.date).getFullYear()))].sort((a, b) => b - a);
  }
  function getAvailableMonths(rides, year) {
    const set = new Set(
      rides.filter((r) => new Date(r.date).getFullYear() === year).map((r) => new Date(r.date).getMonth())
    );
    return [...set].sort((a, b) => a - b).map((m) => ({ value: m, label: MONTH_NAMES[m] }));
  }
  function getAvailableWeeks(rides, year, month) {
    const map = new Map();
    rides
      .filter((r) => {
        const d = new Date(r.date);
        if (d.getFullYear() !== year) return false;
        if (month !== "all" && d.getMonth() !== Number(month)) return false;
        return true;
      })
      .forEach((r) => {
        const d = new Date(r.date);
        const key = weekKey(d);
        if (!map.has(key)) map.set(key, getWeekStart(d));
      });
    return [...map.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, start]) => ({ key, label: formatWeekLabel(start) }));
  }
  function filterRides(rides, f) {
    return rides.filter((r) => {
      const d = new Date(r.date);
      if (f.year !== "all" && d.getFullYear() !== Number(f.year)) return false;
      if (f.month !== "all" && d.getMonth() !== Number(f.month)) return false;
      if (f.week !== "all" && weekKey(d) !== f.week) return false;
      return true;
    });
  }
  function periodLabel(f) {
    if (f.year === "all") return "All time";
    if (f.week !== "all") {
      const [y, m, d] = f.week.split("-").map(Number);
      return formatWeekLabel(new Date(y, m - 1, d)) + `, ${f.year}`;
    }
    if (f.month !== "all") return `${MONTH_NAMES[Number(f.month)]} ${f.year}`;
    return String(f.year);
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

  async function fetchAllRides(accessToken) {
    const perPage = 200;
    const maxPages = 10; // safety cap (~2000 activities)
    let all = [];
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetch(`/.netlify/functions/strava-activities?per_page=${perPage}&page=${page}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load activities");
      all = all.concat(data.rides);
      if (!data.rawCount || data.rawCount < perPage) break;
    }
    return all;
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

  function updateTopbarConnected() {
    const first = athleteInfo && athleteInfo.firstname ? athleteInfo.firstname : null;
    topbarStatus.innerHTML = `<span class="status-dot"></span> ${first ? "connected as " + first : "connected"}`;
    const disc = document.createElement("button");
    disc.className = "link-btn";
    disc.style.marginLeft = "10px";
    disc.textContent = "Disconnect";
    disc.addEventListener("click", () => {
      clearTokens();
      renderConnectScreen();
    });
    topbarStatus.appendChild(disc);
  }

  function renderDashboard() {
    updateTopbarConnected();

    const filtered = filterRides(allRides, filters);
    const years = getAvailableYears(allRides);
    const months = filters.year === "all" ? [] : getAvailableMonths(allRides, Number(filters.year));
    const weeks = filters.year === "all" ? [] : getAvailableWeeks(allRides, Number(filters.year), filters.month);

    const totals = computeTotals(filtered);
    const dist = fmtDistance(totals.distance);
    const elev = fmtElevation(totals.elevation);
    const avgSpeedMps = totals.count ? totals.speedSum / totals.count : 0;
    const speed = fmtSpeed(avgSpeedMps);
    const time = fmtTime(totals.time);

    main.innerHTML = `
      <div class="filter-bar">
        <div class="filter-group">
          <select id="yearFilter" class="filter-select">
            <option value="all" ${filters.year === "all" ? "selected" : ""}>All time</option>
            ${years.map((y) => `<option value="${y}" ${filters.year === String(y) ? "selected" : ""}>${y}</option>`).join("")}
          </select>
          <select id="monthFilter" class="filter-select" ${filters.year === "all" ? "disabled" : ""}>
            <option value="all" ${filters.month === "all" ? "selected" : ""}>All months</option>
            ${months.map((m) => `<option value="${m.value}" ${filters.month === String(m.value) ? "selected" : ""}>${m.label}</option>`).join("")}
          </select>
          <select id="weekFilter" class="filter-select" ${filters.year === "all" ? "disabled" : ""}>
            <option value="all" ${filters.week === "all" ? "selected" : ""}>All weeks</option>
            ${weeks.map((w) => `<option value="${w.key}" ${filters.week === w.key ? "selected" : ""}>${w.label}</option>`).join("")}
          </select>
        </div>
        <button id="simulateBtn" class="link-btn">Simulate ride</button>
      </div>

      <div class="hero">
        <svg class="contour" viewBox="0 0 1000 90" preserveAspectRatio="none">
          <path d="M0,70 C 60,20 120,90 180,50 S 300,10 360,55 S 480,85 540,40 S 660,5 720,45 S 840,80 900,35 S 980,15 1000,50"
                fill="none" stroke="var(--signal-dim)" stroke-width="2"/>
          <path d="M0,80 C 80,55 140,95 200,70 S 320,35 380,72 S 520,95 580,60 S 700,25 760,65 S 900,90 1000,60"
                fill="none" stroke="var(--hairline)" stroke-width="2"/>
        </svg>
        <div class="hero-sub">${totals.count} ride${totals.count === 1 ? "" : "s"} · ${periodLabel(filters)}</div>
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
        <div class="section-head"><h2>Routes (${filtered.length})</h2></div>
        <div id="map"></div>
      </div>

      <div class="section">
        <div class="section-head"><h2>Log (${filtered.length})</h2></div>
        <div class="log-head">
          <div>Date</div><div>Ride</div>
          <div class="metric">Dist</div><div class="metric elev">Elev</div><div class="metric">Time</div>
        </div>
        <div class="log-list" id="logList"></div>
      </div>

      <div class="footer">Data from Strava · Map tiles &copy; CARTO, OpenStreetMap contributors · Click a ride for full details</div>
    `;

    animateNumber(document.getElementById("numDistance"), dist.value);
    animateNumber(document.getElementById("numElev"), elev.value);
    animateNumber(document.getElementById("numSpeed"), speed.value);

    const logList = document.getElementById("logList");
    if (filtered.length === 0) {
      logList.innerHTML = `<div class="log-empty">No rides in this period.</div>`;
    } else {
      logList.innerHTML = filtered
        .map((r) => {
          const d = fmtDistance(r.distance);
          const e = fmtElevation(r.elevation_gain);
          return `
            <div class="log-row" data-id="${r.id}" tabindex="0" role="button">
              <div class="date">${fmtDate(r.date)}</div>
              <div class="name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</div>
              <div class="metric">${d.value}${d.unit}</div>
              <div class="metric elev">${e.value}${e.unit}</div>
              <div class="metric">${fmtTime(r.moving_time)}</div>
            </div>`;
        })
        .join("");

      logList.addEventListener("click", (e) => {
        const row = e.target.closest(".log-row");
        if (row) openRideDetail(row.dataset.id);
      });
      logList.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const row = e.target.closest(".log-row");
        if (row) { e.preventDefault(); openRideDetail(row.dataset.id); }
      });
    }

    document.getElementById("yearFilter").addEventListener("change", (e) => {
      filters.year = e.target.value;
      filters.month = "all";
      filters.week = "all";
      renderDashboard();
    });
    document.getElementById("monthFilter").addEventListener("change", (e) => {
      filters.month = e.target.value;
      filters.week = "all";
      renderDashboard();
    });
    document.getElementById("weekFilter").addEventListener("change", (e) => {
      filters.week = e.target.value;
      renderDashboard();
    });
    document.getElementById("simulateBtn").addEventListener("click", openSimulateModal);

    renderMap(filtered);
  }

  function renderMap(rides) {
    const mapEl = document.getElementById("map");
    const withRoutes = rides.filter((r) => r.polyline);

    if (withRoutes.length === 0) {
      mapEl.outerHTML = `<div id="map" class="map-empty">No route data in this period (manual entries or trainer rides have no GPS track).</div>`;
      return;
    }

    const map = L.map("map", { scrollWheelZoom: false });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OpenStreetMap contributors',
      subdomains: "abcd",
      maxZoom: 19,
    }).addTo(map);

    const signalColor = getComputedStyle(document.documentElement).getPropertyValue("--signal").trim() || "#93C23F";
    const allBounds = [];
    withRoutes.forEach((r) => {
      const latlngs = decodePolyline(r.polyline);
      if (!latlngs.length) return;
      const line = L.polyline(latlngs, { color: signalColor, weight: 3, opacity: 0.85 }).addTo(map);
      line.bindTooltip(`${r.name} · ${fmtDate(r.date)}`, { sticky: true });
      line.on("click", () => openRideDetail(r.id));
      line.on("mouseover", () => line.setStyle({ weight: 5, opacity: 1 }));
      line.on("mouseout", () => line.setStyle({ weight: 3, opacity: 0.85 }));
      allBounds.push(...latlngs);
    });

    if (allBounds.length) {
      map.fitBounds(allBounds, { padding: [24, 24] });
    } else {
      map.setView([0, 0], 2);
    }
  }

  // ---------------------------------------------------------------
  // shared modal shell (used by both ride-detail and simulate-ride)
  // ---------------------------------------------------------------
  function ensureModalRoot() {
    let overlay = document.getElementById("modalOverlay");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "modalOverlay";
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true">
        <button class="modal-close" id="modalClose" aria-label="Close">&times;</button>
        <div id="modalBody"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });
    document.getElementById("modalClose").addEventListener("click", closeModal);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay.classList.contains("open")) closeModal();
    });
    return overlay;
  }

  function closeModal() {
    const overlay = document.getElementById("modalOverlay");
    if (!overlay) return;
    overlay.classList.remove("open");
    if (activeModalMap) { activeModalMap.remove(); activeModalMap = null; }
  }

  function statTile(label, value, unit) {
    if (value === null || value === undefined) return "";
    return `
      <div class="mini-stat">
        <div class="mini-num">${value}${unit ? `<span class="mini-unit">${unit}</span>` : ""}</div>
        <div class="mini-label">${label}</div>
      </div>`;
  }

  // ---------------------------------------------------------------
  // ride detail modal
  // ---------------------------------------------------------------
  async function openRideDetail(id) {
    const overlay = ensureModalRoot();
    const body = document.getElementById("modalBody");
    overlay.classList.add("open");
    body.innerHTML = `<p class="modal-loading">Loading ride…</p>`;

    try {
      const accessToken = await ensureFreshToken();
      if (!accessToken) throw new Error("Not connected");

      const res = await fetch(`/.netlify/functions/strava-activity-detail?id=${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load ride");

      renderRideDetail(data.activity);
    } catch (err) {
      body.innerHTML = `<div class="error-box">${escapeHtml(err.message || String(err))}</div>`;
    }
  }

  function renderRideDetail(a) {
    const dist = fmtDistance(a.distance);
    const elev = fmtElevation(a.elevation_gain);
    const speed = fmtSpeed(a.avg_speed);
    const maxSpeed = a.max_speed ? fmtSpeed(a.max_speed) : null;

    const tiles = [
      statTile("Distance", dist.value, dist.unit),
      statTile("Elevation", elev.value, elev.unit),
      statTile("Moving time", fmtClock(a.moving_time)),
      statTile("Elapsed time", fmtClock(a.elapsed_time)),
      statTile("Avg speed", speed.value, speed.unit),
      maxSpeed ? statTile("Max speed", maxSpeed.value, maxSpeed.unit) : "",
      a.avg_heartrate ? statTile("Avg HR", Math.round(a.avg_heartrate), "bpm") : "",
      a.max_heartrate ? statTile("Max HR", Math.round(a.max_heartrate), "bpm") : "",
      a.avg_watts ? statTile("Avg power", Math.round(a.avg_watts), "W") : "",
      a.weighted_avg_watts ? statTile("Weighted power", Math.round(a.weighted_avg_watts), "W") : "",
      a.kilojoules ? statTile("Work", Math.round(a.kilojoules), "kJ") : "",
      a.avg_cadence ? statTile("Avg cadence", Math.round(a.avg_cadence), "rpm") : "",
      a.calories ? statTile("Calories", Math.round(a.calories), "kcal") : "",
    ].filter(Boolean).join("");

    const socialBits = [
      a.kudos_count ? `${a.kudos_count} kudos` : null,
      a.comment_count ? `${a.comment_count} comments` : null,
      a.achievement_count ? `${a.achievement_count} achievements` : null,
      a.pr_count ? `${a.pr_count} PRs` : null,
      a.photo_count ? `${a.photo_count} photos` : null,
    ].filter(Boolean).join(" · ");

    const tags = [
      a.gear && a.gear.name ? a.gear.name : null,
      a.trainer ? "Trainer" : null,
      a.commute ? "Commute" : null,
    ].filter(Boolean);

    const splits = a.splits_metric;
    const splitsHtml = splits && splits.length
      ? `
        <div class="section-head" style="margin-top:22px"><h2>Splits</h2></div>
        <div class="splits-table">
          <div class="splits-head"><div>#</div><div>Time</div><div>Pace</div><div class="elev">Elev</div></div>
          ${splits.map((s) => {
            const e = fmtElevation(s.elevation_difference || 0);
            const sign = (s.elevation_difference || 0) > 0 ? "+" : "";
            return `
              <div class="splits-row">
                <div>${s.split}</div>
                <div>${fmtClock(s.moving_time)}</div>
                <div>${fmtPace(s.average_speed)}</div>
                <div class="elev">${sign}${e.value}${e.unit}</div>
              </div>`;
          }).join("")}
        </div>`
      : "";

    document.getElementById("modalBody").innerHTML = `
      <h2 class="modal-title">${escapeHtml(a.name)}</h2>
      <div class="modal-date">${fmtFullDate(a.date)}</div>
      ${a.description ? `<p class="modal-desc">${escapeHtml(a.description)}</p>` : ""}
      ${tags.length ? `<div class="tag-row">${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      <div class="mini-grid">${tiles}</div>
      ${socialBits ? `<div class="social-row">${socialBits}</div>` : ""}
      ${a.polyline ? `<div id="modalMap" class="modal-map"></div>` : `<div class="map-empty" style="padding:24px 0">No GPS route on this ride.</div>`}
      ${splitsHtml}
    `;

    if (a.polyline) {
      const latlngs = decodePolyline(a.polyline);
      if (latlngs.length) {
        activeModalMap = L.map("modalMap", { scrollWheelZoom: false });
        L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
          attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OpenStreetMap contributors',
          subdomains: "abcd", maxZoom: 19,
        }).addTo(activeModalMap);
        const signalColor = getComputedStyle(document.documentElement).getPropertyValue("--signal").trim() || "#93C23F";
        L.polyline(latlngs, { color: signalColor, weight: 4, opacity: 0.9 }).addTo(activeModalMap);
        activeModalMap.fitBounds(latlngs, { padding: [16, 16] });
      }
    }
  }

  // ---------------------------------------------------------------
  // simulate-ride modal
  // ---------------------------------------------------------------
  function openSimulateModal() {
    const overlay = ensureModalRoot();
    overlay.classList.add("open");
    renderSimulateForm();
  }

  function renderSimulateForm() {
    document.getElementById("modalBody").innerHTML = `
      <h2 class="modal-title">Simulate a ride</h2>
      <p class="modal-desc">Say about how far you want to go and where you're starting — I'll suggest a loop route of roughly that distance, starting and ending near that address.</p>
      <div class="sim-form">
        <label class="sim-label">Distance (km)
          <input type="number" id="simDistance" min="3" max="200" step="1" value="${simCache?.distanceKm || 30}" class="sim-input" />
        </label>
        <label class="sim-label">Starting address
          <input type="text" id="simAddress" placeholder="e.g. 10 Downing Street, London"
                 value="${simCache?.address ? escapeHtml(simCache.address) : ""}" class="sim-input" />
        </label>
        <button id="simSubmit" class="connect-btn" style="margin-top:6px">Generate route</button>
        <div id="simError" class="error-box" style="display:none"></div>
      </div>
    `;
    document.getElementById("simSubmit").addEventListener("click", handleSimulateSubmit);
  }

  async function handleSimulateSubmit() {
    const distanceKm = Number(document.getElementById("simDistance").value);
    const address = document.getElementById("simAddress").value.trim();
    const errorBox = document.getElementById("simError");
    const btn = document.getElementById("simSubmit");

    if (!address) return showSimError("Enter a starting address.");
    if (!distanceKm || distanceKm < 3 || distanceKm > 200) return showSimError("Pick a distance between 3 and 200 km.");

    btn.disabled = true;
    btn.textContent = "Finding your route…";
    errorBox.style.display = "none";

    try {
      const geo = await fetch(`/.netlify/functions/geocode?address=${encodeURIComponent(address)}`);
      const geoData = await geo.json();
      if (!geo.ok) throw new Error(geoData.error || "Could not find that address");

      simCache = { lat: geoData.lat, lon: geoData.lon, displayName: geoData.displayName, address, distanceKm };

      await generateAndRenderRoute();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Generate route";
      showSimError(err.message || String(err));
    }

    function showSimError(msg) {
      errorBox.style.display = "block";
      errorBox.textContent = msg;
    }
  }

  async function generateAndRenderRoute() {
    const body = document.getElementById("modalBody");
    body.innerHTML = `<p class="modal-loading">Sketching a ${simCache.distanceKm}km loop near ${escapeHtml(simCache.displayName || simCache.address)}…</p>`;

    try {
      const res = await fetch("/.netlify/functions/simulate-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: simCache.lat, lon: simCache.lon, distanceKm: simCache.distanceKm }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not generate a route for this area");

      renderSimulatedResult(data);
    } catch (err) {
      body.innerHTML = `
        <div class="error-box">${escapeHtml(err.message || String(err))}</div>
        <button id="simRetryBack" class="link-btn" style="margin-top:14px">Try again</button>
      `;
      document.getElementById("simRetryBack").addEventListener("click", renderSimulateForm);
    }
  }

  function renderSimulatedResult(route) {
    document.getElementById("modalBody").innerHTML = `
      <h2 class="modal-title">${route.distanceKm}km loop</h2>
      <div class="modal-date">Starting near ${escapeHtml(simCache.displayName || simCache.address)}</div>
      <div class="mini-grid">
        ${statTile("Distance", route.distanceKm, "km")}
        ${statTile("Est. time", fmtClock(route.durationMinutes * 60))}
      </div>
      <div id="simMap" class="modal-map"></div>
      <p class="modal-desc" style="margin-top:14px">A suggested loop, not a real ride — check the route makes sense for your bike and traffic before heading out.</p>
      <div class="tag-row">
        <button id="simAnother" class="link-btn">Generate another</button>
        <button id="simNewSearch" class="link-btn">New search</button>
      </div>
    `;

    const latlngs = decodePolyline(route.polyline);
    if (latlngs.length) {
      activeModalMap = L.map("simMap", { scrollWheelZoom: false });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OpenStreetMap contributors',
        subdomains: "abcd", maxZoom: 19,
      }).addTo(activeModalMap);
      const signalColor = getComputedStyle(document.documentElement).getPropertyValue("--signal").trim() || "#93C23F";
      L.polyline(latlngs, { color: signalColor, weight: 4, opacity: 0.9 }).addTo(activeModalMap);
      L.circleMarker(latlngs[0], { radius: 6, color: "#E8A23D", fillColor: "#E8A23D", fillOpacity: 1 }).addTo(activeModalMap);
      activeModalMap.fitBounds(latlngs, { padding: [16, 16] });
    }

    document.getElementById("simAnother").addEventListener("click", () => {
      if (activeModalMap) { activeModalMap.remove(); activeModalMap = null; }
      generateAndRenderRoute();
    });
    document.getElementById("simNewSearch").addEventListener("click", () => {
      if (activeModalMap) { activeModalMap.remove(); activeModalMap = null; }
      renderSimulateForm();
    });
  }

  // ---------------------------------------------------------------
  // boot
  // ---------------------------------------------------------------
  async function loadDashboard() {
    main.innerHTML = `<div class="connect-screen"><div class="connect-card"><p>Loading your rides…</p></div></div>`;
    try {
      const accessToken = await ensureFreshToken();
      if (!accessToken) return renderConnectScreen();

      allRides = await fetchAllRides(accessToken);
      const tokens = getTokens();
      athleteInfo = tokens ? tokens.athlete : null;

      renderDashboard();
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
