// The one source of the app version: package.json. Never typed in by hand.
// Preview and dev builds on Vercel append the short commit hash
// (1.0.0+a1b2c3d); production and the LAN build show the plain version.
'use strict';

const { version } = require('../package.json');

function appVersion() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  const isProd = process.env.VERCEL_ENV === 'production';
  return sha && !isProd ? `${version}+${sha.slice(0, 7)}` : version;
}

module.exports = { appVersion };
