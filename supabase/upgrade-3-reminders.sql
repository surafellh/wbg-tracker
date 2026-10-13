-- WBG Weekly Activity Tracking · Optional: automatic reminders by Telegram
-- Sends each unit its reminders (missing plan, overdue, due soon, blocked 5+ days, no status, next week's plan
-- missing) and sends Group Strategy a one-message summary. Runs inside Supabase on a schedule: no server needed.
-- Needs upgrade-1-safe.sql first. Safe to re-run.
--
-- SETUP
-- 1. In Telegram, talk to @BotFather, send /newbot, and copy the bot token it gives you.
-- 2. Add the bot to each unit's Telegram group (and to the Group Strategy group). Send any message in the group,
--    then open https://api.telegram.org/bot<TOKEN>/getUpdates in a browser and copy the "chat":{"id": ...} number
--    (group ids start with a minus sign).
-- 3. In Supabase: Database > Extensions, turn on pg_cron and pg_net.
-- 4. Run this file, then fill in step 5 and 6 at the bottom and run those lines.

create table if not exists public.telegram_chats (
  unit_id text primary key,              -- a unit id, or '*' for the Group Strategy summary
  chat_id text not null
);
alter table public.telegram_chats enable row level security;   -- no policy: not readable through the site

-- The reminder text for every unit for the current week (Addis Ababa time). Try it: select * from wbg_reminder_texts();
create or replace function public.wbg_reminder_texts() returns table (unit_id text, unit_name text, level int, message text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_mon date := public.wbg_monday(); v_today date := (now() at time zone 'Africa/Addis_Ababa')::date;
  u record; p record; v_next int; v_lines text[]; v_lvl int; v_txt text; n int;
begin
  for u in select * from public.units order by type, sort_order, name loop
    v_lines := '{}'; v_lvl := 0;
    select * into p from public.plans where id = to_char(v_mon,'YYYY-MM-DD') || '_' || u.id;
    if not found or coalesce(jsonb_array_length(p.tasks), 0) = 0 then
      v_lines := v_lines || 'No plan has been entered for this week.'::text; v_lvl := 2;
    else
      -- overdue
      select count(*), string_agg('  • ' || (x->>'title') || ' (due ' || (x->>'due') || ')', E'\n') into n, v_txt
        from jsonb_array_elements(p.tasks) x
        where coalesce(x->>'kind','Task') <> 'KPI / OKR' and coalesce(x->>'status','') <> 'Done' and coalesce(x->>'due','') <> '' and (x->>'due')::date < v_today;
      if n > 0 then v_lines := v_lines || (n || ' task(s) past the due date:' || E'\n' || v_txt); v_lvl := 2; end if;
      -- due in the next 2 days
      select count(*), string_agg('  • ' || (x->>'title') || ' (due ' || (x->>'due') || ')', E'\n') into n, v_txt
        from jsonb_array_elements(p.tasks) x
        where coalesce(x->>'kind','Task') <> 'KPI / OKR' and coalesce(x->>'status','') <> 'Done' and coalesce(x->>'due','') <> '' and (x->>'due')::date between v_today and v_today + 2;
      if n > 0 then v_lines := v_lines || (n || ' task(s) due in the next 2 days:' || E'\n' || v_txt); v_lvl := greatest(v_lvl, 1); end if;
      -- blocked 5+ days
      select count(*), string_agg('  • ' || (x->>'title') || ' (blocked since ' || (x->>'blockedSince') || ')', E'\n') into n, v_txt
        from jsonb_array_elements(p.tasks) x
        where x->>'status' = 'Blocked' and coalesce(x->>'blockedSince','') <> '' and (x->>'blockedSince')::date <= v_today - 5;
      if n > 0 then v_lines := v_lines || (n || ' task(s) blocked for 5+ days. Please escalate:' || E'\n' || v_txt); v_lvl := 2; end if;
      -- no status
      select count(*) into n from jsonb_array_elements(p.tasks) x where coalesce(x->>'kind','Task') <> 'KPI / OKR' and coalesce(x->>'status','') = '';
      if n > 0 then v_lines := v_lines || (n || ' task(s) have no status.'); v_lvl := greatest(v_lvl, 1); end if;
    end if;
    -- Thursday to Sunday: next week's plan missing
    if extract(isodow from v_today) >= 4 then
      select coalesce(jsonb_array_length(tasks), 0) into v_next from public.plans where id = to_char(v_mon + 7,'YYYY-MM-DD') || '_' || u.id;
      if coalesce(v_next, 0) = 0 then v_lines := v_lines || 'Next week''s plan has not been entered yet.'::text; v_lvl := greatest(v_lvl, 1); end if;
    end if;
    if array_length(v_lines, 1) > 0 then
      unit_id := u.id; unit_name := u.name; level := v_lvl;
      message := 'WBG weekly plan reminder · ' || u.name || ' · week of ' || to_char(v_mon, 'DD Mon YYYY') || E'\n\n' || array_to_string(v_lines, E'\n\n')
                 || E'\n\nPlease update the WBG Weekly Activity Tracker. · Group Strategy Office';
      return next;
    end if;
  end loop;
end $$;
revoke all on function public.wbg_reminder_texts() from public, anon, authenticated;

-- Send the reminders. Units with a chat get their own message; '*' gets the summary.
create or replace function public.wbg_send_reminders() returns int
language plpgsql security definer set search_path = public as $$
declare v_token text; r record; v_chat text; v_sent int := 0; v_sum text := '';
begin
  select value into v_token from public.app_secrets where key = 'telegram_bot_token';
  if v_token is null then raise notice 'No telegram_bot_token in app_secrets'; return 0; end if;
  for r in select * from public.wbg_reminder_texts() loop
    select chat_id into v_chat from public.telegram_chats where unit_id = r.unit_id;
    if v_chat is not null then
      perform net.http_post(url := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
        body := jsonb_build_object('chat_id', v_chat, 'text', left(r.message, 4000), 'disable_web_page_preview', true),
        headers := '{"Content-Type":"application/json"}'::jsonb);
      v_sent := v_sent + 1;
    end if;
    v_sum := v_sum || case r.level when 2 then '🔴 ' when 1 then '🟡 ' else '⚪ ' end || r.unit_name || ': '
             || split_part(split_part(r.message, E'\n\n', 2), E'\n', 1) || E'\n';
  end loop;
  select chat_id into v_chat from public.telegram_chats where unit_id = '*';
  if v_chat is not null and v_sum <> '' then
    perform net.http_post(url := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
      body := jsonb_build_object('chat_id', v_chat, 'text', left('WBG weekly plans · follow-up for ' || to_char(public.wbg_monday(), 'DD Mon YYYY') || E'\n\n' || v_sum, 4000)),
      headers := '{"Content-Type":"application/json"}'::jsonb);
    v_sent := v_sent + 1;
  end if;
  return v_sent;
end $$;
revoke all on function public.wbg_send_reminders() from public, anon, authenticated;

-- Weekly safety copy of every plan of the last 4 weeks into row_history (on top of the copy kept on every change).
create or replace function public.wbg_weekly_snapshot() returns int
language sql security definer set search_path = public as $$
  with ins as (
    insert into public.row_history (tbl, row_id, op, old_row, changed_by)
    select 'plans', id, 'SNAPSHOT', to_jsonb(p), 'weekly backup' from public.plans p where week >= public.wbg_monday() - 28
    returning 1)
  select count(*)::int from ins
$$;
revoke all on function public.wbg_weekly_snapshot() from public, anon, authenticated;

-- 5. Your bot token and chats (replace the values, then run these lines):
-- insert into public.app_secrets (key, value) values ('telegram_bot_token', '123456:ABC-your-token') on conflict (key) do update set value = excluded.value;
-- insert into public.telegram_chats (unit_id, chat_id) values ('*', '-1001234567890') on conflict (unit_id) do update set chat_id = excluded.chat_id;   -- Group Strategy summary
-- insert into public.telegram_chats (unit_id, chat_id) values ('hrm', '-1009876543210') on conflict (unit_id) do update set chat_id = excluded.chat_id;  -- one line per unit
-- Test once by hand:  select public.wbg_send_reminders();
--
-- 6. Schedule (times are UTC; 06:00 UTC = 09:00 in Addis Ababa):
-- select cron.schedule('wbg-reminders-wed', '0 6 * * 3', 'select public.wbg_send_reminders()');   -- Wednesday 09:00
-- select cron.schedule('wbg-reminders-fri', '0 6 * * 5', 'select public.wbg_send_reminders()');   -- Friday 09:00, before the review
-- select cron.schedule('wbg-weekly-backup', '0 18 * * 6', 'select public.wbg_weekly_snapshot()'); -- Saturday 21:00
-- To stop one:  select cron.unschedule('wbg-reminders-wed');
