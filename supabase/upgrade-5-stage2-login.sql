-- WBG Weekly Activity Tracking · Upgrade 5 (Stage 2): real sign-in, roles and row-level security
-- Replaces unit PINs and the approver code with company-email sign-in (one-time code from Supabase Auth),
-- roles managed by Group Strategy, access rules enforced by the database, an audit trail and scoped undo.
-- Run it in Supabase: SQL Editor > New query > paste > Run. Safe to re-run.
-- Order: schema.sql, upgrade-1-safe.sql, upgrade-4-v3-stage1.sql (if not done), THEN this file.
-- IMPORTANT: after this file runs, the previous site version can no longer save (PINs are gone). Deploy the new site first
-- on a preview branch and test it against the TEST project only.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. People: profiles, invites, access requests
--    role: super_admin  Group Strategy (everything, manages people, approves, undoes anything)
--          executive    CEO / DCEO (views everything, writes feedback; title says which)
--          leader       Chief of a function, BU director or general manager (views everything, edits own unit)
--          planning     Planning department of a unit (views and edits everything in the unit, deletes)
--          manager      Manager or department head (views own unit, edits only own departments)
--          staff        Employee (sees and edits only own department)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  full_name  text not null default '',
  role       text not null default 'staff' check (role in ('super_admin','executive','leader','planning','manager','staff')),
  title      text not null default '',
  unit_id    text,
  departments jsonb not null default '[]'::jsonb,
  status     text not null default 'active' check (status in ('active','disabled')),
  setup_done boolean not null default false,       -- the person has entered their name
  invited    boolean not null default false,       -- unit, department and role were set by Group Strategy
  created_at timestamptz not null default now(),
  last_seen  timestamptz
);
create unique index if not exists profiles_email_idx on public.profiles (lower(email));

create table if not exists public.invites (
  email      text primary key,                      -- lower case
  full_name  text not null default '',
  role       text not null default 'staff' check (role in ('super_admin','executive','leader','planning','manager','staff')),
  title      text not null default '',
  unit_id    text,
  departments jsonb not null default '[]'::jsonb,
  invited_by text not null default '',
  created_at timestamptz not null default now(),
  used_at    timestamptz
);

create table if not exists public.access_requests (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  full_name  text not null,
  unit_id    text,
  contact    text not null default '',              -- WhatsApp or phone, so Group Strategy can confirm the person
  note       text not null default '',
  status     text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  decided_by text,
  decided_at timestamptz
);
create index if not exists access_requests_status_idx on public.access_requests (status, created_at desc);

alter table public.profiles        enable row level security;
alter table public.invites         enable row level security;   -- no policy: only through the functions below
alter table public.access_requests enable row level security;   -- no policy: only through the functions below

-- Allowed company email domains (Group Strategy can change them). Check the spelling of each one.
insert into public.app_config (key, value) values
  ('allowed_domains', '["wagwagoelectric.com","geezinstitute.com","wanzalogistics.com","niyatconsultancy.com","niyatconsultnacy.com","trucksload.net"]'::jsonb)
on conflict (key) do nothing;

-- The first Group Strategy super admin. They sign in with this email and then manage everyone else.
insert into public.invites (email, full_name, role, title, unit_id, invited_by)
select 'surafel.h@wagwagoelectric.com', 'Surafel Hailu', 'super_admin', 'Group Strategy',
       (select id from public.units where id = 'group-strategy-office'), 'setup'
on conflict (email) do nothing;

-- Only company emails (or invited emails) can create an account.
create or replace function public.wbg_guard_signup() returns trigger
language plpgsql security definer set search_path = public as $$
declare d text := lower(split_part(coalesce(new.email,''), '@', 2));
begin
  if new.email is null or new.email = '' then return new; end if;
  if exists (select 1 from public.app_config c, jsonb_array_elements_text(c.value) x
             where c.key = 'allowed_domains' and lower(trim(x)) = d) then return new; end if;
  if exists (select 1 from public.invites where email = lower(new.email)) then return new; end if;
  raise exception 'This email is not allowed. Use your company email, or ask Group Strategy for an invite.';
end $$;
drop trigger if exists wbg_guard_signup on auth.users;
create trigger wbg_guard_signup before insert on auth.users for each row execute function public.wbg_guard_signup();

-- ---------------------------------------------------------------------------
-- 2. Who is calling? (from the sign-in session, never from what the browser says)
-- ---------------------------------------------------------------------------
create or replace function public.wbg_auth() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('uid', user_id, 'name', trim(full_name), 'email', email, 'role', role, 'title', title,
                          'unit', unit_id, 'departments', departments)
                   from public.profiles where user_id = auth.uid() and status = 'active' and setup_done), '{}'::jsonb)
$$;

drop function if exists public.wbg_is_approver(jsonb);
drop function if exists public.wbg_unit_ok(jsonb, text);
create or replace function public.wbg_is_approver(a jsonb) returns boolean
language sql immutable as $$ select coalesce(a->>'role' = 'super_admin', false) $$;
-- a member of that unit who edits (any of the four unit roles)
create or replace function public.wbg_unit_ok(a jsonb, p_unit text) returns boolean
language sql immutable as $$ select coalesce(a->>'role' in ('leader','planning','manager','staff') and a->>'unit' = p_unit, false) $$;
-- a unit member who can see and work with the unit as a whole (not a plain employee)
create or replace function public.wbg_unit_lead(a jsonb, p_unit text) returns boolean
language sql immutable as $$ select coalesce(a->>'role' in ('leader','planning','manager') and a->>'unit' = p_unit, false) $$;
-- may this person change tasks of this department in this unit?
create or replace function public.wbg_dept_ok(a jsonb, p_unit text, p_dept text) returns boolean
language sql immutable as $$
  select case a->>'role'
    when 'super_admin' then true
    when 'leader'      then a->>'unit' = p_unit
    when 'planning'    then a->>'unit' = p_unit
    when 'manager'     then a->>'unit' = p_unit and coalesce(p_dept,'') <> '' and coalesce(a->'departments','[]'::jsonb) ? p_dept
    when 'staff'       then a->>'unit' = p_unit and coalesce(p_dept,'') <> '' and coalesce(a->'departments','[]'::jsonb) ? p_dept
    else false end
