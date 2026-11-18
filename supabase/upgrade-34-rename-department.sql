-- Rename a department of a unit and carry it over everywhere it is stored: the unit's list, people, invites, role requests,
-- pending change requests and the tasks of every saved plan of that unit. Plans keep their old version in plan history.
create or replace function public.wbg_rename_department(p_unit text, p_old text, p_new text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare a jsonb := public.wbg_auth(); v_role text := a->>'role'; v_m boolean := public.wbg_perm_on(); v_new text := trim(coalesce(p_new,'')); v_deps jsonb; v_plans int := 0; v_ppl int := 0;
begin
  if v_m then
    if not public.wbg_can(a, 'edit_departments', p_unit) then return jsonb_build_object('error','not_allowed'); end if;
  else
    if v_role is null or v_role not in ('super_admin','planning','leader') then return jsonb_build_object('error','not_allowed'); end if;
    if v_role <> 'super_admin' and a->>'unit' is distinct from p_unit then return jsonb_build_object('error','not_allowed'); end if;
  end if;
  if v_new = '' or length(v_new) > 60 then return jsonb_build_object('error','bad_request'); end if;
  select departments into v_deps from public.units where id = p_unit;
  if not found then return jsonb_build_object('error','not_found'); end if;
  if not (v_deps ? p_old) then return jsonb_build_object('error','not_found'); end if;
  if v_new = p_old then return jsonb_build_object('ok', true, 'changed', 0); end if;
  if exists (select 1 from jsonb_array_elements_text(v_deps) x where lower(x) = lower(v_new) and x <> p_old) then return jsonb_build_object('error','already_exists'); end if;

  update public.units set departments = (select jsonb_agg(case when x = p_old then v_new else x end order by o) from jsonb_array_elements_text(departments) with ordinality t(x, o)) where id = p_unit;
  update public.profiles set departments = (select jsonb_agg(case when x = p_old then v_new else x end order by o) from jsonb_array_elements_text(departments) with ordinality t(x, o)) where unit_id = p_unit and departments ? p_old;
  get diagnostics v_ppl = row_count;
  update public.invites set departments = (select jsonb_agg(case when x = p_old then v_new else x end order by o) from jsonb_array_elements_text(departments) with ordinality t(x, o)) where unit_id = p_unit and departments ? p_old;
  update public.role_requests set departments = (select jsonb_agg(case when x = p_old then v_new else x end order by o) from jsonb_array_elements_text(departments) with ordinality t(x, o)) where unit_id = p_unit and departments ? p_old;
  update public.role_requests set from_departments = (select jsonb_agg(case when x = p_old then v_new else x end order by o) from jsonb_array_elements_text(from_departments) with ordinality t(x, o)) where from_unit = p_unit and from_departments ? p_old;
  update public.change_requests set dept = v_new where unit_id = p_unit and dept = p_old;
  update public.plans set tasks = (select coalesce(jsonb_agg(case when e->>'dept' = p_old then jsonb_set(e, '{dept}', to_jsonb(v_new)) else e end order by o), '[]'::jsonb) from jsonb_array_elements(tasks) with ordinality t(e, o))
   where unit_id = p_unit and jsonb_typeof(tasks) = 'array' and exists (select 1 from jsonb_array_elements(tasks) e where e->>'dept' = p_old);
  get diagnostics v_plans = row_count;
  perform public.wbg_add_activity(trim(coalesce(a->>'name','')), p_unit, null, jsonb_build_object('action','lists','summary','Renamed department "' || p_old || '" to "' || v_new || '" (' || v_plans || ' weekly plans, ' || v_ppl || ' people updated)'));
  return jsonb_build_object('ok', true, 'plans', v_plans, 'people', v_ppl);
end $$;
revoke all on function public.wbg_rename_department(text, text, text) from public, anon;
grant execute on function public.wbg_rename_department(text, text, text) to authenticated;
