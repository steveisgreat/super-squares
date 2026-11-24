// One request, hard timeout, never throws. Shared by the adapters so the error
// strings are uniform: 'timeout', 'HTTP <status>', 'bad JSON', 'network: <msg>'.
// Secrets are scrubbed from every message, so an API key can never reach a log
// or a returned error.
'use strict';

const DEFAULT_TIMEOUT_MS = 4000;

async function getJson(url, { headers, fetchImpl, timeoutMs, secrets } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const ctrl = new AbortController();
  const limit = timeoutMs || DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, limit);
  const scrub = s => (secrets || []).filter(Boolean)
    .reduce((out, k) => out.split(k).join('***'), String(s));
  try {
    const res = await doFetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    let text;
    try { text = await res.text(); } catch (e) { return { ok: false, error: timedOut ? 'timeout' : 'network: body read failed' }; }
    try { return { ok: true, body: JSON.parse(text) }; } catch (e) { return { ok: false, error: 'bad JSON' }; }
  } catch (e) {
    return { ok: false, error: timedOut ? 'timeout' : scrub(`network: ${e && e.message ? e.message : e}`) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { getJson, DEFAULT_TIMEOUT_MS };
