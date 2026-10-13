-- Stage 3b: discussion on tasks (with @mentions), notifications, and feedback / corrective actions tied to a task.
-- Safe to run twice. Run it in the SQL Editor of the TEST project first.

-- 1. Feedback and corrective actions can point at a task by its reference (for example WE-0029)
alter table public.feedback           add column if not exists task_ref text not null default '';
alter table public.corrective_actions add column if not exists task_ref text not null default '';

-- 2. Discussion on a task. Comments belong to the task's reference, so they follow the task across weeks.
create table if not exists public.task_comments (
  id         uuid primary key default gen_random_uuid(),
  unit_id    text not null,
  task_ref   text not null,
  task_id    text not null default '',
  week       date,
  by_id      uuid,
  by_name    text not null default '',
  body       text not null default '',
  mentions   jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists task_comments_idx on public.task_comments (unit_id, task_ref, created_at);
create table if not exists public.task_mentions (
  id         uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.task_comments (id) on delete cascade,
  user_id    uuid not null,
  unit_id    text not null,
  task_ref   text not null,
  task_id    text not null default '',
  week       date,
  by_name    text not null default '',
  snippet    text not null default '',
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index if not exists task_mentions_user_idx on public.task_mentions (user_id, read_at);
alter table public.task_comments enable row level security;
alter table public.task_mentions enable row level security;
revoke all on public.task_comments, public.task_mentions from anon, authenticated;   -- reached only through the functions below

-- who may take part in the discussion of a task of this unit
create or replace function public.wbg__can_discuss(a jsonb, p_unit text) returns boolean
language sql immutable as $$
  select coalesce(a->>'role' in ('super_admin','executive','leader') or a->>'unit' = p_unit, false) and coalesce(a->>'role','') <> ''
$$;

create or replace function public.wbg_task_comments(p_unit text, p_ref text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wbg_auth();
begin
  if not public.wbg__can_discuss(a, p_unit) then return jsonb_build_object('error','not_allowed'); end if;
  return jsonb_build_object('ok', true, 'comments', coalesce((
    select jsonb_agg(jsonb_build_object('id', c.id, 'by', c.by_name, 'byId', c.by_id, 'body', c.body, 'mentions', c.mentions, 'at', c.created_at) order by c.created_at)
    from public.task_comments c where c.unit_id = p_unit and c.task_ref = p_ref), '[]'::jsonb));
end $$;

create or replace function public.wbg_mentionables(p_unit text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wbg_auth();
begin
  if not public.wbg__can_discuss(a, p_unit) then return jsonb_build_object('error','not_allowed'); end if;
  return jsonb_build_object('ok', true, 'people', coalesce((
    select jsonb_agg(jsonb_build_object('id', user_id, 'name', full_name, 'role', role, 'title', title) order by full_name)
    from public.profiles where status = 'active' and setup_done and full_name <> '' and (unit_id = p_unit or role in ('super_admin','executive'))), '[]'::jsonb));
end $$;

create or replace function public.wbg_add_comment(p_unit text, p_ref text, p_task_id text, p_week date, p_body text, p_mentions jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wbg_auth(); v_id uuid; v_body text := trim(coalesce(p_body,'')); m jsonb; v_ok jsonb := '[]'::jsonb; v_uid uuid := nullif(a->>'uid','')::uuid;
        v_name text; v_snip text;
begin
  if not public.wbg__can_discuss(a, p_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if v_body = '' or coalesce(p_ref,'') = '' or length(v_body) > 4000 then return jsonb_build_object('error','bad_request'); end if;
  -- only people who may see this unit can be mentioned
  for m in select * from jsonb_array_elements(coalesce(p_mentions,'[]'::jsonb)) loop
    select full_name into v_name from public.profiles
      where user_id = nullif(m->>'id','')::uuid and status = 'active' and setup_done and (unit_id = p_unit or role in ('super_admin','executive'));
    if v_name is not null then v_ok := v_ok || jsonb_build_array(jsonb_build_object('id', m->>'id', 'name', v_name)); v_name := null; end if;
  end loop;
  insert into public.task_comments (unit_id, task_ref, task_id, week, by_id, by_name, body, mentions)
  values (p_unit, p_ref, coalesce(p_task_id,''), p_week, v_uid, trim(coalesce(a->>'name','')), v_body, v_ok) returning id into v_id;
  v_snip := left(v_body, 140);
  insert into public.task_mentions (comment_id, user_id, unit_id, task_ref, task_id, week, by_name, snippet)
  select v_id, (x->>'id')::uuid, p_unit, p_ref, coalesce(p_task_id,''), p_week, trim(coalesce(a->>'name','')), v_snip
  from jsonb_array_elements(v_ok) x where (x->>'id')::uuid is distinct from v_uid;
  perform public.wbg_add_activity(trim(coalesce(a->>'name','')), p_unit, p_week, jsonb_build_object('action','comment','summary','Comment on ' || p_ref || ': ' || left(v_body, 100)));
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.wbg_my_mentions() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'unit', unit_id, 'ref', task_ref, 'taskId', task_id, 'week', week, 'by', by_name, 'snippet', snippet, 'at', created_at) order by created_at desc), '[]'::jsonb)
  from (select * from public.task_mentions where user_id = auth.uid() and read_at is null order by created_at desc limit 50) t
$$;

create or replace function public.wbg_read_mentions(p_unit text, p_ref text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.task_mentions set read_at = now() where user_id = auth.uid() and read_at is null and unit_id = p_unit and task_ref = p_ref;
  return jsonb_build_object('ok', true);
end $$;

grant execute on function public.wbg_task_comments(text, text), public.wbg_mentionables(text),
  public.wbg_add_comment(text, text, text, date, text, jsonb), public.wbg_my_mentions(), public.wbg_read_mentions(text, text) to authenticated;
revoke execute on function public.wbg_task_comments(text, text), public.wbg_mentionables(text),
  public.wbg_add_comment(text, text, text, date, text, jsonb), public.wbg_my_mentions(), public.wbg_read_mentions(text, text) from public, anon;

-- 3. Feedback and corrective action functions now keep the task reference
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
    update public.feedback set task_ref = coalesce(p_row->>'taskRef', task_ref), unit_id = v_unit, week = nullif(p_row->>'week','')::date, from_role = v_from, body = p_row->>'body' where id = v_id;
  else
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    insert into public.feedback (id, unit_id, week, from_role, by_name, body, task_ref) values (v_id, v_unit, nullif(p_row->>'week','')::date, v_from, v_name, p_row->>'body', coalesce(p_row->>'taskRef',''));
  end if;
  perform public.wbg_add_activity(v_name, v_unit, nullif(p_row->>'week','')::date, jsonb_build_object('action','feedback','summary','Feedback from ' || v_from));
  return jsonb_build_object('ok', true, 'id', v_id);
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
    insert into public.corrective_actions (id, unit_id, week, source, issue, action, owner, due, status, task_title, task_ref, notes, created_by, updated_by, closed_at)
    values (v_id, v_unit, nullif(p_row->>'week','')::date, v_src, coalesce(p_row->>'issue',''), coalesce(p_row->>'action',''), coalesce(p_row->>'owner',''),
      nullif(p_row->>'due','')::date, v_status, coalesce(p_row->>'taskTitle',''), coalesce(p_row->>'taskRef',''), coalesce(p_row->>'notes',''), v_name, v_name,
      case when v_status in ('Done','Closed') then now() end);
  else
    update public.corrective_actions set
      source = case when v_appr and coalesce(p_row->>'source','') in ('Self','CEO','DCEO','Group Strategy') then p_row->>'source' else source end,
      issue = coalesce(p_row->>'issue',''), action = coalesce(p_row->>'action',''), owner = coalesce(p_row->>'owner',''),
      due = nullif(p_row->>'due','')::date, status = v_status, task_title = coalesce(p_row->>'taskTitle',''), task_ref = coalesce(p_row->>'taskRef', task_ref), notes = coalesce(p_row->>'notes',''),
      week = nullif(p_row->>'week','')::date, updated_by = v_name, updated_at = now(),
      closed_at = case when v_status in ('Done','Closed') then coalesce(closed_at, now()) else null end
    where id = v_id;
  end if;
  perform public.wbg_add_activity(v_name, v_unit, nullif(p_row->>'week','')::date, jsonb_build_object('action','corrective',
    'summary', (case when v_old.id is null then 'Logged corrective action: ' else 'Updated corrective action (' || v_status || '): ' end) || left(coalesce(p_row->>'action',''), 120)));
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
