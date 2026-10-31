-- Cash flow backup: daily snapshot of the seven cf_ tables (kept 35 days), manual snapshots (last 20), and a super-admin restore.
-- Needs pg_cron. Restore: select public.wbg_cf_backup_restore(<id>) as super admin; it saves the current state first.
create table if not exists public.cf_backups (
  id bigint generated always as identity primary key,
  day date not null,
  kind text not null default 'daily' check (kind in ('daily','manual','before-restore')),
  label text not null default '',
  taken_by text not null default '',
  created_at timestamptz not null default now(),
  counts jsonb not null default '{}'::jsonb,
  data jsonb not null
);
create unique index if not exists cf_backups_daily_day on public.cf_backups(day) where kind = 'daily';
alter table public.cf_backups enable row level security;
revoke all on public.cf_backups from anon, authenticated;

create or replace function public.wbg_cf_snapshot(p_kind text, p_label text, p_by text)
returns bigint language plpgsql security definer set search_path to 'public' as $$
declare v_day date := (now() at time zone 'Africa/Addis_Ababa')::date; v_data jsonb; v_counts jsonb; v_id bigint;
begin
  v_data := jsonb_build_object(
    'cf_items', coalesce((select jsonb_agg(to_jsonb(x)) from public.cf_items x), '[]'::jsonb),
    'cf_log', coalesce((select jsonb_agg(to_jsonb(x)) from public.cf_log x), '[]'::jsonb),
    'cf_bank', coalesce((select jsonb_agg(to_jsonb(x)) from public.cf_bank x), '[]'::jsonb),
    'cf_plan', coalesce((select jsonb_agg(to_jsonb(x)) from public.cf_plan x), '[]'::jsonb),
    'cf_week_lines', coalesce((select jsonb_agg(to_jsonb(x)) from public.cf_week_lines x), '[]'::jsonb),
    'cf_types', coalesce((select jsonb_agg(to_jsonb(x)) from public.cf_types x), '[]'::jsonb),
    'cf_settings', coalesce((select jsonb_agg(to_jsonb(x)) from public.cf_settings x), '[]'::jsonb));
  select jsonb_object_agg(k, jsonb_array_length(v_data->k)) into v_counts from jsonb_object_keys(v_data) k;
  if p_kind = 'daily' then
    insert into public.cf_backups(day, kind, label, taken_by, counts, data) values (v_day, 'daily', '', coalesce(p_by,''), v_counts, v_data)
    on conflict (day) where kind = 'daily' do update set data = excluded.data, counts = excluded.counts, created_at = now(), taken_by = excluded.taken_by
    returning id into v_id;
  else
    insert into public.cf_backups(day, kind, label, taken_by, counts, data) values (v_day, p_kind, coalesce(p_label,''), coalesce(p_by,''), v_counts, v_data) returning id into v_id;
  end if;
  delete from public.cf_backups where kind = 'daily' and day < v_day - 35;
  delete from public.cf_backups where kind <> 'daily' and id not in (select id from public.cf_backups where kind <> 'daily' order by created_at desc limit 20);
  return v_id;
end $$;
revoke all on function public.wbg_cf_snapshot(text,text,text) from public, anon, authenticated;

create or replace function public.wbg_cf_daily_backup() returns bigint language sql security definer set search_path to 'public' as $$ select public.wbg_cf_snapshot('daily','','cron') $$;
revoke all on function public.wbg_cf_daily_backup() from public, anon, authenticated;

create or replace function public.wbg_cf_backup_now(p_label text default '') returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id bigint;
begin
  if coalesce(public.wbg_auth()->>'role','') <> 'super_admin' then return jsonb_build_object('error','not_allowed'); end if;
  v_id := public.wbg_cf_snapshot('manual', p_label, coalesce(public.wbg_auth()->>'name',''));
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.wbg_cf_backup_list() returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  if coalesce(public.wbg_auth()->>'role','') <> 'super_admin' then return jsonb_build_object('error','not_allowed'); end if;
  return jsonb_build_object('ok', true, 'backups', coalesce((select jsonb_agg(jsonb_build_object('id',id,'day',day,'kind',kind,'label',label,'by',taken_by,'at',created_at,'counts',counts) order by created_at desc) from public.cf_backups), '[]'::jsonb));
end $$;

create or replace function public.wbg_cf_backup_restore(p_id bigint) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare b public.cf_backups; v_safety bigint;
begin
  if coalesce(public.wbg_auth()->>'role','') <> 'super_admin' then return jsonb_build_object('error','not_allowed'); end if;
  select * into b from public.cf_backups where id = p_id;
  if not found then return jsonb_build_object('error','not_found'); end if;
  v_safety := public.wbg_cf_snapshot('before-restore', 'Taken just before restoring backup ' || p_id, coalesce(public.wbg_auth()->>'name',''));
  delete from public.cf_log; delete from public.cf_week_lines; delete from public.cf_plan; delete from public.cf_bank; delete from public.cf_items; delete from public.cf_types; delete from public.cf_settings;
  insert into public.cf_items select * from jsonb_populate_recordset(null::public.cf_items, b.data->'cf_items');
  insert into public.cf_log select * from jsonb_populate_recordset(null::public.cf_log, b.data->'cf_log');
  insert into public.cf_bank select * from jsonb_populate_recordset(null::public.cf_bank, b.data->'cf_bank');
  insert into public.cf_plan select * from jsonb_populate_recordset(null::public.cf_plan, b.data->'cf_plan');
  insert into public.cf_week_lines select * from jsonb_populate_recordset(null::public.cf_week_lines, b.data->'cf_week_lines');
  insert into public.cf_types select * from jsonb_populate_recordset(null::public.cf_types, b.data->'cf_types');
  insert into public.cf_settings select * from jsonb_populate_recordset(null::public.cf_settings, b.data->'cf_settings');
  return jsonb_build_object('ok', true, 'restored', p_id, 'safety_backup', v_safety, 'counts', b.counts);
end $$;

select cron.schedule('wbg-cf-daily-backup', '15 21 * * *', 'select public.wbg_cf_daily_backup()');
