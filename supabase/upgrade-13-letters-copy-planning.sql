-- Letters to the head of a unit are copied to the unit's planning head. Run once after upgrade-12 (safe to run again).
drop policy if exists "read" on public.feedback;
create policy "read" on public.feedback for select to authenticated using (
  public.wbg_auth()->>'role' in ('super_admin','executive')
  or (to_lead and public.wbg_auth()->>'role' in ('leader','planning') and public.wbg_auth()->>'unit' = unit_id)
  or (not to_lead and public.wbg_unit_read(unit_id))
);
