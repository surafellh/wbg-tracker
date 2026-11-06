-- Upgrade 31: access matrix part 2 - projects, business support, feedback reading, messages, change requests, restoring copies.
-- Same rule as upgrade 30: every rule keeps its old logic until the matrix mode is switched on, and the seeded defaults equal the old rules.

-- a rule for a unit can now be limited to one role: subject "pmo|manager"
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
    select coalesce(max(public.wbg_rank(value)), 0) into u from public.perm_grants
      where kind = 'unit' and cap = p_cap and subject in (a->>'unit', (a->>'unit') || '|' || (a->>'role'), (a->>'unit') || '|' || coalesce(a->>'rawRole', ''));
  end if;
  return greatest(r, u);
end $$;

insert into public.perm_caps (cap, grp, label, help, levels, sort) values
 ('projects_read','Projects','See projects','"All" = every project. "Own" = projects owned by their unit or where their unit is involved. "Owned only" = only projects owned by their unit.','none,dept,own,all',300),
 ('projects_write','Projects','Add and edit projects','"Own" = projects owned by their unit. "All" = any project.','none,own,all',310),
 ('projects_delete','Projects','Delete projects','','none,all',320),
 ('support_log','Business support','Log and follow their unit''s support requests','Log a request to any function and see/edit their own unit''s open requests.','none,own,all',330),
 ('request_change','Approvals','Ask for approval of a change','Send a change request (locked field, past week, removal) for approval. "Own" = their own unit.','none,own,all',335),
 ('restore_any','Plans and tasks','Restore any earlier copy, any week, any unit','Without this, a person can only restore their own recent changes in their own unit.','none,all',105),
 ('feedback_read_all','Feedback','Read all feedback of every unit','','none,all',225),
 ('letters_read','Feedback','Read letters addressed to the head of their unit','','none,own,all',226),
 ('message_all','Messages','Send messages to anyone in the company','Everyone can message their own unit and Group Strategy/CEO/DCEO.','none,all',340)
on conflict (cap) do update set grp=excluded.grp, label=excluded.label, help=excluded.help, levels=excluded.levels, sort=excluded.sort;

insert into public.perm_default_grants (kind, subject, cap, value)
select * from (values
 ('role','super_admin','projects_read','all'),('role','executive','projects_read','all'),('role','lea','projects_read','all'),('role','leader','projects_read','own'),('role','planning','projects_read','own'),
 ('unit','pmo|leader','projects_read','all'),('unit','pmo|planning','projects_read','all'),('unit','pmo|manager','projects_read','all'),('unit','niyat-consultancy|manager','projects_read','dept'),
 ('role','super_admin','projects_write','all'),('role','planning','projects_write','own'),
 ('unit','pmo|leader','projects_write','all'),('unit','pmo|planning','projects_write','all'),('unit','pmo|manager','projects_write','all'),
 ('role','super_admin','projects_delete','all'),
 ('unit','pmo|leader','projects_delete','all'),('unit','pmo|planning','projects_delete','all'),('unit','pmo|manager','projects_delete','all'),
 ('role','leader','support_log','own'),('role','planning','support_log','own'),('role','manager','support_log','own'),('role','staff','support_log','own'),
 ('role','super_admin','request_change','all'),('role','leader','request_change','own'),('role','planning','request_change','own'),('role','manager','request_change','own'),
 ('role','super_admin','restore_any','all'),
 ('role','super_admin','feedback_read_all','all'),('role','executive','feedback_read_all','all'),
 ('role','leader','letters_read','own'),('role','planning','letters_read','own'),
 ('role','super_admin','message_all','all'),('role','executive','message_all','all')
) t(kind, subject, cap, value)
on conflict do nothing;
insert into public.perm_grants (kind, subject, cap, value, updated_by)
select kind, subject, cap, value, 'default' from public.perm_default_grants d
where d.cap in ('projects_read','projects_write','projects_delete','support_log','request_change','restore_any','feedback_read_all','letters_read','message_all')
on conflict do nothing;

