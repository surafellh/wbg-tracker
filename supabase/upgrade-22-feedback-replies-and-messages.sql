-- Upgrade 22: replies to feedback, and direct messages.
-- 1. A unit can answer feedback: the chief / GM (leader) or the planning head of that unit, as a short reply or as a letter.
--    A planning head's reply also sends a message to the unit's chief / GM. Group Strategy, the CEO and the DCEO can answer back in the same thread.
--    Whoever can read the feedback can read its replies. Employees and managers cannot reply.
-- 2. Messages (the icon next to the bell): one to one, between people of the same unit, or with Group Strategy, the CEO and the DCEO.
--    Group Strategy, the CEO and the DCEO can message anyone. A message can carry a link to a feedback thread or a task.
-- Safe to run more than once. No data is changed.

-- who wrote the feedback (so replies can notify them)
alter table public.feedback add column if not exists by_uid uuid;
create or replace function public.wbg_feedback_by_uid() returns trigger language plpgsql security definer set search_path = public as $$
begin if new.by_uid is null then new.by_uid := nullif(public.wbg_auth()->>'uid','')::uuid; end if; return new; end $$;
drop trigger if exists feedback_by_uid on public.feedback;
create trigger feedback_by_uid before insert on public.feedback for each row execute function public.wbg_feedback_by_uid();

-- ---------- messages ----------
create table if not exists public.messages (
  id text primary key,
  from_uid uuid not null, from_name text not null default '', to_uid uuid not null, to_name text not null default '',
  body text not null,
  link_kind text not null default '', link_ref text not null default '', link_unit text not null default '', link_week date, link_label text not null default '',
  created_at timestamptz not null default now(), read_at timestamptz
);
create index if not exists messages_to_idx on public.messages(to_uid, created_at desc);
create index if not exists messages_from_idx on public.messages(from_uid, created_at desc);
alter table public.messages enable row level security;
drop policy if exists "read" on public.messages;
create policy "read" on public.messages for select to authenticated using (from_uid = auth.uid() or to_uid = auth.uid());
revoke all on public.messages from anon, authenticated;
grant select on public.messages to authenticated;

