-- Stage 5c: approval chain. Requests go to the person one step above the one who asked, not always to Group Strategy.
-- Run once in the Supabase SQL Editor, after upgrade-10. Safe to run again.
--
--   Employee / manager asks  -> the chief (leader) who covers their department, final approval there.
--                               No chief for that department -> the unit's planning head -> Group Strategy.
--   Chief asks               -> the unit's planning head (business units) or Group Strategy (group functions).
--   Planning head asks       -> Group Strategy.
--   Planning heads and Group Strategy can also decide anything below them. Nobody approves their own request.
--   A chief's "departments" list says which departments they cover. Empty list = the whole unit (for example a GM).
--   Rejecting needs a written reason.

alter table public.change_requests add column if not exists dept text not null default '';
alter table public.change_requests add column if not exists req_kind text not null default 'plan';   -- 'plan' or 'actual'
alter table public.change_requests add column if not exists stage text not null default 'group';     -- who must decide: 'chief', 'planning', 'group'
alter table public.change_requests add column if not exists requested_by_uid uuid;

-- Who is the right approver for a request from this role, in this unit, for these departments
create or replace function public.wbg_route_stage(p_unit text, p_role text, p_depts text[]) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_fn boolean := coalesce((select type = 'Corporate function' from public.units where id = p_unit), false); v_chief boolean; v_plan boolean;
begin
  select exists (select 1 from public.profiles p where p.unit_id = p_unit and p.role = 'leader' and p.status = 'active' and p.setup_done
    and (jsonb_array_length(coalesce(p.departments,'[]'::jsonb)) = 0
         or (cardinality(p_depts) > 0 and not exists (select 1 from unnest(p_depts) d where not (p.departments ? d))))) into v_chief;
  select exists (select 1 from public.profiles p where p.unit_id = p_unit and p.role = 'planning' and p.status = 'active' and p.setup_done) into v_plan;
  if p_role in ('staff','manager') then
    if v_chief then return 'chief'; end if;
    if v_plan and not v_fn then return 'planning'; end if;
    return 'group';
  elsif p_role = 'leader' then
    if v_plan and not v_fn then return 'planning'; end if;
    return 'group';
  end if;
  return 'group';
end $$;

-- May this person decide this request?
create or replace function public.wbg_can_decide(a jsonb, r public.change_requests) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_depts text[] := case when coalesce(r.dept,'') = '' then '{}'::text[] else string_to_array(r.dept, ',') end;
begin
  if coalesce(a->>'role','') = '' then return false; end if;
  if a->>'role' = 'super_admin' then return true; end if;
  if r.requested_by_uid is not null and r.requested_by_uid = nullif(a->>'uid','')::uuid then return false; end if;
  if a->>'unit' is distinct from r.unit_id then return false; end if;
  if a->>'role' = 'planning' then return r.stage in ('chief','planning'); end if;
  if a->>'role' = 'leader' then
    return r.stage = 'chief' and (jsonb_array_length(coalesce(a->'departments','[]'::jsonb)) = 0
      or (cardinality(v_depts) > 0 and not exists (select 1 from unnest(v_depts) d where not (a->'departments' ? d))));
  end if;
  return false;
end $$;

