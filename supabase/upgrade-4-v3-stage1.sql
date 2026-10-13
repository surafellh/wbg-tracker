-- WBG Weekly Activity Tracking · Upgrade 4 (version 3, stage 1)
-- Adds: Saturday-to-Friday weeks, Business support log, Feedback, Corrective actions.
-- Run AFTER schema.sql and upgrade-1-safe.sql. Safe to run again. Nothing existing is deleted.
-- It does not need upgrade-2 (lockdown) to be run before or after it.

-- ---------------------------------------------------------------------------
-- 1. Weeks: up to the week of Monday 5 Oct 2026 weeks start on Monday; from Saturday 10 Oct 2026 they start on Saturday.
--    wbg_monday() keeps its name (the other functions call it) and now returns the start of the CURRENT week.
-- ---------------------------------------------------------------------------
create or replace function public.wbg_monday() returns date
language sql stable as $$
  select case when d >= date '2026-10-10' then d - ((extract(dow from d)::int + 1) % 7)
              else date_trunc('week', d)::date end
  from (select (now() at time zone 'Africa/Addis_Ababa')::date as d) x
$$;

-- Plans already entered for the old "Monday 12 Oct" week belong to the first Saturday week (10 Oct).
-- Skipped for any unit that already has a plan for 10 Oct.
do $$
declare r record;
begin
  for r in select id, unit_id from public.plans p where p.week = date '2026-10-12'
           and not exists (select 1 from public.plans q where q.week = date '2026-10-10' and q.unit_id = p.unit_id) loop
    update public.plans set week = date '2026-10-10', id = '2026-10-10_' || r.unit_id where id = r.id;
    update public.activity set week = date '2026-10-10' where week = date '2026-10-12' and unit_id = r.unit_id;
    update public.change_requests set week = date '2026-10-10', plan_id = '2026-10-10_' || r.unit_id where plan_id = r.id;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
create sequence if not exists public.support_ref_seq;

create table if not exists public.support_requests (
  id            text primary key,
  ref           text unique,
  function_id   text not null,                 -- the corporate function that received the request
  requester     text not null default '',      -- business unit or function that asked
  category      text not null default '',
  description   text not null default '',
  priority      text not null default 'Normal',
  date_requested date,
  status        text not null default 'Open',  -- Open, In progress, Responded, Closed, On hold
  response_date date,
  action_taken  text not null default '',
  responded_by  text not null default '',
  evidence_ref  text not null default '',
  follow_up     boolean not null default false,
  remarks       text not null default '',
  created_by    text not null default '',
  created_at    timestamptz not null default now(),
  updated_by    text not null default '',
  updated_at    timestamptz not null default now()
);
create index if not exists support_requests_fn_idx on public.support_requests (function_id, status);

create table if not exists public.feedback (
  id          text primary key,
  unit_id     text not null,
  week        date,
  from_role   text not null default 'Group Strategy',   -- CEO, DCEO or Group Strategy
  by_name     text not null default '',
  body        text not null default '',
  created_at  timestamptz not null default now(),
  ack_by      text not null default '',
  ack_at      timestamptz
);
create index if not exists feedback_unit_idx on public.feedback (unit_id, created_at desc);

create table if not exists public.corrective_actions (
  id          text primary key,
  unit_id     text not null,
  week        date,
  source      text not null default 'Self',   -- Self, CEO, DCEO or Group Strategy
  issue       text not null default '',
  action      text not null default '',
  owner       text not null default '',
  due         date,
  status      text not null default 'Open',   -- Open, In progress, Done, Closed
  task_title  text not null default '',
  notes       text not null default '',
  created_by  text not null default '',
  created_at  timestamptz not null default now(),
  updated_by  text not null default '',
  updated_at  timestamptz not null default now(),
  closed_at   timestamptz
);
create index if not exists corrective_actions_unit_idx on public.corrective_actions (unit_id, status);

