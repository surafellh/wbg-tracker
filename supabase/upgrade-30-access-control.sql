-- Upgrade 30: configurable access control (the "access matrix").
-- SAFE TO RUN WHILE OFF: every rule keeps its old logic until Admin > Access is switched to "matrix" mode.
-- Defaults seeded below are identical to the rules that were hard-coded before, so switching on changes nothing until an admin edits a rule.
-- Super admin always keeps full control: the Access page itself is hard-wired to the super_admin role and cannot be revoked.

-- ============ tables ============
create table if not exists public.perm_caps (
  cap text primary key, grp text not null, label text not null, help text not null default '',
  levels text not null default 'none,all', sort int not null default 0
);
create table if not exists public.perm_grants (
  kind text not null check (kind in ('role','unit','user')),
  subject text not null,
  cap text not null references public.perm_caps(cap) on delete cascade,
  value text not null check (value in ('none','dept','own','all')),
  updated_by text, updated_at timestamptz not null default now(),
  primary key (kind, subject, cap)
);
create table if not exists public.perm_default_grants (like public.perm_grants including all);
create table if not exists public.perm_history (
  id bigserial primary key, at timestamptz not null default now(), by_name text, batch uuid, action text,
  kind text, subject text, cap text, old_value text, new_value text, note text
);
create table if not exists public.perm_snapshots (
  id bigserial primary key, at timestamptz not null default now(), by_name text, label text, grants jsonb not null, config jsonb not null default '{}'::jsonb
);
alter table public.perm_caps enable row level security;
alter table public.perm_grants enable row level security;
alter table public.perm_default_grants enable row level security;
alter table public.perm_history enable row level security;
alter table public.perm_snapshots enable row level security;
-- no policies: only the SECURITY DEFINER functions below can read or write these tables.

-- ============ catalogue ============
insert into public.perm_caps (cap, grp, label, help, levels, sort) values
 ('read_plans','See','See plans and progress','Weekly plans, requests and the activity log. "All" = every unit; "Own" = only their own unit.','none,own,all',10),
 ('read_private','See','See a unit''s corrective actions and feedback','Corrective actions and the feedback shown to a unit. "All" = every unit; "Own" = only their own unit.','none,own,all',20),
 ('discuss','See','Comment on tasks','Write comments on a unit''s tasks and mention people. "Own" = their own unit only.','none,own,all',30),
 ('plan_save','Plans and tasks','Save weekly plans','May save a unit''s weekly plan at all. "Own" = their own unit; "All" = any unit.','none,own,all',40),
 ('plan_full','Plans and tasks','Edit every department''s tasks and skip locked fields','Without this, the person only edits tasks of their own departments and locked fields need approval.','none,own,all',50),
 ('edit_dept','Plans and tasks','Edit tasks of a department','"Dept" = only their own departments; "Own" = every department of their unit; "All" = any unit.','none,dept,own,all',60),
 ('plan_unit_text','Plans and tasks','Edit key results, blockers and asks','The unit-level text under the task table.','none,own,all',70),
 ('plan_past_week','Plans and tasks','Change a past week without approval','Normally a week that has ended needs approval.','none,own,all',80),
 ('plan_any_completion','Plans and tasks','Set any completion date','Normally a completion date must be today or unchanged.','none,own,all',90),
 ('undo_save','Plans and tasks','Undo the last save (30 minutes)','','none,own,all',100),
 ('unit_lists','Plans and tasks','Edit the people list of a unit','','none,own,all',110),
 ('edit_departments','Plans and tasks','Edit the departments of a unit','','none,own,all',120),
 ('lead_unit','Approvals','Act as lead of a unit','Counts as unit lead (acknowledge feedback, manage the unit''s people and requests).','none,own,all',130),
 ('member_unit','Approvals','Count as a member of a unit','','none,own,all',140),
 ('decide_chief','Approvals','Approve requests at the chief step','Requests of staff/managers of their own unit that wait for the chief.','none,own,all',150),
 ('decide_planning','Approvals','Approve requests at the planning-head step','Includes the chief step.','none,own,all',160),
 ('decide_ask','Approvals','Answer "ask for an update" requests','"Dept" = only requests for their own departments.','none,dept,own,all',170),
 ('decide_own','Approvals','Approve their own requests','Normally nobody approves their own request, except the planning head.','none,own,all',180),
 ('decide_group','Approvals','Approve any request at any step (Group Strategy)','','none,all',190),
 ('approve_admin','Approvals','Full approver: delete, restore, manage everything','Deletes/edits other people''s records (support asks, actions, feedback), logs, withdraws requests.','none,all',200),
 ('feedback_write','Feedback','Write feedback and letters to units','','none,all',210),
 ('feedback_reply','Feedback','Reply to feedback','"Own" = only feedback of their own unit.','none,own,all',220),
 ('admin_people','Admin','Manage people','Edit people, invite, disable, reset password, give a temporary password, decide access and role requests.','none,all',230),
 ('admin_settings','Admin','Change general settings','Cut-off time, renaming, locked fields, company-email domains, approval code.','none,all',240),
 ('admin_backups','Admin','Download and restore backups','','none,all',250),
 ('cash_view','Cash flow','See the weekly cash flow','','none,all',260),
 ('cash_write','Cash flow','Change the weekly cash flow','Enter items, payments and collections, import, restore backups.','none,all',270)
on conflict (cap) do update set grp=excluded.grp, label=excluded.label, help=excluded.help, levels=excluded.levels, sort=excluded.sort;

