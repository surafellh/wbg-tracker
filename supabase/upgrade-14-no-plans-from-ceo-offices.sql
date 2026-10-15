-- The CEO and D/CEO offices do not record plans, so the reminders no longer ask them for one.
-- Run once in the Supabase SQL Editor, after upgrade-3. Safe to run again. (Their data is kept; only the reminders skip them.)

create or replace function public.wbg_reminder_texts() returns table (unit_id text, unit_name text, level int, message text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_mon date := public.wbg_monday(); v_today date := (now() at time zone 'Africa/Addis_Ababa')::date;
  u record; p record; v_next int; v_lines text[]; v_lvl int; v_txt text; n int;
begin
  for u in select * from public.units where id not in ('ceo','d-ceo') order by type, sort_order, name loop
    v_lines := '{}'; v_lvl := 0;
    select * into p from public.plans where id = to_char(v_mon,'YYYY-MM-DD') || '_' || u.id;
    if not found or coalesce(jsonb_array_length(p.tasks), 0) = 0 then
      v_lines := v_lines || 'No plan has been entered for this week.'::text; v_lvl := 2;
    else
      -- overdue
      select count(*), string_agg('  • ' || (x->>'title') || ' (due ' || (x->>'due') || ')', E'\n') into n, v_txt
        from jsonb_array_elements(p.tasks) x
        where coalesce(x->>'kind','Task') <> 'KPI / OKR' and coalesce(x->>'status','') <> 'Done' and coalesce(x->>'due','') <> '' and (x->>'due')::date < v_today;
      if n > 0 then v_lines := v_lines || (n || ' task(s) past the due date:' || E'\n' || v_txt); v_lvl := 2; end if;
      -- due in the next 2 days
      select count(*), string_agg('  • ' || (x->>'title') || ' (due ' || (x->>'due') || ')', E'\n') into n, v_txt
        from jsonb_array_elements(p.tasks) x
        where coalesce(x->>'kind','Task') <> 'KPI / OKR' and coalesce(x->>'status','') <> 'Done' and coalesce(x->>'due','') <> '' and (x->>'due')::date between v_today and v_today + 2;
      if n > 0 then v_lines := v_lines || (n || ' task(s) due in the next 2 days:' || E'\n' || v_txt); v_lvl := greatest(v_lvl, 1); end if;
      -- blocked 5+ days
      select count(*), string_agg('  • ' || (x->>'title') || ' (blocked since ' || (x->>'blockedSince') || ')', E'\n') into n, v_txt
        from jsonb_array_elements(p.tasks) x
        where x->>'status' = 'Blocked' and coalesce(x->>'blockedSince','') <> '' and (x->>'blockedSince')::date <= v_today - 5;
      if n > 0 then v_lines := v_lines || (n || ' task(s) blocked for 5+ days. Please escalate:' || E'\n' || v_txt); v_lvl := 2; end if;
      -- no status
      select count(*) into n from jsonb_array_elements(p.tasks) x where coalesce(x->>'kind','Task') <> 'KPI / OKR' and coalesce(x->>'status','') = '';
      if n > 0 then v_lines := v_lines || (n || ' task(s) have no status.'); v_lvl := greatest(v_lvl, 1); end if;
    end if;
    -- Thursday to Sunday: next week's plan missing
    if extract(isodow from v_today) >= 4 then
      select coalesce(jsonb_array_length(tasks), 0) into v_next from public.plans where id = to_char(v_mon + 7,'YYYY-MM-DD') || '_' || u.id;
      if coalesce(v_next, 0) = 0 then v_lines := v_lines || 'Next week''s plan has not been entered yet.'::text; v_lvl := greatest(v_lvl, 1); end if;
    end if;
    if array_length(v_lines, 1) > 0 then
      unit_id := u.id; unit_name := u.name; level := v_lvl;
      message := 'WBG weekly plan reminder · ' || u.name || ' · week of ' || to_char(v_mon, 'DD Mon YYYY') || E'\n\n' || array_to_string(v_lines, E'\n\n')
                 || E'\n\nPlease update the WBG Weekly Activity Tracker. · Group Strategy Office';
      return next;
    end if;
  end loop;
end $$;
revoke all on function public.wbg_reminder_texts() from public, anon, authenticated;
