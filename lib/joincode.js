// Join codes (R22, decision 016): six characters, no 0/O/1/I/L, so a code read
// aloud or squinted at on a TV survives. Generated here and nowhere else.
'use strict';

const crypto = require('crypto');

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const LENGTH = 6;
const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
// The path form server.js serves index.html for (vercel.json carries the same
// pattern; test-joincode.js keeps the two equal).
const PATH_RE = /^\/[2-9A-HJKMNP-Za-hjkmnp-z]{6}$/;

function generate() {
  let code = '';
  for (let i = 0; i < LENGTH; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return code;
}

// Uppercase and trimmed, or null when it can't be a code.
function normalize(input) {
  if (typeof input !== 'string') return null;
  const code = input.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

module.exports = { ALPHABET, LENGTH, CODE_RE, PATH_RE, generate, normalize };
