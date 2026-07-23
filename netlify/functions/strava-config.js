// Returns the public Strava Client ID so the frontend can build the
// OAuth authorize URL. The Client SECRET never leaves this server —
// see strava-auth.js.
exports.handler = async function () {
  const clientId = process.env.STRAVA_CLIENT_ID;

  if (!clientId) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "STRAVA_CLIENT_ID is not set. Add it in Netlify: Site settings → Environment variables.",
      }),
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId }),
  };
};
