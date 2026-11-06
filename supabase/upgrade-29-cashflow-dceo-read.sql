-- The DCEO can view the whole Cash flow module (read only). Writing stays with the super admin and Group Finance.
create or replace function public.wbg_cf_any()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.wbg_auth()->>'role' = 'super_admin' or public.wbg_auth()->>'unit' = 'group-finance-function'
    or (public.wbg_auth()->>'rawRole' = 'executive' and public.wbg_auth()->>'title' = 'DCEO'), false)
$$;
create or replace function public.wbg_cf_write(p_unit text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.wbg_auth()->>'role' = 'super_admin' or public.wbg_auth()->>'unit' = 'group-finance-function', false)
$$;
create or replace function public.wbg_cf_write_any()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.wbg_auth()->>'role' = 'super_admin' or public.wbg_auth()->>'unit' = 'group-finance-function', false)
$$;
