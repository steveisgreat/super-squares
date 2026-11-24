// The one email the app sends: a sign-in link and code (decision 012).
// One fetch to Resend's API, so there is no mail dependency.
'use strict';

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10000;

// `link` and `code` are made by the server, so nothing a visitor typed is in
// the message and there is nothing to escape.
function loginMessage(link, code) {
  const shown = `${code.slice(0, 4)} ${code.slice(4)}`;
  return {
    subject: 'Sign in to Super-Squares',
    text: [
      'Sign in to Super-Squares with this link:',
      '',
      link,
      '',
      `Or enter this code where you asked to sign in: ${shown}`,
      '',
      'Both work once and expire in 15 minutes. Never share them with anyone.',
      'If you did not ask to sign in, ignore this email.'
    ].join('\n'),
    html: [
      '<p>Sign in to Super-Squares:</p>',
      `<p><a href="${link}">Sign in</a></p>`,
      '<p>Or enter this code where you asked to sign in:</p>',
      `<p style="font-size:24px;letter-spacing:2px"><strong>${shown}</strong></p>`,
      '<p>Both work once and expire in 15 minutes. Never share them with anyone.<br>',
      'If you did not ask to sign in, ignore this email.</p>'
    ].join('\n')
  };
}

// Resolves when the mail is handed over and throws when it isn't. Without
// RESEND_API_KEY the link and code go to the server console, which is how a
// developer signs in locally. Never on Vercel: auth.js treats the missing key
// there as a broken setup, and this refuses too, so a code can't reach a log.
async function sendLoginEmail({ to, link, code, requestId }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    if (process.env.VERCEL) throw new Error('RESEND_API_KEY is not set');
    console.log(`\n  Sign-in for ${to}\n  Link: ${link}\n  Code: ${code}\n`);
    return;
  }
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `login-${requestId}`
    },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], ...loginMessage(link, code) }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
  });
  // Status only: the response body can repeat the address.
  if (!res.ok) throw new Error(`Resend answered ${res.status}`);
}

module.exports = { sendLoginEmail, loginMessage };
