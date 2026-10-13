-- Stage 5a: role requests (at sign-up and as a later upgrade), profile settings, notifications for Group Strategy.
-- Run once in the Supabase SQL Editor, after upgrade-7. Safe to run again.
--
-- What it adds
--   * profiles.phone and profiles.job_title (the person edits these themselves)
--   * role_requests: a person asks for a role (at sign-up, or later as an upgrade); Group Strategy approves or rejects
--   * wbg_update_profile: a person changes their own name, phone and job title (never their role, unit or departments)
--   * wbg_request_role / wbg_my_role_requests / wbg_withdraw_role_request: the person's side
--   * wbg_admin_role_requests / wbg_admin_decide_role: Group Strategy's side (the list also feeds the notification bell)
--   * wbg_me and wbg_admin_users now also return phone and job title

alter table public.profiles add column if not exists phone text not null default '';
alter table public.profiles add column if not exists job_title text not null default '';

create table if not exists public.role_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text not null default '',
  kind        text not null default 'upgrade' check (kind in ('signup','upgrade')),
  from_role   text not null default '',
  from_unit   text,
  from_departments jsonb not null default '[]'::jsonb,
  req_role    text not null check (req_role in ('leader','planning','manager','staff')),
  unit_id     text,
  departments jsonb not null default '[]'::jsonb,
  reason      text not null default '',
  status      text not null default 'pending' check (status in ('pending','approved','rejected','withdrawn')),
  created_at  timestamptz not null default now(),
  decided_by  text,
  decided_at  timestamptz,
  decision_note text not null default ''
);
create index if not exists role_requests_status_idx on public.role_requests (status, created_at desc);
create index if not exists role_requests_user_idx on public.role_requests (user_id, created_at desc);
alter table public.role_requests enable row level security;   -- no policy: only through the functions below

-- ---------------------------------------------------------------------------
-- The caller's own profile (adds phone and job title)
-- ---------------------------------------------------------------------------
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
    'name', p.full_name, 'role', p.role, 'title', p.title, 'unit', p.unit_id, 'departments', p.departments,
    'phone', p.phone, 'jobTitle', p.job_title);
end $$;

