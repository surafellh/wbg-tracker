-- Upgrade 15: half-day grace for finishing the week that just ended.
-- Weeks still run Saturday to Friday. But until Saturday 12:00 noon (Addis Ababa) the week that just ended can still be
-- updated directly; after that, changes to it need approval ("Request update"). Run in the Supabase SQL Editor (safe to run again).

-- 1) wbg_monday() goes back to the real start of the current week (undoes the earlier 14-hour shift).
create or replace function public.wbg_monday() returns date
language sql stable as $$
  select case when d >= date '2026-10-10' then d - ((extract(dow from d)::int + 1) % 7)
              else date_trunc('week', d)::date end
  from (select (now() at time zone 'Africa/Addis_Ababa')::date as d) x
$$;

-- 2) The week up to which direct saving is allowed: the previous week until Saturday 12:00, otherwise the current week.
create or replace function public.wbg_lock_monday() returns date
language sql stable as $$
  select case when extract(dow from (now() at time zone 'Africa/Addis_Ababa')) = 6
               and extract(hour from (now() at time zone 'Africa/Addis_Ababa')) < 12
              then public.wbg_monday() - 7 else public.wbg_monday() end
$$;
grant execute on function public.wbg_lock_monday() to anon, authenticated;

-- 3) The save function checks the lock week instead of the current week.
do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'wbg_save_plan';
  if d like '%public.wbg_monday()%' then
    execute replace(d, 'public.wbg_monday()', 'public.wbg_lock_monday()');
  end if;
end $$;