-- ===== projects =====
create or replace function public.wbg_project_read(p_unit text, p_involved text[]) returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when public.wbg_perm_on() then (
      case public.wbg_cap_rank(a.j, 'projects_read')
        when 3 then true
        when 2 then coalesce(a.j->>'unit','') <> '' and (a.j->>'unit' = p_unit or a.j->>'unit' = any(coalesce(p_involved,'{}')))
        when 1 then coalesce(a.j->>'unit','') <> '' and a.j->>'unit' = p_unit
        else false end)
    else coalesce(
       a.j->>'role' in ('super_admin','executive')
    or a.raw = 'lea'
    or (a.j->>'role' in ('leader','planning','manager') and a.j->>'unit' = 'pmo')
    or (a.j->>'role' in ('leader','planning') and (a.j->>'unit' = p_unit or a.j->>'unit' = any(coalesce(p_involved,'{}'))))
    or (a.j->>'role' = 'manager' and p_unit = 'niyat-consultancy' and a.j->>'unit' = p_unit), false) end
  from (select public.wbg_auth() as j,
               (select p.role from public.profiles p where p.user_id = auth.uid() and p.status = 'active' and p.setup_done) as raw) a
$$;
create or replace function public.wbg_project_write(p_unit text) returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when public.wbg_perm_on() then public.wbg_can(a.j, 'projects_write', p_unit) and (public.wbg_cap_rank(a.j, 'projects_write') >= 3 or coalesce(p_unit,'') <> '')
    else coalesce(
       a.j->>'role' = 'super_admin'
    or (a.j->>'role' in ('leader','planning','manager') and a.j->>'unit' = 'pmo')
    or (a.j->>'role' = 'planning' and a.j->>'unit' = p_unit and p_unit <> ''), false) end
  from (select public.wbg_auth() as j) a
$$;

-- ===== business support / feedback read policies =====
create or replace function public.wbg__support_member(a jsonb) returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when public.wbg_perm_on() then coalesce(a->>'unit','') <> '' and public.wbg_cap_rank(a, 'support_log') > 0
    else coalesce(a->>'role' in ('leader','planning','manager','staff'), false) end $$;
create or replace function public.wbg_support_read(p_function text, p_requester_unit text) returns boolean language sql stable security definer set search_path to 'public' as $$
  select public.wbg_unit_read(p_function) or (coalesce(p_requester_unit,'') <> '' and
    case when public.wbg_perm_on() then public.wbg_can(public.wbg_auth(), 'support_log', p_requester_unit)
         else coalesce(public.wbg_auth()->>'role' in ('leader','planning','manager','staff') and public.wbg_auth()->>'unit' = p_requester_unit, false) end) $$;
create or replace function public.wbg_feedback_read(p_unit text, p_to_lead boolean) returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when public.wbg_perm_on() then
      public.wbg_can(public.wbg_auth(), 'feedback_read_all')
      or (coalesce(p_to_lead,false) and public.wbg_can(public.wbg_auth(), 'letters_read', p_unit))
      or (not coalesce(p_to_lead,false) and public.wbg_unit_read_own(p_unit))
    else coalesce(
      (public.wbg_auth()->>'role') = any (array['super_admin','executive'])
      or (p_to_lead and (public.wbg_auth()->>'role') = any (array['leader','planning']) and (public.wbg_auth()->>'unit') = p_unit)
      or ((not coalesce(p_to_lead,false)) and public.wbg_unit_read_own(p_unit)), false) end $$;

do $$
begin
  execute 'alter policy "read" on public.support_requests using (public.wbg_support_read(function_id, requester_unit))';
  execute 'alter policy "read" on public.feedback using (public.wbg_feedback_read(unit_id, to_lead))';
end $$;

