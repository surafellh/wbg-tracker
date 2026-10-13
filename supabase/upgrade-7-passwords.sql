-- Stage 2b: email + password sign-in (the one-time code stays for first sign-in and "forgot password").
-- Run once in the Supabase SQL Editor, after upgrade-5. Safe to run again.
-- Also set in Supabase: Authentication > Sign In / Providers > Email > Minimum password length = 10.

-- Group Strategy can switch a person back to code-only sign-in (lost password, shared device, someone who left):
-- removes their password and signs them out everywhere. They sign in with a code and choose a new password.
create or replace function public.wbg_admin_reset_password(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wbg_auth(); o public.profiles%rowtype;
begin
  if not public.wbg_is_approver(a) then return jsonb_build_object('error','not_allowed'); end if;
  select * into o from public.profiles where user_id = p_user;
  if not found then return jsonb_build_object('error','not_found'); end if;
  update auth.users set encrypted_password = '',
         raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || '{"has_password": false}'::jsonb
   where id = p_user;
  delete from auth.sessions where user_id = p_user;
  perform public.wbg_add_activity(a->>'name', coalesce(o.unit_id, ''), null,
    jsonb_build_object('action','user','summary','Reset the password of ' || o.email || ' (code sign-in until a new password is set)'));
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.wbg_admin_reset_password(uuid) from public, anon;
grant execute on function public.wbg_admin_reset_password(uuid) to authenticated;