-- ============ defaults = the rules that were hard-coded before ============
delete from public.perm_default_grants;
insert into public.perm_default_grants (kind, subject, cap, value)
select 'role', r, c, v from (values
 ('super_admin','read_plans','all'),('executive','read_plans','all'),('leader','read_plans','all'),('planning','read_plans','own'),('manager','read_plans','own'),
 ('super_admin','read_private','all'),('executive','read_private','all'),('leader','read_private','own'),('planning','read_private','own'),('manager','read_private','own'),
 ('super_admin','discuss','all'),('executive','discuss','all'),('leader','discuss','all'),('planning','discuss','own'),('manager','discuss','own'),('staff','discuss','own'),
 ('super_admin','plan_save','all'),('leader','plan_save','own'),('planning','plan_save','own'),('manager','plan_save','own'),
 ('super_admin','plan_full','all'),('leader','plan_full','own'),('planning','plan_full','own'),
 ('super_admin','edit_dept','all'),('leader','edit_dept','own'),('planning','edit_dept','own'),('manager','edit_dept','dept'),('staff','edit_dept','dept'),
 ('super_admin','plan_unit_text','all'),('leader','plan_unit_text','own'),('planning','plan_unit_text','own'),('manager','plan_unit_text','own'),
 ('super_admin','plan_past_week','all'),
 ('super_admin','plan_any_completion','all'),
 ('super_admin','undo_save','all'),('leader','undo_save','own'),('planning','undo_save','own'),('manager','undo_save','own'),
 ('super_admin','unit_lists','all'),('leader','unit_lists','own'),('planning','unit_lists','own'),('manager','unit_lists','own'),
 ('super_admin','edit_departments','all'),('leader','edit_departments','own'),('planning','edit_departments','own'),
 ('leader','lead_unit','own'),('planning','lead_unit','own'),('manager','lead_unit','own'),
 ('leader','member_unit','own'),('planning','member_unit','own'),('manager','member_unit','own'),('staff','member_unit','own'),
 ('leader','decide_chief','own'),('planning','decide_chief','own'),
 ('planning','decide_planning','own'),
 ('leader','decide_ask','own'),('planning','decide_ask','own'),('manager','decide_ask','dept'),
 ('planning','decide_own','own'),
 ('super_admin','decide_group','all'),
 ('super_admin','approve_admin','all'),
 ('super_admin','feedback_write','all'),('executive','feedback_write','all'),
 ('super_admin','feedback_reply','all'),('executive','feedback_reply','all'),('leader','feedback_reply','own'),('planning','feedback_reply','own'),
 ('super_admin','admin_people','all'),('super_admin','admin_settings','all'),('super_admin','admin_backups','all'),
 ('super_admin','cash_view','all'),('super_admin','cash_write','all'),
 ('title:DCEO','cash_view','all')
) t(r, c, v);
-- the group finance function keeps cash flow access as a unit rule
insert into public.perm_default_grants (kind, subject, cap, value) values
 ('unit','group-finance-function','cash_view','all'),('unit','group-finance-function','cash_write','all');
-- seed the live grants from the defaults only the first time (never overwrite what an admin has edited)
insert into public.perm_grants (kind, subject, cap, value, updated_by)
select kind, subject, cap, value, 'default' from public.perm_default_grants
on conflict do nothing;

