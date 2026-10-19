// Help guides for the in-app assistant. Plain data: edit the text here and redeploy, the help panel updates by itself.
//
// Each guide:  { id, g: group, pages: [tab ids it belongs to], roles?: [roles it is for], title, kw: "extra search words",
//                intro, steps: [...], why: [...], fix: [[problem, answer], ...], go: [[label, tab], ...],
//                pin?: tabs where it is also shown in the main list (otherwise only guides of the page's own group are, the rest are "Related") }
// Text may use **bold**. These words are replaced with live facts when shown (main.js helpFacts() reads them from the app's own code, so they cannot go stale):
//   {grace} {fixed} {rename}  the Saturday cut-off and renaming rule (settings)
//   {cutover} {statuses} {priorities} {columns} {templateRows} {evidence}  facts from the code
//   A step or "why" entry can be {fact: "ratings" | "finals" | "roles"} to insert a generated list.
// Run  npm run check-help  after changing the app or this file: it lists guide wording that no longer matches the app.
// "pages" uses the app's tab ids: dashboard, update, plan, mplan, approvals, support, fb, tasks, monthly, ceo, follow, activity, units, people.
// Keep sentences short and name the buttons exactly as they appear on screen.
export const GUIDES_VERSION = "2026-10-19.4";

export const GROUPS = [
  { id: "start", title: "Getting started", icon: "🚀", blurb: "Signing in, weeks, roles and finding your way around" },
  { id: "plan", title: "Next week's plan", icon: "📝", blurb: "Plan the coming week, use Excel, submit for approval" },
  { id: "upd", title: "Weekly progress update", icon: "✅", blurb: "Update status and progress, attach evidence, the deadline" },
  { id: "mp", title: "Monthly plan", icon: "🗓️", blurb: "Plan a whole month and split it into weeks" },
  { id: "appr", title: "Approvals and changes", icon: "🔏", blurb: "Who approves what, and why some fields are locked" },
  { id: "rep", title: "Reports and dashboards", icon: "📊", blurb: "Dashboard, weekly and monthly reports, downloads" },
  { id: "del", title: "Business support and feedback", icon: "🤝", blurb: "Support requests, feedback and corrective actions" },
  { id: "adm", title: "Group Strategy tools", icon: "⚙️", blurb: "People, units, settings and the activity log" },
  { id: "fix", title: "When something goes wrong", icon: "🛠️", blurb: "Quick fixes for the most common problems" },
];

export const TAB_NAMES = {
  dashboard: "Dashboard", update: "Progress update", plan: "Next plan", mplan: "Monthly plan", approvals: "Approvals",
  support: "Business support", fb: "Feedback", tasks: "Weekly report", monthly: "Monthly report", ceo: "Actions for the CEO",
  activity: "Activity log", units: "Units", people: "People",
};

const ADM = ["super_admin"];
const APPR = ["super_admin", "leader", "planning", "manager"];

