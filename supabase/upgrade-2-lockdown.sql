-- WBG Weekly Activity Tracking · Upgrade 2 of 2 (LOCKDOWN)
-- Run this ONLY AFTER the new version of the site is live and you have set the approver code and unit PINs.
-- From here on, nobody can change data directly with the public key: every change goes through the
-- PIN-checked functions from upgrade-1-safe.sql. The OLD site will no longer be able to save.
-- Safe to re-run. To undo it, run the "open access" block at the end (commented out).

drop policy if exists "open access" on public.units;
drop policy if exists "open access" on public.plans;
drop policy if exists "open access" on public.activity;

drop policy if exists "read" on public.units;
drop policy if exists "read" on public.plans;
drop policy if exists "read" on public.activity;
create policy "read" on public.units    for select to anon, authenticated using (true);
create policy "read" on public.plans    for select to anon, authenticated using (true);
create policy "read" on public.activity for select to anon, authenticated using (true);

-- Belt and braces: remove direct write rights on every tracker table.
revoke insert, update, delete, truncate on public.units, public.plans, public.activity, public.row_history,
  public.change_requests, public.app_config, public.unit_pins, public.app_secrets, public.auth_failures
  from anon, authenticated;
revoke select on public.unit_pins, public.app_secrets, public.auth_failures from anon, authenticated;

-- To go back to the open trial setup (not recommended):
-- grant insert, update, delete on public.units, public.plans, public.activity to anon, authenticated;
-- create policy "open access" on public.units    for all to anon, authenticated using (true) with check (true);
-- create policy "open access" on public.plans    for all to anon, authenticated using (true) with check (true);
-- create policy "open access" on public.activity for all to anon, authenticated using (true) with check (true);
