-- Upgrade 21: undo only your own changes, with a limit.
-- Before: any chief, planning head or manager of a unit could put a plan back to any earlier copy, wiping other people's later work.
-- Now: Group Strategy can undo anything. Everyone else can undo only changes that are all their own (this one and every later one on the plan),
-- and not more than 5 steps back. Otherwise the database answers others_changed or too_far. Redo = undo the undo (it is a change of your own).
-- Safe to run more than once.

create or replace function public.wbg_restore_version(p_auth jsonb, p_history_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); v_role text := p_auth->>'role'; v_h public.row_history%rowtype; v_name text := trim(coalesce(p_auth->>'name',''));
        r jsonb; v_cur public.plans%rowtype; v_tasks jsonb; v_later int; v_others int;
begin
  if v_role is null or v_role in ('staff','executive') then return jsonb_build_object('error','not_allowed'); end if;
  select * into v_h from public.row_history where id = p_history_id;
  if not found then return jsonb_build_object('error','not_found'); end if;
  r := v_h.old_row;
  if v_h.tbl = 'plans' then
    if v_role <> 'super_admin' and coalesce(p_auth->>'unit','') <> (r->>'unit_id') then return jsonb_build_object('error','not_allowed'); end if;
    if v_role <> 'super_admin' and (r->>'week')::date < public.wbg_monday() then return jsonb_build_object('error','not_allowed'); end if;
    -- Group Strategy may undo anything. Everyone else may only undo what they did themselves: every change from this copy onward
    -- (this one and the later ones) must be theirs, and it may not reach back more than 5 steps.
    if v_role <> 'super_admin' then
      select count(*), count(*) filter (where changed_by is distinct from v_name) into v_later, v_others
        from public.row_history where tbl = v_h.tbl and row_id = v_h.row_id and op <> 'SNAPSHOT' and id >= v_h.id;
      if v_others > 0 then return jsonb_build_object('error','others_changed'); end if;
      if v_later > 5 then return jsonb_build_object('error','too_far'); end if;
    end if;
    select * into v_cur from public.plans where id = r->>'id';
    v_tasks := coalesce(r->'tasks','[]'::jsonb);
    if v_role = 'manager' then v_tasks := public.wbg__merge_scope(p_auth, r->>'unit_id', v_cur.tasks, v_tasks); end if;
    insert into public.plans (id, week, unit_id, tasks, wins, blockers, asks, updated_at, updated_by, source)
    values (r->>'id', (r->>'week')::date, r->>'unit_id', v_tasks, coalesce(r->>'wins',''), coalesce(r->>'blockers',''), coalesce(r->>'asks',''),
            now(), v_name, 'Restored copy from ' || to_char(v_h.changed_at at time zone 'Africa/Addis_Ababa', 'YYYY-MM-DD HH24:MI'))
    on conflict (id) do update set tasks = excluded.tasks, wins = case when v_role = 'manager' then public.plans.wins else excluded.wins end,
      blockers = case when v_role = 'manager' then public.plans.blockers else excluded.blockers end, asks = case when v_role = 'manager' then public.plans.asks else excluded.asks end,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by, source = excluded.source;
    perform public.wbg_add_activity(v_name, r->>'unit_id', (r->>'week')::date, jsonb_build_object('action','restore',
      'summary', 'Restored the plan to the copy saved before ' || to_char(v_h.changed_at at time zone 'Africa/Addis_Ababa', 'DD Mon YYYY HH24:MI') || ' (EAT)' || case when v_role = 'manager' then ' (own departments only)' else '' end));
  elsif v_h.tbl = 'units' then
    if v_role <> 'super_admin' then return jsonb_build_object('error','not_allowed'); end if;
    insert into public.units (id, name, type, sort_order, departments, people)
    values (r->>'id', r->>'name', coalesce(r->>'type','Business unit'), coalesce((r->>'sort_order')::int, 99), coalesce(r->'departments','[]'::jsonb), coalesce(r->'people','[]'::jsonb))
    on conflict (id) do update set name = excluded.name, type = excluded.type, sort_order = excluded.sort_order, departments = excluded.departments, people = excluded.people;
    perform public.wbg_add_activity(v_name, r->>'id', null, jsonb_build_object('action','restore', 'summary', 'Restored unit "' || (r->>'name') || '"'));
  end if;
  return jsonb_build_object('ok', true);
end $$;
