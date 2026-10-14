-- Stage 5b: department is optional, and Group Strategy can approve a role request on the spot with an approval code.
-- Run once in the Supabase SQL Editor, after upgrade-8-roles-and-profile. Safe to run again.
--
-- What it changes
--   * Choosing a department is no longer required (sign-up, role requests, People). Without a department a person
--     sees their unit but edits only after Group Strategy / the unit's planning adds a department for them.
--   * Approval code: Group Strategy sets a secret code (stored only as a hash). Standing next to the person, enter the
--     code on THEIR screen (Profile > Role and access) and their waiting role request is approved as asked.
--     Wrong codes are counted: 5 wrong tries in 15 minutes lock that person's code entry for 15 minutes.

-- 1. Department no longer needed
create or replace function public.wbg__check_person(p jsonb) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(p->>'role','') not in ('super_admin','executive','leader','planning','manager','staff') then return 'bad_role'; end if;
  if p->>'role' = 'executive' and coalesce(p->>'title','') not in ('CEO','DCEO') then return 'title_needed'; end if;
  if p->>'role' in ('leader','planning','manager','staff') and not exists (select 1 from public.units where id = p->>'unit') then return 'unit_needed'; end if;
  return null;
end $$;

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
    if p.setup_done then return jsonb_build_object('error','not_allowed'); end if;
    if not exists (select 1 from public.units where id = p_unit) then return jsonb_build_object('error','unit_needed'); end if;
    select coalesce(bool_and(u.departments ? d), true) into v_ok
      from public.units u, jsonb_array_elements_text(v_deps) d where u.id = p_unit;
    if not coalesce(v_ok, true) then v_deps := '[]'::jsonb; end if;
    update public.profiles set full_name = left(trim(p_name), 120), unit_id = p_unit, departments = v_deps, setup_done = true where user_id = p.user_id;
  end if;
  perform public.wbg_add_activity(left(trim(p_name),120), coalesce((select unit_id from public.profiles where user_id = p.user_id),''), null,
    jsonb_build_object('action','user','summary','Signed up: ' || left(trim(p_name),120) || ' (' || p.email || ')'));
  return public.wbg_me();
end $$;

-- 2. Approval code
create table if not exists public.role_code_attempts (
  id      bigserial primary key,
  user_id uuid not null,
  at      timestamptz not null default now()
);
create index if not exists role_code_attempts_idx on public.role_code_attempts (user_id, at desc);
alter table public.role_code_attempts enable row level security;   -- no policy: only the functions below touch it

-- Group Strategy sets, changes or clears (empty text) the code. At least 6 characters.
create or replace function public.wbg_admin_set_approval_code(p_code text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a jsonb := public.wbg_auth();
begin
  if not public.wbg_is_approver(a) then return jsonb_build_object('error','not_allowed'); end if;
  if coalesce(p_code,'') = '' then
    delete from public.app_secrets where key in ('role_approval_code','role_approval_code_at');
    perform public.wbg_add_activity(a->>'name', '', null, jsonb_build_object('action','user','summary','Turned off the approval code'));
    return jsonb_build_object('ok', true, 'set', false);
  end if;
  if length(trim(p_code)) < 6 then return jsonb_build_object('error','code_too_short'); end if;
  insert into public.app_secrets (key, value) values ('role_approval_code', extensions.crypt(trim(p_code), extensions.gen_salt('bf')))
    on conflict (key) do update set value = excluded.value;
  insert into public.app_secrets (key, value) values ('role_approval_code_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    on conflict (key) do update set value = excluded.value;
  perform public.wbg_add_activity(a->>'name', '', null, jsonb_build_object('action','user','summary','Set a new approval code'));
  return jsonb_build_object('ok', true, 'set', true);
end $$;

create or replace function public.wbg_admin_approval_code_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.wbg_is_approver(public.wbg_auth()) then return jsonb_build_object('error','not_allowed'); end if;
  return jsonb_build_object('ok', true, 'set', exists (select 1 from public.app_secrets where key = 'role_approval_code'),
    'setAt', (select value from public.app_secrets where key = 'role_approval_code_at'));
end $$;

-- The person enters the code on their own screen: their waiting request is approved exactly as asked.
create or replace function public.wbg_approve_role_with_code(p_id uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare p public.profiles%rowtype; r public.role_requests%rowtype; v_hash text; v_err text;
begin
  select * into p from public.profiles where user_id = auth.uid() and status = 'active' and setup_done;
  if not found then return jsonb_build_object('error','not_allowed'); end if;
  if (select count(*) from public.role_code_attempts where user_id = p.user_id and at > now() - interval '15 minutes') >= 5
     then return jsonb_build_object('error','too_many'); end if;
  select value into v_hash from public.app_secrets where key = 'role_approval_code';
  if v_hash is null then return jsonb_build_object('error','code_off'); end if;
  if v_hash <> extensions.crypt(trim(coalesce(p_code,'')), v_hash) then
    insert into public.role_code_attempts (user_id) values (p.user_id);
    return jsonb_build_object('error','bad_code');
  end if;
  select * into r from public.role_requests where id = p_id and user_id = p.user_id and status = 'pending' for update;
  if not found then return jsonb_build_object('error','not_found'); end if;
  v_err := public.wbg__check_person(jsonb_build_object('role', r.req_role, 'unit', r.unit_id, 'departments', r.departments));
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  update public.profiles set role = r.req_role, title = '', unit_id = r.unit_id, departments = r.departments, invited = true where user_id = p.user_id;
  update public.role_requests set status = 'approved', decided_by = 'Approval code', decided_at = now(), decision_note = 'Approved in person with the approval code' where id = r.id;
  delete from public.role_code_attempts where user_id = p.user_id;
  perform public.wbg_add_activity('Approval code', coalesce(r.unit_id,''), null, jsonb_build_object('action','user',
    'summary', 'Approved the role request of ' || r.full_name || ' (' || r.email || ') with the approval code',
    'details', jsonb_build_array('Was: ' || p.role || ' · ' || coalesce(p.unit_id,'-'), 'Now: ' || r.req_role || ' · ' || coalesce(r.unit_id,'-') || ' · ' || r.departments::text)));
  return jsonb_build_object('ok', true, 'profile', public.wbg_me());
end $$;

revoke all on function public.wbg_admin_set_approval_code(text), public.wbg_admin_approval_code_status(), public.wbg_approve_role_with_code(uuid, text) from public, anon;
grant execute on function public.wbg_admin_set_approval_code(text), public.wbg_admin_approval_code_status(), public.wbg_approve_role_with_code(uuid, text), public.wbg_complete_signup(text, text, jsonb) to authenticated;
