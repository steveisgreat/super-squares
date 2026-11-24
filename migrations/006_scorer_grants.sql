-- R24: scorer-phone hand-off (decision 018). One row per one-time QR code; when a phone uses
-- it, the row becomes that phone's grant to enter scores on one board. Only sha256 hashes are
-- stored. `host_version` is the owner's hosts.session_version when the code was made (null in
-- password and off modes), so "sign out everywhere" ends the grant. Expiry is judged at read
-- time (5 minutes unused, 24 hours from used_at); expired rows are deleted when a new code is
-- made. Adds only: the previous code never touches this table.

create table if not exists scorer_grants (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references games(id) on delete cascade,
  host_version int,
  token_hash   text not null unique,
  session_hash text unique,
  created_at   timestamptz not null default now(),
  used_at      timestamptz
);
create index if not exists scorer_grants_game_idx on scorer_grants (game_id);
