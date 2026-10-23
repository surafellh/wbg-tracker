-- Upgrade 20: any business unit or function can log a support request.
-- Before: only Group Strategy or the lead of the RECEIVING function could save a request, so a unit asking for help could not log it.
-- Now:
--   * Anyone who works in a unit (chief / GM, planning head, manager, employee) can log a request to any function. The system records their unit.
--   * They can see their unit's requests and change them while the status is still Open (the function's response fields stay locked).
--   * The receiving function's lead and Group Strategy still answer and change everything, as before.
-- Safe to run more than once.

alter table public.support_requests add column if not exists requester_unit text not null default '';

-- who can read: as before, plus the unit that asked
alter policy "read" on public.support_requests using (
  public.wbg_unit_read(function_id)
  or (requester_unit <> '' and public.wbg_auth()->>'role' in ('leader','planning','manager','staff') and public.wbg_auth()->>'unit' = requester_unit)
);

create or replace function public.wbg_save_support(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); v_fn text := coalesce(p_row->>'function',''); v_id text := nullif(p_row->>'id',''); v_name text := trim(coalesce(p_auth->>'name',''));
        v_ref text; v_old public.support_requests%rowtype; v_priv boolean; v_ru text; v_status text;
begin
  if v_fn = '' then return jsonb_build_object('error','bad_request'); end if;
  if v_id is not null then select * into v_old from public.support_requests where id = v_id; end if;
  v_priv := public.wbg_is_approver(p_auth) or public.wbg_unit_lead(p_auth, coalesce(v_old.function_id, v_fn));
  if v_old.id is null then
    -- new request: Group Strategy / the receiving function's lead, or any member of a unit logging its own request
    if not v_priv and not public.wbg_unit_lead(p_auth, v_fn) and not coalesce(p_auth->>'role' in ('leader','planning','manager','staff') and coalesce(p_auth->>'unit','') <> '', false) then
      return jsonb_build_object('error','not_allowed'); end if;
  else
    if v_old.function_id <> v_fn and not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
    if not v_priv then
      -- the asking unit may edit its own request only while it is still Open
      if not (v_old.requester_unit <> '' and v_old.requester_unit = coalesce(p_auth->>'unit','') and p_auth->>'role' in ('leader','planning','manager','staff')) then
        return jsonb_build_object('error','not_allowed'); end if;
      if v_old.status <> 'Open' then return jsonb_build_object('error','locked'); end if;
    end if;
  end if;
  -- the asking unit: members of a unit are always recorded under their own unit; Group Strategy / the function lead may name one
  if not v_priv then v_ru := coalesce(p_auth->>'unit','');
  else v_ru := coalesce(nullif(p_row->>'requesterUnit',''), v_old.requester_unit, ''); end if;
  if v_old.id is null then
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    v_ref := coalesce(nullif(p_row->>'ref',''), 'SR-' || lpad(nextval('public.support_ref_seq')::text, 4, '0'));
    insert into public.support_requests (id, ref, function_id, requester, requester_unit, category, description, priority, date_requested, status, response_date,
      action_taken, responded_by, evidence_ref, follow_up, remarks, created_by, updated_by)
    values (v_id, v_ref, v_fn, coalesce(p_row->>'requester',''), v_ru, coalesce(p_row->>'category',''), coalesce(p_row->>'description',''),
      coalesce(nullif(p_row->>'priority',''),'Normal'), coalesce(nullif(p_row->>'requested','')::date, current_date),
      case when v_priv then coalesce(nullif(p_row->>'status',''),'Open') else 'Open' end,
      case when v_priv then nullif(p_row->>'responded','')::date else null end,
      case when v_priv then coalesce(p_row->>'action','') else '' end, case when v_priv then coalesce(p_row->>'respondedBy','') else '' end,
      case when v_priv then coalesce(p_row->>'evidence','') else '' end, case when v_priv then coalesce((p_row->>'followUp')::boolean,false) else false end,
      coalesce(p_row->>'remarks',''), v_name, v_name);
  else
    v_ref := v_old.ref;
    if v_priv then
      update public.support_requests set function_id = v_fn, requester = coalesce(p_row->>'requester',''), requester_unit = v_ru, category = coalesce(p_row->>'category',''),
        description = coalesce(p_row->>'description',''), priority = coalesce(nullif(p_row->>'priority',''),'Normal'),
        date_requested = nullif(p_row->>'requested','')::date, status = coalesce(nullif(p_row->>'status',''),'Open'),
        response_date = nullif(p_row->>'responded','')::date, action_taken = coalesce(p_row->>'action',''), responded_by = coalesce(p_row->>'respondedBy',''),
        evidence_ref = coalesce(p_row->>'evidence',''), follow_up = coalesce((p_row->>'followUp')::boolean,false), remarks = coalesce(p_row->>'remarks',''),
        updated_by = v_name, updated_at = now()
      where id = v_id;
    else
      -- asking unit: request details only; status and response stay as the function left them
      update public.support_requests set function_id = v_fn, requester = coalesce(p_row->>'requester',''), category = coalesce(p_row->>'category',''),
        description = coalesce(p_row->>'description',''), priority = coalesce(nullif(p_row->>'priority',''),'Normal'),
        date_requested = coalesce(nullif(p_row->>'requested','')::date, v_old.date_requested), remarks = coalesce(p_row->>'remarks',''),
        updated_by = v_name, updated_at = now()
      where id = v_id;
    end if;
  end if;
  perform public.wbg_add_activity(v_name, v_fn, null, jsonb_build_object('action','support','summary',
    (case when v_old.id is null then 'Logged support request ' else 'Updated support request ' end) || v_ref || ' from ' || coalesce(p_row->>'requester','') || ' (' || coalesce(nullif(p_row->>'status',''),'Open') || ')'));
  return jsonb_build_object('ok', true, 'id', v_id, 'ref', v_ref);
end $$;
grant execute on function public.wbg_save_support(jsonb, jsonb) to authenticated;
