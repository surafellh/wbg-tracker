# WBG Weekly Activity Tracking (v3, stage 1b)

Weekly plans, progress, Ethiopian-calendar monthly reports and an activity log for Wagwago Business Group's functions and business units.
Vite + vanilla JS front end; data is stored in a free Supabase (Postgres) project.

## 1. Create the Supabase project
1. Sign in at https://supabase.com and click **New project** (the free plan is fine). Pick a name, a database password and a region.
2. When it is ready, open **Project Settings > API** and copy the **Project URL** and the **anon public** key.

## 2. Create the tables
1. In Supabase open **SQL Editor > New query**.
2. Paste the whole of `supabase/schema.sql` and press **Run**. (Safe to run again.)
3. Optional but recommended: paste `supabase/seed.sql` and run it. It loads the 12 units, the 14 weekly plans (222 tasks) and the activity log exported from the Claude artifact. Re-running it never overwrites existing rows.

## 3. Set your keys
```bash
cp .env.example .env
```
Edit `.env`:
```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
# leave both empty to run in local test mode
```
`.env` is git-ignored. Never commit it. (The anon key is designed to be public, but see "Security" below.)

## 4. Run locally
```bash
npm install
npm run dev
```
Open the address Vite prints (usually http://localhost:5173). To check a production build: `npm run build && npm run preview`.

## 5. Deploy
Both hosts: connect the Git repository, then set the `VITE_` variables in the host's settings **before** building. Vite bakes them in at build time, so changing them means redeploying.

- **Vercel:** New Project > import the repo. Framework preset: Vite. Build command `npm run build`, output directory `dist`. Add the environment variables, then Deploy.
- **Netlify:** Add new site > import the repo. Build command `npm run build`, publish directory `dist`. Add the environment variables under Site configuration, then Deploy.

## What is new in stage 1b
- **Dark mode** is now neutral black with a richer golden yellow. Light mode is unchanged.
- **One Dashboard.** Overview is merged into the Dashboard: KPIs and trend on top, then the unit table, blockers and asks, and the task list. There is no separate Overview tab.
- **Approvals** moved behind the bell icon at the top right (it shows how many changes are waiting). A later stage replaces it with notifications that open the task.
- **Starting data** (`supabase/seed.sql`, and the local test data) is rebuilt from the 10 Oct 2026 export. Plans saved for Monday 12 Oct are in the week of Sat 10 Oct; Niyat's later plans are in the weeks of 17 Oct, 24 Oct and 31 Oct.

### Loading the new seed into the TEST project
Run in the SQL Editor, in this order: `truncate activity, plans, units;` then the whole of `supabase/seed.sql`. (The truncate removes the old Monday-dated rows so nothing is duplicated; test project only.) Business support, feedback and corrective actions are not touched.

## What is new in version 3 (stage 1)
- **This week's update** columns are now: Task, Type, Department, Due, Priority, Status update, %, Note, Evidence, Owner. Dependencies go in the Note.
- **Average % complete counts every task.** Done = 100, otherwise the % entered; a task with no status or no % counts as 0. A progress bar for the whole week's plan sits at the top, and each unit has its own bar.
- **Click a column title to sort** (Priority sorts High, Medium, Low; empty values go last). Click again for the reverse, a third time to clear.
- **Weeks run Saturday to Friday** from Saturday 10 Oct 2026. Earlier weeks keep their Monday dates. `upgrade-4` moves any plan saved for "Monday 12 Oct" to the week of 10 Oct.
- **Business support** tab: log and follow up requests made to a corporate function (starts with the HR support log). Active requests are shown by default, 15 at a time, with filters for status, function, requester, category, dates and search, and Excel / PDF downloads.
- **Feedback** tab: feedback from the CEO, DCEO or Group Strategy per unit (a unit acknowledges it), and a **corrective action log** (Group Strategy or the unit logs an action; only Group Strategy closes it).
- Stage 2 (not in this version): sign-in with company email, roles and row-level security. Unit PINs and the approver code still apply.

## Upgrading to v3 stage 1 (test project first)
1. **SQL Editor:** run `supabase/upgrade-4-v3-stage1.sql` (after `schema.sql` and `upgrade-1-safe.sql`). Safe to run again.
2. Optional starting data: `supabase/seed.sql` (plans and activity, with the 12 Oct plans already moved to 10 Oct) and `supabase/seed-support.sql` (24 HR support requests).
3. Deploy the new site files (on a branch first). The new tabs show empty lists until step 1 is done.

## Who can change what (v2)
There is still no email sign-in. Instead:

- **Anyone with the link can view.** To change a plan, a person signs in with their **name, their unit, and the unit's PIN**. Group Strategy sets each unit's PIN in the **Units** tab. The PIN is checked by the database on every save, so a made-up name cannot change anything.
- **Group Strategy approvers** are people whose name starts with or contains `Surafel`, `Surafel Hailu`, `Ataklti` or `Ataklti Nega` **and** who enter the approver code. A name alone is not enough, because anyone can type a name. The name list is in the Supabase table `app_config` (key `approver_names`).
- **Saved tasks keep their definition.** Once a week has started, a saved task's title, expected outcome, type, department, due date and priority are fixed (🔒). Units update status, %, notes, owner, dependencies and evidence freely. To change a fixed field they press **Request change**; removing a saved task also becomes a request. Next week's plan stays fully editable until that week starts.
- **Past weeks need approval.** Any change to a week that has ended is sent to the **Approvals** tab and is recorded only when an approver accepts it. Approvers can edit everything directly.
- PINs and the approver code are stored as bcrypt hashes. 20 wrong tries in 15 minutes locks that unit (or approvals) for 15 minutes.

## Backups, history and undo
- **Every change keeps a copy automatically** (database trigger, table `row_history`). Open a plan and press **History** to see every earlier version; approvers can **Restore** any of them (the version being replaced is kept too, so a restore can be undone).
- After a save, the message at the bottom has **Undo** (works for 30 minutes on your own save).
- **Units tab > Download full backup (JSON)**: a complete offline copy of units, plans, activity and requests. Keep one on the shared drive every week. **Restore from a backup file** puts it back.
- Optional: `supabase/upgrade-3-reminders.sql` also schedules a weekly snapshot.

## Evidence files
Optional on every task: **📎 Attach** up to 3 files at once, 5 MB in total (PDF, images, Word, Excel, PowerPoint, text, CSV). Files go to a private Supabase Storage bucket called `evidence` (free plan: 1 GB). They are linked to the task when the plan is saved.

## Automatic reminders
- **In the app:** each unit sees a Reminders panel when it opens its plan (overdue, due in 2 days, blocked 5+ days, carried 2+ weeks, no status, other units waiting on it, not updated for 3 days, next week's plan missing from Thursday). The **Follow-up** tab and the **Dashboard** escalations list show the same checks for every unit.
- **By Telegram (optional):** `supabase/upgrade-3-reminders.sql` sends each unit's reminders to its Telegram group and a summary to Group Strategy on a schedule (for example Wednesday and Friday 09:00). Setup steps are at the top of that file.

## Upgrading the live site to v2 (order matters)
1. **Supabase > SQL Editor:** run `supabase/upgrade-1-safe.sql`. The current live site keeps working; from now on every save is backed up.
2. In the same file, at the bottom, set the **approver code** (edit the text in quotes, select that line, Run).
3. Test the new version on your computer (see "Versions" below), then push it so Vercel deploys it.
4. On the live site: sign in as Ataklti or Surafel with the approver code, open **Units**, and set a PIN for every unit. Send each unit its PIN privately.
5. Only then run `supabase/upgrade-2-lockdown.sql`. After this, the database refuses any change that does not come through the PIN-checked functions (the old site can no longer save).
6. Optional: `supabase/upgrade-3-reminders.sql` for Telegram reminders.

For a brand-new project: run `schema.sql`, `seed.sql`, then the upgrade files in order.

## Versions: test locally first, keep or drop changes
Your code lives in GitHub; Vercel rebuilds the live site from the `main` branch every time you push to it. So nothing reaches the live site until you push.

**Test safely on localhost.** If `.env` holds the live Supabase keys, `npm run dev` on your computer edits the **real** data. To test without risk either:
- rename `.env` to `.env.off` and run `npm run dev`: the page says **Local test mode** and keeps everything in your browser (approver code `approve`), or
- make a second free Supabase project as a test copy, run the SQL files there, and put its keys in `.env`.

**Typical cycle**
```bash
git checkout -b v2-dashboard      # work on a branch, main stays as the live version
# copy the new files in, then:
npm install && npm run dev        # check it on http://localhost:5173
git status                        # see which files changed
git diff                          # see exactly what changed
git add -A && git commit -m "v2: dashboard, PINs, approvals, evidence, backups"
git push -u origin v2-dashboard   # Vercel builds a Preview link for the branch, live site untouched
```
When the preview is right, merge the branch into `main` on GitHub (Pull request > Merge). That deploys it live. Mark releases so you can find them: `git tag v2.0 && git push --tags`.

**Dropping changes**
- Not committed yet, throw away everything: `git restore .` (and `git clean -fd` for new files).
- One file only: `git restore src/main.js`.
- Committed on a branch you no longer want: `git checkout main && git branch -D v2-dashboard`.
- Already live and something is wrong: in Vercel > Deployments, open the previous good deployment and choose **Promote to Production** (instant rollback). Then fix the code, or undo the commit with `git revert <commit>` and push.

Code rollbacks do not touch the data: plans live in Supabase. For data, use History / Restore or a backup file.

## What was replaced
| In the Claude artifact | Here |
|---|---|
| `claude.use("db")` (collections units, plans, activity, live listeners) | `src/data.js` with `@supabase/supabase-js`; tables in `supabase/schema.sql` |
| `claude.use("user")` (signed-in id, display names, owner flag) | Name box + optional admin code (`src/data.js`, `showWho` in `src/main.js`) |
| `claude.use("downloads")` | Normal browser file download |
| jsPDF / SheetJS from a CDN | Installed from npm and bundled |
| Last unit picked (`localStorage`) | Unchanged |

Per-person sign-in is replaced by unit PINs and an approver code (see "Who can change what").

## Project layout
```
index.html            page markup
src/main.js           the app
src/data.js           Supabase data layer (reads, PIN-checked writes, evidence storage) and local test mode
src/rules.js          what a unit may change directly vs. what needs approval (same rules as the database)
src/alerts.js         automatic reminders and blocker checks
src/dashboard.js      executive dashboard charts
src/style.css         styles
supabase/schema.sql   tables, indexes, Row Level Security, realtime
supabase/seed.sql     starting data
supabase/upgrade-1-safe.sql      v2 tables and functions (safe with the old site)
supabase/upgrade-2-lockdown.sql  v2 lockdown (run after the new site is live)
supabase/upgrade-3-reminders.sql optional Telegram reminders and weekly snapshot
supabase/upgrade-4-v3-stage1.sql v3: Saturday weeks, Business support, Feedback, Corrective actions
supabase/upgrade-5-stage2-login.sql company-email sign-in, roles, row level security
supabase/upgrade-6-daily-backup.sql nightly backup
supabase/upgrade-7-passwords.sql   password reset for Group Strategy
supabase/seed.sql, seed-support.sql starting data
.env.example
```

## Stage 2: company-email sign-in, roles, audit, data quality

**What changes.** Unit PINs and the approver code are gone. People sign in with email and password. The first time (or after a forgotten password) they get a one-time code by email and then choose a password. "Stay signed in on this device" keeps the sign-in after the browser closes. Roles are managed in the new **People** tab (Group Strategy only).

| Role | Sees | Changes |
|---|---|---|
| Group Strategy (super admin) | everything | everything, People, Units, restore |
| CEO / DCEO (executive) | everything | feedback only |
| Chief / director / GM (leader) | everything | their own unit's plan; undo/restore for their unit |
| Planning | their own unit | their own unit's plan, departments; undo/restore |
| Manager | their own unit | their own departments; undo/restore for those |
| Employee (staff) | own department tasks only | own department tasks; no undo |

Allowed email domains (editable in People): wagwagoelectric.com, geezinstitute.com, wanzalogistics.com, niyatconsultnacy.com, niyatconsultancy.com, trucksload.net. **Check the Niyat spelling and delete the wrong one.** Anyone on an allowed domain may sign themselves up as Staff in the unit they choose; others need an invite or an approved access request.

**Also new**
- Daily database backup at 00:00 Addis time (upgrade-6; People tab lists the days and downloads one).
- Excel template with dropdowns (unit, department per unit, type, category, priority, status), number and date checks; import review shows "Did you mean…" for wrong unit or department names. Departments are never created by import.
- Category (Operational / Revenue) per task, filter on All tasks and Dashboard, split on the Dashboard.
- Target, unit and Actual per task: % complete is calculated; "lower is better" for costs and delays.

**Upgrade steps (test project first)**
1. Supabase: Authentication > Providers > Email on. Authentication > Email Templates > Magic Link: put `{{ .Token }}` in the body so the email shows the code.
2. Authentication > SMTP: set up your own mail sender (the built-in one allows only a few emails an hour).
3. SQL Editor: run `upgrade-5-stage2-login.sql`, then `upgrade-6-daily-backup.sql` (enable the pg_cron extension first: Database > Extensions).
4. Push to a new branch, let Vercel build a preview, sign in as surafel.h@wagwagoelectric.com (first Group Strategy admin).
5. **After upgrade-5 the old site can no longer save.** Do this on the test project only until you are ready to go live.

Test mode (no Supabase keys): the sign-in page offers a list of test people, including a first-time newcomer.

**Passwords (upgrade-7)**
- Run `supabase/upgrade-7-passwords.sql` after upgrade-5 (adds "Reset password" for Group Strategy in the People tab).
- Supabase: Authentication > Sign In / Providers > Email > set Minimum password length to 10.
- The Confirm sign up and Magic Link email templates must both contain `{{ .Token }}` (new people get the first, returning people the second).

## Stage 3a: deliverables, reference numbers, task panel, evidence preview
**Database step (once, in the Supabase SQL Editor, BEFORE using the new site):** run `supabase/upgrade-8-task-refs.sql`. It gives every existing task a stable reference (for example `WE-0001`; the same task keeps the same reference across weeks) and adds a safe counter so new tasks are numbered without clashes. It is safe to run twice.

What is new
- **Reference numbers** on every task (chip in the table, searchable in All tasks).
- **Deliverables:** a task can be placed under another task ("Part of deliverable" in the task panel, or "Add a task under this"). The deliverable's progress is the weighted average of its tasks (weight 1 by default, change it in the panel). One level only. Existing tasks each stay a deliverable on their own, so nothing changes until you group them.
- **Count level:** Dashboard and All tasks have a "Deliverables / All tasks" switch. Group Strategy and executives start on Deliverables, everyone else on All tasks.
- **Task panel:** click `Open` on a row (or the reference chip in All tasks). All fields, tasks under it, evidence, Save plan. In All tasks it is read-only, with a button to edit it in this week's update.
- **Evidence preview:** View opens PDF and images directly, Excel as tables, Word as formatted text, PowerPoint as slide text only (.docx, .xlsx, .pptx), text and CSV as text. Download is always there.
- **Due colours:** overdue in red, due within 3 days in amber.
- Not in 3a (coming in 3b): discussion and @mentions, bell opening the task, feedback inside the panel, completed-by-week chart, print.

## Stage 3b: discussion, mentions, bell, task feedback, completed-by-week, print
**Database step (once, BEFORE using the new site):** run `supabase/upgrade-9-task-discussion.sql` in the Supabase SQL Editor (test project first). It adds comments and mention notifications (reached only through checked functions), a task reference on feedback and corrective actions, and updates the two save functions. Safe to run twice.

- **Discussion** in the task panel. Anyone who can work with the unit (unit members, leaders, the CEO/DCEO, Group Strategy) can read and write. Type `@` to mention a person of that unit or an executive; they get a notification.
- **Bell:** shows mentions and approvals waiting. A mention opens the task with its discussion.
- **Feedback and corrective actions inside the task panel:** give feedback on the task (CEO, DCEO, Group Strategy), log a corrective action, acknowledge feedback, open an action. The Feedback tab still gives the overview of all of them, with the task reference shown.
- **Dashboard:** new "Completed by week" chart (tasks counted by completion date, Saturday to Friday).
- **Print:** Print button in All tasks and in the task panel (landscape, buttons hidden).
