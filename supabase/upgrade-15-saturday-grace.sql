-- Upgrade 15: a grace period at the end of the week.
-- The week now rolls over on Saturday at 2 PM Addis Ababa time instead of at midnight, so people can still
-- update the week that just ended on Saturday morning. Run in the Supabase SQL Editor (safe to run again).
create or replace function public.wbg_monday() returns date
language sql stable as $$
  select case when d >= date '2026-10-10' then d - ((extract(dow from d)::int + 1) % 7)
              else date_trunc('week', d)::date end
  from (select ((now() - interval '14 hours') at time zone 'Africa/Addis_Ababa')::date as d) x
$$;
