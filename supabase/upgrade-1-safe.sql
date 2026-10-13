-- WBG Weekly Activity Tracking · Upgrade 1 of 2 (SAFE: the current live site keeps working)
-- Adds: automatic version history (backup on every save), unit PINs, Strategy Office approvers,
-- change requests (approvals), evidence file storage, and the server functions the new site uses.
-- Run it in Supabase: SQL Editor > New query > paste > Run. Safe to re-run.
-- Then run the two setup lines at the very bottom (approver code), and deploy the new site.
-- Only after the new site is live, run upgrade-2-lockdown.sql.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Version history: every change to a plan or unit keeps a copy of the row as it was before.
--    Written by a database trigger, so it works for every save, from any version of the site.
-- ---------------------------------------------------------------------------
create table if not exists public.row_history (
  id          bigserial primary key,
  tbl         text not null,                 -- 'plans' | 'units'
  row_id      text not null,
  op          text not null,                 -- UPDATE | DELETE
  old_row     jsonb not null,                -- the row exactly as it was before the change
  changed_at  timestamptz not null default now(),
  changed_by  text                           -- who made the change that replaced this copy
);
create index if not exists row_history_row_idx on public.row_history (tbl, row_id, changed_at desc);

create or replace function public.wbg_keep_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and to_jsonb(old) = to_jsonb(new) then return new; end if;
  insert into public.row_history (tbl, row_id, op, old_row, changed_by)
  values (tg_table_name, old.id, tg_op, to_jsonb(old),
          case when tg_op = 'UPDATE' then to_jsonb(new)->>'updated_by' else null end);
  return coalesce(new, old);
end $$;

drop trigger if exists plans_history on public.plans;
create trigger plans_history before update or delete on public.plans
  for each row execute function public.wbg_keep_history();
drop trigger if exists units_history on public.units;
create trigger units_history before update or delete on public.units
  for each row execute function public.wbg_keep_history();

-- ---------------------------------------------------------------------------
-- 2. Access: unit PINs and the Strategy Office approver code (stored as bcrypt hashes, never readable)
-- ---------------------------------------------------------------------------
create table if not exists public.unit_pins (
  unit_id  text primary key,
  pin_hash text not null,
  set_by   text,
  set_at   timestamptz not null default now()
);
create table if not exists public.app_secrets (
  key   text primary key,
  value text not null
);
create table if not exists public.auth_failures (
  id   bigserial primary key,
  key  text not null,                      -- unit id, or 'approver'
  at   timestamptz not null default now()
);
create index if not exists auth_failures_idx on public.auth_failures (key, at desc);