export const GUIDES = [
  // =====================================================================================================================
  // GETTING STARTED
  // =====================================================================================================================
  {
    id: "signin", g: "start", pages: ["*"], title: "Signing in for the first time, and forgotten passwords",
    kw: "login log in password code email otp sign up register account access new user forgot reset stay signed in",
    intro: "You sign in with your company email and a password. The very first time you have no password yet, so the app sends a one-time code to your email and then asks you to choose a password.",
    steps: [
      "Open the app and look at the sign-in box.",
      "**First time (or forgot your password):** click **Get a code by email** (or open the **Sign up** tab), type your company email and press **Send code**.",
      "Open your email, copy the 6-digit code and type it into the app.",
      "Choose a password (at least 6 characters). Next time you only need your email and this password.",
      "Leave **Stay signed in on this device** ticked on your own phone or laptop. Untick it on a shared computer.",
    ],
    why: [
      "Only emails from approved company domains (or people Group Strategy has invited) can sign up. Everyone starts as an Employee in the unit they choose, then asks for a higher role if they need one (see 'Asking for a different role').",
      "A new password cannot be one you used before.",
    ],
    fix: [
      ["The code never arrives", "Wait one minute, then check Junk/Spam. Some company mail systems hold unknown senders back. If it still does not come, tell Group Strategy: they can set up your access another way."],
      ["'That email or password is not right'", "Check the email spelling. If you never set a password, use **Get a code by email** instead of typing a password."],
      ["'Too many tries'", "Wait a few minutes and try again. The app pauses sign-in after several wrong attempts to protect your account."],
      ["My company is not accepted", "Click **Request access** on the sign-in screen. Group Strategy sees the request and can approve it."],
    ],
    
  },
  {
    id: "weeks", g: "start", pages: ["*"], title: "How weeks work (Saturday to Friday) and the Saturday cut-off",
    kw: "week saturday friday monday cutoff cut-off deadline calendar ethiopian this week next week arrows today",
    intro: "Every week runs from **Saturday to Friday**. A week is named after its Saturday. Weeks before {cutover} are older Monday-to-Friday weeks and keep their old dates.",
    steps: [
      "Use the **‹ ›** arrows at the top, or click the week name to pick a date from a calendar.",
      "Press **This week** to jump back to the current week at any time.",
      "Dates are shown in the Gregorian calendar with the Ethiopian date underneath.",
    ],
    why: [
      "Most updating and planning happens on Saturday, so to avoid confusion the app does not switch weeks at midnight. Until **{grace}** (Addis Ababa time) the week that just ended still counts as 'this week' for updates, and **Next plan** still opens the week that has just started.",
      "After {grace} the week that ended becomes **closed**: changes to it need approval, the weekly report shows final status labels, and **Next plan** moves to the following week.",
      "Group Strategy can change the cut-off time, or keep last week open for longer on a special occasion (People page, 'Update deadline and renaming').",
    ],
    fix: [
      ["Next plan opened the wrong week", "Look for the pill at the top of the page. If it says NOT NEXT WEEK, click **Go to next week**."],
      ["I am past the cut-off and still need to update last week", "Use **Request update** to send the change for approval, or ask Group Strategy to keep last week open."],
    ],
    go: [["Next plan", "plan"], ["Progress update", "update"]],
  },
  {
    id: "map", g: "start", pages: ["*"], title: "Finding your way around: what each menu and button is for",
    kw: "navigate menu tabs top bar search bell avatar where is find page home dashboard plans delivery reports",
    intro: "The top bar has four groups. Click a group and its pages appear underneath.",
    steps: [
      "**Dashboards:** how every unit is doing this week, with charts.",
      "**Plans:** **Progress update** (this week's actuals), **Next plan** (the coming week), **Monthly plan**, and **Approvals**.",
      "**Delivery:** **Business support** requests and **Feedback** with corrective actions.",
      "**Reports:** **Weekly report** (every task, filtered and downloadable), **Monthly report**, and **Actions for the CEO** (CEO, DCEO and Group Strategy only).",
      "Top right: the **magnifier** searches tasks, the **clock** is the Activity log, the **bell** shows messages and approvals, and your **initials** open your profile and sign-out.",
      "Group Strategy also has **Units** and **People** for settings.",
    ],
    why: ["What you see depends on your role. If a page is missing, your role does not use it. See 'Roles'."],
    go: [["Dashboard", "dashboard"], ["Weekly report", "tasks"]],
  },
  {
    id: "roles", g: "start", pages: ["*"], title: "Roles: who can see and change what",
    kw: "role permission access cannot edit view only employee manager department head chief gm director planning head division head super admin executive ceo dceo why cant i edit",
    intro: "Your role decides what you can see and change. Your role is shown on your profile (click your initials).",
    steps: [
      "**Employee / Division head:** view only. You see your own department and can ask your department head to update progress (a box on the Progress update page).",
      "**Department head (Manager):** sees the whole unit. Updates progress and plans next week for **their own departments** only. Their next-week plan goes to the chief for approval.",
      "**Chief, GM, Director:** sees every unit. Edits everything in their own unit or function and approves the plans of the departments they cover.",
      "**Planning head:** edits everything in their own unit (including deleting), manages its departments, approves plans including their own.",
      "**CEO / DCEO:** sees everything and writes feedback, but cannot change plans.",
      "**Group Strategy (super admin):** sees and changes everything, manages people, units and settings, approves and can undo anything.",
    ],
    why: [
      "Departments matter: a Department head can only change tasks tagged with a department they belong to. A Finance head cannot edit HR tasks, but the unit's chief or planning head can edit both.",
      "If you need a different role, ask for it in your profile (see 'Asking for a different role').",
      "The exact role descriptions used by the app:",
      { fact: "roles" },
    ],
    fix: [
      ["Everything is greyed out", "You are probably view-only (Employee/Division head), or you are looking at a unit that is not yours, or the task belongs to a department you are not in."],
      ["I can open the page but there is no Save button", "Same reason: your role cannot change this unit. Pick your own unit at the top of the page."],
    ],
    
  },
  {
    id: "profile", g: "start", pages: ["*"], title: "Your profile: details, theme, start page, password, role request",
    kw: "profile settings name phone job title theme dark light start page password change sign out all devices role request upgrade approval code",
    intro: "Click your **initials** at the top right to open your profile.",
    steps: [
      "**Your details:** change your name (it appears as 'updated by'), phone and job title, then press **Save details**. Your email is your sign-in and cannot be changed here.",
      "**Appearance and start page:** pick a light, dark or automatic theme and choose which page the app opens on. This is remembered on this device.",
      "**Password and security:** **Change password**, or **Sign out of all devices** if you lost a phone.",
      "**Role and access:** shows your current role, and lets you ask Group Strategy for a different one.",
      "**Sign out** is at the bottom.",
    ],
    why: ["Role, unit and departments only change when Group Strategy approves a request. That keeps plans safe."],
    
  },
  {
    id: "rolereq", g: "start", pages: ["*"], title: "Asking for a different role, unit or department",
    kw: "request role upgrade promotion change unit department approval code access staff to manager",
    intro: "New people start as Employees. To edit plans you need a higher role in your unit.",
    steps: [
      "Click your initials → **Profile and settings**, then scroll to **Role and access**.",
      "Choose the **role**, **unit** and **departments** you need and press the send button.",
      "Group Strategy gets the request on their bell and People page. You are notified of the decision.",
      "**Shortcut:** if Group Strategy is sitting next to you and gives you the approval code, type it in the box on your pending request and press the approve button. Your access updates immediately.",
      "Changed your mind? Use **Withdraw** on the pending request.",
    ],
    why: ["Your access changes on your next action after the approval. If a page still looks the same, refresh the page."],
    
  },
  {
    id: "bell", g: "start", pages: ["*"], title: "The bell: messages, mentions and approvals waiting for you",
    kw: "bell notification message mention alert badge number red approval waiting unread",
    intro: "The bell collects everything that needs your attention.",
    steps: [
      "Click the **bell**. New items have a dot.",
      "**Mentions:** someone wrote your name in a task discussion. Click it to open that task.",
      "**Approvals:** requests waiting for your decision, grouped by unit and department. Click one to open the Approvals page.",
      "**History:** older messages (decisions on your requests, system notes). Use **Mark all as read** to clear the dots.",
    ],
    why: ["The number on the bell counts only things that need you, so a 0 means you are up to date."],
    go: [["Approvals", "approvals"]],
  },
  {
    id: "search", g: "start", pages: ["*"], title: "Searching for a task",
    kw: "search find task magnifier lookup code reference title keyword",
    intro: "The **magnifier** in the top bar finds a task by its title, its task code (reference number) or its owner.",
    steps: [
      "Click the magnifier and type at least 2 letters of the title, the task code or the owner's name.",
      "It searches the tasks of the **week you are viewing**, so first move to the right week with the arrows.",
      "Click a result to open the task details on the right.",
      "On Next plan, Progress update and Weekly report there is also a search box above the table that filters the rows you can see.",
    ],
    fix: [["The task is not found", "Search only covers tasks you are allowed to see, in the week shown at the top. Change the week with the arrows and search again."]],
  },
  {
    id: "unsaved", g: "start", pages: ["plan", "update", "mplan"], title: "Saving, discarding and 'Save or discard your changes first'",
    kw: "save discard unsaved changes lost draft cancel dirty prompt leave page toast message",
    intro: "Nothing you type is stored until you press **Save plan**. Until then it is a draft on your screen only.",
    steps: [
      "After editing, look at the bar at the bottom of the table: it says there are unsaved changes.",
      "Press **Save plan** to keep your work, or **Discard changes** to throw the edits away.",
      "If you try to change page, week or unit with unsaved edits, the app asks you to save or discard first so nothing is lost by accident.",
    ],
    why: [
      "Every save keeps a copy in **History** (⋯ menu), so earlier versions can be restored by people who are allowed to.",
      "If two people edit the same plan at once, the app tells you the plan changed and asks you to reload before saving, so nobody overwrites the other.",
    ],
    fix: [["The page says 'A new version is available'", "Save your changes first, then press **Refresh** in the box. You get the newest version of the app."]],
  },
  {
    id: "lifecycle", g: "start", pages: ["*"], title: "The big picture: how a task travels through the app",
    kw: "logic flow lifecycle process overview how it works plan submit approve week starts locked update report explain effect",
    intro: "Understanding this one flow explains most of the app.",
    steps: [
      "**1. Plan (before the week starts).** In **Next plan** you add tasks for the coming week. You can edit freely, because the week has not started.",
      "**2. Submit.** Press **Submit for approval**. Group Strategy and the approvers see the plan. It is a notice that the plan is ready: you can keep editing.",
      "**3. Approve.** Approving accepts the plan as it stands and records it in the Activity log.",
      "**4. The week starts.** Now the task's {fixed} are **locked**. You can still change status, %, notes, owner, due date and evidence. To change a locked field you send a request that needs approval.",
      "**5. Update.** In **Progress update** you set the status and % for each task, attach evidence, and write the key results, blockers and asks.",
      "**6. Cut-off.** After {grace}, the week closes. Changes then need approval.",
      "**7. Report.** The weekly report, dashboard, monthly report and CEO actions all read from the saved plans. Tasks that are unfinished can be brought forward into the next plan.",
    ],
    why: [
      "Because every page reads from the same saved plans, an update you save shows up everywhere within moments: the dashboard, the report and your manager's view.",
      "If a number looks wrong anywhere, the cause is nearly always in the tasks: a missing status counts as 0%, and Closed tasks are left out of the score.",
    ],
    go: [["Next plan", "plan"], ["Progress update", "update"]],
  },

  // =====================================================================================================================
  // NEXT WEEK'S PLAN
  // =====================================================================================================================
  {
    id: "plan-add", g: "plan", pages: ["plan"], title: "Plan next week by hand, step by step",
    kw: "add task new line row create plan next week how to write enter fill title outcome department priority due date",
    intro: "Use this when you have a handful of tasks to enter. For many tasks, the Excel template is faster.",
    steps: [
      "Open **Plans → Next plan**. Check the pill at the top says **PLAN FOR NEXT WEEK** and the week dates are right.",
      "In the **Unit** box choose your function or unit (it is chosen for you if you only have one).",
      "Press **Add task**. A blank line appears at the top of the table.",
      "Write the **Task or product** (what will be done) and, if the line shows it, the **expected outcome** (what will exist or change when it is done).",
      "Choose **Category** (Operational, or Financial for money targets), **Due** date, **Department** and **Priority** ({priorities}).",
      "If the task has a number to reach (for example sales), fill **Target** and the unit (ETB, visits, %...). The % will be worked out later from the actual figure.",
      "Press **Save plan** at the bottom. The message 'Plan saved' appears.",
      "When the plan is ready, press **Submit for approval** at the top.",
    ],
    why: [
      "Every task gets a unique task code (like a reference number) when it is saved. The code stays with the task for life, even if it is brought forward into later weeks, so the same task is never counted twice.",
      "Pick the right **Department** now. After the week starts the department is locked, and department decides who may edit the task.",
    ],
    fix: [
      ["The new line did not appear", "A filter may be hiding it. The app now clears filters for you and says 'Filters cleared so the new task shows'. If you still do not see it, press **Clear** next to the filters."],
      ["The Department list is empty", "Your unit has no departments yet. The chief or planning head opens the **⋯ menu → Departments** and adds them."],
      ["I cannot add a task", "You may be view-only, or looking at a unit that is not yours. See 'Roles'."],
    ],
    go: [["Next plan", "plan"]],
  },
  {
    id: "plan-excel", g: "plan", pages: ["plan", "mplan"], title: "Plan with the Excel template: download, fill, upload",
    kw: "excel template upload import download xlsx csv columns file spreadsheet bulk many tasks error warning merge replace",
    intro: "The template lets you write many tasks offline and load them in one go.",
    steps: [
      "Go to **Next plan**, pick your unit and make sure the week is next week.",
      "Press **Download template**. You get an Excel file with {templateRows} empty rows. The week, unit and type are already filled in.",
      "Fill one task per row. Columns: {columns}. Only the task title is essential.",
      "Do **not** change the header row or the unit and week columns. Do not retype tasks that were brought forward. **Always download a fresh template**: an old one carries last week's dates and old department lists.",
      "Back in the app press **Upload Excel** and choose your file. A preview opens.",
      "Read the preview: green 'ready' rows will be imported, rows with notices are imported with a fix applied, and 'will be skipped' rows have an error (for example an unknown department).",
      "Choose what to do if a title already exists: **Update it and add new ones** (safe) or **Replace the unit's whole plan for that week** (it deletes what is there; the old version stays in History).",
      "Press **Import N rows**. Then check the plan and press **Submit for approval**.",
    ],
    why: [
      "The template does not include tasks already in the plan, so uploading only adds new tasks and never duplicates the old ones.",
      "Rows with a 'Week starting' date go to that week, so one file can carry last week's report and next week's plan.",
      "Departments are never created by an import: the department in the file must already exist in the unit, otherwise that row is held back. The preview suggests the closest name ('Did you mean...').",
      "If you give both a target and an actual, the % is calculated for you. A task marked Done gets 100%.",
    ],
    fix: [
      ["Row skipped: department not found", "Fix the spelling in Excel to match the unit's list exactly, or ask the chief/planning head to add the department first."],
      ["Status not recognised", "The app sets it to In progress and keeps your wording in the notes. Use: Not started, In progress, Done, Blocked, Delayed or Closed."],
      ["Due date not understood", "It is kept in the notes. Use a real date such as 2026-10-30 or 30/10/2026."],
      ["'Could not read that file'", "Use the template downloaded from this page and keep its header row. Save as .xlsx or .csv."],
      ["Nothing happens after upload", "Press **Import** in the preview. Nothing is saved until you do."],
    ],
    go: [["Next plan", "plan"]],
  },
  {
    id: "upd-fast", g: "upd", pages: ["update"], title: "Updating many tasks quickly on screen (and why there is no Excel upload here)",
    kw: "update progress many tasks quickly fast bulk long list tedious excel import upload not available status percent keyboard filter sort",
    intro: "Progress is updated directly in the app, not through Excel. That keeps the status, the %, the notes and the evidence together, and the update takes effect the moment you save. Excel upload exists only for planning new tasks.",
    steps: [
      "Open **Progress update**, choose your **unit** and check the week at the top.",
      "Use the **Status** filter (for example **No status**) to see the tasks you have not touched yet, and work down the list.",
      "For each task pick the **Status**. Choosing **Done** fills in 100% for you, so only the tasks that are partly done need a % typed.",
      "Click a column title such as **Due** or **Priority** to sort, so the urgent tasks come first.",
      "Press **Save plan** now and then (the bottom bar shows when something is unsaved), and once more at the end.",
      "Finish with the **Key results**, **Blockers** and **Asks** boxes at the bottom.",
    ],
    why: [
      "There is no Excel import on this page on purpose: an update made in a file can silently miss a task or a locked field, while on screen the app checks each change as you make it.",
      "If your list is very long, filter by department and update one department at a time.",
    ],
    go: [["Progress update", "update"]],
  },
  {
    id: "imp-trouble", g: "fix", pages: ["plan", "mplan"], pin: ["plan"], title: "My Excel import does not work: what to check",
    kw: "import not working upload excel fail error rows skipped no rows found could not read file old template last week column order changed header renamed department not found unit not found wrong week duplicate approval sent warning nothing imported",
    intro: "Imports fail for a handful of reasons. Go through this list from the top, it covers almost every case.",
    steps: [
      "**1. Use a fresh file, never an old one.** Download a new template every time you plan. An old file keeps last week's dates and the unit and department lists of the day it was made. If you downloaded it twice, make sure you upload the one you filled in (look at the file name, the one with (1) or a later time is usually the second download).",
      "**2. Check the week.** Each row goes to the week in its **Week starting** column. A file from last week sends the rows to last week, which is closed, so changes become approval requests or are refused. Fix: download a fresh template, or in the File check choose **Put every row in the week I am on**.",
      "**3. Do not change the header row.** Keep every column title as downloaded. Column order does not matter, but a renamed or deleted title may not be recognised, and the title row must be in the first 15 rows.",
      "**4. Pick from the dropdowns.** Unit, Department, Type, Category, Priority and Status are dropdowns. A typed or edited unit name is not found. A department must already exist in the unit (the import never creates one).",
      "**5. Read the File check and the preview before pressing Import.** The File check says which template the file came from, which week and unit the rows will go to, and what could not be read. Rows in red will be skipped and the Notice column says why. Rows in amber are imported with a small fix.",
      "**6. Look at the message after Import.** It says how many rows were imported, and how many changes were **sent for approval** instead of applied. Open **Approvals** to see them.",
      "**7. Make sure you are allowed to change those rows.** Department heads can only import rows for their own departments, and view-only roles cannot import at all.",
      "**8. Refresh the page.** An old version of the app open in the browser can behave differently. Press F5, then try again.",
      "**9. If you are still stuck:** note the unit, the week, the Notice text from the preview and your role, and send them to Group Strategy.",
    ],
    why: [
      "Group Strategy can import into any unit and any week and is never held back by locks. That is why an import can work for Group Strategy and not for a unit user using the same file: the difference is usually the week, the department or the locked fields.",
      "Nothing is saved until you press **Import** in the preview, so checking the preview costs nothing.",
    ],
    fix: [
      ["'No rows found. Use the template and keep its header row.'", "The app could not find the header. Use a file from the app and do not delete or rename the first row."],
      ["'Could not read that file'", "Save it as .xlsx or .csv. A file open in another program, or one downloaded from email in Protected View, can fail: save a copy first."],
      ["Department not found ('Did you mean...')", "Fix the spelling to the suggested name, or ask the chief/planning head to add the department under **⋯ → Departments**, then download a new template."],
      ["Unit not found", "Pick the unit from the dropdown. If the unit was renamed, download a new template."],
      ["Rows were imported but tasks look duplicated", "The title in the file was not exactly the same as a saved one. Import is meant for adding new tasks; to change existing tasks, edit them on screen."],
      ["'This file has no tasks filled in'", "You uploaded a blank template. Check which of your downloaded files you filled in and upload that one."],
      ["'N changes sent for approval'", "Those rows touched locked fields or a closed week. The approver decides them on the **Approvals** page."],
    ],
    go: [["Approvals", "approvals"]],
  },
  {
    id: "plan-bf", g: "plan", pages: ["plan"], title: "Bring forward unfinished tasks from earlier weeks",
    kw: "bring forward carry over unfinished carried repeat copy previous last week incomplete move task",
    intro: "Instead of retyping work that was not finished, bring it forward into the new plan.",
    steps: [
      "On **Next plan**, press **Bring forward**.",
      "A list shows unfinished tasks from the last 8 weeks, grouped by status, with the week each was last seen.",
      "Tick the ones you want. **In progress** and **Not started** are ticked for you; **Blocked** and **Delayed** start unticked, bring them only if they can really move. Use **Select all**, **In progress only** or **Select none**.",
      "Press **Bring N tasks forward**, then **Save plan**.",
    ],
    why: [
      "Brought-forward tasks keep their original task code, so the weekly and monthly reports follow one task across weeks instead of counting it as new.",
      "The copy shows a **Carried** tag (and ×2, ×3 if it keeps being carried). Its previous status and % are remembered, and a past due date is cleared and written in the notes.",
      "Done and Closed tasks are never listed, and tasks already in the plan show as duplicates so you cannot bring them twice.",
      "Department heads and staff only see tasks of their own departments in this list.",
    ],
    fix: [["'Nothing unfinished in the earlier weeks'", "Everything before was finished or closed, or you have not chosen a unit yet."]],
    go: [["Next plan", "plan"]],
  },
  {
    id: "plan-submit", g: "plan", pages: ["plan", "approvals"], pin: ["approvals"], title: "Submit for approval: what it does and what happens next",
    kw: "submit approval send plan waiting pending submitted again withdraw finance upload after approved edit",
    intro: "Submitting tells the approvers 'this plan is ready'. It does not lock the plan.",
    steps: [
      "Save the plan first. The Submit button is greyed out until the plan is saved and has at least one task.",
      "Press **Submit for approval** at the top. A pill beside the week shows **Waiting for approval**.",
      "Your approver opens it from the bell or **Approvals**, reviews it with **Open the plan**, and approves or rejects.",
      "If it is sent back, the pill shows **Sent back** with the written reason. Fix the plan and press **Submit again**.",
      "The pill beside the week always tells you where it stands: **Draft, not submitted**, **Waiting for approval**, **Approved** or **Sent back**.",
      "A department head or employee submits their own departments only, and sees only their own departments' status. One department being submitted or approved does not change the others. A chief or planning head sees one status per department.",
    ],
    why: [
      "While the plan is waiting you can keep editing, and your colleagues (for example a Finance head for the Finance rows) can keep adding their tasks or uploading their Excel. What each person may change still depends on their role and department.",
      "Approving accepts the plan as it stands at that moment. After approval the button reads **Approved** and stays off. If you change one of your tasks afterwards the pill turns **Approved, changed since** and the button becomes **Submit changes**, so the approver sees the final version. Changes by other departments do not count.",
      "Who approves: a department head's plan goes to the chief; a chief's goes to the planning head (or Group Strategy in corporate functions); the planning head approves their own. Nobody approves their own request otherwise.",
      "Once the week starts, tasks become partly locked. See 'Locked fields'.",
    ],
    fix: [
      ["The Submit button is grey", "Save the plan first, or the plan is empty, or it is already waiting for approval."],
      ["Who is my approver?", "Open **Approvals**. Each waiting request shows 'Waiting for: Chief / Planning head / Group Strategy'."],
    ],
    go: [["Approvals", "approvals"]],
  },
  {
    id: "duedate", g: "plan", pages: ["plan", "update"], pin: ["plan", "update"], title: "Changing a due date",
    kw: "due date deadline change reschedule move postpone calendar next week later date outside this week does not accept reverts",
    intro: "A due date has to fall **inside the week the task belongs to** (Saturday to Friday). You can change it any time, even after the week has started.",
    steps: [
      "Click the **Due** date of the task, or open the task with **Open details** and use **Due**.",
      "Pick a day from the calendar. The calendar only accepts days in this week, and the week is shown at the top of the page.",
      "Press **Save plan** (or **Save**) to keep it.",
      "If you need a date **after** this week, do not type it here. Go to **Next plan**, press **Bring forward**, tick the task, and set the new date there. The task keeps its number, so it is never counted twice.",
    ],
    why: [
      "Every task belongs to one week, and the weekly numbers count it in that week. A due date in another week would make the task show as 'due this week' or 'overdue' in the wrong week.",
      "If you type or pick a date outside the week, the date goes back to what it was and a message tells you why. Nothing is lost.",
      "A task that is already late keeps its old date until you change it. Changing it to a day inside this week is fine, but it will still show in the lists for earlier weeks if it was carried.",
    ],
    fix: [
      ["The date I picked disappeared", "It was outside this week. Pick a day from this week, or bring the task into next week's plan."],
      ["The year looks wrong (for example 0202)", "Type all four digits of the year, or pick from the calendar. A wrong year is outside the week and is not accepted."],
      ["I cannot change the date at all", "You may be viewing the task read-only (another unit, or a role that cannot edit). Open your own unit, or ask your department head."],
    ],
    go: [["Next plan", "plan"], ["Progress update", "update"]],
  },
  {
    id: "plan-notnext", g: "plan", pages: ["plan"], title: "The pill says 'NOT NEXT WEEK'",
    kw: "not next week wrong week pill go to next week plan for current week saturday",
    intro: "Next plan is meant for the coming week only. If you are looking at another week the pill turns amber.",
    steps: [
      "Click **Go to next week** in the hint under the title, or use the **›** arrow.",
      "Remember the Saturday rule: until {grace}, 'next week' is the week that has just started, because people still plan on Saturday morning.",
    ],
    why: ["After {grace} on Saturday, Next plan moves on to the following Saturday-to-Friday week automatically."],
    go: [["Next plan", "plan"]],
  },
  {
    id: "plan-targets", g: "plan", pages: ["plan", "update"], title: "Targets, actuals and how the % is worked out",
    kw: "target actual percent progress calculate revenue financial lower is better cost operational category number measure etb units",
    intro: "A task can be measured by a number (a target) instead of a feeling.",
    steps: [
      "On the plan, fill **Target** (the number to reach) and the unit beside it, such as ETB, visits or %.",
      "During the week, in **Progress update**, fill **Actual**.",
      "The % complete is **Actual ÷ Target**, capped at 100%.",
      "For things where lower is better (costs, delays), tick **Lower is better**: meeting or beating the target then counts as 100%.",
    ],
    why: [
      "A task with a target and an actual has its % worked out by the app, so you do not type it.",
      "**Financial** tasks (money, sales, revenue) get their own table in Progress update with Target, Actual and Performance, plus a total for the unit. Business units are judged mostly on these.",
      "Tasks with no number just use the status and the % you type.",
    ],
    fix: [["% will not change", "If the task has a target, the % is automatic. Change the **Actual** instead."]],
    go: [["Progress update", "update"]],
  },
  {
    id: "plan-deliverables", g: "plan", pages: ["plan", "update", "tasks"], title: "Deliverables and the tasks under them",
    kw: "deliverable sub task subtask parent child weight rollup roll up group part of kpi okr type",
    intro: "A deliverable is a bigger result made of several smaller tasks.",
    steps: [
      "Save the big task first so it gets a task code.",
      "Open it (the open icon on its row) and press **＋ Add a task under this**.",
      "Or, on any task, open **More details** and choose **Part of deliverable**.",
      "Optionally give each small task a **Weight in it**: 1 means an equal share, 2 counts double.",
    ],
    why: [
      "A deliverable's % is calculated from its tasks, which is why its % box is read-only and says '% from N tasks'.",
      "Switch between **By deliverable** and **All tasks** above the table to see either view. Reports follow the level you pick.",
      "**KPI / OKR** type lines are targets to watch. They are listed separately and are not counted as tasks in the scores.",
    ],
    go: [["Next plan", "plan"]],
  },
  {
    id: "locked", g: "appr", pages: ["plan", "update", "approvals"], pin: ["plan", "update"], title: "Locked fields (lock icon) and how to change them",
    kw: "locked lock icon cannot edit title outcome type department priority pencil bin delete request change rename approval fixed greyed",
    intro: "Once a week has started, a saved task keeps some details fixed so that the plan everyone agreed on cannot quietly change.",
    steps: [
      "**Fixed after the week starts:** {fixed}. {rename}",
      "**Always editable by you:** status, %, notes, owner, due date, target/actual and evidence.",
      "**To change a fixed field** click the **pencil** on the row, edit it, and save. The change is sent to the approver instead of being applied.",
      "**To remove a task** click the **bin**. Removing also needs approval.",
      "Track it on **Approvals** (your own requests show there until decided). Use **Withdraw** if you change your mind.",
    ],
    why: [
      "Next week's plan is not locked at all: until the week starts you can change anything.",
      "Chiefs, planning heads and Group Strategy can change fixed fields directly. The rules are meant for the people below them.",
      "Group Strategy can switch on 'Allow renaming saved tasks' for a short period when many titles need correcting. It is off by default.",
    ],
    fix: [["I need to fix a typo in a title", "If renaming is off, use the pencil and send a change request, or ask the planning head. If Group Strategy has turned renaming on, just edit the title and save."]],
    go: [["Approvals", "approvals"]],
  },
  {
    id: "plan-filters", g: "plan", pages: ["plan", "update", "tasks"], title: "Searching, filtering and sorting the task table",
    kw: "filter sort search priority status department clear order column header find rows hide hidden",
    intro: "Long lists are easier with filters. They only change what you see, never the data.",
    steps: [
      "Type in **Search tasks** to match titles.",
      "Use the **Priority**, **Status** and **Department** drop-downs. Press **Clear** to remove all filters.",
      "Click a column title to sort by it; click again to reverse, and a third time to remove the sort. Empty values always go last.",
    ],
    why: ["If a count says '3 of 12 tasks', a filter is hiding the other 9. Filters are cleared when you move between Progress update and Next plan."],
    fix: [["A task I know exists is missing", "Look for 'N of M tasks' beside the filters and press **Clear**. Also check the unit and the week."]],
  },
  {
    id: "departments", g: "plan", pages: ["plan", "update", "people"], title: "Departments inside a unit: adding and removing",
    kw: "department list add remove create new dept names unit managers",
    intro: "Each unit has its own list of departments. Tasks are tagged with a department, and the department decides who can edit them.",
    steps: [
      "Open **Progress update** or **Next plan** and choose your unit.",
      "Open the **⋯ menu** and press **Departments**.",
      "Type the name and press **Add department**. To remove one, press **×** beside it.",
      "Group Strategy can also manage departments from the **People** page.",
    ],
    why: [
      "Only the chief/director/GM, the planning head and Group Strategy can add or remove departments.",
      "Removing a department does not delete tasks: they keep their label. People already in that department keep it until their profile is changed.",
      "People are linked to departments in their profile, so add the department first, then assign people to it.",
    ],
    go: [["Next plan", "plan"]],
  },
  {
    id: "unplanned", g: "plan", pages: ["update"], title: "Adding a task that was not in the plan (unplanned task)",
    kw: "unplanned extra additional new task during the week not planned urgent ad hoc",
    intro: "Work comes up during the week. Record it so it is counted.",
    steps: [
      "On **Progress update** open **Add task ▾** and choose **Add unplanned task**.",
      "Write what the task is, set the department, status and %.",
      "Press **Save plan**. It carries an **Unplanned** tag in reports.",
    ],
    why: ["Marking it unplanned keeps the original plan honest: reports can show how much of the week's work was planned and how much came up later."],
    go: [["Progress update", "update"]],
  },

  // =====================================================================================================================
  // PROGRESS UPDATE
  // =====================================================================================================================
  {
    id: "upd-howto", g: "upd", pages: ["update"], title: "Update this week's progress, step by step",
    kw: "update progress status percent weekly how to report done in progress notes owner save week score key results blockers asks",
    intro: "Do this at least once a week, ideally on Friday or Saturday morning before the cut-off.",
    steps: [
      "Open **Plans → Progress update**. The pill should say **ACTUAL** and the dates should be the week you are reporting.",
      "Choose your **Unit**.",
      "For each task set the **Status** (Not started, In progress, Done, Blocked, Delayed or Closed) and the **Progress %**.",
      "Use the **open icon** on a row to add a one-line **Note**, the **Owner**, **evidence** files or a **dependency**.",
      "Fill the three boxes at the bottom: **Key results this week**, **Blockers and issues**, and **Asks to top management or other units**.",
      "Press **Save plan**. A message confirms it. The **Week score** card at the top updates.",
    ],
    why: [
      "Everything is saved against the task, and the dashboard and reports read from it, so you never report the same thing twice.",
      "A task with **no status counts as 0%**. Closed tasks are left out. So always give every task a status.",
      "The three boxes at the bottom feed the **Blockers and asks** panel on the Dashboard and the Monthly report, which is how top management sees what you need.",
    ],
    fix: [
      ["I cannot change the status", "You may be view-only, or the task belongs to another department, or the week is closed. See 'Roles' and 'The deadline and late updates'."],
      ["My save was refused with a conflict message", "Someone else saved the same plan a moment ago. Reload the page and apply your changes again."],
    ],
    go: [["Progress update", "update"]],
  },
  {
    id: "upd-status", g: "upd", pages: ["update", "tasks"], title: "What each status means, and what it changes automatically",
    kw: "status meaning not started in progress done blocked delayed closed no status percent automatic completed date stuck cancelled",
    intro: "Pick the status that is true today. The statuses are: {statuses}.",
    steps: [
      "**Not started:** planned but nothing done yet (0%).",
      "**In progress:** work has begun. Set the % you have reached.",
      "**Done:** finished. The % jumps to 100% and today's date is recorded as the completion date.",
      "**Blocked:** you cannot move because of something outside your control. The date it became blocked is recorded, and it shows on the dashboard's 'Needs attention'.",
      "**Delayed:** running late but not stuck.",
      "**Closed:** cancelled or no longer needed. Closed tasks are left out of scores and show as **Cancelled** in the final weekly report.",
      "**No status:** counts as 0%, so avoid it.",
    ],
    why: [
      "Changing a task from Done back to anything else clears the completion date and the 100%, so reports stay correct.",
      "Moving a task out of Blocked clears the blocked date.",
      "After a week closes, the weekly report replaces these statuses with final labels based on the % reached. See 'Final status labels'.",
    ],
    fix: [["I set Done but need to change the date it was completed", "Changing a completion date to a day other than today needs approval."]],
  },
  {
    id: "upd-score", g: "upd", pages: ["update", "dashboard"], title: "The Week score card and rating words",
    kw: "week score rating outstanding very high high satisfactory needs improvement low percent average indicative colour bar",
    intro: "At the top of Progress update the **Week score** shows the average % complete of all your tasks.",
    steps: [
      { fact: "ratings" },
      "The coloured bar splits your tasks into Done, In progress, Blocked or delayed, and Not started.",
    ],
    why: [
      "It is only an **indication** for the unit. The official rating is set at the end of the quarter.",
      "Every task counts equally. Closed tasks are not counted. A task with no status counts as 0%.",
    ],
  },
  {
    id: "upd-fin", g: "upd", pages: ["update"], title: "Updating financial (revenue) lines",
    kw: "financial revenue sales actual target performance total product money etb finance table",
    intro: "Financial tasks have their own table so the figures are quick to enter.",
    steps: [
      "On **Progress update** switch the **Operational / Financial** buttons above the table to **Financial**.",
      "For each product type the **Actual** figure.",
      "The **Performance** bar and % are calculated from Actual ÷ Target. A **Total** row sums the whole table.",
      "Press **Save plan**.",
    ],
    why: ["Business units are judged largely on financial performance, so the Financial table feeds the CEO action suggestions and unit scores."],
    go: [["Progress update", "update"]],
  },
  {
    id: "upd-evidence", g: "upd", pages: ["update", "tasks"], title: "Attaching evidence (files) to a task",
    kw: "evidence attach file upload pdf photo image document proof clip paperclip remove view download size limit",
    intro: "Evidence proves the work was done: a report, a photo, a signed letter.",
    steps: [
      "Open the task (the open icon on its row).",
      "Under **Evidence** press **📎 Attach** and choose the files from your computer.",
      "The message 'Attached. Save the plan to keep the evidence with the task.' appears. Press **Save plan**.",
      "Click a file name to view it. Use the remove icon to detach it.",
    ],
    why: [
      "Limits: {evidence}",
      "A paperclip with a number on the task row shows how many files are attached.",
    ],
    fix: [
      ["Upload failed", "Check the number of files, their total size and their type (see Good to know). Shrink big photos or save a PDF instead. You can attach more files in a second round."],
      ["The file disappeared after I left", "You did not press **Save plan** after attaching. Attach it again and save."],
    ],
  },
  {
    id: "deadline", g: "upd", pages: ["update", "plan", "tasks"], pin: ["plan", "tasks"], title: "The deadline and late updates (what happens after {grace})",
    kw: "deadline late update closed week past cut-off cutoff 2pm request update grace extend extension locked approval too late missed friday saturday",
    intro: "You can update the week that just ended directly until **{grace}** (Addis Ababa time).",
    steps: [
      "Before the cut-off: update normally and press **Save plan**.",
      "After the cut-off: the week is closed. A yellow note says changes need approval, and the save button changes to **Request update**.",
      "Make your edits and press **Request update**. The approver sees exactly what changed (old value → new value) and decides.",
      "Need more time for everyone? Ask Group Strategy: they can change the cut-off time or keep last week open until a chosen date and time.",
    ],
    why: [
      "The cut-off exists so the weekly report and dashboard show a fixed, fair picture once the week is over.",
      "After the cut-off, the weekly report shows **final status labels** (Achieved, Well performed...) instead of In progress / Done.",
      "Group Strategy is not blocked by the cut-off.",
    ],
    fix: [["I updated but the report still shows the old numbers", "Check that you pressed **Save plan** and that the save was not turned into a request. Requests show on **Approvals** until decided."]],
    go: [["Approvals", "approvals"]],
  },
  {
    id: "upd-ask", g: "upd", pages: ["update"], roles: ["staff"], title: "View-only? Ask your department head to update",
    kw: "ask update employee staff division head view only request department head cannot edit message",
    intro: "Employees and division heads can see their department's plan but cannot change it.",
    steps: [
      "On **Progress update** find the yellow 'View only' box with the text area.",
      "Write what should be updated (for example: 'Task A is done, Task B is at 60%').",
      "Press **Ask for an update**. The message says 'Sent to your department head'.",
      "Your department head (or the chief/planning head) sees it in their approvals and marks it done after updating.",
    ],
    why: ["This keeps one accountable person per department updating the plan, while still giving you a way to report your progress."],
  },
  {
    id: "undo", g: "upd", pages: ["update", "plan", "activity"], roles: APPR, title: "History, undo and restore: getting an older version back",
    kw: "history undo restore version revert mistake wrong overwritten previous copy backup",
    intro: "Every save keeps a copy, so mistakes can be reversed.",
    steps: [
      "Open the plan, press the **⋯ menu → History**.",
      "Each saved version is listed with who saved it and when. Press one to preview it.",
      "Press **Restore** on the one you want. The version you replace is also kept in History.",
      "From the **Activity log** you can also press **Undo** on a single change.",
    ],
    why: ["Only chiefs, planning heads, department heads and Group Strategy can undo. Nothing is ever really lost: a restore is itself recorded."],
  },

  // =====================================================================================================================
  // MONTHLY PLAN
  // =====================================================================================================================
  {
    id: "mp-howto", g: "mp", pages: ["mplan"], title: "Monthly plan: plan the month once and split it across its weeks",
    kw: "monthly plan month result target phase task split weeks even create weekly plans track tracking results ethiopian month",
    intro: "Instead of entering the same work week after week, plan the **results of the month** once and let the app create the weekly tasks.",
    steps: [
      "Open **Plans → Monthly plan**, choose your **unit** and the **month** (Ethiopian months, starting on day 1).",
      "Press **Add result** and choose the kind: **Target-based** (a number to reach, such as sales), **Phase-based** (a result reached in stages) or **Task-based** (a result reached by doing tasks).",
      "Give the result a name, department, priority and, for target-based, the monthly target and unit.",
      "Choose how to split it: **Evenly**, **More early**, **More late**, or **Custom** (type each week's figure). The check beside the row must say 'Adds up'.",
      "For phase- and task-based results, write the step planned each week (and for phases the % expected by the end of that week, which must not go down).",
      "Press **Create weekly plans**. The weekly tasks are written into each week of the month.",
      "Press **Submit for approval** to send the monthly plan to the approver.",
      "Switch to **Tracking** at any time to see how each result is being achieved, from the weekly updates.",
    ],
    why: [
      "Nothing reaches the weekly plans until you press **Create weekly plans**. Rows on screen before that are only a draft ('Not created yet').",
      "Each week's piece lands in that week's Next plan as a normal task linked to the monthly result, so weekly updates roll up into the result's %.",
      "A week belongs to the month holding most of its days (at least 4 of 7). Only Saturday-to-Friday weeks from {cutover} can be planned here.",
    ],
    fix: [
      ["'Short by' or 'Over by'", "The weekly figures do not add up to the monthly target. Adjust a week or choose a split."],
      ["'Create the weekly plans first'", "You have results not created yet. Press **Create weekly plans** or **Cancel** before submitting."],
      ["The month is greyed out", "Weeks before {cutover} use the old Monday weeks and cannot be planned here."],
    ],
    go: [["Monthly plan", "mplan"]],
  },
  {
    id: "mp-excel", g: "mp", pages: ["mplan"], title: "Monthly plan with Excel",
    kw: "monthly template excel upload import download results month file",
    intro: "Fill the monthly template offline, then load it.",
    steps: [
      "On **Monthly plan** press **Download template** and fill it (an Instructions sheet explains each column).",
      "Press **Upload Excel** and choose the file. The rows fill the table on screen.",
      "Check the rows, then press **Create weekly plans**.",
      "Submit for approval when ready.",
    ],
    why: ["Uploading only fills the table on screen. Nothing reaches the weekly plans until you press **Create weekly plans**."],
    go: [["Monthly plan", "mplan"]],
  },

  // =====================================================================================================================
  // APPROVALS
  // =====================================================================================================================
  {
    id: "appr-mine", g: "appr", pages: ["approvals"], title: "Following up my own requests and submissions",
    kw: "my request status pending approved rejected withdrawn waiting for reason where is track decision",
    intro: "Anything you send for approval (a submitted plan, a change to a locked field, a late update) shows up on the Approvals page.",
    steps: [
      "Open **Plans → Approvals**.",
      "Each card says what changed, who it is **Waiting for** (Chief, Planning head, Group Strategy...), and when you asked.",
      "When it is decided it moves to **Recent decisions** with the result and any comment.",
      "If it is **rejected**, read the comment: it says what to fix. Correct it and send again.",
      "Use **Withdraw** on a pending request you no longer want.",
    ],
    why: ["The bell tells you as soon as a decision is made."],
    go: [["Approvals", "approvals"]],
  },
  {
    id: "appr-decide", g: "appr", pages: ["approvals"], roles: APPR, title: "Approving or rejecting a request (for approvers)",
    kw: "approve reject decide comment reason request waiting for you submitted plan change before proposed approver chief planning",
    intro: "Requests that need your decision are under **Waiting for you**. Others are under **Waiting for someone else**.",
    steps: [
      "Open **Plans → Approvals** (or click the request from the bell).",
      "Read the table: each row is a change with **Before** and **Proposed** values. For a submitted plan press **Open the plan** to review all its tasks.",
      "Write a comment to the unit (optional when approving).",
      "Press **Approve** to apply the change, or **Reject**. A rejection **requires a written reason**.",
    ],
    why: [
      "Approving applies the change to the plan and records it in the Activity log. Rejecting leaves the plan untouched.",
      "Approving a submitted plan accepts the plan as it is at that moment.",
      "Nobody approves their own request, except the planning head who may approve their own plan. Group Strategy can decide anything.",
    ],
    fix: [["A request is not in my 'Waiting for you'", "It is waiting for a different step. Look at 'Waiting for' on the card; it may be for the chief, the planning head or Group Strategy."]],
    go: [["Approvals", "approvals"]],
  },
  {
    id: "appr-chain", g: "appr", pages: ["approvals", "plan"], title: "Who approves what: the approval chain",
    kw: "chain route who approves chief planning head group strategy department head step stage above one level",
    intro: "A request goes to the person one step above the one who asked.",
    steps: [
      "**Department head or employee request** → the **chief/director/GM** who covers that department. If there is none, the planning head. If none, Group Strategy.",
      "**Chief/director/GM request** → the **planning head** (in a corporate function it goes straight to Group Strategy).",
      "**Planning head request** → the planning head approves their own plan.",
      "**View-only employee 'ask to update'** → their department head, chief or planning head.",
    ],
    why: ["The 'Waiting for' label on each request shows the current step. Group Strategy can always step in."],
  },

  // =====================================================================================================================
  // REPORTS AND DASHBOARDS
  // =====================================================================================================================
  {
    id: "dash", g: "rep", pages: ["dashboard"], title: "Reading the dashboard",
    kw: "dashboard chart overview completion units status needs attention trend blockers asks filters period quarter group business unit function",
    intro: "The Dashboard shows how every unit and function is doing, with the week you selected.",
    steps: [
      "Use the **week arrows** at the top to look at a different week.",
      "Choose which units to include (all, business units only, corporate functions only, or pick specific ones).",
      "Switch **Weekly / Monthly / Quarterly** to change the period of the trend charts.",
      "**Completion by unit**, **Task status** and **Tasks done against planned** compare units this week.",
      "**Needs attention** lists blocked and overdue work. The CEO, DCEO and Group Strategy see every unit. Everyone else sees only their own unit, whatever they filter the charts by, so it is a list they can act on. If there are more than four, press **+ more** to see them all.",
      "**Weekly trend**, **Completed by week** and **Status mix by unit** show the direction over time.",
      "**Blockers and asks** shows what units wrote in their weekly report so management can act. Click a unit to open its plan.",
    ],
    why: [
      "The numbers come from the saved plans. A unit that has not saved anything shows as 'No plan'; tasks with no status count as 0%.",
      "Counts follow the level you choose (deliverables rolled up, or the individual tasks).",
    ],
    go: [["Dashboard", "dashboard"]],
  },
  {
    id: "rep-weekly", g: "rep", pages: ["tasks"], title: "Weekly report: filters, summary and downloads",
    kw: "weekly report all tasks table filter download pdf excel powerpoint pptx charts unit selection summary performance export",
    intro: "**Reports → Weekly report** lists every task you are allowed to see, for the selected week.",
    steps: [
      "Pick the week with the arrows. Use the filters to narrow by unit, department, status, priority, owner or text.",
      "The **Week performance summary** panel at the top shows how the week went in totals.",
      "Press **Download…** to choose which units to include and the format: **PowerPoint** (with charts), **Excel** or **PDF**.",
      "Click any task to open its details; click a column title to sort.",
    ],
    why: [
      "The PowerPoint has a title slide, a week-at-a-glance slide with charts, comparison by unit, one slide per unit, and a table of under-performed or cancelled tasks.",
      "Excel and PDF exports include final labels once the week is closed.",
    ],
    fix: [["The download is empty", "You must tick at least one unit that has tasks. Units with no tasks are not listed."]],
    go: [["Weekly report", "tasks"]],
  },
  {
    id: "rep-final", g: "rep", pages: ["tasks"], title: "Final status labels on the weekly report",
    kw: "final status achieved well performed partially achieved under performed cancelled bands percent label closed week",
    intro: "Once a week's update period is over, the report stops showing In progress / Done and shows a final label based on the % reached.",
    steps: [
      { fact: "finals" },
    ],
    why: [
      "Labels only appear for the weekly view, after {grace} following the end of the week. While the week is still open the report shows live statuses and a note 'Updates still open'.",
      "This gives a fair end-of-week picture. The Progress update page always keeps the working statuses.",
    ],
    go: [["Weekly report", "tasks"]],
  },
  {
    id: "rep-monthly", g: "rep", pages: ["monthly"], title: "Monthly report (Ethiopian months)",
    kw: "monthly report month ethiopian meskerem tikimt consolidated basis ends starts departments drill distinct tasks download",
    intro: "**Reports → Monthly report** adds up the weeks of one Ethiopian month.",
    steps: [
      "Choose the month with the arrows.",
      "Choose how a week counts: in the month it **ends in** or the month it **starts in**.",
      "Tick **Show departments** to see each department under its unit.",
      "Click any number to open the tasks behind it.",
      "Scroll down for the weekly reports (key results, blockers, asks) in week order.",
      "Press **Refresh** to reload, or download the report.",
    ],
    why: ["A task that appears in several weeks counts **once**, at its latest status. KPI / OKR lines are listed separately and not counted as tasks."],
    go: [["Monthly report", "monthly"]],
  },
  {
    id: "rep-ceo", g: "rep", pages: ["ceo"], roles: ["super_admin", "executive"], title: "Actions for the CEO",
    kw: "ceo dceo action suggested letter follow up rating band unit head corrective manual explain performance",
    intro: "For each unit the page suggests what the CEO should do, based on its progress and the Performance Evaluation Manual.",
    steps: [
      "Pick the week or month at the top.",
      "Each unit shows its score band and suggested actions, such as acknowledge, ask for a catch-up plan or hold a performance meeting.",
      "Press an action's button to send a short message to the unit head or to log a follow-up for Group Strategy.",
    ],
    why: ["Business units are judged mostly on financial performance (half the score) and corporate functions on delivery. Weekly suggestions are light-touch; monthly ones are firmer."],
    go: [["Actions for the CEO", "ceo"]],
  },

  // =====================================================================================================================
  // DELIVERY
  // =====================================================================================================================
  {
    id: "support", g: "del", pages: ["support"], title: "Business support requests: log, answer and track",
    kw: "business support request log function respond status open in progress on hold responded closed turnaround follow up category filter excel pdf",
    intro: "This page records what business units ask from corporate functions (HR, Finance, IT...) and how each request was answered.",
    steps: [
      "Press **+ Log a request**.",
      "Choose the function, who requested, the category and priority, and write the request.",
      "The function opens the request, writes what was done in **Response / action taken**, and sets the status: **Open → In progress → On hold → Responded → Closed**.",
      "Use the status buttons, function, category and date filters to find requests. **Excel** and **PDF** download the filtered list.",
    ],
    why: [
      "**Turnaround** shows days from request to response. Requests still open show how long they have been waiting, highlighted red if stale.",
      "**Follow-up = Yes** means someone needs to check later.",
      "Only the function concerned (and Group Strategy) can answer; everyone else can view.",
    ],
    go: [["Business support", "support"]],
  },
  {
    id: "fb", g: "del", pages: ["fb"], title: "Feedback and corrective actions",
    kw: "feedback ceo dceo group strategy corrective action issue owner due acknowledge log task linked",
    intro: "Feedback is written by the CEO, DCEO or Group Strategy about a unit or a task. Corrective actions record what is being done to fix a gap.",
    steps: [
      "**Giving feedback** (CEO, DCEO, Group Strategy): press **+ Give feedback**, choose the unit, optionally a task, and write the message. You can also do it from inside a task's **Discussion and feedback** section.",
      "**Receiving feedback:** units see a blue banner on their page. Open it and press **Acknowledge** so the sender knows it was read.",
      "**Corrective actions:** the unit head presses **+ Log a corrective action** and writes the issue, the action, the owner and the due date.",
      "Update the action's status (Open, In progress, Done, Closed) as work proceeds. Overdue open actions are marked.",
    ],
    why: ["Feedback tied to a task appears inside that task, so the reason and the fix stay with the work."],
    go: [["Feedback", "fb"]],
  },
  {
    id: "task-thread", g: "del", pages: ["update", "plan", "tasks"], title: "Comments and @mentions on a task",
    kw: "comment discussion mention at name thread chat reply task details panel notify",
    intro: "Every saved task has a discussion area.",
    steps: [
      "Open the task (the open icon on its row), then open **Discussion and feedback**.",
      "Type your comment. Write **@** followed by a person's name to mention them and notify them.",
      "Press send. The person sees it on their **bell**.",
    ],
    why: ["Only tasks that have a task code (saved at least once) have a discussion."],
  },

  // =====================================================================================================================
  // GROUP STRATEGY TOOLS
  // =====================================================================================================================
  {
    id: "adm-people", g: "adm", pages: ["people"], roles: ADM, title: "People: invite, change roles, reset passwords, approve requests",
    kw: "people users invite role unit department disable enable reset password approve role request access code domains super admin manage",
    intro: "The **People** page controls who can use the app and what they can do.",
    steps: [
      "**Invite someone:** open **Invite someone**, type their email, name, role, unit and departments, then **Send invite**. They sign in with that email and get the role you set.",
      "**Change a role:** click a person's row, change role, unit, departments or access (Active/Disabled), and **Save**.",
      "**Reset a password:** open the person and press the reset button. They sign in again with a code and choose a new password.",
      "**Decisions:** requests for a different role, and requests for access, are at the top. Choose the role/unit and approve or reject.",
      "**Approval code:** set a secret code. Someone sitting next to you can type it on their screen to approve their own pending role request.",
      "**Allowed email domains:** people with these company domains can sign themselves up as Employees.",
    ],
    why: [
      "Disabling someone blocks access without deleting their history.",
      "Choose departments from the unit's list. Add missing ones first under **Departments** on the same page.",
    ],
    go: [["People", "people"]],
  },
  {
    id: "adm-settings", g: "adm", pages: ["people"], roles: ADM, title: "Changing the Saturday cut-off, extending last week, and allowing renaming",
    kw: "setting deadline cutoff cut-off time 2pm extend until rename saved tasks allow title super admin control date",
    intro: "Three controls on the People page (**Update deadline and renaming**) let you manage deadlines without a developer.",
    steps: [
      "**Saturday cut-off:** choose the time (Addis Ababa) and press **Save time**. It is {grace} now.",
      "**Keep last week open until:** pick a date and time and press **Save date**. Last week stays open for direct updates until then. Press **Clear** to switch it off.",
      "**Allow renaming saved tasks:** tick to let people edit task titles after the week has started. Untick to lock them again. The default is off.",
    ],
    why: [
      "Settings apply to everyone within a few minutes (the app re-checks every 3 minutes and when a tab is reopened), and the server enforces them too.",
      "The extension only reaches back one week.",
      "Every change is written to the Activity log.",
      "{rename}",
    ],
    go: [["People", "people"]],
  },
  {
    id: "adm-units", g: "adm", pages: ["units"], roles: ADM, title: "Units, backups and restore",
    kw: "units add rename remove business unit corporate function type backup restore json download",
    intro: "The **Units** page lists every reporting unit.",
    steps: [
      "Rename a unit or change its type (Business unit / Corporate function) in the table.",
      "Add a unit: type its name, choose the type and press **Add unit**.",
      "Remove a unit with the remove button: its past plans stay saved.",
      "**Backup:** press **Download full backup (JSON)** and keep it on the shared drive.",
      "**Restore:** choose a backup file. Plans that change are kept in History first, so a restore can be undone.",
    ],
    why: ["The type matters: business units are scored mainly on financial results and corporate functions on delivery, and approvals route differently for functions."],
    go: [["Units", "units"]],
  },
  {
    id: "activity", g: "adm", pages: ["activity"], title: "Activity log: who changed what, and when",
    kw: "activity log audit history who changed when undo export excel who is updating not updated this week",
    intro: "Every save, import, approval and department change is recorded with the person who did it.",
    steps: [
      "Click the **clock** icon at the top right, or your initials → **Activity log**.",
      "Choose the **week**, then filter by unit, person or kind of action.",
      "Press the small **details** line to see exactly what changed.",
      "**Who is updating** (second tab) shows how active each person was in the last 30 days and which units have not updated this week.",
      "Press **Excel** to download the log.",
    ],
    why: ["Times are shown in UTC. Add 3 hours for Addis Ababa time."],
    go: [["Activity log", "activity"]],
  },
  {
    id: "viewas", g: "adm", pages: ["*"], roles: ADM, title: "View as another role (Group Strategy)",
    kw: "view as impersonate try role test see what they see employee manager screen",
    intro: "Group Strategy can see the app exactly as another role would, to understand a problem someone reports.",
    steps: [
      "Click your initials (top right) and choose **View as another role**. It is available to the main Group Strategy account.",
      "Pick the role, unit and departments to imitate.",
      "The screens and buttons change. A bar at the top reminds you that you are in View as mode. Use it to exit.",
    ],
    why: ["On the live app View as is read-only, so nothing can be saved by accident."],
  },

  // =====================================================================================================================
  // TROUBLESHOOTING
  // =====================================================================================================================
  {
    id: "fix-loading", g: "fix", pages: ["*"], title: "'Loading weekly plans…' never goes away, or the page looks stuck",
    kw: "loading stuck spinner blank white page slow connect offline reload refresh not loading plans",
    intro: "Usually a connection or an old version of the page.",
    steps: [
      "Check your internet. If there is an offline message at the top, wait for the connection.",
      "Refresh the page (F5, or pull down on a phone).",
      "If that does not help, sign out from your profile and sign in again.",
      "Still stuck? Tell Group Strategy which page, what time, and what you saw.",
    ],
    why: ["If you were signed out on another device, 'Sign out of all devices' also ends this session. Just sign in again."],
  },
  {
    id: "fix-nosave", g: "fix", pages: ["plan", "update", "mplan"], pin: ["update"], title: "My changes did not save",
    kw: "not saving lost missing disappeared cannot save error conflict refused permission request sent approval instead",
    intro: "Check these in order.",
    steps: [
      "Did you press **Save plan**? Typing alone is not saving.",
      "Did the message say 'sent for approval'? Then your change was turned into a request. See **Approvals**.",
      "Is it a conflict message? Reload and try again: someone saved before you.",
      "Are you in the right unit, week and department? Tasks of a department you do not belong to cannot be changed.",
      "Is the week closed (after {grace})? Use **Request update**.",
    ],
  },
  {
    id: "fix-missing-task", g: "fix", pages: ["plan", "update", "tasks"], title: "A task or a unit is missing",
    kw: "missing task cannot find disappeared unit not showing hidden gone filter week department",
    intro: "Almost always one of these.",
    steps: [
      "Look for 'N of M tasks' near the filters and press **Clear**.",
      "Check the week at the top. A task from last week is not in this week unless it was brought forward.",
      "Check the unit selector.",
      "Check the level switch **By deliverable / All tasks**: sub-tasks are hidden inside their deliverable in the first view.",
      "Closed tasks are left out of counts and some tables.",
      "Employees only see their own department.",
    ],
  },
  {
    id: "fix-numbers", g: "fix", pages: ["dashboard", "tasks", "monthly", "update"], title: "The percentages or counts look wrong",
    kw: "wrong numbers percent total count average score zero no status closed kpi mismatch different report dashboard",
    intro: "The numbers are calculated the same way everywhere, so look at the tasks.",
    steps: [
      "A task with **no status or no %** counts as **0%**: give every task a status.",
      "**Done** counts as 100% whatever the % box says.",
      "**Closed** tasks and **KPI / OKR** lines are not counted in scores.",
      "Tasks with a target and an actual use Actual ÷ Target, not the % you type.",
      "Deliverables take their % from the tasks under them.",
      "The monthly report counts a repeated task once, at its latest status; the weekly report counts each week separately.",
    ],
  },
  {
    id: "fix-version", g: "fix", pages: ["*"], title: "'A new version is available'",
    kw: "new version update refresh banner reload latest app updated",
    intro: "The app was improved while you had it open.",
    steps: ["Save your changes first.", "Press **Refresh** in the box. If you press **Later** it will ask again in 10 minutes."],
    why: ["Older tabs can behave slightly differently, so refreshing avoids confusing problems."],
  },
];