create or replace function public.wbg_admin_users() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.wbg_is_approver(public.wbg_auth()) then return jsonb_build_object('error','not_allowed'); end if;
  return jsonb_build_object('ok', true,
    'users', coalesce((select jsonb_agg(jsonb_build_object('id', p.user_id, 'email', p.email, 'name', p.full_name, 'role', p.role, 'title', p.title,
        'unit', p.unit_id, 'departments', p.departments, 'status', p.status, 'setupDone', p.setup_done, 'invited', p.invited,
        'phone', p.phone, 'jobTitle', p.job_title,
        'createdAt', p.created_at, 'lastSeen', p.last_seen) order by p.created_at desc) from public.profiles p), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('email', i.email, 'name', i.full_name, 'role', i.role, 'title', i.title, 'unit', i.unit_id,
        'departments', i.departments, 'invitedBy', i.invited_by, 'createdAt', i.created_at) order by i.created_at desc) from public.invites i where i.used_at is null), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'email', r.email, 'name', r.full_name, 'unit', r.unit_id, 'contact', r.contact,
        'note', r.note, 'status', r.status, 'createdAt', r.created_at) order by r.created_at desc) from public.access_requests r where r.status = 'pending'), '[]'::jsonb),
    'domains', coalesce((select value from public.app_config where key = 'allowed_domains'), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- A person edits their own details (name, phone, job title). Role, unit and departments change only through a request.
-- ---------------------------------------------------------------------------
create or replace function public.wbg_update_profile(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.profiles%rowtype; v_name text; v_phone text; v_job text;
begin
  select * into p from public.profiles where user_id = auth.uid() and status = 'active';
  if not found then return jsonb_build_object('error','not_allowed'); end if;
  v_name  := case when p_data ? 'name'     then left(trim(coalesce(p_data->>'name','')), 120) else p.full_name end;
  v_phone := case when p_data ? 'phone'    then left(trim(coalesce(p_data->>'phone','')), 40)  else p.phone end;
  v_job   := case when p_data ? 'jobTitle' then left(trim(coalesce(p_data->>'jobTitle','')), 80) else p.job_title end;
  if length(v_name) < 3 then return jsonb_build_object('error','name_needed'); end if;
  update public.profiles set full_name = v_name, phone = v_phone, job_title = v_job where user_id = p.user_id;
  if v_name is distinct from p.full_name then
    perform public.wbg_add_activity(v_name, coalesce(p.unit_id,''), null, jsonb_build_object('action','user','summary', p.full_name || ' changed their name to ' || v_name));
  end if;
  return jsonb_build_object('ok', true, 'profile', public.wbg_me());
end $$;

-- ---------------------------------------------------------------------------
-- Ask for a role: at sign-up (kind = signup) or later (kind = upgrade). One open request per person.
-- ---------------------------------------------------------------------------
create or replace function public.wbg_request_role(p_role text, p_unit text, p_departments jsonb, p_reason text, p_kind text default 'upgrade') returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.profiles%rowtype; v_kind text := case when p_kind = 'signup' then 'signup' else 'upgrade' end;
        v_deps jsonb := coalesce(p_departments, '[]'::jsonb); v_err text; v_unit text := nullif(p_unit, ''); v_id uuid;
begin
  select * into p from public.profiles where user_id = auth.uid() and status = 'active' and setup_done;
  if not found then return jsonb_build_object('error','not_allowed'); end if;
  if p.role = 'super_admin' then return jsonb_build_object('error','not_allowed'); end if;
  if coalesce(p_role,'') not in ('leader','planning','manager','staff') then return jsonb_build_object('error','bad_role'); end if;
  if exists (select 1 from public.role_requests where user_id = p.user_id and status = 'pending') then return jsonb_build_object('error','already_pending'); end if;
  v_err := public.wbg__check_person(jsonb_build_object('role', p_role, 'unit', v_unit, 'departments', v_deps));
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  if v_kind = 'upgrade' then
    if p_role = p.role and v_unit is not distinct from p.unit_id and v_deps = p.departments then return jsonb_build_object('error','no_change'); end if;
    if length(trim(coalesce(p_reason,''))) < 5 then return jsonb_build_object('error','reason_needed'); end if;
  end if;
  if exists (select 1 from jsonb_array_elements_text(v_deps) d where not exists (select 1 from public.units u where u.id = v_unit and u.departments ? d))
     then return jsonb_build_object('error','department_needed'); end if;
  insert into public.role_requests (user_id, email, full_name, kind, from_role, from_unit, from_departments, req_role, unit_id, departments, reason)
  values (p.user_id, p.email, p.full_name, v_kind, p.role, p.unit_id, p.departments, p_role, v_unit, v_deps, left(trim(coalesce(p_reason,'')), 500)) returning id into v_id;
  perform public.wbg_add_activity(p.full_name, coalesce(v_unit,''), null, jsonb_build_object('action','user',
    'summary', p.full_name || ' asked for the role ' || p_role || case when v_kind = 'signup' then ' (at sign-up)' else ' (upgrade)' end));
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.wbg_my_role_requests() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then return jsonb_build_object('error','not_allowed'); end if;
  return jsonb_build_object('ok', true, 'requests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'role', r.req_role, 'unit', r.unit_id,
      'departments', r.departments, 'reason', r.reason, 'status', r.status, 'createdAt', r.created_at, 'decidedAt', r.decided_at, 'decidedBy', r.decided_by,
      'note', r.decision_note) order by r.created_at desc)
    from (select * from public.role_requests where user_id = auth.uid() order by created_at desc limit 6) r), '[]'::jsonb));
end $$;

