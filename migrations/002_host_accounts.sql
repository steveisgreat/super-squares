-- R2, decision 012: host accounts. Adds only, so the previous code runs
-- against this schema and a rollback needs no database change.
--
-- games.owner_id is a column and never a key inside doc: every guest reads
-- doc, and hosts PUT the whole doc. It stays nullable because boards made
-- before accounts (or with sign-in off) have no owner.

create table if not exists hosts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  session_version int not null default 1,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists login_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  token_hash bytea not null unique,
  code_hash bytea not null,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create index if not exists login_requests_email_idx on login_requests (email, created_at);

create index if not exists login_requests_created_idx on login_requests (created_at);

alter table games add column if not exists owner_id uuid references hosts(id);

create index if not exists games_owner_idx on games (owner_id, updated_at desc);
