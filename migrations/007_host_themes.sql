-- R33, decision 021: one color theme per host. `host_key` is the host's id in accounts mode and
-- 'site' in password mode, where there is one host and no hosts row. A host with no row has the
-- default theme. No foreign key, so it works on a database without migration 002. Adds only: the
-- previous code never touches this table.

create table if not exists host_themes (
  host_key   text primary key,
  theme      text not null,
  updated_at timestamptz not null default now()
);
