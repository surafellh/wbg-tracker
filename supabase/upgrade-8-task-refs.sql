-- Stage 3a: task reference numbers (WE-0001), used for deliverables and for following one task across weeks.
-- Run once in the Supabase SQL Editor after upgrade-7. Safe to run again (tasks that already have a number keep it).

create table if not exists public.ref_counters (unit_id text primary key, n int not null default 0);
alter table public.ref_counters enable row level security;      -- no policies: only the functions below touch it

-- Short code for a unit from its name: "Wagwago Electric" -> WE, "Group Strategy Office" -> GSO.
-- Two units with the same letters get a number added (WE, WE2).
create or replace function public.wbg_unit_prefix(p_unit text) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_name text; v_base text; v_rank int;
begin
  select name into v_name from public.units where id = p_unit;
  if v_name is null then return 'T'; end if;
  select coalesce(nullif(left(string_agg(left(w, 1), '' order by ord), 3), ''), 'U') into v_base
    from regexp_split_to_table(upper(v_name), '[^A-Z0-9]+') with ordinality as t(w, ord)
   where w <> '' and w not in ('PLC', 'AND', 'OF', 'THE', 'FOR');
  select count(*) into v_rank from public.units u2
   where u2.id < p_unit and (select coalesce(nullif(left(string_agg(left(w, 1), '' order by ord), 3), ''), 'U')
          from regexp_split_to_table(upper(u2.name), '[^A-Z0-9]+') with ordinality as t(w, ord)
         where w <> '' and w not in ('PLC', 'AND', 'OF', 'THE', 'FOR')) = v_base;
  return v_base || case when v_rank > 0 then (v_rank + 1)::text else '' end;
end $$;

-- Hand out the next p_n numbers for a unit (one at a time, so two people never get the same number).
create or replace function public.wbg_alloc_refs(p_unit text, p_n int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wbg_auth(); v_start int;
begin
  if not (public.wbg_is_approver(a) or public.wbg_unit_ok(a, p_unit)) then return jsonb_build_object('error', 'not_allowed'); end if;
  if p_n is null or p_n < 1 or p_n > 200 then return jsonb_build_object('error', 'bad_request'); end if;
  insert into public.ref_counters(unit_id, n) values (p_unit, 0) on conflict do nothing;
  update public.ref_counters set n = n + p_n where unit_id = p_unit returning n - p_n + 1 into v_start;
  return jsonb_build_object('prefix', public.wbg_unit_prefix(p_unit), 'start', v_start);
end $$;
revoke all on function public.wbg_unit_prefix(text), public.wbg_alloc_refs(text, int) from public, anon;
grant execute on function public.wbg_alloc_refs(text, int) to authenticated;

-- Give every existing task a number. The same title in a unit (week after week) gets the same number.
do $$
declare u record; r record; e jsonb; v_prefix text; v_n int; v_map jsonb; v_k text; v_ref text; v_new jsonb; v_changed boolean;
begin
  for u in select id from public.units order by id loop
    v_prefix := public.wbg_unit_prefix(u.id);
    select coalesce(max(n), 0) into v_n from public.ref_counters where unit_id = u.id;
    v_map := '{}'::jsonb;
    for r in select p.id, p.tasks from public.plans p where p.unit_id = u.id order by p.week, p.id loop
      v_new := '[]'::jsonb; v_changed := false;
      for e in select x from jsonb_array_elements(r.tasks) x loop
        v_k := lower(regexp_replace(coalesce(e->>'title', ''), '[^a-zA-Z0-9]+', ' ', 'g'));
        if e ? 'ref' and coalesce(e->>'ref', '') <> '' then
          v_ref := e->>'ref';
          if not v_map ? v_k then v_map := v_map || jsonb_build_object(v_k, v_ref); end if;
          if v_ref ~ '-[0-9]+$' then v_n := greatest(v_n, (regexp_replace(v_ref, '^.*-', ''))::int); end if;
        else
          if v_map ? v_k then v_ref := v_map->>v_k;
          else v_n := v_n + 1; v_ref := v_prefix || '-' || lpad(v_n::text, 4, '0'); v_map := v_map || jsonb_build_object(v_k, v_ref); end if;
          e := e || jsonb_build_object('ref', v_ref); v_changed := true;
        end if;
        v_new := v_new || jsonb_build_array(e);
      end loop;
      if v_changed then update public.plans set tasks = v_new where id = r.id; end if;
    end loop;
    insert into public.ref_counters(unit_id, n) values (u.id, v_n) on conflict (unit_id) do update set n = greatest(public.ref_counters.n, excluded.n);
  end loop;
end $$;

select unit_id, n from public.ref_counters order by unit_id;
