-- Upgrade 17: roles as titles, view-only employees, "ask for an update", self-approval for the planning head, reschedulable due dates.
-- Run once in the Supabase SQL Editor (safe to run again).
--
--  * New roles: chief, gm, director, lea (Lead executive assistant) and divhead (Division head).
--    The database treats chief / gm / director / lea exactly like the old "leader" role, and divhead exactly like "staff"
--    (wbg_auth() reports the base role), so every existing permission keeps working.
--  * Employees and division heads are view-only. They send an "ask" to their department head instead of saving.
--  * Department heads (manager) and above update progress and plan next week directly. Next-week plans still go to the chief.
--  * The planning head can approve plans, including their own.
--  * The due date is no longer a fixed field: it can be changed during the week (the change is logged, and the chief is notified).

-- 1) role names ---------------------------------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('super_admin','executive','leader','chief','gm','director','lea','planning','manager','divhead','staff'));
alter table public.invites drop constraint if exists invites_role_check;
alter table public.invites add constraint invites_role_check check (role in ('super_admin','executive','leader','chief','gm','director','lea','planning','manager','divhead','staff'));
alter table public.role_requests drop constraint if exists role_requests_req_role_check;
alter table public.role_requests add constraint role_requests_req_role_check check (req_role in ('leader','chief','gm','director','lea','planning','manager','divhead','staff'));

create or replace function public.wbg_base_role(r text) returns text language sql immutable as $$
  select case when r in ('chief','gm','director','lea') then 'leader' when r = 'divhead' then 'staff' else r end $$;
grant execute on function public.wbg_base_role(text) to anon, authenticated;

-- existing chiefs / directors: functions -> chief, business units -> director, the LEA office -> lea
update public.profiles p set role = case when p.unit_id = 'lead-executive-assistance-lea' then 'lea' when u.type = 'Business unit' then 'director' else 'chief' end
  from public.units u where u.id = p.unit_id and p.role = 'leader';

-- wbg_auth() keeps reporting the base role, so no other permission check changes
do $$
declare d text;
begin
  select pg_get_functiondef('public.wbg_auth'::regproc) into d;
  if d like '%''role'', role,%' then
    d := replace(d, '''role'', role,', '''role'', public.wbg_base_role(role), ''rawRole'', role,');
  end if;
  if d like '%coalesce(v.as_role, p.role)%' then
    d := replace(d, 'coalesce(v.as_role, p.role)', 'coalesce(v.as_role, public.wbg_base_role(p.role))');
  end if;
  execute d;
end $$;

-- the role lists in the person checks
do $$
declare d text; f text;
begin
  foreach f in array array['wbg__check_person','wbg_request_role'] loop
    select pg_get_functiondef(p.oid) into d from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f;
    if d is not null and d like '%''leader'',''planning'',''manager'',''staff''%' then
      execute replace(d, '''leader'',''planning'',''manager'',''staff''', '''leader'',''chief'',''gm'',''director'',''lea'',''planning'',''manager'',''divhead'',''staff''');
    end if;
  end loop;
end $$;

-- 2) save rules: view-only employees, reschedulable due date ------------------------------------------------------
do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'wbg_save_plan';
  if d like '%array[''title'',''kind'',''dept'',''outcome'',''due'',''priority'']%' then
    d := replace(d, 'array[''title'',''kind'',''dept'',''outcome'',''due'',''priority'']', 'array[''title'',''kind'',''dept'',''outcome'',''priority'']');
  end if;
  if d not like '%view_only_role%' then
    d := replace(d, 'if v_role is null or v_role = ''executive'' then return jsonb_build_object(''error'',''not_allowed''); end if;',
      'if v_role is null or v_role = ''executive'' then return jsonb_build_object(''error'',''not_allowed''); end if;' || E'\n' ||
      '  if v_role = ''staff'' then return jsonb_build_object(''error'',''view_only_role''); end if;');
  end if;
  execute d;
  select pg_get_functiondef(p.oid) into d from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'wbg_request_change';
  if d not like '%view_only_role%' then
    d := replace(d, 'if v_unit is null or v_week is null or jsonb_typeof(p_req->''patch'') <> ''array'' then return jsonb_build_object(''error'',''bad_request''); end if;',
      'if v_unit is null or v_week is null or jsonb_typeof(p_req->''patch'') <> ''array'' then return jsonb_build_object(''error'',''bad_request''); end if;' || E'\n' ||
      '  if p_auth->>''role'' = ''staff'' then return jsonb_build_object(''error'',''view_only_role''); end if;');
  end if;
  execute d;
end $$;