-- Readable settings. approver_names: a person whose name starts with or contains one of these
-- (and who has the approver code) can approve changes and manage units.
create table if not exists public.app_config (
  key   text primary key,
  value jsonb not null
);
insert into public.app_config (key, value) values
  ('approver_names', '["Surafel","Surafel Hailu","Ataklti","Ataklti Nega"]'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Change requests: past-week updates, edits to locked task fields and task removals
--    wait here until a Strategy Office approver accepts or rejects them.
-- ---------------------------------------------------------------------------
create table if not exists public.change_requests (
  id            text primary key,
  created_at    timestamptz not null default now(),
  unit_id       text not null,
  week          date not null,
  plan_id       text not null,
  requested_by  text not null default '',
  status        text not null default 'pending',   -- pending | approved | rejected | withdrawn
  summary       text not null default '',
  details       jsonb not null default '[]'::jsonb,  -- readable lines
  patch         jsonb not null default '[]'::jsonb,  -- the changes, applied on approval
  decided_by    text,
  decided_at    timestamptz,
  decision_note text not null default ''
);
create index if not exists change_requests_status_idx on public.change_requests (status, created_at desc);
create index if not exists change_requests_unit_idx on public.change_requests (unit_id, week);

-- ---------------------------------------------------------------------------
-- 4. Row Level Security for the new tables (old tables keep their current policy until upgrade 2)
-- ---------------------------------------------------------------------------
alter table public.row_history     enable row level security;
alter table public.unit_pins       enable row level security;   -- no policy: nobody can read it through the API
alter table public.app_secrets     enable row level security;   -- no policy: nobody can read it through the API
alter table public.auth_failures   enable row level security;   -- no policy
alter table public.app_config      enable row level security;
alter table public.change_requests enable row level security;

drop policy if exists "read" on public.row_history;
create policy "read" on public.row_history for select to anon, authenticated using (true);
drop policy if exists "read" on public.app_config;
create policy "read" on public.app_config for select to anon, authenticated using (true);
drop policy if exists "read" on public.change_requests;
create policy "read" on public.change_requests for select to anon, authenticated using (true);
-- (no insert/update/delete policies: these tables change only through the functions below)

do $$
begin
  begin execute 'alter publication supabase_realtime add table public.change_requests';
  exception when duplicate_object then null; when undefined_object then null; end;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Evidence files: private Storage bucket, 5 MB per file, documents and images only.
--    Anyone with the site can upload (files cannot be overwritten or deleted through the API);
--    the file is linked to a task only by a PIN-checked plan save.
-- ---------------------------------------------------------------------------
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('evidence', 'evidence', false, 5242880, array[
    'application/pdf','image/png','image/jpeg','image/gif','image/webp','text/plain','text/csv',
    'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation'])
  on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  execute 'drop policy if exists "evidence upload" on storage.objects';
  execute 'drop policy if exists "evidence read" on storage.objects';
  execute $p$create policy "evidence upload" on storage.objects for insert to anon, authenticated with check (bucket_id = 'evidence')$p$;
  execute $p$create policy "evidence read" on storage.objects for select to anon, authenticated using (bucket_id = 'evidence')$p$;
exception when undefined_table or invalid_schema_name then
  raise notice 'Storage schema not found: evidence uploads are not set up.';
end $$;

-- ---------------------------------------------------------------------------
-- 6. Server functions. The site calls these; each one checks the PIN or approver code itself.
--    p_auth = {"name": "...", "unit": "<unit id>", "pin": "...", "code": "<approver code>"}
-- ---------------------------------------------------------------------------
create or replace function public.wbg_monday() returns date
language sql stable as $$ select date_trunc('week', now() at time zone 'Africa/Addis_Ababa')::date $$;

create or replace function public.wbg_too_many_failures(p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select count(*) >= 20 from public.auth_failures where key = p_key and at > now() - interval '15 minutes'
$$;

create or replace function public.wbg_name_is_approver(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(length(trim(p_name)) > 0 and exists (
    select 1 from public.app_config c, jsonb_array_elements_text(c.value) n
    where c.key = 'approver_names' and length(trim(n)) > 0
      and (lower(trim(p_name)) like lower(trim(n)) || '%' or position(lower(trim(n)) in lower(trim(p_name))) > 0)
  ), false)
$$;

-- true when name + approver code are right. Wrong codes are counted; 20 in 15 minutes locks approvals for 15 minutes.
create or replace function public.wbg_is_approver(p_auth jsonb) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_code text := coalesce(p_auth->>'code', '');
begin
  if v_code = '' or not public.wbg_name_is_approver(p_auth->>'name') then return false; end if;
  if public.wbg_too_many_failures('approver') then return false; end if;
  select value into v_hash from public.app_secrets where key = 'approver_code';
  if v_hash is not null and v_hash = extensions.crypt(v_code, v_hash) then return true; end if;
  insert into public.auth_failures (key) values ('approver');
  return false;
end $$;

-- true when the PIN is right for that unit.
create or replace function public.wbg_unit_ok(p_auth jsonb, p_unit text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_pin text := coalesce(p_auth->>'pin', '');
begin
  if coalesce(p_auth->>'unit', '') <> p_unit or v_pin = '' or length(trim(coalesce(p_auth->>'name',''))) = 0 then return false; end if;
  if public.wbg_too_many_failures(p_unit) then return false; end if;
  select pin_hash into v_hash from public.unit_pins where unit_id = p_unit;
  if v_hash is not null and v_hash = extensions.crypt(v_pin, v_hash) then return true; end if;
  insert into public.auth_failures (key) values (p_unit);
  return false;
end $$;

create or replace function public.wbg_add_activity(p_by text, p_unit text, p_week date, p_entry jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.activity (id, ts, by_name, unit_id, week, action, summary, details)
  values (coalesce(nullif(p_entry->>'id',''), md5(random()::text || clock_timestamp()::text)), now(), coalesce(p_by,''), coalesce(p_unit,''), p_week,
          coalesce(p_entry->>'action','save'), coalesce(p_entry->>'summary',''), coalesce(p_entry->'details','[]'::jsonb))
  on conflict (id) do nothing
$$;

-- Sign-in check used by the site: which rights do these details give?
create or replace function public.wbg_login(p_auth jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_unit text := coalesce(p_auth->>'unit',''); v_unit_ok boolean := false; v_appr boolean := false; v_locked boolean := false;
begin
  if coalesce(p_auth->>'code','') <> '' then
    v_locked := public.wbg_too_many_failures('approver');
    v_appr := public.wbg_is_approver(p_auth);
  end if;
  if v_unit <> '' and coalesce(p_auth->>'pin','') <> '' then
    v_locked := v_locked or public.wbg_too_many_failures(v_unit);
    v_unit_ok := public.wbg_unit_ok(p_auth, v_unit);
  end if;
  return jsonb_build_object('ok', true, 'unitOk', v_unit_ok, 'approver', v_appr,
    'approverName', public.wbg_name_is_approver(p_auth->>'name'), 'lockedOut', v_locked,
    'hasPin', exists (select 1 from public.unit_pins where unit_id = v_unit));
end $$;

-- Save one weekly plan.
-- Unit PIN holders: current and future weeks of their own unit. Once a week has started, saved tasks keep their
--   title, type, department, expected outcome, due date and priority, and cannot be removed: those go through
--   wbg_request_change. Past weeks: only through wbg_request_change.
-- Approvers: any plan, any change.
create or replace function public.wbg_save_plan(p_auth jsonb, p_plan jsonb, p_base timestamptz default null, p_force boolean default false, p_activity jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_unit text := p_plan->>'unit'; v_week date := (p_plan->>'week')::date; v_id text; v_old public.plans%rowtype;
  v_appr boolean; v_name text := trim(coalesce(p_auth->>'name','')); v_now timestamptz := now();
  v_today text := to_char(now() at time zone 'Africa/Addis_Ababa', 'YYYY-MM-DD');
  v_locked text[] := array['title','kind','dept','outcome','due','priority'];
begin
  if v_unit is null or v_week is null then return jsonb_build_object('error','bad_request'); end if;
  if jsonb_typeof(coalesce(p_plan->'tasks','[]'::jsonb)) <> 'array' then return jsonb_build_object('error','bad_request'); end if;
  v_id := to_char(v_week,'YYYY-MM-DD') || '_' || v_unit;
  v_appr := public.wbg_is_approver(p_auth);
  if not v_appr and not public.wbg_unit_ok(p_auth, v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  select * into v_old from public.plans where id = v_id;
  -- the site sends times with millisecond precision, so compare at that precision
  if found and p_base is not null and not p_force and date_trunc('milliseconds', v_old.updated_at) is distinct from date_trunc('milliseconds', p_base) then
    return jsonb_build_object('error','conflict', 'updatedAt', v_old.updated_at, 'updatedBy', v_old.updated_by);
  end if;
  if not v_appr then
    if v_week < public.wbg_monday() then return jsonb_build_object('error','needs_approval', 'reason','past_week'); end if;
    if v_old.id is not null and v_week <= public.wbg_monday() then
      if exists (select 1 from jsonb_array_elements(v_old.tasks) o
                 where not exists (select 1 from jsonb_array_elements(p_plan->'tasks') n where n->>'id' = o->>'id')) then
        return jsonb_build_object('error','needs_approval', 'reason','removed');
      end if;
      if exists (select 1 from jsonb_array_elements(v_old.tasks) o
                 join jsonb_array_elements(p_plan->'tasks') n on n->>'id' = o->>'id'
                 cross join unnest(v_locked) f
                 where case when f = 'kind' then coalesce(nullif(o->>f,''),'Task') <> coalesce(nullif(n->>f,''),'Task')
                            else coalesce(o->>f,'') <> coalesce(n->>f,'') end) then
        return jsonb_build_object('error','needs_approval', 'reason','locked');
      end if;
    end if;
    -- completion date: only today, blank, or unchanged
    if exists (select 1 from jsonb_array_elements(p_plan->'tasks') n
               left join jsonb_array_elements(coalesce(v_old.tasks,'[]'::jsonb)) o on o->>'id' = n->>'id'
               where coalesce(n->>'completedAt','') not in ('', v_today, coalesce(o->>'completedAt',''))) then
      return jsonb_build_object('error','needs_approval', 'reason','completion_date');
    end if;
  end if;
  insert into public.plans (id, week, unit_id, tasks, wins, blockers, asks, updated_at, updated_by, source)
  values (v_id, v_week, v_unit, coalesce(p_plan->'tasks','[]'::jsonb), coalesce(p_plan->>'wins',''), coalesce(p_plan->>'blockers',''),
          coalesce(p_plan->>'asks',''), v_now, v_name, coalesce(p_plan->>'source',''))
  on conflict (id) do update set tasks = excluded.tasks, wins = excluded.wins, blockers = excluded.blockers, asks = excluded.asks,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by, source = excluded.source;
  if p_activity is not null then perform public.wbg_add_activity(v_name, v_unit, v_week, p_activity); end if;
  return jsonb_build_object('ok', true, 'updatedAt', v_now);
end $$;

-- Ask Group Strategy to approve a change. p_req = {id, unit, week, summary, details[], patch[]}
create or replace function public.wbg_request_change(p_auth jsonb, p_req jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_unit text := p_req->>'unit'; v_week date := (p_req->>'week')::date; v_name text := trim(coalesce(p_auth->>'name',''));
begin
  if v_unit is null or v_week is null or jsonb_typeof(p_req->'patch') <> 'array' then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_unit_ok(p_auth, v_unit) and not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  insert into public.change_requests (id, unit_id, week, plan_id, requested_by, summary, details, patch)
  values (coalesce(nullif(p_req->>'id',''), md5(random()::text || clock_timestamp()::text)), v_unit, v_week, to_char(v_week,'YYYY-MM-DD') || '_' || v_unit,
          v_name, coalesce(p_req->>'summary',''), coalesce(p_req->'details','[]'::jsonb), p_req->'patch');
  perform public.wbg_add_activity(v_name, v_unit, v_week, jsonb_build_object('action','request','summary','Asked for approval: ' || coalesce(p_req->>'summary',''), 'details', coalesce(p_req->'details','[]'::jsonb)));
  return jsonb_build_object('ok', true);
end $$;

-- Approver accepts (saving p_plan, the plan with the change applied) or rejects a request.
create or replace function public.wbg_decide_request(p_auth jsonb, p_id text, p_approve boolean, p_note text default '', p_plan jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_req public.change_requests%rowtype; v_name text := trim(coalesce(p_auth->>'name','')); v_res jsonb;
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

-- The unit (or an approver) withdraws a pending request.
create or replace function public.wbg_withdraw_request(p_auth jsonb, p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_req public.change_requests%rowtype;
begin
  select * into v_req from public.change_requests where id = p_id for update;
  if not found or v_req.status <> 'pending' then return jsonb_build_object('error','not_pending'); end if;
  if not public.wbg_unit_ok(p_auth, v_req.unit_id) and not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  update public.change_requests set status = 'withdrawn', decided_by = trim(coalesce(p_auth->>'name','')), decided_at = now() where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- Approver restores a plan or unit to a saved copy from row_history (the current version is kept as a copy too).
create or replace function public.wbg_restore_version(p_auth jsonb, p_history_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_h public.row_history%rowtype; v_name text := trim(coalesce(p_auth->>'name','')); r jsonb;
begin
  if not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  select * into v_h from public.row_history where id = p_history_id;
  if not found then return jsonb_build_object('error','not_found'); end if;
  r := v_h.old_row;
  if v_h.tbl = 'plans' then
    insert into public.plans (id, week, unit_id, tasks, wins, blockers, asks, updated_at, updated_by, source)
    values (r->>'id', (r->>'week')::date, r->>'unit_id', coalesce(r->'tasks','[]'::jsonb), coalesce(r->>'wins',''), coalesce(r->>'blockers',''), coalesce(r->>'asks',''),
            now(), v_name, 'Restored copy from ' || to_char(v_h.changed_at at time zone 'Africa/Addis_Ababa', 'YYYY-MM-DD HH24:MI'))
    on conflict (id) do update set tasks = excluded.tasks, wins = excluded.wins, blockers = excluded.blockers, asks = excluded.asks,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by, source = excluded.source;
    perform public.wbg_add_activity(v_name, r->>'unit_id', (r->>'week')::date, jsonb_build_object('action','restore',
      'summary', 'Restored the plan to the copy saved before ' || to_char(v_h.changed_at at time zone 'Africa/Addis_Ababa', 'DD Mon YYYY HH24:MI') || ' (EAT)'));
  elsif v_h.tbl = 'units' then
    insert into public.units (id, name, type, sort_order, departments, people)
    values (r->>'id', r->>'name', coalesce(r->>'type','Business unit'), coalesce((r->>'sort_order')::int, 99), coalesce(r->'departments','[]'::jsonb), coalesce(r->'people','[]'::jsonb))
    on conflict (id) do update set name = excluded.name, type = excluded.type, sort_order = excluded.sort_order, departments = excluded.departments, people = excluded.people;
    perform public.wbg_add_activity(v_name, r->>'id', null, jsonb_build_object('action','restore', 'summary', 'Restored unit "' || (r->>'name') || '"'));
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- A unit undoes its own last save within 30 minutes (puts back the copy kept just before that save).
create or replace function public.wbg_undo_last_save(p_auth jsonb, p_plan_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_p public.plans%rowtype; v_h public.row_history%rowtype; v_name text := trim(coalesce(p_auth->>'name','')); r jsonb;
begin
  select * into v_p from public.plans where id = p_plan_id;
  if not found then return jsonb_build_object('error','not_found'); end if;
  if not public.wbg_unit_ok(p_auth, v_p.unit_id) and not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  if v_p.updated_by is distinct from v_name or v_p.updated_at < now() - interval '30 minutes' then return jsonb_build_object('error','too_late'); end if;
  select * into v_h from public.row_history where tbl = 'plans' and row_id = p_plan_id and op <> 'SNAPSHOT' order by changed_at desc, id desc limit 1;
  if not found or v_h.changed_at < v_p.updated_at - interval '5 seconds' then return jsonb_build_object('error','not_found'); end if;
  r := v_h.old_row;
  update public.plans set tasks = coalesce(r->'tasks','[]'::jsonb), wins = coalesce(r->>'wins',''), blockers = coalesce(r->>'blockers',''), asks = coalesce(r->>'asks',''),
    updated_at = now(), updated_by = v_name, source = 'Undo' where id = p_plan_id;
  perform public.wbg_add_activity(v_name, v_p.unit_id, v_p.week, jsonb_build_object('action','restore','summary','Undid the last save'));
  return jsonb_build_object('ok', true);
end $$;

-- Units. Approvers: add, rename, change type, remove, set PINs. Unit PIN holders: their own departments and staff names.
-- p_op: 'add' {id,name,type,order} | 'update' {id, name?, type?} | 'remove' {id} | 'lists' {id, departments?, people?}
create or replace function public.wbg_save_unit(p_auth jsonb, p_op text, p_data jsonb, p_summary text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id text := p_data->>'id'; v_name text := trim(coalesce(p_auth->>'name','')); v_appr boolean := public.wbg_is_approver(p_auth);
begin
  if v_id is null or v_id = '' then return jsonb_build_object('error','bad_request'); end if;
  if p_op = 'lists' then
    if not v_appr and not public.wbg_unit_ok(p_auth, v_id) then return jsonb_build_object('error','not_allowed'); end if;
    update public.units set departments = coalesce(p_data->'departments', departments), people = coalesce(p_data->'people', people) where id = v_id;
  elsif not v_appr then
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

create or replace function public.wbg_set_unit_pin(p_auth jsonb, p_unit text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  if coalesce(p_pin,'') = '' then
    delete from public.unit_pins where unit_id = p_unit;
  else
    if length(p_pin) < 4 then return jsonb_build_object('error','pin_too_short'); end if;
    insert into public.unit_pins (unit_id, pin_hash, set_by, set_at) values (p_unit, extensions.crypt(p_pin, extensions.gen_salt('bf')), trim(p_auth->>'name'), now())
    on conflict (unit_id) do update set pin_hash = excluded.pin_hash, set_by = excluded.set_by, set_at = excluded.set_at;
  end if;
  delete from public.auth_failures where key = p_unit;
  perform public.wbg_add_activity(trim(p_auth->>'name'), p_unit, null, jsonb_build_object('action','unit','summary', case when coalesce(p_pin,'') = '' then 'Removed the unit PIN' else 'Set a new unit PIN' end));
  return jsonb_build_object('ok', true);
end $$;

-- Which units have a PIN (not the PINs themselves). Approvers only.
create or replace function public.wbg_pin_status(p_auth jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  return jsonb_build_object('ok', true, 'units', coalesce((select jsonb_object_agg(unit_id, set_at) from public.unit_pins), '{}'::jsonb));
end $$;

-- Change the approver code (approvers only, with the current code).
create or replace function public.wbg_change_approver_code(p_auth jsonb, p_new text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  if length(coalesce(p_new,'')) < 6 then return jsonb_build_object('error','code_too_short'); end if;
  update public.app_secrets set value = extensions.crypt(p_new, extensions.gen_salt('bf')) where key = 'approver_code';
  return jsonb_build_object('ok', true);
end $$;

-- Free-form activity entry (for example, evidence uploads). Needs a valid unit PIN or approver code.
create or replace function public.wbg_log(p_auth jsonb, p_entry jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_unit text := coalesce(p_entry->>'unit','');
begin
  if not public.wbg_is_approver(p_auth) and not public.wbg_unit_ok(p_auth, v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  perform public.wbg_add_activity(trim(p_auth->>'name'), v_unit, nullif(p_entry->>'week','')::date, p_entry);
  return jsonb_build_object('ok', true);
end $$;

-- Disaster recovery: put back units and plans from a full backup file downloaded from the site. Approvers only.
-- Every plan it overwrites is kept in row_history first, so a restore can itself be undone.
create or replace function public.wbg_restore_backup(p_auth jsonb, p_backup jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u jsonb; p jsonb; nu int := 0; np int := 0; v_name text := trim(coalesce(p_auth->>'name',''));
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

-- Who may call what: the site (anon) can call the wbg_ functions above, but not the internal helpers.
revoke all on function public.wbg_keep_history() from public, anon, authenticated;
revoke all on function public.wbg_is_approver(jsonb) from public, anon, authenticated;
revoke all on function public.wbg_unit_ok(jsonb, text) from public, anon, authenticated;
revoke all on function public.wbg_add_activity(text, text, date, jsonb) from public, anon, authenticated;
revoke all on function public.wbg_too_many_failures(text) from public, anon, authenticated;
grant execute on function public.wbg_login(jsonb), public.wbg_save_plan(jsonb, jsonb, timestamptz, boolean, jsonb),
  public.wbg_request_change(jsonb, jsonb), public.wbg_decide_request(jsonb, text, boolean, text, jsonb),
  public.wbg_withdraw_request(jsonb, text), public.wbg_restore_version(jsonb, bigint), public.wbg_undo_last_save(jsonb, text),
  public.wbg_save_unit(jsonb, text, jsonb, text), public.wbg_set_unit_pin(jsonb, text, text), public.wbg_pin_status(jsonb),
  public.wbg_change_approver_code(jsonb, text), public.wbg_log(jsonb, jsonb), public.wbg_restore_backup(jsonb, jsonb),
  public.wbg_name_is_approver(text), public.wbg_monday() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. ONE-TIME SETUP: choose the Strategy Office approver code (at least 6 characters; share it only with
--    Surafel and Ataklti). Replace the text in quotes, then select just the line below and run it.
--    You can change the code later from the Units tab.
-- ---------------------------------------------------------------------------
-- insert into public.app_secrets (key, value) values ('approver_code', extensions.crypt('CHANGE-ME-TO-A-SECRET', extensions.gen_salt('bf')))
--   on conflict (key) do update set value = excluded.value;
