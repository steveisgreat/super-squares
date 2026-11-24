// Maps a provider's team abbreviation to OUR form (public/teams.js: lowercase,
// e.g. 'wsh', 'gb', 'lv'). Providers disagree on a few teams (Washington is WSH
// at ESPN and WAS elsewhere), so each league has an alias table. An abbreviation
// we do not recognize is passed through lowercased rather than dropped, so a
// game never vanishes silently; callers can test it with isKnown().
'use strict';

const TeamData = require('../../public/teams.js');

const ALIASES = {
  nfl: {
    was: 'wsh', jac: 'jax', la: 'lar', lvr: 'lv', oak: 'lv', sd: 'lac', stl: 'lar',
    tam: 'tb', nwe: 'ne', gnb: 'gb', kan: 'kc', nor: 'no', sfo: 'sf'
  },
  nba: {
    was: 'wsh', gsw: 'gs', sas: 'sa', nyk: 'ny', nop: 'no', bro: 'bkn', uta: 'utah', cho: 'cha'
  }
};

function toOurAbbr(raw, league) {
  if (raw === null || raw === undefined || raw === '') return null;
  const a = String(raw).trim().toLowerCase();
  const table = ALIASES[league] || {};
  return Object.prototype.hasOwnProperty.call(table, a) ? table[a] : a;
}

function knownAbbrs(league) {
  const set = { nfl: TeamData.NFL_TEAMS, nba: TeamData.NBA_TEAMS }[league] || [];
  return set.map(t => t.abbr);
}

function isKnown(abbr, league) {
  return knownAbbrs(league).includes(abbr);
}

// Converts an ISO timestamp to the America/New_York calendar date (YYYY-MM-DD).
function etDateOf(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

module.exports = { toOurAbbr, knownAbbrs, isKnown, etDateOf, ALIASES };
