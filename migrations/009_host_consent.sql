-- R34 and R6, decision 024: what a host agreed to at sign-in.
--
-- news_opt_in_at: when the host ticked "Tell me about next season"; null = not opted in (turning
--   it off sets it back to null). Nobody is ever emailed on a null.
-- terms_version, terms_accepted_at: the newest version of the Terms and Privacy Policy the host
--   signed in under, and when they first did. Null = never signed in with the notice shown.
--
-- Adds only, all nullable: the previous code ignores them and a rollback needs no database change.
--
-- Who to write to:  select email from hosts where news_opt_in_at is not null

alter table hosts add column if not exists news_opt_in_at timestamptz;

alter table hosts add column if not exists terms_version text;

alter table hosts add column if not exists terms_accepted_at timestamptz;