-- ============ engine ============
create or replace function public.wbg_perm_on() returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(nullif(current_setting('wbg.perm_mode', true), ''), (select value #>> '{}' from public.app_config where key = 'perm_mode'), 'legacy') = 'matrix'
$$;
create or replace function public.wbg_rank(v text) returns int language sql immutable as $$ select case v when 'all' then 3 when 'own' then 2 when 'dept' then 1 else 0 end $$;

-- the strongest level this person has for a capability: a rule for the person wins, otherwise the role's rule, combined with any rule for their unit
create or replace function public.wbg_cap_rank(a jsonb, p_cap text) returns int language plpgsql stable security definer set search_path to 'public' as $$
declare v text; r int := 0; u int := 0; v_found boolean := false;
begin
  if coalesce(a->>'role','') = '' then return 0; end if;
  if coalesce(a->>'uid','') <> '' then
    select value into v from public.perm_grants where kind = 'user' and subject = a->>'uid' and cap = p_cap;
    if found then return public.wbg_rank(v); end if;
  end if;
  if coalesce(a->>'title','') <> '' then
    select value into v from public.perm_grants where kind = 'role' and subject = 'title:' || (a->>'title') and cap = p_cap;
    v_found := found;
  end if;
  if not v_found and coalesce(a->>'rawRole','') <> '' then
    select value into v from public.perm_grants where kind = 'role' and subject = a->>'rawRole' and cap = p_cap;
    v_found := found;
  end if;
  if not v_found then
    select value into v from public.perm_grants where kind = 'role' and subject = a->>'role' and cap = p_cap;
    v_found := found;
  end if;
  if v_found then r := public.wbg_rank(v); end if;
  if coalesce(a->>'unit','') <> '' then
    select coalesce(max(public.wbg_rank(value)), 0) into u from public.perm_grants where kind = 'unit' and subject = a->>'unit' and cap = p_cap;
  end if;
  return greatest(r, u);
end $$;

-- may this person use the capability for this unit / department? (unit null = anywhere)
create or replace function public.wbg_can(a jsonb, p_cap text, p_unit text default null, p_dept text default null) returns boolean language plpgsql stable security definer set search_path to 'public' as $$
declare r int := public.wbg_cap_rank(a, p_cap);
begin
  if r >= 3 then return true; end if;
  if r = 0 then return false; end if;
  if p_unit is null then return true; end if;
  if coalesce(a->>'unit','') = '' or a->>'unit' is distinct from p_unit then return false; end if;
  if r = 2 then return true; end if;
  return coalesce(p_dept,'') <> '' and coalesce(a->'departments','[]'::jsonb) ? p_dept;
end $$;

-- the auth object of any user (used by "what can this person do" and by tests)
create or replace function public.wbg_auth_of(p_user uuid) returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce((select jsonb_build_object('uid', user_id, 'name', trim(full_name), 'email', email, 'role', public.wbg_base_role(role), 'rawRole', role, 'title', title,
                          'unit', unit_id, 'departments', departments)
                   from public.profiles where user_id = p_user and status = 'active' and setup_done), '{}'::jsonb)
$$;

create or replace function public.wbg_my_caps() returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_object_agg(c.cap, case public.wbg_cap_rank(public.wbg_auth(), c.cap) when 3 then 'all' when 2 then 'own' when 1 then 'dept' else 'none' end), '{}'::jsonb) from public.perm_caps c
$$;

-- gates for the admin screens
create or replace function public.wbg_admin_ok(a jsonb, p_cap text) returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when public.wbg_perm_on() then public.wbg_can(a, p_cap) else coalesce(a->>'role' = 'super_admin', false) end
$$;
create or replace function public.wbg_ap_people(a jsonb) returns boolean language sql stable security definer set search_path to 'public' as $$ select public.wbg_admin_ok(a, 'admin_people') $$;
create or replace function public.wbg_ap_settings(a jsonb) returns boolean language sql stable security definer set search_path to 'public' as $$ select public.wbg_admin_ok(a, 'admin_settings') $$;
create or replace function public.wbg_ap_backups(a jsonb) returns boolean language sql stable security definer set search_path to 'public' as $$ select public.wbg_admin_ok(a, 'admin_backups') $$;
-- the permission page itself: hard-wired to super admin so nobody can lock the admins out
create or replace function public.wbg_perm_admin(a jsonb) returns boolean language sql immutable as $$ select coalesce(a->>'role' = 'super_admin', false) $$;

-- ============ the old primitives, now able to follow the matrix ============
create or replace function public.wbg_is_approver(a jsonb) returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when public.wbg_perm_on() then public.wbg_can(a, 'approve_admin') else coalesce(a->>'role' = 'super_admin', false) end $$;
create or replace function public.wbg_full_read() returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when public.wbg_perm_on() then public.wbg_cap_rank(public.wbg_auth(), 'read_plans') >= 3
    else coalesce(public.wbg_auth()->>'role' in ('super_admin','executive','leader'), false) end $$;
create or replace function public.wbg_unit_read(p_unit text) returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when public.wbg_perm_on() then public.wbg_can(public.wbg_auth(), 'read_plans', p_unit)
    else coalesce(public.wbg_auth()->>'role' in ('super_admin','executive','leader')
      or (public.wbg_auth()->>'role' in ('planning','manager') and public.wbg_auth()->>'unit' = p_unit), false) end $$;
create or replace function public.wbg_unit_read_own(p_unit text) returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when public.wbg_perm_on() then public.wbg_can(public.wbg_auth(), 'read_private', p_unit)
    else coalesce(public.wbg_auth()->>'role' in ('super_admin','executive')
      or (public.wbg_auth()->>'role' in ('leader','planning','manager') and public.wbg_auth()->>'unit' = p_unit), false) end $$;
create or replace function public.wbg_unit_lead(a jsonb, p_unit text) returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when public.wbg_perm_on() then public.wbg_can(a, 'lead_unit', p_unit)
    else coalesce(a->>'role' in ('leader','planning','manager') and a->>'unit' = p_unit, false) end $$;
create or replace function public.wbg_unit_ok(a jsonb, p_unit text) returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when public.wbg_perm_on() then public.wbg_can(a, 'member_unit', p_unit)
    else coalesce(a->>'role' in ('leader','planning','manager','staff') and a->>'unit' = p_unit, false) end $$;
create or replace function public.wbg_dept_ok(a jsonb, p_unit text, p_dept text) returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when public.wbg_perm_on() then public.wbg_can(a, 'edit_dept', p_unit, p_dept)
  else (case a->>'role'
    when 'super_admin' then true
    when 'leader'      then a->>'unit' = p_unit
    when 'planning'    then a->>'unit' = p_unit
    when 'manager'     then a->>'unit' = p_unit and coalesce(p_dept,'') <> '' and coalesce(a->'departments','[]'::jsonb) ? p_dept
    when 'staff'       then a->>'unit' = p_unit and coalesce(p_dept,'') <> '' and coalesce(a->'departments','[]'::jsonb) ? p_dept
    else false end) end $$;
create or replace function public.wbg__can_discuss(a jsonb, p_unit text) returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when public.wbg_perm_on() then public.wbg_can(a, 'discuss', p_unit)
    else coalesce(a->>'role' in ('super_admin','executive','leader') or a->>'unit' = p_unit, false) and coalesce(a->>'role','') <> '' end $$;

create or replace function public.wbg_can_decide(a jsonb, r change_requests) returns boolean
 language plpgsql stable security definer set search_path to 'public' as $$
declare v_depts text[] := case when coalesce(r.dept,'') = '' then '{}'::text[] else string_to_array(r.dept, ',') end; k int;
begin
  if coalesce(a->>'role','') = '' then return false; end if;
  if public.wbg_perm_on() then
    if public.wbg_can(a, 'decide_group') then return true; end if;
    if a->>'unit' is distinct from r.unit_id then return false; end if;
    if r.req_kind = 'ask' then
      k := public.wbg_cap_rank(a, 'decide_ask');
      if k >= 2 then return true; end if;
      if k = 1 then return cardinality(v_depts) = 0 or exists (select 1 from unnest(v_depts) d where coalesce(a->'departments','[]'::jsonb) ? d); end if;
      return false;
    end if;
    if r.requested_by_uid is not null and r.requested_by_uid = nullif(a->>'uid','')::uuid and not public.wbg_can(a, 'decide_own', r.unit_id) then return false; end if;
    return (r.stage in ('chief','planning') and public.wbg_can(a, 'decide_planning', r.unit_id)) or (r.stage = 'chief' and public.wbg_can(a, 'decide_chief', r.unit_id));
  end if;
  if a->>'role' = 'super_admin' then return true; end if;
  if a->>'unit' is distinct from r.unit_id then return false; end if;
  if r.req_kind = 'ask' then
    if a->>'role' in ('leader','planning') then return true; end if;
    if a->>'role' = 'manager' then return cardinality(v_depts) = 0 or exists (select 1 from unnest(v_depts) d where coalesce(a->'departments','[]'::jsonb) ? d); end if;
    return false;
  end if;
  if r.requested_by_uid is not null and r.requested_by_uid = nullif(a->>'uid','')::uuid and a->>'role' <> 'planning' then return false; end if;
  if a->>'role' = 'planning' then return r.stage in ('chief','planning'); end if;
  if a->>'role' = 'leader' then return r.stage = 'chief'; end if;
  return false;
end $$;

-- cash flow
create or replace function public.wbg_cf_any() returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when public.wbg_perm_on() then public.wbg_can(public.wbg_auth(), 'cash_view')
    else coalesce(public.wbg_auth()->>'role' = 'super_admin' or public.wbg_auth()->>'unit' = 'group-finance-function'
      or (public.wbg_auth()->>'rawRole' = 'executive' and public.wbg_auth()->>'title' = 'DCEO'), false) end $$;
create or replace function public.wbg_cf_write(p_unit text) returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when public.wbg_perm_on() then public.wbg_can(public.wbg_auth(), 'cash_write')
    else coalesce(public.wbg_auth()->>'role' = 'super_admin' or public.wbg_auth()->>'unit' = 'group-finance-function', false) end $$;
create or replace function public.wbg_cf_write_any() returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when public.wbg_perm_on() then public.wbg_can(public.wbg_auth(), 'cash_write')
    else coalesce(public.wbg_auth()->>'role' = 'super_admin' or public.wbg_auth()->>'unit' = 'group-finance-function', false) end $$;

-- route the admin functions through their own gates (mechanical swap; each function is checked to contain the call)
do $$
declare f text; d text; g text; n int := 0;
begin
  for f, g in select * from (values
    ('wbg_admin_users','people'),('wbg_admin_save_user','people'),('wbg_admin_invite','people'),('wbg_admin_delete_invite','people'),
    ('wbg_admin_reset_password','people'),('wbg_admin_temp_password','people'),('wbg_admin_decide_access','people'),('wbg_admin_decide_role','people'),('wbg_admin_role_requests','people'),
    ('wbg_admin_set_setting','settings'),('wbg_admin_set_domains','settings'),('wbg_admin_set_approval_code','settings'),('wbg_admin_approval_code_status','settings'),
    ('wbg_admin_backups','backups'),('wbg_admin_get_backup','backups'),('wbg_restore_backup','backups')) t(f, g)
  loop
    select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = f and p.prokind = 'f';
    if d is null then raise exception 'missing function %', f; end if;
    if d like '%wbg_ap_' || g || '(%' then continue; end if;   -- already swapped
    if d not like '%wbg_is_approver(%' then raise exception 'function % has no approver check to swap', f; end if;
    execute replace(d, 'wbg_is_approver(', 'wbg_ap_' || g || '(');
    n := n + 1;
  end loop;
  raise notice 'swapped % functions', n;
end $$;

-- ============ plans: follow the matrix, and read the locked fields from settings ============
create or replace function public.wbg_locked_fields() returns text[] language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    (select array_agg(x) from jsonb_array_elements_text(case when jsonb_typeof(public.wbg_cfg('locked_fields')) = 'array' then public.wbg_cfg('locked_fields') else null end) x),
    case when coalesce(public.wbg_cfg('allow_rename') = 'true'::jsonb, false) then array['kind','dept','outcome','priority'] else array['title','kind','dept','outcome','priority'] end)