$$;

-- row level security helpers (read access)
create or replace function public.wbg_full_read() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.wbg_auth()->>'role' in ('super_admin','executive','leader'), false)
$$;
create or replace function public.wbg_unit_read(p_unit text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.wbg_auth()->>'role' in ('super_admin','executive','leader')
    or (public.wbg_auth()->>'role' in ('planning','manager') and public.wbg_auth()->>'unit' = p_unit), false)
$$;
create or replace function public.wbg_active() returns boolean
language sql stable security definer set search_path = public as $$ select public.wbg_auth() <> '{}'::jsonb $$;

-- ---------------------------------------------------------------------------
-- 3. Row level security: signed-in people only, each role sees its own scope
-- ---------------------------------------------------------------------------
drop policy if exists "open access" on public.units;
drop policy if exists "open access" on public.plans;
drop policy if exists "open access" on public.activity;
drop policy if exists "read" on public.units;           create policy "read" on public.units           for select to authenticated using (public.wbg_active());
drop policy if exists "read" on public.plans;           create policy "read" on public.plans           for select to authenticated using (public.wbg_unit_read(unit_id));
drop policy if exists "read" on public.activity;        create policy "read" on public.activity        for select to authenticated
  using (public.wbg_unit_read(nullif(unit_id,'')) or (nullif(unit_id,'') is null and public.wbg_full_read()));
drop policy if exists "read" on public.row_history;     create policy "read" on public.row_history     for select to authenticated
  using (public.wbg_unit_read(case when tbl = 'plans' then old_row->>'unit_id' else row_id end));
drop policy if exists "read" on public.change_requests; create policy "read" on public.change_requests for select to authenticated using (public.wbg_unit_read(unit_id));
drop policy if exists "read" on public.app_config;      create policy "read" on public.app_config      for select to authenticated using (public.wbg_active());
drop policy if exists "read" on public.support_requests;   create policy "read" on public.support_requests   for select to authenticated using (public.wbg_unit_read(function_id));
drop policy if exists "read" on public.feedback;           create policy "read" on public.feedback           for select to authenticated using (public.wbg_unit_read(unit_id));
drop policy if exists "read" on public.corrective_actions; create policy "read" on public.corrective_actions for select to authenticated using (public.wbg_unit_read(unit_id));
drop policy if exists "own or admin" on public.profiles;
create policy "own or admin" on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.wbg_auth()->>'role' = 'super_admin');

revoke all on public.units, public.plans, public.activity, public.row_history, public.change_requests, public.app_config,
  public.support_requests, public.feedback, public.corrective_actions, public.profiles, public.invites, public.access_requests from anon;
revoke insert, update, delete, truncate on public.units, public.plans, public.activity, public.row_history, public.change_requests,
  public.app_config, public.support_requests, public.feedback, public.corrective_actions, public.profiles, public.invites, public.access_requests from authenticated;

grant select on public.units, public.plans, public.activity, public.row_history, public.change_requests, public.app_config,
  public.support_requests, public.feedback, public.corrective_actions, public.profiles to authenticated;

do $$
begin
  begin execute 'alter publication supabase_realtime add table public.profiles'; exception when duplicate_object then null; when undefined_object then null; end;
end $$;

-- Evidence files: signed-in people only; the second part of the path is the unit.
do $$
begin
  execute 'drop policy if exists "evidence upload" on storage.objects';
  execute 'drop policy if exists "evidence read" on storage.objects';
  execute $p$create policy "evidence upload" on storage.objects for insert to authenticated
    with check (bucket_id = 'evidence' and (public.wbg_auth()->>'role' = 'super_admin'
      or (public.wbg_auth()->>'role' in ('leader','planning','manager','staff') and public.wbg_auth()->>'unit' = split_part(name, '/', 2))))$p$;
  execute $p$create policy "evidence read" on storage.objects for select to authenticated
    using (bucket_id = 'evidence' and (public.wbg_full_read() or public.wbg_auth()->>'unit' = split_part(name, '/', 2)))$p$;
exception when undefined_table or invalid_schema_name then
  raise notice 'Storage schema not found: evidence policies not changed.';
end $$;

-- ---------------------------------------------------------------------------
-- 4. Sign-in and sign-up functions
-- ---------------------------------------------------------------------------
-- Before sending a code: is this email allowed? (anyone may ask, nothing else is revealed)
create or replace function public.wbg_check_email(p_email text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare e text := lower(trim(coalesce(p_email,''))); d text := split_part(lower(trim(coalesce(p_email,''))), '@', 2);
begin
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return jsonb_build_object('allowed', false, 'reason', 'bad_email'); end if;
  return jsonb_build_object('allowed',
    exists (select 1 from public.app_config c, jsonb_array_elements_text(c.value) x where c.key = 'allowed_domains' and lower(trim(x)) = d)
    or exists (select 1 from public.invites where email = e)
    or exists (select 1 from public.profiles where lower(email) = e));
end $$;

-- Unit names for the "request access" form (public information, no staff data).
create or replace function public.wbg_public_units() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'type', type, 'departments', departments) order by type, sort_order, name), '[]'::jsonb) from public.units
$$;

-- A person without a company email asks Group Strategy for access (they leave a WhatsApp number to be confirmed).
create or replace function public.wbg_request_access(p_email text, p_name text, p_unit text, p_contact text, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(coalesce(p_email,'')));
begin
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(trim(coalesce(p_name,''))) < 3 then return jsonb_build_object('error','bad_request'); end if;
  if length(trim(coalesce(p_contact,''))) < 5 then return jsonb_build_object('error','contact_needed'); end if;
  if (select count(*) from public.access_requests where status = 'pending') >= 300
     or (select count(*) from public.access_requests where lower(email) = e and created_at > now() - interval '1 day') >= 3 then
    return jsonb_build_object('error','too_many');
  end if;
  insert into public.access_requests (email, full_name, unit_id, contact, note)
  values (e, left(trim(p_name), 120), nullif(p_unit,''), left(trim(p_contact), 60), left(coalesce(p_note,''), 500));
  return jsonb_build_object('ok', true);
