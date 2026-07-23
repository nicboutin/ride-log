// Generates a bike LOOP route (starts and ends at the same point) of
// roughly the requested distance, following real roads.
//
// How it works:
//   1. Scatter a handful of waypoints in a rough circle around the start,
//      sized so the real-road loop should come out near the target distance.
//   2. Ask OSRM's "trip" service (a round-trip solver) for the shortest
//      way to visit those points and return to the start.
//   3. Compare the actual distance to the target and, if it's off,
//      scale the circle and try again (a few iterations).
//
// Uses the free community-run OSRM demo server (routing.openstreetmap.de,
// maintained by FOSSGIS e.V.) — no API key needed, but it's a shared
// public service, so this is meant for occasional personal use, not
// heavy traffic. If it's ever slow or unavailable, that's on their end,
// not something an environment variable here can fix.

const OSRM_HOST = "https://routing.openstreetmap.de/routed-bike";
const EARTH_RADIUS_M = 6371000;

function destinationPoint(lat, lon, bearingDeg, distanceM) {
  const bearing = (bearingDeg * Math.PI) / 180;
  const angDist = distanceM / EARTH_RADIUS_M;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angDist) + Math.cos(lat1) * Math.sin(angDist) * Math.cos(bearing)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angDist) * Math.cos(lat1),
      Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
    );

  return { lat: (lat2 * 180) / Math.PI, lon: (lon2 * 180) / Math.PI };
}

function buildLoopWaypoints(lat, lon, radiusM, pointCount) {
  const startBearing = Math.random() * 360;
  const pts = [];
  for (let i = 1; i <= pointCount; i++) {
    const bearing = startBearing + (360 / pointCount) * i;
    pts.push(destinationPoint(lat, lon, bearing, radiusM));
  }
  return pts;
}

async function tryRoute(lat, lon, radiusM) {
  const waypoints = buildLoopWaypoints(lat, lon, radiusM, 5);
  const coords = [[lon, lat], ...waypoints.map((w) => [w.lon, w.lat])].map((c) => c.join(",")).join(";");

  const url = `${OSRM_HOST}/trip/v1/bike/${coords}?source=first&destination=first&roundtrip=true&geometries=polyline&overview=full`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.code !== "Ok" || !data.trips || !data.trips[0]) return null;
  const trip = data.trips[0];
  return { distance: trip.distance, duration: trip.duration, geometry: trip.geometry };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const { lat, lon, distanceKm } = payload;
  if (typeof lat !== "number" || typeof lon !== "number" || !distanceKm) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing lat/lon/distanceKm" }) };
  }
  const target = Math.min(Math.max(Number(distanceKm), 3), 200) * 1000; // clamp 3–200km, in meters

  try {
    // Real-road loops usually run longer than the straight-line circle
    // they're scattered around, so start with a smaller radius than
    // circumference math alone would suggest.
    let radius = target / (2 * Math.PI * 1.3);
    let best = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await tryRoute(lat, lon, radius);
      if (result) {
        if (!best || Math.abs(result.distance - target) < Math.abs(best.distance - target)) {
          best = result;
        }
        const ratio = Math.abs(result.distance - target) / target;
        if (ratio < 0.12) break; // within 12% of target — good enough
        radius *= target / result.distance;
      } else {
        radius *= 0.8; // route failed (maybe unroutable area) — try a tighter loop
      }
    }

    if (!best) {
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: "Could not generate a route near that address. Try a different distance, or a nearby address with more roads.",
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        distanceKm: +(best.distance / 1000).toFixed(1),
        durationMinutes: Math.round(best.duration / 60),
        polyline: best.geometry,
      }),
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: "Could not reach the routing service", details: String(err) }) };
  }
};