$$;

create or replace function public.wbg_settings() returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'graceTime', coalesce(nullif(public.wbg_cfg('grace_time') #>> '{}', ''), '14:00'),
    'extendUntil', coalesce(public.wbg_cfg('extend_until') #>> '{}', ''),
    'allowRename', coalesce(public.wbg_cfg('allow_rename') = 'true'::jsonb, false),
    'lockedFields', to_jsonb(public.wbg_locked_fields()),
    'routeChief', coalesce(public.wbg_cfg('route_chief') <> 'false'::jsonb, true),
    'routePlanning', coalesce(public.wbg_cfg('route_planning') <> 'false'::jsonb, true),
    'permMode', case when public.wbg_perm_on() then 'matrix' else 'legacy' end)
$$;

create or replace function public.wbg_save_plan(p_auth jsonb, p_plan jsonb, p_base timestamp with time zone DEFAULT NULL::timestamp with time zone, p_force boolean DEFAULT false, p_activity jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
declare
  p_auth jsonb := public.wbg_auth();
  v_apply boolean := current_setting('wbg.apply_approved', true) = '1';
  v_role text := case when current_setting('wbg.apply_approved', true) = '1' then 'super_admin' else p_auth->>'role' end; v_name text := trim(coalesce(p_auth->>'name',''));
  v_unit text := p_plan->>'unit'; v_week date := (p_plan->>'week')::date; v_id text; v_old public.plans%rowtype;
  v_now timestamptz := now(); v_today text := to_char(now() at time zone 'Africa/Addis_Ababa', 'YYYY-MM-DD');
  v_locked text[] := public.wbg_locked_fields();
  v_new jsonb := coalesce(p_plan->'tasks','[]'::jsonb); v_final jsonb := '[]'::jsonb; v_started boolean;
  v_can boolean; v_full boolean; v_past boolean; v_anycomp boolean; v_text boolean;
  o jsonb; n jsonb; v_ignored int := 0; f text; v_diff boolean; v_wins text := coalesce(p_plan->>'wins',''); v_bl text := coalesce(p_plan->>'blockers',''); v_asks text := coalesce(p_plan->>'asks','');
begin
  if v_unit is null or v_week is null or jsonb_typeof(v_new) <> 'array' then return jsonb_build_object('error','bad_request'); end if;
  if public.wbg_perm_on() then
    v_can := v_apply or public.wbg_can(p_auth, 'plan_save', v_unit);
    v_full := v_apply or public.wbg_can(p_auth, 'plan_full', v_unit);
    v_past := v_apply or public.wbg_can(p_auth, 'plan_past_week', v_unit);
    v_anycomp := v_apply or public.wbg_can(p_auth, 'plan_any_completion', v_unit);
    v_text := v_apply or public.wbg_can(p_auth, 'plan_unit_text', v_unit);
  else
    v_can := not (v_role is null or v_role in ('executive','staff')) and (v_role = 'super_admin' or coalesce(p_auth->>'unit','') = v_unit);
    v_full := v_role in ('super_admin','leader','planning');
    v_past := v_role = 'super_admin'; v_anycomp := v_role = 'super_admin'; v_text := v_role is distinct from 'staff';
  end if;
  if not v_can then return jsonb_build_object('error', case when v_role = 'staff' then 'view_only_role' else 'not_allowed' end); end if;
  v_id := to_char(v_week,'YYYY-MM-DD') || '_' || v_unit;
  select * into v_old from public.plans where id = v_id;
  if found and p_base is not null and not p_force and date_trunc('milliseconds', v_old.updated_at) is distinct from date_trunc('milliseconds', p_base) then
    return jsonb_build_object('error','conflict', 'updatedAt', v_old.updated_at, 'updatedBy', v_old.updated_by);
  end if;
  v_started := v_old.id is not null and v_week <= public.wbg_lock_monday();
  if not v_past and v_week < public.wbg_lock_monday() then return jsonb_build_object('error','needs_approval', 'reason','past_week'); end if;

  if not v_full then
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
    if not v_text then v_wins := coalesce(v_old.wins,''); v_bl := coalesce(v_old.blockers,''); v_asks := coalesce(v_old.asks,''); end if;
  else
    v_final := v_new;
  end if;

  if not v_anycomp and exists (select 1 from jsonb_array_elements(v_final) nt
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
end $function$;

create or replace function public.wbg_undo_last_save(p_auth jsonb, p_plan_id text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
declare p_auth jsonb := public.wbg_auth(); v_role text := p_auth->>'role'; v_p public.plans%rowtype; v_h public.row_history%rowtype;
        v_name text := trim(coalesce(p_auth->>'name','')); r jsonb; v_m boolean := public.wbg_perm_on();
begin
  if v_role is null or (not v_m and v_role in ('staff','executive')) or (v_m and public.wbg_cap_rank(p_auth, 'undo_save') = 0) then return jsonb_build_object('error','not_allowed'); end if;
  select * into v_p from public.plans where id = p_plan_id;
  if not found then return jsonb_build_object('error','not_found'); end if;
  if v_m then
    if not public.wbg_can(p_auth, 'undo_save', v_p.unit_id) then return jsonb_build_object('error','not_allowed'); end if;
  elsif v_role <> 'super_admin' and coalesce(p_auth->>'unit','') <> v_p.unit_id then return jsonb_build_object('error','not_allowed'); end if;
  if v_p.updated_by is distinct from v_name or v_p.updated_at < now() - interval '30 minutes' then return jsonb_build_object('error','too_late'); end if;
  select * into v_h from public.row_history where tbl = 'plans' and row_id = p_plan_id and op <> 'SNAPSHOT' order by changed_at desc, id desc limit 1;
  if not found or v_h.changed_at < v_p.updated_at - interval '5 seconds' then return jsonb_build_object('error','not_found'); end if;
  r := v_h.old_row;
  update public.plans set tasks = coalesce(r->'tasks','[]'::jsonb), wins = coalesce(r->>'wins',''), blockers = coalesce(r->>'blockers',''), asks = coalesce(r->>'asks',''),
    updated_at = now(), updated_by = v_name, source = 'Undo' where id = p_plan_id;
  perform public.wbg_add_activity(v_name, v_p.unit_id, v_p.week, jsonb_build_object('action','restore','summary','Undid the last save'));
  return jsonb_build_object('ok', true);
end $function$;

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
    insert into public.units (id, name, type, sort_order) values (v_id, p_data->>'name', coalesce(p_data->>'type','Business unit'), coalesce((p_data->>'order')::int, 99))
    on conflict (id) do nothing;
  elsif p_op = 'update' then
    update public.units set name = coalesce(nullif(p_data->>'name',''), name), type = coalesce(nullif(p_data->>'type',''), type) where id = v_id;
  elsif p_op = 'remove' then
    delete from public.units where id = v_id;
  else
    return jsonb_build_object('error','bad_request');
  end if;
  perform public.wbg_add_activity(v_name, v_id, null, jsonb_build_object('action', case when p_op = 'lists' then 'lists' else 'unit' end, 'summary', coalesce(nullif(p_summary,''), p_op || ' unit')));
  return jsonb_build_object('ok', true);
end $function$;

-- feedback
create or replace function public.wbg_save_feedback(p_auth jsonb, p_row jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
declare p_auth jsonb := public.wbg_auth(); v_role text := p_auth->>'role'; v_unit text := coalesce(p_row->>'unit',''); v_id text := nullif(p_row->>'id','');
        v_name text := trim(coalesce(p_auth->>'name','')); v_from text := coalesce(nullif(p_row->>'from',''),'Group Strategy');
        v_lead boolean := coalesce((p_row->>'toLead')::boolean, false); v_ok boolean;
begin
  v_ok := case when public.wbg_perm_on() then public.wbg_can(p_auth, 'feedback_write') else v_role in ('super_admin','executive') end;
  if not v_ok then return jsonb_build_object('error','not_allowed'); end if;
  if v_role = 'executive' then v_from := p_auth->>'title'; end if;
  if v_unit = '' or length(trim(coalesce(p_row->>'body',''))) = 0 or v_from not in ('CEO','DCEO','Group Strategy') then return jsonb_build_object('error','bad_request'); end if;
  if v_id is not null and exists (select 1 from public.feedback where id = v_id) then
    if v_role is distinct from 'super_admin' and (select by_name from public.feedback where id = v_id) <> v_name then return jsonb_build_object('error','not_allowed'); end if;
    update public.feedback set task_ref = coalesce(p_row->>'taskRef', task_ref), unit_id = v_unit, week = nullif(p_row->>'week','')::date, from_role = v_from, body = p_row->>'body',
           to_lead = case when p_row ? 'toLead' then v_lead else to_lead end where id = v_id;
  else
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    insert into public.feedback (id, unit_id, week, from_role, by_name, body, task_ref, to_lead) values (v_id, v_unit, nullif(p_row->>'week','')::date, v_from, v_name, p_row->>'body', coalesce(p_row->>'taskRef',''), v_lead);
  end if;
  perform public.wbg_add_activity(v_name, v_unit, nullif(p_row->>'week','')::date, jsonb_build_object('action','feedback','summary', case when v_lead then 'Letter from ' else 'Feedback from ' end || v_from));
  return jsonb_build_object('ok', true, 'id', v_id);
end $function$;

create or replace function public.wbg_delete_feedback(p_auth jsonb, p_id text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
declare p_auth jsonb := public.wbg_auth(); v_by text; v_own boolean;
begin
  select by_name into v_by from public.feedback where id = p_id;
  if v_by is null then return jsonb_build_object('error','not_found'); end if;
  v_own := v_by = trim(p_auth->>'name') and case when public.wbg_perm_on() then public.wbg_can(p_auth, 'feedback_write') else p_auth->>'role' = 'executive' end;
  if not (public.wbg_is_approver(p_auth) or v_own) then return jsonb_build_object('error','not_allowed'); end if;
  delete from public.feedback where id = p_id;
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.wbg_delete_reply(p_auth jsonb, p_id text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
declare a jsonb := public.wbg_auth(); v_r public.feedback_replies%rowtype;
begin
  select * into v_r from public.feedback_replies where id = p_id;
  if v_r.id is null then return jsonb_build_object('error','not_found'); end if;
  if not (public.wbg_is_approver(a) or v_r.by_uid = nullif(a->>'uid','')::uuid) then return jsonb_build_object('error','not_allowed'); end if;
  delete from public.feedback_replies where id = p_id;
  return jsonb_build_object('ok', true);
end $function$;

do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = 'wbg_save_reply';
  if d like '%wbg_perm_on%' then return; end if;
  if d not like E'%if v_role not in (''super_admin'',''executive'',''leader'',''planning'') or (v_role in (''leader'',''planning'') and a->>''unit'' is distinct from v_f.unit_id) then return jsonb_build_object(''error'',''not_allowed''); end if;%' then
    raise exception 'wbg_save_reply has changed, review before swapping';
  end if;
  execute replace(d, E'if v_role not in (''super_admin'',''executive'',''leader'',''planning'') or (v_role in (''leader'',''planning'') and a->>''unit'' is distinct from v_f.unit_id) then',
    E'if (case when public.wbg_perm_on() then not public.wbg_can(a, ''feedback_reply'', v_f.unit_id) else (v_role not in (''super_admin'',''executive'',''leader'',''planning'') or (v_role in (''leader'',''planning'') and a->>''unit'' is distinct from v_f.unit_id)) end) then');
end $$;

-- approval routing: an admin can skip a step (both steps are on by default, as before)
create or replace function public.wbg_route_stage(p_unit text, p_role text, p_depts text[]) returns text
 language plpgsql stable security definer set search_path to 'public' as $$
declare v_fn boolean := coalesce((select type = 'Corporate function' from public.units where id = p_unit), false); v_chief boolean; v_plan boolean;
begin
  select exists (select 1 from public.profiles p where p.unit_id = p_unit and public.wbg_base_role(p.role) = 'leader' and p.status = 'active' and p.setup_done) into v_chief;
  select exists (select 1 from public.profiles p where p.unit_id = p_unit and p.role = 'planning' and p.status = 'active' and p.setup_done) into v_plan;
  if coalesce(public.wbg_cfg('route_chief') = 'false'::jsonb, false) then v_chief := false; end if;
  if coalesce(public.wbg_cfg('route_planning') = 'false'::jsonb, false) then v_plan := false; end if;
  if p_role = 'planning' then return case when v_plan or not coalesce(public.wbg_cfg('route_planning') = 'false'::jsonb, false) then 'planning' else 'group' end; end if;
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

-- ============ me: the person's own capabilities ============
do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = 'wbg_me';
  if d like '%wbg_my_caps%' then return; end if;
  if d not like E'%''phone'', p.phone, ''jobTitle'', p.job_title);%' then raise exception 'wbg_me has changed, review before swapping'; end if;
  execute replace(d, E'''phone'', p.phone, ''jobTitle'', p.job_title);', E'''phone'', p.phone, ''jobTitle'', p.job_title, ''caps'', case when p.status = ''active'' and p.setup_done then public.wbg_my_caps() else ''{}''::jsonb end, ''permMode'', case when public.wbg_perm_on() then ''matrix'' else ''legacy'' end);');
end $$;

-- ============ admin API (super admin only, hard-wired) ============
create or replace function public.wbg__perm_snapshot(p_label text, p_by text) returns bigint language plpgsql security definer set search_path to 'public' as $$
declare v_id bigint;
begin
  insert into public.perm_snapshots (by_name, label, grants, config)
  values (p_by, p_label, coalesce((select jsonb_agg(to_jsonb(g)) from public.perm_grants g), '[]'::jsonb),
          coalesce((select jsonb_object_agg(key, value) from public.app_config where key in ('perm_mode','locked_fields','allow_rename','route_chief','route_planning','grace_time','extend_until')), '{}'::jsonb))
  returning id into v_id;
  delete from public.perm_snapshots where id < (select max(id) - 60 from public.perm_snapshots);
  return v_id;
end $$;

create or replace function public.wbg_admin_perm_get() returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare a jsonb := public.wbg_auth();
begin
  if not public.wbg_perm_admin(a) then return jsonb_build_object('error','not_allowed'); end if;
  return jsonb_build_object('ok', true,
    'mode', case when public.wbg_perm_on() then 'matrix' else 'legacy' end,
    'caps', (select coalesce(jsonb_agg(to_jsonb(c) order by c.sort), '[]'::jsonb) from public.perm_caps c),
    'grants', (select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'subject',subject,'cap',cap,'value',value)), '[]'::jsonb) from public.perm_grants),
    'defaults', (select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'subject',subject,'cap',cap,'value',value)), '[]'::jsonb) from public.perm_default_grants),
    'history', (select coalesce(jsonb_agg(to_jsonb(h) order by h.id desc), '[]'::jsonb) from (select * from public.perm_history order by id desc limit 150) h),
    'snapshots', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'at',at,'by',by_name,'label',label) order by id desc), '[]'::jsonb) from (select * from public.perm_snapshots order by id desc limit 15) s),
    'settings', public.wbg_settings());