end $$;

-- Who am I? Creates the profile on the first sign-in (company email, or an invite) and returns it.
create or replace function public.wbg_me() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_email text; p public.profiles%rowtype; inv public.invites%rowtype; v_dom boolean;
begin
  if v_uid is null then return jsonb_build_object('status','signed_out'); end if;
  select * into p from public.profiles where user_id = v_uid;
  if not found then
    select email into v_email from auth.users where id = v_uid;
    select * into inv from public.invites where email = lower(v_email);
    if found then
      insert into public.profiles (user_id, email, full_name, role, title, unit_id, departments, invited)
      values (v_uid, v_email, inv.full_name, inv.role, inv.title, inv.unit_id, inv.departments, true) returning * into p;
      update public.invites set used_at = now() where email = inv.email;
    else
      select exists (select 1 from public.app_config c, jsonb_array_elements_text(c.value) x
                     where c.key = 'allowed_domains' and lower(trim(x)) = split_part(lower(v_email), '@', 2)) into v_dom;
      if not v_dom then return jsonb_build_object('status','none'); end if;
      insert into public.profiles (user_id, email) values (v_uid, v_email) returning * into p;
    end if;
    perform public.wbg_add_activity(coalesce(nullif(p.full_name,''), p.email), coalesce(p.unit_id,''), null,
      jsonb_build_object('action','user','summary','First sign-in: ' || p.email || case when p.invited then ' (invited as ' || p.role || ')' else ' (company email)' end));
  end if;
  update public.profiles set last_seen = now() where user_id = v_uid;
  return jsonb_build_object('status', p.status, 'setupDone', p.setup_done, 'invited', p.invited, 'id', p.user_id, 'email', p.email,
    'name', p.full_name, 'role', p.role, 'title', p.title, 'unit', p.unit_id, 'departments', p.departments);
end $$;

-- First-time sign-up: the person enters their name (shown as "updated by"); company-email people also choose unit and departments.
create or replace function public.wbg_complete_signup(p_name text, p_unit text, p_departments jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.profiles%rowtype; v_deps jsonb := coalesce(p_departments, '[]'::jsonb); v_ok boolean;
begin
  select * into p from public.profiles where user_id = auth.uid();
  if not found or p.status <> 'active' then return jsonb_build_object('error','not_allowed'); end if;
  if length(trim(coalesce(p_name,''))) < 3 then return jsonb_build_object('error','name_needed'); end if;
  if p.invited then
    update public.profiles set full_name = left(trim(p_name), 120), setup_done = true where user_id = p.user_id;
  else
    if p.setup_done then return jsonb_build_object('error','not_allowed'); end if;   -- afterwards only Group Strategy changes unit and roles
    if not exists (select 1 from public.units where id = p_unit) then return jsonb_build_object('error','unit_needed'); end if;
    select coalesce(bool_and(u.departments ? d), true) into v_ok
      from public.units u, jsonb_array_elements_text(v_deps) d where u.id = p_unit;
    if not coalesce(v_ok, true) or jsonb_array_length(v_deps) = 0 and jsonb_array_length((select departments from public.units where id = p_unit)) > 0 then
      return jsonb_build_object('error','department_needed');
    end if;
    update public.profiles set full_name = left(trim(p_name), 120), unit_id = p_unit, departments = v_deps, setup_done = true where user_id = p.user_id;
  end if;
  perform public.wbg_add_activity(left(trim(p_name),120), coalesce((select unit_id from public.profiles where user_id = p.user_id),''), null,
    jsonb_build_object('action','user','summary','Signed up: ' || left(trim(p_name),120) || ' (' || p.email || ')'));
  return public.wbg_me();
end $$;

-- ---------------------------------------------------------------------------
-- 5. People management (Group Strategy only)
-- ---------------------------------------------------------------------------
create or replace function public.wbg_admin_users() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.wbg_is_approver(public.wbg_auth()) then return jsonb_build_object('error','not_allowed'); end if;
  return jsonb_build_object('ok', true,
    'users', coalesce((select jsonb_agg(jsonb_build_object('id', p.user_id, 'email', p.email, 'name', p.full_name, 'role', p.role, 'title', p.title,
        'unit', p.unit_id, 'departments', p.departments, 'status', p.status, 'setupDone', p.setup_done, 'invited', p.invited,
        'createdAt', p.created_at, 'lastSeen', p.last_seen) order by p.created_at desc) from public.profiles p), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('email', i.email, 'name', i.full_name, 'role', i.role, 'title', i.title, 'unit', i.unit_id,
        'departments', i.departments, 'invitedBy', i.invited_by, 'createdAt', i.created_at) order by i.created_at desc) from public.invites i where i.used_at is null), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'email', r.email, 'name', r.full_name, 'unit', r.unit_id, 'contact', r.contact,
        'note', r.note, 'status', r.status, 'createdAt', r.created_at) order by r.created_at desc) from public.access_requests r where r.status = 'pending'), '[]'::jsonb),
    'domains', coalesce((select value from public.app_config where key = 'allowed_domains'), '[]'::jsonb));
end $$;

create or replace function public.wbg__check_person(p jsonb) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(p->>'role','') not in ('super_admin','executive','leader','planning','manager','staff') then return 'bad_role'; end if;
  if p->>'role' = 'executive' and coalesce(p->>'title','') not in ('CEO','DCEO') then return 'title_needed'; end if;
  if p->>'role' in ('leader','planning','manager','staff') and not exists (select 1 from public.units where id = p->>'unit') then return 'unit_needed'; end if;
  if p->>'role' in ('manager','staff') and jsonb_array_length(coalesce(p->'departments','[]'::jsonb)) = 0 then return 'department_needed'; end if;
  return null;