create or replace function public.wbg_withdraw_role_request(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.role_requests set status = 'withdrawn', decided_at = now(), decided_by = (select full_name from public.profiles where user_id = auth.uid())
   where id = p_id and user_id = auth.uid() and status = 'pending';
  if not found then return jsonb_build_object('error','not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- Group Strategy: the waiting requests (also used for the notification bell), and the decision.
-- ---------------------------------------------------------------------------
create or replace function public.wbg_admin_role_requests() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.wbg_is_approver(public.wbg_auth()) then return jsonb_build_object('error','not_allowed'); end if;
  return jsonb_build_object('ok', true,
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'userId', r.user_id, 'email', r.email, 'name', r.full_name, 'kind', r.kind,
        'fromRole', r.from_role, 'fromUnit', r.from_unit, 'fromDepartments', r.from_departments, 'role', r.req_role, 'unit', r.unit_id,
        'departments', r.departments, 'reason', r.reason, 'createdAt', r.created_at,
        'phone', coalesce((select p.phone from public.profiles p where p.user_id = r.user_id), ''),
        'jobTitle', coalesce((select p.job_title from public.profiles p where p.user_id = r.user_id), '')) order by r.created_at)
      from public.role_requests r where r.status = 'pending'), '[]'::jsonb),
    'accessCount', (select count(*) from public.access_requests where status = 'pending'));
end $$;

create or replace function public.wbg_admin_decide_role(p_id uuid, p_approve boolean, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wbg_auth(); r public.role_requests%rowtype; o public.profiles%rowtype; v_role text; v_unit text; v_deps jsonb; v_err text; v_note text := left(trim(coalesce(p_data->>'note','')), 300);
begin
  if not public.wbg_is_approver(a) then return jsonb_build_object('error','not_allowed'); end if;
  select * into r from public.role_requests where id = p_id and status = 'pending' for update;
  if not found then return jsonb_build_object('error','not_found'); end if;
  select * into o from public.profiles where user_id = r.user_id;
  if not found then return jsonb_build_object('error','not_found'); end if;
  if p_approve then
    v_role := coalesce(nullif(p_data->>'role',''), r.req_role);
    v_unit := case when p_data ? 'unit' then nullif(p_data->>'unit','') else r.unit_id end;
    v_deps := coalesce(p_data->'departments', r.departments);
    if v_role = 'super_admin' then return jsonb_build_object('error','not_allowed'); end if;
    v_err := public.wbg__check_person(jsonb_build_object('role', v_role, 'unit', v_unit, 'departments', v_deps));
    if v_err is not null then return jsonb_build_object('error', v_err); end if;
    update public.profiles set role = v_role, title = case when v_role = 'executive' then title else '' end, unit_id = v_unit, departments = v_deps, invited = true where user_id = r.user_id;
  end if;
  update public.role_requests set status = case when p_approve then 'approved' else 'rejected' end, decided_by = a->>'name', decided_at = now(), decision_note = v_note where id = p_id;
  perform public.wbg_add_activity(a->>'name', coalesce(case when p_approve then v_unit else r.unit_id end, ''), null, jsonb_build_object('action','user',
    'summary', (case when p_approve then 'Approved ' else 'Rejected ' end) || 'the role request of ' || r.full_name || ' (' || r.email || ')',
    'details', jsonb_build_array('Was: ' || o.role || ' · ' || coalesce(o.unit_id,'-') || ' · ' || o.departments::text,
      case when p_approve then 'Now: ' || v_role || ' · ' || coalesce(v_unit,'-') || ' · ' || v_deps::text else 'Asked for: ' || r.req_role || ' · ' || coalesce(r.unit_id,'-') end)));
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.wbg_update_profile(jsonb), public.wbg_request_role(text, text, jsonb, text, text), public.wbg_my_role_requests(),
  public.wbg_withdraw_role_request(uuid), public.wbg_admin_role_requests(), public.wbg_admin_decide_role(uuid, boolean, jsonb) from public, anon;
grant execute on function public.wbg_update_profile(jsonb), public.wbg_request_role(text, text, jsonb, text, text), public.wbg_my_role_requests(),
  public.wbg_withdraw_role_request(uuid), public.wbg_admin_role_requests(), public.wbg_admin_decide_role(uuid, boolean, jsonb), public.wbg_me(), public.wbg_admin_users() to authenticated;