end $$;

-- changes: [{kind, subject, cap, value}] ; value null/"" = remove the rule (fall back to the role)
create or replace function public.wbg_admin_perm_set(p_changes jsonb, p_note text default '') returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare a jsonb := public.wbg_auth(); c jsonb; v_batch uuid := gen_random_uuid(); v_kind text; v_sub text; v_cap text; v_val text; v_old text; v_levels text; n int := 0; v_name text := coalesce(a->>'name','');
begin
  if not public.wbg_perm_admin(a) then return jsonb_build_object('error','not_allowed'); end if;
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) = 0 or jsonb_array_length(p_changes) > 200 then return jsonb_build_object('error','bad_request'); end if;
  perform public.wbg__perm_snapshot('Before change: ' || left(coalesce(p_note,''), 80), v_name);
  for c in select * from jsonb_array_elements(p_changes) loop
    v_kind := c->>'kind'; v_sub := trim(coalesce(c->>'subject','')); v_cap := c->>'cap'; v_val := nullif(c->>'value','');
    select levels into v_levels from public.perm_caps where cap = v_cap;
    if v_levels is null or v_kind not in ('role','unit','user') or v_sub = '' then return jsonb_build_object('error','bad_request'); end if;
    if v_val is not null and not (v_val = any (string_to_array(v_levels, ','))) then return jsonb_build_object('error','bad_request', 'detail', v_cap || ' cannot be ' || v_val); end if;
    -- the super admin role cannot be edited, and no rule may be placed on a super admin person: nobody can lock the admins out
    if v_kind = 'role' and v_sub = 'super_admin' then return jsonb_build_object('error','protected', 'detail','Super admin access cannot be changed'); end if;
    if v_kind = 'user' and exists (select 1 from public.profiles where user_id::text = v_sub and role = 'super_admin') then return jsonb_build_object('error','protected', 'detail','Super admin access cannot be changed'); end if;
    if v_kind = 'user' and not exists (select 1 from public.profiles where user_id::text = v_sub) then return jsonb_build_object('error','bad_request'); end if;
    if v_kind = 'unit' and not exists (select 1 from public.units where id = v_sub) then return jsonb_build_object('error','bad_request'); end if;
    select value into v_old from public.perm_grants where kind = v_kind and subject = v_sub and cap = v_cap;
    if v_old is not distinct from v_val then continue; end if;
    if v_val is null then delete from public.perm_grants where kind = v_kind and subject = v_sub and cap = v_cap;
    else insert into public.perm_grants (kind, subject, cap, value, updated_by) values (v_kind, v_sub, v_cap, v_val, v_name)
         on conflict (kind, subject, cap) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now(); end if;
    insert into public.perm_history (by_name, batch, action, kind, subject, cap, old_value, new_value, note) values (v_name, v_batch, 'set', v_kind, v_sub, v_cap, v_old, v_val, left(coalesce(p_note,''), 300));
    n := n + 1;
  end loop;
  if n > 0 then perform public.wbg_add_activity(v_name, '', null, jsonb_build_object('action','user','summary','Changed ' || n || ' access rule(s)' || case when coalesce(p_note,'') <> '' then ': ' || left(p_note, 120) else '' end)); end if;
  return jsonb_build_object('ok', true, 'changed', n, 'batch', v_batch);
