-- R45c: where hosts heard about us (decision 027 section 5). `src` is the tag of an ad or video link
-- (`?src=<tag>`), kept by the browser and sent with the sign-in request like `ref` (008); it is copied
-- to hosts.src only when the account is first created. `heard_from` is the host's answer to the one
-- optional question after signing in, `heard_other` the short text for "something else", and
-- `heard_at` when they answered or skipped (null: not asked yet). Adds only: the previous code never
-- reads or writes these columns. Apply before the push that ships R45c (runbook).

alter table login_requests add column if not exists src text;

alter table hosts add column if not exists src text;
alter table hosts add column if not exists heard_from text
  check (heard_from in ('friend', 'search', 'video', 'group', 'ad', 'other', 'skip'));
alter table hosts add column if not exists heard_other text check (char_length(heard_other) <= 80);
alter table hosts add column if not exists heard_at timestamptz;
-- Hosts from before this migration are asked once at their next visit, like a new host: accounts mode
-- is not live yet, so that is only test accounts.