-- ===== patch helper: replace a piece of a function, failing loudly if the text is not there =====
create or replace function public.wbg__patch(p_fn text, p_old text, p_new text) returns void language plpgsql as $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = p_fn and p.prokind = 'f';
  if d is null then raise exception 'missing function %', p_fn; end if;
  if position(p_new in d) > 0 and position(p_old in d) = 0 then return; end if;   -- already patched
  if position(p_old in d) = 0 then raise exception 'function % has changed: "%" not found', p_fn, left(p_old, 60); end if;
  execute replace(d, p_old, p_new);
end $$;

-- delete project
select public.wbg__patch('wbg_delete_project',
  $q$if not (p_auth->>'role' = 'super_admin' or (p_auth->>'role' in ('leader','planning','manager') and p_auth->>'unit' = 'pmo')) then$q$,
  $q$if not (case when public.wbg_perm_on() then public.wbg_can(p_auth, 'projects_delete') else (p_auth->>'role' = 'super_admin' or (p_auth->>'role' in ('leader','planning','manager') and p_auth->>'unit' = 'pmo')) end) then$q$);

-- business support
select public.wbg__patch('wbg_save_support',
  $q$not coalesce(p_auth->>'role' in ('leader','planning','manager','staff') and coalesce(p_auth->>'unit','') <> '', false)$q$,
  $q$not public.wbg__support_member(p_auth)$q$);
select public.wbg__patch('wbg_save_support',
  $q$if not (v_old.requester_unit <> '' and v_old.requester_unit = coalesce(p_auth->>'unit','') and p_auth->>'role' in ('leader','planning','manager','staff')) then$q$,
  $q$if not (v_old.requester_unit <> '' and v_old.requester_unit = coalesce(p_auth->>'unit','') and public.wbg__support_member(p_auth)) then$q$);

-- messages
select public.wbg__patch('wbg_message_people',
  $q$(a->>'role' in ('super_admin','executive') or unit_id = a->>'unit' or role in ('super_admin','executive'))$q$,
  $q$((case when public.wbg_perm_on() then public.wbg_can(a, 'message_all') else a->>'role' in ('super_admin','executive') end) or unit_id = a->>'unit' or role in ('super_admin','executive'))$q$);
select public.wbg__patch('wbg_send_message',
  $q$if not (a->>'role' in ('super_admin','executive') or v_t.role in ('super_admin','executive') or v_t.unit_id = a->>'unit') then$q$,
  $q$if not ((case when public.wbg_perm_on() then public.wbg_can(a, 'message_all') else a->>'role' in ('super_admin','executive') end) or v_t.role in ('super_admin','executive') or v_t.unit_id = a->>'unit') then$q$);

-- change requests
select public.wbg__patch('wbg_request_change',
  $q$if p_auth->>'role' = 'staff' then return jsonb_build_object('error','view_only_role'); end if;$q$,
  $q$if p_auth->>'role' = 'staff' and not public.wbg_perm_on() then return jsonb_build_object('error','view_only_role'); end if;$q$);
select public.wbg__patch('wbg_request_change',
  $q$if not public.wbg_unit_ok(p_auth, v_unit) and not public.wbg_is_approver(p_auth) then return jsonb_build_object('error','not_allowed'); end if;$q$,
  $q$if (case when public.wbg_perm_on() then not public.wbg_can(p_auth, 'request_change', v_unit) else (not public.wbg_unit_ok(p_auth, v_unit) and not public.wbg_is_approver(p_auth)) end) then return jsonb_build_object('error', case when p_auth->>'role' = 'staff' then 'view_only_role' else 'not_allowed' end); end if;$q$);
select public.wbg__patch('wbg_request_change',
  $q$if v_role in ('manager','staff') then$q$,
  $q$if (case when public.wbg_perm_on() then not public.wbg_can(p_auth, 'plan_full', v_unit) else v_role in ('manager','staff') end) then$q$);