end $$;

create or replace function public.wbg_admin_perm_revert(p_batch uuid) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare a jsonb := public.wbg_auth(); h record; v_new uuid := gen_random_uuid(); v_name text := coalesce(a->>'name',''); n int := 0;
begin
  if not public.wbg_perm_admin(a) then return jsonb_build_object('error','not_allowed'); end if;
  perform public.wbg__perm_snapshot('Before revert', v_name);
  for h in select * from public.perm_history where batch = p_batch and action = 'set' order by id desc loop
    if h.old_value is null then delete from public.perm_grants where kind = h.kind and subject = h.subject and cap = h.cap;
    else insert into public.perm_grants (kind, subject, cap, value, updated_by) values (h.kind, h.subject, h.cap, h.old_value, v_name)
         on conflict (kind, subject, cap) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now(); end if;
    insert into public.perm_history (by_name, batch, action, kind, subject, cap, old_value, new_value, note) values (v_name, v_new, 'revert', h.kind, h.subject, h.cap, h.new_value, h.old_value, 'Reverted a change');
    n := n + 1;
  end loop;
  if n = 0 then return jsonb_build_object('error','not_found'); end if;
  perform public.wbg_add_activity(v_name, '', null, jsonb_build_object('action','user','summary','Reverted ' || n || ' access rule(s)'));
  return jsonb_build_object('ok', true, 'changed', n);