-- ---------- replies ----------
create table if not exists public.feedback_replies (
  id text primary key,
  feedback_id text not null references public.feedback(id) on delete cascade,
  unit_id text not null,
  kind text not null default 'reply' check (kind in ('reply','letter')),
  subject text not null default '',
  body text not null,
  by_name text not null default '', by_role text not null default '', by_title text not null default '', by_uid uuid,
  notified text not null default '', to_lead boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists feedback_replies_idx on public.feedback_replies(feedback_id, created_at);
alter table public.feedback_replies enable row level security;
drop policy if exists "read" on public.feedback_replies;
create policy "read" on public.feedback_replies for select to authenticated using (exists (select 1 from public.feedback f where f.id = feedback_id));
revoke all on public.feedback_replies from anon, authenticated;
grant select on public.feedback_replies to authenticated;

do $$ begin
  begin execute 'alter publication supabase_realtime add table public.messages'; exception when duplicate_object then null; when undefined_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.feedback_replies'; exception when duplicate_object then null; when undefined_object then null; end;
end $$;

create or replace function public.wbg_save_reply(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wbg_auth(); v_role text := a->>'role'; v_name text := trim(coalesce(a->>'name','')); v_uid uuid := nullif(a->>'uid','')::uuid;
  v_f public.feedback%rowtype; v_id text := md5(random()::text || clock_timestamp()::text);
  v_body text := trim(coalesce(p_row->>'body','')); v_kind text := coalesce(nullif(p_row->>'kind',''),'reply'); v_subject text := trim(coalesce(p_row->>'subject',''));
  v_notified text := ''; r record; v_label text;
begin
  select * into v_f from public.feedback where id = p_row->>'feedbackId';
  if v_f.id is null then return jsonb_build_object('error','not_found'); end if;
  if v_role not in ('super_admin','executive','leader','planning') or (v_role in ('leader','planning') and a->>'unit' is distinct from v_f.unit_id) then return jsonb_build_object('error','not_allowed'); end if;
  if v_body = '' or length(v_body) > 8000 or v_kind not in ('reply','letter') or length(v_subject) > 300 then return jsonb_build_object('error','bad_request'); end if;
  insert into public.feedback_replies (id, feedback_id, unit_id, kind, subject, body, by_name, by_role, by_title, by_uid, to_lead)
  values (v_id, v_f.id, v_f.unit_id, v_kind, v_subject, v_body, v_name, v_role, coalesce(a->>'title',''), v_uid, coalesce(v_f.to_lead,false));
  -- an answer from the unit counts as acknowledging the feedback
  if v_role in ('leader','planning') and v_f.ack_at is null then update public.feedback set ack_by = v_name, ack_at = now() where id = v_f.id; end if;
  v_label := left(coalesce(nullif(v_subject,''), split_part(v_f.body, E'\n', 1)), 80);
  -- a planning head's reply, or an answer from Group Strategy / CEO / DCEO, is passed to the unit's chief / GM
  if v_role in ('planning','super_admin','executive') then
    for r in select user_id, full_name from public.profiles where unit_id = v_f.unit_id and role = 'leader' and status = 'active' and setup_done and user_id is distinct from v_uid loop
      insert into public.messages (id, from_uid, from_name, to_uid, to_name, body, link_kind, link_ref, link_unit, link_label)
      values (md5(random()::text || clock_timestamp()::text || r.user_id::text), v_uid, v_name, r.user_id, r.full_name,
        case when v_role = 'planning' then 'I replied to the feedback below for your unit. Please read it.' else 'I answered the feedback below for your unit. Please read it.' end,
        'feedback', v_f.id, v_f.unit_id, v_label);
      v_notified := v_notified || case when v_notified = '' then '' else ', ' end || r.full_name;
    end loop;
  end if;
  -- the person who wrote the feedback hears about an answer from the unit
  if v_role in ('leader','planning') and v_f.by_uid is not null and v_f.by_uid is distinct from v_uid then
    insert into public.messages (id, from_uid, from_name, to_uid, to_name, body, link_kind, link_ref, link_unit, link_label)
    select md5(random()::text || clock_timestamp()::text || 'a'), v_uid, v_name, v_f.by_uid, coalesce(trim(p.full_name),''), 'I replied to your feedback.', 'feedback', v_f.id, v_f.unit_id, v_label
    from public.profiles p where p.user_id = v_f.by_uid;
  end if;
  update public.feedback_replies set notified = v_notified where id = v_id;
  perform public.wbg_add_activity(v_name, v_f.unit_id, null, jsonb_build_object('action','feedback','summary', case when v_kind = 'letter' then 'Letter in reply from ' else 'Reply from ' end || coalesce(nullif(a->>'title',''), v_role)));
  return jsonb_build_object('ok', true, 'id', v_id, 'notified', v_notified);
end $$;

create or replace function public.wbg_delete_reply(p_auth jsonb, p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wbg_auth(); v_r public.feedback_replies%rowtype;
begin
  select * into v_r from public.feedback_replies where id = p_id;
  if v_r.id is null then return jsonb_build_object('error','not_found'); end if;
  if not (a->>'role' = 'super_admin' or v_r.by_uid = nullif(a->>'uid','')::uuid) then return jsonb_build_object('error','not_allowed'); end if;
  delete from public.feedback_replies where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- people the caller may message
create or replace function public.wbg_message_people() returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wbg_auth(); v_uid uuid := nullif(a->>'uid','')::uuid;
begin
  if v_uid is null then return jsonb_build_object('error','not_signed_in'); end if;
  return jsonb_build_object('ok', true, 'people', coalesce((
    select jsonb_agg(jsonb_build_object('id', user_id, 'name', trim(full_name), 'role', role, 'title', title, 'unit', unit_id) order by full_name)
    from public.profiles
    where status = 'active' and setup_done and trim(full_name) <> '' and user_id <> v_uid
      and (a->>'role' in ('super_admin','executive') or unit_id = a->>'unit' or role in ('super_admin','executive'))), '[]'::jsonb));
end $$;

create or replace function public.wbg_send_message(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wbg_auth(); v_uid uuid := nullif(a->>'uid','')::uuid; v_to uuid := nullif(p_row->>'to','')::uuid; v_t public.profiles%rowtype;
  v_body text := trim(coalesce(p_row->>'body','')); v_id text := md5(random()::text || clock_timestamp()::text);
begin
  if v_uid is null or v_to is null or v_to = v_uid then return jsonb_build_object('error','bad_request'); end if;
  if v_body = '' or length(v_body) > 4000 then return jsonb_build_object('error','bad_request'); end if;
  select * into v_t from public.profiles where user_id = v_to and status = 'active' and setup_done;
  if v_t.user_id is null then return jsonb_build_object('error','not_found'); end if;
  if not (a->>'role' in ('super_admin','executive') or v_t.role in ('super_admin','executive') or v_t.unit_id = a->>'unit') then return jsonb_build_object('error','not_allowed'); end if;
  insert into public.messages (id, from_uid, from_name, to_uid, to_name, body, link_kind, link_ref, link_unit, link_week, link_label)
  values (v_id, v_uid, trim(coalesce(a->>'name','')), v_to, trim(v_t.full_name), v_body,
    case when p_row->>'linkKind' in ('feedback','task') then p_row->>'linkKind' else '' end, coalesce(p_row->>'linkRef',''), coalesce(p_row->>'linkUnit',''),
    nullif(p_row->>'linkWeek','')::date, left(coalesce(p_row->>'linkLabel',''), 200));
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.wbg_read_messages(p_auth jsonb, p_with uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wbg_auth(); v_uid uuid := nullif(a->>'uid','')::uuid;
begin
  if v_uid is null then return jsonb_build_object('error','not_signed_in'); end if;
  update public.messages set read_at = now() where to_uid = v_uid and from_uid = p_with and read_at is null;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.wbg_save_reply(jsonb,jsonb), public.wbg_delete_reply(jsonb,text), public.wbg_message_people(), public.wbg_send_message(jsonb,jsonb), public.wbg_read_messages(jsonb,uuid) from public, anon;
grant execute on function public.wbg_save_reply(jsonb,jsonb), public.wbg_delete_reply(jsonb,text), public.wbg_message_people(), public.wbg_send_message(jsonb,jsonb), public.wbg_read_messages(jsonb,uuid) to authenticated;
