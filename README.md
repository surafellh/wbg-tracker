# WBG Weekly Activity Tracking

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
VITE_ADMIN_CODE=            # optional, see "Who is using it"
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

## Who is using it (simple mode)
There is no login yet. The first time someone opens the app they type their name. It is kept in their browser and saved on every change they make (the task's "Updated by", the plan's last editor, and the Activity tab). Anyone can type any name, so treat it as a convenience, not proof of identity. Click the name button at the top to change it.

The **Units** tab (add, rename, remove units) is shown to everyone if `VITE_ADMIN_CODE` is empty. If you set a code, only people who enter it in the name dialog see the tab. Because the code ships inside the page, this hides the tab but does not protect the data.

## Security
`schema.sql` starts with an open policy: anyone with the site address and anon key can read, change and delete all data. That is acceptable for a trial, not for company data you rely on. The bottom of `schema.sql` explains how to move to Supabase Auth (magic-link sign-in, admin-only unit editing, append-only activity log, per-unit access).

## How saving works
Plans are edited on screen and saved with **Save plan** (or **Save all changes**), as in the original. Each save is one write per plan and adds an Activity entry. Unit, department and owner changes, and imports, save immediately. If someone else saves the same plan while you are editing, the page warns you before you overwrite it. Changes made by others appear live (Supabase Realtime) and after every save you make.

## What was replaced
| In the Claude artifact | Here |
|---|---|
| `claude.use("db")` (collections units, plans, activity, live listeners) | `src/data.js` with `@supabase/supabase-js`; tables in `supabase/schema.sql` |
| `claude.use("user")` (signed-in id, display names, owner flag) | Name box + optional admin code (`src/data.js`, `showWho` in `src/main.js`) |
| `claude.use("downloads")` | Normal browser file download |
| jsPDF / SheetJS from a CDN | Installed from npm and bundled |
| Last unit picked (`localStorage`) | Unchanged |

Not replicated: Claude's per-person sign-in and identity (see above), and the owner-only rule for the Units tab as a real permission. The page never used "ask Claude".

## Project layout
```
index.html            page markup
src/main.js           the app (UI code unchanged) + name dialog
src/data.js           Supabase data layer, identity, downloads
src/style.css         styles
supabase/schema.sql   tables, indexes, Row Level Security, realtime
supabase/seed.sql     starting data
.env.example
```
