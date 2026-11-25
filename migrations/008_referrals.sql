-- R13: guest-to-host referrals. `ref` is the join code of the board a guest came from when they
-- chose "Host your own board" (six characters, validated on the server). It rides on the sign-in
-- request and is copied to hosts.referred_by only when the account is first created, so an
-- existing host is never re-attributed. Adds only, both columns nullable: the previous code
-- ignores them and a rollback needs no database change.
--
-- Count sign-ups per board:  select referred_by, count(*) from hosts
--                            where referred_by is not null group by 1 order by 2 desc;

alter table login_requests add column if not exists ref text;

alter table hosts add column if not exists referred_by text;
