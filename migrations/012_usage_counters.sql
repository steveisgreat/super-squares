-- R45a: daily counters for the admin usage page (decision 027). One row per day (UTC) and key, such
-- as `feed:espn`, `feed:fallback`, `mail:sent` or `login:code`. Each outside call adds one in a single
-- upsert, which also keeps the busiest minute of the day: `minute` is the minute being counted,
-- `minute_calls` its count so far, `peak_minute` the most in any one minute. `last_at` is the latest
-- call (the last failover, for `feed:fallback`). Writing is best effort: without this table nothing
-- fails and the admin page shows no service counts. Adds only: the previous code never touches it.

create table if not exists usage_counters (
  day          date        not null,
  key          text        not null check (char_length(key) <= 40),
  calls        int         not null default 0,
  failed       int         not null default 0,
  minute       timestamptz,
  minute_calls int         not null default 0,
  peak_minute  int         not null default 0,
  last_at      timestamptz,
  primary key (day, key)
);
