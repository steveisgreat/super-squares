// Gives every board with no owner to one host account (decision 012 §5). Run by
// hand when host accounts go live: once after migration 002, and again after
// the deploy that sets AUTH_MODE=accounts.
//
//   node --env-file=.env.local scripts/assign-owner.js you@example.com
//   node --env-file=.env.local scripts/assign-owner.js you@example.com --apply
//
// Without --apply it only reads and prints counts. A board that already has an
// owner is never touched. Running it twice changes nothing the second time.
'use strict';

const { normalizeEmail } = require('../lib/auth.js');

const USAGE = 'Usage: node --env-file=.env.local scripts/assign-owner.js <email> [--apply]';

async function main(args) {
  const apply = args.includes('--apply');
  const rest = args.filter(a => a !== '--apply');
  const email = rest.length === 1 ? normalizeEmail(rest[0]) : null;
  // A misspelled flag must not fall through to anything.
  if (!email) throw new Error(USAGE);
  if (!process.env.DATABASE_URL) throw new Error(`DATABASE_URL is not set.\n${USAGE}`);

  // Checked here because neon() would print the whole string, password included.
  if (!URL.canParse(process.env.DATABASE_URL)) throw new Error('DATABASE_URL is not a valid URL.');

  const { neon } = require('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);

  const [c] = await sql`
    select
      (select count(*) from games)::int as total,
      (select count(*) from games where owner_id is null)::int as unowned,
      (select count(*) from games g join hosts h on h.id = g.owner_id where h.email = ${email})::int as already,
      (select count(*) from hosts where email = ${email})::int as accounts
  `;
  console.log(`Database:             ${new URL(process.env.DATABASE_URL).hostname}`);
  console.log(`Account:              ${email} (${c.accounts ? 'exists' : 'will be created'})`);
  console.log(`Boards:               ${c.total}`);
  console.log(`  already theirs:     ${c.already}`);
  console.log(`  another host's:     ${c.total - c.already - c.unowned} (not touched)`);
  console.log(`  no owner, to assign: ${c.unowned}`);

  if (!apply) {
    console.log('\nNothing was written. Run it again with --apply to make the change.');
    return;
  }
  // One statement, so the account and the boards change together or not at all.
  const done = await sql`
    with h as (
      insert into hosts (email) values (${email})
      on conflict (email) do update set email = excluded.email
      returning id
    )
    update games set owner_id = (select id from h)
    where owner_id is null
    returning id
  `;
  console.log(`\nAssigned ${done.length} board${done.length === 1 ? '' : 's'} to ${email}.`);
}

main(process.argv.slice(2)).catch(e => {
  // 42P01, 42703: table or column missing.
  console.error(e.code === '42P01' || e.code === '42703'
    ? 'The accounts tables are missing. Apply migrations/002_host_accounts.sql first.'
    : e.message);
  process.exitCode = 1;
});
