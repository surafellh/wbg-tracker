-- Upgrade 19: feedback and corrective actions are readable only by the unit they were given to.
-- Before: wbg_unit_read() let a chief / GM (role 'leader') of ANY unit read every unit's corrective actions and ordinary feedback.
-- Now: Group Strategy and the CEO / DCEO read all; a chief / GM, planning head or manager reads only their own unit's.
-- Employees still read none. Letters to the head of the unit (to_lead) stay private to that unit's chief and planning head, Group Strategy, CEO and DCEO.
-- Chiefs and GMs still read every unit's plans, as before. Safe to run more than once.

create or replace function public.wbg_unit_read_own(p_unit text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    public.wbg_auth()->>'role' in ('super_admin','executive')
    or (public.wbg_auth()->>'role' in ('leader','planning','manager') and public.wbg_auth()->>'unit' = p_unit), false)
$$;
grant execute on function public.wbg_unit_read_own(text) to authenticated;

alter policy "read" on public.corrective_actions using (public.wbg_unit_read_own(unit_id));

alter policy "read" on public.feedback using (
  ((public.wbg_auth()->>'role') = any (array['super_admin','executive']))
  or (to_lead and (public.wbg_auth()->>'role') = any (array['leader','planning']) and (public.wbg_auth()->>'unit') = unit_id)
  or ((not to_lead) and public.wbg_unit_read_own(unit_id))
);
