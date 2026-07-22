// Handles the two token operations that require the Client Secret:
//   1. Exchanging an OAuth "code" for an access/refresh token pair
//      (first-time connect).
//   2. Exchanging a "refresh_token" for a fresh access token
//      (called by the frontend when the current token has expired).
//
// The Client Secret is read from an environment variable and is never
// sent to, or stored in, the browser.

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error:
          "STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET are not set. Add them in Netlify: Site settings → Environment variables.",
      }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const params = { client_id: clientId, client_secret: clientSecret };

  if (payload.code) {
    params.code = payload.code;
    params.grant_type = "authorization_code";
  } else if (payload.refresh_token) {
    params.refresh_token = payload.refresh_token;
    params.grant_type = "refresh_token";
  } else {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Provide either 'code' or 'refresh_token'" }),
    };
  }

  try {
    const res = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });

    const data = await res.json();

    if (!res.ok) {
      return {
        statusCode: res.status,
        body: JSON.stringify({ error: data.message || "Strava rejected the request", details: data }),
      };
    }

    // Only pass through what the frontend needs — never anything secret.
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at,
        athlete: data.athlete
          ? {
              id: data.athlete.id,
              firstname: data.athlete.firstname,
              lastname: data.athlete.lastname,
            }
          : undefined,
      }),
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: "Could not reach Strava", details: String(err) }) };
  }
};
