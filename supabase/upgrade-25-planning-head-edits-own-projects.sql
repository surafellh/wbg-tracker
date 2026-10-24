-- Planning heads can edit the projects their own unit owns.
-- Adding and deleting projects stays with Group PMO and Group Strategy.
create or replace function public.wbg_project_write(p_unit text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(
       a.j->>'role' = 'super_admin'
    or (a.j->>'role' in ('leader','planning','manager') and a.j->>'unit' = 'pmo')
    or (a.j->>'role' = 'planning' and a.j->>'unit' = p_unit and p_unit <> ''), false)
  from (select public.wbg_auth() as j) a
$$;

create or replace function public.wbg_delete_project(p_auth jsonb, p_id text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_old public.projects%rowtype;
begin
  select * into v_old from public.projects where id = p_id;
  if v_old.id is null then return jsonb_build_object('ok', true); end if;
  if not (p_auth->>'role' = 'super_admin' or (p_auth->>'role' in ('leader','planning','manager') and p_auth->>'unit' = 'pmo')) then
    return jsonb_build_object('error','not_allowed');
  end if;
  delete from public.projects where id = p_id;
  return jsonb_build_object('ok', true);
end $$;
