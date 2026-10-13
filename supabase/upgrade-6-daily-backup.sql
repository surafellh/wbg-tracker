-- WBG Weekly Activity Tracking · Upgrade 6: daily backup inside the database
-- Keeps one full copy of units, plans, support requests, feedback, corrective actions and people for each of the last 30 days.
-- On top of the copy kept on every change (row_history). Group Strategy can download any day from the Users tab.
-- Needs upgrade-5 first. Safe to re-run.
--
-- SETUP: Supabase > Database > Extensions > turn on pg_cron. Then run this whole file.
-- NOTE: backups kept in the same database protect against mistakes, not against losing the whole project.
-- Also download a full backup file from the site every week (Units tab), or upgrade the Supabase plan for off-site daily backups.

create table if not exists public.daily_backups (
  day        date primary key,
  created_at timestamptz not null default now(),
  data       jsonb not null
);
alter table public.daily_backups enable row level security;    -- no policy: only the functions below

create or replace function public.wbg_daily_backup() returns int
language plpgsql security definer set search_path = public as $$
declare v_day date := (now() at time zone 'Africa/Addis_Ababa')::date;
begin
  insert into public.daily_backups (day, data)
  select v_day, jsonb_build_object(
    'savedAt', now(),
    'units', coalesce((select jsonb_agg(to_jsonb(x)) from public.units x), '[]'::jsonb),
    'plans', coalesce((select jsonb_agg(to_jsonb(x)) from public.plans x), '[]'::jsonb),
    'support', coalesce((select jsonb_agg(to_jsonb(x)) from public.support_requests x), '[]'::jsonb),
    'feedback', coalesce((select jsonb_agg(to_jsonb(x)) from public.feedback x), '[]'::jsonb),
    'actions', coalesce((select jsonb_agg(to_jsonb(x)) from public.corrective_actions x), '[]'::jsonb),
    'profiles', coalesce((select jsonb_agg(to_jsonb(x)) from public.profiles x), '[]'::jsonb))
  on conflict (day) do update set data = excluded.data, created_at = now();
  delete from public.daily_backups where day < v_day - 30;
  return (select count(*) from public.daily_backups)::int;
end $$;

-- Group Strategy: list the available days, and read one.
create or replace function public.wbg_admin_backups() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.wbg_is_approver(public.wbg_auth()) then return jsonb_build_object('error','not_allowed'); end if;
  return jsonb_build_object('ok', true, 'days', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'at', created_at, 'bytes', pg_column_size(data)) order by day desc) from public.daily_backups), '[]'::jsonb));
end $$;
create or replace function public.wbg_admin_get_backup(p_day date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.wbg_is_approver(public.wbg_auth()) then return jsonb_build_object('error','not_allowed'); end if;
  return coalesce((select jsonb_build_object('ok', true, 'day', day, 'data', data) from public.daily_backups where day = p_day), jsonb_build_object('error','not_found'));
end $$;

revoke all on function public.wbg_daily_backup(), public.wbg_admin_backups(), public.wbg_admin_get_backup(date) from public, anon, authenticated;
grant execute on function public.wbg_admin_backups(), public.wbg_admin_get_backup(date) to authenticated;

select public.wbg_daily_backup();      -- take the first copy now

-- Schedule: every night at 21:00 UTC (00:00 in Addis Ababa). If pg_cron is not on, turn it on first (see top).
select cron.schedule('wbg-daily-backup', '0 21 * * *', 'select public.wbg_daily_backup()');
-- To stop it:  select cron.unschedule('wbg-daily-backup');
