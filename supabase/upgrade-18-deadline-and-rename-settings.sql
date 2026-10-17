-- Upgrade 18: settings a super admin can change: the update deadline on Saturday, a one-off extension, and renaming of saved tasks.
-- Run once in the Supabase SQL Editor (safe to run again).
--
--  * grace_time   : the time on Saturday (Addis Ababa) until which the week that just ended can still be updated directly. Default 14:00.
--  * extend_until : optional date and time (Addis Ababa, "YYYY-MM-DDTHH:MM"). Until then the week that just ended stays open, whatever the day. Empty = off.
--  * allow_rename : false (default) = a saved task keeps its name once the week has started; true = the name may be changed directly.
-- They are stored in app_config, read by wbg_settings() and written only by approvers through wbg_admin_set_setting().

create or replace function public.wbg_cfg(k text) returns jsonb
language sql stable security definer set search_path to 'public' as $$ select value from public.app_config where key = k $$;

-- the end of the update period: Saturday at grace_time, or later when extend_until is set
create or replace function public.wbg_lock_monday() returns date
language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_now timestamp := now() at time zone 'Africa/Addis_Ababa';
  v_cur date := public.wbg_monday();
  v_t time := coalesce(nullif(public.wbg_cfg('grace_time') #>> '{}', ''), '14:00')::time;
  v_ext timestamp := nullif(public.wbg_cfg('extend_until') #>> '{}', '')::timestamp;
begin
  if extract(dow from v_cur) = 6 and v_now < v_cur::timestamp + v_t then return v_cur - 7; end if;
  if v_ext is not null and v_now < v_ext then return v_cur - 7; end if;
  return v_cur;
exception when others then
  return v_cur;   -- a bad setting never blocks saving
end $$;
grant execute on function public.wbg_lock_monday() to anon, authenticated;

create or replace function public.wbg_settings() returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'graceTime', coalesce(nullif(public.wbg_cfg('grace_time') #>> '{}', ''), '14:00'),
    'extendUntil', coalesce(public.wbg_cfg('extend_until') #>> '{}', ''),
    'allowRename', coalesce(public.wbg_cfg('allow_rename') = 'true'::jsonb, false))
$$;
grant execute on function public.wbg_settings() to anon, authenticated;

create or replace function public.wbg_admin_set_setting(p_key text, p_value jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare a jsonb := public.wbg_auth(); v jsonb := p_value; s text;
begin
  if not public.wbg_is_approver(a) then return jsonb_build_object('error','not_allowed'); end if;
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
  elsif p_key = 'allow_rename' then
    if jsonb_typeof(p_value) <> 'boolean' then return jsonb_build_object('error','bad_request'); end if;
  else return jsonb_build_object('error','bad_request'); end if;
  if exists (select 1 from public.app_config where key = p_key) then update public.app_config set value = v where key = p_key;
  else insert into public.app_config (key, value) values (p_key, v); end if;
  perform public.wbg_add_activity(coalesce(a->>'name',''), '', null, jsonb_build_object('action','user',
    'summary', 'Changed the setting ' || p_key || ' to ' || coalesce(nullif(v #>> '{}', ''), '(off)')));
  return jsonb_build_object('ok', true, 'settings', public.wbg_settings());
end $$;
grant execute on function public.wbg_admin_set_setting(text, jsonb) to authenticated;

-- saved tasks keep their name unless allow_rename is on
do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'wbg_save_plan';
  if d like '%v_locked text[] := array[''title'',''kind'',''dept'',''outcome'',''priority''];%' then
    d := replace(d, 'v_locked text[] := array[''title'',''kind'',''dept'',''outcome'',''priority''];',
      'v_locked text[] := case when coalesce(public.wbg_cfg(''allow_rename'') = ''true''::jsonb, false) then array[''kind'',''dept'',''outcome'',''priority''] else array[''title'',''kind'',''dept'',''outcome'',''priority''] end;');
    execute d;
  end if;
end $$;
