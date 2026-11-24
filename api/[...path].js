// Vercel serverless entry point. A thin wrapper, not a rewrite — handleApi
// is already a framework-free (req, res) function (see lib/api.js), written
// once and shared with the local dev server in server.js.
'use strict';

// Vercel sets VERCEL only when a project exposes its system variables. This
// file runs nowhere else, so say so ourselves: auth.js must never fall back to
// "no sign-in" on the public internet (decision 012).
process.env.VERCEL = process.env.VERCEL || '1';

const { handleApi, sendJSON } = require('../lib/api.js');

module.exports = async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    await handleApi(req, res, url.pathname, url.searchParams);
  } catch (e) {
    // The detail goes to the server log, never to the client: a failure down
    // in the Postgres driver puts host names and connection-string fragments
    // in e.message, and this endpoint is reachable by anyone holding a game
    // link.
    console.error(`Unhandled API error on ${url.pathname}: ${e.stack || e.message}`);
    sendJSON(res, 500, { error: 'Something went wrong on the server.' });
  }
};
