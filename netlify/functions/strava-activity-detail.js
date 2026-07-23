// Fetches the full detail record for a single ride — richer than the
// summary list used on the main dashboard (heart rate, power, gear,
// per-km/mile splits, achievement counts, full-resolution route, etc).

exports.handler = async function (event) {
  const authHeader = event.headers.authorization || event.headers.Authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { statusCode: 401, body: JSON.stringify({ error: "Missing bearer token" }) };
  }

  const id = event.queryStringParameters?.id;
  if (!id) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing 'id' query parameter" }) };
  }

  try {
    const res = await fetch(`https://www.strava.com/api/v3/activities/${encodeURIComponent(id)}`, {
      headers: { Authorization: authHeader },
    });

    const a = await res.json();

    if (!res.ok) {
      return {
        statusCode: res.status,
        body: JSON.stringify({ error: a.message || "Strava rejected the request", details: a }),
      };
    }

    const detail = {
      id: a.id,
      name: a.name,
      description: a.description || null,
      date: a.start_date_local,
      type: a.type,
      distance: a.distance,
      moving_time: a.moving_time,
      elapsed_time: a.elapsed_time,
      elevation_gain: a.total_elevation_gain,
      elev_high: a.elev_high,
      elev_low: a.elev_low,
      avg_speed: a.average_speed,
      max_speed: a.max_speed,
      avg_cadence: a.average_cadence ?? null,
      avg_watts: a.average_watts ?? null,
      weighted_avg_watts: a.weighted_average_watts ?? null,
      kilojoules: a.kilojoules ?? null,
      avg_heartrate: a.average_heartrate ?? null,
      max_heartrate: a.max_heartrate ?? null,
      calories: a.calories ?? null,
      achievement_count: a.achievement_count ?? 0,
      pr_count: a.pr_count ?? 0,
      kudos_count: a.kudos_count ?? 0,
      comment_count: a.comment_count ?? 0,
      photo_count: a.total_photo_count ?? a.photo_count ?? 0,
      trainer: !!a.trainer,
      commute: !!a.commute,
      gear: a.gear ? { name: a.gear.name, distance: a.gear.distance } : null,
      polyline: a.map && (a.map.polyline || a.map.summary_polyline) ? a.map.polyline || a.map.summary_polyline : null,
      splits_metric: Array.isArray(a.splits_metric) ? a.splits_metric : [],
      splits_standard: Array.isArray(a.splits_standard) ? a.splits_standard : [],
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activity: detail }),
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: "Could not reach Strava", details: String(err) }) };
  }
};