alter table public.support_requests  enable row level security;
alter table public.feedback          enable row level security;
alter table public.corrective_actions enable row level security;
drop policy if exists "read" on public.support_requests;
drop policy if exists "read" on public.feedback;
drop policy if exists "read" on public.corrective_actions;
create policy "read" on public.support_requests  for select to anon, authenticated using (true);
create policy "read" on public.feedback          for select to anon, authenticated using (true);
create policy "read" on public.corrective_actions for select to anon, authenticated using (true);
-- no insert/update/delete policies: these tables change only through the functions below
revoke insert, update, delete, truncate on public.support_requests, public.feedback, public.corrective_actions from anon, authenticated;

do $$
begin
  begin execute 'alter publication supabase_realtime add table public.support_requests'; exception when duplicate_object then null; when undefined_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.feedback'; exception when duplicate_object then null; when undefined_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.corrective_actions'; exception when duplicate_object then null; when undefined_object then null; end;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Functions (same sign-in checks as the plan functions: unit PIN or approver code)
-- ---------------------------------------------------------------------------
-- Business support: the function that received the request (or Group Strategy) can add and update it.
create or replace function public.wbg_save_support(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_fn text := coalesce(p_row->>'function',''); v_id text := nullif(p_row->>'id',''); v_name text := trim(coalesce(p_auth->>'name',''));
        v_ref text; v_old public.support_requests%rowtype;
begin
  if v_fn = '' then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_is_approver(p_auth) and not public.wbg_unit_ok(p_auth, v_fn) then return jsonb_build_object('error','not_allowed'); end if;
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
declare v_old public.support_requests%rowtype;
begin
  if not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  select * into v_old from public.support_requests where id = p_id;
  if v_old.id is null then return jsonb_build_object('error','not_found'); end if;
  delete from public.support_requests where id = p_id;
  perform public.wbg_add_activity(trim(p_auth->>'name'), v_old.function_id, null, jsonb_build_object('action','support','summary','Deleted support request ' || coalesce(v_old.ref,'')));
  return jsonb_build_object('ok', true);
end $$;

-- Feedback from the CEO, DCEO or Group Strategy: written by Group Strategy approvers; the unit can acknowledge it.
create or replace function public.wbg_save_feedback(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_unit text := coalesce(p_row->>'unit',''); v_id text := nullif(p_row->>'id',''); v_name text := trim(coalesce(p_auth->>'name',''));
        v_from text := coalesce(nullif(p_row->>'from',''),'Group Strategy');
begin
  if not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  if v_unit = '' or length(trim(coalesce(p_row->>'body',''))) = 0 or v_from not in ('CEO','DCEO','Group Strategy') then return jsonb_build_object('error','bad_request'); end if;
  if v_id is not null and exists (select 1 from public.feedback where id = v_id) then
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
begin
  if not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  delete from public.feedback where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.wbg_ack_feedback(p_auth jsonb, p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_unit text;
begin
  select unit_id into v_unit from public.feedback where id = p_id;
  if v_unit is null then return jsonb_build_object('error','not_found'); end if;
  if not public.wbg_is_approver(p_auth) and not public.wbg_unit_ok(p_auth, v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  update public.feedback set ack_by = trim(coalesce(p_auth->>'name','')), ack_at = now() where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- Corrective actions: Group Strategy can log one for any unit; a unit can log and update its own. Only Group Strategy can set "Closed".
create or replace function public.wbg_save_action(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_unit text := coalesce(p_row->>'unit',''); v_id text := nullif(p_row->>'id',''); v_name text := trim(coalesce(p_auth->>'name',''));
        v_appr boolean; v_old public.corrective_actions%rowtype; v_status text := coalesce(nullif(p_row->>'status',''),'Open'); v_src text;
begin
  if v_unit = '' then return jsonb_build_object('error','bad_request'); end if;
  v_appr := public.wbg_is_approver(p_auth);
  if not v_appr and not public.wbg_unit_ok(p_auth, v_unit) then return jsonb_build_object('error','not_allowed'); end if;
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
begin
  if not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;
  delete from public.corrective_actions where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

grant execute on function public.wbg_save_support(jsonb, jsonb), public.wbg_delete_support(jsonb, text),
  public.wbg_save_feedback(jsonb, jsonb), public.wbg_delete_feedback(jsonb, text), public.wbg_ack_feedback(jsonb, text),
  public.wbg_save_action(jsonb, jsonb), public.wbg_delete_action(jsonb, text) to anon, authenticated;
