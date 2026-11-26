-- R39: recent changes (decision 025 section 7). One row per score or squares operation, and per
-- helper added, joined, changed or removed: who (helper_id null = the host) and a short line of
-- text. `label` is the helper's name copied at write time, so it outlives the helper's row; there is
-- no foreign key on helper_id for the same reason. The store keeps the newest 50 per board, and
-- rows go with the board. Writing is best effort: without this table nothing fails and the host's
-- list is empty. Adds only: the previous code never touches this table.

create table if not exists board_changes (
  id        bigint generated always as identity primary key,
  game_id   uuid not null references games(id) on delete cascade,
  at        timestamptz not null default now(),
  helper_id uuid,
  label     text check (char_length(label) <= 10),
  text      text not null check (char_length(text) <= 120)
);
create index if not exists board_changes_game_idx on board_changes (game_id, at desc);