-- 3) "ask for an update": a view-only employee asks their department head ----------------------------------------
create or replace function public.wbg_ask_update(p_auth jsonb, p_req jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text := p_req->>'unit'; v_week date := (p_req->>'week')::date; v_name text := trim(coalesce(p_auth->>'name',''));
        v_txt text := trim(coalesce(p_req->>'text','')); v_depts text[];
begin
  if v_unit is null or v_week is null or length(v_txt) < 3 then return jsonb_build_object('error','bad_request'); end if;
  if coalesce(p_auth->>'role','') = '' or coalesce(p_auth->>'unit','') <> v_unit then return jsonb_build_object('error','not_allowed'); end if;
  select coalesce(array_agg(distinct d), '{}'::text[]) into v_depts from jsonb_array_elements_text(coalesce(p_req->'depts','[]'::jsonb)) d
    where d <> '' and coalesce(p_auth->'departments','[]'::jsonb) ? d;
  if cardinality(v_depts) = 0 then
    v_depts := coalesce((select array_agg(d) from jsonb_array_elements_text(coalesce(p_auth->'departments','[]'::jsonb)) d), '{}'::text[]);
  end if;
  insert into public.change_requests (id, unit_id, week, plan_id, requested_by, summary, details, patch, dept, req_kind, stage, requested_by_uid)
  values (coalesce(nullif(p_req->>'id',''), md5(random()::text || clock_timestamp()::text)), v_unit, v_week, to_char(v_week,'YYYY-MM-DD') || '_' || v_unit,
          v_name, left(v_txt, 500), jsonb_build_array(left(v_txt, 500)), '[]'::jsonb, array_to_string(v_depts, ','), 'ask', 'dept', nullif(p_auth->>'uid','')::uuid);
  perform public.wbg_add_activity(v_name, v_unit, v_week, jsonb_build_object('action','request','summary','Asked their department head for an update: ' || left(v_txt, 200)));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.wbg_ask_update(jsonb, jsonb) to authenticated;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'change_requests' and policyname = 'read_own') then
    create policy "read_own" on public.change_requests for select to authenticated using (requested_by_uid = auth.uid());
  end if;
end $$;

-- 4) who decides ----------------------------------------------------------------------------------------------------
create or replace function public.wbg_can_decide(a jsonb, r change_requests) returns boolean
language plpgsql stable security definer set search_path to 'public' as $$
declare v_depts text[] := case when coalesce(r.dept,'') = '' then '{}'::text[] else string_to_array(r.dept, ',') end;
begin
  if coalesce(a->>'role','') = '' then return false; end if;
  if a->>'role' = 'super_admin' then return true; end if;
  if a->>'unit' is distinct from r.unit_id then return false; end if;
  if r.req_kind = 'ask' then   -- a view-only employee's ask: their department head, the chief or the planning head
    if a->>'role' in ('leader','planning') then return true; end if;
    if a->>'role' = 'manager' then return cardinality(v_depts) = 0 or exists (select 1 from unnest(v_depts) d where coalesce(a->'departments','[]'::jsonb) ? d); end if;
    return false;
  end if;
  if r.requested_by_uid is not null and r.requested_by_uid = nullif(a->>'uid','')::uuid and a->>'role' <> 'planning' then return false; end if;
  if a->>'role' = 'planning' then return r.stage in ('chief','planning'); end if;
  if a->>'role' = 'leader' then
    return r.stage = 'chief' and (jsonb_array_length(coalesce(a->'departments','[]'::jsonb)) = 0
      or (cardinality(v_depts) > 0 and not exists (select 1 from unnest(v_depts) d where not (a->'departments' ? d))));
  end if;
  return false;
end $$;

create or replace function public.wbg_route_stage(p_unit text, p_role text, p_depts text[]) returns text
language plpgsql stable security definer set search_path to 'public' as $$
declare v_fn boolean := coalesce((select type = 'Corporate function' from public.units where id = p_unit), false); v_chief boolean; v_plan boolean;
begin
  select exists (select 1 from public.profiles p where p.unit_id = p_unit and public.wbg_base_role(p.role) = 'leader' and p.status = 'active' and p.setup_done
    and (jsonb_array_length(coalesce(p.departments,'[]'::jsonb)) = 0
         or (cardinality(p_depts) > 0 and not exists (select 1 from unnest(p_depts) d where not (p.departments ? d))))) into v_chief;
  select exists (select 1 from public.profiles p where p.unit_id = p_unit and p.role = 'planning' and p.status = 'active' and p.setup_done) into v_plan;
  if p_role = 'planning' then return 'planning'; end if;   -- the planning head approves their own plan
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

-- an "ask" is only marked done: nothing is saved to the plan
create or replace function public.wbg_decide_request(p_auth jsonb, p_id text, p_approve boolean, p_note text default ''::text, p_plan jsonb default null::jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_req public.change_requests%rowtype; v_name text := trim(coalesce(p_auth->>'name','')); v_res jsonb;
begin
  select * into v_req from public.change_requests where id = p_id for update;
  if not found or v_req.status <> 'pending' then return jsonb_build_object('error','not_pending'); end if;
  if not public.wbg_can_decide(p_auth, v_req) then return jsonb_build_object('error','not_allowed'); end if;
  if not p_approve and trim(coalesce(p_note,'')) = '' then return jsonb_build_object('error','reason_needed'); end if;
  if p_approve and v_req.req_kind is distinct from 'ask' then
    if p_plan is null then return jsonb_build_object('error','bad_request'); end if;
    perform set_config('wbg.apply_approved', '1', true);
    v_res := public.wbg_save_plan(p_auth, p_plan || jsonb_build_object('unit', v_req.unit_id, 'week', v_req.week), null, true, null);
    perform set_config('wbg.apply_approved', '0', true);
    if v_res ? 'error' then return v_res; end if;
  end if;
  update public.change_requests set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = v_name, decided_at = now(), decision_note = coalesce(p_note,'') where id = p_id;
  perform public.wbg_add_activity(v_name, v_req.unit_id, v_req.week, jsonb_build_object('action','approval',
    'summary', (case when v_req.req_kind = 'ask' then (case when p_approve then 'Marked done: ' else 'Declined: ' end) else (case when p_approve then 'Approved ' else 'Rejected ' end) || 'request from ' end)
               || case when v_req.req_kind = 'ask' then v_req.requested_by || ' asked for an update' else v_req.requested_by || ': ' || v_req.summary end
               || case when coalesce(p_note,'') <> '' then ' · Note: ' || p_note else '' end,
    'details', v_req.details));
  return jsonb_build_object('ok', true);
end $$;