-- restoring an earlier copy
create or replace function public.wbg_restore_any(a jsonb) returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when public.wbg_perm_on() then public.wbg_can(a, 'restore_any') else coalesce(a->>'role' = 'super_admin', false) end $$;
create or replace function public.wbg_restore_scoped(a jsonb, p_unit text) returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when public.wbg_perm_on() then not public.wbg_can(a, 'plan_full', p_unit) else a->>'role' = 'manager' end $$;
select public.wbg__patch('wbg_restore_version',
  $q$if v_role is null or v_role in ('staff','executive') then return jsonb_build_object('error','not_allowed'); end if;$q$,
  $q$if v_role is null or (case when public.wbg_perm_on() then public.wbg_cap_rank(p_auth, 'undo_save') = 0 else v_role in ('staff','executive') end) then return jsonb_build_object('error','not_allowed'); end if;$q$);
select public.wbg__patch('wbg_restore_version',
  $q$if v_role <> 'super_admin' and coalesce(p_auth->>'unit','') <> (r->>'unit_id') then$q$,
  $q$if not public.wbg_restore_any(p_auth) and (case when public.wbg_perm_on() then not public.wbg_can(p_auth, 'undo_save', r->>'unit_id') else coalesce(p_auth->>'unit','') <> (r->>'unit_id') end) then$q$);
select public.wbg__patch('wbg_restore_version',
  $q$if v_role <> 'super_admin' and (r->>'week')::date < public.wbg_monday() then$q$,
  $q$if not public.wbg_restore_any(p_auth) and (r->>'week')::date < public.wbg_monday() then$q$);
select public.wbg__patch('wbg_restore_version',
  $q$    if v_role <> 'super_admin' then
      select count(*)$q$,
  $q$    if not public.wbg_restore_any(p_auth) then
      select count(*)$q$);
select public.wbg__patch('wbg_restore_version',
  $q$if v_role = 'manager' then v_tasks :=$q$,
  $q$if public.wbg_restore_scoped(p_auth, r->>'unit_id') then v_tasks :=$q$);
select public.wbg__patch('wbg_restore_version',
  $q$wins = case when v_role = 'manager' then public.plans.wins else excluded.wins end,
      blockers = case when v_role = 'manager' then public.plans.blockers else excluded.blockers end, asks = case when v_role = 'manager' then public.plans.asks else excluded.asks end,$q$,
  $q$wins = case when public.wbg_restore_scoped(p_auth, r->>'unit_id') then public.plans.wins else excluded.wins end,
      blockers = case when public.wbg_restore_scoped(p_auth, r->>'unit_id') then public.plans.blockers else excluded.blockers end, asks = case when public.wbg_restore_scoped(p_auth, r->>'unit_id') then public.plans.asks else excluded.asks end,$q$);
select public.wbg__patch('wbg_restore_version',
  $q$case when v_role = 'manager' then ' (own departments only)' else '' end$q$,
  $q$case when public.wbg_restore_scoped(p_auth, r->>'unit_id') then ' (own departments only)' else '' end$q$);
select public.wbg__patch('wbg_restore_version',
  $q$  elsif v_h.tbl = 'units' then
    if v_role <> 'super_admin' then return$q$,
  $q$  elsif v_h.tbl = 'units' then
    if not public.wbg_restore_any(p_auth) then return$q$);

drop function public.wbg__patch(text, text, text);

-- the admin function now accepts a unit rule limited to one role ("unit|role")
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
    if v_kind = 'role' and v_sub = 'super_admin' then return jsonb_build_object('error','protected', 'detail','Super admin access cannot be changed'); end if;
    if v_kind = 'user' and exists (select 1 from public.profiles where user_id::text = v_sub and role = 'super_admin') then return jsonb_build_object('error','protected', 'detail','Super admin access cannot be changed'); end if;
    if v_kind = 'user' and not exists (select 1 from public.profiles where user_id::text = v_sub) then return jsonb_build_object('error','bad_request'); end if;
    if v_kind = 'unit' and (not exists (select 1 from public.units where id = split_part(v_sub, '|', 1))
        or (position('|' in v_sub) > 0 and split_part(v_sub, '|', 2) not in ('leader','planning','manager','staff','executive','chief','gm','director','lea','divhead'))) then return jsonb_build_object('error','bad_request'); end if;
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