end $$;

create or replace function public.wbg_admin_save_user(p_user uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wbg_auth(); o public.profiles%rowtype; v_err text; v_status text; v_sum text;
begin
  if not public.wbg_is_approver(a) then return jsonb_build_object('error','not_allowed'); end if;
  select * into o from public.profiles where user_id = p_user;
  if not found then return jsonb_build_object('error','not_found'); end if;
  v_status := coalesce(nullif(p_data->>'status',''), o.status);
  if v_status not in ('active','disabled') then return jsonb_build_object('error','bad_request'); end if;
  v_err := public.wbg__check_person(jsonb_build_object('role', coalesce(p_data->>'role', o.role), 'title', coalesce(p_data->>'title', o.title),
            'unit', coalesce(p_data->>'unit', o.unit_id), 'departments', coalesce(p_data->'departments', o.departments)));
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  if p_user = (a->>'uid')::uuid and (coalesce(p_data->>'role', o.role) <> 'super_admin' or v_status <> 'active') then
    return jsonb_build_object('error','cannot_change_self');
  end if;
  update public.profiles set
    full_name = coalesce(nullif(trim(p_data->>'name'),''), full_name), role = coalesce(p_data->>'role', role), title = coalesce(p_data->>'title', title),
    unit_id = case when p_data ? 'unit' then nullif(p_data->>'unit','') else unit_id end, departments = coalesce(p_data->'departments', departments),
    status = v_status, invited = case when p_data ? 'role' or p_data ? 'unit' or p_data ? 'departments' then true else invited end
  where user_id = p_user;
  -- disabling takes effect on the very next request: every function and policy checks the profile status
  update auth.users set banned_until = case when v_status = 'disabled' then 'infinity'::timestamptz else null end where id = p_user;
  v_sum := case when v_status = 'disabled' and o.status <> 'disabled' then 'Disabled ' when v_status = 'active' and o.status = 'disabled' then 'Re-enabled ' else 'Updated ' end
           || o.email || ' (' || coalesce(p_data->>'role', o.role) || case when coalesce(p_data->>'unit', o.unit_id) is not null then ', ' || coalesce(p_data->>'unit', o.unit_id) else '' end || ')';
  perform public.wbg_add_activity(a->>'name', coalesce(p_data->>'unit', o.unit_id, ''), null,
    jsonb_build_object('action','user','summary', v_sum,
      'details', jsonb_build_array('Before: ' || o.role || ' · ' || coalesce(o.unit_id,'-') || ' · ' || o.departments::text || ' · ' || o.status,
                                   'After: ' || coalesce(p_data->>'role', o.role) || ' · ' || coalesce(p_data->>'unit', o.unit_id, '-') || ' · ' || coalesce(p_data->'departments', o.departments)::text || ' · ' || v_status)));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.wbg_admin_invite(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wbg_auth(); e text := lower(trim(coalesce(p_data->>'email',''))); v_err text;
begin
  if not public.wbg_is_approver(a) then return jsonb_build_object('error','not_allowed'); end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return jsonb_build_object('error','bad_email'); end if;
  if exists (select 1 from public.profiles where lower(email) = e) then return jsonb_build_object('error','already_registered'); end if;
  v_err := public.wbg__check_person(p_data);
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  insert into public.invites (email, full_name, role, title, unit_id, departments, invited_by)
  values (e, left(trim(coalesce(p_data->>'name','')),120), p_data->>'role', coalesce(p_data->>'title',''), nullif(p_data->>'unit',''), coalesce(p_data->'departments','[]'::jsonb), a->>'name')
  on conflict (email) do update set full_name = excluded.full_name, role = excluded.role, title = excluded.title, unit_id = excluded.unit_id,
    departments = excluded.departments, invited_by = excluded.invited_by, used_at = null;
  perform public.wbg_add_activity(a->>'name', coalesce(p_data->>'unit',''), null, jsonb_build_object('action','user','summary','Invited ' || e || ' as ' || (p_data->>'role')));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.wbg_admin_delete_invite(p_email text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.wbg_is_approver(public.wbg_auth()) then return jsonb_build_object('error','not_allowed'); end if;
  delete from public.invites where email = lower(trim(p_email)) and used_at is null;
  return jsonb_build_object('ok', true);
end $$;

-- Approve (creates an invite with the role you choose) or reject an access request.
create or replace function public.wbg_admin_decide_access(p_id uuid, p_approve boolean, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wbg_auth(); r public.access_requests%rowtype; v_res jsonb;
begin
  if not public.wbg_is_approver(a) then return jsonb_build_object('error','not_allowed'); end if;
  select * into r from public.access_requests where id = p_id and status = 'pending' for update;
  if not found then return jsonb_build_object('error','not_found'); end if;
  if p_approve then
    v_res := public.wbg_admin_invite(coalesce(p_data, '{}'::jsonb) || jsonb_build_object('email', r.email, 'name', r.full_name));
    if v_res ? 'error' then return v_res; end if;
  end if;
  update public.access_requests set status = case when p_approve then 'approved' else 'rejected' end, decided_by = a->>'name', decided_at = now() where id = p_id;
  perform public.wbg_add_activity(a->>'name', '', null, jsonb_build_object('action','user','summary', (case when p_approve then 'Approved' else 'Rejected' end) || ' access request from ' || r.email));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.wbg_admin_set_domains(p_domains jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wbg_auth();
begin
  if not public.wbg_is_approver(a) then return jsonb_build_object('error','not_allowed'); end if;
  if jsonb_typeof(p_domains) <> 'array' or jsonb_array_length(p_domains) = 0 then return jsonb_build_object('error','bad_request'); end if;
  update public.app_config set value = (select jsonb_agg(distinct lower(trim(x))) from jsonb_array_elements_text(p_domains) x where trim(x) ~ '^[a-z0-9.-]+\.[a-z]{2,}$') where key = 'allowed_domains';
  perform public.wbg_add_activity(a->>'name', '', null, jsonb_build_object('action','user','summary','Changed the allowed email domains'));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Plans
-- ---------------------------------------------------------------------------
-- Plans for people who may see only their own department: the tasks of other departments are removed on the server.
create or replace function public.wbg_read_plans(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a jsonb := public.wbg_auth();
begin
  if a = '{}'::jsonb then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'week', p.week, 'unit_id', p.unit_id,
      'tasks', case when a->>'role' = 'staff' then coalesce((select jsonb_agg(t) from jsonb_array_elements(p.tasks) t
                                                          where coalesce(a->'departments','[]'::jsonb) ? coalesce(t->>'dept','')), '[]'::jsonb) else p.tasks end,
      'wins', case when a->>'role' = 'staff' then '' else p.wins end, 'blockers', case when a->>'role' = 'staff' then '' else p.blockers end,
      'asks', case when a->>'role' = 'staff' then '' else p.asks end, 'updated_at', p.updated_at, 'updated_by', p.updated_by, 'source', p.source))
    from public.plans p
    where (p_from is null or p.week >= p_from) and (p_to is null or p.week <= p_to)
      and (public.wbg_unit_read(p.unit_id) or (a->>'role' = 'staff' and a->>'unit' = p.unit_id))), '[]'::jsonb);
end $$;

-- Merge for restores by department-limited roles: keep other departments as they are now, take the old version of mine.
create or replace function public.wbg__merge_scope(a jsonb, p_unit text, p_current jsonb, p_source jsonb) returns jsonb
language sql stable set search_path = public as $$
  select coalesce((select jsonb_agg(t) from jsonb_array_elements(coalesce(p_current,'[]'::jsonb)) t where not public.wbg_dept_ok(a, p_unit, coalesce(t->>'dept',''))), '[]'::jsonb)
      || coalesce((select jsonb_agg(t) from jsonb_array_elements(coalesce(p_source,'[]'::jsonb)) t where public.wbg_dept_ok(a, p_unit, coalesce(t->>'dept',''))), '[]'::jsonb)
$$;

-- Save one weekly plan.
--   super_admin: any plan, any change.  executive: never.
--   leader / planning (own unit): current and future weeks, any change including locked fields and removals.
--   manager / staff (own unit): only tasks of their own departments. Once a week has started, saved tasks keep title, type,
--     department, outcome, due date and priority, and cannot be removed: those go through wbg_request_change.
--   Past weeks: everyone except super_admin goes through wbg_request_change.
create or replace function public.wbg_save_plan(p_auth jsonb, p_plan jsonb, p_base timestamptz default null, p_force boolean default false, p_activity jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p_auth jsonb := public.wbg_auth();
  v_role text := p_auth->>'role'; v_name text := trim(coalesce(p_auth->>'name',''));
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

-- Restore a plan or unit to a saved copy from row_history. The version being replaced is kept too.
--   super_admin: anything.  leader / planning: plans of their own unit.  manager: only the tasks of their own departments.
--   staff and executive: no.
create or replace function public.wbg_restore_version(p_auth jsonb, p_history_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); v_role text := p_auth->>'role'; v_h public.row_history%rowtype; v_name text := trim(coalesce(p_auth->>'name',''));
        r jsonb; v_cur public.plans%rowtype; v_tasks jsonb;
begin
  if v_role is null or v_role in ('staff','executive') then return jsonb_build_object('error','not_allowed'); end if;
  select * into v_h from public.row_history where id = p_history_id;
  if not found then return jsonb_build_object('error','not_found'); end if;
  r := v_h.old_row;
  if v_h.tbl = 'plans' then
    if v_role <> 'super_admin' and coalesce(p_auth->>'unit','') <> (r->>'unit_id') then return jsonb_build_object('error','not_allowed'); end if;
    if v_role <> 'super_admin' and (r->>'week')::date < public.wbg_monday() then return jsonb_build_object('error','not_allowed'); end if;
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

-- Undo your own last save within 30 minutes (not for plain employees).
create or replace function public.wbg_undo_last_save(p_auth jsonb, p_plan_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); v_role text := p_auth->>'role'; v_p public.plans%rowtype; v_h public.row_history%rowtype;
        v_name text := trim(coalesce(p_auth->>'name','')); r jsonb;
begin
  if v_role is null or v_role in ('staff','executive') then return jsonb_build_object('error','not_allowed'); end if;
  select * into v_p from public.plans where id = p_plan_id;
  if not found then return jsonb_build_object('error','not_found'); end if;
  if v_role <> 'super_admin' and coalesce(p_auth->>'unit','') <> v_p.unit_id then return jsonb_build_object('error','not_allowed'); end if;
  if v_p.updated_by is distinct from v_name or v_p.updated_at < now() - interval '30 minutes' then return jsonb_build_object('error','too_late'); end if;
  select * into v_h from public.row_history where tbl = 'plans' and row_id = p_plan_id and op <> 'SNAPSHOT' order by changed_at desc, id desc limit 1;
  if not found or v_h.changed_at < v_p.updated_at - interval '5 seconds' then return jsonb_build_object('error','not_found'); end if;
  r := v_h.old_row;
  update public.plans set tasks = coalesce(r->'tasks','[]'::jsonb), wins = coalesce(r->>'wins',''), blockers = coalesce(r->>'blockers',''), asks = coalesce(r->>'asks',''),
    updated_at = now(), updated_by = v_name, source = 'Undo' where id = p_plan_id;
  perform public.wbg_add_activity(v_name, v_p.unit_id, v_p.week, jsonb_build_object('action','restore','summary','Undid the last save'));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Units and departments
--    Group Strategy: add, rename, change type, remove, change any list.
--    Planning / leader (own unit): departments and staff names. Manager (own unit): staff names only.
--    Departments are never created by accident: they change only here (and in the Units tab), never from an Excel import.
-- ---------------------------------------------------------------------------
create or replace function public.wbg_save_unit(p_auth jsonb, p_op text, p_data jsonb, p_summary text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); v_id text := p_data->>'id'; v_name text := trim(coalesce(p_auth->>'name','')); v_role text := p_auth->>'role';
begin
  if v_id is null or v_id = '' then return jsonb_build_object('error','bad_request'); end if;
  if p_op = 'lists' then
    if v_role is null or v_role = 'executive' or v_role = 'staff' then return jsonb_build_object('error','not_allowed'); end if;
    if v_role <> 'super_admin' and p_auth->>'unit' <> v_id then return jsonb_build_object('error','not_allowed'); end if;
    if p_data ? 'departments' and v_role not in ('super_admin','planning','leader') then return jsonb_build_object('error','not_allowed'); end if;
    update public.units set departments = coalesce(p_data->'departments', departments), people = coalesce(p_data->'people', people) where id = v_id;
  elsif v_role <> 'super_admin' then
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
end $$;

-- ---------------------------------------------------------------------------
-- 8. Feedback: CEO, DCEO and Group Strategy write it. A CEO or DCEO writes as themselves; Group Strategy may write as any of the three.
-- ---------------------------------------------------------------------------
create or replace function public.wbg_save_feedback(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); v_role text := p_auth->>'role'; v_unit text := coalesce(p_row->>'unit',''); v_id text := nullif(p_row->>'id','');
        v_name text := trim(coalesce(p_auth->>'name','')); v_from text := coalesce(nullif(p_row->>'from',''),'Group Strategy');
begin
  if v_role not in ('super_admin','executive') then return jsonb_build_object('error','not_allowed'); end if;
  if v_role = 'executive' then v_from := p_auth->>'title'; end if;
  if v_unit = '' or length(trim(coalesce(p_row->>'body',''))) = 0 or v_from not in ('CEO','DCEO','Group Strategy') then return jsonb_build_object('error','bad_request'); end if;
  if v_id is not null and exists (select 1 from public.feedback where id = v_id) then
    if v_role = 'executive' and (select by_name from public.feedback where id = v_id) <> v_name then return jsonb_build_object('error','not_allowed'); end if;
    update public.feedback set unit_id = v_unit, week = nullif(p_row->>'week','')::date, from_role = v_from, body = p_row->>'body' where id = v_id;
  else
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    insert into public.feedback (id, unit_id, week, from_role, by_name, body) values (v_id, v_unit, nullif(p_row->>'week','')::date, v_from, v_name, p_row->>'body');
  end if;
  perform public.wbg_add_activity(v_name, v_unit, nullif(p_row->>'week','')::date, jsonb_build_object('action','feedback','summary','Feedback from ' || v_from));
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.wbg_delete_feedback(p_auth jsonb, p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); v_by text;
begin
  select by_name into v_by from public.feedback where id = p_id;
  if v_by is null then return jsonb_build_object('error','not_found'); end if;
  if not (public.wbg_is_approver(p_auth) or (p_auth->>'role' = 'executive' and v_by = trim(p_auth->>'name'))) then return jsonb_build_object('error','not_allowed'); end if;
  delete from public.feedback where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- 9. Functions carried over from earlier versions. The caller is now taken from the sign-in session
--    (wbg_auth), never from what the browser sends, so the name saved with every change is the person's real name.
-- ---------------------------------------------------------------------------
create or replace function public.wbg_request_change(p_auth jsonb, p_req jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text := p_req->>'unit'; v_week date := (p_req->>'week')::date; v_name text := trim(coalesce(p_auth->>'name',''));
begin
  if v_unit is null or v_week is null or jsonb_typeof(p_req->'patch') <> 'array' then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_unit_ok(p_auth, v_unit) and not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  insert into public.change_requests (id, unit_id, week, plan_id, requested_by, summary, details, patch)
  values (coalesce(nullif(p_req->>'id',''), md5(random()::text || clock_timestamp()::text)), v_unit, v_week, to_char(v_week,'YYYY-MM-DD') || '_' || v_unit,
          v_name, coalesce(p_req->>'summary',''), coalesce(p_req->'details','[]'::jsonb), p_req->'patch');
  perform public.wbg_add_activity(v_name, v_unit, v_week, jsonb_build_object('action','request','summary','Asked for approval: ' || coalesce(p_req->>'summary',''), 'details', coalesce(p_req->'details','[]'::jsonb)));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.wbg_decide_request(p_auth jsonb, p_id text, p_approve boolean, p_note text default '', p_plan jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); v_req public.change_requests%rowtype; v_name text := trim(coalesce(p_auth->>'name','')); v_res jsonb;
begin
  if not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  select * into v_req from public.change_requests where id = p_id for update;
  if not found or v_req.status <> 'pending' then return jsonb_build_object('error','not_pending'); end if;
  if p_approve then
    if p_plan is null then return jsonb_build_object('error','bad_request'); end if;
    v_res := public.wbg_save_plan(p_auth, p_plan || jsonb_build_object('unit', v_req.unit_id, 'week', v_req.week), null, true, null);
    if v_res ? 'error' then return v_res; end if;
  end if;
  update public.change_requests set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = v_name, decided_at = now(), decision_note = coalesce(p_note,'') where id = p_id;
  perform public.wbg_add_activity(v_name, v_req.unit_id, v_req.week, jsonb_build_object('action','approval',
    'summary', (case when p_approve then 'Approved' else 'Rejected' end) || ' request from ' || v_req.requested_by || ': ' || v_req.summary || case when coalesce(p_note,'') <> '' then ' · Note: ' || p_note else '' end,
    'details', v_req.details));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.wbg_withdraw_request(p_auth jsonb, p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); v_req public.change_requests%rowtype;
begin
  select * into v_req from public.change_requests where id = p_id for update;
  if not found or v_req.status <> 'pending' then return jsonb_build_object('error','not_pending'); end if;
  if not public.wbg_unit_ok(p_auth, v_req.unit_id) and not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  update public.change_requests set status = 'withdrawn', decided_by = trim(coalesce(p_auth->>'name','')), decided_at = now() where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.wbg_log(p_auth jsonb, p_entry jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text := coalesce(p_entry->>'unit','');
begin
  if not public.wbg_is_approver(p_auth) and not public.wbg_unit_ok(p_auth, v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  perform public.wbg_add_activity(trim(p_auth->>'name'), v_unit, nullif(p_entry->>'week','')::date, p_entry);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.wbg_restore_backup(p_auth jsonb, p_backup jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); u jsonb; p jsonb; nu int := 0; np int := 0; v_name text := trim(coalesce(p_auth->>'name',''));
begin
  if not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  for u in select * from jsonb_array_elements(coalesce(p_backup->'units','[]'::jsonb)) loop
    insert into public.units (id, name, type, sort_order, departments, people)
    values (u->>'id', u->>'name', coalesce(u->>'type','Business unit'), coalesce((u->>'order')::int, 99), coalesce(u->'departments','[]'::jsonb), coalesce(u->'people','[]'::jsonb))
    on conflict (id) do update set name = excluded.name, type = excluded.type, sort_order = excluded.sort_order, departments = excluded.departments, people = excluded.people;
    nu := nu + 1;
  end loop;
  for p in select * from jsonb_array_elements(coalesce(p_backup->'plans','[]'::jsonb)) loop
    insert into public.plans (id, week, unit_id, tasks, wins, blockers, asks, updated_at, updated_by, source)
    values (p->>'id', (p->>'week')::date, p->>'unit', coalesce(p->'tasks','[]'::jsonb), coalesce(p->>'wins',''), coalesce(p->>'blockers',''), coalesce(p->>'asks',''),
            coalesce((p->>'updatedAt')::timestamptz, now()), coalesce(p->>'updatedBy',''), coalesce(p->>'source',''))
    on conflict (id) do update set tasks = excluded.tasks, wins = excluded.wins, blockers = excluded.blockers, asks = excluded.asks,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by, source = excluded.source
    where public.plans.tasks is distinct from excluded.tasks or public.plans.wins is distinct from excluded.wins
       or public.plans.blockers is distinct from excluded.blockers or public.plans.asks is distinct from excluded.asks;
    np := np + 1;
  end loop;
  perform public.wbg_add_activity(v_name, '', null, jsonb_build_object('action','restore','summary', format('Restored from backup file: %s units, %s plans', nu, np)));
  return jsonb_build_object('ok', true, 'units', nu, 'plans', np);
end $$;

create or replace function public.wbg_save_support(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); v_fn text := coalesce(p_row->>'function',''); v_id text := nullif(p_row->>'id',''); v_name text := trim(coalesce(p_auth->>'name',''));
        v_ref text; v_old public.support_requests%rowtype;
begin
  if v_fn = '' then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_is_approver(p_auth) and not public.wbg_unit_lead(p_auth, v_fn) then return jsonb_build_object('error','not_allowed'); end if;
  if v_id is not null then select * into v_old from public.support_requests where id = v_id; end if;
  if v_old.id is not null and v_old.function_id <> v_fn and not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  if v_old.id is null then
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    v_ref := coalesce(nullif(p_row->>'ref',''), 'SR-' || lpad(nextval('public.support_ref_seq')::text, 4, '0'));
    insert into public.support_requests (id, ref, function_id, requester, category, description, priority, date_requested, status, response_date,
      action_taken, responded_by, evidence_ref, follow_up, remarks, created_by, updated_by)
    values (v_id, v_ref, v_fn, coalesce(p_row->>'requester',''), coalesce(p_row->>'category',''), coalesce(p_row->>'description',''),
      coalesce(nullif(p_row->>'priority',''),'Normal'), nullif(p_row->>'requested','')::date, coalesce(nullif(p_row->>'status',''),'Open'),
      nullif(p_row->>'responded','')::date, coalesce(p_row->>'action',''), coalesce(p_row->>'respondedBy',''), coalesce(p_row->>'evidence',''),
      coalesce((p_row->>'followUp')::boolean,false), coalesce(p_row->>'remarks',''), v_name, v_name);
  else
    v_ref := v_old.ref;
    update public.support_requests set function_id = v_fn, requester = coalesce(p_row->>'requester',''), category = coalesce(p_row->>'category',''),
      description = coalesce(p_row->>'description',''), priority = coalesce(nullif(p_row->>'priority',''),'Normal'),
      date_requested = nullif(p_row->>'requested','')::date, status = coalesce(nullif(p_row->>'status',''),'Open'),
      response_date = nullif(p_row->>'responded','')::date, action_taken = coalesce(p_row->>'action',''), responded_by = coalesce(p_row->>'respondedBy',''),
      evidence_ref = coalesce(p_row->>'evidence',''), follow_up = coalesce((p_row->>'followUp')::boolean,false), remarks = coalesce(p_row->>'remarks',''),
      updated_by = v_name, updated_at = now()
    where id = v_id;
  end if;
  perform public.wbg_add_activity(v_name, v_fn, null, jsonb_build_object('action','support','summary',
    (case when v_old.id is null then 'Logged support request ' else 'Updated support request ' end) || v_ref || ' from ' || coalesce(p_row->>'requester','') || ' (' || coalesce(nullif(p_row->>'status',''),'Open') || ')'));
  return jsonb_build_object('ok', true, 'id', v_id, 'ref', v_ref);
end $$;

create or replace function public.wbg_delete_support(p_auth jsonb, p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); v_old public.support_requests%rowtype;
begin
  if not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  select * into v_old from public.support_requests where id = p_id;
  if v_old.id is null then return jsonb_build_object('error','not_found'); end if;
  delete from public.support_requests where id = p_id;
  perform public.wbg_add_activity(trim(p_auth->>'name'), v_old.function_id, null, jsonb_build_object('action','support','summary','Deleted support request ' || coalesce(v_old.ref,'')));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.wbg_ack_feedback(p_auth jsonb, p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text;
begin
  select unit_id into v_unit from public.feedback where id = p_id;
  if v_unit is null then return jsonb_build_object('error','not_found'); end if;
  if not public.wbg_is_approver(p_auth) and not public.wbg_unit_lead(p_auth, v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  update public.feedback set ack_by = trim(coalesce(p_auth->>'name','')), ack_at = now() where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.wbg_save_action(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text := coalesce(p_row->>'unit',''); v_id text := nullif(p_row->>'id',''); v_name text := trim(coalesce(p_auth->>'name',''));
        v_appr boolean; v_old public.corrective_actions%rowtype; v_status text := coalesce(nullif(p_row->>'status',''),'Open'); v_src text;
begin
  if v_unit = '' then return jsonb_build_object('error','bad_request'); end if;
  v_appr := public.wbg_is_approver(p_auth);
  if not v_appr and not public.wbg_unit_lead(p_auth, v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if v_status not in ('Open','In progress','Done','Closed') then return jsonb_build_object('error','bad_request'); end if;
  if v_status = 'Closed' and not v_appr then return jsonb_build_object('error','not_allowed'); end if;
  if v_id is not null then select * into v_old from public.corrective_actions where id = v_id; end if;
  if v_old.id is not null and v_old.unit_id <> v_unit then return jsonb_build_object('error','not_allowed'); end if;
  if v_old.id is null then
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    v_src := case when v_appr and coalesce(p_row->>'source','') in ('Self','CEO','DCEO','Group Strategy') then p_row->>'source' else 'Self' end;
    insert into public.corrective_actions (id, unit_id, week, source, issue, action, owner, due, status, task_title, notes, created_by, updated_by, closed_at)
    values (v_id, v_unit, nullif(p_row->>'week','')::date, v_src, coalesce(p_row->>'issue',''), coalesce(p_row->>'action',''), coalesce(p_row->>'owner',''),
      nullif(p_row->>'due','')::date, v_status, coalesce(p_row->>'taskTitle',''), coalesce(p_row->>'notes',''), v_name, v_name,
      case when v_status in ('Done','Closed') then now() end);
  else
    update public.corrective_actions set
      source = case when v_appr and coalesce(p_row->>'source','') in ('Self','CEO','DCEO','Group Strategy') then p_row->>'source' else source end,
      issue = coalesce(p_row->>'issue',''), action = coalesce(p_row->>'action',''), owner = coalesce(p_row->>'owner',''),
      due = nullif(p_row->>'due','')::date, status = v_status, task_title = coalesce(p_row->>'taskTitle',''), notes = coalesce(p_row->>'notes',''),
      week = nullif(p_row->>'week','')::date, updated_by = v_name, updated_at = now(),
      closed_at = case when v_status in ('Done','Closed') then coalesce(closed_at, now()) else null end
    where id = v_id;
  end if;
  perform public.wbg_add_activity(v_name, v_unit, nullif(p_row->>'week','')::date, jsonb_build_object('action','corrective',
    'summary', (case when v_old.id is null then 'Logged corrective action: ' else 'Updated corrective action (' || v_status || '): ' end) || left(coalesce(p_row->>'action',''), 120)));
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.wbg_delete_action(p_auth jsonb, p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p_auth jsonb := public.wbg_auth();
begin
  if not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  delete from public.corrective_actions where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- 10. Retire the PIN system
-- ---------------------------------------------------------------------------
drop function if exists public.wbg_login(jsonb);
drop function if exists public.wbg_set_unit_pin(jsonb, text, text);
drop function if exists public.wbg_pin_status(jsonb);
drop function if exists public.wbg_change_approver_code(jsonb, text);
drop function if exists public.wbg_name_is_approver(text);
drop function if exists public.wbg_too_many_failures(text);
drop table if exists public.unit_pins;
drop table if exists public.auth_failures;
delete from public.app_secrets where key = 'approver_code';
delete from public.app_config where key = 'approver_names';

-- ---------------------------------------------------------------------------
-- 11. Who may call what. The public (not signed in) can only check an email and ask for access.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'wbg\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;

grant execute on function
  public.wbg_auth(), public.wbg_full_read(), public.wbg_unit_read(text), public.wbg_active(),
  public.wbg_is_approver(jsonb), public.wbg_unit_ok(jsonb, text), public.wbg_unit_lead(jsonb, text), public.wbg_dept_ok(jsonb, text, text),
  public.wbg_monday(),
  public.wbg_me(), public.wbg_complete_signup(text, text, jsonb), public.wbg_read_plans(date, date),
  public.wbg_save_plan(jsonb, jsonb, timestamptz, boolean, jsonb), public.wbg_request_change(jsonb, jsonb),
  public.wbg_decide_request(jsonb, text, boolean, text, jsonb), public.wbg_withdraw_request(jsonb, text),
  public.wbg_restore_version(jsonb, bigint), public.wbg_undo_last_save(jsonb, text), public.wbg_save_unit(jsonb, text, jsonb, text),
  public.wbg_log(jsonb, jsonb), public.wbg_restore_backup(jsonb, jsonb),
  public.wbg_save_support(jsonb, jsonb), public.wbg_delete_support(jsonb, text),
  public.wbg_save_feedback(jsonb, jsonb), public.wbg_delete_feedback(jsonb, text), public.wbg_ack_feedback(jsonb, text),
  public.wbg_save_action(jsonb, jsonb), public.wbg_delete_action(jsonb, text),
  public.wbg_admin_users(), public.wbg_admin_save_user(uuid, jsonb), public.wbg_admin_invite(jsonb), public.wbg_admin_delete_invite(text),
  public.wbg_admin_decide_access(uuid, boolean, jsonb), public.wbg_admin_set_domains(jsonb)
  to authenticated;
grant execute on function public.wbg_check_email(text), public.wbg_public_units(), public.wbg_request_access(text, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 12. Done. Next, in Supabase: Authentication > Providers > Email must be ON (confirm email can stay ON),
--     and Authentication > Emails > "Magic Link" template must show the code: put {{ .Token }} in the message.
--     Then sign in with surafel.h@wagwagoelectric.com: that email was set up above as the first Group Strategy super admin.
-- ---------------------------------------------------------------------------
