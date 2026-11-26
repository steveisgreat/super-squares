'use strict';

// The admin page's Database and Hosting cards (R45c, decision 027 section 5): a few numbers read from
// the Neon and Vercel APIs, only by GET /api/admin/stats, only for an admin. Each key is optional: a
// card without one answers null and the page shows "Open dashboard". A provider that fails or is slow
// answers { ok: false } and never fails the page. Only the fields named here leave this file; the
// providers' answers carry more (the Neon owner's email, for one), which is dropped.

const TIMEOUT_MS = 4000;

async function getJson(url, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
const str = v => (typeof v === 'string' && v ? v : null);

// Neon: this billing period's compute and active time, data moved, and the default branch's size.
// NEON_PROJECT_ID names the project (Settings > General in the Neon console).
async function neon(env) {
  const key = env.NEON_API_KEY;
  const project = env.NEON_PROJECT_ID;
  if (!key || !project || !/^[a-z0-9-]{1,64}$/.test(project)) return null;
  try {
    const base = `https://console.neon.tech/api/v2/projects/${project}`;
    const [p, b] = await Promise.all([getJson(base, key), getJson(`${base}/branches`, key)]);
    const pr = (p && p.project) || {};
    const main = ((b && b.branches) || []).find(x => x && x.default) || null;
    return {
      ok: true,
      computeHours: num(pr.compute_time_seconds) === null ? null : pr.compute_time_seconds / 3600,
      activeHours: num(pr.active_time_seconds) === null ? null : pr.active_time_seconds / 3600,
      transferBytes: num(pr.data_transfer_bytes),
      writtenBytes: num(pr.written_data_bytes),
      storageBytes: main ? num(main.logical_size) : null,
      periodStart: str(pr.consumption_period_start),
      periodEnd: str(pr.consumption_period_end),
      lastActive: str(pr.compute_last_active_at)
    };
  } catch (e) {
    console.error(`Admin: Neon API read failed: ${e.message}`);
    return { ok: false };
  }
}

// Vercel: the current production deployment. VERCEL_PROJECT_ID and VERCEL_TEAM_ID come from
// .vercel/project.json (projectId, orgId).
async function vercel(env) {
  const token = env.VERCEL_API_TOKEN;
  const project = env.VERCEL_PROJECT_ID;
  const team = env.VERCEL_TEAM_ID;
  if (!token || !project || !/^[A-Za-z0-9_-]{1,64}$/.test(project) || (team && !/^[A-Za-z0-9_-]{1,64}$/.test(team))) return null;
  try {
    const q = new URLSearchParams({ projectId: project, target: 'production', limit: '1' });
    if (team) q.set('teamId', team);
    const r = await getJson(`https://api.vercel.com/v6/deployments?${q}`, token);
    const d = ((r && r.deployments) || [])[0];
    if (!d) return { ok: true, deploy: null };
    const meta = d.meta || {};
    return {
      ok: true,
      deploy: {
        state: str(d.state) || str(d.readyState),
        createdAt: num(d.created) === null ? null : new Date(d.created).toISOString(),
        commit: str(meta.githubCommitSha) ? meta.githubCommitSha.slice(0, 7) : null,
        message: str(meta.githubCommitMessage) ? meta.githubCommitMessage.split('\n')[0].slice(0, 120) : null
      }
    };
  } catch (e) {
    console.error(`Admin: Vercel API read failed: ${e.message}`);
    return { ok: false };
  }
}

// -> { neon, vercel, tables } for the stats answer. `tableRows` is the store's (null in the fs store).
async function read(env, tableRows) {
  const [n, v, tables] = await Promise.all([
    neon(env),
    vercel(env),
    tableRows().catch(e => { console.error(`Admin: row counts failed: ${e.message}`); return null; })
  ]);
  return { neon: n, vercel: v, tables };
}

module.exports = { read, neon, vercel };
