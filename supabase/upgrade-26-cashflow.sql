-- Cash flow for Group Finance: tables, functions and starting list of types. Safe to run twice.
-- Combines the cash flow parts of the test upgrades 21, 22, 23, 24, 27, 28, 33 and 34 for the live database.

-- ---------- 2. cash flow: access (Group Finance only, plus the super admin who looks after the app) ----------
create or replace function public.wbg_cf_fin_dept() returns boolean
language sql stable security definer set search_path to 'public' as $$ select false $$;
create or replace function public.wbg_cf_any() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.wbg_auth()->>'role' = 'super_admin' or public.wbg_auth()->>'unit' = 'group-finance-function', false)
$$;
create or replace function public.wbg_cf_read(p_unit text) returns boolean
language sql stable security definer set search_path to 'public' as $$ select public.wbg_cf_any() $$;
create or replace function public.wbg_cf_write(p_unit text) returns boolean
language sql stable security definer set search_path to 'public' as $$ select public.wbg_cf_any() $$;
create or replace function public.wbg_cf_write_any() returns boolean
language sql stable security definer set search_path to 'public' as $$ select public.wbg_cf_any() $$;

-- ---------- 3. cash flow: tables ----------
-- Lookup list of collection / payment types (the dropdown). Anyone with write access can add one; the code is what finance already uses.
create table if not exists public.cf_types (
  id text primary key, code text not null unique, label text not null default '',
  kind text not null default 'both' check (kind in ('in','out','both')),
  section text not null default 'operating' check (section in ('operating','investing','financing','intercompany','other')),
  grp text not null default '', description text not null default '',
  expected boolean not null default true,            -- false: not expected to be collected or paid in the foreseeable future (for example related parties)
  confirmed boolean not null default false,          -- finance has confirmed the meaning
  active boolean not null default true, sort int not null default 100,
  created_by text not null default '', created_at timestamptz not null default now(), updated_by text not null default '', updated_at timestamptz not null default now()
);
-- Collections (money we expect to receive) and payables (money we must pay), one row each, kept until settled.
create table if not exists public.cf_items (
  id text primary key, unit_id text not null, kind text not null check (kind in ('in','out')),
  party text not null default '', description text not null default '', ref text not null default '',
  type_code text not null default '', bucket int not null default 1 check (bucket in (1,2,3)),   -- 1 / 11 short, 2 / 22 within two months, 3 / 33 long term
  amount numeric not null default 0, currency text not null default 'ETB', priority text not null default 'Normal',
  expected date, status text not null default 'open' check (status in ('open','settled','written_off')),
  settled_on date, note text not null default '', entered_on date not null default current_date,
  created_by text not null default '', created_at timestamptz not null default now(), updated_by text not null default '', updated_at timestamptz not null default now()
);
create index if not exists cf_items_unit_idx on public.cf_items(unit_id, status);
-- Daily bank position: one row per unit, bank and day (bank "All banks" when only the total is kept).
create table if not exists public.cf_bank (
  id text primary key, unit_id text not null, bank text not null default 'All banks', day date not null,
  opening numeric not null default 0, inflow numeric not null default 0, outflow numeric not null default 0, closing numeric not null default 0,
  note text not null default '', updated_by text not null default '', updated_at timestamptz not null default now(),
  unique (unit_id, bank, day)
);
create index if not exists cf_bank_unit_day_idx on public.cf_bank(unit_id, day);
-- Planned cash flow lines by month (the forecast sheet): operating / investing / financing, inflow or outflow.
create table if not exists public.cf_plan (
  id text primary key, unit_id text not null, month text not null,              -- 'YYYY-MM'
  kind text not null check (kind in ('in','out')), section text not null default 'operating' check (section in ('operating','investing','financing')),
  label text not null default '', amount numeric not null default 0, note text not null default '',
  updated_by text not null default '', updated_at timestamptz not null default now()
);
create index if not exists cf_plan_unit_idx on public.cf_plan(unit_id, month);
create table if not exists public.cf_settings (id text primary key, value text not null default '', updated_by text not null default '', updated_at timestamptz not null default now());

alter table public.cf_types enable row level security; alter table public.cf_items enable row level security; alter table public.cf_bank enable row level security;
alter table public.cf_plan enable row level security; alter table public.cf_settings enable row level security;
drop policy if exists "read" on public.cf_types;    create policy "read" on public.cf_types    for select to authenticated using (public.wbg_cf_any());
drop policy if exists "read" on public.cf_settings; create policy "read" on public.cf_settings for select to authenticated using (public.wbg_cf_any());
drop policy if exists "read" on public.cf_items;    create policy "read" on public.cf_items    for select to authenticated using (public.wbg_cf_read(unit_id));
drop policy if exists "read" on public.cf_bank;     create policy "read" on public.cf_bank     for select to authenticated using (public.wbg_cf_read(unit_id));
drop policy if exists "read" on public.cf_plan;     create policy "read" on public.cf_plan     for select to authenticated using (public.wbg_cf_read(unit_id));
revoke all on public.cf_types, public.cf_items, public.cf_bank, public.cf_plan, public.cf_settings from anon, authenticated;
grant select on public.cf_types, public.cf_items, public.cf_bank, public.cf_plan, public.cf_settings to authenticated;

