-- R22, decision 016: a short join code per board (the /<code> guest link).
-- Adds only, so the previous code runs against this schema and a rollback needs no
-- database change. Like owner_id it is a column, never inside `doc`. Existing boards
-- stay null until their owner next reads or shares them (no backfill).

alter table games add column if not exists join_code text;
create unique index if not exists games_join_code_key on games (join_code);
