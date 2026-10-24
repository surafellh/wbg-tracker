-- Upgrade 24: a chief, GM or director answers for everyone in their own unit or function, whatever department is set on their profile.
-- Before this, a chief whose profile listed only some departments was skipped for the other departments' plans, which went straight to Group Strategy.
-- Replaces two functions, and moves requests that are still waiting at the Group Strategy step back to the chief where the unit has one.
-- Safe to run more than once.

create or replace function public.wbg_can_decide(a jsonb, r change_requests) returns boolean
language plpgsql stable security definer set search_path to 'public' as $$
declare v_depts text[] := case when coalesce(r.dept,'') = '' then '{}'::text[] else string_to_array(r.dept, ',') end;
begin
  if coalesce(a->>'role','') = '' then return false; end if;
  if a->>'role' = 'super_admin' then return true; end if;
  if a->>'unit' is distinct from r.unit_id then return false; end if;
  if r.req_kind = 'ask' then
    if a->>'role' in ('leader','planning') then return true; end if;
    if a->>'role' = 'manager' then return cardinality(v_depts) = 0 or exists (select 1 from unnest(v_depts) d where coalesce(a->'departments','[]'::jsonb) ? d); end if;
    return false;
  end if;
  if r.requested_by_uid is not null and r.requested_by_uid = nullif(a->>'uid','')::uuid and a->>'role' <> 'planning' then return false; end if;
  if a->>'role' = 'planning' then return r.stage in ('chief','planning'); end if;
  if a->>'role' = 'leader' then return r.stage = 'chief'; end if;
  return false;
end $$;

create or replace function public.wbg_route_stage(p_unit text, p_role text, p_depts text[]) returns text
language plpgsql stable security definer set search_path to 'public' as $$
declare v_fn boolean := coalesce((select type = 'Corporate function' from public.units where id = p_unit), false); v_chief boolean; v_plan boolean;
begin
  select exists (select 1 from public.profiles p where p.unit_id = p_unit and public.wbg_base_role(p.role) = 'leader' and p.status = 'active' and p.setup_done) into v_chief;
  select exists (select 1 from public.profiles p where p.unit_id = p_unit and p.role = 'planning' and p.status = 'active' and p.setup_done) into v_plan;
  if p_role = 'planning' then return 'planning'; end if;
  if p_role in ('staff','manager') then
    if v_chief then return 'chief'; end if;
    if v_plan and not v_fn then return 'planning'; end if;
    return 'group';
  elsif p_role = 'leader' then
    if v_plan and not v_fn then return 'planning'; end if;
    return 'group';
  end if;
  return 'group';
end $$;

-- requests from a department head or employee that are still waiting at the Group Strategy step go to the chief instead
update public.change_requests r set stage = 'chief'
 where r.status = 'pending' and r.stage = 'group' and r.req_kind is distinct from 'ask'
   and exists (select 1 from public.profiles q where q.user_id = r.requested_by_uid and q.role in ('manager','staff','divhead'))
   and exists (select 1 from public.profiles c where c.unit_id = r.unit_id and public.wbg_base_role(c.role) = 'leader' and c.status = 'active' and c.setup_done);
