-- Super admin creates a person's account directly, with a random temporary password (no emailed code needed).
-- Same role/unit rules as an invite. They choose their own password at the first sign-in (must_change_password).
-- If the person already has a sign-in account but never finished setting up, it is completed and given the password.
create or replace function public.wbg_admin_create_with_password(p_data jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare a jsonb := public.wbg_auth(); e text := lower(trim(coalesce(p_data->>'email',''))); v_name text := left(trim(coalesce(p_data->>'name','')),120);
  v_role text := p_data->>'role'; v_title text := case when p_data->>'role' = 'executive' then coalesce(p_data->>'title','') else '' end;
  v_unit text := nullif(p_data->>'unit',''); v_deps jsonb := coalesce(p_data->'departments','[]'::jsonb); v_err text; v_uid uuid;
  v_alpha text := 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; v_pw text := ''; v_b bytea; i int;
begin
  if not public.wbg_ap_people(a) then return jsonb_build_object('error','not_allowed'); end if;
  if v_role = 'super_admin' and (a->>'role') is distinct from 'super_admin' then return jsonb_build_object('error','not_allowed'); end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return jsonb_build_object('error','bad_email'); end if;
  if v_name = '' then return jsonb_build_object('error','bad_request'); end if;
  if exists (select 1 from public.profiles where lower(email) = e) then return jsonb_build_object('error','already_registered'); end if;
  v_err := public.wbg__check_person(p_data);
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  v_b := extensions.gen_random_bytes(10);
  for i in 0..9 loop v_pw := v_pw || substr(v_alpha, (get_byte(v_b, i) % length(v_alpha)) + 1, 1); end loop;
  insert into public.invites (email, full_name, role, title, unit_id, departments, invited_by, used_at)
  values (e, v_name, v_role, v_title, v_unit, v_deps, a->>'name', now())
  on conflict (email) do update set full_name = excluded.full_name, role = excluded.role, title = excluded.title, unit_id = excluded.unit_id,
    departments = excluded.departments, invited_by = excluded.invited_by, used_at = now();
  select id into v_uid from auth.users where lower(email) = e;
  if v_uid is null then
    v_uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current, reauthentication_token, phone_change, phone_change_token)
    values ('00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated', e, extensions.crypt(v_pw, extensions.gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('sub', v_uid::text, 'email', e, 'email_verified', true, 'phone_verified', false, 'has_password', true, 'must_change_password', true),
        now(), now(), '', '', '', '', '', '', '', '');
    insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_uid::text, v_uid, jsonb_build_object('sub', v_uid::text, 'email', e, 'email_verified', true, 'phone_verified', false), 'email', now(), now(), now());
  else
    update auth.users set encrypted_password = extensions.crypt(v_pw, extensions.gen_salt('bf')), email_confirmed_at = coalesce(email_confirmed_at, now()),
        raw_user_meta_data = coalesce(raw_user_meta_data,'{}'::jsonb) || '{"has_password": true, "must_change_password": true}'::jsonb, updated_at = now() where id = v_uid;
    delete from auth.sessions where user_id = v_uid;
  end if;
  insert into public.profiles (user_id, email, full_name, role, title, unit_id, departments, status, setup_done, invited)
  values (v_uid, e, v_name, v_role, v_title, v_unit, v_deps, 'active', true, true);
  perform public.wbg_add_activity(a->>'name', coalesce(v_unit,''), null, jsonb_build_object('action','user','summary','Created ' || e || ' as ' || v_role || ' with a temporary password (they choose their own at the first sign-in)'));
  return jsonb_build_object('ok', true, 'password', v_pw, 'email', e, 'name', v_name);
end $$;
revoke all on function public.wbg_admin_create_with_password(jsonb) from public, anon;
grant execute on function public.wbg_admin_create_with_password(jsonb) to authenticated;
