-- R37: helpers (decision 025). One row per helper a host adds to a board: a one-time code that
-- becomes one phone's access to the jobs ticked here. Only sha256 hashes are stored. `host_version`
-- is the owner's hosts.session_version when the helper was added (null in password and off modes),
-- so "sign out everywhere" ends the job. `label` is for the host's list and never authorizes
-- anything. Lifetimes are judged at read time (the code at token_expires_at; the job 180 days from
-- used_at, or 24 hours after a finished board was last saved). Adds only: the previous code never
-- touches this table, and scorer_grants (006) stays in place, unused.

create table if not exists helpers (
  id               uuid primary key default gen_random_uuid(),
  game_id          uuid not null references games(id) on delete cascade,
  host_version     int,
  label            text not null check (char_length(label) between 1 and 10),
  can_score        boolean not null default false,
  can_squares      boolean not null default false,
  token_hash       text unique,          -- null once used
  token_expires_at timestamptz,
  session_hash     text unique,          -- the phone's cookie, set on use
  created_at       timestamptz not null default now(),
  used_at          timestamptz
);
create index if not exists helpers_game_idx on helpers (game_id);
