// Turns a free-text address into coordinates, using OpenStreetMap's
// public Nominatim geocoder. Free, no API key — but their usage policy
// asks for a descriptive User-Agent and no more than ~1 request/second,
// both of which fit fine for a single personal user.
// Policy: https://operations.osmfoundation.org/policies/nominatim/

exports.handler = async function (event) {
  const address = event.queryStringParameters?.address;
  if (!address) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing 'address' query parameter" }) };
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "RideLog-personal-cycling-dashboard/1.0" },
    });

    if (!res.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: "Geocoding service returned an error" }) };
    }

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: "Could not find that address — try being more specific." }) };
    }

    const { lat, lon, display_name } = data[0];
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: parseFloat(lat), lon: parseFloat(lon), displayName: display_name }),
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: "Could not reach geocoding service", details: String(err) }) };
  }
};