-- A request records which departments it touches, what kind it is and who must decide it
create or replace function public.wbg_request_change(p_auth jsonb, p_req jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text := p_req->>'unit'; v_week date := (p_req->>'week')::date; v_name text := trim(coalesce(p_auth->>'name',''));
        v_role text := p_auth->>'role'; v_depts text[]; v_kind text; v_stage text;
begin
  if v_unit is null or v_week is null or jsonb_typeof(p_req->'patch') <> 'array' then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_unit_ok(p_auth, v_unit) and not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  select coalesce(array_agg(distinct d), '{}'::text[]) into v_depts from jsonb_array_elements_text(coalesce(p_req->'depts','[]'::jsonb)) d where d <> '';
  if v_role in ('manager','staff') then
    v_depts := coalesce((select array_agg(d) from unnest(v_depts) d where coalesce(p_auth->'departments','[]'::jsonb) ? d), '{}'::text[]);
    if cardinality(v_depts) = 0 then v_depts := coalesce((select array_agg(d) from jsonb_array_elements_text(coalesce(p_auth->'departments','[]'::jsonb)) d), '{}'::text[]); end if;
  end if;
  v_kind := case when exists (select 1 from jsonb_array_elements(p_req->'patch') o where o->>'op' = 'submit') then 'plan'
                 when v_week < public.wbg_monday() then 'actual' else 'plan' end;
  v_stage := case when public.wbg_is_approver(p_auth) then 'group' else public.wbg_route_stage(v_unit, v_role, v_depts) end;
  insert into public.change_requests (id, unit_id, week, plan_id, requested_by, summary, details, patch, dept, req_kind, stage, requested_by_uid)
  values (coalesce(nullif(p_req->>'id',''), md5(random()::text || clock_timestamp()::text)), v_unit, v_week, to_char(v_week,'YYYY-MM-DD') || '_' || v_unit,
          v_name, coalesce(p_req->>'summary',''), coalesce(p_req->'details','[]'::jsonb), p_req->'patch', array_to_string(v_depts, ','), v_kind, v_stage, nullif(p_auth->>'uid','')::uuid);
  perform public.wbg_add_activity(v_name, v_unit, v_week, jsonb_build_object('action','request','summary','Asked for approval: ' || coalesce(p_req->>'summary',''), 'details', coalesce(p_req->'details','[]'::jsonb)));
  return jsonb_build_object('ok', true);
end $$;

-- Applying an approved change must not be blocked by the approver's own rights (a chief cannot normally edit a past week)
create or replace function public.wbg_save_plan(p_auth jsonb, p_plan jsonb, p_base timestamptz default null, p_force boolean default false, p_activity jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p_auth jsonb := public.wbg_auth();
  v_role text := case when current_setting('wbg.apply_approved', true) = '1' then 'super_admin' else p_auth->>'role' end; v_name text := trim(coalesce(p_auth->>'name',''));
  v_unit text := p_plan->>'unit'; v_week date := (p_plan->>'week')::date; v_id text; v_old public.plans%rowtype;
  v_now timestamptz := now(); v_today text := to_char(now() at time zone 'Africa/Addis_Ababa', 'YYYY-MM-DD');
  v_locked text[] := array['title','kind','dept','outcome','due','priority'];
  v_new jsonb := coalesce(p_plan->'tasks','[]'::jsonb); v_final jsonb := '[]'::jsonb; v_started boolean; v_full boolean;
  o jsonb; n jsonb; v_ignored int := 0; f text; v_diff boolean; v_wins text := coalesce(p_plan->>'wins',''); v_bl text := coalesce(p_plan->>'blockers',''); v_asks text := coalesce(p_plan->>'asks','');
begin
  if v_unit is null or v_week is null or jsonb_typeof(v_new) <> 'array' then return jsonb_build_object('error','bad_request'); end if;
  if v_role is null or v_role = 'executive' then return jsonb_build_object('error','not_allowed'); end if;
  if v_role <> 'super_admin' and coalesce(p_auth->>'unit','') <> v_unit then return jsonb_build_object('error','not_allowed'); end if;
  v_id := to_char(v_week,'YYYY-MM-DD') || '_' || v_unit;
  select * into v_old from public.plans where id = v_id;
  if found and p_base is not null and not p_force and date_trunc('milliseconds', v_old.updated_at) is distinct from date_trunc('milliseconds', p_base) then
    return jsonb_build_object('error','conflict', 'updatedAt', v_old.updated_at, 'updatedBy', v_old.updated_by);
  end if;
  v_started := v_old.id is not null and v_week <= public.wbg_monday();
  v_full := v_role in ('super_admin','leader','planning');
  if v_role <> 'super_admin' and v_week < public.wbg_monday() then return jsonb_build_object('error','needs_approval', 'reason','past_week'); end if;

  if v_role in ('manager','staff') then
    -- tasks outside my departments stay exactly as stored
    for o in select * from jsonb_array_elements(coalesce(v_old.tasks,'[]'::jsonb)) loop
      select x into n from jsonb_array_elements(v_new) x where x->>'id' = o->>'id' limit 1;
      if not public.wbg_dept_ok(p_auth, v_unit, coalesce(o->>'dept','')) then
        v_final := v_final || jsonb_build_array(o);
        if n is not null and n is distinct from o then v_ignored := v_ignored + 1; end if;
      elsif n is null then
        if v_started then return jsonb_build_object('error','needs_approval', 'reason','removed'); end if;
      else
        if not public.wbg_dept_ok(p_auth, v_unit, coalesce(n->>'dept','')) then return jsonb_build_object('error','not_allowed_dept'); end if;
        if v_started then
          foreach f in array v_locked loop
            v_diff := case when f = 'kind' then coalesce(nullif(o->>f,''),'Task') <> coalesce(nullif(n->>f,''),'Task') else coalesce(o->>f,'') <> coalesce(n->>f,'') end;
            if v_diff then return jsonb_build_object('error','needs_approval', 'reason','locked'); end if;
          end loop;
        end if;
        v_final := v_final || jsonb_build_array(n);
      end if;
    end loop;
    for n in select * from jsonb_array_elements(v_new) loop
      if not exists (select 1 from jsonb_array_elements(coalesce(v_old.tasks,'[]'::jsonb)) x where x->>'id' = n->>'id') then
        if not public.wbg_dept_ok(p_auth, v_unit, coalesce(n->>'dept','')) then return jsonb_build_object('error','not_allowed_dept'); end if;
        v_final := v_final || jsonb_build_array(n);
      end if;
    end loop;
    -- unit-level text (key results, blockers, asks) belongs to the unit's leaders and planning team
    if v_role = 'staff' then v_wins := coalesce(v_old.wins,''); v_bl := coalesce(v_old.blockers,''); v_asks := coalesce(v_old.asks,''); end if;
  else
    v_final := v_new;
  end if;

  -- completion date: only super_admin sets any date; others today, blank or unchanged
  if v_role <> 'super_admin' and exists (select 1 from jsonb_array_elements(v_final) nt
       left join jsonb_array_elements(coalesce(v_old.tasks,'[]'::jsonb)) ot on ot->>'id' = nt->>'id'
       where coalesce(nt->>'completedAt','') not in ('', v_today, coalesce(ot->>'completedAt',''))) then
    return jsonb_build_object('error','needs_approval', 'reason','completion_date');
  end if;

  insert into public.plans (id, week, unit_id, tasks, wins, blockers, asks, updated_at, updated_by, source)
  values (v_id, v_week, v_unit, v_final, v_wins, v_bl, v_asks, v_now, v_name, coalesce(p_plan->>'source',''))
  on conflict (id) do update set tasks = excluded.tasks, wins = excluded.wins, blockers = excluded.blockers, asks = excluded.asks,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by, source = excluded.source;
  if p_activity is not null then perform public.wbg_add_activity(v_name, v_unit, v_week, p_activity); end if;
  return jsonb_build_object('ok', true, 'updatedAt', v_now, 'ignored', v_ignored);
end $$;

create or replace function public.wbg_decide_request(p_auth jsonb, p_id text, p_approve boolean, p_note text default '', p_plan jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); v_req public.change_requests%rowtype; v_name text := trim(coalesce(p_auth->>'name','')); v_res jsonb;
begin
  select * into v_req from public.change_requests where id = p_id for update;
  if not found or v_req.status <> 'pending' then return jsonb_build_object('error','not_pending'); end if;
  if not public.wbg_can_decide(p_auth, v_req) then return jsonb_build_object('error','not_allowed'); end if;
  if not p_approve and trim(coalesce(p_note,'')) = '' then return jsonb_build_object('error','reason_needed'); end if;
  if p_approve then
    if p_plan is null then return jsonb_build_object('error','bad_request'); end if;
    perform set_config('wbg.apply_approved', '1', true);
    v_res := public.wbg_save_plan(p_auth, p_plan || jsonb_build_object('unit', v_req.unit_id, 'week', v_req.week), null, true, null);
    perform set_config('wbg.apply_approved', '0', true);
    if v_res ? 'error' then return v_res; end if;
  end if;
  update public.change_requests set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = v_name, decided_at = now(), decision_note = coalesce(p_note,'') where id = p_id;
  perform public.wbg_add_activity(v_name, v_req.unit_id, v_req.week, jsonb_build_object('action','approval',
    'summary', (case when p_approve then 'Approved' else 'Rejected' end) || ' request from ' || v_req.requested_by || ': ' || v_req.summary || case when coalesce(p_note,'') <> '' then ' · Note: ' || p_note else '' end,
    'details', v_req.details));
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.wbg_route_stage(text, text, text[]), public.wbg_can_decide(jsonb, public.change_requests) from public, anon;
grant execute on function public.wbg_route_stage(text, text, text[]), public.wbg_can_decide(jsonb, public.change_requests),
  public.wbg_request_change(jsonb, jsonb), public.wbg_decide_request(jsonb, text, boolean, text, jsonb), public.wbg_save_plan(jsonb, jsonb, timestamptz, boolean, jsonb) to authenticated;
