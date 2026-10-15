-- Stage 5d: letters from the CEO / DCEO / Group Strategy reach only the head of the unit, and progress updates can be traced to a role.
-- Run once in the Supabase SQL Editor, after upgrade-11. Safe to run again.
--
--   feedback.to_lead   true  -> a letter to the head of the unit: only the unit's chiefs (leader role), the unit's planning head (copied), Group Strategy, the CEO and the DCEO can read it.
--   activity.by_role   the role of the person who made the change, so progress updates can be passed up the hierarchy.

alter table public.feedback add column if not exists to_lead boolean not null default false;
alter table public.activity add column if not exists by_role text not null default '';

drop policy if exists "read" on public.feedback;
create policy "read" on public.feedback for select to authenticated using (
  public.wbg_auth()->>'role' in ('super_admin','executive')
  or (to_lead and public.wbg_auth()->>'role' in ('leader','planning') and public.wbg_auth()->>'unit' = unit_id)
  or (not to_lead and public.wbg_unit_read(unit_id))
);

-- Remember who made each change, by role
create or replace function public.wbg_add_activity(p_by text, p_unit text, p_week date, p_entry jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.activity (id, ts, by_name, unit_id, week, action, summary, details, by_role)
  values (coalesce(nullif(p_entry->>'id',''), md5(random()::text || clock_timestamp()::text)), now(), coalesce(p_by,''), coalesce(p_unit,''), p_week,
          coalesce(p_entry->>'action','save'), coalesce(p_entry->>'summary',''), coalesce(p_entry->'details','[]'::jsonb), coalesce(public.wbg_auth()->>'role',''))
  on conflict (id) do nothing
$$;

-- Feedback can be marked as a letter to the head of the unit
create or replace function public.wbg_save_feedback(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); v_role text := p_auth->>'role'; v_unit text := coalesce(p_row->>'unit',''); v_id text := nullif(p_row->>'id','');
        v_name text := trim(coalesce(p_auth->>'name','')); v_from text := coalesce(nullif(p_row->>'from',''),'Group Strategy');
        v_lead boolean := coalesce((p_row->>'toLead')::boolean, false);
begin
  if v_role not in ('super_admin','executive') then return jsonb_build_object('error','not_allowed'); end if;
  if v_role = 'executive' then v_from := p_auth->>'title'; end if;
  if v_unit = '' or length(trim(coalesce(p_row->>'body',''))) = 0 or v_from not in ('CEO','DCEO','Group Strategy') then return jsonb_build_object('error','bad_request'); end if;
  if v_id is not null and exists (select 1 from public.feedback where id = v_id) then
    if v_role = 'executive' and (select by_name from public.feedback where id = v_id) <> v_name then return jsonb_build_object('error','not_allowed'); end if;
    update public.feedback set task_ref = coalesce(p_row->>'taskRef', task_ref), unit_id = v_unit, week = nullif(p_row->>'week','')::date, from_role = v_from, body = p_row->>'body',
           to_lead = case when p_row ? 'toLead' then v_lead else to_lead end where id = v_id;
  else
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    insert into public.feedback (id, unit_id, week, from_role, by_name, body, task_ref, to_lead) values (v_id, v_unit, nullif(p_row->>'week','')::date, v_from, v_name, p_row->>'body', coalesce(p_row->>'taskRef',''), v_lead);
  end if;
  perform public.wbg_add_activity(v_name, v_unit, nullif(p_row->>'week','')::date, jsonb_build_object('action','feedback','summary', case when v_lead then 'Letter from ' else 'Feedback from ' end || v_from));
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

grant execute on function public.wbg_save_feedback(jsonb, jsonb) to authenticated;
