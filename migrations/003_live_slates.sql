-- R4a part 2, decision 001 section 3: one shared score row per league and ET date.
-- Adds only, so the previous code runs against this schema and a rollback needs no
-- database change.
--
-- checked_at is the throttle: a request that finds it older than 15 s claims the
-- refresh with `update ... where checked_at = <the value it read>`, so exactly one
-- request fetches. fetched_at is the last success. payload holds
-- { provider, games: [LiveGame], switchedAt?, error? }.

create table if not exists live_slates (
  league text not null,
  et_date date not null,
  payload jsonb,
  checked_at timestamptz not null,
  fetched_at timestamptz,
  primary key (league, et_date)
);
