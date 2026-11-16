-- Two Deputy CEOs from 1 Nov 2026: each unit gets a "reports to" value (dceo-bu | dceo-st | ceo).
-- Additive and safe to re-run. Nothing else changes: access rules are the same for both DCEOs.
alter table public.units add column if not exists reports_to text;

update public.units set reports_to = 'dceo-bu' where reports_to is null and type = 'Business unit';
update public.units set reports_to = 'dceo-st' where reports_to is null and id in ('group-strategy-office','pmo','research-development','cto');
update public.units set reports_to = 'ceo'     where reports_to is null;

create or replace function public.wbg_save_unit(p_auth jsonb, p_op text, p_data jsonb, p_summary text DEFAULT ''::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
declare p_auth jsonb := public.wbg_auth(); v_id text := p_data->>'id'; v_name text := trim(coalesce(p_auth->>'name','')); v_role text := p_auth->>'role'; v_m boolean := public.wbg_perm_on();
begin
  if v_id is null or v_id = '' then return jsonb_build_object('error','bad_request'); end if;
  if p_op = 'lists' then
    if v_m then
      if not public.wbg_can(p_auth, 'unit_lists', v_id) then return jsonb_build_object('error','not_allowed'); end if;
      if p_data ? 'departments' and not public.wbg_can(p_auth, 'edit_departments', v_id) then return jsonb_build_object('error','not_allowed'); end if;
    else
      if v_role is null or v_role = 'executive' or v_role = 'staff' then return jsonb_build_object('error','not_allowed'); end if;
      if v_role <> 'super_admin' and p_auth->>'unit' <> v_id then return jsonb_build_object('error','not_allowed'); end if;
      if p_data ? 'departments' and v_role not in ('super_admin','planning','leader') then return jsonb_build_object('error','not_allowed'); end if;
    end if;
    update public.units set departments = coalesce(p_data->'departments', departments), people = coalesce(p_data->'people', people) where id = v_id;
  elsif v_role is distinct from 'super_admin' then
    return jsonb_build_object('error','not_allowed');
  elsif p_op = 'add' then
    insert into public.units (id, name, type, sort_order, reports_to) values (v_id, p_data->>'name', coalesce(p_data->>'type','Business unit'), coalesce((p_data->>'order')::int, 99),
      coalesce(nullif(p_data->>'reports_to',''), case when coalesce(p_data->>'type','Business unit') = 'Business unit' then 'dceo-bu' else 'ceo' end))
    on conflict (id) do nothing;
  elsif p_op = 'update' then
    if p_data ? 'reports_to' and (p_data->>'reports_to') not in ('dceo-bu','dceo-st','ceo') then return jsonb_build_object('error','bad_request'); end if;
    update public.units set name = coalesce(nullif(p_data->>'name',''), name), type = coalesce(nullif(p_data->>'type',''), type), reports_to = coalesce(nullif(p_data->>'reports_to',''), reports_to) where id = v_id;
  elsif p_op = 'remove' then
    delete from public.units where id = v_id;
  else
    return jsonb_build_object('error','bad_request');
  end if;
  perform public.wbg_add_activity(v_name, v_id, null, jsonb_build_object('action', case when p_op = 'lists' then 'lists' else 'unit' end, 'summary', coalesce(nullif(p_summary,''), p_op || ' unit')));
  return jsonb_build_object('ok', true);
end $function$;