end $$;

create or replace function public.wbg_admin_perm_reset() returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare a jsonb := public.wbg_auth(); v_name text := coalesce(a->>'name','');
begin
  if not public.wbg_perm_admin(a) then return jsonb_build_object('error','not_allowed'); end if;
  perform public.wbg__perm_snapshot('Before reset to defaults', v_name);
  delete from public.perm_grants;
  insert into public.perm_grants (kind, subject, cap, value, updated_by) select kind, subject, cap, value, 'default' from public.perm_default_grants;
  insert into public.perm_history (by_name, batch, action, note) values (v_name, gen_random_uuid(), 'reset', 'All rules reset to the original defaults');
  perform public.wbg_add_activity(v_name, '', null, jsonb_build_object('action','user','summary','Reset all access rules to the defaults'));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.wbg_admin_perm_restore(p_snapshot bigint) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare a jsonb := public.wbg_auth(); s public.perm_snapshots%rowtype; v_name text := coalesce(a->>'name','');
begin
  if not public.wbg_perm_admin(a) then return jsonb_build_object('error','not_allowed'); end if;
  select * into s from public.perm_snapshots where id = p_snapshot;
  if not found then return jsonb_build_object('error','not_found'); end if;
  perform public.wbg__perm_snapshot('Before restoring snapshot ' || p_snapshot, v_name);
  delete from public.perm_grants;
  insert into public.perm_grants (kind, subject, cap, value, updated_by, updated_at)
    select x->>'kind', x->>'subject', x->>'cap', x->>'value', x->>'updated_by', coalesce((x->>'updated_at')::timestamptz, now()) from jsonb_array_elements(s.grants) x
    where exists (select 1 from public.perm_caps c where c.cap = x->>'cap');
  insert into public.perm_history (by_name, batch, action, note) values (v_name, gen_random_uuid(), 'restore', 'Restored the rules saved on ' || to_char(s.at, 'YYYY-MM-DD HH24:MI'));
  return jsonb_build_object('ok', true);
