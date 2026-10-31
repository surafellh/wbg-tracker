-- Super admin gives a person a random temporary password (for someone who cannot receive the sign-in code or forgot the password).
-- Their old password stops working, they are signed out everywhere, and the app makes them choose their own password at the next sign-in
-- (user metadata must_change_password, cleared by api.setPassword). Needs pgcrypto (extensions schema). Run once.
create or replace function public.wbg_admin_temp_password(p_user uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare a jsonb := public.wbg_auth(); o public.profiles%rowtype;
  v_alpha text := 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; v_pw text := ''; v_bytes bytea; i int;
begin
  if not public.wbg_is_approver(a) then return jsonb_build_object('error','not_allowed'); end if;
  select * into o from public.profiles where user_id = p_user;
  if not found then return jsonb_build_object('error','not_found'); end if;
  if p_user = (a->>'uid')::uuid then return jsonb_build_object('error','cannot_change_self'); end if;
  v_bytes := extensions.gen_random_bytes(10);
  for i in 0..9 loop v_pw := v_pw || substr(v_alpha, (get_byte(v_bytes, i) % length(v_alpha)) + 1, 1); end loop;
  update auth.users set encrypted_password = extensions.crypt(v_pw, extensions.gen_salt('bf')),
         raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || '{"has_password": true, "must_change_password": true}'::jsonb,
         updated_at = now()
   where id = p_user;
  delete from auth.sessions where user_id = p_user;
  perform public.wbg_add_activity(a->>'name', coalesce(o.unit_id, ''), null,
    jsonb_build_object('action','user','summary','Gave ' || o.email || ' a temporary password (they choose their own at the next sign-in)'));
  return jsonb_build_object('ok', true, 'password', v_pw);
end $$;
revoke all on function public.wbg_admin_temp_password(uuid) from public, anon;
grant execute on function public.wbg_admin_temp_password(uuid) to authenticated;