-- ---------- 4. cash flow: saving (rows are written through these functions only) ----------
create or replace function public.wbg_cf_save_item(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_id text := nullif(p_row->>'id',''); v_unit text := coalesce(p_row->>'unit','');
  v_name text := trim(coalesce(p_auth->>'name','')); v_kind text := p_row->>'kind'; v_status text := coalesce(nullif(p_row->>'status',''),'open');
  v_bucket int := coalesce(nullif(p_row->>'bucket','')::int, 1); v_old public.cf_items%rowtype;
begin
  if v_unit = '' or v_kind not in ('in','out') or v_bucket not in (1,2,3) or v_status not in ('open','settled','written_off') then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if v_id is not null then select * into v_old from public.cf_items where id = v_id; end if;
  if v_old.id is not null and not public.wbg_cf_write(v_old.unit_id) then return jsonb_build_object('error','not_allowed'); end if;
  if v_old.id is null then
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    insert into public.cf_items (id, unit_id, kind, party, description, ref, type_code, bucket, amount, currency, priority, expected, status, settled_on, note, entered_on, created_by, updated_by)
    values (v_id, v_unit, v_kind, coalesce(p_row->>'party',''), coalesce(p_row->>'description',''), coalesce(p_row->>'ref',''), coalesce(p_row->>'typeCode',''), v_bucket,
      coalesce(nullif(p_row->>'amount','')::numeric, 0), coalesce(nullif(p_row->>'currency',''),'ETB'), coalesce(nullif(p_row->>'priority',''),'Normal'), nullif(p_row->>'expected','')::date,
      v_status, nullif(p_row->>'settledOn','')::date, coalesce(p_row->>'note',''), coalesce(nullif(p_row->>'enteredOn','')::date, current_date), v_name, v_name);
  else
    update public.cf_items set unit_id = v_unit, kind = v_kind, party = coalesce(p_row->>'party',''), description = coalesce(p_row->>'description',''), ref = coalesce(p_row->>'ref',''),
      type_code = coalesce(p_row->>'typeCode',''), bucket = v_bucket, amount = coalesce(nullif(p_row->>'amount','')::numeric, 0), currency = coalesce(nullif(p_row->>'currency',''),'ETB'),
      priority = coalesce(nullif(p_row->>'priority',''),'Normal'), expected = nullif(p_row->>'expected','')::date, status = v_status, settled_on = nullif(p_row->>'settledOn','')::date,
      note = coalesce(p_row->>'note',''), updated_by = v_name, updated_at = now() where id = v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.wbg_cf_save_bank(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text := coalesce(p_row->>'unit',''); v_name text := trim(coalesce(p_auth->>'name','')); v_bank text := coalesce(nullif(trim(p_row->>'bank'),''),'All banks');
  v_day date := nullif(p_row->>'day','')::date; v_id text;
begin
  if v_unit = '' or v_day is null then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  insert into public.cf_bank (id, unit_id, bank, day, opening, inflow, outflow, closing, note, updated_by)
  values (md5(v_unit || '|' || v_bank || '|' || v_day::text), v_unit, v_bank, v_day, coalesce(nullif(p_row->>'opening','')::numeric,0), coalesce(nullif(p_row->>'inflow','')::numeric,0),
    coalesce(nullif(p_row->>'outflow','')::numeric,0), coalesce(nullif(p_row->>'closing','')::numeric,0), coalesce(p_row->>'note',''), v_name)
  on conflict (unit_id, bank, day) do update set opening = excluded.opening, inflow = excluded.inflow, outflow = excluded.outflow, closing = excluded.closing, note = excluded.note, updated_by = excluded.updated_by, updated_at = now()
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.wbg_cf_save_plan(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_id text := nullif(p_row->>'id',''); v_unit text := coalesce(p_row->>'unit',''); v_name text := trim(coalesce(p_auth->>'name',''));
  v_old public.cf_plan%rowtype;
begin
  if v_unit = '' or coalesce(p_row->>'month','') !~ '^\d{4}-\d{2}$' or p_row->>'kind' not in ('in','out') or coalesce(nullif(p_row->>'section',''),'operating') not in ('operating','investing','financing') then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if v_id is not null then select * into v_old from public.cf_plan where id = v_id; end if;
  if v_old.id is not null and not public.wbg_cf_write(v_old.unit_id) then return jsonb_build_object('error','not_allowed'); end if;
  if v_old.id is null then
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    insert into public.cf_plan (id, unit_id, month, kind, section, label, amount, note, updated_by) values (v_id, v_unit, p_row->>'month', p_row->>'kind', coalesce(nullif(p_row->>'section',''),'operating'), coalesce(p_row->>'label',''), coalesce(nullif(p_row->>'amount','')::numeric,0), coalesce(p_row->>'note',''), v_name);
  else
    update public.cf_plan set unit_id = v_unit, month = p_row->>'month', kind = p_row->>'kind', section = coalesce(nullif(p_row->>'section',''),'operating'), label = coalesce(p_row->>'label',''), amount = coalesce(nullif(p_row->>'amount','')::numeric,0), note = coalesce(p_row->>'note',''), updated_by = v_name, updated_at = now() where id = v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.wbg_cf_save_type(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_id text := nullif(p_row->>'id',''); v_code text := trim(coalesce(p_row->>'code','')); v_name text := trim(coalesce(p_auth->>'name',''));
  v_old public.cf_types%rowtype; v_admin boolean := coalesce(p_auth->>'role' = 'super_admin' or p_auth->>'unit' = 'group-finance-function', false);
begin
  if v_code = '' or coalesce(nullif(p_row->>'kind',''),'both') not in ('in','out','both') or coalesce(nullif(p_row->>'section',''),'operating') not in ('operating','investing','financing','intercompany','other') then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_cf_write_any() then return jsonb_build_object('error','not_allowed'); end if;
  if v_id is not null then select * into v_old from public.cf_types where id = v_id; end if;
  if v_old.id is null then
    if exists (select 1 from public.cf_types where lower(code) = lower(v_code)) then return jsonb_build_object('error','exists'); end if;
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    insert into public.cf_types (id, code, label, kind, section, grp, description, expected, confirmed, active, sort, created_by, updated_by)
    values (v_id, v_code, coalesce(nullif(p_row->>'label',''), v_code), coalesce(nullif(p_row->>'kind',''),'both'), coalesce(nullif(p_row->>'section',''),'operating'), coalesce(p_row->>'grp',''), coalesce(p_row->>'description',''),
      coalesce((p_row->>'expected')::boolean, true), false, true, coalesce(nullif(p_row->>'sort','')::int, 100), v_name, v_name);
  else
    -- renaming the code or hiding a type changes every list: Group Finance / Group Strategy only
    if (v_old.code <> v_code or v_old.active <> coalesce((p_row->>'active')::boolean, v_old.active)) and not v_admin then return jsonb_build_object('error','not_allowed'); end if;
    update public.cf_types set code = v_code, label = coalesce(nullif(p_row->>'label',''), v_code), kind = coalesce(nullif(p_row->>'kind',''),'both'), section = coalesce(nullif(p_row->>'section',''),'operating'),
      grp = coalesce(p_row->>'grp',''), description = coalesce(p_row->>'description',''), expected = coalesce((p_row->>'expected')::boolean, true),
      confirmed = case when v_admin then coalesce((p_row->>'confirmed')::boolean, confirmed) else confirmed end, active = coalesce((p_row->>'active')::boolean, active),
      sort = coalesce(nullif(p_row->>'sort','')::int, sort), updated_by = v_name, updated_at = now() where id = v_id;
    if v_old.code <> v_code then update public.cf_items set type_code = v_code where type_code = v_old.code; end if;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.wbg_cf_save_setting(p_auth jsonb, p_key text, p_value text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth();
begin
  if not (coalesce(p_auth->>'role' = 'super_admin' or p_auth->>'unit' = 'group-finance-function', false)) then return jsonb_build_object('error','not_allowed'); end if;
  if p_key not in ('usd_etb') then return jsonb_build_object('error','bad_request'); end if;
  insert into public.cf_settings (id, value, updated_by) values (p_key, coalesce(p_value,''), trim(coalesce(p_auth->>'name','')))
  on conflict (id) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.wbg_cf_delete(p_auth jsonb, p_table text, p_id text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text;
begin
  if p_table = 'cf_items' then select unit_id into v_unit from public.cf_items where id = p_id;
  elsif p_table = 'cf_plan' then select unit_id into v_unit from public.cf_plan where id = p_id;
  elsif p_table = 'cf_bank' then select unit_id into v_unit from public.cf_bank where id = p_id;
  else return jsonb_build_object('error','bad_request'); end if;
  if v_unit is null then return jsonb_build_object('ok', true); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if p_table = 'cf_items' then delete from public.cf_items where id = p_id;
  elsif p_table = 'cf_plan' then delete from public.cf_plan where id = p_id;
  else delete from public.cf_bank where id = p_id; end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.wbg_cf_save_item(jsonb,jsonb), public.wbg_cf_save_bank(jsonb,jsonb), public.wbg_cf_save_plan(jsonb,jsonb), public.wbg_cf_save_type(jsonb,jsonb),
  public.wbg_cf_save_setting(jsonb,text,text), public.wbg_cf_delete(jsonb,text,text) from public, anon;
grant execute on function public.wbg_cf_save_item(jsonb,jsonb), public.wbg_cf_save_bank(jsonb,jsonb), public.wbg_cf_save_plan(jsonb,jsonb), public.wbg_cf_save_type(jsonb,jsonb),
  public.wbg_cf_save_setting(jsonb,text,text), public.wbg_cf_delete(jsonb,text,text) to authenticated;

do $$ declare t text; begin
  foreach t in array array['cf_types','cf_items','cf_bank','cf_plan','cf_settings'] loop
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename=t) then execute format('alter publication supabase_realtime add table public.%I', t); end if;
  end loop;
end $$;

insert into public.cf_settings (id, value) values ('usd_etb', '') on conflict do nothing;

-- ---------- 5. starting list of types (the dropdown). The meanings are not confirmed by finance yet; finance can edit them on the Types screen. ----------
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('0cc6101983e176ece393361ec0829825','Train I','Training, internal','in','operating','Training','Internal training of Geez, from which a collection is expected.',true,false,10,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('71967fa524225121a1f2308aa63db31f','Train E','Training, external','in','operating','Training','External training.',true,false,20,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('d3dba2e2d3edf3c6b6614fa107d505b7','Mkt E','Marketing, external','in','operating','Marketing','Marketing services for external clients.',true,false,30,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('af1a830ac73edc22fa5d081b00de95cd','Maint','Maintenance','in','operating','Maintenance','Maintenance services.',true,false,40,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('15de6042b4d872bb1642c98f670869ea','HW','HW','both','operating','','',true,false,50,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('a71e1af5e2e0d892c17be27ee12f0e36','WHT','Withholding tax','both','operating','Taxes','',true,false,60,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('600691c3566cfc8d86dc615e465ecff7','LC','Letter of credit (goods to import and sell)','in','operating','Sales on LC','An LC has been opened and the materials are expected to be imported soon and sold. Some may be raw materials that are produced and sold.',true,false,70,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('8b89aabb519905a693ddd0edf0876a59','RP','Related parties','in','other','Related parties','Businesses or people who borrowed from or owe us. Not expected to pay in the foreseeable future; some may be written off.',false,false,80,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('fcb303b36ab0a28cacf9552d03e2a1bb','Stock','Stock in inventory','in','operating','Stock','Goods in inventory, to be sold.',true,false,90,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('910678e070a57d4bc8c7b023a0254025','Truck','Truck','in','operating','','',true,false,100,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('fe3c95a276c1ba758d32d481231eec37','Sister Comp','Sister company','in','intercompany','Intercompany','Lent by Wagwago Electric to other business units.',true,false,110,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('21f0c2eb798235aba25fa83c5fe6e27a','Express I','Express I','in','operating','','',true,false,120,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('a07c0f6a75a804d4f8d188f891843549','Express E','Express E','in','operating','','',true,false,130,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('3c6483bfebdd3b9730cc4d1a25b02b2b','Pension','Pension','out','operating','Taxes and pension','',true,false,140,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('45def3ee7335ed041764b663e38d57a7','Inc Tax','Income tax','out','operating','Taxes and pension','Income tax.',true,false,150,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('6e3483e014c995d9d10b2a8a95f83b46','VAT','VAT','out','operating','Taxes and pension','',true,false,160,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('c6455c53fe907590297f8165a57d4a8d','purchase','Purchase','out','operating','Purchases','',true,false,170,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('66c8c6547fb231bd4d95dcfbc4624ae5','Salary','Salary','out','operating','Payroll','',true,false,180,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('19f2885a5ec0fd88b34ed2e812fd94d3','Rental C','Rental car','out','operating','Rent','Rental car (also written RC).',true,false,190,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('62b15adf0d54528706abdbc91308c452','Rental HO','Rent, head office','out','operating','Rent','HO means head office.',true,false,200,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('982a194c94a01ba9df9cd2923919d500','Rental Hana','Rent, Hana Mariam site','out','operating','Rent','Rental for the Hana Mariam site (believed to be a showroom).',true,false,210,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('8f48dc6b29d5eebd780a2a9be15ef149','Rental Mek','Rent, Mekelle','out','operating','Rent','',true,false,220,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('e3a62bfc12aa99c58750778702bd6fa5','Rental Factory Mek','Rent, factory Mekelle','out','operating','Rent','',true,false,230,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('03c7312ad82baefc71aca223e2d36870','Rental Off Mek','Rent, office Mekelle','out','operating','Rent','',true,false,240,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('fa0ae2191b0179764dc0e8868a946b8b','Rental- Gelan','Rent, Gelan','out','operating','Rent','',true,false,250,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('eea8174163ed7c64296dad473c5bb0fb','Rental','Rent (not specified)','out','operating','Rent','',true,false,260,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('a52cb93b3328b927e0ecf3f6f9716571','WBG C& Sav','WBG C& Sav','out','other','','',true,false,270,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('3a83d27f9ba92c01f8e777cf65b9efac','Djibouti','Djibouti','out','operating','','',true,false,280,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('2133157b13edf03312b24a27128d2bbf','Utility','Utilities','out','operating','Utilities','',true,false,290,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('673cafb900937499077b710128ab0436','LC RM','LC, raw materials','out','operating','LC payments','',true,false,300,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('d973f0f3d7be2a7cb04fe60b42f1af4b','LC laptop','LC, laptops','out','investing','LC payments','',true,false,310,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('b07bb0e89269c851ae3651fe8d5345ec','LC BYD 21','LC, BYD vehicles','out','investing','LC payments','',true,false,320,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('bb411df7ef9a0a1c12b69224dd3fb689','Custom G','Customs','out','operating','Customs and ERCA','',true,false,330,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('779ff6a8c8c0dc77a671002d5bc6833f','Loan WB','Loan WB','out','financing','Loans','',true,false,340,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('ab45721d64b0fad822ed7e02baa001ef','Loan CBE','Loan, CBE','out','financing','Loans','',true,false,350,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('b49dfb59ab616d90d95d2e16f6402323','Loan Staff','Loan, staff','out','financing','Loans','',true,false,360,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('b8882ffd77f7b8ef1174a11de4265395','Loan Anbesa','Loan, Anbesa','out','financing','Loans','',true,false,370,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('ddf55237aeb02d583074e3970a449572','Construction','Construction','out','investing','Capital','',true,false,380,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('f8fbda2a12ba8e114c8c47db561bd8a9','Final Factory purchase','Final factory purchase','out','investing','Capital','',true,false,390,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('29782af69c8283da6c0edb83628e25f9','ERP','ERP','out','investing','Capital','',true,false,400,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('9d130bea89d65b34a6dd2d138a4d3cc0','Afri Insu','Insurance, Africa Insurance','out','operating','Insurance','',true,false,410,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('e42479c7ec0dcf4d5c6ead585cb7701a','Profit -audit','Profit tax audit','out','operating','Taxes and pension','',true,false,420,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('8a7be9630a4dc2e064f4799071935e1f','Rwanda','Rwanda','out','operating','','',true,false,430,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('78354163cff3bbbc9673712661fc9144','Board fee','Board fee','out','operating','Board','',true,false,440,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('509c88c5cd256fde06632cc8cd384f47','Board fee-hab','Board fee, HAB','out','operating','Board','',true,false,450,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('51b37dca8052a2834f9860fd80d0874c','Inc Tax n Pension Mek','Income tax and pension, Mekelle','out','operating','Taxes and pension','',true,false,460,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('5bd067ebd786e5ade0208b664a5bf0ee','Social Mek','Social, Mekelle','out','operating','','',true,false,470,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('d99c7c928127593808fff5c345967d60','Social HO','Social, head office','out','operating','','',true,false,480,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('5ee84665c5429d2518fddcf1a7488c51','Fuel Mek','Fuel, Mekelle','out','operating','','',true,false,490,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('c7fa7c7d0a258af732d9358ed011915d','Security service','Security service','out','operating','','',true,false,500,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('56e482f17404c4ff2f92d72c555acc27','Transp','Transportation','out','operating','','',true,false,510,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('6bf5fb9036aa51e065c4cb1336f15a1a','allowance','Allowance','out','operating','Payroll','',true,false,520,'Import','Import') on conflict (code) do nothing;
insert into public.cf_types (id,code,label,kind,section,grp,description,expected,confirmed,sort,created_by,updated_by) values ('386b8421e565344cdeac9134575305bf','Trainer','Trainer fee','out','operating','Training','',true,false,530,'Import','Import') on conflict (code) do nothing;

-- ======== from upgrade-22-cashflow-daily-log.sql ========
-- Cash flow, round 2: a daily log of what cash really moved (linked to the planned line by a code), and a link code on every planned line.
-- Run in the Supabase SQL editor after upgrade-21.

-- 1. A short code on every collection / payment line (CF-00001 ...). The daily log points to it, so a partial payment is traced to its line.
create sequence if not exists public.cf_item_seq;
alter table public.cf_items add column if not exists code text;
update public.cf_items set code = 'CF-' || lpad(nextval('public.cf_item_seq')::text, 5, '0') where code is null;
alter table public.cf_items alter column code set default ('CF-' || lpad(nextval('public.cf_item_seq')::text, 5, '0'));
create unique index if not exists cf_items_code_uq on public.cf_items(code);

-- 2. The daily log: one row per cash movement, with the bank that was credited or debited.
create table if not exists public.cf_log (
  id text primary key, unit_id text not null, day date not null, kind text not null check (kind in ('in','out')),
  bank text not null default '', amount numeric not null default 0, currency text not null default 'ETB',
  party text not null default '', description text not null default '', type_code text not null default '',
  item_id text, item_code text not null default '', note text not null default '',
  created_by text not null default '', created_at timestamptz not null default now(), updated_by text not null default '', updated_at timestamptz not null default now()
);
create index if not exists cf_log_unit_day_idx on public.cf_log(unit_id, day);
create index if not exists cf_log_item_idx on public.cf_log(item_id);
alter table public.cf_log enable row level security;
drop policy if exists "read" on public.cf_log; create policy "read" on public.cf_log for select to authenticated using (public.wbg_cf_read(unit_id));
revoke all on public.cf_log from anon, authenticated; grant select on public.cf_log to authenticated;

create or replace function public.wbg_cf_save_log(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_id text := nullif(p_row->>'id',''); v_unit text := coalesce(p_row->>'unit',''); v_name text := trim(coalesce(p_auth->>'name',''));
  v_kind text := p_row->>'kind'; v_day date := nullif(p_row->>'day','')::date; v_old public.cf_log%rowtype; v_item text := nullif(p_row->>'itemId','');
  v_code text := coalesce(p_row->>'itemCode','');
begin
  if v_unit = '' or v_day is null or v_kind not in ('in','out') then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if v_id is not null then select * into v_old from public.cf_log where id = v_id; end if;
  if v_old.id is not null and not public.wbg_cf_write(v_old.unit_id) then return jsonb_build_object('error','not_allowed'); end if;
  if v_item is not null then select code into v_code from public.cf_items where id = v_item and unit_id = v_unit; if v_code is null then return jsonb_build_object('error','bad_request'); end if; end if;
  if v_old.id is null then
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    insert into public.cf_log (id, unit_id, day, kind, bank, amount, currency, party, description, type_code, item_id, item_code, note, created_by, updated_by)
    values (v_id, v_unit, v_day, v_kind, coalesce(p_row->>'bank',''), coalesce(nullif(p_row->>'amount','')::numeric,0), coalesce(nullif(p_row->>'currency',''),'ETB'), coalesce(p_row->>'party',''),
      coalesce(p_row->>'description',''), coalesce(p_row->>'typeCode',''), v_item, v_code, coalesce(p_row->>'note',''), v_name, v_name);
  else
    update public.cf_log set day = v_day, kind = v_kind, bank = coalesce(p_row->>'bank',''), amount = coalesce(nullif(p_row->>'amount','')::numeric,0), currency = coalesce(nullif(p_row->>'currency',''),'ETB'),
      party = coalesce(p_row->>'party',''), description = coalesce(p_row->>'description',''), type_code = coalesce(p_row->>'typeCode',''), item_id = v_item, item_code = v_code,
      note = coalesce(p_row->>'note',''), updated_by = v_name, updated_at = now() where id = v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.wbg_cf_delete(p_auth jsonb, p_table text, p_id text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text;
begin
  if p_table = 'cf_items' then select unit_id into v_unit from public.cf_items where id = p_id;
  elsif p_table = 'cf_plan' then select unit_id into v_unit from public.cf_plan where id = p_id;
  elsif p_table = 'cf_bank' then select unit_id into v_unit from public.cf_bank where id = p_id;
  elsif p_table = 'cf_log' then select unit_id into v_unit from public.cf_log where id = p_id;
  else return jsonb_build_object('error','bad_request'); end if;
  if v_unit is null then return jsonb_build_object('ok', true); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if p_table = 'cf_items' then delete from public.cf_log where item_id = p_id; delete from public.cf_items where id = p_id;
  elsif p_table = 'cf_plan' then delete from public.cf_plan where id = p_id;
  elsif p_table = 'cf_log' then delete from public.cf_log where id = p_id;
  else delete from public.cf_bank where id = p_id; end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.wbg_cf_save_log(jsonb,jsonb), public.wbg_cf_delete(jsonb,text,text) from public, anon;
grant execute on function public.wbg_cf_save_log(jsonb,jsonb), public.wbg_cf_delete(jsonb,text,text) to authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='cf_log') then alter publication supabase_realtime add table public.cf_log; end if;
end $$;

-- ======== from upgrade-23-cashflow-original-total.sql ========
-- Cash flow: a line keeps the amount still to be collected or paid ("amount", shown as Remaining) and an optional original total for reference.
-- Run in the Supabase SQL editor after upgrade-22.
alter table public.cf_items add column if not exists total_amount numeric;

create or replace function public.wbg_cf_save_item(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_id text := nullif(p_row->>'id',''); v_unit text := coalesce(p_row->>'unit','');
  v_name text := trim(coalesce(p_auth->>'name','')); v_kind text := p_row->>'kind'; v_status text := coalesce(nullif(p_row->>'status',''),'open');
  v_bucket int := coalesce(nullif(p_row->>'bucket','')::int, 1); v_total numeric := nullif(p_row->>'total','')::numeric; v_old public.cf_items%rowtype;
begin
  if v_unit = '' or v_kind not in ('in','out') or v_bucket not in (1,2,3) or v_status not in ('open','settled','written_off') then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if v_id is not null then select * into v_old from public.cf_items where id = v_id; end if;
  if v_old.id is not null and not public.wbg_cf_write(v_old.unit_id) then return jsonb_build_object('error','not_allowed'); end if;
  if v_old.id is null then
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    insert into public.cf_items (id, unit_id, kind, party, description, ref, type_code, bucket, amount, total_amount, currency, priority, expected, status, settled_on, note, entered_on, created_by, updated_by)
    values (v_id, v_unit, v_kind, coalesce(p_row->>'party',''), coalesce(p_row->>'description',''), coalesce(p_row->>'ref',''), coalesce(p_row->>'typeCode',''), v_bucket,
      coalesce(nullif(p_row->>'amount','')::numeric, 0), v_total, coalesce(nullif(p_row->>'currency',''),'ETB'), coalesce(nullif(p_row->>'priority',''),'Normal'), nullif(p_row->>'expected','')::date,
      v_status, nullif(p_row->>'settledOn','')::date, coalesce(p_row->>'note',''), coalesce(nullif(p_row->>'enteredOn','')::date, current_date), v_name, v_name);
  else
    update public.cf_items set unit_id = v_unit, kind = v_kind, party = coalesce(p_row->>'party',''), description = coalesce(p_row->>'description',''), ref = coalesce(p_row->>'ref',''),
      type_code = coalesce(p_row->>'typeCode',''), bucket = v_bucket, amount = coalesce(nullif(p_row->>'amount','')::numeric, 0), total_amount = v_total, currency = coalesce(nullif(p_row->>'currency',''),'ETB'),
      priority = coalesce(nullif(p_row->>'priority',''),'Normal'), expected = nullif(p_row->>'expected','')::date, status = v_status, settled_on = nullif(p_row->>'settledOn','')::date,
      note = coalesce(p_row->>'note',''), updated_by = v_name, updated_at = now() where id = v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
revoke all on function public.wbg_cf_save_item(jsonb,jsonb) from public, anon;
grant execute on function public.wbg_cf_save_item(jsonb,jsonb) to authenticated;

-- ======== from upgrade-24-cashflow-undo-delete.sql ========
-- Cash flow: deleting a collection / payment line or a cash movement now keeps it (marked deleted) so it can be restored.
-- Run in the Supabase SQL editor after upgrade-23.
alter table public.cf_items add column if not exists deleted_at timestamptz, add column if not exists deleted_by text not null default '';
alter table public.cf_log   add column if not exists deleted_at timestamptz, add column if not exists deleted_by text not null default '';

create or replace function public.wbg_cf_delete(p_auth jsonb, p_table text, p_id text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text; v_name text := trim(coalesce(p_auth->>'name',''));
begin
  if p_table = 'cf_items' then select unit_id into v_unit from public.cf_items where id = p_id;
  elsif p_table = 'cf_plan' then select unit_id into v_unit from public.cf_plan where id = p_id;
  elsif p_table = 'cf_bank' then select unit_id into v_unit from public.cf_bank where id = p_id;
  elsif p_table = 'cf_log' then select unit_id into v_unit from public.cf_log where id = p_id;
  else return jsonb_build_object('error','bad_request'); end if;
  if v_unit is null then return jsonb_build_object('ok', true); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if p_table = 'cf_items' then update public.cf_items set deleted_at = now(), deleted_by = v_name where id = p_id;
  elsif p_table = 'cf_log' then update public.cf_log set deleted_at = now(), deleted_by = v_name where id = p_id;
  elsif p_table = 'cf_plan' then delete from public.cf_plan where id = p_id;
  else delete from public.cf_bank where id = p_id; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.wbg_cf_restore(p_auth jsonb, p_table text, p_id text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text;
begin
  if p_table = 'cf_items' then select unit_id into v_unit from public.cf_items where id = p_id;
  elsif p_table = 'cf_log' then select unit_id into v_unit from public.cf_log where id = p_id;
  else return jsonb_build_object('error','bad_request'); end if;
  if v_unit is null then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if p_table = 'cf_items' then update public.cf_items set deleted_at = null, deleted_by = '' where id = p_id;
  else update public.cf_log set deleted_at = null, deleted_by = '' where id = p_id; end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.wbg_cf_delete(jsonb,text,text), public.wbg_cf_restore(jsonb,text,text) from public, anon;
grant execute on function public.wbg_cf_delete(jsonb,text,text), public.wbg_cf_restore(jsonb,text,text) to authenticated;

-- ======== from upgrade-27-cashflow-weekly.sql ========
-- Cash flow, round 3: the weekly plan.
-- A planned line (cf_items) keeps its code for life. Each week it is planned again in cf_week_lines (week = the Saturday the week starts),
-- so you can see when it was planned, how much for that week, and trace it week by week. Unpaid lines roll into the next week.
-- Also: a section on each line (operating / investing / financing) and a flag for unplanned cash.
-- Run in the Supabase SQL editor after upgrade-24. Safe to run more than once. Schema only, no company data.

alter table public.cf_items add column if not exists section text not null default 'operating';
alter table public.cf_items add column if not exists unplanned boolean not null default false;
alter table public.cf_items add column if not exists first_week date;

create table if not exists public.cf_week_lines (
  id text primary key, unit_id text not null, week date not null,
  item_id text not null, item_code text not null default '', kind text not null check (kind in ('in','out')),
  planned numeric not null default 0, due date, rolled boolean not null default false, note text not null default '',
  created_by text not null default '', created_at timestamptz not null default now(), updated_by text not null default '', updated_at timestamptz not null default now(),
  unique (unit_id, week, item_id)
);
create index if not exists cf_week_lines_idx on public.cf_week_lines(unit_id, week);
alter table public.cf_week_lines enable row level security;
drop policy if exists "read" on public.cf_week_lines;
create policy "read" on public.cf_week_lines for select to authenticated using (public.wbg_cf_read(unit_id));
revoke all on public.cf_week_lines from anon, authenticated;
grant select on public.cf_week_lines to authenticated;

create or replace function public.wbg_cf_save_item(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_id text := nullif(p_row->>'id',''); v_unit text := coalesce(p_row->>'unit','');
  v_name text := trim(coalesce(p_auth->>'name','')); v_kind text := p_row->>'kind'; v_status text := coalesce(nullif(p_row->>'status',''),'open');
  v_bucket int := coalesce(nullif(p_row->>'bucket','')::int, 1); v_total numeric := nullif(p_row->>'total','')::numeric; v_old public.cf_items%rowtype;
  v_section text := coalesce(nullif(p_row->>'section',''),'operating'); v_unpl boolean := coalesce((p_row->>'unplanned')::boolean, false); v_code text;
begin
  if v_unit = '' or v_kind not in ('in','out') or v_bucket not in (1,2,3) or v_status not in ('open','settled','written_off') or v_section not in ('operating','investing','financing','intercompany','other') then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if v_id is not null then select * into v_old from public.cf_items where id = v_id; end if;
  if v_old.id is not null and not public.wbg_cf_write(v_old.unit_id) then return jsonb_build_object('error','not_allowed'); end if;
  if v_old.id is null then
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    v_code := case when v_unpl then 'UP-' || lpad(nextval('public.cf_item_seq')::text, 5, '0') else 'CF-' || lpad(nextval('public.cf_item_seq')::text, 5, '0') end;
    insert into public.cf_items (id, code, unit_id, kind, party, description, ref, type_code, bucket, amount, total_amount, currency, priority, expected, status, settled_on, note, entered_on, section, unplanned, first_week, created_by, updated_by)
    values (v_id, v_code, v_unit, v_kind, coalesce(p_row->>'party',''), coalesce(p_row->>'description',''), coalesce(p_row->>'ref',''), coalesce(p_row->>'typeCode',''), v_bucket,
      coalesce(nullif(p_row->>'amount','')::numeric, 0), v_total, coalesce(nullif(p_row->>'currency',''),'ETB'), coalesce(nullif(p_row->>'priority',''),'Normal'), nullif(p_row->>'expected','')::date,
      v_status, nullif(p_row->>'settledOn','')::date, coalesce(p_row->>'note',''), coalesce(nullif(p_row->>'enteredOn','')::date, current_date), v_section, v_unpl, nullif(p_row->>'firstWeek','')::date, v_name, v_name);
  else
    update public.cf_items set unit_id = v_unit, kind = v_kind, party = coalesce(p_row->>'party',''), description = coalesce(p_row->>'description',''), ref = coalesce(p_row->>'ref',''),
      type_code = coalesce(p_row->>'typeCode',''), bucket = v_bucket, amount = coalesce(nullif(p_row->>'amount','')::numeric, 0), total_amount = v_total, currency = coalesce(nullif(p_row->>'currency',''),'ETB'),
      priority = coalesce(nullif(p_row->>'priority',''),'Normal'), expected = nullif(p_row->>'expected','')::date, status = v_status, settled_on = nullif(p_row->>'settledOn','')::date,
      note = coalesce(p_row->>'note',''), section = case when p_row ? 'section' then v_section else section end, first_week = coalesce(first_week, nullif(p_row->>'firstWeek','')::date),
      updated_by = v_name, updated_at = now() where id = v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'code', coalesce(v_code, v_old.code));
end $$;

-- One week of one line. planned = what is expected to be collected or paid in that week.
create or replace function public.wbg_cf_save_week(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text := coalesce(p_row->>'unit',''); v_name text := trim(coalesce(p_auth->>'name',''));
  v_week date := nullif(p_row->>'week','')::date; v_item public.cf_items%rowtype; v_id text;
begin
  if v_unit = '' or v_week is null or extract(dow from v_week) <> 6 then return jsonb_build_object('error','bad_request'); end if;   -- weeks start on a Saturday
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  select * into v_item from public.cf_items where id = p_row->>'itemId' and unit_id = v_unit;
  if v_item.id is null then return jsonb_build_object('error','bad_request'); end if;
  insert into public.cf_week_lines (id, unit_id, week, item_id, item_code, kind, planned, due, rolled, note, created_by, updated_by)
  values (md5(v_unit || '|' || v_week::text || '|' || v_item.id), v_unit, v_week, v_item.id, v_item.code, v_item.kind, coalesce(nullif(p_row->>'planned','')::numeric, 0),
    nullif(p_row->>'due','')::date, coalesce((p_row->>'rolled')::boolean, false), coalesce(p_row->>'note',''), v_name, v_name)
  on conflict (unit_id, week, item_id) do update set planned = excluded.planned, due = excluded.due, rolled = excluded.rolled, note = excluded.note, updated_by = excluded.updated_by, updated_at = now()
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.wbg_cf_delete(p_auth jsonb, p_table text, p_id text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text; v_name text := trim(coalesce(p_auth->>'name',''));
begin
  if p_table = 'cf_items' then select unit_id into v_unit from public.cf_items where id = p_id;
  elsif p_table = 'cf_plan' then select unit_id into v_unit from public.cf_plan where id = p_id;
  elsif p_table = 'cf_bank' then select unit_id into v_unit from public.cf_bank where id = p_id;
  elsif p_table = 'cf_log' then select unit_id into v_unit from public.cf_log where id = p_id;
  elsif p_table = 'cf_week_lines' then select unit_id into v_unit from public.cf_week_lines where id = p_id;
  else return jsonb_build_object('error','bad_request'); end if;
  if v_unit is null then return jsonb_build_object('ok', true); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if p_table = 'cf_items' then update public.cf_items set deleted_at = now(), deleted_by = v_name where id = p_id;
  elsif p_table = 'cf_log' then update public.cf_log set deleted_at = now(), deleted_by = v_name where id = p_id;
  elsif p_table = 'cf_plan' then delete from public.cf_plan where id = p_id;
  elsif p_table = 'cf_week_lines' then delete from public.cf_week_lines where id = p_id;
  else delete from public.cf_bank where id = p_id; end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.wbg_cf_save_item(jsonb,jsonb), public.wbg_cf_save_week(jsonb,jsonb), public.wbg_cf_delete(jsonb,text,text) from public, anon;
grant execute on function public.wbg_cf_save_item(jsonb,jsonb), public.wbg_cf_save_week(jsonb,jsonb), public.wbg_cf_delete(jsonb,text,text) to authenticated;

-- ======== from upgrade-28-cashflow-statement.sql ========
-- Cash flow, round 4: the weekly plan as the cash flow statement.
-- A week line can now stand on its own (history imported from the old weekly workbooks has no line code yet), keeps the statement row it belongs to,
-- the exchange rate used for USD lines, and the actual that was reported at the time.
-- A movement (cf_log) keeps the exchange rate of the day, so a changing rate never changes earlier values.
-- Run in the Supabase SQL editor after upgrade-27. Safe to run more than once. Schema only, no company data.

alter table public.cf_week_lines alter column item_id drop not null;
alter table public.cf_week_lines add column if not exists stmt text not null default '';          -- row of the cash flow statement, e.g. 'Credit collection'
alter table public.cf_week_lines add column if not exists section text not null default 'operating';
alter table public.cf_week_lines add column if not exists party text not null default '';
alter table public.cf_week_lines add column if not exists description text not null default '';
alter table public.cf_week_lines add column if not exists ref text not null default '';
alter table public.cf_week_lines add column if not exists currency text not null default 'ETB';
alter table public.cf_week_lines add column if not exists rate numeric;                            -- ETB per USD for this line in this week
alter table public.cf_week_lines add column if not exists actual numeric;                          -- actual reported at the time (history only; new weeks are worked out from the daily cash)
alter table public.cf_week_lines add column if not exists remark text not null default '';
alter table public.cf_week_lines add column if not exists source text not null default '';         -- where a history line came from
alter table public.cf_log add column if not exists fx_rate numeric;

create or replace function public.wbg_cf_save_week(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text := coalesce(p_row->>'unit',''); v_name text := trim(coalesce(p_auth->>'name',''));
  v_week date := nullif(p_row->>'week','')::date; v_item public.cf_items%rowtype; v_id text := nullif(p_row->>'id',''); v_iid text := nullif(p_row->>'itemId','');
  v_kind text := p_row->>'kind'; v_old public.cf_week_lines%rowtype;
begin
  if v_unit = '' or v_week is null or extract(dow from v_week) <> 6 then return jsonb_build_object('error','bad_request'); end if;   -- weeks start on a Saturday
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if v_iid is not null then
    select * into v_item from public.cf_items where id = v_iid and unit_id = v_unit;
    if v_item.id is null then return jsonb_build_object('error','bad_request'); end if;
    v_kind := v_item.kind; v_id := md5(v_unit || '|' || v_week::text || '|' || v_item.id);
  else
    if v_kind not in ('in','out') then return jsonb_build_object('error','bad_request'); end if;
    if v_id is null then v_id := md5(random()::text || clock_timestamp()::text); end if;
    select * into v_old from public.cf_week_lines where id = v_id;
    if v_old.id is not null and not public.wbg_cf_write(v_old.unit_id) then return jsonb_build_object('error','not_allowed'); end if;
  end if;
  insert into public.cf_week_lines (id, unit_id, week, item_id, item_code, kind, planned, due, rolled, note, stmt, section, party, description, ref, currency, rate, remark, actual, created_by, updated_by)
  values (v_id, v_unit, v_week, v_iid, coalesce(v_item.code, ''), v_kind, coalesce(nullif(p_row->>'planned','')::numeric, 0), nullif(p_row->>'due','')::date,
    coalesce((p_row->>'rolled')::boolean, false), coalesce(p_row->>'note',''), coalesce(p_row->>'stmt',''), coalesce(nullif(p_row->>'section',''), v_item.section, 'operating'),
    coalesce(nullif(p_row->>'party',''), v_item.party, ''), coalesce(nullif(p_row->>'description',''), v_item.description, ''), coalesce(nullif(p_row->>'ref',''), v_item.ref, ''),
    coalesce(nullif(p_row->>'currency',''), v_item.currency, 'ETB'), nullif(p_row->>'rate','')::numeric, coalesce(p_row->>'remark',''), nullif(p_row->>'actual','')::numeric, v_name, v_name)
  on conflict (id) do update set planned = excluded.planned, due = excluded.due, rolled = excluded.rolled, note = excluded.note, stmt = excluded.stmt, section = excluded.section,
    party = excluded.party, description = excluded.description, ref = excluded.ref, currency = excluded.currency, rate = excluded.rate, remark = excluded.remark, actual = coalesce(excluded.actual, public.cf_week_lines.actual), updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.wbg_cf_save_log(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_id text := nullif(p_row->>'id',''); v_unit text := coalesce(p_row->>'unit',''); v_name text := trim(coalesce(p_auth->>'name',''));
  v_kind text := p_row->>'kind'; v_day date := nullif(p_row->>'day','')::date; v_old public.cf_log%rowtype; v_item text := nullif(p_row->>'itemId','');
  v_code text := coalesce(p_row->>'itemCode',''); v_rate numeric := nullif(p_row->>'fxRate','')::numeric;
begin
  if v_unit = '' or v_day is null or v_kind not in ('in','out') then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if v_id is not null then select * into v_old from public.cf_log where id = v_id; end if;
  if v_old.id is not null and not public.wbg_cf_write(v_old.unit_id) then return jsonb_build_object('error','not_allowed'); end if;
  if v_item is not null then select code into v_code from public.cf_items where id = v_item and unit_id = v_unit; if v_code is null then return jsonb_build_object('error','bad_request'); end if; end if;
  if v_old.id is null then
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    insert into public.cf_log (id, unit_id, day, kind, bank, amount, currency, party, description, type_code, item_id, item_code, note, fx_rate, created_by, updated_by)
    values (v_id, v_unit, v_day, v_kind, coalesce(p_row->>'bank',''), coalesce(nullif(p_row->>'amount','')::numeric,0), coalesce(nullif(p_row->>'currency',''),'ETB'), coalesce(p_row->>'party',''),
      coalesce(p_row->>'description',''), coalesce(p_row->>'typeCode',''), v_item, v_code, coalesce(p_row->>'note',''), v_rate, v_name, v_name);
  else
    update public.cf_log set day = v_day, kind = v_kind, bank = coalesce(p_row->>'bank',''), amount = coalesce(nullif(p_row->>'amount','')::numeric,0), currency = coalesce(nullif(p_row->>'currency',''),'ETB'),
      party = coalesce(p_row->>'party',''), description = coalesce(p_row->>'description',''), type_code = coalesce(p_row->>'typeCode',''), item_id = v_item, item_code = v_code,
      note = coalesce(p_row->>'note',''), fx_rate = v_rate, updated_by = v_name, updated_at = now() where id = v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

revoke all on function public.wbg_cf_save_week(jsonb,jsonb), public.wbg_cf_save_log(jsonb,jsonb) from public, anon;
grant execute on function public.wbg_cf_save_week(jsonb,jsonb), public.wbg_cf_save_log(jsonb,jsonb) to authenticated;

-- ======== from upgrade-33-cashflow-weeks-monday.sql ========
-- Cash flow weeks now run Monday to Saturday (they used to start on a Saturday).
-- Move every stored week start from its Saturday to the Monday two days later. Safe to run once.
-- Keep a copy first: the lines of each week keep their amounts, only the week they belong to moves.
update public.cf_week_lines set week = week + 2 where extract(dow from week) = 6;
update public.cf_items set first_week = first_week + 2 where first_week is not null and extract(dow from first_week) = 6;

-- ======== from upgrade-34-cashflow-week-save-monday.sql ========
-- Cash flow weeks start on a Monday now (they used to start on a Saturday). The weekly save function accepted only Saturdays; accept Mondays.
create or replace function public.wbg_cf_save_week(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text := coalesce(p_row->>'unit',''); v_name text := trim(coalesce(p_auth->>'name',''));
  v_week date := nullif(p_row->>'week','')::date; v_item public.cf_items%rowtype; v_id text := nullif(p_row->>'id',''); v_iid text := nullif(p_row->>'itemId','');
  v_kind text := p_row->>'kind'; v_old public.cf_week_lines%rowtype;
begin
  if v_unit = '' or v_week is null or extract(dow from v_week) <> 1 then return jsonb_build_object('error','bad_request'); end if;   -- weeks start on a Monday
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if v_iid is not null then
    select * into v_item from public.cf_items where id = v_iid and unit_id = v_unit;
    if v_item.id is null then return jsonb_build_object('error','bad_request'); end if;
    v_kind := v_item.kind; v_id := md5(v_unit || '|' || v_week::text || '|' || v_item.id);
  else
    if v_kind not in ('in','out') then return jsonb_build_object('error','bad_request'); end if;
    if v_id is null then v_id := md5(random()::text || clock_timestamp()::text); end if;
    select * into v_old from public.cf_week_lines where id = v_id;
    if v_old.id is not null and not public.wbg_cf_write(v_old.unit_id) then return jsonb_build_object('error','not_allowed'); end if;
  end if;
  insert into public.cf_week_lines (id, unit_id, week, item_id, item_code, kind, planned, due, rolled, note, stmt, section, party, description, ref, currency, rate, remark, actual, created_by, updated_by)
  values (v_id, v_unit, v_week, v_iid, coalesce(v_item.code, ''), v_kind, coalesce(nullif(p_row->>'planned','')::numeric, 0), nullif(p_row->>'due','')::date,
    coalesce((p_row->>'rolled')::boolean, false), coalesce(p_row->>'note',''), coalesce(p_row->>'stmt',''), coalesce(nullif(p_row->>'section',''), v_item.section, 'operating'),
    coalesce(nullif(p_row->>'party',''), v_item.party, ''), coalesce(nullif(p_row->>'description',''), v_item.description, ''), coalesce(nullif(p_row->>'ref',''), v_item.ref, ''),
    coalesce(nullif(p_row->>'currency',''), v_item.currency, 'ETB'), nullif(p_row->>'rate','')::numeric, coalesce(p_row->>'remark',''), nullif(p_row->>'actual','')::numeric, v_name, v_name)
  on conflict (id) do update set planned = excluded.planned, due = excluded.due, rolled = excluded.rolled, note = excluded.note, stmt = excluded.stmt, section = excluded.section,
    party = excluded.party, description = excluded.description, ref = excluded.ref, currency = excluded.currency, rate = excluded.rate, remark = excluded.remark, actual = coalesce(excluded.actual, public.cf_week_lines.actual), updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
revoke all on function public.wbg_cf_save_week(jsonb,jsonb) from public, anon;
grant execute on function public.wbg_cf_save_week(jsonb,jsonb) to authenticated;