end $$;

-- switch between the old fixed rules and the matrix (a snapshot is taken first; switching back is always possible)
create or replace function public.wbg_admin_perm_mode(p_mode text) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare a jsonb := public.wbg_auth(); v_name text := coalesce(a->>'name','');
begin
  if not public.wbg_perm_admin(a) then return jsonb_build_object('error','not_allowed'); end if;
  if p_mode not in ('legacy','matrix') then return jsonb_build_object('error','bad_request'); end if;
  perform public.wbg__perm_snapshot('Before switching to ' || p_mode, v_name);
  if p_mode = 'matrix' and not exists (select 1 from public.perm_grants where kind = 'role' and subject = 'super_admin' and cap = 'approve_admin' and value = 'all') then
    return jsonb_build_object('error','protected', 'detail','The super admin rules are missing. Reset to defaults first.');
  end if;
  if exists (select 1 from public.app_config where key = 'perm_mode') then update public.app_config set value = to_jsonb(p_mode) where key = 'perm_mode';
  else insert into public.app_config (key, value) values ('perm_mode', to_jsonb(p_mode)); end if;
  insert into public.perm_history (by_name, batch, action, note) values (v_name, gen_random_uuid(), 'mode', 'Access rules mode: ' || p_mode);
  perform public.wbg_add_activity(v_name, '', null, jsonb_build_object('action','user','summary','Access rules mode set to ' || p_mode));
  return jsonb_build_object('ok', true, 'mode', p_mode);
end $$;

-- what can this person do right now?
create or replace function public.wbg_admin_perm_preview(p_user uuid) returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare a jsonb := public.wbg_auth(); b jsonb := public.wbg_auth_of(p_user);
begin
  if not public.wbg_perm_admin(a) then return jsonb_build_object('error','not_allowed'); end if;
  if b = '{}'::jsonb then return jsonb_build_object('error','not_found'); end if;
  return jsonb_build_object('ok', true, 'caps', (select jsonb_object_agg(c.cap, case public.wbg_cap_rank(b, c.cap) when 3 then 'all' when 2 then 'own' when 1 then 'dept' else 'none' end) from public.perm_caps c));
end $$;

-- settings: two new switches (locked fields, approval steps) on top of the existing three
create or replace function public.wbg_admin_set_setting(p_key text, p_value jsonb) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare a jsonb := public.wbg_auth(); v jsonb := p_value; s text; x text;
begin
  if not public.wbg_ap_settings(a) then return jsonb_build_object('error','not_allowed'); end if;
  if p_key = 'grace_time' then
    s := trim(coalesce(p_value #>> '{}', ''));
    if s !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then return jsonb_build_object('error','bad_request'); end if;
    v := to_jsonb(lpad(split_part(s, ':', 1), 2, '0') || ':' || split_part(s, ':', 2));
  elsif p_key = 'extend_until' then
    s := trim(coalesce(p_value #>> '{}', ''));
    if s <> '' then
      begin perform s::timestamp; exception when others then return jsonb_build_object('error','bad_request'); end;
      v := to_jsonb(left(replace(s, ' ', 'T'), 16));
    else v := to_jsonb(''::text); end if;
  elsif p_key in ('allow_rename','route_chief','route_planning') then
    if jsonb_typeof(p_value) <> 'boolean' then return jsonb_build_object('error','bad_request'); end if;
  elsif p_key = 'locked_fields' then
    if jsonb_typeof(p_value) <> 'array' then return jsonb_build_object('error','bad_request'); end if;
    for x in select jsonb_array_elements_text(p_value) loop
      if x not in ('title','kind','dept','outcome','priority','owner','due') then return jsonb_build_object('error','bad_request'); end if;
    end loop;
  else return jsonb_build_object('error','bad_request'); end if;
  if exists (select 1 from public.app_config where key = p_key) then update public.app_config set value = v where key = p_key;
  else insert into public.app_config (key, value) values (p_key, v); end if;
  perform public.wbg_add_activity(coalesce(a->>'name',''), '', null, jsonb_build_object('action','user',
    'summary', 'Changed the setting ' || p_key || ' to ' || coalesce(nullif(v #>> '{}', ''), case when jsonb_typeof(v) = 'array' then v::text else '(off)' end)));
  return jsonb_build_object('ok', true, 'settings', public.wbg_settings());
end $$;
