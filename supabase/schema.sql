-- WBG Weekly Activity Tracking: database schema for Supabase (Postgres).
-- Run this once in Supabase: SQL Editor > New query > paste > Run. Safe to re-run.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Functions and business units that report weekly.
create table if not exists public.units (
  id          text primary key,                    -- slug, e.g. 'wagwago-electric'
  name        text not null,
  type        text not null default 'Business unit',  -- 'Corporate function' | 'Business unit'
  sort_order  int  not null default 99,
  departments jsonb not null default '[]'::jsonb,  -- ["FFD", "Recruitment", ...]
  people      jsonb not null default '[]'::jsonb,  -- owner names offered in the task owner box
  created_at  timestamptz not null default now()
);

-- One row per unit per week. id = '<week Monday>_<unit id>', e.g. '2026-10-05_hrm'.
-- Tasks live in one jsonb array so a plan is read, diffed, merged and saved as a whole, exactly like the app does.
-- task = { id, title, dept, owner, due, priority, status, pct, notes, kind, lu, lb, carried }
create table if not exists public.plans (
  id          text primary key,
  week        date not null,                       -- Monday of the week
  unit_id     text not null,                       -- no foreign key on purpose: removing a unit keeps its past plans
  tasks       jsonb not null default '[]'::jsonb,
  wins        text not null default '',            -- key results
  blockers    text not null default '',
  asks        text not null default '',
  updated_at  timestamptz,
  updated_by  text,                                -- name of the person who saved
  source      text not null default '',            -- e.g. 'Import: file.xlsx'
  created_at  timestamptz not null default now(),
  unique (week, unit_id)
);
create index if not exists plans_week_idx      on public.plans (week);
create index if not exists plans_unit_week_idx on public.plans (unit_id, week);

-- Audit trail: who changed what, and when.
create table if not exists public.activity (
  id         text primary key,
  ts         timestamptz not null default now(),
  by_name    text not null default '',
  unit_id    text not null default '',
  week       date,
  action     text not null default '',             -- save | import | lists | data-load
  summary    text not null default '',
  details    jsonb not null default '[]'::jsonb
);
create index if not exists activity_ts_idx   on public.activity (ts desc);
create index if not exists activity_unit_idx on public.activity (unit_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.units    enable row level security;
alter table public.plans    enable row level security;
alter table public.activity enable row level security;

-- STARTER POLICY: anyone holding the site URL + anon key can read, add, edit and delete everything.
-- Fine for a trial; tighten before sharing widely (see below).
drop policy if exists "open access" on public.units;
drop policy if exists "open access" on public.plans;
drop policy if exists "open access" on public.activity;
create policy "open access" on public.units    for all to anon, authenticated using (true) with check (true);
create policy "open access" on public.plans    for all to anon, authenticated using (true) with check (true);
create policy "open access" on public.activity for all to anon, authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Realtime (live updates between people on the same week)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['units','plans','activity'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;   -- already added
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- HOW TO TIGHTEN LATER (with Supabase Auth)
-- 1. Turn on Authentication > Providers > Email (magic link) and make the app sign people in.
-- 2. Add a role flag for Strategy Office admins, e.g. in auth.users raw_app_meta_data: {"role":"admin"}.
-- 3. Replace the open policies with the ones below, then drop the "open access" policies.
-- 4. Make activity append-only for normal users (no update/delete) so the audit trail cannot be rewritten.
--
-- drop policy "open access" on public.units;
-- drop policy "open access" on public.plans;
-- drop policy "open access" on public.activity;
--
-- create policy "units: signed-in read"   on public.units    for select to authenticated using (true);
-- create policy "units: admin write"      on public.units    for all    to authenticated
--   using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
--   with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
--
-- create policy "plans: signed-in read"   on public.plans    for select to authenticated using (true);
-- create policy "plans: signed-in write"  on public.plans    for insert to authenticated with check (true);
-- create policy "plans: signed-in update" on public.plans    for update to authenticated using (true) with check (true);
--
-- create policy "activity: read"          on public.activity for select to authenticated using (true);
-- create policy "activity: append"        on public.activity for insert to authenticated with check (true);
--
-- Per-unit access (a unit's staff can only edit their own unit) needs a mapping table, e.g.
--   create table public.unit_members (user_id uuid references auth.users, unit_id text, primary key (user_id, unit_id));
-- and plans policies that check: exists (select 1 from public.unit_members m where m.user_id = auth.uid() and m.unit_id = plans.unit_id)
