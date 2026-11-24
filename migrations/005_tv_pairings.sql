-- R23: TV pairing. A TV opening /tv gets a short code (shown) and a secret token (kept in
-- the TV's storage); only the sha256 of the token is stored. The host enters the code,
-- which sets game_id/owner_id and retires the code (code -> null). Expiry is judged at
-- read time (15 min unpaired, 24 h since paired_at); expired rows are deleted when a new
-- pairing is created. Adds only: the previous code never touches this table.

create table if not exists tv_pairings (
  token_hash text primary key,
  code       text,
  game_id    text,
  owner_id   uuid,
  created_at timestamptz not null default now(),
  paired_at  timestamptz
);
create unique index if not exists tv_pairings_code_key on tv_pairings (code) where code is not null;
create index if not exists tv_pairings_owner_idx on tv_pairings (owner_id);
