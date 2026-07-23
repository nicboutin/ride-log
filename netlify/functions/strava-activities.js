// Proxies a request for recent activities to Strava, using the
// access token the frontend already holds. This just avoids
// CORS friction and keeps all Strava calls in one place; it does not
// need the Client Secret (refreshing expired tokens is handled by
// strava-auth.js, called from the frontend before this one).

exports.handler = async function (event) {
  const authHeader = event.headers.authorization || event.headers.Authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { statusCode: 401, body: JSON.stringify({ error: "Missing bearer token" }) };
  }

  const perPage = event.queryStringParameters?.per_page || "200";
  const page = event.queryStringParameters?.page || "1";

  try {
    const res = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=${encodeURIComponent(perPage)}&page=${encodeURIComponent(page)}`,
      { headers: { Authorization: authHeader } }
    );

    const data = await res.json();

    if (!res.ok) {
      return {
        statusCode: res.status,
        body: JSON.stringify({ error: data.message || "Strava rejected the request", details: data }),
      };
    }

    // Keep only cycling activities, and only the fields the dashboard uses.
    const rides = data
      .filter((a) => a.type === "Ride" || a.type === "VirtualRide" || a.type === "GravelRide")
      .map((a) => ({
        id: a.id,
        name: a.name,
        date: a.start_date_local,
        distance: a.distance, // meters
        moving_time: a.moving_time, // seconds
        elevation_gain: a.total_elevation_gain, // meters
        avg_speed: a.average_speed, // m/s
        polyline: a.map && a.map.summary_polyline ? a.map.summary_polyline : null,
      }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      // rawCount (pre-filter) tells the frontend whether Strava returned a
      // full page — if so, there may be more pages to fetch.
      body: JSON.stringify({ rides, rawCount: data.length }),
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: "Could not reach Strava", details: String(err) }) };
  }
};
