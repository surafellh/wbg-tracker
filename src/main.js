import "./style.css";
import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import { applyPlugin } from "jspdf-autotable";
import { createData, configError, planFromRow, EVIDENCE, fileType } from "./data.js";
import { startGate } from "./gate.js";
import { groupTasks, rollupOf, rolledPlan, leafPlan, leafTasks, parentChoices, weightOf } from "./rollup.js";
import { ROLES, ROLE_LABEL, ROLE_HELP, isAdmin, unitMember, deptOk, canUndo, canFeedback, canEditDepartments, roleText, canDecide, STAGE_LABEL } from "./access.js";
import { assess, actions as ceoActions, letter as ceoLetter, INTERNAL, fmtD, addDaysIso } from "./ceoaction.js";
import { WEEK_CUTOVER, LOCKED, planOps, needsApproval, applyOps, addisToday, addisWeekStart, addisLockWeek, calcPct, CATEGORIES, weekStartOf, weekEndOf, nextWeekOf, prevWeekOf } from "./rules.js";
import { unitAlerts, levelRank, BLOCKED_DAYS } from "./alerts.js";
import { renderDashboard } from "./dashboard.js";
import { createExtras } from "./extras.js";
import { openViewer, canPreview } from "./viewer.js";
applyPlugin(jsPDF); window.jspdf = { jsPDF }; window.XLSX = XLSX;

(() => {
  const STATUSES = ["Not started","In progress","Done","Blocked","Delayed","Closed"];
  const PRIORITIES = ["High","Medium","Low"];
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const pad = n => String(n).padStart(2,"0");
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const parse = s => { const [y,m,d] = s.split("-").map(Number); return new Date(y, m-1, d); };
  const mondayOf = d => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const wd = (x.getDay()+6)%7; x.setDate(x.getDate()-wd); return x; };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate()+n); return iso(d); };
  const fmt = s => { if(!s) return ""; const d = parse(s); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
  const weekLabel = w => { const a = parse(w), b = parse(weekEndOf(w)); return a.getMonth()===b.getMonth() ? `${a.getDate()}–${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}` : `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`; };
  const uid = () => Math.random().toString(36).slice(2,10);
  const statusClass = s => s==="Done"?"s-done":s==="In progress"?"s-prog":s==="Blocked"?"s-bad":(s==="Not started"||s==="Delayed")?"s-not":s==="Closed"?"s-closed":"s-none";
  const todayIso = addisToday();
  const who = t => [t.dept, t.owner].filter(Boolean).join(" · ");

  const state = {
    week: addisWeekStart(),
    tab: "dashboard",
    units: [], unitsLoaded: false,
    plans: {}, plansLoaded: false,
    editUnit: null, draft: null, dirty: false, remoteChanged: false,
    
    confirmDelete: null,
    names: {}, activity: [], actLoaded: false, actErr: "", actFilter: { unit: "", who: "", action: "" }, actTab: "log", actWeek: "",
    imp: null, impUnit: "", impPrefill: false, impDefaultUnit: "", importing: false,
    monthBasis: "end", monthByDept: false, monthData: null, monthLoading: false, monthKey: "",
  };
  let db = null, api = null, downloads = null, myId = null, isOwner = false, me = null, dataMode = "";
  // The signed-in person (from the database). The database checks every save again.
  state.requests = []; state.dash = { type: "", units: [], period: "week", pop: false, range: 8 }; state.dashData = null; state.dashKey = "";
  state.level = "tasks"; state.history = null; state.lastSave = null; state.base = {}; state.unlock = new Set(); state.reqNotes = {}; state.people = null; state.pu = {};
  const auth = () => me ? { name: me.name || "", role: me.role, title: me.title || "", unit: me.unit || "", departments: me.departments || [] } : {};
  const isAppr = () => isAdmin(me);
  const isLenient = () => !!me && (me.role === "leader" || me.role === "planning");
  const canEdit = u => isAppr() || unitMember(me, u);
  const canLead = u => !!u && (isAppr() || (!!me && ["leader", "planning", "manager"].includes(me.role) && me.unit === u));
  const myUnit = () => me && unitMember(me, me.unit) ? me.unit : "";
  const mayUndo = () => canUndo(me);
  const mayDepts = u => canEditDepartments(me, u);
  const rowEd = (u, t) => !canEdit(u) ? false : (isAppr() || isLenient() || deptOk(me, u, t.dept) || (!t.dept && !savedTask(u, t)));
  let unsubPlans = null;
  const store = { get(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }, set(k,v){ try { localStorage.setItem(k,v); } catch(e){} } };
  const savedUnit = store.get("wp-unit"); if (savedUnit) state.editUnit = savedUnit;

  function toast(msg, action){
    const t = $("#toast"); t.innerHTML = ""; t.append(document.createTextNode(msg));
    const acts = (Array.isArray(action) ? action : [action]).filter(Boolean);
    acts.forEach(a => { const b = document.createElement("button"); b.className = "toast-act"; b.type = "button"; b.textContent = a.label; b.onclick = () => { t.hidden = true; a.fn(); }; t.append(b); });
    t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, acts.some(a => a.ms) ? Math.max(...acts.map(a => a.ms || 0)) : acts.length ? 9000 : 2800);
  }

  // ---------- data ----------
  const planId = (week, unit) => `${week}_${unit}`;
  function emptyPlan(unit){ return { week: state.week, unit, tasks: [], wins: "", blockers: "", asks: "", updatedAt: null, updatedBy: null }; }
  function summarize(p){
    const t = leafTasks((p && p.tasks) || []).filter(x => x.kind !== "KPI / OKR");
    const kpi = ((p && p.tasks) || []).length - ((p && p.tasks) || []).filter(x => x.kind !== "KPI / OKR").length;
    const done = t.filter(x => x.status==="Done").length;
    const blocked = t.filter(x => x.status==="Blocked").length;
    const high = t.filter(x => x.priority==="High").length;
    const highDone = t.filter(x => x.priority==="High" && x.status==="Done").length;
    // Every task counts: Done = 100, otherwise the % entered, and no status or no % counts as 0.
    const nums = t.map(x => x.status==="Done" ? 100 : (typeof x.pct==="number" ? x.pct : 0));
    const avg = nums.length ? Math.round(nums.reduce((a,b)=>a+b,0)/nums.length) : null;
    const noStatus = t.filter(x => !x.status).length;
    const overdue = t.filter(x => x.due && x.due < todayIso && x.status!=="Done").length;
    return { total: t.length, kpi, done, blocked, high, highDone, avg, noStatus, overdue };
  }

  const ALL = "__all__";
  const clone = o => JSON.parse(JSON.stringify(o));
  const isAll = () => state.editUnit === ALL;
  const hasDraft = () => !!(state.draft || state.allDrafts);
  state.allDrafts = null; state.dirtyUnits = new Set(); state.showLists = false;

  function subscribePlans(){
    if (!db) return;
    if (unsubPlans) unsubPlans();
    state.plansLoaded = false; state.plans = {};
    render();
    unsubPlans = db.collection("plans").where("week","==",state.week).onSnapshot(snap => {
      const next = {};
      snap.docs.forEach(d => { const v = d.data(); if (v && v.unit) next[v.unit] = v; });
      state.plans = next; state.plansLoaded = true;
      if (state.editUnit && !hasDraft() && !state.dirty) loadDraft();
      if (state.draft && state.editUnit && !isAll()) {
        const remote = next[state.editUnit];
        if (state.dirty && remote && remote.updatedAt !== state.draft.updatedAt) state.remoteChanged = true;
        if (!state.dirty) loadDraft();
      } else if (state.allDrafts) {
        if (!state.dirty) loadDraft();
        else Object.keys(state.allDrafts).forEach(u => {
          const remote = next[u];
          if (!state.dirtyUnits.has(u)) { state.allDrafts[u] = clone(remote || emptyPlan(u)); state.base[u] = remote ? clone(remote) : null; }
          else if (remote && remote.updatedAt !== state.allDrafts[u].updatedAt) state.remoteChanged = true;
        });
      }
      render();
    }, err => { banner(`The plan store stopped responding (${err.code}). Reload the page to reconnect.`); });
  }

  function loadDraft(){
    state.dirty = false; state.remoteChanged = false; state.dirtyUnits = new Set();
    if (!state.editUnit) { state.draft = null; state.allDrafts = null; return; }
    if (isAll()) {
      state.draft = null;
      state.allDrafts = Object.fromEntries(sortedUnits().map(u => [u.id, clone(state.plans[u.id] || emptyPlan(u.id))]));
      state.base = Object.fromEntries(sortedUnits().map(u => [u.id, state.plans[u.id] ? clone(state.plans[u.id]) : null]));
      return;
    }
    state.allDrafts = null;
    state.draft = clone(state.plans[state.editUnit] || emptyPlan(state.editUnit));
    state.base = { [state.editUnit]: state.plans[state.editUnit] ? clone(state.plans[state.editUnit]) : null };
  }
  const planFor = u => isAll() ? state.allDrafts && state.allDrafts[u] : state.draft;

  // ---------- saving: direct changes save now, the rest goes to Group Strategy for approval ----------
  const newId = () => `${Date.now().toString(36)}${uid()}`;
  const ERR = {
    not_allowed: "You can't save changes to this unit with your current sign-in. Sign out and sign in again, then retry. If it keeps happening, ask Group Strategy to check your role and unit.",
    not_allowed_dept: "One of these tasks is in a department that is not yours (or has no department). Pick one of your own departments for the task, or remove it, then save again.",
    bad_request: "This plan could not be read. Reload the page and try again.",
    conflict: "Someone saved this plan a moment ago. Their version is now loaded underneath yours: press Save again to add your changes.",
    needs_approval: "This change needs Group Strategy approval.", not_pending: "That request was already decided.",
    too_late: "Undo is only possible for 30 minutes after your own save.", not_found: "Nothing to restore.",
    bad_code: "That approval code is not right.", too_many: "Too many wrong tries. Wait 15 minutes and try again.", code_off: "The approval code is not turned on.", already_pending: "You already have a request waiting. Withdraw it first to send a different one.", no_change: "That is the same as your current role and unit.", reason_needed: "Write a short reason (at least 5 characters).", bad_role: "That role cannot be requested.", quota_exceeded: "Storage is full. Ask the Strategy Office to archive old weeks.", pin_too_short: "A PIN needs at least 4 characters.", code_too_short: "The approver code needs at least 6 characters.",
  };
  const errText = e => { const k = e && (e.error || e.code || e); return ERR[k] || (typeof k === "string" && /^[a-z_]{3,40}$/.test(k) && k !== "error" ? `Could not save (${k}). Reload the page and try again. If it keeps happening, tell Group Strategy this code.` : "Could not reach the server. Check your connection and try again."); };
  function opSummary(ops){
    const add = ops.filter(o => o.op === "add").length, rem = ops.filter(o => o.op === "remove").length;
    const upd = new Set(ops.filter(o => o.op === "set").map(o => o.id)).size, txt = ops.some(o => o.op === "text");
    return [add && `${add} added`, upd && `${upd} updated`, rem && `${rem} removed`, txt && "report text edited"].filter(Boolean).join(", ");
  }
  const showF = (f, v) => f === "ev" ? `${(v || []).length} file${(v || []).length === 1 ? "" : "s"}` : f === "depUnit" ? (v ? unitName(v) : "–") : showV(v);
  function opLines(ops){
    const lines = [], byTask = new Map();
    ops.forEach(o => {
      if (o.op === "add") lines.push(`Added "${short(o.task.title)}"`);
      else if (o.op === "remove") lines.push(`Removed "${short(o.task.title)}"`);
      else if (o.op === "text") lines.push(`Edited ${({ wins: "key results", blockers: "blockers", asks: "asks" })[o.f]}`);
      else { if (!byTask.has(o.id)) byTask.set(o.id, { title: o.title, ch: [] }); byTask.get(o.id).ch.push(o.f === "title" ? `title → "${short(o.to)}"` : `${FLAB[o.f] || o.f} ${showF(o.f, o.from)} → ${showF(o.f, o.to)}`); }
    });
    byTask.forEach(t => lines.push(`Updated "${short(t.title)}": ${t.ch.join("; ")}`));
    return lines;
  }
  // saved = the plan as it was when editing started; draft = the edited copy; latest = what is in the store now
  async function persistPlan(u, week, saved, draft, opts = {}){
    draft.tasks = (draft.tasks || []).filter(t => (t.title || "").trim());
    const unnumbered = draft.tasks.filter(t => !t.ref);
    if (unnumbered.length) { const r = await api.allocRefs(auth(), u, unnumbered.length); if (r.error) return { error: r.error }; unnumbered.forEach((t, i) => { t.ref = `${r.prefix}-${String(r.start + i).padStart(4, "0")}`; }); }
    const ops = planOps(saved, draft);
    if (!ops.length) return { nothing: true };
    const monday = thisMonday(), appr = isAppr();
    const need = o => isLenient() ? (week < monday || (o.op === "set" && o.f === "completedAt" && o.to && o.to !== todayIso && week === monday)) : needsApproval(o, week, monday, todayIso);
    const direct = appr ? ops : ops.filter(o => !need(o));
    const queued = appr ? [] : ops.filter(o => need(o));
    const res = { saved: false, requested: 0 };
    if (direct.length) {
      const latest = opts.latest !== undefined ? opts.latest : (week === state.week ? state.plans[u] : saved);
      const plan = applyOps(latest || { week, unit: u, tasks: [], wins: "", blockers: "", asks: "" }, direct, { at: new Date().toISOString(), by: myId || "" });
      plan.week = week; plan.unit = u; plan.source = opts.source || "";
      const r = await api.savePlan(auth(), plan, latest ? latest.updatedAt : null, !!opts.force, { id: newId(), action: opts.action || "save", summary: (opts.prefix || "") + opSummary(direct), details: opLines(direct).slice(0, 40) });
      if (r.error) return { ...r };
      res.saved = true; state.lastSave = { id: planId(week, u), at: Date.now() };
    }
    if (queued.length) {
      const byId = new Map([...((saved && saved.tasks) || []), ...((draft && draft.tasks) || [])].map(t => [t.id, t]));
      const depts = [...new Set(queued.map(o => (o.task ? o.task.dept : (byId.get(o.id) || {}).dept) || "").filter(Boolean))];
      const r = await api.requestChange(auth(), { id: newId(), unit: u, week, summary: (opts.prefix || "") + opSummary(queued), details: opLines(queued).slice(0, 60), patch: queued, depts });
      if (r.error) return { ...res, error: r.error };
      res.requested = queued.length;
    }
    return res;
  }
  async function saveDraft(){
    if (!db || !hasDraft()) return;
    const units = isAll() ? [...state.dirtyUnits] : [state.editUnit];
    let saved = 0, requested = 0;
    for (const u of units) {
      if (!canEdit(u)) { toast(ERR.not_allowed); return; }
      const d = isAll() ? state.allDrafts[u] : state.draft;
      let r;
      try { r = await persistPlan(u, state.week, state.base[u], d); } catch (e) { r = { error: e.code || "error" }; }
      if (r.error) { if (r.error === "conflict") state.remoteChanged = true; toast(errText(r)); render(); return; }
      if (r.saved) saved++; requested += r.requested || 0;
    }
    state.dirty = false; state.remoteChanged = false; state.dirtyUnits = new Set();
    loadDraft(); render();
    const msg = [saved && (isAll() ? `Saved ${saved} plan${saved === 1 ? "" : "s"}` : "Plan saved"), requested && `${requested} change${requested === 1 ? "" : "s"} sent to Group Strategy for approval`].filter(Boolean).join(" · ") || "Nothing to save";
    const undoAct = saved && !isAll() && state.lastSave && mayUndo() ? { label: "Undo", fn: undoLast } : null;
    const sb = saved && !isAll() && state.tab === "plan" && state.week === nextMonday() ? subOf(state.editUnit, "week", state.week) : null;
    const askSubmit = saved && !isAll() && state.tab === "plan" && state.week === nextMonday() && !(sb && sb.status === "pending") && (((state.plans[state.editUnit] || {}).tasks) || []).length;
    if (askSubmit) toast("Plan saved. Click Submit for approval, at the top of the page, to send it.", [{ label: "Submit for approval", fn: submitWeek, ms: 10000 }, undoAct]);
    else toast(msg, undoAct);
  }
  async function undoLast(){
    const ls = state.lastSave; if (!ls) return;
    try { const r = await api.undoLast(auth(), ls.id); toast(r.error ? errText(r) : "Last save undone"); state.lastSave = null; }
    catch (e) { toast(errText(e)); }
  }

  // ---------- Ethiopian calendar ----------
  const ETH_M = ["Meskerem","Tikimt","Hidar","Tahsas","Tir","Yekatit","Megabit","Miazia","Ginbot","Sene","Hamle","Nehase","Pagume"];
  const jdnOf = (y, m, d) => { const a = Math.floor((14 - m) / 12), yy = y + 4800 - a, mm = m + 12 * a - 3; return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045; };
  function toEth(s){
    const [y, m, d] = s.split("-").map(Number), j = jdnOf(y, m, d) - 1723856, r = j % 1461, n = (r % 365) + 365 * Math.floor(r / 1460);
    return { y: 4 * Math.floor(j / 1461) + Math.floor(r / 365) - Math.floor(r / 1460), m: Math.floor(n / 30) + 1, d: (n % 30) + 1 };
  }
  function ethRange(a, b){ const A = toEth(a), B = toEth(b); return A.m === B.m && A.y === B.y ? `${ETH_M[A.m-1]} ${A.d}–${B.d}, ${A.y} EC` : `${ETH_M[A.m-1]} ${A.d} – ${ETH_M[B.m-1]} ${B.d}, ${B.y} EC`; }
  const ethWeekLabel = w => ethRange(w, weekEndOf(w));
  function ethMonthRange(e){
    const g = new Date(e.y + 7, 8, 11 + 30 * (e.m - 1)); let start = null;
    for (let k = -6; k <= 6 && !start; k++) { const s = iso(new Date(g.getFullYear(), g.getMonth(), g.getDate() + k)), x = toEth(s); if (x.y === e.y && x.m === e.m && x.d === 1) start = s; }
    let end = start; for (let i = 1; i < 31; i++) { const s = addDays(start, i), x = toEth(s); if (x.m === e.m && x.y === e.y) end = s; else break; }
    return { start, end };
  }
  const ethName = e => `${ETH_M[e.m - 1]} ${e.y} EC`;
  // ---------- reporting months and week numbers ----------
  // Months are named in the Gregorian calendar but start on Ethiopian day 1 (Oct = 11 Oct to 9 Nov). A week belongs to the month holding its middle day.
  const RM_S = { 1: "Sep", 2: "Oct", 3: "Nov", 4: "Dec", 5: "Jan", 6: "Feb", 7: "Mar", 8: "Apr", 9: "May", 10: "Jun", 11: "Jul", 12: "Aug", 13: "Sep" };
  const RM_L = { 1: "September", 2: "October", 3: "November", 4: "December", 5: "January", 6: "February", 7: "March", 8: "April", 9: "May", 10: "June", 11: "July", 12: "August", 13: "September" };
  const FYM = [[2018, 11], [2018, 12], [2019, 1], [2019, 2], [2019, 3], [2019, 4], [2019, 5], [2019, 6], [2019, 7], [2019, 8], [2019, 9], [2019, 10]].map(([y, m]) => ({ y, m }));   // Jul 2026 to Jun 2027 (fiscal year starts 8 Jul 2026)
  function rmWeeksAll(Y, m){
    const { start, end } = ethMonthRange({ y: Y, m }); if (!start) return [];
    const out = []; let w = weekStartOf(start), g = 0;
    while (w <= end && g++ < 8) { const e = toEth(addDays(w, 3)); if (e.y === Y && e.m === m) out.push(w); w = nextWeekOf(w); }
    return out;
  }
  const _wkc = new Map();
  function wkInfo(w){ let c = _wkc.get(w); if (c) return c; const e = toEth(addDays(w, 3)), k = rmWeeksAll(e.y, e.m).indexOf(w) + 1; c = { n: k, tag: k ? `${RM_S[e.m]} W${k}` : RM_S[e.m] }; _wkc.set(w, c); return c; }
  const wkTag = w => wkInfo(w).tag;
  const FY_START = "2026-07-08";
  function fyWeek(w){ let x = weekStartOf(FY_START), k = 1; if (w < x) return 0; while (x < w && k < 80) { x = nextWeekOf(x); k++; } return x === w ? k : 0; }
  state.eth = toEth(iso(new Date())); state.monthBasis = "end";
  state.ov = { priority: "High", status: "", unit: "", q: "", all: false };
  state.expanded = new Set(); state.bf = null; state.carryInfo = null; state.carryKey = "";
  const newFilter = () => ({ unit: "", status: "", statuses: [], priority: "", kind: "", dept: "", q: "", period: "week", from: "", group: false, category: "" });
  state.filter = newFilter();
  const thisMonday = () => weekStartOf(todayIso);   // start of the current week (Saturday from 10 Oct 2026)
  const nextMonday = () => nextWeekOf(thisMonday());

  // ---------- this week's update / next week's plan ----------
  function planBanner(){
    if (state.tab === "plan") {
      const on = state.week === nextMonday();
      return `<div class="banner ${on ? "info" : "warn"}"><b>${on ? "Planning" : "Viewing"} ${esc(weekLabel(state.week))} · ${esc(ethWeekLabel(state.week))}.</b> ${on ? "Enter next week's tasks here: add them by hand, bring forward unfinished work, or import an Excel plan further down." : `This is not next week. <button class="btn" id="goNext" style="margin-left:6px">Go to next week (${esc(weekLabel(nextMonday()))})</button>`}</div>`;
    }
    return `<div class="banner info">Update progress for <b>${esc(weekLabel(state.week))} · ${esc(ethWeekLabel(state.week))}</b>: status, % complete, key results, blockers and asks. New tasks for the coming week go under <b>Next week's plan</b>.</div>`;
  }
  function carryBanner(){
    const c = state.carryInfo; if (!c || c.key !== `${state.week}|${state.editUnit}` || !state.draft) return "";
    const have = new Set(state.draft.tasks.map(t => norm(t.title))); const n = c.items.filter(t => !have.has(norm(t.title))).length;
    return n ? `<div class="slimnote warn">${n} unfinished task${n > 1 ? "s" : ""} from earlier weeks not in this week. <button class="lnk" id="bfBtn2">Review and bring forward</button></div>` : "";
  }
  function fetchCarry(){
    if (!((state.tab === "update" || state.tab === "plan") && db && state.editUnit && !isAll() && state.draft)) return;
    const key = `${state.week}|${state.editUnit}`; if (state.carryKey === key) return; state.carryKey = key;
    earlierUnfinished(state.editUnit, state.week).then(items => { state.carryInfo = { key, items: items.map(x => x.t) }; render(); }).catch(() => {});
  }
  // Unfinished tasks from the weeks before this one (newest version of each task wins; a task finished in a later week is left out)
  async function earlierUnfinished(unit, week, n = 8){
    let oldest = week, last = week; for (let i = 0; i < n; i++) { last = prevWeekOf(last); oldest = last; }
    const snap = await db.collection("plans").where("week", ">=", oldest).where("week", "<=", prevWeekOf(week)).get();
    const rows = snap.docs.map(d => d.data()).filter(v => v && v.unit === unit).sort((a, b) => a.week < b.week ? 1 : -1);
    const seen = new Map();
    rows.forEach(p => allRealTasks(p).forEach(t => { const k = t.ref || norm(t.title); if (!seen.has(k)) seen.set(k, { t, wk: p.week }); }));
    return [...seen.values()].filter(x => x.t.status !== "Done" && x.t.status !== "Closed");
  }
  async function openBf(){
    if (!db || isAll() || !state.editUnit || !state.draft) { toast("Choose one unit first"); return; }
    let found;
    try { found = await earlierUnfinished(state.editUnit, state.week); } catch (e) { toast("Could not read the earlier weeks"); return; }
    const have = new Set(state.draft.tasks.map(t => norm(t.title)));
    const items = found.map(({ t, wk }) => ({ t, wk, dup: have.has(norm(t.title)), checked: !have.has(norm(t.title)) && (t.status === "In progress" || t.status === "Not started" || !t.status) }));
    if (!items.length) { toast("Nothing unfinished in the earlier weeks"); return; }
    state.bf = { items, week: prevWeekOf(state.week) }; renderModal();
  }
  function bfCount(){ return state.bf ? state.bf.items.filter(x => x.checked && !x.dup).length : 0; }
  function renderModal(){
    const root = $("#modalRoot"), b = state.bf; if (!b) { root.innerHTML = ""; return; }
    const order = ["In progress","Not started","","Blocked","Delayed"];
    const groups = order.map(s => ({ s, list: b.items.map((x, i) => ({ ...x, i })).filter(x => (x.t.status || "") === s) })).filter(g => g.list.length);
    root.innerHTML = `<div class="overlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="bfTitle">
      <div class="panel-head"><div><h2 id="bfTitle">Bring forward unfinished tasks</h2><div class="small muted">From the last 8 weeks into ${esc(weekLabel(state.week))}. Each task shows the week it was last seen in. Done tasks are not listed. Blocked and Delayed tasks start unticked: bring them only if they will still be worked on. Unticked tasks stay in last week only.</div></div></div>
      <div class="toolbar" style="padding:10px 16px"><button class="btn" id="bfAll">Select all</button><button class="btn" id="bfProg">In progress only</button><button class="btn" id="bfNone">Select none</button></div>
      <div style="padding:0 16px 8px">${groups.map(g => `<div class="small muted" style="margin:10px 0 4px;font-weight:700;text-transform:uppercase;letter-spacing:.05em">${esc(g.s || "No status")} · ${g.list.length}</div>${g.list.map(x => `<label class="bf-row ${x.dup ? "dim" : ""}"><input type="checkbox" data-bf="${x.i}" ${x.checked ? "checked" : ""} ${x.dup ? "disabled" : ""}><span><b>${esc(x.t.title)}</b>${x.dup ? ' <span class="tag">Already in this week</span>' : ""}<br><span class="small muted">${[x.t.dept, x.t.owner, typeof x.t.pct === "number" ? x.t.pct + "%" : "", x.t.due ? "due " + fmt(x.t.due) : ""].filter(Boolean).map(esc).join(" · ")}${x.wk ? ` · <b>from ${esc(weekShort(x.wk))}</b>` : ""}</span></span></label>`).join("")}`).join("")}</div>
      <div class="save-bar"><span class="small muted">Past due dates are cleared on the copy and kept in its notes.</span><div class="toolbar"><button class="btn" id="bfCancel">Cancel</button><button class="btn primary" id="bfGo">Bring ${bfCount()} task${bfCount() === 1 ? "" : "s"} forward</button></div></div></div></div>`;
  }
  function bfGo(){
    const b = state.bf; if (!b) return; const sel = b.items.filter(x => x.checked && !x.dup);
    sel.forEach(x => {
      const t = clone(x.t), past = t.due && t.due < todayIso;
      state.draft.tasks.push({ ...t, id: uid(), carried: true, carriedCount: (t.carriedCount || 0) + 1, prevStatus: t.status || "", prevPct: typeof t.pct === "number" ? t.pct : null, completedAt: "",
        due: past ? "" : (t.due || ""), notes: [t.notes, `Carried from ${fmt(x.wk || b.week)} week${past ? ` (was due ${fmt(t.due)})` : ""}`].filter(Boolean).join(" | ") });
    });
    if (sel.length) { state.dirty = true; state.dirtyUnits.add(state.editUnit); }
    state.bf = null; renderModal(); toast(sel.length ? `${sel.length} task${sel.length > 1 ? "s" : ""} brought forward. Save to keep them.` : "No tasks selected"); render();
  }
  $("#modalRoot").addEventListener("click", e => {
    const t = e.target.closest("button"); if (!t) return;
    if (state.history) {
      if (t.id === "hClose") { state.history = null; renderHistory(); }
      else if (t.dataset.hprev) { state.history.preview = state.history.preview === t.dataset.hprev ? null : t.dataset.hprev; renderHistory(); }
      else if (t.dataset.hrestore) {
        if (state.dirty) { toast("Save or discard your changes first"); return; }
        api.restoreVersion(auth(), t.dataset.hrestore).then(r => { if (r.error) { toast(errText(r)); return; } toast("Restored. The replaced version is kept in History."); state.history = null; renderHistory(); }).catch(x => toast(errText(x)));
      }
      return;
    }
    if (!state.bf) return;
    const setAll = fn => { state.bf.items.forEach(x => { if (!x.dup) x.checked = fn(x); }); document.querySelectorAll("#modalRoot input[data-bf]").forEach(c => { const x = state.bf.items[Number(c.dataset.bf)]; c.checked = x.checked; }); const g = $("#bfGo"); if (g) g.textContent = `Bring ${bfCount()} task${bfCount() === 1 ? "" : "s"} forward`; };
    if (t.id === "bfAll") setAll(() => true); else if (t.id === "bfNone") setAll(() => false); else if (t.id === "bfProg") setAll(x => x.t.status === "In progress");
    else if (t.id === "bfCancel") { state.bf = null; renderModal(); } else if (t.id === "bfGo") bfGo();
  });
  $("#modalRoot").addEventListener("change", e => { const c = e.target; if (c.dataset.bf !== undefined && state.bf) { state.bf.items[Number(c.dataset.bf)].checked = c.checked; const g = $("#bfGo"); if (g) g.textContent = `Bring ${bfCount()} task${bfCount() === 1 ? "" : "s"} forward`; } });

  // ---------- overview: task detail ----------
  function renderOvTasks(){
    if (!state.units.length || !state.plansLoaded) return "";
    const o = state.ov, pool = levelTasks().filter(t => t.kind !== "KPI / OKR"), q = o.q.trim().toLowerCase();
    const cnt = { high: pool.filter(t => t.priority === "High").length, done: pool.filter(t => t.status === "Done").length, ns: pool.filter(t => t.status === "Not started").length };
    const pr = { High: 0, Medium: 1, Low: 2 };
    const list = pool.filter(t => (!o.unit || t.unit === o.unit) && (!o.priority || (o.priority === "none" ? !t.priority : t.priority === o.priority)) && (!o.status || (o.status === "none" ? !t.status : t.status === o.status)) && (!q || `${t.ref || ""} ${t.title} ${t.dept || ""} ${t.owner || ""}`.toLowerCase().includes(q)))
      .sort((a, b) => (pr[a.priority] ?? 3) - (pr[b.priority] ?? 3) || a.unitName.localeCompare(b.unitName));
    if (state.sort.ov && state.sort.ov.k) { const sorted = sortedBy(list, "ov"); list.length = 0; list.push(...sorted); }
    const shown = o.all ? list : list.slice(0, 50);
    const rows = shown.map(readRow).join("");
    const on = (p, s) => (o.priority === p && o.status === s) ? " on" : "";
    return `<div class="panel" style="margin-top:16px">
      <div class="panel-head"><h2>Tasks in ${esc(weekLabel(state.week))}</h2>
        <div class="toolbar"><button class="btn${on("High", "")}" id="ovHigh">High priority · ${cnt.high}</button><button class="btn${on("", "Done")}" id="ovDone">Completed · ${cnt.done}</button><button class="btn${on("", "Not started")}" id="ovNS">Not started · ${cnt.ns}</button></div></div>
      <div class="toolbar" style="padding:12px 16px;border-bottom:1px solid var(--line)">
        <label class="small muted" for="ovPri">Priority</label><select id="ovPri"><option value="">All</option>${PRIORITIES.map(p => `<option ${o.priority === p ? "selected" : ""}>${p}</option>`).join("")}<option value="none" ${o.priority === "none" ? "selected" : ""}>Not set</option></select>
        <label class="small muted" for="ovSt">Status</label><select id="ovSt"><option value="">All</option>${STATUSES.map(s => `<option ${o.status === s ? "selected" : ""}>${s}</option>`).join("")}<option value="none" ${o.status === "none" ? "selected" : ""}>No status</option></select>
        <select id="ovUnit" aria-label="Unit"><option value="">All units</option>${sortedUnits().map(u => `<option value="${esc(u.id)}" ${o.unit === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>
        <input type="text" id="ovQ" placeholder="Search" value="${esc(o.q)}" aria-label="Search tasks"><span class="small muted">${list.length} task${list.length === 1 ? "" : "s"}</span>
        <button class="btn ghost" id="ovOpen">Open in All tasks</button></div>
      ${list.length ? `<div class="scroll"><table><thead><tr>${readHead("ov")}</tr></thead><tbody>${rows}</tbody></table></div>${list.length > shown.length ? `<div class="toolbar" style="padding:12px 16px"><span class="small muted">Showing ${shown.length} of ${list.length}</span><button class="btn" id="ovAll">Show all</button></div>` : ""}` : `<div class="empty"><b>No tasks match</b>Change the priority or status.</div>`}</div>`;
  }

  // ---------- all tasks (with filters, month drill-down and department grouping) ----------
  function allTasks(){
    return sortedUnits().flatMap(u => (state.plans[u.id]?.tasks || []).map(t => ({ ...t, unit: u.id, unitName: u.name })));
  }
  // the same list, but following the chosen level (deliverables rolled up, or the individual tasks)
  function levelTasks(){
    return sortedUnits().flatMap(u => ((state.plans[u.id] && levelPlan(state.plans[u.id]).tasks) || []).map(t => ({ ...t, unit: u.id, unitName: u.name })));
  }
  function poolTasks(){
    if (state.filter.period === "month" && state.monthData) return (monthStats() || []).flatMap(r => r.all.map(t => ({ ...t, unit: r.u.id, unitName: r.u.name })));
    return levelTasks();
  }
  function filteredTasks(){
    const f = state.filter, q = f.q.trim().toLowerCase();
    return poolTasks().filter(t => (!f.unit || t.unit === f.unit)
      && (f.statuses.length ? f.statuses.includes(t.status || "") : (!f.status || (f.status === "none" ? !t.status : t.status === f.status)))
      && (!f.priority || t.priority === f.priority) && (!f.kind || (t.kind || "Task") === f.kind) && (!f.category || (t.category || "") === f.category) && (!f.dept || (t.dept || "") === f.dept)
      && (!q || `${t.ref || ""} ${t.title} ${t.dept || ""} ${t.owner} ${t.notes}`.toLowerCase().includes(q)));
  }
  const readHead = scope => `${th(scope,"unit","Unit")}${th(scope,"title","Task")}${th(scope,"dept","Department")}${th(scope,"owner","Owner (name)")}${th(scope,"due","Due")}${th(scope,"priority","Priority")}<th>Previous status</th>${th(scope,"status","Status")}${th(scope,"pct","Complete")}<th>Completed on</th><th>Depends on</th><th>Evidence</th><th>Notes</th><th>Updated by</th>`;
  const READ_COLS = 14;
  const evLinks = t => (t.ev || []).length ? (t.ev || []).map(e => `<button class="lnk ev-open" type="button" data-evp="${esc(e.path)}" data-evn="${esc(e.name)}" title="${esc(e.name)}">📎${(t.ev || []).length > 1 ? "" : " " + esc(e.name.length > 14 ? e.name.slice(0, 12) + "…" : e.name)}</button>`).join("") : '<span class="muted small">–</span>';
  const refChip = (t, unit) => t.ref ? `<button class="ref" type="button" data-open-task="${esc(unit)}|${esc(t.id)}" title="Open ${esc(t.ref)}">${esc(t.ref)}</button>` : "";
  const soon = d => { if (!d) return false; const n = (new Date(d + "T00:00:00") - new Date(todayIso + "T00:00:00")) / 864e5; return n >= 0 && n <= 3; };
  function readRow(t, sub){
    const late = t.due && t.due < todayIso && t.status !== "Done", lateDone = t.status === "Done" && t.due && t.completedAt && t.completedAt > t.due;
    return `<tr>
      <td class="small"><b>${esc(t.unitName)}</b></td>
      <td class="c-read-task${sub ? " sub" : ""}" title="${esc(t.title)}${t.outcome ? "\nExpected outcome: " + esc(t.outcome) : ""}">${t.priority === "High" ? '<span class="hi-dot" title="High priority"></span>' : ""}${sub ? "↳ " : ""}${refChip(t, t.unit)} ${esc(t.title)}${t.kidCount ? ` <button class="tag kid-tgl" type="button" data-kids="${esc(t.unit)}|${esc(t.ref)}">${state.expanded.has("kid:" + t.unit + "|" + t.ref) ? "▾" : "▸"} ${t.kidCount} tasks</button>` : ""}${t.kind === "KPI / OKR" ? ' <span class="tag">KPI / OKR</span>' : ""}${t.carried ? ` <span class="tag">carried${(t.carriedCount || 1) > 1 ? " " + t.carriedCount + " weeks" : ""}</span>` : ""}${t.outcome ? `<div class="small muted">Outcome: ${esc(t.outcome)}</div>` : ""}</td>
      <td class="small">${esc(t.dept || "")}</td><td class="small">${esc(t.owner)}</td>
      <td class="num small" style="color:${late ? "var(--bad)" : soon(t.due) && t.status !== "Done" ? "var(--warn)" : "inherit"}" ${late ? 'title="Overdue"' : soon(t.due) && t.status !== "Done" ? 'title="Due within 3 days"' : ""}>${esc(fmt(t.due))}</td>
      <td class="small">${t.priority ? esc(t.priority) : '<span class="muted">–</span>'}</td>
      <td>${t.prevStatus ? `<span class="pill ${statusClass(t.prevStatus)}">${esc(t.prevStatus)}</span>` : '<span class="muted small">–</span>'}</td>
      <td><span class="pill ${statusClass(t.status)}">${esc(t.status || "No status")}</span></td>
      <td>${typeof t.pct === "number" ? `<div class="prog"><div class="bar"><i style="width:${t.pct}%"></i></div><span class="num">${t.pct}%</span></div>` : '<span class="muted small">–</span>'}</td>
      <td class="num small" ${lateDone ? 'style="color:var(--warn)" title="Finished after the due date"' : ""}>${t.completedAt ? esc(fmt(t.completedAt)) : '<span class="muted">–</span>'}</td>
      <td class="small">${t.depUnit ? `<b>${esc(unitName(t.depUnit))}</b>` : ""}${t.dep ? `${t.depUnit ? "<br>" : ""}${esc(t.dep)}` : ""}${!t.depUnit && !t.dep ? '<span class="muted">–</span>' : ""}</td>
      <td class="small" style="white-space:nowrap">${evLinks(t)}</td>
      <td class="small muted">${esc(t.notes)}</td>
      <td class="small" style="white-space:nowrap">${t.lu ? `${esc(fmt(t.lu.slice(0, 10)))} ${t.lb ? `<span class="muted" data-person="${esc(t.lb)}"></span>` : `<span class="muted">data load</span>`}` : '<span class="muted">–</span>'}</td></tr>`;
  }
  // a deliverable row, followed by its tasks when expanded
  function readRows(t){
    let h = readRow(t);
    if (t.kidCount && state.expanded.has("kid:" + t.unit + "|" + t.ref)) h += ((state.plans[t.unit] && state.plans[t.unit].tasks) || []).filter(k => k.parent === t.ref).map(k => readRow({ ...k, unit: t.unit, unitName: t.unitName }, true)).join("");
    return h;
  }
  function filterChips(){
    const f = state.filter, c = [];
    if (f.period === "month") c.push(["period", `${ethName(state.eth)} · distinct tasks at latest status`]);
    if (f.unit) c.push(["unit", unitName(f.unit)]);
    if (f.statuses.length) c.push(["statuses", "Status: " + f.statuses.map(s => s || "No status").join(" / ")]);
    if (f.priority) c.push(["priority", "Priority: " + f.priority]);
    if (f.dept) c.push(["dept", "Department: " + f.dept]);
    return c;
  }
  // ---------- Actions for the CEO (Group Strategy, CEO and DCEO only) ----------
  state.ceoType = ""; state.ceoOpen = new Set(); state.ceoDraft = null; state.ceoSent = new Set();
  function ceoRows(){
    const month = state.filter.period === "month";
    if (month && !state.monthData) return null;
    const by = new Map(); poolTasks().forEach(t => { if (!by.has(t.unit)) by.set(t.unit, []); by.get(t.unit).push(t); });
    return sortedUnits().filter(u => !state.ceoType || u.type === state.ceoType).map(u => ({ id: u.id, a: assess({ name: u.name, type: u.type, tasks: leafTasks(by.get(u.id) || []), today: todayIso }) })).filter(r => r.a).sort((x, y) => x.a.score - y.a.score);
  }
  function renderCeo(){
    if (!canFeedback(me)) return `<div class="panel"><div class="empty"><b>Not available</b>This page is for Group Strategy, the CEO and the DCEO.</div></div>`;
    const month = state.filter.period === "month", per = month ? "month" : "week", perLabel = month ? ethName(state.eth) : weekLabel(state.week);
    const rows = ceoRows();
    const bar = `<div class="panel-head"><div><h2>Actions for the CEO</h2><div class="small muted">${esc(perLabel)} · ${month ? "monthly view: firmer actions" : "weekly view: check-ins"}</div></div>
      <div class="toolbar"><select id="fPeriod" aria-label="Period"><option value="week" ${!month ? "selected" : ""}>Week: ${esc(weekLabel(state.week))}</option><option value="month" ${month ? "selected" : ""}>Month: ${esc(ethName(state.eth))}</option></select>
      <div class="seg" role="tablist" aria-label="Unit type">${[["", "All"], ["Business unit", "Business units"], ["Corporate function", "Function units"]].map(([v, l]) => `<button type="button" role="tab" data-ceotype="${v}" aria-selected="${state.ceoType === v}">${l}</button>`).join("")}</div></div></div>`;
    if (!rows) return `<div class="panel">${bar}<div class="empty"><b>Collecting the weeks of ${esc(ETH_M[state.eth.m - 1])}…</b></div></div>`;
    if (!rows.length) return `<div class="panel">${bar}<div class="empty"><b>No tasks to assess</b>Nothing is planned for this selection yet.</div></div>`;
    const cnt = {}; rows.forEach(r => cnt[r.a.band.label] = (cnt[r.a.band.label] || 0) + 1);
    const chips = `<div class="toolbar small" style="padding:10px 16px;gap:14px;flex-wrap:wrap">${Object.entries(cnt).map(([k, v]) => `<span><b>${v}</b> ${esc(k)}</span>`).join("")}</div>`;
    const body = rows.map(r => {
      const a = r.a, acts = ceoActions(a, per), open = state.ceoOpen.has(r.id);
      const pill = `<span class="pill ${a.score >= 75 ? "s-done" : a.score >= 50 ? "s-prog" : "s-bad"}">${esc(a.band.label)} · ${a.score}%</span>`;
      return `<tr class="clickable" data-ceotgl="${esc(r.id)}" tabindex="0"><td><b>${open ? "▾" : "▸"} ${esc(a.name)}</b></td><td class="small">${a.isBU ? "Business unit" : "Function"}</td><td>${pill}</td><td class="small num">${a.isBU && a.finPct != null ? a.finPct + "%" : "–"}</td><td class="small">${esc(acts[0] ? acts[0].text : "")}${acts.length > 1 ? ` <span class="muted">+${acts.length - 1}</span>` : ""}</td></tr>`
        + (open ? `<tr class="ceo-open"><td colspan="5"><ol class="ceo-l">${acts.map((x, i) => ceoItem(r, x, i, per)).join("")}</ol></td></tr>` : "");
    }).join("");
    return `<div class="panel">${bar}${chips}<div class="scroll"><table><thead><tr><th>Unit</th><th>Type</th><th>Rating</th><th>Financial</th><th>First action</th></tr></thead><tbody>${body}</tbody></table></div></div>`;
  }
  const ceoCtx = per => ({ sender: me.name || "", senderTitle: roleText(me), perLabel: per === "month" ? ethName(state.eth) : weekLabel(state.week), period: per, today: todayIso });
  const ceoKey = (r, x) => `${r.id}|${state.filter.period}|${x.k}`;
  function ceoItem(r, x, i, per){
    const dr = state.ceoDraft && state.ceoDraft.key === ceoKey(r, x) ? state.ceoDraft : null, sent = state.ceoSent.has(ceoKey(r, x));
    let btn = "";
    if (sent) btn = `<span class="pill s-done">Done</span>`;
    else if (x.k === "none") btn = "";
    else if (INTERNAL.includes(x.k)) btn = isAppr() ? `<button class="btn small" type="button" data-ceoprep="${i}" data-u="${esc(r.id)}">Log follow-up</button>` : "";
    else btn = `<button class="btn small${dr ? "" : " primary"}" type="button" data-ceoprep="${i}" data-u="${esc(r.id)}">${dr ? "Close draft" : "Prepare letter"}</button>`;
    const box = dr ? `<div class="ceo-draft"><label class="small muted" for="ceoSub">Subject</label><input id="ceoSub" value="${esc(dr.subject)}"><label class="small muted" for="ceoBody">Letter</label><textarea id="ceoBody" rows="12">${esc(dr.body)}</textarea>
      ${dr.needsReply ? `<div class="toolbar" style="margin:8px 0"><label class="small" for="ceoDue">Written reply due</label><input type="date" id="ceoDue" value="${esc(dr.due)}"></div>` : ""}
      <div class="toolbar"><button class="btn small primary" type="button" data-ceodo="send" data-u="${esc(r.id)}" data-i="${i}">${dr.needsReply && isAppr() ? "Send and track the reply" : "Send to " + esc(r.a.name)}</button><button class="btn small" type="button" data-ceodo="cancel">Cancel</button></div>
      <div class="small muted">${dr.needsReply && isAppr() ? "It is sent to the unit as feedback and a corrective action is opened with the reply date." : "It is sent to the unit as feedback."}</div></div>` : "";
    return `<li><div class="ceo-line"><span>${esc(x.text)}</span>${btn}</div>${box}</li>`;
  }
  function ceoPrep(id, i){
    const rows = ceoRows(), r = rows && rows.find(y => y.id === id); if (!r) return;
    const per = state.filter.period === "month" ? "month" : "week", x = ceoActions(r.a, per)[i]; if (!x) return;
    const key = ceoKey(r, x);
    if (INTERNAL.includes(x.k)) { ceoSend(r, x, { subject: x.text, body: "", needsReply: false, due: "" }, true); return; }
    if (state.ceoDraft && state.ceoDraft.key === key) { state.ceoDraft = null; render(); return; }
    const l = ceoLetter(x, r.a, ceoCtx(per)); if (!l) return;
    state.ceoDraft = { key, ...l }; render();
  }
  async function ceoSend(r, x, l, internal){
    const per = state.filter.period === "month" ? "month" : "week", perLabel = ceoCtx(per).perLabel, key = ceoKey(r, x);
    try {
      let res;
      if (internal) res = await api.saveAction(auth(), { unit: r.id, source: "Group Strategy", issue: `${r.a.band.label} (${r.a.score}%) for ${perLabel}.`, action: x.text, owner: "", due: "", status: "Open", taskTitle: "", notes: "", week: state.week, taskRef: "" });
      else {
        res = await api.saveFeedback(auth(), { unit: r.id, from: isAppr() ? "Group Strategy" : (auth().title || "CEO"), week: state.week, body: `${l.subject}\n\n${l.body}`, taskRef: "", toLead: true });
        if (!(res && res.error) && l.needsReply && isAppr()) res = await api.saveAction(auth(), { unit: r.id, source: "Group Strategy", issue: l.subject, action: `Written reply required from the head of ${r.a.name}.`, owner: "", due: l.due || "", status: "Open", taskTitle: "", notes: "", week: state.week, taskRef: "" });
      }
      if (res && res.error) { toast(errText(res)); return; }
      state.ceoSent.add(key); state.ceoDraft = null;
      toast(internal ? "Logged for follow-up" : (l.needsReply && isAppr() ? "Sent to the head of " + r.a.name + ". Reply tracked." : "Sent to the head of " + r.a.name));
    } catch (e) { toast(errText(e)); }
    render();
  }
  function renderTasks(){
    const f = state.filter, month = f.period === "month";
    if (month && !state.monthData) return `<div class="panel"><div class="empty"><b>Collecting the weeks of ${esc(ETH_M[state.eth.m - 1])}…</b></div></div>`;
    const list = sortedBy(filteredTasks(), "tasks"), chips = filterChips();
    const depts = [...new Set(poolTasks().filter(t => !f.unit || t.unit === f.unit).map(t => t.dept || "").filter(Boolean))].sort();
    const scope = poolTasks().filter(t => (!f.unit || t.unit === f.unit) && (!f.dept || (t.dept || "") === f.dept)), sm = summarize({ tasks: scope });
    const scopeName = (f.unit ? unitName(f.unit) : "All units") + (f.dept ? " · " + f.dept : ""), perLabel = month ? ethName(state.eth) : weekLabel(state.week);
    const overall = `<div class="panel overall" style="margin-bottom:14px"><div class="panel-head"><div><h2>Overall progress</h2><div class="small muted">${esc(scopeName)} · ${esc(perLabel)}</div></div></div>
      <div style="padding:6px 16px 16px">${sm.total ? `${progressBar("Average completion across " + sm.total + " task" + (sm.total === 1 ? "" : "s"), sm.avg, "", true)}
      <div class="toolbar small" style="margin-top:10px;gap:14px;flex-wrap:wrap"><span><b>${sm.done}</b> done</span><span><b>${sm.total - sm.done - sm.blocked}</b> in progress or not started</span><span><b>${sm.blocked}</b> blocked</span><span><b>${sm.overdue}</b> overdue</span>${sm.high ? `<span><b>${sm.highDone}</b> of <b>${sm.high}</b> high-priority done</span>` : ""}</div>` : `<div class="muted small">No tasks for this selection yet.</div>`}</div></div>`;
    let body = "";
    if (f.group) {
      const byU = new Map(); list.forEach(t => { if (!byU.has(t.unit)) byU.set(t.unit, { name: t.unitName, d: new Map() }); const u = byU.get(t.unit), k = t.dept || ""; if (!u.d.has(k)) u.d.set(k, []); u.d.get(k).push(t); });
      byU.forEach((u, uid_) => {
        const n = [...u.d.values()].reduce((a, b) => a + b.length, 0);
        body += `<tr class="group-row"><td colspan="${READ_COLS}"><b>${esc(u.name)}</b> <span class="small muted">${n} task${n === 1 ? "" : "s"}</span></td></tr>`;
        const keys = [...u.d.keys()].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b)), flat = keys.length === 1 && keys[0] === "";
        keys.forEach(k => {
          const key = uid_ + "|" + k, open = flat || state.expanded.has(key), ts = u.d.get(k);
          if (!flat) body += `<tr class="clickable" data-tgl="${esc(key)}" tabindex="0"><td colspan="${READ_COLS}"><b>${open ? "▾" : "▸"} ${esc(k || "(no department)")}</b> <span class="small muted">${ts.length}</span></td></tr>`;
          if (open) body += ts.map(readRows).join("");
        });
      });
    } else body = list.map(readRows).join("");
    return `${overall}<div class="panel">
      ${f.from === "monthly" ? `<div class="toolbar" style="padding:12px 16px;border-bottom:1px solid var(--line)"><button class="btn" id="backMonthly">‹ Back to monthly report</button><span class="small muted">Showing the tasks behind the number you selected.</span></div>` : ""}
      ${chips.length ? `<div class="chipset" style="padding:12px 16px;border-bottom:1px solid var(--line)">${chips.map(([k, l]) => `<span class="chip">${esc(l)}<button data-chip="${k}" aria-label="Remove filter">×</button></span>`).join("")}</div>` : ""}
      <div class="panel-head">
        <div class="toolbar">
          <select id="fPeriod" aria-label="Period"><option value="week" ${!month ? "selected" : ""}>Week: ${esc(weekLabel(state.week))}</option><option value="month" ${month ? "selected" : ""}>Month: ${esc(ethName(state.eth))}</option></select>
          <select id="fUnit" aria-label="Filter by unit"><option value="">All units</option>${sortedUnits().map(u => `<option value="${esc(u.id)}" ${f.unit === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>
          <select id="fDept" aria-label="Filter by department"><option value="">All departments</option>${depts.map(d => `<option ${f.dept === d ? "selected" : ""}>${esc(d)}</option>`).join("")}</select>
          <select id="fStatus" aria-label="Filter by status"><option value="">All statuses</option>${f.statuses.length ? `<option value="__multi__" selected>Selected statuses</option>` : ""}${STATUSES.map(s => `<option ${!f.statuses.length && f.status === s ? "selected" : ""}>${s}</option>`).join("")}<option value="none" ${!f.statuses.length && f.status === "none" ? "selected" : ""}>No status</option></select>
          <select id="fPri" aria-label="Filter by priority"><option value="">All priorities</option>${PRIORITIES.map(p => `<option ${f.priority === p ? "selected" : ""}>${p}</option>`).join("")}</select>
          <select id="fKind" aria-label="Filter by type"><option value="">Tasks and KPI lines</option>${KINDS.map(k => `<option ${f.kind === k ? "selected" : ""}>${k}</option>`).join("")}</select>
          <select id="fCat" aria-label="Filter by category"><option value="">All categories</option>${CATEGORIES.map(k => `<option ${f.category === k ? "selected" : ""}>${k}</option>`).join("")}</select>
          ${month ? "" : `<select id="fLevel" aria-label="Show"><option value="deliverables" ${state.level === "deliverables" ? "selected" : ""}>Deliverables</option><option value="tasks" ${state.level === "tasks" ? "selected" : ""}>All tasks</option></select>`}
          <input type="text" id="fQ" placeholder="Search by reference, task, department or owner" value="${esc(f.q)}" aria-label="Search">
          <label class="small"><input type="checkbox" id="fGroup" ${f.group ? "checked" : ""}> Group by department</label>
        </div>
        <div class="toolbar"><span class="small muted">${list.length} tasks</span><button class="btn" id="printBtn" type="button">Print</button>${downloads ? `<button class="btn" id="tasksPdfBtn">PDF</button><button class="btn" id="tasksXlsxBtn">Excel</button><button class="btn" id="exportBtn">CSV</button>` : ""}</div>
      </div>
      ${list.length ? `<div class="scroll"><table><thead><tr>${readHead("tasks")}</tr></thead><tbody>${body}</tbody></table></div>` : `<div class="empty"><b>No tasks match</b>Change the filters, or pick another period.</div>`}
    </div>`;
  }

  // ---------- monthly consolidation (Ethiopian calendar) ----------
  function monthWeeks(e, basis){
    const { start, end } = ethMonthRange(e), res = []; let w = prevWeekOf(weekStartOf(start));
    for (let i = 0; i < 10; i++) { const x = toEth(basis === "end" ? weekEndOf(w) : w); if (x.y === e.y && x.m === e.m) res.push(w); w = nextWeekOf(w); if (w > addDays(end, 7)) break; }
    return res;
  }
  async function loadMonth(){
    if (!db) return;
    const key = `${state.eth.y}-${state.eth.m}${state.monthBasis}`, weeks = monthWeeks(state.eth, state.monthBasis);
    state.monthKey = key; state.monthLoading = true; state.monthData = null; render();
    const data = {};
    for (const w of weeks) {
      try { const snap = await db.collection("plans").where("week", "==", w).get(); data[w] = {}; snap.docs.forEach(d => { const v = d.data(); if (v && v.unit) data[w][v.unit] = v; }); }
      catch (e) { data[w] = {}; }
    }
    if (state.monthKey !== key) return;
    state.monthData = { weeks, data }; state.monthLoading = false; render();
  }
  function shiftMonth(d){ let m = state.eth.m + d, y = state.eth.y; if (m > 13) { m = 1; y++; } if (m < 1) { m = 13; y--; } state.eth = { y, m }; loadMonth(); }
  const progressBar = (label, pct, sub, hero) => `<div class="pbar${hero ? " hero" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct ?? 0}" aria-label="${esc(label)}"><div class="pbar-top"><b>${esc(label)}</b><span class="num">${pct === null ? "–" : pct + "%"}</span></div><div class="pbar-track"><i style="width:${pct ?? 0}%"></i></div><div class="pbar-sub small">${esc(sub || "")}</div></div>`;
  const avgOf = arr => { const n = arr.map(x => x.status === "Done" ? 100 : (typeof x.pct === "number" ? x.pct : 0)); return n.length ? Math.round(n.reduce((a, b) => a + b, 0) / n.length) : null; };
  function monthStats(){
    const md = state.monthData; if (!md) return null;
    return sortedUnits().map(u => {
      const uniq = new Map(), uniqAll = new Map(); let entries = 0, kpi = 0, reported = 0; const texts = [];
      md.weeks.forEach(w => {
        const p = md.data[w] && md.data[w][u.id]; if (!p) return;
        const rt = realTasks(p); kpi += kpiTasks(p).length; entries += rt.length;
        if (rt.length || kpiTasks(p).length || p.wins || p.blockers || p.asks) reported++;
        rt.forEach(t => uniq.set(norm(t.title) + "|" + norm(t.dept), { ...t, week: w }));
        (p.tasks || []).forEach(t => uniqAll.set((t.kind === "KPI / OKR" ? "k" : "t") + "|" + norm(t.title) + "|" + norm(t.dept), { ...t, week: w }));
        if (p.wins || p.blockers || p.asks) texts.push({ week: w, wins: p.wins || "", blockers: p.blockers || "", asks: p.asks || "", by: p.updatedBy || "" });
      });
      const tasks = [...uniq.values()];
      const mk = ts => ({ total: ts.length, done: ts.filter(t => t.status === "Done").length, prog: ts.filter(t => t.status === "In progress").length, blocked: ts.filter(t => t.status === "Blocked").length, delayed: ts.filter(t => t.status === "Delayed").length, notStarted: ts.filter(t => t.status === "Not started").length, noStatus: ts.filter(t => !t.status).length, high: ts.filter(t => t.priority === "High").length, highDone: ts.filter(t => t.priority === "High" && t.status === "Done").length, avg: avgOf(ts) });
      const byDept = {}; tasks.forEach(t => { const k = t.dept || "(no department)"; (byDept[k] = byDept[k] || []).push(t); });
      return { u, tasks, all: [...uniqAll.values()], entries, kpi, reported, texts, s: mk(tasks), dept: Object.entries(byDept).map(([d, ts]) => ({ d, s: mk(ts) })).sort((a, b) => a.d.localeCompare(b.d)) };
    });
  }
  function renderMonthly(){
    const e = state.eth, rng = ethMonthRange(e);
    const head = `<div class="panel-head"><div class="toolbar"><h2>${esc(ethName(e))}</h2><span class="muted small">${esc(fmt(rng.start))} – ${esc(fmt(rng.end))} ${parse(rng.end).getFullYear()}</span>
      <label class="small muted" for="mBasis">A week counts in the month it</label><select id="mBasis"><option value="end" ${state.monthBasis === "end" ? "selected" : ""}>ends in (last day)</option><option value="start" ${state.monthBasis === "start" ? "selected" : ""}>starts in (first day)</option></select></div>
      <div class="toolbar"><label class="small"><input type="checkbox" id="mDept" ${state.monthByDept ? "checked" : ""}> Show departments</label><button class="btn" id="mRefresh">Refresh</button>${downloads && state.monthData ? `<button class="btn primary" id="mPdf">Monthly report (PDF)</button><button class="btn" id="mXlsx">Excel</button>` : ""}</div></div>`;
    if (!db) return `<div class="panel">${head}<div class="empty"><b>No data</b>The shared store is not available in this view.</div></div>`;
    if (state.monthLoading || !state.monthData) return `<div class="panel">${head}<div class="empty"><b>Collecting the weeks of ${esc(ETH_M[e.m - 1])}…</b></div></div>`;
    const st = monthStats(), md = state.monthData;
    const tot = st.reduce((a, r) => { const s = r.s; return { uniq: a.uniq + s.total, done: a.done + s.done, prog: a.prog + s.prog, ns: a.ns + s.notStarted + s.noStatus, blk: a.blk + s.blocked + s.delayed, entries: a.entries + r.entries, rep: a.rep + (r.reported ? 1 : 0), high: a.high + s.high, highDone: a.highDone + s.highDone }; }, { uniq: 0, done: 0, prog: 0, ns: 0, blk: 0, entries: 0, rep: 0, high: 0, highDone: 0 });
    const gAvg = avgOf(st.flatMap(r => r.tasks));
    const wk = md.weeks.map(w => `${ethRange(w, weekEndOf(w)).replace(/, \d+ EC$/, "")}`).join(" · ");
    const stats = `<div class="stats">
      <div class="stat"><div class="v">${md.weeks.length}</div><div class="k">weeks: ${esc(wk) || "none"}</div></div>
      <div class="stat"><div class="v">${tot.rep} of ${st.length}</div><div class="k">units reported in the month</div></div>
      <div class="stat"><div class="v">${tot.uniq}</div><div class="k">distinct tasks (${tot.entries} weekly entries)</div></div>
      <div class="stat"><div class="v">${tot.uniq ? Math.round(tot.done / tot.uniq * 100) : 0}%</div><div class="k">done at latest status (${tot.done})</div></div>
      <div class="stat"><div class="v">${gAvg === null ? "–" : gAvg + "%"}</div><div class="k">average % complete</div></div>
      <div class="stat"><div class="v accent">${tot.highDone} of ${tot.high}</div><div class="k">High-priority done</div></div></div>`;
    const lk = (u, key, n) => n ? `<button class="lnk" data-drill="${esc(u)}|${key}" title="Show these tasks">${n}</button>` : `<span class="num muted">0</span>`;
    const line = (label, s, sub, uId, rep, kpi) => `<tr${sub ? ' class="sub"' : ""}><td>${sub ? `<span class="muted">↳ </span>${esc(label)}` : `<button class="lnk unit-name" data-drill="${esc(uId)}|all">${esc(label)}</button>${uId ? `<br><span class="tag">${esc((state.units.find(x => x.id === uId) || {}).type || "")}</span>` : ""}`}</td><td class="num">${sub ? "" : rep}</td>
      <td class="num">${sub ? s.total : lk(uId, "all", s.total)}${!sub && kpi ? `<div class="muted small">+${kpi} KPI lines</div>` : ""}</td><td class="num">${sub ? s.done : lk(uId, "done", s.done)}</td><td class="num">${sub ? s.prog : lk(uId, "prog", s.prog)}</td><td class="num">${sub ? s.notStarted + s.noStatus : lk(uId, "ns", s.notStarted + s.noStatus)}</td><td class="num" style="color:${s.blocked + s.delayed ? "var(--bad)" : "inherit"}">${sub ? s.blocked + s.delayed : lk(uId, "blk", s.blocked + s.delayed)}</td><td class="num">${sub ? `${s.highDone}/${s.high}` : (s.high ? `<button class="lnk" data-drill="${esc(uId)}|high" title="Show completed high-priority tasks">${s.highDone}/${s.high}</button>` : "0/0")}</td>
      <td>${s.avg === null ? '<span class="muted small">–</span>' : `<div class="prog"><div class="bar"><i style="width:${s.avg}%"></i></div><span class="num">${s.avg}%</span></div>`}</td></tr>`;
    const rows = st.map(r => line(r.u.name, r.s, false, r.u.id, `${r.reported} / ${md.weeks.length}`, r.kpi) + (state.monthByDept ? r.dept.filter(x => r.dept.length > 1 || x.d !== "(no department)").map(x => line(x.d, x.s, true, r.u.id)).join("") : "")).join("");
    const totS = { total: tot.uniq, done: tot.done, prog: tot.prog, notStarted: tot.ns, noStatus: 0, blocked: tot.blk, delayed: 0, high: tot.high, highDone: tot.highDone, avg: gAvg };
    const reports = st.filter(r => r.texts.length).map(r => `<details class="rep"><summary><b>${esc(r.u.name)}</b> <span class="muted small">${r.texts.length} weekly report${r.texts.length > 1 ? "s" : ""}</span></summary>${r.texts.map(t => `<div class="ask"><div class="who">${esc(weekLabel(t.week))} · ${esc(ethWeekLabel(t.week))}${t.by ? ` · <span data-person="${esc(t.by)}" data-bare></span>` : ""}</div>${t.wins ? `<p><b>Key results:</b> ${esc(t.wins)}</p>` : ""}${t.blockers ? `<p><b>Blockers:</b> ${esc(t.blockers)}</p>` : ""}${t.asks ? `<p><b>Asks:</b> ${esc(t.asks)}</p>` : ""}</div>`).join("")}</details>`).join("");
    return `${stats}<div class="panel" style="margin-bottom:16px">${head}
      <div class="scroll"><table><thead><tr><th>Unit</th><th>Weeks reported</th><th>Distinct tasks</th><th>Done</th><th>In progress</th><th>Not started / no status</th><th>Blocked / delayed</th><th>High done</th><th>Avg. complete</th></tr></thead><tbody>${rows}${line("All units", totS, false, "", `${tot.rep} / ${st.length} units`, 0)}</tbody></table></div>
      <div class="small muted" style="padding:10px 16px">Select any number to open the tasks behind it. A task that appears in several weeks counts once, at its latest status. KPI / OKR lines are listed separately and are not counted as tasks.</div></div>
    <div class="panel"><div class="panel-head"><h2>Weekly reports in the month</h2><span class="muted small">Key results, blockers and asks, in week order</span></div><div class="asks">${reports || `<div class="empty" style="padding:20px 0"><b>No weekly reports entered</b>Units add key results, blockers and asks when they update a plan.</div>`}</div></div>`;
  }
  const monthFile = () => `${ETH_M[state.eth.m - 1]} ${state.eth.y}`;
  async function exportMonthXlsx(){
    if (!libsReady("xlsx") || !state.monthData) return;
    const st = monthStats(), md = state.monthData, label = ethName(state.eth);
    const wb = XLSX.utils.book_new();
    const sumRow = (name, type, rep, s, kpi) => [name, type, rep, s.total, s.done, s.prog, s.notStarted + s.noStatus, s.blocked, s.delayed, s.high, s.highDone, s.avg === null ? "" : s.avg / 100, kpi];
    const sh = ["Unit","Type","Weeks reported","Distinct tasks","Done","In progress","Not started / no status","Blocked","Delayed","High priority","High done","Average complete","KPI / OKR lines"];
    const ws = sheetFromRows([[`Wagwago Business Group · Monthly report · ${label}`], [`Weeks: ${md.weeks.map(w => weekLabel(w) + " (" + ethWeekLabel(w) + ")").join(" · ")}`], [], sh, ...st.map(r => sumRow(r.u.name, r.u.type || "", `${r.reported} of ${md.weeks.length}`, r.s, r.kpi))], [34,18,14,13,8,12,18,9,9,12,11,15,14]); pctFormat(ws, 11, 4);
    XLSX.utils.book_append_sheet(wb, ws, "Summary");
    const dr = []; st.forEach(r => r.dept.forEach(x => dr.push(sumRow(r.u.name, x.d, "", x.s, ""))));
    const wd = sheetFromRows([["Unit","Department", ...sh.slice(2)], ...dr.map(a => [a[0], a[1], ...a.slice(2)])], [34,26,14,13,8,12,18,9,9,12,11,15,14]); pctFormat(wd, 12, 1);
    XLSX.utils.book_append_sheet(wb, wd, "By department");
    const tk = []; st.forEach(r => r.tasks.forEach(t => tk.push([r.u.name, t.dept || "", t.title || "", t.owner || "", t.due || "", t.priority || "", t.status || "No status", typeof t.pct === "number" ? t.pct / 100 : "", fmt(t.week), t.notes || ""])));
    const wt = sheetFromRows([["Unit","Department","Task / deliverable","Owner","Due","Priority","Latest status","% complete","Latest week","Notes"], ...tk], [30,22,60,22,12,10,13,11,12,50]); pctFormat(wt, 7, 1);
    XLSX.utils.book_append_sheet(wb, wt, "Distinct tasks");
    const rp = []; st.forEach(r => r.texts.forEach(t => rp.push([r.u.name, weekLabel(t.week) + " (" + ethWeekLabel(t.week) + ")", t.wins, t.blockers, t.asks])));
    XLSX.utils.book_append_sheet(wb, sheetFromRows([["Unit","Week","Key results","Blockers","Asks"], ...rp], [30,34,60,50,50]), "Weekly reports");
    await writeXlsx(wb, `Wagwago monthly report ${monthFile()}.xlsx`, "Monthly workbook saved");
  }
  async function exportMonthPdf(){
    if (!libsReady("pdf") || !state.monthData) return;
    const st = monthStats(), md = state.monthData, label = ethName(state.eth);
    const doc = newPdf(`Monthly Report · ${label}`, `Weeks: ${md.weeks.map(w => fmt(w) + " (" + ethWeekLabel(w).replace(/, \d+ EC$/, "") + ")").join(", ")}  ·  Generated ${fmt(todayIso)} ${new Date().getFullYear()}`);
    doc.autoTable({ startY: 92, margin: { left: 36, right: 36 }, head: [["Unit","Weeks reported","Distinct tasks","Done","In progress","Not started / no status","Blocked / delayed","High done","Avg. complete"]],
      body: st.map(r => [r.u.name, `${r.reported} of ${md.weeks.length}`, r.s.total, r.s.done, r.s.prog, r.s.notStarted + r.s.noStatus, r.s.blocked + r.s.delayed, `${r.s.highDone}/${r.s.high}`, r.s.avg === null ? "–" : r.s.avg + "%"]), columnStyles: { 0: { cellWidth: 150, fontStyle: "bold" } }, ...tableStyle() });
    let y0 = doc.lastAutoTable.finalY + 24; y0 = sectionTitle(doc, "Weekly reports: key results, blockers and asks", y0);
    const body = []; st.forEach(r => r.texts.forEach(t => body.push([r.u.name, fmt(t.week), t.wins || "–", t.blockers || "–", t.asks || "–"])));
    doc.autoTable({ startY: y0, margin: { left: 36, right: 36 }, head: [["Unit","Week","Key results","Blockers","Asks"]], body: body.length ? body : [["No weekly reports entered","","","",""]], columnStyles: { 0: { cellWidth: 110, fontStyle: "bold" }, 1: { cellWidth: 44 } }, ...tableStyle() });
    const n = doc.getNumberOfPages(), H = doc.internal.pageSize.getHeight();
    for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(...Y.muted); doc.text(`Monthly report · ${label} · Page ${i} of ${n}`, 36, H - 18); }
    await save(`Wagwago monthly report ${monthFile()}.pdf`, doc.output("arraybuffer"), "Monthly report saved. Open it to print.");
  }

  // ---------- import: what will happen to existing data ----------
  async function computeImpact(){
    const imp = state.imp; if (!imp || !imp.rows || !db) return;
    const groups = new Map(); imp.rows.filter(r => !r.err.length).forEach(r => { const k = r.week + "|" + r.unit.id; if (!groups.has(k)) groups.set(k, { week: r.week, unit: r.unit, rows: [] }); groups.get(k).rows.push(r); });
    let upd = 0, add = 0, keep = 0, rem = 0;
    for (const g of groups.values()) {
      let existing = []; try { const s = await db.doc(`plans/${planId(g.week, g.unit.id)}`).get(); existing = s.exists ? (s.data().tasks || []) : []; } catch (e) {}
      const keys = new Set(existing.map(t => norm(t.title))), seen = new Set();
      g.rows.forEach(r => { const k = norm(r.row.title); if (keys.has(k)) { upd++; seen.add(k); } else add++; });
      keep += existing.filter(t => !seen.has(norm(t.title))).length; rem += existing.length;
    }
    if (state.imp === imp) { imp.impact = { upd, add, keep, rem, n: imp.rows.filter(r => !r.err.length).length }; render(); }
  }

  // ---------- rendering ----------
  let bannerMsg = "";
  function banner(m){ bannerMsg = m; render(); }

  function unitName(id){ const u = state.units.find(x => x.id===id); return u ? u.name : id; }
  // the CEO and D/CEO offices do not record plans or progress, so they are not tracked or expected to report
  const NO_PLAN_UNITS = ["ceo", "d-ceo"];
  function sortedUnits(){ return [...state.units].sort((a,b) => (a.type||"").localeCompare(b.type||"") || (a.order??99)-(b.order??99) || a.name.localeCompare(b.name)); }

  const GROUPS = { dashboard: ["dashboard"], plans: ["update", "plan", "mplan", "approvals"], delivery: ["support", "fb"], reports: ["tasks", "monthly", "ceo"] };
  const SUB_LABEL = { update: "Progress update", plan: "Next plan", mplan: "Monthly plan", approvals: "Approvals", support: "Business support", fb: "Feedback", tasks: "Weekly report", monthly: "Monthly report", ceo: "Actions for the CEO" };
  const PAGE_TITLE = { dashboard: ["Dashboards", "How every unit and function is doing this week."], update: ["Plans", "Update progress on this week's tasks."], plan: ["Plans", "Plan the tasks for next week."], mplan: ["Plans", "Plan the month once and split it across its weeks."], approvals: ["Plans", "Changes waiting for approval."], support: ["Delivery", "Support requested from group functions."], fb: ["Delivery", "Feedback and corrective actions."], tasks: ["Reports", "Every task, filtered and downloadable."], monthly: ["Reports", "Consolidated by Ethiopian calendar month."], ceo: ["Reports", "What the CEO should do about each unit."], follow: ["Follow-up", ""], activity: ["Activity log", "Who changed what, and when."], units: ["Settings · Units", "Group Strategy only."], people: ["Settings · People", "Group Strategy only."] };
  const groupOf = t => Object.keys(GROUPS).find(g => GROUPS[g].includes(t)) || "";
  const SM = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const weekShort = w => { const a = parse(w), b = parse(weekEndOf(w)); return a.getMonth() === b.getMonth() ? `${SM[a.getMonth()]} ${a.getDate()} – ${b.getDate()}` : `${SM[a.getMonth()]} ${a.getDate()} – ${SM[b.getMonth()]} ${b.getDate()}`; };
  function renderHero(){
    $("#weekLabel").textContent = wkTag(state.week) + " · " + weekShort(state.week);
    const units = state.units.length;
    const submitted = state.units.filter(u => (state.plans[u.id]?.tasks||[]).length).length;
    const all = Object.values(state.plans).flatMap(p => realTasks(p));
    const done = all.filter(t => t.status==="Done").length;
    $("#heroChips").innerHTML = false ? `
      <span class="hero-chip"><b>${submitted}/${units}</b> units submitted</span>
      <span class="hero-chip"><b>${all.length}</b> tasks planned</span>
      <span class="hero-chip"><b>${done}</b> done</span>` : "";
    const hp = $("#heroProg");
    if (hp) { const pool = Object.values(state.plans).flatMap(p => realTasks(p)); hp.hidden = true;
      if (!hp.hidden) hp.innerHTML = progressBar(`Overall progress of the week's plan`, avgOf(pool), `${done} of ${all.length} tasks done · every task counts, no status or % counts as 0`, true); }
    const mo = state.tab === "monthly";
    const pt = PAGE_TITLE[state.tab] || ["Weekly Activity Tracking", ""]; $("#heroTitle").textContent = pt[0]; $("#heroSub").textContent = pt[1];
    document.body.dataset.tab = state.tab;
    if (mo) { const r = ethMonthRange(state.eth); $("#weekLabel").textContent = ethName(state.eth); $("#weekSub").textContent = `${fmt(r.start)} – ${fmt(r.end)} ${parse(r.end).getFullYear()}`; }
    else $("#weekSub").textContent = (state.week === thisMonday() ? "This week · " : state.week === nextMonday() ? "Next week · " : "") + ethWeekLabel(state.week);
    $("#thisWeek").textContent = mo ? "This month" : "This week";
    $("#prevWeek").setAttribute("aria-label", mo ? "Previous month" : "Previous week"); $("#nextWeek").setAttribute("aria-label", mo ? "Next month" : "Next week");
    document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab===state.tab)));
    $("#unitsTabBtn").hidden = !isAppr(); $("#peopleTabBtn").hidden = !isAppr();
    renderNav();
    const nb = X.badgeCount(), fbb = $("#fbCount"); if (fbb) { fbb.textContent = nb; fbb.hidden = !nb; }
    const np = canDecideAny() ? toDecide().length : pendingFor().length, ab = $("#apprCount"); const nm = (state.mentions || []).length, nr = (state.rr ? state.rr.count + state.rr.access : 0) + unreadMsgs().length, bb = $("#bellBtn"); if (ab) { ab.textContent = np + nm + nr > 9 ? "9+" : np + nm + nr; ab.hidden = !(np + nm + nr); } if (bb) { bb.classList.toggle("has", !!(np + nm + nr)); bb.title = np + nm + nr ? [nm ? nm + " mention" + (nm === 1 ? "" : "s") : "", np ? np + (canDecideAny() ? " waiting for your approval" : " waiting for approval") : "", nr ? nr + " other update" + (nr === 1 ? "" : "s") : ""].filter(Boolean).join(" · ") : "Notifications"; bb.setAttribute("aria-label", "Notifications: " + bb.title); }
    $("#whoBtn").textContent = me ? ((me.name || me.email || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?") : "?"; $("#whoBtn").title = me ? me.name : "Sign in";
    $("#modeChip").hidden = dataMode !== "local";
  }

  function renderOverview(merged){
    if (!state.units.length) return `<div class="panel"><div class="empty"><b>No units set up yet</b>${isAppr() ? "Open the Units tab to add the functions and business units that report weekly." : "The Strategy Office has not added the reporting units yet."}</div></div>`;
    const rows = sortedUnits().map(u => ({ u, p: state.plans[u.id], s: summarize(state.plans[u.id]) }));
    const tot = rows.reduce((a,r) => ({ total: a.total+r.s.total, done: a.done+r.s.done, blocked: a.blocked+r.s.blocked, high: a.high+r.s.high, highDone: a.highDone+r.s.highDone, overdue: a.overdue+r.s.overdue }), { total:0, done:0, blocked:0, high:0, highDone:0, overdue:0 });
    const submitted = rows.filter(r => r.s.total || r.s.kpi).length;
    const groupAvg = avgOf(rows.flatMap(r => realTasks(r.p)));
    const stats = `<div class="stats">
      <div class="stat"><div class="v">${submitted} of ${rows.length}</div><div class="k">units submitted a plan</div></div>
      <div class="stat"><div class="v">${tot.total}</div><div class="k">tasks planned this week</div></div>
      <div class="stat"><div class="v">${tot.total ? Math.round(tot.done/tot.total*100) : 0}%</div><div class="k">tasks done (${tot.done})</div></div>
      <div class="stat"><div class="v">${groupAvg===null?"–":groupAvg+"%"}</div><div class="k">average % complete</div></div>
      <div class="stat"><div class="v accent">${tot.highDone} of ${tot.high}</div><div class="k">High-priority tasks done</div></div>
      <div class="stat"><div class="v accent">${tot.blocked + tot.overdue}</div><div class="k">blocked or overdue</div></div>
    </div>`;
    const tr = rows.map(({u,p,s}) => {
      const state_ = !s.total && s.kpi ? `<span class="pill s-none">KPI lines only</span>` : !s.total ? `<span class="pill s-bad">No plan</span>` : s.noStatus===s.total ? `<span class="pill s-not">No status</span>` : `<span class="pill s-done">Submitted</span>`;
      const prog = s.avg===null ? `<span class="muted small">–</span>` : `<div class="prog"><div class="bar"><i style="width:${s.avg}%"></i></div><span class="num">${s.avg}%</span></div>`;
      const upd = p && p.updatedAt ? `${fmt(p.updatedAt.slice(0,10))} ${p.updatedBy ? `<span class="muted" data-person="${esc(p.updatedBy)}"></span>` : `<span class="muted">data load</span>`}` : `<span class="muted">–</span>`;
      return `<tr class="clickable" data-open-unit="${esc(u.id)}" tabindex="0">
        <td><div class="unit-name">${esc(u.name)}</div><span class="tag">${esc(u.type||"")}</span></td>
        <td>${state_}</td>
        <td class="num">${s.total}${s.kpi ? `<div class="muted small">+${s.kpi} KPI</div>` : ""}</td>
        <td class="num">${s.done}</td>
        <td class="num">${s.high}</td>
        <td class="num" style="color:${s.blocked+s.overdue?"var(--bad)":"inherit"}">${s.blocked}${s.overdue?` / ${s.overdue}`:""}</td>
        <td>${prog}</td>
        <td class="small">${upd}</td>
      </tr>`;
    }).join("");
    const asks = rows.filter(r => r.p && (r.p.asks||r.p.blockers)).map(({u,p}) => `
      <div class="ask"><div class="who">${esc(u.name)}</div>
      ${p.blockers ? `<p><b>Blockers:</b> ${esc(p.blockers)}</p>` : ""}
      ${p.asks ? `<p><b>Asks:</b> ${esc(p.asks)}</p>` : ""}</div>`).join("");
    return `${merged ? "" : stats}
    <div class="grid2" style="${merged ? "margin-top:16px;grid-template-columns:minmax(0,1fr)" : ""}">
      <div class="panel">
        <div class="panel-head"><h2>Units this week</h2><div class="toolbar"><span class="muted small">Select a unit to open its plan</span>${downloads ? `${merged ? "" : `<button class="btn primary" id="pdfBtn">Performance report (PDF)</button>`}<button class="btn" id="xlsxAllBtn">All plans (Excel)</button>` : ""}</div></div>
        <div class="scroll"><table>
          <thead><tr><th>Unit</th><th>Plan</th><th>Tasks</th><th>Done</th><th>High</th><th>Blocked / overdue</th><th>Avg. complete</th><th>Last update</th></tr></thead>
          <tbody>${tr}</tbody></table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Blockers and asks</h2></div>
        <div class="asks">${asks || `<div class="empty" style="padding:20px 0"><b>Nothing raised yet</b>Blockers and asks that units enter with their plans appear here.</div>`}</div>
      </div>
    </div>`;
  }

  const unitOf = id => state.units.find(u => u.id === id) || {};
  function deptOptions(u, t){
    const list = [...(unitOf(u).departments || [])];
    if (t.dept && !list.includes(t.dept)) list.unshift(t.dept);
    return `<option value="">${list.length ? "Choose department" : "No department"}</option>` + (isAppr() || isLenient() ? list : list.filter(d => d === t.dept || (me.departments || []).includes(d))).map(d => `<option ${d===t.dept?"selected":""}>${esc(d)}</option>`).join("") + (mayDepts(u) ? `<option value="__new__">＋ Add a department…</option>` : "");
  }
  // A saved task in a week that has started keeps its definition; the unit can ask to change it.
  const savedTask = (u, t) => !!((state.base[u] && state.base[u].tasks) || []).some(x => x.id === t.id);
  const isLocked = (u, t) => !isAppr() && !isLenient() && savedTask(u, t) && state.week <= thisMonday() && !state.unlock.has(t.id);
  const pendingTask = (u, id) => pendingFor(u, state.week).some(r => (r.patch || []).some(o => o.id === id));
  const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  const sel = (on) => on ? "selected" : "";
  const hasTgt = t => t.target !== "" && t.target != null && isFinite(Number(t.target));
  const tgtHtml = (t, dis) => `<div class="tgt small muted"><label>Target <input type="number" step="any" id="t-tg-${t.id}" data-f="target" value="${t.target ?? ""}" placeholder="–" aria-label="Target" ${dis}></label><input type="text" id="t-ms-${t.id}" data-f="measure" value="${esc(t.measure || "")}" placeholder="unit (ETB, %, units)" aria-label="Target unit" maxlength="20" ${dis}><label><input type="checkbox" id="t-lw-${t.id}" data-f="lower" ${t.lower ? "checked" : ""} ${dis}> lower is better</label></div>`;
  // ---------- Plans page: icons, due-date wording, lean task rows ----------
  const ico = d => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const IC = {
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>', plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', open: '<path d="M14 4h6v6M20 4l-9 9M10 6H5v13h13v-5"/>',
    down: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>', clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.5 3-6 6-6s6 2.5 6 6M16 5a3 3 0 010 6M18 14c2 .8 3 3 3 6"/>',
    fwd: '<path d="M4 12h14M13 6l6 6-6 6"/>', more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>', note: '<path d="M5 4h14v12l-4 4H5zM15 20v-4h4"/>',
    clip: '<path d="M20 11l-8 8a5 5 0 01-7-7l9-9a3.5 3.5 0 015 5l-9 9a2 2 0 01-3-3l8-8"/>', pen: '<path d="M4 20l1-4L16 5l3 3L8 19zM14 7l3 3"/>',
    link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>', filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
    save: '<path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6"/>'
  };
  const catLabel = k => k === "Revenue" ? "Financial" : (k || "Operational");
  const dueInfo = t => {
    if (!t.due) return { txt: "No date", cls: "mut", sub: "" };
    const n = Math.round((Date.parse(t.due) - Date.parse(todayIso)) / 864e5);
    if (t.status === "Done") return { txt: fmt(t.due), cls: "mut", sub: "" };
    if (n < 0) return { txt: `${-n} day${n === -1 ? "" : "s"} overdue`, cls: "late", sub: fmt(t.due) };
    if (n === 0) return { txt: "Today", cls: "soon", sub: fmt(t.due) };
    if (n === 1) return { txt: "Tomorrow", cls: "soon", sub: fmt(t.due) };
    if (n <= 7) return { txt: `In ${n} days`, cls: n <= 2 ? "soon" : "", sub: fmt(t.due) };
    return { txt: fmt(t.due), cls: "", sub: "" };
  };
  const priPill = p => p ? `<span class="pill ${p === "High" ? "s-bad" : p === "Medium" ? "s-not" : "s-none"}">${esc(p)}</span>` : '<span class="muted">–</span>';
  function taskRowHtml(u, t, i, ind = 0){
    if (state.tab === "plan") return planRowHtml(u, t, i);
    if (pf().kind === "fin") return finRowHtml(u, t, i);
    const key = `${u}|${i}`, ed = rowEd(u, t), lk = isLocked(u, t), free = ed && (!savedTask(u, t) || state.unlock.has(t.id)), dis = ed ? "" : "disabled";
    const kidsL = t.ref ? ((planFor(u) || {}).tasks || []).filter(x => x.parent === t.ref) : [], roll = rollupOf(t, kidsL);
    const auto = (hasTgt(t) && calcPct(t) !== null) || !!roll, pend = pendingTask(u, t.id), carriedN = t.carriedCount || (t.carried ? 1 : 0);
    const nEv = (t.ev || []).length, di = dueInfo(t);
    const pct = roll ? roll.pct : (t.status === "Done" ? 100 : (typeof t.pct === "number" ? t.pct : 0));
    const sub = [
      t.ref ? `<span class="ref">${esc(t.ref)}</span>` : '<span class="pill s-none">New</span>',
      t.unplanned ? '<span class="pill s-prog" title="Came up during the week, not in the plan">Unplanned</span>' : "",
      t.parent ? `<span class="pill s-none" title="Part of deliverable ${esc(t.parent)}">↳ ${esc(t.parent)}</span>` : "",
      (t.mpId && t.mpKind && t.mpKind !== "target" && t.mpTitle) ? `<span class="pill s-none res" title="Part of the monthly result: ${esc(t.mpTitle)}">◎ ${esc(t.mpTitle)}</span>` : "",
      roll ? `<span class="pill s-prog" title="Deliverable made of ${roll.total} tasks; progress is calculated from them">${roll.done}/${roll.total} tasks</span>` : "",
      t.kind === "KPI / OKR" ? '<span class="pill s-prog">KPI / OKR</span>' : "",
      carriedN ? `<span class="pill s-not" title="Brought forward from an earlier week">Carried${carriedN > 1 ? " ×" + carriedN : ""}</span>` : "",
      pend ? '<span class="pill s-not">Change waiting for approval</span>' : "",
      t.owner ? `<span class="who" title="Owner">${esc(t.owner)}</span>` : "",
      hasTgt(t) ? `<span class="pill s-none" title="Actual against target">${esc(String(t.actual ?? 0))} / ${esc(String(t.target))} ${esc(t.measure || "")}</span>` : "",
      (t.depUnit || t.dep) ? `<span class="mi" title="Depends on ${esc(depText(t))}">${ico(IC.link)}</span>` : "",
      t.notes ? `<span class="mi" title="${esc(t.notes)}">${ico(IC.note)}</span>` : "",
      nEv ? `<span class="mi" title="${nEv} file${nEv === 1 ? "" : "s"} attached">${ico(IC.clip)}${nEv}</span>` : "",
      lk ? `<span class="mi" title="Saved task: the title, outcome, type, department, due date and priority are fixed. Use the pencil to request a change.">${ico(IC.lock)}</span>` : ""
    ].filter(Boolean).join("");
    const main = free
      ? `<textarea class="grow title-in" rows="1" id="t-title-${t.id}" data-f="title" placeholder="Task or deliverable" aria-label="Task">${esc(t.title)}</textarea>
         <textarea class="grow out-in" rows="1" id="t-outcome-${t.id}" data-f="outcome" placeholder="Expected outcome: what will exist or change when this is done" aria-label="Expected outcome">${esc(t.outcome || "")}</textarea>`
      : `<div class="tt" title="${esc(t.title)}">${t.priority === "High" ? '<span class="hi-dot" title="High priority"></span>' : ""}${esc(t.title) || '<span class="muted">(no title)</span>'}</div>${t.outcome ? `<div class="task-out" title="${esc(t.outcome)}">${esc(t.outcome)}</div>` : ""}`;
    const dueC = free ? `<input type="date" id="t-due-${t.id}" data-f="due" value="${esc(t.due)}" aria-label="Due date">` : `<span class="due ${di.cls}">${esc(di.txt)}</span>${di.sub ? `<div class="small muted">${esc(di.sub)}</div>` : ""}`;
    const deptC = free ? `<select id="t-dept-${t.id}" data-f="dept" aria-label="Department">${deptOptions(u, t)}</select>` : (esc(t.dept) || '<span class="muted">–</span>');
    const priC = free ? `<select id="t-pri-${t.id}" data-f="priority" aria-label="Priority"><option value="" ${sel(!t.priority)}>Not set</option>${PRIORITIES.map(p => `<option ${sel(p === t.priority)}>${p}</option>`).join("")}</select>` : priPill(t.priority);
    const stExtra = t.status === "Blocked" && t.blockedSince ? `<div class="small muted">since ${esc(fmt(t.blockedSince))}</div>` : "";
    const prevTip = (t.prevStatus || typeof t.prevPct === "number") ? ` title="Last week: ${esc(t.prevStatus || "No status")}${typeof t.prevPct === "number" ? " " + t.prevPct + "%" : ""}"` : "";
    const doneTxt = isAppr() ? (t.status === "Done" ? `<label class="small muted">Done on <input type="date" id="t-cd-${t.id}" data-f="completedAt" value="${esc(t.completedAt || "")}" aria-label="Actual completion date"></label>` : "") : (t.completedAt ? `<div class="small muted" id="t-cd-${t.id}">Done ${esc(fmt(t.completedAt))}</div>` : "");
    const stC = ed ? `<select class="st ${statusClass(t.status)}" id="t-st-${t.id}" data-f="status" aria-label="Status update"${prevTip}><option value="" ${sel(!t.status)}>No status</option>${STATUSES.map(x => `<option ${sel(x === t.status)}>${x}</option>`).join("")}</select>` : `<span class="pill ${statusClass(t.status)}"${prevTip}>${esc(t.status || "No status")}</span>`;
    const pcC = ed ? `<div class="pc"><div class="bar"><i style="width:${Math.min(pct, 100)}%"></i></div><input type="number" id="t-pct-${t.id}" data-f="pct" min="0" max="100" step="5" value="${roll ? roll.pct : (t.pct ?? "")}" placeholder="0" aria-label="Percent complete" ${auto ? `readonly title="${roll ? "Calculated from its tasks (weighted)" : "Calculated from actual and target"}"` : ""}></div>`
      : `<div class="pc"><div class="bar"><i style="width:${Math.min(pct, 100)}%"></i></div><span class="num small">${pct}%</span></div>`;
    const act = `<button class="icon-btn ib" type="button" data-open-task="${esc(u)}|${esc(t.id)}" aria-label="Open details" title="Open details: notes, evidence, owner, discussion">${ico(IC.open)}</button>`
      + (ed && lk ? `<button class="icon-btn ib" type="button" data-unlock="${esc(t.id)}" aria-label="Request change" title="Request change: the edit goes to Group Strategy for approval">${ico(IC.pen)}</button>` : "")
      + (ed ? (state.confirmDelete === t.id ? `<span class="confirm">${savedTask(u, t) && !isAppr() && state.week <= thisMonday() ? "Ask to remove?" : "Remove?"} <button class="btn danger small" data-del-yes="${esc(key)}">Yes</button><button class="btn small" data-del-no>No</button></span>` : `<button class="icon-btn ib bad" type="button" data-del="${t.id}" aria-label="Remove task" title="Remove task">${ico(IC.trash)}</button>`) : "");
    return `<tr class="task-row${ind ? " kid" : ""}" data-u="${esc(u)}" data-i="${i}" data-id="${esc(t.id)}">
      <td class="c-task"><div class="task-main">${main}<div class="sub">${sub}</div></div></td>
      <td class="c-due" data-l="Due">${dueC}</td>
      <td class="c-dept" data-l="Department">${deptC}</td>
      <td class="c-pri" data-l="Priority">${priC}</td>
      <td class="c-status" data-l="Status">${stC}${stExtra}${doneTxt}</td>
      <td class="c-pct" data-l="Progress">${pcC}</td>
      <td class="c-act"><div class="task-side">${act}</div></td>
    </tr>`;
  }
  // Next plan: one editable line per planned item (category, due, department, priority, target)
  function planRowHtml(u, t, i){
    const ed = rowEd(u, t), lk = isLocked(u, t), free = ed && !lk, key = `${u}|${i}`;
    const dis = free ? "" : "disabled", fin = t.category === "Revenue";
    const sub = [t.ref ? `<span class="ref">${esc(t.ref)}</span>` : '<span class="pill s-none">New</span>', t.unplanned ? '<span class="pill s-prog">Unplanned</span>' : "", t.carried ? '<span class="pill s-not">Carried</span>' : "", t.parent ? `<span class="pill s-none">↳ ${esc(t.parent)}</span>` : "", t.owner ? `<span class="who">${esc(t.owner)}</span>` : "", lk ? `<span class="mi" title="Fixed task">${ico(IC.lock)}</span>` : ""].filter(Boolean).join("");
    const main = free ? `<textarea class="grow title-in" rows="1" id="t-title-${t.id}" data-f="title" placeholder="Task or product" aria-label="Task">${esc(t.title)}</textarea>` : `<div class="tt">${esc(t.title) || '<span class="muted">(no title)</span>'}</div>`;
    const act = `<button class="icon-btn ib" type="button" data-open-task="${esc(u)}|${esc(t.id)}" aria-label="Open details" title="Open details">${ico(IC.open)}</button>` + (ed ? (state.confirmDelete === t.id ? `<span class="confirm">Remove? <button class="btn danger small" data-del-yes="${esc(key)}">Yes</button><button class="btn small" data-del-no>No</button></span>` : `<button class="icon-btn ib bad" type="button" data-del="${t.id}" aria-label="Remove task" title="Remove">${ico(IC.trash)}</button>`) : "");
    return `<tr class="task-row" data-u="${esc(u)}" data-i="${i}" data-id="${esc(t.id)}">
      <td class="c-task"><div class="task-main">${main}<div class="sub">${sub}</div></div></td>
      <td class="c-cat" data-l="Category"><select id="t-cat-${t.id}" data-f="category" aria-label="Category" ${dis}><option value="Operational" ${sel(!fin)}>Operational</option><option value="Revenue" ${sel(fin)}>Financial</option></select></td>
      <td class="c-due" data-l="Due"><input type="date" id="t-due-${t.id}" data-f="due" value="${esc(t.due)}" aria-label="Due date" ${dis}></td>
      <td class="c-dept" data-l="Department"><select id="t-dept-${t.id}" data-f="dept" aria-label="Department" ${dis}>${deptOptions(u, t)}</select></td>
      <td class="c-pri" data-l="Priority"><select id="t-pri-${t.id}" data-f="priority" aria-label="Priority" ${dis}><option value="" ${sel(!t.priority)}>Not set</option>${PRIORITIES.map(p => `<option ${sel(p === t.priority)}>${p}</option>`).join("")}</select></td>
      <td class="c-tgt" data-l="Target"><div class="tg2"><input type="number" step="any" id="t-tg-${t.id}" data-f="target" value="${t.target ?? ""}" placeholder="–" aria-label="Target" ${dis}><input type="text" id="t-ms-${t.id}" data-f="measure" value="${esc(t.measure || "")}" placeholder="unit" maxlength="20" aria-label="Target unit" ${dis}></div></td>
      <td class="c-act"><div class="task-side">${act}</div></td></tr>`;
  }
  // Progress update, Financial: one line per revenue product, actual typed in the row
  const finPct = t => { const c = calcPct(t); return c === null ? 0 : c; };
  function finRowHtml(u, t, i){
    const ed = rowEd(u, t), pct = finPct(t);
    return `<tr class="task-row" data-u="${esc(u)}" data-i="${i}" data-id="${esc(t.id)}" data-fin="1">
      <td class="c-task"><div class="tt">${esc(t.title) || '<span class="muted">(no title)</span>'}</div><div class="sub">${t.ref ? `<span class="ref">${esc(t.ref)}</span>` : ""}${t.dept ? `<span class="who">${esc(t.dept)}</span>` : ""}</div></td>
      <td class="num fin-n" data-l="Target">${hasTgt(t) ? esc(Number(t.target).toLocaleString()) + (t.measure ? ` <span class="small muted">${esc(t.measure)}</span>` : "") : '<span class="muted">–</span>'}</td>
      <td data-l="Actual"><input type="number" step="any" class="fin-in" id="t-act-${t.id}" data-f="actual" value="${t.actual ?? ""}" placeholder="0" aria-label="Actual" ${ed ? "" : "disabled"}></td>
      <td data-l="Performance"><div class="pc"><div class="bar"><i class="fin-bar" style="width:${pct}%"></i></div><span class="num small fin-pct">${hasTgt(t) ? pct + "%" : "–"}</span></div></td>
      <td class="c-act"><div class="task-side"><button class="icon-btn ib" type="button" data-open-task="${esc(u)}|${esc(t.id)}" aria-label="Open details" title="Open details">${ico(IC.open)}</button></div></td></tr>`;
  }
  function finTotal(tasks){
    const withT = tasks.filter(hasTgt), T = withT.reduce((a, t) => a + Number(t.target), 0), A = withT.reduce((a, t) => a + (Number(t.actual) || 0), 0), pct = T > 0 ? Math.min(100, Math.round(A / T * 100)) : 0;
    return `<tr class="tot"><td><b>Total</b></td><td class="num fin-n" id="finTotT">${T.toLocaleString()}</td><td class="num fin-n" id="finTotA">${A.toLocaleString()}</td><td><div class="pc"><div class="bar"><i id="finTotB" style="width:${pct}%"></i></div><span class="num small" id="finTotP">${T ? pct + "%" : "–"}</span></div></td><td></td></tr>`;
  }
  function refreshFin(tr, task){
    const pct = finPct(task); const b = tr.querySelector(".fin-bar"), pp = tr.querySelector(".fin-pct");
    if (b) b.style.width = pct + "%"; if (pp) pp.textContent = hasTgt(task) ? pct + "%" : "–";
    const all = (state.tab === "update" && state.draft && !isAll()) ? state.draft.tasks.filter(x => x.category === "Revenue" && hasTgt(x)) : [];
    if (!all.length) return; const T = all.reduce((a, x) => a + Number(x.target), 0), A = all.reduce((a, x) => a + (Number(x.actual) || 0), 0), tp = T > 0 ? Math.min(100, Math.round(A / T * 100)) : 0;
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set("finTotA", A.toLocaleString()); set("finTotP", tp + "%"); const tb = document.getElementById("finTotB"); if (tb) tb.style.width = tp + "%";
  }
  // Indicative score for the week (shown to the unit, official rating comes later)
  const RATE = p => p >= 95 ? ["Outstanding", "s-done"] : p >= 90 ? ["Very high", "s-done"] : p >= 80 ? ["High", "s-done"] : p >= 75 ? ["Satisfactory", "s-prog"] : p >= 50 ? ["Needs improvement", "s-not"] : ["Low", "s-bad"];
  function weekScore(all){
    const tasks = all.filter(t => t.status !== "Closed"), closed = all.length - tasks.length;
    const n = tasks.length; if (!n) return null;
    const pctOf = t => t.status === "Done" ? 100 : (typeof t.pct === "number" ? t.pct : 0);
    const c = { done: 0, prog: 0, blk: 0, ns: 0 };
    tasks.forEach(t => { if (t.status === "Done") c.done++; else if (t.status === "In progress") c.prog++; else if (t.status === "Blocked" || t.status === "Delayed") c.blk++; else c.ns++; });
    return { total: Math.round(tasks.reduce((a, t) => a + pctOf(t), 0) / n), n, c, closed };
  }
  function scoreCard(tasks, rem = ""){
    const sc = weekScore(tasks); if (!sc) return rem ? `<div class="pstrip">${rem}</div>` : "";
    const r = RATE(sc.total), c = sc.c, seg = (k, col, l) => c[k] ? `<i style="width:${c[k] / sc.n * 100}%;background:${col}" title="${l}: ${c[k]}"></i>` : "";
    return `<div class="pstrip">${rem}<section class="panel score-card" title="Week score: the average % complete of every task this week. Indicative only; the official rating is set at quarter end.">
      <div class="sc-n"><span class="sc-l">Week score</span><span class="num">${sc.total}%</span><span class="pill ${r[1]}">${r[0]}</span></div>
      <div class="sc-bars"><div class="stk">${seg("done", "var(--good)", "Done")}${seg("prog", "var(--bar)", "In progress")}${seg("blk", "var(--bad)", "Blocked or delayed")}${seg("ns", "var(--track)", "Not started")}</div>
      <div class="leg"><span><i class="sw" style="background:var(--good)"></i>Done ${c.done}</span><span><i class="sw" style="background:var(--bar)"></i>In progress ${c.prog}</span><span><i class="sw" style="background:var(--bad)"></i>Blocked ${c.blk}</span><span><i class="sw" style="background:var(--track)"></i>Not started ${c.ns}</span>${sc.closed ? `<span title="Closed tasks are not counted in the score"><i class="sw" style="background:var(--line)"></i>Closed ${sc.closed}</span>` : ""}</div></div></section></div>`;
  }
  const editHeadOld = () => `<thead><tr>${th("edit","title","Task")}${th("edit","due","Due")}${th("edit","dept","Department")}${th("edit","priority","Priority")}${th("edit","status","Status")}${th("edit","pct","Progress")}<th class="c-act"></th></tr></thead>`;
  const editHead = () => {
    if (state.tab === "plan") return `<thead><tr>${th("edit","title","Task or product")}${th("edit","category","Category")}${th("edit","due","Due")}${th("edit","dept","Department")}${th("edit","priority","Priority")}${th("edit","target","Target")}<th class="c-act"></th></tr></thead>`;
    if (pf().kind === "fin") return `<thead><tr>${th("edit","title","Product")}${th("edit","target","Target")}<th>Actual</th>${th("edit","pct","Performance")}<th class="c-act"></th></tr></thead>`;
    return editHeadOld();
  };

  // ---------- helpers for task kinds ----------
  const KINDS = ["Task","KPI / OKR"];
  const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  // ---------- sorting by column (click a column title) ----------
  state.sort = {};
  const PRI_RANK = { High: 0, Medium: 1, Low: 2 }, ST_RANK = { "Not started": 0, "In progress": 1, "Blocked": 2, "Delayed": 3, "Done": 4, "Closed": 5 };
  const sortVal = (t, k) => ({
    title: (t.title || "").toLowerCase(), kind: t.kind || "Task", dept: (t.dept || "").toLowerCase(), owner: (t.owner || "").toLowerCase(), unit: (t.unitName || "").toLowerCase(),
    due: t.due || "", priority: PRI_RANK[t.priority] ?? 9, status: ST_RANK[t.status] ?? 9, pct: typeof t.pct === "number" ? t.pct : (t.status === "Done" ? 100 : -1),
    notes: (t.notes || "").toLowerCase(), ev: (t.ev || []).length, category: t.category === "Revenue" ? 1 : 0, target: typeof t.target === "number" ? t.target : -1,
  })[k];
  // Returns the list's indexes in display order. Empty values always go last.
  function sortOrder(list, scope, valFn = sortVal){
    const sp = state.sort[scope], idx = list.map((_, i) => i);
    if (!sp || !sp.k) return idx;
    const empty = v => v === "" || v === 9 || v === -1;
    return idx.sort((a, b) => {
      const A = valFn(list[a], sp.k), B = valFn(list[b], sp.k), ea = empty(A), eb = empty(B);
      if (ea !== eb) return ea ? 1 : -1;
      return (A < B ? -1 : A > B ? 1 : 0) * sp.dir || a - b;
    });
  }
  const sortedBy = (list, scope) => sortOrder(list, scope).map(i => list[i]);
  const th = (scope, k, label, cls = "") => { const sp = state.sort[scope] || {}, on = sp.k === k; return `<th class="sortable ${cls}" data-sort="${scope}:${k}" tabindex="0" role="button" aria-sort="${on ? (sp.dir > 0 ? "ascending" : "descending") : "none"}" title="Sort by ${esc(label)}">${label}<span class="si">${on ? (sp.dir > 0 ? "▲" : "▼") : "↕"}</span></th>`; };
  // ---------- version 3: Business support, Feedback and Corrective actions (src/extras.js) ----------
  const X = createExtras({
    state, esc, fmt, th: (...a) => th(...a), sortOrder: (...a) => sortOrder(...a), sortedUnits: () => sortedUnits(), unitName: id => unitName(id), todayIso, toast: (...a) => toast(...a),
    errText: e => errText(e), render: () => render(), db: () => db, api: () => api, auth: () => auth(), isAppr: () => isAppr(), canEdit: u => canEdit(u), canLead: u => canLead(u), canFeedback: () => canFeedback(me), myUnit: () => myUnit(), myRole: () => me && me.role,
    downloads: () => downloads, libsReady: k => libsReady(k), sheetFromRows: (...a) => sheetFromRows(...a), writeXlsx: (...a) => writeXlsx(...a), XLSX: () => XLSX,
    newPdf: (...a) => newPdf(...a), pdfStyle: () => pdfStyle(), pdfFooter: (...a) => pdfFooter(...a), save: (...a) => save(...a), goTab: t => goTab(t), weekLabel: w => weekLabel(w),
    weekChoices: () => { const t = thisMonday(); return [nextWeekOf(t), t, prevWeekOf(t), prevWeekOf(prevWeekOf(t)), prevWeekOf(prevWeekOf(prevWeekOf(t)))]; }, thisWeek: () => thisMonday(), ALL,
  });
  // counts follow the chosen level: deliverables (rolled up) or the individual tasks behind them
  const levelPlan = p => !p ? p : (state.level === "deliverables" ? rolledPlan(p) : leafPlan(p));
  const realTasks = p => ((p && levelPlan(p).tasks) || []).filter(t => t.kind !== "KPI / OKR" && t.status !== "Closed");
  const allRealTasks = p => ((p && p.tasks) || []).filter(t => t.kind !== "KPI / OKR");
  const kpiTasks = p => ((p && p.tasks) || []).filter(t => t.kind === "KPI / OKR");
  const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const short = s => { s = String(s || ""); return s.length > 70 ? s.slice(0, 67) + "…" : s; };
  const nameOf = id => (id ? (state.names[id] || "") : "");

  // ---------- accountability: who changed what ----------
  const FIELDS = ["title","dept","owner","due","priority","status","pct","notes","kind","outcome","depUnit","dep","category","target","measure","actual","lower","parent","weight"];
  const FLAB = { ref:"Reference", parent:"Part of", weight:"Weight", category:"Category", target:"Target", measure:"Target unit", actual:"Actual", lower:"Lower is better", title:"Task", dept:"Department", owner:"Owner", due:"Due", priority:"Priority", status:"Status", pct:"%", notes:"Notes", kind:"Type", outcome:"Expected outcome", prevStatus:"Previous status", prevPct:"Previous %", completedAt:"Completed on", depUnit:"Depends on", dep:"Dependency", ev:"Evidence", carried:"Carried", carriedCount:"Weeks carried", blockedSince:"Blocked since" };
  const showV = v => (v === null || v === undefined || v === "") ? "–" : String(v);
  // Requests (approvals) are shared state: everyone sees pending ones; approvers act on them.
  let unsubReq = null;
  function subscribeRequests(){
    if (!db || unsubReq) return;
    unsubReq = db.collection("requests").orderBy("createdAt","desc").limit(300).onSnapshot(snap => {
      state.requests = snap.docs.map(d => ({ id: d.id, ...d.data() })); render();
    }, () => { state.requests = []; });
  }
  const pendingFor = (u, w) => state.requests.filter(r => r.status === "pending" && (!u || r.unit === u) && (!w || r.week === w));
  const canDecideAny = () => !!me && (isAppr() || ["leader", "planning"].includes(me.role));
  const toDecide = () => canDecideAny() ? state.requests.filter(r => r.status === "pending" && canDecide(me, r)) : [];
  const seenFyi = () => { try { return JSON.parse(store.get("wp-fyi-seen") || "[]"); } catch (e) { return []; } };
  const markSeenFyi = ids => { const x = new Set([...seenFyi(), ...ids]); store.set("wp-fyi-seen", JSON.stringify([...x].slice(-80))); };
  // planning heads are told when a chief has approved something in their unit
  const fyiForMe = () => (me && me.role === "planning") ? state.requests.filter(r => r.status === "approved" && r.stage === "chief" && r.unit === me.unit && r.decidedBy && r.decidedBy !== me.name && !seenFyi().includes(r.id) && Date.now() - Date.parse(r.decidedAt || 0) < 7 * 864e5) : [];
  // ----- notification history: kept on this device, read ones stay in the panel -----
  const nlogKey = () => "wp-nlog-" + ((me && (me.email || me.id)) || "x");
  const readLog = () => { try { return JSON.parse(store.get(nlogKey()) || "null"); } catch (e) { return null; } };
  const msgCandidates = () => {
    if (!me) return [];
    const out = [], now = Date.now(), DAY = 864e5;
    if (me.role === "planning") state.requests.filter(r => r.status === "approved" && r.stage === "chief" && r.unit === me.unit && r.decidedBy && r.decidedBy !== me.name && now - Date.parse(r.decidedAt || 0) < 14 * DAY)
      .forEach(r => out.push({ id: "fyi:" + r.id, ts: r.decidedAt, n: 1, html: `<b>${esc(r.decidedBy)}</b> approved ${esc((KIND_LABEL[r.kind] || "plan").toLowerCase())} changes for <b>${esc(deptLabel(r))}</b><div class="small muted">${esc(r.summary)} · asked by ${esc(r.by)}</div>`, go: { t: "approvals" } }));
    (state.myRR || []).filter(x => (x.status === "approved" || x.status === "rejected") && now - Date.parse(x.decidedAt || 0) < 30 * DAY)
      .forEach(x => out.push({ id: "rr:" + x.id, ts: x.decidedAt, n: 1, html: `Your role request was <b>${x.status === "approved" ? "approved" : "not approved"}</b><div class="small muted">${esc(ROLE_LABEL[x.role] || x.role)}${x.note ? " · “" + esc(x.note) + "”" : ""}</div>`, go: { t: "menu" } }));
    (state.fbs || []).filter(f => f.toLead && f.by !== me.name && ((me.role === "leader" || me.role === "planning") ? f.unit === me.unit : ["super_admin", "executive"].includes(me.role)) && now - Date.parse(f.createdAt || 0) < 60 * DAY)
      .forEach(f => out.push({ id: "fb:" + f.id, ts: f.createdAt, n: 1, html: `<b>${esc(f.from)}</b> sent a letter ${me.role === "leader" ? "to the head of" : "(copy) to the head of"} <b>${esc(unitName(f.unit))}</b><div class="small muted">${esc((f.body || "").split("\n")[0].slice(0, 110))}</div>`, go: { t: "fb", unit: f.unit } }));
    // progress updates travel up: staff and managers to their chiefs, chiefs to planning, Group Strategy, the CEO and the DCEO
    const groups = new Map(), cur = thisMonday();
    (state.activity || []).forEach(a => {
      if (a.action !== "save" || !a.role || !a.week || String(a.week).slice(0, 10) > cur || a.by === me.name || now - Date.parse(a.ts || 0) > 7 * DAY) return;
      const up = a.role === "leader" ? (me.role === "planning" && me.unit === a.unit) || me.role === "super_admin" || me.role === "executive"
        : a.role === "planning" ? me.role === "super_admin" || me.role === "executive"
        : ["manager", "staff"].includes(a.role) ? me.role === "leader" && me.unit === a.unit : false;
      if (!up) return;
      const day = String(a.ts).slice(0, 10), id = "pu:" + a.by + "|" + a.unit + "|" + day, g = groups.get(id) || { id, by: a.by, role: a.role, unit: a.unit, week: String(a.week).slice(0, 10), ts: a.ts, n: 0, det: [] };
      g.n++; g.det.push({ ts: a.ts, s: a.summary || "", d: (Array.isArray(a.details) ? a.details : []).slice(0, 15).map(x => String(x).slice(0, 200)) }); if (a.ts > g.ts) g.ts = a.ts; groups.set(id, g);
    });
    groups.forEach(g => out.push({ id: g.id, ts: g.ts, n: g.n, det: g.det.sort((x, y) => x.ts < y.ts ? -1 : 1).slice(-12), html: `<b>${esc(g.by)}</b> (${g.role === "leader" ? "chief" : g.role === "planning" ? "planning head" : g.role}, ${esc(unitName(g.unit))}) updated progress<div class="small muted">${g.n} save${g.n === 1 ? "" : "s"} on ${esc(fmt(String(g.ts).slice(0, 10)))}</div>`, go: { t: "unit", unit: g.unit, week: g.week } }));
    return out;
  };
  function syncMsgs(){
    const first = readLog() === null, log = readLog() || {}; let ch = first;
    msgCandidates().forEach(m => {
      const o = log[m.id];
      if (!o) { log[m.id] = { ...m, read: first && Date.now() - Date.parse(m.ts || 0) > 864e5 }; ch = true; }
      else if (m.n > (o.n || 1)) { log[m.id] = { ...m, read: false }; ch = true; }
      else if (o.html !== m.html || JSON.stringify(o.det || null) !== JSON.stringify(m.det || null)) { log[m.id] = { ...o, html: m.html, go: m.go, det: m.det }; ch = true; }
    });
    const keys = Object.keys(log).sort((a, b) => (log[b].ts || "") < (log[a].ts || "") ? -1 : 1);
    if (keys.length > 80) { keys.slice(80).forEach(k => delete log[k]); ch = true; }
    if (ch) store.set(nlogKey(), JSON.stringify(log));
    return log;
  }
  const msgList = () => Object.values(syncMsgs()).sort((a, b) => (b.ts || "") < (a.ts || "") ? -1 : 1);
  const unreadMsgs = () => msgList().filter(m => !m.read);
  function markMsgsRead(ids){ const log = syncMsgs(); (ids || Object.keys(log)).forEach(i => { if (log[i]) log[i].read = true; }); store.set(nlogKey(), JSON.stringify(log)); }
  const KIND_LABEL = { plan: "Plan", actual: "Progress update" };
  const deptLabel = r => (r.dept || "").split(",").filter(Boolean).join(", ") || "Whole unit";
  const reqTitle = r => `${deptLabel(r)} · ${unitName(r.unit)}`;
  let unsubAct = null;
  function subscribeActivity(){
    if (!db || unsubAct) return;
    unsubAct = db.collection("activity").orderBy("ts","desc").limit(400).onSnapshot(snap => {
      state.activity = snap.docs.map(d => { const a = { id: d.id, ...d.data() }; if (typeof a.details === "string") { try { a.details = JSON.parse(a.details); } catch (e) { a.details = [a.details]; } } if (!Array.isArray(a.details)) a.details = []; return a; }); state.actLoaded = true;
      if (state.tab === "activity") render(); else renderHero();
    }, err => { state.actLoaded = true; state.actErr = err.code; unsubAct = null; render(); });
  }
  const ACTIONS = ["save","import","request","approval","restore","lists","unit","evidence","data-load"];
  const actionLabel = a => ({ save:"Saved plan", import:"Imported file", "data-load":"Data load", lists:"Departments / staff", unit:"Unit change", request:"Asked for approval", approval:"Approval decision", restore:"Restore / undo", evidence:"Evidence", support:"Business support", feedback:"Feedback", corrective:"Corrective action" })[a] || a;

  const UNDOABLE = ["save", "import", "approval", "restore", "lists", "unit"];
  const canUndoAct = a => mayUndo() && UNDOABLE.includes(a.action) && a.unit && Date.now() - Date.parse(a.ts) < 30 * 864e5 && (a.action === "lists" || a.action === "unit" ? isAppr() : (a.week && (isAppr() || (a.unit === me.unit && a.week >= thisMonday()))));
  function undoBtn(a){
    if (!canUndoAct(a)) return "";
    if (state.undoAsk === a.id) return `<div class="undo-ask" role="alert"><span>Put this back as it was before? Later changes to the same plan are undone too. The version you replace stays in History.</span> <button class="btn small primary" type="button" data-undo-yes="${esc(a.id)}">Yes, undo</button> <button class="btn small" type="button" data-undo-no="1">Keep</button></div>`;
    return `<div><button class="btn small ghost" type="button" data-undo="${esc(a.id)}" title="Put the plan back as it was before this change">${ico(IC.undo || IC.clock)}Undo</button></div>`;
  }
  async function doUndoAct(id){
    const a = state.activity.find(x => x.id === id); state.undoAsk = null; if (!a) { render(); return; }
    const isUnit = a.action === "lists" || a.action === "unit", row = isUnit ? a.unit : planId(a.week, a.unit), tbl = isUnit ? "units" : "plans";
    try {
      const snap = await db.collection("history").where("rowId", "==", row).orderBy("at", "desc").limit(80).get();
      const hs = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(h => h.tbl === tbl && h.op !== "SNAPSHOT");
      let best = null, bd = 1e12; const t0 = Date.parse(a.ts);
      hs.forEach(h => { const d = Math.abs(Date.parse(h.at) - t0); if (d < bd) { bd = d; best = h; } });
      if (!best || bd > 30000) { toast("No saved copy was found for this change, so it cannot be undone from here."); render(); return; }
      const r = await api.restoreVersion(auth(), best.id);
      if (r.error) { toast(errText(r)); render(); return; }
      toast("Undone. The version you replaced is kept in History."); state.history = null;
    } catch (e) { toast(errText(e)); }
    render();
  }
  function renderActivity(){
    if (!db) return `<div class="panel"><div class="empty"><b>No activity to show</b>The shared store is not available in this view.</div></div>`;
    if (!state.actLoaded) return `<div class="panel"><div class="empty"><b>Loading activity…</b></div></div>`;
    if (state.actErr) return `<div class="banner warn">Could not load the activity log (${esc(state.actErr)}). Reload the page to try again.</div>`;
    const f = state.actFilter, all = state.activity;
    const people = [...new Set(all.map(a => a.by))];
    const tmw = thisMonday(), aw = state.actWeek || tmw, wkOf = a => weekStartOf((a.ts || "").slice(0, 10));
    const weeks = [...new Set([tmw, ...all.map(wkOf)])].sort().reverse();
    const list = all.filter(a => wkOf(a) === aw && (!f.unit || a.unit === f.unit) && (f.who === "" || a.by === (f.who === "__sys__" ? "" : f.who)) && (!f.action || a.action === f.action));
    const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
    const by = {};
    all.filter(a => a.ts >= cutoff && a.action !== "data-load").forEach(a => { const k = a.by || ""; const r = by[k] || (by[k] = { n: 0, units: new Set(), last: "" }); r.n++; if (a.unit) r.units.add(a.unit); if (a.ts > r.last) r.last = a.ts; });
    const sumRows = Object.entries(by).sort((a, b) => b[1].n - a[1].n).map(([id, r]) => `<tr><td><b>${id ? `<span data-person="${esc(id)}" data-bare>Someone</span>` : "System"}</b></td><td class="num">${r.n}</td><td class="small">${[...r.units].map(unitName).map(esc).join(", ") || "–"}</td><td class="small">${esc(r.last.slice(0,10))} ${esc(r.last.slice(11,16))} UTC</td></tr>`).join("");
    const rows = list.map(a => `<tr>
      <td class="small num" style="white-space:nowrap">${esc((a.ts || "").slice(0,10))}<br><span class="muted">${esc((a.ts || "").slice(11,16))} UTC</span></td>
      <td>${a.by ? `<b data-person="${esc(a.by)}" data-bare>Someone</b>` : `<span class="muted">System</span>`}</td>
      <td class="small">${a.unit ? esc(unitName(a.unit)) : "–"}</td>
      <td class="small">${a.week ? esc(weekLabel(a.week)) : "–"}</td>
      <td><span class="pill s-none">${esc(actionLabel(a.action))}</span></td>
      <td class="small">${esc(a.summary)}${undoBtn(a)}${(a.details || []).length ? `<details><summary class="muted">${a.details.length} detail${a.details.length > 1 ? "s" : ""}</summary><ul style="margin:6px 0 0;padding-left:18px">${a.details.map(x => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}</td></tr>`).join("");
    return `<div class="banner info">Every save, import and department change is recorded with the person who made it. Task rows also show who last changed them under All tasks.</div>
    <div class="seg" role="tablist" aria-label="Activity view" style="margin-bottom:14px"><button type="button" role="tab" data-acttab="log" aria-selected="${state.actTab !== "who"}">Activity log</button><button type="button" role="tab" data-acttab="who" aria-selected="${state.actTab === "who"}">Who is updating</button></div>
    ${state.actTab === "who" ? `<div class="grid2" style="margin-bottom:16px">
      <div class="panel"><div class="panel-head"><h2>Who is updating</h2><span class="muted small">Last 30 days</span></div>
        ${sumRows ? `<div class="scroll"><table><thead><tr><th>Person</th><th>Updates</th><th>Units</th><th>Last active</th></tr></thead><tbody>${sumRows}</tbody></table></div>` : `<div class="empty"><b>No updates yet</b>Saves and imports appear here.</div>`}</div>
      <div class="panel"><div class="panel-head"><h2>Not updated this week</h2></div><div class="asks">${(() => { const ids = state.units.filter(u => { const p = state.plans[u.id]; return !(p && p.updatedAt && p.updatedBy); }).map(u => u.name); return ids.length ? `<p class="small muted" style="margin:6px 0">No saved update by a person for ${esc(weekLabel(state.week))}:</p><div class="chipset">${ids.map(n => `<span class="tag">${esc(n)}</span>`).join("")}</div>` : `<div class="empty" style="padding:20px 0"><b>Every unit has an update</b></div>`; })()}</div></div>
    </div>` : ""}
    ${state.actTab === "who" ? "" : `
    <div class="panel">
      <div class="panel-head"><h2>Activity log</h2><div class="toolbar">
        <select id="aWeek" aria-label="Week">${weeks.map(w => `<option value="${w}" ${w === aw ? "selected" : ""}>${w === tmw ? "This week · " : ""}${esc(weekLabel(w))}</option>`).join("")}</select>
        <select id="aUnit" aria-label="Filter by unit"><option value="">All units</option>${sortedUnits().map(u => `<option value="${esc(u.id)}" ${f.unit === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>
        <select id="aWho" aria-label="Filter by person"><option value="">Everyone</option>${people.map(id => `<option value="${id || "__sys__"}" ${f.who === (id || "__sys__") ? "selected" : ""}>${id ? esc(nameOf(id) || "User " + id.slice(-4)) : "System"}</option>`).join("")}</select>
        <select id="aAct" aria-label="Filter by action"><option value="">All actions</option>${ACTIONS.map(a => `<option value="${a}" ${f.action === a ? "selected" : ""}>${actionLabel(a)}</option>`).join("")}</select>
        <span class="muted small">${list.length} entries</span>${downloads ? `<button class="btn" id="actXlsx">Excel</button>` : ""}</div></div>
      ${list.length ? `<div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>Unit</th><th>Week</th><th>Action</th><th>What changed</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><b>No entries for this week</b>Pick another week or change the filters.</div>`}`}
    </div>`;
  }
  async function exportActivityXlsx(){
    if (!libsReady("xlsx")) return;
    const rows = [["When (UTC)","Who","Unit","Week","Action","Summary","Details"], ...state.activity.map(a => [a.ts, a.by ? (nameOf(a.by) || a.by) : "System", a.unit ? unitName(a.unit) : "", a.week || "", actionLabel(a.action), a.summary || "", (a.details || []).join("\n")])];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, sheetFromRows(rows, [22,24,30,14,18,50,80]), "Activity");
    await writeXlsx(wb, "Wagwago weekly tracking activity log.xlsx", "Activity log saved");
  }

  // ---------- departments and staff inside a unit ----------
  async function updateUnitList(field, value, text){
    const u = state.editUnit; if (!u || isAll() || !db) return false;
    if (!canEdit(u)) { toast(ERR.not_allowed); return false; }
    try { const r = await api.saveUnit(auth(), "lists", { id: u, [field]: value }, text); if (r.error) { toast(errText(r)); return false; } return true; }
    catch (e) { toast(errText(e)); return false; }
  }
  async function addDept(){
    const el = $("#newDept"); const name = (el.value || "").trim().replace(/\s+/g, " ");
    if (!name) { toast("Type a department name first"); return; }
    const list = unitOf(state.editUnit).departments || [];
    if (list.some(x => x.toLowerCase() === name.toLowerCase())) { toast("That department already exists"); return; }
    if (await updateUnitList("departments", [...list, name], `Added department "${name}"`)) { toast("Department added"); setTimeout(() => { const n = $("#newDept"); n && n.focus(); }); }
  }
  async function removeDept(name){
    state.confirmDelete = null;
    const list = unitOf(state.editUnit).departments || [];
    if (await updateUnitList("departments", list.filter(x => x !== name), `Removed department "${name}"`)) toast("Department removed. Tasks keep their label.");
  }
  async function addPerson(){
    const name = ($("#newPerson").value || "").trim().replace(/\s+/g, " "), dept = $("#newPersonDept").value;
    if (!name) { toast("Type a name first"); return; }
    const list = unitOf(state.editUnit).people || [];
    if (list.some(p => p.name.toLowerCase() === name.toLowerCase())) { toast("That name is already in the list"); return; }
    if (await updateUnitList("people", [...list, dept ? { name, dept } : { name }], `Added staff name "${name}"${dept ? " (" + dept + ")" : ""}`)) toast("Name added");
  }
  async function removePerson(i){
    state.confirmDelete = null;
    const list = [...(unitOf(state.editUnit).people || [])]; const gone = list.splice(i, 1)[0];
    if (await updateUnitList("people", list, `Removed staff name "${gone && gone.name}"`)) toast("Name removed");
  }
  function ownerDatalist(u){
    const names = new Set((unitOf(u).people || []).map(p => p.name));
    const p = isAll() ? (state.allDrafts && state.allDrafts[u]) : state.draft;
    ((p && p.tasks) || []).forEach(t => t.owner && names.add(t.owner));
    return `<datalist id="dl-owners-${esc(u)}">${[...names].map(n => `<option value="${esc(n)}"></option>`).join("")}</datalist>`;
  }
  function renderLists(){
    const u = unitOf(state.editUnit), depts = u.departments || [], people = u.people || [];
    const cnt = d => ((state.draft && state.draft.tasks) || []).filter(t => t.dept === d).length;
    const chips = depts.map(d => state.confirmDelete === "dept:" + d
      ? `<span class="confirm">Remove ${esc(d)}? <button class="btn danger" data-dept-yes="${esc(d)}">Remove</button><button class="btn" data-del-no>Keep</button></span>`
      : `<span class="chip">${esc(d)} <span class="muted small">${cnt(d)} this week</span>${mayDepts(state.editUnit) ? `<button data-dept-del="${esc(d)}" aria-label="Remove ${esc(d)}">×</button>` : ""}</span>`).join("");
    const ppl = people.map((p, i) => state.confirmDelete === "person:" + i
      ? `<li><span class="confirm">Remove ${esc(p.name)}? <button class="btn danger" data-person-yes="${i}">Remove</button><button class="btn" data-del-no>Keep</button></span></li>`
      : `<li><span>${esc(p.name)}${p.dept ? ` <span class="tag">${esc(p.dept)}</span>` : ""}</span><button class="icon-btn" data-person-del="${i}" aria-label="Remove ${esc(p.name)}">×</button></li>`).join("");
    return `<div class="reports" style="border-bottom:1px solid var(--line)">
      <div><label for="newDept">Departments in ${esc(u.name || "")}</label>
        <div class="chipset" style="margin-bottom:10px">${chips || `<span class="muted small">No departments yet. Add the first one below.</span>`}</div>
        ${mayDepts(state.editUnit) ? `<div class="toolbar"><input type="text" id="newDept" placeholder="New department name" style="flex:1;min-width:160px"><button class="btn primary" id="addDeptBtn">Add department</button></div>` : `<div class="small muted">Only Group Strategy, the unit's chief or planning can add or remove departments.</div>`}</div>
      <div><label for="newPerson">Staff names (optional, fills the owner suggestions)</label>
        <ul class="plain">${ppl || `<li class="muted small">No names yet.</li>`}</ul>
        <div class="toolbar"><input type="text" id="newPerson" placeholder="Name" style="flex:1;min-width:120px"><select id="newPersonDept" aria-label="Department of this person"><option value="">No department</option>${depts.map(d => `<option>${esc(d)}</option>`).join("")}</select><button class="btn" id="addPersonBtn">Add name</button></div></div>
      <div style="display:flex;flex-direction:column;justify-content:flex-end;gap:8px"><span class="small muted">Changes save straight away and fill the Department dropdown for every task in this unit. Import files can also create departments.</span><div class="toolbar"><button class="btn" id="listsCancel">Close</button></div></div>
    </div>`;
  }

  function alertsFor(u){
    const unit = unitOf(u); if (!unit.id) return [];
    return unitAlerts({ unit, plan: state.plans[u], nextPlan: state.week === thisMonday() ? (state.nextPlans || {})[u] || null : undefined, weekPlans: state.plans, week: state.week, thisMonday: thisMonday(), today: todayIso, requests: state.requests });
  }
  function remindersPanel(u){
    const list = alertsFor(u).sort((a, b) => levelRank[a.level] - levelRank[b.level]);
    if (!list.length) return "";
    const urgent = list.filter(a => a.level === "bad"), soon = list.filter(a => a.level !== "bad");
    const col = (arr, cls, name) => `<div class="rem-col"><div class="rem-h"><span class="pill ${cls}">${name}</span> <span class="muted small">${arr.length}</span></div>${arr.length ? [...arr.filter(a => a.tasks.length), ...arr.filter(a => !a.tasks.length)].map(a => `<div class="rem-it"><div class="rem-tx">${esc(a.text)}</div>${a.tasks.length ? `<ul class="rem-t">${a.tasks.map(t => `<li>${esc(short(t.title))}${t.fromUnit ? ` <span class="muted small">(${esc(unitName(t.fromUnit))})</span>` : ""}</li>`).join("")}</ul>` : ""}</div>`).join("") : `<div class="muted small">Nothing here.</div>`}</div>`;
    return `<details class="reminders" id="remPanel"><summary title="Checked automatically for ${esc(unitName(u))}. Click to see the details."><span class="rem-title">Reminders for ${esc(unitName(u))}</span><span class="rem-btns"><span class="pill ${urgent.length ? "s-bad" : "s-none"}">Act now · ${urgent.length}</span><span class="pill ${soon.length ? "s-not" : "s-none"}">Soon · ${soon.length}</span></span></summary>
      <div class="rem-pop">${col(urgent, "s-bad", "Act now")}${col(soon, "s-not", "Soon")}</div></details>`;
  }
  function requestsPanel(u){
    const list = pendingFor(u, state.week); if (!list.length) return "";
    return `<div class="banner warn" style="margin:12px 16px 0"><b>${list.length} change request${list.length === 1 ? "" : "s"} waiting for Group Strategy.</b> They are not part of the plan until approved.
      ${list.map(r => `<div class="req-mini"><span>${esc((r.details || [])[0] || r.summary)}${(r.details || []).length > 1 ? ` <span class="muted small">+${r.details.length - 1} more</span>` : ""} <span class="muted small">· ${esc(r.by)} · ${esc(fmt((r.createdAt || "").slice(0, 10)))}</span></span>${canEdit(u) ? `<button class="btn small" data-withdraw="${esc(r.id)}">Withdraw</button>` : ""}${isAppr() ? `<button class="btn small" data-goto="approvals">Review</button>` : ""}</div>`).join("")}</div>`;
  }
  // ---------- Plans: week banner, filters, list ----------
  const pf = () => state.pf || (state.pf = { q: "", pri: "", st: "", dep: "", lvl: "tasks", kind: "ops" });
  function visibleRows(tasks){
    const f = pf(), q = f.q.trim().toLowerCase();
    const ok = t => (!q || [t.title, t.ref, t.owner, t.dept, t.outcome].some(x => (x || "").toLowerCase().includes(q))) && (!f.pri || t.priority === f.pri) && (!f.st || (f.st === "none" ? !t.status : t.status === f.st)) && (!f.dep || t.dept === f.dep) && (state.tab === "plan" || (f.kind === "fin") === (t.category === "Revenue"));
    const base = sortOrder(tasks, "edit");
    if (f.lvl !== "deliv") return base.filter(i => ok(tasks[i])).map(i => ({ i, ind: 0 }));
    const refs = new Set(tasks.map(t => t.ref).filter(Boolean)), out = [];
    base.filter(i => !tasks[i].parent || !refs.has(tasks[i].parent)).forEach(i => {
      const t = tasks[i], kids = t.ref ? base.filter(j => tasks[j].parent === t.ref) : [], kidOk = kids.filter(j => ok(tasks[j]));
      if (ok(t) || kidOk.length) { out.push({ i, ind: 0 }); (ok(t) ? kids : kidOk).forEach(j => out.push({ i: j, ind: 1 })); }
    });
    return out;
  }
  function planFilterBar(deptList, shown, total, extra){
    const f = pf(), on = f.q || f.pri || f.st || f.dep;
    const o = (k, label, arr) => `<select class="in sm${f[k] ? " on" : ""}" data-pfl="${k}" aria-label="${label}"><option value="">${label}: any</option>${arr.map(x => `<option value="${esc(x[0])}" ${f[k] === x[0] ? "selected" : ""}>${esc(x[1])}</option>`).join("")}</select>`;
    return `<div class="plan-bar2"><div class="fbar"><div class="fsearch">${ico(IC.search)}<input type="text" id="pfQ" placeholder="Search tasks" value="${esc(f.q)}" aria-label="Search tasks"></div>
      ${o("pri", "Priority", PRIORITIES.map(p => [p, p]))}${o("st", "Status", [...STATUSES.map(x => [x, x]), ["none", "No status"]])}${deptList.length ? o("dep", "Department", deptList.map(d => [d, d])) : ""}${on ? '<button class="lnk" type="button" id="pfClear">Clear</button>' : ""}</div>
      <span class="small muted">${on ? `${shown} of ${total} tasks` : `${total} task${total === 1 ? "" : "s"}`}${extra || ""}</span></div>`;
  }
  function weekBan(){
    const w = state.week, planTab = state.tab === "plan", next = w === nextMonday(), tm = thisMonday();
    const sb = planTab && state.editUnit && !isAll() ? subPill(subOf(state.editUnit, "week", w)) : "";
    const pill = planTab ? (next ? '<span class="pill out">PLAN FOR NEXT WEEK</span>' : '<span class="pill s-not">NOT NEXT WEEK</span>') + sb : '<span class="pill tag-actual">ACTUAL</span>';
    const rel = w === tm ? "This week" : w < tm ? "Past week" : next ? "Next week" : "Later week";
    const hint = planTab ? (next ? "Add next week's tasks by hand, bring forward unfinished work, or fill in the Excel template and upload it. Press Submit for approval when the plan is ready." : `This is not next week. <button class="lnk" id="goNext">Go to next week (${esc(weekLabel(nextMonday()))})</button>`)
      : "";
    return `<div class="weekban">${pill}<span class="pill s-none wk-no" title="Week number inside its month${fyWeek(w) ? " · fiscal week " + fyWeek(w) : ""}">${esc(wkTag(w))}</span><span class="wk-big">${esc(weekLabel(w))}</span><span class="eth">${esc(ethWeekLabel(w))}</span><span class="small muted">${rel}</span></div><div class="small muted plan-hint">${hint}</div>`;
  }
  const moreMenu = items => items.length ? `<details class="more"><summary class="btn" aria-label="More actions" title="More actions">${ico(IC.more)}</summary><div class="more-menu">${items.join("")}</div></details>` : "";
  function renderUpdate(){
    if (!state.units.length) return `<div class="panel"><div class="empty"><b>No units to report for</b>Units appear here once the Strategy Office adds them.</div></div>`;
    const opts = `<option value="${ALL}" ${isAll()?"selected":""}>All units</option>` + sortedUnits().map(u => `<option value="${esc(u.id)}" ${u.id===state.editUnit?"selected":""}>${esc(u.name)}${u.id === myUnit() ? " (yours)" : ""}</option>`).join("");
    const single = hasDraft() && !isAll(), ed = single && canEdit(state.editUnit);
    const past = state.week < addisLockWeek();
    const lead = single ? X.banner(state.editUnit) : "", remBox = single ? remindersPanel(state.editUnit) : "";
    const d0 = state.draft;
    const pick = `<div class="toolbar"><label for="unitPick" class="small muted">Unit</label><select id="unitPick"><option value="">Choose your function or unit…</option>${opts}</select></div>`;
    const menu = [];
    if (single) {
      if (ed && canLead(state.editUnit)) menu.push(`<button type="button" id="listsBtn">${ico(IC.users)}Departments${(unitOf(state.editUnit).departments||[]).length ? ` (${unitOf(state.editUnit).departments.length})` : ""}</button>`);
      if (mayUndo()) menu.push(`<button type="button" id="histBtn" title="Every saved version of this plan">${ico(IC.clock)}History</button>`);
      if (downloads) menu.push(`<button type="button" id="unitPdfBtn">${ico(IC.down)}Plan (PDF)</button>`, `<button type="button" id="unitXlsxBtn">${ico(IC.down)}Plan (Excel)</button>`);
    } else if (isAll() && downloads) menu.push(`<button type="button" id="pdfBtn">${ico(IC.down)}Performance report (PDF)</button>`, `<button type="button" id="xlsxAllBtn">${ico(IC.down)}All plans (Excel)</button>`);
    const planM = state.tab === "plan", sub = planM && single ? subOf(state.editUnit, "week", state.week) : null, subbed = sub && sub.status === "pending";
    const planTop = planM && single ? `<button class="btn" type="button" id="tplTop">${ico(IC.down)}Download template</button>${ed ? `<label class="btn" title="Fill the template, then upload it here">${ico(IC.fwd)}Upload Excel<input type="file" id="impFileTop" accept=".xlsx,.xls,.csv" hidden></label>` : ""}` : "";
    const submitBtn = planM && single && ed ? `<button class="btn primary" type="button" id="submitPlan" ${state.dirty || !d0 || !d0.tasks.length || subbed ? "disabled" : ""} title="${state.dirty ? "Save the plan first" : subbed ? "Already waiting for approval" : "Send next week's plan to Group Strategy"}">${sub && sub.status !== "withdrawn" && sub.status !== "pending" ? "Submit again" : "Submit for approval"}</button>` : "";
    const acts = `<div class="toolbar plan-acts">${planTop}${single && ed && canLead(state.editUnit) && planM ? `<button class="btn" type="button" id="carryBtn">${ico(IC.fwd)}Bring forward</button>` : ""}${moreMenu(menu)}${single && ed ? (!planM && state.week === thisMonday() ? `<details class="more add-menu"><summary class="btn primary">${ico(IC.plus)}Add task <span aria-hidden="true">▾</span></summary><div class="more-menu"><button type="button" id="addTask">Add task</button><button type="button" id="addUnplanned" title="A task that came up during the week and was not in the plan">Add unplanned task</button></div></details>` : `<button class="btn${planM ? "" : " primary"}" type="button" id="addTask">${ico(IC.plus)}Add task</button>`) : ""}${submitBtn}</div>`;
    const topRow = `<div class="plan-top"><div class="plan-wk">${weekBan()}</div>${acts}</div>`;
    const lvlSeg = `<div class="seg" role="tablist" aria-label="List level"><button type="button" role="tab" data-lvl="tasks" aria-selected="${pf().lvl !== "deliv"}">All tasks</button><button type="button" role="tab" data-lvl="deliv" aria-selected="${pf().lvl === "deliv"}">By deliverable</button></div>`;
    const planMode = state.tab === "plan", fin = !planMode && pf().kind === "fin";
    const kindSeg = `<div class="seg" role="tablist" aria-label="Kind of work"><button type="button" role="tab" data-kind="ops" aria-selected="${!fin}">Operational</button><button type="button" role="tab" data-kind="fin" aria-selected="${fin}">Financial</button></div>`;
    const bar1 = `<div class="plan-bar">${pick}<div class="toolbar">${planMode ? "" : kindSeg}${planMode || fin ? "" : lvlSeg}</div></div>`;
    if (!state.editUnit || !hasDraft()) return `${topRow}<div class="panel">${bar1}<div class="empty"><b>Choose your unit to start</b>Pick your function or business unit. Anyone can view; to update, sign in with your name and your unit's PIN (the name button at the top). Then update status, % complete, notes and evidence as the week goes on.</div></div>`;
    const warn = state.remoteChanged ? `<div class="banner warn" style="margin:12px 16px 0">Someone else saved ${isAll() ? "one of these plans" : "this plan"} while you were editing. Saving adds your changes on top of theirs. <button class="btn" id="reloadRemote" style="margin-left:6px">Drop mine and load theirs</button></div>` : "";
    const submitLbl = past && !isAppr() ? "Request update" : isAll() ? "Save all changes" : "Save plan";
    const saveBar = (meta) => `<div class="save-bar"><span class="small muted">${state.dirty ? `<b style='color:var(--accent)'>Unsaved changes${isAll() && state.dirtyUnits.size ? ` in ${state.dirtyUnits.size} unit${state.dirtyUnits.size>1?"s":""}` : ""}</b>` : meta}</span>
        <div class="toolbar"><button class="btn" id="discardBtn" ${state.dirty?"":"disabled"}>Discard changes</button><button class="btn primary" id="saveBtn" ${state.dirty?"":"disabled"}>${ico(IC.save)}${submitLbl}</button></div></div>`;
    const noMatch = `<div class="empty"><b>No tasks match these filters</b><button class="btn" type="button" id="pfClear">Clear filters</button></div>`;

    if (isAll()) {
      const can = isAppr();
      const allTasks = sortedUnits().flatMap(u => (state.allDrafts[u.id] || emptyPlan(u.id)).tasks);
      const deptList = [...new Set(allTasks.map(t => t.dept).filter(Boolean))].sort();
      let shown = 0;
      const groups = sortedUnits().map(u => {
        const d = state.allDrafts[u.id] || emptyPlan(u.id);
        const s = summarize(d), vis = visibleRows(d.tasks); shown += vis.length;
        const f = pf(), filtered = f.q || f.pri || f.st || f.dep;
        if ((filtered || fin) && !vis.length) return "";
        const rows = vis.map(r => taskRowHtml(u.id, d.tasks[r.i], r.i, r.ind)).join("");
        return `<tbody><tr class="group-row"><td colspan="7"><div class="toolbar" style="justify-content:space-between">
            <div><b>${esc(u.name)}</b> <span class="tag">${esc(u.type||"")}</span> <span class="small muted">${s.total} tasks · ${s.done} done${state.dirtyUnits.has(u.id) ? " · <b style='color:var(--accent)'>edited</b>" : ""}</span></div>
            ${canEdit(u.id) ? `<button class="btn small" data-add-unit="${esc(u.id)}">${ico(IC.plus)}Add task</button>` : ""}</div>${ownerDatalist(u.id)}</td></tr>
          ${rows || `<tr><td colspan="7" class="small muted">${fin ? "No financial lines yet." : "No tasks entered yet."}</td></tr>`}${fin && vis.length ? finTotal(vis.map(r => d.tasks[r.i])) : ""}</tbody>`;
      }).join("");
      return `${topRow}${planMode ? "" : scoreCard(allTasks)}<div class="panel">${bar1}${planFilterBar(deptList, shown, allTasks.length)}${warn}${can ? "" : `<div class="banner info" style="margin:12px 16px 0">All units is view-only, except your own unit's rows. Group Strategy approvers can edit every unit here.</div>`}
        ${shown || !groups ? `<div class="scroll edit-scroll"><table class="edit-table">${editHead()}${groups}</table></div>` : noMatch}
        <div class="banner info" style="margin:12px 16px">To edit a unit's key results, blockers and asks, or its departments and staff lists, choose that unit on its own.</div>
        ${saveBar("Showing every unit's plan for this week")}</div>`;
    }

    const d = state.draft;
    const p = state.plans[state.editUnit];
    const meta = p && p.updatedAt ? `Last saved ${fmt(p.updatedAt.slice(0,10))} ${p.updatedAt.slice(11,16)} UTC ${p.updatedBy ? `<span data-person="${esc(p.updatedBy)}"></span>` : `· ${esc(p.source || "data load")}`}` : "Not saved yet for this week";
    const u = unitOf(state.editUnit);
    const access = !ed
      ? `<div class="banner warn" style="margin:12px 16px 0"><b>View only.</b> To update ${esc(u.name || "this unit")}, sign in with your name and ${esc(u.name || "the unit")}'s PIN. <button class="btn" id="signInBtn" style="margin-left:6px">Sign in</button></div>`
      : past && !isAppr() ? `<div class="banner warn" style="margin:12px 16px 0"><b>This week is closed.</b> Progress for a past week can't be edited directly. Make the change and press <b>Request update</b>: Group Strategy reviews it and it is recorded only when approved.</div>`
      : state.week < thisMonday() && !isAppr() ? `<div class="slimnote warn">This week has ended. You can still update its progress until Saturday 12:00 noon; after that, changes need approval.</div>`
      : state.week <= thisMonday() && !isAppr() ? `<div class="slimnote" title="Saved tasks keep their title, expected outcome, type, department, due date and priority (lock icon). Update status, %, notes, owner and evidence freely. To change a fixed field or remove a task, use the pencil or the bin: Group Strategy approves it first.">ⓘ Some fields are locked. Hover for details.</div>` : "";
    const listHint = ed && !(u.departments||[]).length ? `<div class="banner info" style="margin:12px 16px 0">${esc(u.name||"This unit")} has no departments yet. Open the ⋯ menu, choose <b>Departments</b> and add them, then pick one for each task.</div>` : "";
    const rdis = ed ? "" : "disabled";
    const us = summarize(d);
    const deptList = [...new Set([...(u.departments || []), ...d.tasks.map(t => t.dept).filter(Boolean)])].sort();
    const vis = visibleRows(d.tasks);
    const prog = us.total ? ` · ${us.done} done · ${us.avg}% overall` : "";
    return `${lead}${topRow}${planMode ? remBox && `<div class="pstrip">${remBox}</div>` : scoreCard(d.tasks, remBox)}<div class="panel">${bar1}${planFilterBar(deptList, vis.length, d.tasks.length, prog)}${state.showLists && ed && canLead(state.editUnit) ? renderLists() : ""}${access}${warn}${requestsPanel(state.editUnit)}${ed ? carryBanner() : ""}${listHint}
      ${ownerDatalist(state.editUnit)}${d.tasks.length ? (vis.length ? `<div class="scroll edit-scroll"><table class="edit-table">${editHead()}<tbody>${vis.map(r => taskRowHtml(state.editUnit, d.tasks[r.i], r.i, r.ind)).join("")}${fin ? finTotal(vis.map(r => d.tasks[r.i])) : ""}</tbody></table></div>` : (fin && !pf().q && !pf().pri && !pf().st && !pf().dep ? `<div class="empty"><b>No financial lines yet</b>Add revenue lines in Next plan or Monthly plan with the category Financial, and they appear here to fill in the actual.</div>` : noMatch)) : `<div class="empty"><b>No tasks yet for ${esc(unitName(state.editUnit))}</b>${ed ? "Add this week's tasks, or bring forward unfinished ones." : "Nothing entered for this week."}</div>`}
      ${planMode ? "" : `<div class="reports">
        <div><label for="f-wins">Key results this week</label><textarea id="f-wins" data-r="wins" placeholder="What was achieved" ${rdis}>${esc(d.wins)}</textarea></div>
        <div><label for="f-blockers">Blockers and issues</label><textarea id="f-blockers" data-r="blockers" placeholder="What is stopping progress" ${rdis}>${esc(d.blockers)}</textarea></div>
        <div><label for="f-asks">Asks to top management or other units</label><textarea id="f-asks" data-r="asks" placeholder="Decision, approval or support needed, and by when" ${rdis}>${esc(d.asks)}</textarea></div>
      </div>`}
      ${ed ? saveBar(meta) : `<div class="save-bar"><span class="small muted">${meta}</span></div>`}
    </div>`;
  }

  // ---------- approvals (Group Strategy) ----------
  function patchRows(r){
    return (r.patch || []).map(o => {
      if (o.op === "submit") return `<tr><td><span class="pill s-prog">Plan submitted</span></td><td colspan="3">${o.kind === "month" ? `Monthly plan ${mpLabelOf(o.key)} with ${o.n} result${o.n === 1 ? "" : "s"}` : `${o.n} task${o.n === 1 ? "" : "s"} for the week`}. Approving accepts the plan as it stands. <button class="btn small" data-review-sub="${esc(r.id)}">Open the plan</button></td></tr>`;
      if (o.op === "add") return `<tr><td><span class="pill s-done">Add</span></td><td colspan="3">${esc(o.task.title)}</td></tr>`;
      if (o.op === "remove") return `<tr><td><span class="pill s-bad">Remove</span></td><td colspan="3">${esc(o.task.title)}</td></tr>`;
      if (o.op === "text") return `<tr><td><span class="pill s-none">${esc(({ wins: "Key results", blockers: "Blockers", asks: "Asks" })[o.f])}</span></td><td></td><td class="small muted">${esc(o.from || "–")}</td><td class="small">${esc(o.to || "–")}</td></tr>`;
      return `<tr><td><span class="pill ${LOCKED.includes(o.f) ? "s-not" : "s-none"}">${esc(FLAB[o.f] || o.f)}</span></td><td class="small">${esc(short(o.title))}</td><td class="small muted">${esc(showF(o.f, o.from))}</td><td class="small"><b>${esc(showF(o.f, o.to))}</b></td></tr>`;
    }).join("");
  }
  function renderApprovals(){
    const pend = state.requests.filter(r => r.status === "pending").sort((x, y) => (x.createdAt || "") < (y.createdAt || "") ? -1 : 1), done = state.requests.filter(r => r.status !== "pending").slice(0, 30);
    const mine = pend.filter(r => canDecide(me, r)), others = pend.filter(r => !canDecide(me, r));
    const intro = canDecideAny() ? `<div class="banner info">Requests go to the person one step above the one who asked: employees and managers to their chief, chiefs to the planning head (Group Strategy in group functions). Approving applies the change to the plan and records it in the Activity log; rejecting leaves the plan unchanged and needs a written reason. The unit sees your comment.</div>`
      : `<div class="banner info">These changes are waiting for approval. Each one shows who has to decide it.</div>`;
    const card = r => { const dec = canDecide(me, r); return `<div class="panel req-card" style="margin-bottom:12px"><div class="panel-head"><div><div class="unit-name">${esc(reqTitle(r))} · <span class="muted">week of ${esc(weekLabel(r.week))}</span> <span class="pill s-none">${esc(KIND_LABEL[r.kind] || "Plan")}</span></div>
        <div class="small muted">Asked by <b>${esc(r.by || "?")}</b> on ${esc(fmt((r.createdAt || "").slice(0, 10)))} ${esc((r.createdAt || "").slice(11, 16))} UTC · ${esc(r.summary)}</div>
        <div class="small muted">Waiting for: <b>${esc(STAGE_LABEL[r.stage || "group"])}</b></div></div>
        ${dec ? `<div class="req-decide"><textarea id="note-${esc(r.id)}" data-req-note="${esc(r.id)}" rows="2" placeholder="Comment to the unit. Required when you reject, optional when you approve." aria-label="Comment to the unit">${esc(state.reqNotes[r.id] || "")}</textarea><div class="toolbar"><button class="btn danger" data-reject="${esc(r.id)}">Reject</button><button class="btn primary" data-approve="${esc(r.id)}">Approve</button></div></div>` : (canEdit(r.unit) ? `<button class="btn" data-withdraw="${esc(r.id)}">Withdraw</button>` : "")}</div>
      <div class="scroll"><table><thead><tr><th>Change</th><th>Task</th><th>Before</th><th>Proposed</th></tr></thead><tbody>${patchRows(r)}</tbody></table></div></div>`; };
    const hist = done.map(r => `<tr><td class="small num">${esc((r.decidedAt || r.createdAt || "").slice(0, 10))}</td><td class="small">${esc(reqTitle(r))}</td><td class="small">${esc(fmt(r.week))}</td><td class="small">${esc(r.summary)}<div class="muted">${esc(r.by)}</div></td><td><span class="pill ${r.status === "approved" ? "s-done" : r.status === "rejected" ? "s-bad" : "s-none"}">${esc(r.status)}</span></td><td class="small">${esc(r.decidedBy || "")}${r.note ? `<div class="muted">${esc(r.note)}</div>` : ""}</td></tr>`).join("");
    const sect = (title, list) => list.length ? `<h3 style="margin:18px 0 8px">${esc(title)} <span class="muted small">${list.length}</span></h3>${list.map(card).join("")}` : "";
    return `${intro}${pend.length ? (canDecideAny() ? sect("Waiting for you", mine) + sect("Waiting for someone else", others) : pend.map(card).join("")) : `<div class="panel" style="margin-bottom:16px"><div class="empty"><b>Nothing waiting for approval</b>Requests appear here as soon as someone submits one.</div></div>`}
      <div class="panel" style="margin-top:16px"><div class="panel-head"><h2>Recent decisions</h2></div>${hist ? `<div class="scroll"><table><thead><tr><th>When</th><th>Department</th><th>Week</th><th>Request</th><th>Result</th><th>By / comment</th></tr></thead><tbody>${hist}</tbody></table></div>` : `<div class="empty"><b>No decisions yet</b></div>`}</div>`;
  }
  async function decide(id, approve){
    const r = state.requests.find(x => x.id === id); if (!r) return;
    let plan = null;
    try {
      if (approve) { const s = await db.doc(`plans/${planId(r.week, r.unit)}`).get(); const cur = s.exists ? s.data() : { tasks: [], wins: "", blockers: "", asks: "" }; plan = applyOps(cur, r.patch || [], { at: new Date().toISOString(), by: r.by || "" }); plan.week = r.week; plan.unit = r.unit; plan.source = `Approved request from ${r.by}`; }
      const res = await api.decideRequest(auth(), id, approve, state.reqNotes[id] || "", plan);
      toast(res.error ? errText(res) : approve ? "Approved and recorded" : "Rejected"); delete state.reqNotes[id];
    } catch (e) { toast(errText(e)); }
  }

  // ---------- version history and restore ----------
  async function openHistory(){
    if (!state.editUnit || isAll()) return;
    const id = planId(state.week, state.editUnit);
    state.history = { id, loading: true, list: [], preview: null }; renderHistory();
    try {
      const snap = await db.collection("history").where("rowId", "==", id).orderBy("at", "desc").limit(60).get();
      state.history.list = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(h => h.tbl === "plans");
    } catch (e) { state.history.error = true; }
    state.history.loading = false; renderHistory();
  }
  function renderHistory(){
    const root = $("#modalRoot"), h = state.history; if (!h) { if (!state.bf) root.innerHTML = ""; return; }
    const cur = state.plans[state.editUnit];
    const rows = h.list.map(v => { const p = planFromRow(v.old), s = summarize(p); return `<tr class="${h.preview === v.id ? "sel" : ""}"><td class="small num">${esc(v.at.slice(0, 10))} ${esc(v.at.slice(11, 16))} UTC</td><td class="small">${esc(p.updatedBy || p.source || "–")}</td><td class="small">${esc(v.by || "–")}</td><td class="num small">${s.total} · ${s.done} done</td><td><button class="btn small" data-hprev="${esc(v.id)}">View</button>${isAppr() ? ` <button class="btn small" data-hrestore="${esc(v.id)}">Restore</button>` : ""}</td></tr>`; }).join("");
    const pv = h.preview && h.list.find(v => v.id === h.preview), pp = pv && planFromRow(pv.old);
    root.innerHTML = `<div class="overlay"><div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="hTitle">
      <div class="panel-head"><div><h2 id="hTitle">History · ${esc(unitName(state.editUnit))} · ${esc(weekLabel(state.week))}</h2><div class="small muted">A copy is kept automatically every time this plan is changed. ${isAppr() ? "Restore puts a copy back; the current version is kept as a copy too, so a restore can be undone." : "You can restore copies of your own unit\u2019s plan (managers: own departments only) for the current and future weeks. The current version is kept as a copy too."}</div></div><button class="icon-btn" id="hClose" aria-label="Close">×</button></div>
      <div class="small" style="padding:10px 16px">Current version: ${cur && cur.updatedAt ? `saved ${esc(cur.updatedAt.slice(0, 16).replace("T", " "))} UTC by ${esc(cur.updatedBy || cur.source || "data load")}` : "not saved"}</div>
      ${h.loading ? `<div class="empty"><b>Loading history…</b></div>` : h.error ? `<div class="banner warn" style="margin:16px">History is not available yet. Run supabase/upgrade-1-safe.sql first.</div>` : rows ? `<div class="scroll"><table><thead><tr><th>Copy taken</th><th>Version saved by</th><th>Replaced by</th><th>Tasks</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><b>No earlier versions</b>Copies appear after the first change to this plan.</div>`}
      ${pp ? `<div class="panel-head" style="border-top:1px solid var(--line)"><h2>Copy from ${esc(pv.at.slice(0, 16).replace("T", " "))} UTC</h2></div><div class="scroll" style="max-height:320px;overflow:auto"><table><thead><tr><th>Task</th><th>Status</th><th>%</th><th>Notes</th></tr></thead><tbody>${pp.tasks.map(t => `<tr><td>${esc(t.title)}</td><td><span class="pill ${statusClass(t.status)}">${esc(t.status || "No status")}</span></td><td class="num small">${t.pct ?? "–"}</td><td class="small muted">${esc(t.notes)}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No tasks</td></tr>`}</tbody></table></div>` : ""}
      </div></div>`;
  }

  // ---------- units, PINs and backups (approvers) ----------
  function renderUnits(){
    const rows = sortedUnits().map(u => `<tr>
      <td><input type="text" id="u-name-${esc(u.id)}" data-unit-name="${esc(u.id)}" value="${esc(u.name)}" aria-label="Unit name"></td>
      <td><select data-unit-type="${esc(u.id)}" id="u-type-${esc(u.id)}" aria-label="Unit type"><option ${u.type==="Corporate function"?"selected":""}>Corporate function</option><option ${u.type==="Business unit"?"selected":""}>Business unit</option></select></td>
      <td>${state.confirmDelete==="unit:"+u.id ? `<span class="confirm">Remove unit? Past plans stay saved. <button class="btn danger" data-unit-del-yes="${esc(u.id)}">Remove</button><button class="btn" data-del-no>Cancel</button></span>` : `<button class="btn ghost danger" data-unit-del="${esc(u.id)}">Remove</button>`}</td></tr>`).join("");
    return `<div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h2>Reporting units</h2><span class="muted small">Group Strategy only. People are assigned to units in the People tab.</span></div>
      <div class="scroll"><table><thead><tr><th>Name</th><th>Type</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="save-bar"><div class="toolbar"><input type="text" id="newUnitName" placeholder="New unit name"><select id="newUnitType"><option>Corporate function</option><option>Business unit</option></select><button class="btn primary" id="addUnit">Add unit</button></div></div>
    </div>
    <div class="grid2 even">
      <div class="panel"><div class="panel-head"><h2>Backup and restore</h2></div>
        <div class="asks"><p class="small">Every change to a plan already keeps a copy (see <b>History</b> on each plan). For a full copy you can keep offline, download a backup file every week and store it on the shared drive.</p>
        <div class="toolbar" style="margin:10px 0"><button class="btn primary" id="backupBtn">Download full backup (JSON)</button></div>
        <p class="small"><b>Restore from a backup file</b> puts back every unit and plan in the file. Plans that change are kept in History first, so this can be undone.</p>
        <div class="toolbar"><input type="file" id="restoreFile" accept=".json,application/json"></div>
        ${state.restore ? `<div class="banner warn" style="margin:10px 0 0">${esc(state.restore.name)}: ${state.restore.units} units, ${state.restore.plans} plans, saved ${esc(state.restore.at || "?")}. <button class="btn danger" id="restoreGo" style="margin-left:6px">Restore now</button> <button class="btn" id="restoreCancel">Cancel</button></div>` : ""}</div></div>
    </div>`;
  }
  async function downloadBackup(){
    try {
      const [units, plans, activity, requests] = await Promise.all(["units", "plans", "activity", "change_requests"].map(t => api.readAll(t)));
      const conv = api.mode === "supabase";
      const b = { app: "WBG Weekly Activity Tracking", version: 2, savedAt: new Date().toISOString(), savedBy: myId,
        units: conv ? units.map(u => ({ id: u.id, name: u.name, type: u.type, order: u.sort_order, departments: u.departments, people: u.people })) : units,
        plans: conv ? plans.map(planFromRow) : plans, activity, requests };
      await save(`WBG tracker backup ${todayIso}.json`, JSON.stringify(b, null, 1), `Backup saved: ${b.units.length} units, ${b.plans.length} plans`);
    } catch (e) { toast("Could not make the backup: " + errText(e)); }
  }
  async function readRestore(file){
    try { const b = JSON.parse(await file.text()); if (!Array.isArray(b.units) || !Array.isArray(b.plans)) throw 0; state.restore = { name: file.name, data: b, units: b.units.length, plans: b.plans.length, at: (b.savedAt || "").slice(0, 16).replace("T", " ") }; }
    catch (e) { state.restore = null; toast("That is not a tracker backup file"); }
    render();
  }

  // Names are stored as typed (no account ids), so person placeholders are filled straight from the attribute.
  function fillPeople(){
    document.querySelectorAll("[data-person]").forEach(e => { const n = e.dataset.person; if (!n) return; e.textContent = /^u_[A-Za-z0-9]{22}$/.test(n) ? "Earlier user" : (e.hasAttribute("data-bare") ? n : `by ${n}`); });
  }

  function render(){
    renderHero();
    const main = $("#main");
    const active = document.activeElement && document.activeElement.id;
    let html = bannerMsg ? `<div class="banner warn">${esc(bannerMsg)}</div>` : "";
    if (!db) html += `<div class="banner warn">Not connected to the database, so plans cannot be loaded or saved.</div>`;
    if (!state.unitsLoaded || !state.plansLoaded) html += `<div class="panel"><div class="empty"><b>Loading weekly plans…</b>Fetching plans for ${esc(weekLabel(state.week))}.</div></div>`;
    else if (state.tab==="dashboard") html += renderDash();
        else if (state.tab==="update") html += renderUpdate();
    else if (state.tab==="plan") html += renderUpdate() + `<details class="panel imp-det" id="impDet" ${(state.impOpen || state.imp) ? "open" : ""}><summary><b>Import or export with Excel</b> <span class="small muted">download the template, fill it in, upload it</span></summary>${renderImport()}</details>`;
    else if (state.tab==="mplan") html += renderMplan();
    else if (state.tab==="tasks") html += renderTasks();
    else if (state.tab==="ceo") html += renderCeo();
    else if (state.tab==="follow") html += renderFollow();
    else if (state.tab==="monthly") html += renderMonthly();
    else if (state.tab==="support") html += X.renderSupport();
    else if (state.tab==="fb") html += X.renderFb();
    else if (state.tab==="activity") html += renderActivity();
    else if (state.tab==="approvals") html += renderApprovals();
    else if (state.tab==="units" && isAppr()) html += renderUnits();
    else if (state.tab==="people" && isAppr()) html += renderPeople();
    else if (state.tab==="units" || state.tab==="people") html += `<div class="panel"><div class="empty"><b>Group Strategy only</b>Only Group Strategy can manage units and people.</div></div>`;
    main.innerHTML = html;
    growAll();
    if (active) { const el = document.getElementById(active); if (el && el.focus) { el.focus(); if (el.setSelectionRange && el.type==="text") { const n = el.value.length; try { el.setSelectionRange(n,n); } catch(e){} } } }
    fillPeople(); fetchCarry(); fetchNext(); if (state.tab === "mplan") loadMp(); syncStick();
    if (state.panel) renderPanel();
    if (state.pendingOpen && state.plansLoaded && state.pendingOpen.week === state.week) { const po = state.pendingOpen; state.pendingOpen = null; const hit = ((state.plans[po.unit] || {}).tasks || []).find(t => t.ref === po.ref); if (hit) { state.panel = { u: po.unit, id: hit.id }; renderPanel(); } else toast("This task was not found in that week."); }
    if (state.pendingPanel && (state.tab === "update" || state.tab === "plan")) { const pp = state.pendingPanel; state.pendingPanel = null; if (panelDraft(pp.u) && panelDraft(pp.u).tasks.some(x => x.id === pp.id)) { state.panel = { u: pp.u, id: pp.id }; renderPanel(); } }
    if (state.tab === "dashboard") ensureDash();
  }
  function growAll(){ document.querySelectorAll("#main textarea.grow").forEach(grow); }
  function grow(el){ el.style.height = "auto"; el.style.height = Math.max(el.classList.contains("out-in") ? 50 : 62, el.scrollHeight + 2) + "px"; }
  // Next week's plans, for the "next week's plan not entered" reminder
  function fetchNext(){
    if (!db || state.tab !== "update" || state.week !== thisMonday()) return;
    const key = nextMonday(); if (state.nextKey === key) return; state.nextKey = key;
    db.collection("plans").where("week", "==", key).get().then(snap => { const m = {}; snap.docs.forEach(d => { const v = d.data(); if (v && v.unit) m[v.unit] = v; }); state.nextPlans = m; render(); }).catch(() => {});
  }

  // ---------- executive dashboard ----------
  function dashWeeks(){ const n = state.dash.range, out = []; for (let i = n - 1; i >= 0; i--) out.push(i ? (() => { let x = state.week; for (let k = 0; k < i; k++) x = prevWeekOf(x); return x; })() : state.week); return out; }
  async function ensureDash(){
    if (!db) return;
    const weeks = dashWeeks(), key = `${state.week}|${state.dash.range}`;
    if (state.dashKey === key) return; state.dashKey = key; state.dashData = null;
    try {
      const snap = await db.collection("plans").where("week", ">=", weeks[0]).where("week", "<=", state.week).get();
      const by = {}; snap.docs.forEach(d => { const v = d.data(); if (v && v.unit) (by[v.week] = by[v.week] || {})[v.unit] = v; });
      if (state.dashKey === key) { state.dashData = { weeks, by }; if (state.tab === "dashboard") render(); }
    } catch (e) { state.dashKey = ""; banner("Could not load the earlier weeks for the dashboard."); }
  }
  function renderDash(){
    if (!state.units.length) return `<div class="panel"><div class="empty"><b>No units set up yet</b></div></div>`;
    if (!state.dashData) return `<div class="panel"><div class="empty"><b>Collecting the last ${state.dash.range} weeks…</b></div></div>`;
    const lvl = ps => Object.fromEntries(Object.entries(ps || {}).map(([k, p]) => [k, levelPlan(p)]));
    const byAll = Object.fromEntries(Object.entries({ ...state.dashData.by, [state.week]: state.plans }).map(([w, ps]) => [w, lvl(ps)])), cat = state.dash.category || "";
    const by = !cat ? byAll : Object.fromEntries(Object.entries(byAll).map(([w, ps]) => [w, Object.fromEntries(Object.entries(ps || {}).map(([k, p]) => [k, p ? { ...p, tasks: (p.tasks || []).filter(t => (t.category || "") === cat) } : p]))]));
    const alerts = sortedUnits().flatMap(u => unitAlerts({ unit: u, plan: state.plans[u.id], weekPlans: state.plans, week: state.week, thisMonday: thisMonday(), today: todayIso, requests: [] })).sort((a, b) => levelRank[a.level] - levelRank[b.level]);
    const w = ($("#main").clientWidth || 1000);
    return renderDashboard({ weeks: state.dashData.weeks, byWeek: by, byWeekAll: byAll, units: sortedUnits(), week: state.week, today: todayIso, filter: { ...state.dash, level: state.level },
      alerts: alerts.filter(a => (!state.dash.type || unitOf(a.unit).type === state.dash.type) && (!state.dash.units.length || state.dash.units.includes(a.unit))), pending: pendingFor().length, downloads, canUpdate: !!(me && !["executive"].includes(me.role)),
      width: w > 900 ? Math.floor((w - 16) * 2 / 3) - 34 : w - 34, unitName, h: { esc, fmt, weekLabel, toEth, ethMonth: w => ethName(toEth(w)), ethWeek: w => ethWeekLabel(w) } });
  }

  // ---------- plan submissions (a request to Group Strategy with a "submit" marker) ----------
  const subOf = (u, kind, key) => state.requests.filter(r => r.unit === u && (r.patch || []).some(o => o.op === "submit" && o.kind === kind && o.key === key)).sort((a, b) => (a.createdAt || "") < (b.createdAt || "") ? 1 : -1)[0] || null;
  const subPill = r => !r || r.status === "withdrawn" ? '<span class="pill s-none">Draft, not submitted</span>' : r.status === "pending" ? '<span class="pill s-not">Waiting for approval</span>' : r.status === "approved" ? '<span class="pill s-done">Approved</span>' : `<span class="pill s-bad" title="${esc(r.note || "")}">Sent back${r.note ? ": " + esc(r.note.length > 40 ? r.note.slice(0, 38) + "…" : r.note) : ""}</span>`;
  async function sendSubmit(u, week, kind, key, n, summary){
    try { const r = await api.requestChange(auth(), { id: newId(), unit: u, week, summary, details: [summary], patch: [{ op: "submit", kind, key, n }] }); toast(r.error ? errText(r) : "Submitted. Group Strategy will review it"); }
    catch (e) { toast(errText(e)); }
  }
  async function submitWeek(){
    const u = state.editUnit, w = state.week;
    if (!u || isAll() || !canEdit(u)) { toast("Sign in with this unit's PIN first"); return; }
    if (state.dirty) { toast("Save the plan first, then submit it"); return; }
    const n = (((state.plans[u] || {}).tasks) || []).length; if (!n) { toast("Add and save tasks before submitting"); return; }
    await sendSubmit(u, w, "week", w, n, `Plan for ${weekLabel(w)} submitted for approval (${n} task${n === 1 ? "" : "s"})`);
  }
  function reviewSubmission(id){
    const r = state.requests.find(x => x.id === id); if (!r) return; const o = (r.patch || []).find(x => x.op === "submit"); if (!o) return;
    if (state.dirty) { toast("Save or discard your open changes first"); return; }
    state.editUnit = r.unit; store.set("wp-unit", r.unit);
    if (o.kind === "month") { const [y, m] = o.key.split("-").map(Number); state.mp.Y = y; state.mp.m = m; state.mp.key = ""; state.tab = "mplan"; render(); return; }
    state.week = r.week; state.draft = null; state.allDrafts = null; state.tab = "plan"; subscribePlans(); render(); openUnit(r.unit, true);
  }

  // ---------- Monthly plan: the results of the month, broken down into weekly tasks ----------
  // Months are named in the Gregorian calendar but start on Ethiopian day 1 (Oct = 11 Oct – 9 Nov). A Saturday-to-Friday
  // week belongs to the month that holds the middle of the week (at least 4 of its 7 days).
  const ethShort = w => { const A = toEth(w), B = toEth(weekEndOf(w)), n = x => ETH_M[x.m - 1].slice(0, 3); return A.m === B.m ? `${n(A)} ${A.d}–${B.d}` : `${n(A)} ${A.d} – ${n(B)} ${B.d}`; };
  const mpWeeksOf = (Y, m) => rmWeeksAll(Y, m).filter(w => w >= WEEK_CUTOVER);
  const mpLabelOf = key => { const [y, m] = String(key).split("-").map(Number), r = ethMonthRange({ y, m }); return r.start ? `${RM_L[m]} ${parse(r.start).getFullYear()}` : String(key); };
  const MP_SPLIT = [["even", "Evenly"], ["front", "More early"], ["back", "More late"], ["custom", "Custom"]];
  const MP_KINDS = { target: "Target-based", phase: "Phase-based", task: "Task-based" };
  const MP_HELP = {
    target: "A number to reach each month, such as sales, ETB or visits. The month target is split over the weeks.",
    phase: "A result reached in stages, such as a project or rollout. Write the step planned each week and the progress % expected by the end of it.",
    task: "A result reached by doing tasks. Write the task planned each week and leave a week empty if nothing is planned."
  };
  const mpKindOf = t => (t && t.mpKind) || "target";
  function splitN(T, n, mode){
    if (!n) return [];
    const wts = mode === "front" ? Array.from({ length: n }, (_, i) => n - i) : mode === "back" ? Array.from({ length: n }, (_, i) => i + 1) : Array(n).fill(1);
    const sum = wts.reduce((a, b) => a + b, 0), raw = wts.map(w => T * w / sum), out = raw.map(Math.floor);
    const r = T - out.reduce((a, b) => a + b, 0), ord = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
    for (let k = 0; k < r; k++) out[ord[k % n][1]]++;
    return out;
  }
  state.mp = { Y: null, m: null, rows: [], key: "", loading: false, busy: false, dirty: false, ask: null, view: "plan" };
  function mpDefault(){
    const e = toEth(addDays(nextMonday(), 3));
    return FYM.find(f => f.y === e.y && f.m === e.m && mpWeeksOf(f.y, f.m).length) || FYM.find(f => mpWeeksOf(f.y, f.m).length) || FYM[3];
  }
  function mpCur(){ const mp = state.mp; if (!mp.Y || !mp.m) { const d = mpDefault(); mp.Y = d.y; mp.m = d.m; } return mp.m; }
  const mpWeeks = () => { mpCur(); return mpWeeksOf(state.mp.Y, state.mp.m); };
  const mpTag = () => { mpCur(); return `${state.mp.Y}-${state.mp.m}`; };
  const mpNew = kind => { const n = mpWeeks().length; return { id: "mp_" + uid(), kind, category: "Operational", title: "", dept: "", priority: "Medium", unit: "", vals: Array(n).fill(0), steps: Array(n).fill(""), pcts: Array(n).fill(""), total: 0, split: "even", saved: false, wk: Array.from({ length: n }, () => []) }; };
  async function loadMp(){
    const mp = state.mp, u = state.editUnit; if (!db || !u || isAll()) return;
    mpCur(); const key = `${u}|${mpTag()}|${mp.view}`; if (mp.key === key) return; mp.key = key; mp.loading = true; mp.rows = []; mp.dirty = false; render();
    const weeks = mpWeeks(), tag = mpTag(), n = weeks.length;
    try {
      const plans = await Promise.all(weeks.map(w => db.doc(`plans/${planId(w, u)}`).get().then(sn => sn.exists ? sn.data() : null)));
      if (mp.key !== key) return;
      const map = new Map();
      plans.forEach((pl, wi) => ((pl && pl.tasks) || []).forEach(t => {
        if (!t.mpId || t.mpMonth !== tag) return;
        const kind = mpKindOf(t);
        let r = map.get(t.mpId);
        if (!r) { r = { id: t.mpId, kind, category: t.category === "Revenue" ? "Revenue" : "Operational", title: t.mpTitle || t.title || "", dept: t.dept || "", priority: t.priority || "Medium", unit: kind === "target" ? (t.measure || "") : "", vals: Array(n).fill(0), steps: Array(n).fill(""), pcts: Array(n).fill(""), total: 0, split: "custom", saved: true, wk: Array.from({ length: n }, () => []) }; map.set(t.mpId, r); }
        r.wk[wi].push(t);
        if (kind === "target") r.vals[wi] = Number(t.target) || 0; else { r.steps[wi] = t.title || ""; r.pcts[wi] = t.mpPct === undefined || t.mpPct === null ? "" : t.mpPct; }
      }));
      map.forEach(r => { r.total = r.vals.reduce((a, b) => a + b, 0); r.split = MP_SPLIT.slice(0, 3).map(x => x[0]).find(m => splitN(r.total, n, m).join() === r.vals.join()) || "custom"; });
      mp.rows = [...map.values()];
    } catch (e) { mp.rows = []; }
    mp.loading = false; render();
  }
  // run an action that would throw away rows not yet created, after asking
  function mpGuard(label, fn){ const mp = state.mp; if (!mp.dirty) { fn(); return; } mp.ask = { label, fn }; render(); }
  // how far a result has got, worked out from its weekly tasks
  const taskPct = t => t.status === "Done" ? 100 : (typeof t.pct === "number" ? t.pct : 0);
  const fN = x => Number(x).toLocaleString("en-US", { maximumFractionDigits: 2 });
  function mpProg(r){
    const tasks = r.wk.flat(), done = tasks.filter(t => t.status === "Done" || taskPct(t) >= 100).length;
    if (r.kind === "target") {
      const ach = tasks.reduce((a, t) => a + (Number(t.actual) || 0), 0), T = Number(r.total) || 0;
      return { pct: T ? Math.min(100, Math.round(ach / T * 100)) : 0, text: `${fN(ach)} of ${fN(T)}${r.unit ? " " + r.unit : ""}`, done, n: tasks.length };
    }
    const idx = r.steps.map((s, k) => (String(s).trim() ? k : -1)).filter(k => k >= 0);
    let w = idx.map(() => 1);
    if (r.kind === "phase") {
      const cum = idx.map(k => (r.pcts[k] === "" || r.pcts[k] == null ? null : Number(r.pcts[k])));
      if (cum.every(x => x !== null)) w = cum.map((c, i) => Math.max(0, c - (i ? cum[i - 1] : 0)));
      if (!w.some(x => x > 0)) w = idx.map(() => 1);
    }
    const tot = w.reduce((a, b) => a + b, 0) || 1;
    const got = idx.reduce((a, k, i) => a + w[i] * (r.wk[k].length ? r.wk[k].reduce((s, t) => s + taskPct(t), 0) / r.wk[k].length : 0) / 100, 0);
    return { pct: Math.round(got / tot * 100), text: `${done} of ${idx.length} step${idx.length === 1 ? "" : "s"} done`, done, n: tasks.length };
  }
  // is a result row complete and consistent? { ok, text }
  function mpChk(r){
    if (r.kind === "target") {
      const sum = r.vals.reduce((a, b) => a + (Number(b) || 0), 0), T = Number(r.total || 0);
      return sum === T ? { ok: true, text: "Adds up" } : { ok: false, text: (sum > T ? "Over by " : "Short by ") + fN(Math.abs(sum - T)) };
    }
    const f = r.steps.map((s, k) => String(s).trim() ? k : -1).filter(k => k >= 0);
    if (!f.length) return { ok: false, text: "Add a step" };
    if (r.kind === "phase") {
      const p = f.map(k => r.pcts[k]).filter(x => x !== "" && x != null).map(Number);
      if (p.some(x => !(x >= 0 && x <= 100))) return { ok: false, text: "% is 0 to 100" };
      if (p.some((x, i) => i && x < p[i - 1])) return { ok: false, text: "% must not drop" };
    }
    return { ok: true, text: `${f.length} step${f.length === 1 ? "" : "s"}` };
  }
  const stCls = t => !t ? "s-none" : (t.status === "Done" || taskPct(t) >= 100) ? "s-done" : (t.status === "Blocked" ? "s-not" : (taskPct(t) > 0 || t.status === "In progress") ? "s-prog" : "s-none");
  function renderMplan(){
    if (!state.units.length) return `<div class="panel"><div class="empty"><b>No units yet</b></div></div>`;
    const mp = state.mp, m = mpCur(), Y = mp.Y, weeks = mpWeeks(), u = state.editUnit, ed = !!u && !isAll() && canEdit(u), track = mp.view === "track";
    const rng = ethMonthRange({ y: Y, m }), gy = rng.start ? parse(rng.start).getFullYear() : "";
    const opts = sortedUnits().map(x => `<option value="${esc(x.id)}" ${x.id === u ? "selected" : ""}>${esc(x.name)}${x.id === myUnit() ? " (yours)" : ""}</option>`).join("");
    const pick = `<div class="toolbar"><label for="unitPick" class="small muted">Unit</label><select id="unitPick"><option value="">Choose your function or unit…</option>${opts}</select></div>`;
    const months = `<div class="seg mp-months" role="tablist">${FYM.map(f => { const off = !mpWeeksOf(f.y, f.m).length, r2 = ethMonthRange(f); return `<button type="button" role="tab" data-mpm="${f.y}-${f.m}" aria-selected="${f.y === Y && f.m === m}" ${off ? 'disabled title="Weeks before 10 Oct 2026 use the old Monday weeks, so they cannot be planned here"' : `title="${esc(RM_L[f.m])}: ${esc(fmt(r2.start))} – ${esc(fmt(r2.end))} (${esc(ETH_M[f.m - 1])} ${f.y} EC)"`}>${RM_S[f.m]}</button>`; }).join("")}</div>`;
    const view = `<div class="seg" role="tablist" aria-label="View"><button type="button" role="tab" data-mpv="plan" aria-selected="${!track}">Plan</button><button type="button" role="tab" data-mpv="track" aria-selected="${track}">Tracking</button></div>`;
    const sub = subOf(u, "month", mpTag()), subbed = sub && sub.status === "pending";
    const saved = mp.rows.filter(r => r.saved).length;
    const addMenu = `<details class="more"><summary class="btn">${ico(IC.plus)}Add result</summary><div class="more-menu mp-add">${Object.keys(MP_KINDS).map(k => `<button type="button" data-mpadd="${k}"><span><b>${MP_KINDS[k]}</b><span class="small muted mp-add-d">${esc(MP_HELP[k])}</span></span></button>`).join("")}</div></details>`;
    const acts = ed && !track ? `<button class="btn" type="button" id="mpTpl">${ico(IC.down)}Download template</button><label class="btn" title="Fill the template, then upload it here">${ico(IC.fwd)}Upload Excel<input type="file" id="mpFile" accept=".xlsx,.xls,.csv" hidden></label>${addMenu}<button class="btn" type="button" id="mpCancel" ${mp.dirty ? "" : "hidden"}>Cancel</button><button class="btn${mp.dirty ? " primary" : ""}" type="button" id="mpCreate" ${mp.busy || !mp.rows.length ? "disabled" : ""}>${mp.busy ? "Creating…" : "Create weekly plans"}</button><button class="btn${mp.dirty ? "" : " primary"}" type="button" id="mpSubmit" ${mp.dirty || !saved || subbed || mp.busy ? "disabled" : ""} title="${mp.dirty ? "Create the weekly plans first" : !saved ? "Nothing created yet" : subbed ? "Already waiting for approval" : "Send this month to Group Strategy for approval"}">${sub && sub.status !== "withdrawn" && sub.status !== "pending" ? "Submit again" : "Submit for approval"}</button>` : "";
    const wkList = weeks.map((w, k) => `W${k + 1} ${weekShort(w)}`).join(" · ");
    const top = `<div class="plan-top"><div class="plan-wk"><div class="weekban"><span class="pill out">MONTHLY PLAN</span><span class="wk-big">${RM_L[m]} ${gy}</span><span class="eth">${esc(fmt(rng.start))} – ${esc(fmt(rng.end))}</span>${u && !isAll() ? subPill(sub) : ""}</div>
      <div class="small muted plan-hint">${weeks.length ? `${weeks.length} week${weeks.length === 1 ? "" : "s"}: ${esc(wkList)}. The month starts on day 1 of the Ethiopian month and a week goes to the month holding most of its days.` : ""} ${track ? "Tracking shows how each result is being achieved, from the weekly updates." : "Plan each result once for the month and break it down into the weeks. Each week's piece lands in that week's plan, so people only update progress."}</div></div>
      <div class="toolbar plan-acts">${acts}</div></div>`;
    const bar = `<div class="plan-bar">${pick}${months}${view}</div>`;
    const ask = mp.ask ? `<div class="banner warn" style="margin:12px 16px 0"><b>You have results that are not created yet.</b> ${esc(mp.ask.label)} will throw them away. <button class="btn danger small" id="mpAskYes" style="margin-left:6px">Discard and continue</button> <button class="btn small" id="mpAskNo">Keep editing</button></div>` : "";
    if (!u || isAll()) return `${top}<div class="panel">${bar}<div class="empty"><b>Choose your unit</b>Pick the function or business unit whose month you want to plan.</div></div>`;
    if (!weeks.length) return `${top}<div class="panel">${bar}<div class="empty"><b>No Saturday weeks in ${RM_L[m]} yet</b>Weekly plans before 10 Oct 2026 use the old Monday weeks. Start from October.</div></div>`;
    const depts = (unitOf(u).departments || []), dis = ed ? "" : "disabled";
    if (track) {
      if (mp.loading) return `${top}<div class="panel">${bar}<div class="empty"><b>Loading the month…</b></div></div>`;
      if (!mp.rows.length) return `${top}<div class="panel">${bar}<div class="empty"><b>No results planned for ${RM_L[m]} yet</b>Switch to Plan and add the results of the month.</div></div>`;
      const pr = mp.rows.map(r => ({ r, p: mpProg(r) })), avg = Math.round(pr.reduce((a, x) => a + x.p.pct, 0) / pr.length), tN = pr.reduce((a, x) => a + x.p.n, 0), tD = pr.reduce((a, x) => a + x.p.done, 0);
      const strip = `<div class="mp-strip"><div><b>${avg}%</b><span class="small muted">Average result achieved</span></div><div><b>${pr.length}</b><span class="small muted">Results planned</span></div><div><b>${tD}/${tN}</b><span class="small muted">Weekly tasks done</span></div><div><b>${pr.filter(x => x.p.pct >= 100).length}</b><span class="small muted">Results fully achieved</span></div></div>`;
      const th = weeks.map((w, k) => `<th class="num">W${k + 1}<div class="eth-s">${esc(weekShort(w))}</div></th>`).join("");
      const tr = pr.map(({ r, p }) => `<tr><td class="c-task"><b>${esc(r.title)}</b><div class="small muted">${MP_KINDS[r.kind]}${r.dept ? " · " + esc(r.dept) : ""}${r.category === "Revenue" ? " · Financial" : ""}</div></td>
        <td><div class="mp-bar" title="${esc(p.text)}"><i style="width:${p.pct}%"></i></div><div class="small"><b>${p.pct}%</b> <span class="muted">${esc(p.text)}</span></div></td>
        ${r.wk.map((ts, k) => {
          if (r.kind === "target") { const pl = Number(r.vals[k]) || 0, ac = ts.reduce((a, t) => a + (Number(t.actual) || 0), 0); return `<td class="num" data-l="W${k + 1}">${pl ? `<span class="pill ${ts.length ? stCls(ts[0]) : "s-none"}" title="Actual against target for ${esc(weekShort(weeks[k]))}">${fN(ac)} / ${fN(pl)}</span>` : '<span class="muted">–</span>'}</td>`; }
          const t = ts[0]; if (!r.steps[k] || !String(r.steps[k]).trim()) return `<td class="num" data-l="W${k + 1}"><span class="muted">–</span></td>`;
          return `<td class="num" data-l="W${k + 1}"><span class="pill ${stCls(t)}" title="${esc(r.steps[k])}${r.pcts[k] !== "" ? " · planned " + r.pcts[k] + "% by week end" : ""}">${t ? taskPct(t) + "%" : "–"}</span><div class="eth-s mp-step">${esc(String(r.steps[k]).slice(0, 28))}</div></td>`;
        }).join("")}</tr>`).join("");
      return `${top}<div class="panel">${bar}${strip}<div class="scroll"><table class="mp-table mp-track"><thead><tr><th>Result</th><th>Achieved</th>${th}</tr></thead><tbody>${tr}</tbody></table></div></div>`;
    }
    const head = weeks.map((w, k) => `<th class="num">W${k + 1}<div class="eth-s">${esc(weekShort(w))}</div><div class="eth-s">${esc(ethShort(w))}</div></th>`).join("");
    const rows = mp.rows.map(r => {
      const c = mpChk(r), tgt = r.kind === "target";
      const cell = (k) => tgt
        ? `<td data-l="W${k + 1} ${esc(weekShort(weeks[k]))}"><input type="number" step="any" class="mp-n" data-mpw="${k}" value="${r.vals[k]}" aria-label="Week ${k + 1}" ${dis}></td>`
        : `<td class="mp-stepc" data-l="W${k + 1} ${esc(weekShort(weeks[k]))}"><input type="text" class="mp-s" data-mps="${k}" value="${esc(r.steps[k] || "")}" placeholder="${r.kind === "phase" ? "Step" : "Task"}" aria-label="Week ${k + 1} ${r.kind === "phase" ? "step" : "task"}" ${dis}>${r.kind === "phase" ? `<input type="number" min="0" max="100" class="mp-p" data-mpp="${k}" value="${r.pcts[k] === "" || r.pcts[k] == null ? "" : r.pcts[k]}" placeholder="%" aria-label="Progress % by end of week ${k + 1}" title="Progress expected by the end of this week" ${dis}>` : ""}</td>`;
      return `<tr data-mpr="${esc(r.id)}">
        <td data-l="Type"><span class="pill s-none mp-kind">${MP_KINDS[r.kind]}</span></td>
        <td data-l="Category"><select data-mpf="category" aria-label="Category" ${dis}><option value="Operational" ${sel(r.category !== "Revenue")}>Operational</option><option value="Revenue" ${sel(r.category === "Revenue")}>Financial</option></select></td>
        <td class="c-task" data-l="Result"><input type="text" data-mpf="title" value="${esc(r.title)}" placeholder="${r.kind === "target" ? "Result, task or product" : "Result to achieve this month"}" aria-label="Result" ${dis}></td>
        <td data-l="Department"><select data-mpf="dept" aria-label="Department" ${dis}><option value="">–</option>${depts.map(d => `<option ${sel(d === r.dept)}>${esc(d)}</option>`).join("")}</select></td>
        <td data-l="Priority"><select data-mpf="priority" aria-label="Priority" ${dis}>${["High", "Medium", "Low"].map(p => `<option ${sel(p === r.priority)}>${p}</option>`).join("")}</select></td>
        <td data-l="Unit">${tgt ? `<input type="text" class="mp-u" data-mpf="unit" value="${esc(r.unit || "")}" placeholder="${r.category === "Revenue" ? "ETB" : "unit"}" aria-label="Unit" ${dis}>` : '<span class="muted">–</span>'}</td>
        <td data-l="Month target">${tgt ? `<input type="number" step="any" class="mp-n" data-mpf="total" value="${r.total || ""}" aria-label="Month target" ${dis}>` : '<span class="muted">–</span>'}</td>
        <td data-l="Split">${tgt ? `<select data-mpf="split" aria-label="Split" ${dis}>${MP_SPLIT.map(o => `<option value="${o[0]}" ${sel(o[0] === r.split)}>${o[1]}</option>`).join("")}</select>` : '<span class="muted">–</span>'}</td>
        ${weeks.map((_, k) => cell(k)).join("")}
        <td data-l="Check"><span class="pill mp-chk ${c.ok ? "s-done" : "s-not"}">${esc(c.text)}</span></td>
        <td class="c-act">${!r.saved && ed ? `<button class="icon-btn ib bad" type="button" data-mprm="${esc(r.id)}" aria-label="Remove result" title="Remove result">${ico(IC.trash)}</button>` : ""}</td></tr>`;
    }).join("");
    const body = mp.loading ? `<div class="empty"><b>Loading the month…</b></div>` : mp.rows.length ? `<div class="scroll"><table class="mp-table"><thead><tr><th>Type</th><th>Category</th><th>Result</th><th>Department</th><th>Priority</th><th>Unit</th><th>Month target</th><th>Split</th>${head}<th>Check</th><th class="c-act"></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="empty"><b>No results planned for ${RM_L[m]} yet</b>${ed ? `Choose how each result is achieved, or download the template, fill it in and upload it.<div class="mp-kinds">${Object.keys(MP_KINDS).map(k => `<button class="mp-kindcard" type="button" data-mpadd="${k}"><b>${ico(IC.plus)}${MP_KINDS[k]}</b><span class="small muted">${esc(MP_HELP[k])}</span></button>`).join("")}</div>` : "Nobody has planned this month yet."}</div>`;
    const note = !ed ? `<div class="banner warn" style="margin:12px 16px 0"><b>View only.</b> Sign in with this unit's PIN to plan its month.</div>` : "";
    return `${top}<div class="panel">${bar}${note}${ask}${body}<div class="save-bar" id="mpBar" ${mp.dirty ? "" : "hidden"}><span class="small"><b style="color:var(--accent)">Not created yet.</b> Press Create weekly plans to put these into the weeks, or Cancel to drop them.</span><div class="toolbar"><button class="btn" type="button" id="mpCancel2">Cancel</button><button class="btn primary" type="button" id="mpCreate2" ${mp.busy ? "disabled" : ""}>Create weekly plans</button></div></div></div>`;
  }
  function mpRowOf(el){ const tr = el.closest("tr[data-mpr]"); return tr ? { tr, r: state.mp.rows.find(x => x.id === tr.dataset.mpr) } : {}; }
  function mpCheck(tr, r){
    const c = mpChk(r), p = tr.querySelector(".mp-chk"); if (!p) return;
    p.className = "pill mp-chk " + (c.ok ? "s-done" : "s-not"); p.textContent = c.text;
  }
  function mpInput(el){
    const { tr, r } = mpRowOf(el); if (!r) return false;
    const f = el.dataset.mpf, w = el.dataset.mpw, s = el.dataset.mps, p = el.dataset.mpp;
    if (!state.mp.dirty) { state.mp.dirty = true; ["mpCancel", "mpBar"].forEach(i => { const e = document.getElementById(i); if (e) e.hidden = false; }); const c = document.getElementById("mpCreate"), sb = document.getElementById("mpSubmit"); if (c) c.classList.add("primary"); if (sb) { sb.classList.remove("primary"); sb.disabled = true; } }
    if (w !== undefined) { r.vals[Number(w)] = el.value === "" ? 0 : Number(el.value); r.split = "custom"; const sp = tr.querySelector('[data-mpf="split"]'); if (sp) sp.value = "custom"; mpCheck(tr, r); return true; }
    if (s !== undefined) { r.steps[Number(s)] = el.value; mpCheck(tr, r); return true; }
    if (p !== undefined) { r.pcts[Number(p)] = el.value === "" ? "" : Number(el.value); mpCheck(tr, r); return true; }
    if (f === "total" || f === "split") {
      if (f === "total") r.total = el.value === "" ? 0 : Number(el.value); else r.split = el.value;
      if (r.split !== "custom") { r.vals = splitN(Number(r.total) || 0, r.vals.length, r.split); tr.querySelectorAll("[data-mpw]").forEach((x, k) => { x.value = r.vals[k]; }); }
      mpCheck(tr, r); return true;
    }
    r[f] = el.value; return true;
  }
  async function mpCreate(){
    const mp = state.mp, u = state.editUnit, weeks = mpWeeks(), tag = mpTag();
    if (!u || !canEdit(u)) { toast("Sign in with this unit's PIN first"); return; }
    if (state.dirty) { toast("Save or discard your open plan changes first"); return; }
    const rows = mp.rows.filter(r => (r.title || "").trim());
    if (!rows.length) { toast("Give each result a name"); return; }
    const bad = rows.filter(r => !mpChk(r).ok);
    if (bad.length) { toast(`${bad.length} result${bad.length === 1 ? "" : "s"} still need fixing (see the Check column)`); return; }
    mp.busy = true; render();
    let made = 0, upd = 0, req = 0;
    try {
      for (let wi = 0; wi < weeks.length; wi++) {
        const w = weeks[wi], snap = await db.doc(`plans/${planId(w, u)}`).get(), latest = snap.exists ? snap.data() : null;
        const plan = latest ? clone(latest) : { week: w, unit: u, tasks: [], wins: "", blockers: "", asks: "" }; plan.tasks = plan.tasks || []; let touched = false;
        rows.forEach(r => {
          const ex = plan.tasks.find(t => t.mpId === r.id), title = r.title.trim();
          if (r.kind === "target") {
            const v = Number(r.vals[wi]) || 0;
            if (ex) { if (ex.target !== v) { ex.target = v; touched = true; upd++; } const c = calcPct(ex); if (c !== null) ex.pct = c; }
            else if (v > 0) { plan.tasks.push({ id: uid(), mpId: r.id, mpMonth: tag, mpKind: "target", mpTitle: title, title, outcome: "", category: r.category, target: v, measure: r.unit || (r.category === "Revenue" ? "ETB" : ""), actual: "", dept: r.dept || "", owner: "", due: weekEndOf(w), priority: r.priority || "Medium", status: "Not started", pct: 0, notes: "", kind: "Task", depUnit: "", dep: "", ev: [] }); touched = true; made++; }
          } else {
            const step = String(r.steps[wi] || "").trim(), pc = r.kind === "phase" && r.pcts[wi] !== "" && r.pcts[wi] != null ? Number(r.pcts[wi]) : null;
            if (ex) { if (step && (ex.title !== step || (ex.mpPct ?? null) !== pc)) { ex.title = step; if (pc === null) delete ex.mpPct; else ex.mpPct = pc; ex.mpTitle = title; touched = true; upd++; } }
            else if (step) { const t = { id: uid(), mpId: r.id, mpMonth: tag, mpKind: r.kind, mpTitle: title, title: step, outcome: "Part of the result: " + title, category: r.category, target: "", measure: "", actual: "", dept: r.dept || "", owner: "", due: weekEndOf(w), priority: r.priority || "Medium", status: "Not started", pct: 0, notes: "", kind: "Task", depUnit: "", dep: "", ev: [] }; if (pc !== null) t.mpPct = pc; plan.tasks.push(t); touched = true; made++; }
          }
        });
        if (!touched) continue;
        const res = await persistPlan(u, w, latest, plan, { latest, source: "Monthly plan", action: "import", prefix: `Monthly plan ${RM_S[mpCur()]}: ` });
        if (res.error) throw Object.assign(new Error(res.error), { code: res.error });
        req += res.requested || 0;
      }
      toast([made ? `Created ${made} weekly task${made === 1 ? "" : "s"}` : "", upd ? `updated ${upd} task${upd === 1 ? "" : "s"}` : "", req ? `${req} change${req === 1 ? "" : "s"} sent for approval` : ""].filter(Boolean).join(" · ") || "Nothing changed");
      mp.key = ""; mp.dirty = false;
    } catch (e) { toast("Stopped part-way: " + errText(e) + " Check the weeks and press Create again."); }
    mp.busy = false; loadDraft(); render();
  }
  async function mpSubmit(){
    const mp = state.mp, u = state.editUnit; if (!u || !canEdit(u)) { toast("Sign in with this unit's PIN first"); return; }
    if (mp.dirty) { toast("Create the weekly plans first"); return; }
    const n = mp.rows.filter(r => r.saved).length; if (!n) { toast("Nothing created yet"); return; }
    const weeks = mpWeeks(), label = mpLabelOf(mpTag());
    await sendSubmit(u, weeks[0], "month", mpTag(), n, `Monthly plan ${label} submitted for approval (${n} result${n === 1 ? "" : "s"})`);
  }
  const normT = x => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  async function mpTemplate(){
    const u = state.editUnit; if (!u || isAll()) { toast("Choose a unit first"); return; }
    let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch (e) { toast("The Excel tool did not load. Reload the page and try again."); return; }
    const mp = state.mp, m = mpCur(), Y = mp.Y, weeks = mpWeeks(), unit = unitOf(u), depts = unit.departments || [];
    if (!weeks.length) { toast("This month has no Saturday weeks yet"); return; }
    const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet("Monthly plan", { views: [{ state: "frozen", ySplit: 1, xSplit: 3 }] }), info = wb.addWorksheet("Info"), lists = wb.addWorksheet("Lists", { state: "veryHidden" });
    const heads = ["Type", "Category", "Result", "Department", "Priority", "Unit", "Month target", "Split", ...weeks.map((w, k) => `W${k + 1} ${weekShort(w)} (${ethShort(w)})`), "Check"];
    ws.columns = heads.map((h, i) => ({ header: h, key: "c" + i, width: i === 2 ? 44 : i < 6 ? 16 : i === 7 ? 13 : i > 7 ? 26 : 14 }));
    const hr = ws.getRow(1); hr.font = { bold: true, color: { argb: "FF2A2208" } }; hr.alignment = { vertical: "middle", wrapText: true }; hr.height = 40;
    hr.eachCell(c => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5C518" } }; });
    const splitLbl = k => (MP_SPLIT.find(x => x[0] === k) || MP_SPLIT[0])[1];
    mp.rows.forEach(r => ws.addRow([MP_KINDS[r.kind], r.category === "Revenue" ? "Financial" : "Operational", r.title, r.dept, r.priority || "Medium", r.unit || "", r.kind === "target" ? (r.total || "") : "", r.kind === "target" ? splitLbl(r.split) : "",
      ...weeks.map((_, k) => r.kind === "target" ? r.vals[k] : ((r.steps[k] || "") + (r.kind === "phase" && r.pcts[k] !== "" && r.pcts[k] != null && r.steps[k] ? " | " + r.pcts[k] : "")))]));
    const LAST = Math.max(40, mp.rows.length + 25), W0 = 9, W1 = 8 + weeks.length, L1 = ws.getColumn(W0).letter, L2 = ws.getColumn(W1).letter;
    Object.values(MP_KINDS).forEach((x, i) => { lists.getCell(i + 1, 1).value = x; }); ["Operational", "Financial"].forEach((x, i) => { lists.getCell(i + 1, 2).value = x; }); MP_SPLIT.forEach((x, i) => { lists.getCell(i + 1, 3).value = x[1]; }); (depts.length ? depts : [""]).forEach((d, i) => { lists.getCell(i + 1, 4).value = d; }); ["High", "Medium", "Low"].forEach((x, i) => { lists.getCell(i + 1, 5).value = x; });
    wb.definedNames.add("Lists!$A$1:$A$3", "L_Type"); wb.definedNames.add("Lists!$B$1:$B$2", "L_Cat"); wb.definedNames.add("Lists!$C$1:$C$4", "L_Split"); wb.definedNames.add(`Lists!$D$1:$D$${Math.max(1, depts.length)}`, "L_Dept"); wb.definedNames.add("Lists!$E$1:$E$3", "L_Pri");
    const dv = (r, c, f, msg) => { ws.getCell(r, c).dataValidation = { type: "list", allowBlank: true, formulae: [f], showErrorMessage: true, error: msg }; };
    for (let r = 2; r <= LAST; r++) {
      dv(r, 1, "L_Type", "Pick Target-based, Phase-based or Task-based."); dv(r, 2, "L_Cat", "Pick Operational or Financial."); dv(r, 4, "L_Dept", "Pick a department of this unit."); dv(r, 5, "L_Pri", "Pick High, Medium or Low."); dv(r, 8, "L_Split", "Pick Evenly, More early, More late or Custom.");
      ws.getCell(r, W1 + 1).value = { formula: `IF(C${r}="","",IF(A${r}="Target-based",IF(SUM(${L1}${r}:${L2}${r})=G${r},"Adds up","Check"),IF(COUNTA(${L1}${r}:${L2}${r})>0,"OK","Add a step")))` };
    }
    [["Unit", u], ["Unit name", unit.name], ["Month", `${Y}-${m}`], ["Month name", mpLabelOf(`${Y}-${m}`)], [], ["How to fill this in"],
      ["1", "One row per result of the month. Type says how the result is achieved: Target-based, Phase-based or Task-based."],
      ["2", "Target-based: a number to reach (sales, ETB, visits). Fill Month target and Split, or type a number in each week. The weeks must add up to the Month target."],
      ["3", "Phase-based: a result reached in stages. In each week write the step planned, then a bar and the progress % expected by the end of that week. Example: Complete design | 30"],
      ["4", "Task-based: a result reached by doing tasks. In each week write the task planned. Leave a week empty if nothing is planned that week."],
      ["5", "Every step or task you write becomes a task in that week's plan, linked to the result, so people only update progress and the monthly Tracking view shows how each result was achieved."],
      ["6", "Do not change the header row or the Unit and Month cells on this sheet. Upload the file under Plans, Monthly plan, Upload Excel."],
      ["7", "Uploading only fills the table on screen. Nothing reaches the weekly plans until you press Create weekly plans."]].forEach(r => info.addRow(r));
    info.getColumn(1).width = 16; info.getColumn(2).width = 110; info.getRow(6).font = { bold: true };
    const buf = await wb.xlsx.writeBuffer();
    await save(`Monthly plan ${safeName(unit.name)} ${RM_S[m]} ${weeks[0].slice(0, 4)}.xlsx`, buf, "Template saved");
  }
  const parseStep = v => { const s = String(v ?? "").trim(); if (!s) return { s: "", p: "" }; const mm = s.match(/^(.*?)\s*[|(]\s*(\d{1,3}(?:\.\d+)?)\s*%?\s*\)?$/); return mm && mm[1].trim() ? { s: mm[1].trim(), p: Math.min(100, Number(mm[2])) } : { s, p: "" }; };
  async function mpUpload(file){
    const mp = state.mp, u = state.editUnit; if (!u || isAll()) { toast("Choose a unit first"); return; }
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const info = wb.SheetNames.find(n => /^info$/i.test(n));
      if (info) {
        const ir = XLSX.utils.sheet_to_json(wb.Sheets[info], { header: 1, raw: true, defval: "" }), g = k => { const r = ir.find(x => String(x[0]).toLowerCase() === k); return r ? String(r[1]).trim() : ""; };
        if ((g("unit") && g("unit") !== u) || (g("month") && g("month") !== mpTag())) { toast(`This file is for ${g("unit name") || g("unit")}, ${g("month name") || g("month")}. Open that unit and month first.`); return; }
      }
      const sn = wb.SheetNames.find(n => /monthly plan/i.test(n)) || wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: "" }), n = mpWeeks().length, depts = unitOf(u).departments || [];
      const num = v => { if (v === "" || v == null) return null; const x = Number(String(v).replace(/,/g, "")); return isFinite(x) ? x : null; };
      const isNew = /^type/i.test(String((rows[0] || [])[0] || "").trim());
      let added = 0, updated = 0, warn = 0;
      for (let i = 1; i < rows.length; i++) {
        const x = rows[i], title = String(x[isNew ? 2 : 1] || "").trim(); if (!title) continue;
        const o = isNew ? { type: x[0], cat: x[1], dept: x[3], pri: x[4], unit: x[5], total: x[6], spl: x[7], w0: 8 } : { type: "", cat: x[0], dept: x[2], pri: "", unit: "", total: x[3], spl: x[4], w0: 5 };
        const cells = x.slice(o.w0, o.w0 + n);
        let kind = /phase/i.test(String(o.type)) ? "phase" : /task/i.test(String(o.type)) ? "task" : /target/i.test(String(o.type)) ? "target" : (cells.some(c => String(c).trim() && num(c) === null) ? "task" : "target");
        const cat = /fin|rev/i.test(String(o.cat)) ? "Revenue" : "Operational";
        let dept = String(o.dept || "").trim(); const dm = depts.find(d => d.toLowerCase() === dept.toLowerCase()); if (dept && !dm) warn++; dept = dm || "";
        const pri = ["High", "Medium", "Low"].find(p => p.toLowerCase() === String(o.pri || "").trim().toLowerCase()) || "Medium";
        const row = mpNew(kind); Object.assign(row, { category: cat, title, dept, priority: pri });
        if (kind === "target") {
          const sp = String(o.spl || ""), splitIn = /early|front/i.test(sp) ? "front" : /late|back/i.test(sp) ? "back" : /custom/i.test(sp) ? "custom" : "even";
          const wk = cells.map(num); let total = num(o.total), vals, split;
          if (wk.some(v => v !== null)) { vals = wk.map(v => v || 0); const sum = vals.reduce((a, b) => a + b, 0); if (total === null) total = sum; split = splitIn === "custom" ? "custom" : (splitN(total, n, splitIn).join() === vals.join() ? splitIn : "custom"); }
          else { total = total || 0; split = splitIn === "custom" ? "even" : splitIn; vals = splitN(total, n, split); }
          Object.assign(row, { unit: String(o.unit || "").trim(), total, split, vals });
        } else {
          cells.forEach((c, k) => { const p = parseStep(c); row.steps[k] = p.s; row.pcts[k] = kind === "phase" ? p.p : ""; });
        }
        const ex = mp.rows.find(r => normT(r.title) === normT(title));
        if (ex) { const keep = { id: ex.id, saved: ex.saved, wk: ex.wk }; Object.assign(ex, row, keep); updated++; }
        else { mp.rows.push(row); added++; }
      }
      if (!added && !updated) { toast("No rows found. Use the template and keep its header row."); return; }
      mp.dirty = true; toast(`Loaded ${added + updated} result${added + updated === 1 ? "" : "s"} from the file${warn ? ` · ${warn} unknown department${warn === 1 ? "" : "s"} left blank` : ""}. Check them, then press Create weekly plans.`); render();
    } catch (e) { toast("Could not read that file. Use the template from this page."); }
  }

  // ---------- events ----------
  function setWeek(w){
    if (state.dirty) { toast("Save or discard your changes first"); return; }
    state.week = w; state.draft = null; state.allDrafts = null; subscribePlans();
  }
  const monthTab = () => state.tab === "monthly";
  $("#prevWeek").onclick = () => monthTab() ? shiftMonth(-1) : setWeek(prevWeekOf(state.week));
  $("#nextWeek").onclick = () => monthTab() ? shiftMonth(1) : setWeek(nextWeekOf(state.week));
  $("#thisWeek").onclick = () => { if (monthTab()) { state.eth = toEth(todayIso); loadMonth(); } else setWeek(state.tab === "plan" ? nextMonday() : thisMonday()); };
  document.querySelectorAll("nav.tabs button").forEach(b => b.onclick = () => { const to = b.dataset.tab; if (state.dirty && (to === "plan" || to === "update") && to !== state.tab) { const w = to === "plan" ? nextMonday() : thisMonday(); if (w !== state.week) { toast("Save or discard your changes first"); return; } }
    if (state.tab === "mplan" && to !== "mplan" && !state.mp.dirty) state.mp.key = "";
    state.tab = to; state.confirmDelete = null;
    if (to === "plan" && state.week < nextMonday() && !state.dirty) { state.week = nextMonday(); state.draft = null; state.allDrafts = null; subscribePlans(); }
    else if (to === "update" && state.week > thisMonday() && !state.dirty) { state.week = thisMonday(); state.draft = null; state.allDrafts = null; subscribePlans(); }
    if ((state.tab==="update"||state.tab==="plan") && !hasDraft()) loadDraft(); if (state.tab==="activity") subscribeActivity(); if (state.tab==="people") loadPeople(); if (state.tab==="monthly" && db && !state.monthLoading && (!state.monthData || state.monthKey !== `${state.eth.y}-${state.eth.m}${state.monthBasis}`)) { render(); loadMonth(); return; } render(); });

  document.addEventListener("click", e => { const rp = document.querySelector("details.reminders[open]"); if (rp && !e.target.closest("details.reminders")) rp.open = false; });
  const main = $("#main");
  main.addEventListener("click", e => {
    const mm = document.querySelector("details.more[open]"); if (mm && (!e.target.closest("details.more") || e.target.closest(".more-menu button"))) mm.open = false;
    const row = e.target.closest("tr.task-row");
    if (row && !e.target.closest("input, select, textarea, button, label, a, summary") && (state.tab === "update" || state.tab === "plan") && row.dataset.id) { openPanel(row.dataset.u + "|" + row.dataset.id); return; }
    const t = e.target.closest("button, tr[data-open-unit], tr[data-tgl], tr[data-ceotgl], .hbar-row[data-open-unit]");
    if (!t) return;
    if (t.id === "pfClear") { state.pf = { q: "", pri: "", st: "", dep: "", lvl: pf().lvl, kind: pf().kind }; render(); return; }
    if (t.dataset.ceotype !== undefined && t.closest(".seg")) { state.ceoType = t.dataset.ceotype; render(); return; }
    { const tr = t.closest("[data-ceotgl]"); if (tr && t.tagName === "TR") { const k = tr.dataset.ceotgl; state.ceoOpen.has(k) ? state.ceoOpen.delete(k) : state.ceoOpen.add(k); render(); return; } }
    if (t.dataset.ceoprep) { ceoPrep(t.dataset.u, Number(t.dataset.ceoprep)); return; }
    if (t.dataset.ceodo === "cancel") { state.ceoDraft = null; render(); return; }
    if (t.dataset.ceodo === "send") {
      const rows = ceoRows(), r = rows && rows.find(y => y.id === t.dataset.u), per = state.filter.period === "month" ? "month" : "week", x = r && ceoActions(r.a, per)[Number(t.dataset.i)], d = state.ceoDraft;
      if (!r || !x || !d) return;
      const sub = ($("#ceoSub") || {}).value || d.subject, body = ($("#ceoBody") || {}).value || d.body, due = ($("#ceoDue") || {}).value || d.due;
      if (!body.trim()) { toast("The letter is empty"); return; }
      ceoSend(r, x, { subject: sub, body, needsReply: d.needsReply, due }); return;
    }
    if (t.dataset.acttab) { state.actTab = t.dataset.acttab; render(); return; }
    if (t.dataset.lvl) { pf().lvl = t.dataset.lvl; render(); return; }
    if (t.dataset.kind) { pf().kind = t.dataset.kind; render(); return; }
    if (t.dataset.mpm !== undefined) { const [yy, mm] = t.dataset.mpm.split("-").map(Number); mpGuard("Changing the month", () => { state.mp.Y = yy; state.mp.m = mm; state.mp.key = ""; state.mp.dirty = false; render(); }); return; }
    if (t.dataset.mpv) { const v = t.dataset.mpv; if (v !== state.mp.view) mpGuard("Switching view", () => { state.mp.view = v; state.mp.key = ""; state.mp.dirty = false; render(); }); return; }
    if (t.id === "mpCancel" || t.id === "mpCancel2") { state.mp.key = ""; state.mp.dirty = false; state.mp.ask = null; render(); toast("Cancelled. The rows you had not created were dropped"); return; }
    if (t.id === "mpAskYes") { const a = state.mp.ask; state.mp.ask = null; state.mp.dirty = false; a && a.fn(); return; }
    if (t.id === "mpAskNo") { state.mp.ask = null; render(); return; }
    if (t.id === "mpCreate2") { mpCreate(); return; }
    if (t.id === "mpSubmit") { mpSubmit(); return; }
    if (t.id === "mpTpl") { mpTemplate(); return; }
    if (t.id === "submitPlan") { submitWeek(); return; }
    if (t.id === "tplTop") { state.impPrefill = true; downloadTemplate(); return; }
    if (t.dataset.reviewSub) { reviewSubmission(t.dataset.reviewSub); return; }
    if (t.dataset.mpadd) { state.mp.rows.push(mpNew(t.dataset.mpadd)); state.mp.dirty = true; render(); const inp = document.querySelector("tr[data-mpr]:last-child [data-mpf=title]"); inp && inp.focus(); return; }
    if (t.dataset.mprm) { state.mp.rows = state.mp.rows.filter(r => r.id !== t.dataset.mprm); render(); return; }
    if (t.id === "mpCreate") { mpCreate(); return; }
    if (t.dataset.tgl) { const k = t.dataset.tgl; state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k); render(); return; }
    if (t.matches("tr[data-open-unit], .hbar-row[data-open-unit]") || (t.dataset.openUnit && t.matches("button"))) { if (state.tab === "dashboard") { state.dash.units = [t.dataset.openUnit]; state.dash.pop = false; render(); window.scrollTo({ top: 0, behavior: "smooth" }); return; } openUnit(t.dataset.openUnit); return; }
    if (t.dataset.datt) { state.dash.att = t.dataset.datt; render(); return; }
    if (t.dataset.dtbl) { state.dash.tbl = t.dataset.dtbl; render(); return; }
    if (t.dataset.dper) { state.dash.period = t.dataset.dper; state.dash.range = t.dataset.dper === "quarter" ? 13 : 8; render(); ensureDash(); return; }
    if (t.id === "dPopBtn") { state.dash.pop = !state.dash.pop; render(); return; }
    if (t.dataset.dgrp) { const g = t.dataset.dgrp; state.dash.units = g === "all" ? [] : state.units.filter(u => (u.type || "") === g).map(u => u.id); render(); return; }
    if (t.dataset.goto) { goTab(t.dataset.goto); return; }
    if (t.dataset.unlock) { state.unlock.add(t.dataset.unlock); render(); const el = document.getElementById("t-title-" + t.dataset.unlock); if (el) el.focus(); toast("Edit the task. Saving sends the change to Group Strategy for approval."); return; }
    if (t.dataset.withdraw) { api.withdrawRequest(auth(), t.dataset.withdraw).then(r => toast(r.error ? errText(r) : "Request withdrawn")).catch(x => toast(errText(x))); return; }
    if (t.dataset.approve) { decide(t.dataset.approve, true); return; }
    if (t.dataset.reject) { const el = document.getElementById("note-" + t.dataset.reject); const v = (el ? el.value : state.reqNotes[t.dataset.reject] || "").trim(); if (!v) { toast("Write the reason for rejecting, so the unit knows what to fix"); if (el) el.focus(); return; } state.reqNotes[t.dataset.reject] = v; decide(t.dataset.reject, false); return; }
    if (t.dataset.ev) { openEvidence(t.dataset.ev); return; }
    if (t.dataset.evp) { viewEvidence({ path: t.dataset.evp, name: t.dataset.evn }); return; }
    if (t.dataset.evDel) { const [u, i, k] = t.dataset.evDel.split("|"); const task = planFor(u).tasks[Number(i)]; task.ev = (task.ev || []).filter((_, j) => j !== Number(k)); state.dirtyUnits.add(u); state.dirty = true; render(); return; }
    if (t.dataset.pe) { peopleClick(t); return; }
    if (t.dataset.undo) { state.undoAsk = t.dataset.undo; render(); return; }
    if (t.dataset.undoNo) { state.undoAsk = null; render(); return; }
    if (t.dataset.undoYes) { doUndoAct(t.dataset.undoYes); return; }
    if (t.id === "signInBtn") { showMenu(); return; }
    if (t.id === "histBtn") { openHistory(); return; }
    if (t.id === "backupBtn") { downloadBackup(); return; }
    if (t.id === "restoreCancel") { state.restore = null; render(); return; }
    if (t.id === "restoreGo") { doRestore(); return; }
    if (t.dataset.openTask) { openPanel(t.dataset.openTask); return; }
    if (t.dataset.kids) { const k = "kid:" + t.dataset.kids; state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k); render(); return; }
    if (t.id==="addUnplanned") { const nt = makeTask(state.editUnit, { unplanned: true }); render(); const el = document.getElementById("t-title-"+nt.id); el && el.focus(); return; }
    if (t.id==="addTask" || t.dataset.addUnit) { const u = t.dataset.addUnit || state.editUnit, nt = makeTask(u); render(); const el = document.getElementById("t-title-"+nt.id); el && el.focus(); }
    else if (t.id==="listsBtn") { state.showLists = !state.showLists; render(); }
    else if (t.id==="listsCancel") { state.showLists = false; render(); }
    else if (t.id==="addDeptBtn") addDept();
    else if (t.id==="addPersonBtn") addPerson();
    else if (t.dataset.deptDel) { state.confirmDelete = "dept:" + t.dataset.deptDel; render(); }
    else if (t.dataset.deptYes) removeDept(t.dataset.deptYes);
    else if (t.dataset.personDel) { state.confirmDelete = "person:" + t.dataset.personDel; render(); }
    else if (t.dataset.personYes) removePerson(Number(t.dataset.personYes));
    else if (t.id==="tplBtn") downloadTemplate();
    else if (t.id==="impGo") commitImport();
    else if (t.id==="impConfirm") { state.imp.confirmed = true; state.imp.needConfirm = false; commitImport(); }
    else if (t.id==="impNoConfirm") { state.imp.needConfirm = false; render(); }
    else if (t.id==="impClear") { state.imp = null; render(); }
    else if (t.id==="actXlsx") exportActivityXlsx();
    else if (t.dataset.drill) drill(t.dataset.drill);
    else if (t.id==="goNext") setWeek(nextMonday());
    else if (t.id==="bfBtn2") openBf();
    else if (t.id==="ovHigh") { state.ov.priority = state.ov.priority==="High" && !state.ov.status ? "" : "High"; state.ov.status = ""; render(); }
    else if (t.id==="ovDone") { state.ov.status = state.ov.status==="Done" && !state.ov.priority ? "" : "Done"; state.ov.priority = ""; render(); }
    else if (t.id==="ovNS") { state.ov.status = state.ov.status==="Not started" && !state.ov.priority ? "" : "Not started"; state.ov.priority = ""; render(); }
    else if (t.id==="ovAll") { state.ov.all = true; render(); }
    else if (t.id==="ovOpen") { const o = state.ov; state.filter = { ...newFilter(), unit: o.unit, priority: o.priority==="none" ? "" : o.priority, status: o.status, q: o.q }; state.tab = "tasks"; render(); }
    else if (t.id==="backMonthly") { state.tab = "monthly"; render(); }
    else if (t.dataset.chip) { const k = t.dataset.chip, f = state.filter; if (k==="statuses") { f.statuses = []; f.status = ""; } else if (k==="period") f.period = "week"; else f[k] = ""; render(); }
    else if (t.id==="tglAll") {}
    else if (t.id==="mRefresh") loadMonth();
    else if (t.id==="mPdf") exportMonthPdf();
    else if (t.id==="mXlsx") exportMonthXlsx();
    else if (t.id==="printBtn") window.print();
    else if (t.id==="saveBtn") saveDraft();
    else if (t.id==="discardBtn") { state.unlock = new Set(); loadDraft(); render(); toast("Changes discarded"); }
    else if (t.id==="carryBtn") openBf();
    else if (t.id==="reloadRemote") { loadDraft(); render(); }
    else if (t.dataset.del) { state.confirmDelete = t.dataset.del; render(); }
    else if (t.dataset.delYes !== undefined) { const [u, i] = t.dataset.delYes.split("|"); planFor(u).tasks.splice(Number(i),1); state.confirmDelete = null; state.dirty = true; state.dirtyUnits.add(u); render(); }
    else if (t.hasAttribute("data-del-no")) { state.confirmDelete = null; render(); }
    else if (t.id==="exportBtn") exportCsv();
    else if (t.id==="goUpdate") { const g = document.querySelector('#mainNav button[data-group="plans"]'); if (g) g.click(); else goTab("update"); }
    else if (t.id==="pdfBtn") { if (state.tab === "dashboard") printDashboard(); else exportPdf(); }
    else if (t.id==="xlsxAllBtn") exportXlsxAll();
    else if (t.id==="unitPdfBtn") exportUnitPdf();
    else if (t.id==="unitXlsxBtn") exportUnitXlsx();
    else if (t.id==="tasksPdfBtn") exportTasksPdf();
    else if (t.id==="tasksXlsxBtn") exportTasksXlsx();
    else if (t.dataset.copy) copyReminder(t.dataset.copy, t);
    else if (t.id==="addUnit") addUnit();
    else if (t.dataset.unitDel) { state.confirmDelete = "unit:"+t.dataset.unitDel; render(); }
    else if (t.dataset.unitDelYes) { const id = t.dataset.unitDelYes; state.confirmDelete = null; api.saveUnit(auth(), "remove", { id }, `Removed unit "${unitName(id)}"`).then(r => toast(r.error ? errText(r) : "Unit removed")).catch(x => toast(errText(x))); }
  });
  main.addEventListener("keydown", e => { const tr = e.target.closest("tr[data-open-unit]"); if (tr && (e.key==="Enter"||e.key===" ")) { e.preventDefault(); openUnit(tr.dataset.openUnit); } });
  main.addEventListener("input", e => {
    const el = e.target;
    if (el.dataset.mpf || el.dataset.mpw !== undefined || el.dataset.mps !== undefined || el.dataset.mpp !== undefined) { mpInput(el); return; }
    if (el.dataset.f) {
      const tr = el.closest("tr"), u = tr.dataset.u, i = Number(tr.dataset.i), f = el.dataset.f, task = planFor(u).tasks[i];
      if (f==="dept" && el.value==="__new__") { el.value = task.dept || ""; if (isAll()) { toast("Open the unit on its own to add a department"); return; } state.showLists = true; render(); setTimeout(() => { const n = $("#newDept"); n && n.focus(); }); return; }
      if (el.classList.contains("grow")) grow(el);
      const again = applyField(u, task, f, el);
      markDirty();
      if (again) render(); else if (tr.dataset.fin) refreshFin(tr, task);
    } else if (el.dataset.r) { state.draft[el.dataset.r] = el.value; state.dirtyUnits.add(state.editUnit); markDirty(); }
    else if (el.id==="fQ") { state.filter.q = el.value; render(); }
    else if (el.id==="pfQ") { pf().q = el.value; render(); }
    else if (el.id==="ovQ") { state.ov.q = el.value; render(); }
    else if (el.dataset.reqNote) { state.reqNotes[el.dataset.reqNote] = el.value; }
  });
  main.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches("textarea.title-in, textarea.out-in")) e.preventDefault(); });
  main.addEventListener("toggle", e => { if (e.target.id === "remPanel") state.remOpen = e.target.open; if (e.target.id === "impDet") state.impOpen = e.target.open; }, true);
  // chart tooltips: any element with data-tip
  const tip = document.createElement("div"); tip.className = "viz-tip"; tip.hidden = true; document.body.appendChild(tip);
  main.addEventListener("mouseover", e => { const el = e.target.closest("[data-tip]"); if (!el) return; tip.innerHTML = el.dataset.tip; tip.hidden = false;
    const svg = el.closest("svg"); if (svg && el.dataset.x) { const xh = svg.querySelector(".xhair"); if (xh) { xh.setAttribute("x1", el.dataset.x); xh.setAttribute("x2", el.dataset.x); xh.style.display = ""; } } });
  main.addEventListener("mousemove", e => { if (tip.hidden) return; const w = tip.offsetWidth, h = tip.offsetHeight; let x = e.clientX + 14, y = e.clientY + 14; if (x + w > innerWidth - 8) x = e.clientX - w - 14; if (y + h > innerHeight - 8) y = e.clientY - h - 14; tip.style.left = x + "px"; tip.style.top = y + "px"; });
  main.addEventListener("mouseout", e => { const el = e.target.closest("[data-tip]"); if (!el || (e.relatedTarget && el.contains(e.relatedTarget))) return; tip.hidden = true; const xh = el.closest("svg")?.querySelector(".xhair"); if (xh) xh.style.display = "none"; });
  main.addEventListener("change", e => {
    const el = e.target;
    if (el.dataset.pfl) { pf()[el.dataset.pfl] = el.value; render(); return; }
    if (el.dataset.pu) {
      const [pid, k] = el.dataset.pu.split("|"), q = x => document.querySelector(`[data-pu="${CSS.escape(pid)}|${x}"]`);
      if (k === "unit") q("departments").innerHTML = DEPT_OPTS(el.value, []);
      if (k === "role") q("title").hidden = el.value !== "executive";
      return;
    }
    if (el.id === "inv-role") { $("#inv-title").hidden = el.value !== "executive"; return; }
    if (el.id === "inv-unit") { $("#inv-dept").innerHTML = DEPT_OPTS(el.value, []); return; }
    if (el.id==="unitPick") {
      if (state.dirty) { el.value = state.editUnit || ""; toast("Save or discard your changes first"); return; }
      if (state.tab === "mplan" && state.mp.dirty) { const v = el.value; el.value = state.editUnit || ""; mpGuard("Changing the unit", () => { state.mp.key = ""; openUnit(v, true); }); return; }
      openUnit(el.value, true);
    } else if (el.id==="fUnit") { state.filter.unit = el.value; state.filter.dept = ""; render(); }
    else if (el.id==="fDept") { state.filter.dept = el.value; render(); }
    else if (el.id==="fStatus") { if (el.value !== "__multi__") { state.filter.status = el.value; state.filter.statuses = []; } render(); }
    else if (el.id==="fGroup") { state.filter.group = el.checked; render(); }
    else if (el.id==="fPeriod") { state.filter.period = el.value; if (el.value==="month" && (!state.monthData || state.monthKey !== `${state.eth.y}-${state.eth.m}${state.monthBasis}`)) loadMonth(); else render(); }
    else if (el.id==="ovPri") { state.ov.priority = el.value; render(); }
    else if (el.id==="ovSt") { state.ov.status = el.value; render(); }
    else if (el.id==="ovUnit") { state.ov.unit = el.value; render(); }
    else if (el.id==="fPri") { state.filter.priority = el.value; render(); }
    else if (el.id==="fKind") { state.filter.kind = el.value; render(); }
    else if (el.id==="fCat") { state.filter.category = el.value; render(); }
    else if (el.id === "dCat") { state.dash.category = el.value; render(); }
    else if (el.id === "dLevel" || el.id === "fLevel") { state.level = el.value; store.set("wp-level", el.value); render(); }
    else if (el.id==="impUnit") { state.impUnit = el.value; state.impDefaultUnit = el.value ? unitName(el.value) : ""; render(); }
    else if (el.id==="impPrefill") { state.impPrefill = el.checked; }
    else if (el.id==="impFile") { if (el.files && el.files[0]) readImportFile(el.files[0]); }
    else if (el.id==="impFileTop") { const f = el.files && el.files[0]; el.value = ""; if (f) { state.impUnit = state.editUnit || state.impUnit; state.impDefaultUnit = state.editUnit ? unitName(state.editUnit) : ""; readImportFile(f).then(() => { const d = document.getElementById("impDet"); d && d.scrollIntoView({ behavior: "smooth", block: "start" }); }); } }
    else if (el.id==="mpFile") { const f = el.files && el.files[0]; el.value = ""; if (f) mpUpload(f); }
    else if (el.id==="impMode") { state.imp.mode = el.value; state.imp.needConfirm = false; state.imp.confirmed = false; render(); }
    else if (el.id==="impDepts") { state.imp.newDepts = el.checked; }
    else if (el.id==="ceoDue" && state.ceoDraft) { const ta = $("#ceoBody"), old = fmtD(state.ceoDraft.due); state.ceoDraft.due = el.value; if (ta && el.value) ta.value = ta.value.split(old).join(fmtD(el.value)); }
    else if (el.id==="aWeek") { state.actWeek = el.value === thisMonday() ? "" : el.value; render(); }
    else if (el.id==="aUnit") { state.actFilter.unit = el.value; render(); }
    else if (el.id==="aWho") { state.actFilter.who = el.value; render(); }
    else if (el.id==="aAct") { state.actFilter.action = el.value; render(); }
    else if (el.id==="mBasis") { state.monthBasis = el.value; loadMonth(); }
    else if (el.id==="mDept") { state.monthByDept = el.checked; render(); }
    else if (el.dataset.unitName) { const v = el.value.trim(), id = el.dataset.unitName; if (v) api.saveUnit(auth(), "update", { id, name: v }, `Renamed unit to "${v}"`).then(r => toast(r.error ? errText(r) : "Unit renamed")); }
    else if (el.dataset.unitType) { const id = el.dataset.unitType; api.saveUnit(auth(), "update", { id, type: el.value }, `Unit type set to ${el.value}`).then(r => toast(r.error ? errText(r) : "Unit type updated")); }
    else if (el.dataset.evAdd) { if (el.files && el.files.length) addEvidence(el.dataset.evAdd, el.files); el.value = ""; }
    else if (el.id === "restoreFile") { if (el.files && el.files[0]) readRestore(el.files[0]); }
    else if (el.dataset.dunit) { const s = new Set(state.dash.units); el.checked ? s.add(el.dataset.dunit) : s.delete(el.dataset.dunit); state.dash.units = [...s]; render(); }
    else if (el.id === "dType") { state.dash.type = el.value; render(); }
    else if (el.id === "dRange") { state.dash.range = Number(el.value); render(); }
    else if (el.dataset.reqNote) { state.reqNotes[el.dataset.reqNote] = el.value; }
  });
  // Applies one edited field to a task. Shared by the table rows and the task panel. Returns true when the screen must be redrawn.
  function applyField(u, task, f, el){
    state.dirtyUnits.add(u);
    if (f==="pct") { const v = el.value==="" ? null : Math.max(0, Math.min(100, Number(el.value))); task.pct = v; if (v===100 && task.status!=="Done") { task.status = "Done"; statusSideEffects(task); return true; } return false; }
    if (f==="target" || f==="actual" || f==="measure" || f==="lower") {
      if (f==="lower") task.lower = el.checked; else if (f==="measure") task.measure = el.value; else task[f] = el.value === "" ? "" : Number(el.value);
      const c = calcPct(task);
      if (c !== null) { task.pct = c; if (c === 100 && task.status !== "Done") { task.status = "Done"; statusSideEffects(task); return true; } if (f !== "measure") { document.querySelectorAll(`#t-pct-${task.id}, #p-pct`).forEach(pe => { pe.value = c; }); } }
      return false;
    }
    if (f==="weight") { const w = Number(el.value); task.weight = isFinite(w) && w > 0 ? w : 1; return false; }
    if (f==="parent") { task.parent = el.value; return true; }
    task[f] = el.value;
    if (f==="status") { statusSideEffects(task); return true; }
    return false;
  }
  // Status drives the automatic fields: completion date, 100% on Done, and how long a task has been blocked.
  function statusSideEffects(t){
    if (t.status === "Done") { t.pct = 100; if (!t.completedAt) t.completedAt = todayIso; }
    else if (t.completedAt) t.completedAt = "";
    if (t.status === "Blocked") { if (!t.blockedSince) t.blockedSince = todayIso; } else if (t.blockedSince) t.blockedSince = "";
  }
  main.addEventListener("click", e => {
    const h = e.target.closest("th[data-sort]"); if (!h) return;
    const [scope, k] = h.dataset.sort.split(":"), cur = state.sort[scope] || {};
    state.sort[scope] = cur.k === k ? (cur.dir > 0 ? { k, dir: -1 } : { k: "", dir: 1 }) : { k, dir: 1 };
    render();
  });
  main.addEventListener("keydown", e => { const h = e.target.closest && e.target.closest("th[data-sort]"); if (h && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); h.click(); } });
  $("#bellBtn").onclick = bellMenu;
  // keep the floating Plans tabs and the table header just under the top bar
  function syncStick(){ const h = document.querySelector("header.topbar"), ph = document.querySelector(".wrap.pagehead"); const root = document.documentElement.style;
    root.setProperty("--tbh", (h ? h.offsetHeight : 56) + "px"); root.setProperty("--phh", (ph && getComputedStyle(ph).position === "sticky" ? ph.offsetHeight : 0) + "px"); }
  window.addEventListener("resize", syncStick);
  // ---------- Stage 4: top bar, grouped tabs, account menu, calendar picker ----------
  function renderNav(){
    const g = groupOf(state.tab);
    document.querySelectorAll("#mainNav button").forEach(b => b.setAttribute("aria-current", String(b.dataset.group === g)));
    const subs = (GROUPS[g] || []).filter(t => (t !== "approvals" || isAppr() || pendingFor().length || toDecide().length) && (t !== "ceo" || canFeedback(me)));
    const nb = X.badgeCount();
    $("#subNav").innerHTML = subs.length > 1 ? subs.map(t => `<button role="tab" data-sub="${t}" aria-selected="${t === state.tab}">${SUB_LABEL[t]}${t === "fb" && nb ? ` <span class="badge">${nb}</span>` : ""}${t === "approvals" && pendingFor().length ? ` <span class="badge">${pendingFor().length}</span>` : ""}</button>`).join("") : "";
    $("#subNav").hidden = !subs.length || subs.length < 2;
    const wb = $("#weekBtn"); if (wb) wb.classList.toggle("flat", state.tab === "dashboard" && false);
  }
  $("#mainNav").addEventListener("click", e => { const b = e.target.closest("button[data-group]"); if (!b) return; const g = b.dataset.group; if (groupOf(state.tab) === g) return; goTab(GROUPS[g][0]); });
  $("#subNav").addEventListener("click", e => { const b = e.target.closest("button[data-sub]"); if (b) goTab(b.dataset.sub); });
  function closeAcct(){ const m = $("#acctMenu"); if (m) m.remove(); }
  function acctMenu(){
    if ($("#acctMenu")) return closeAcct();
    if (!me) return showMenu();
    const m = document.createElement("div"); m.id = "acctMenu"; m.className = "acct-menu"; m.setAttribute("role", "menu");
    const role = roleText(me) + (me.unit ? " · " + unitName(me.unit) : "");
    m.innerHTML = `<div class="acct-who"><b>${esc(me.name)}</b><span class="small muted">${esc(me.email || "")}</span><span class="small muted">${esc(role)}</span></div>
      <button role="menuitem" data-a="profile">Profile and settings</button>
      ${isAppr() ? `<div class="acct-sep">Settings</div><button role="menuitem" data-a="units">Units</button><button role="menuitem" data-a="people">People and roles</button>` : ""}
      <button role="menuitem" data-a="activity">Activity log</button>
      <div class="acct-sep"></div><button role="menuitem" data-a="out">Sign out</button>`;
    document.body.append(m);
    m.onclick = async e => { const b = e.target.closest("button[data-a]"); if (!b) return; const a = b.dataset.a; closeAcct(); if (a === "profile") showMenu(); else if (a === "out") { await api.signOut(); location.reload(); } else goTab(a); };
  }
  document.addEventListener("click", e => { if ($("#acctMenu") && !e.target.closest("#acctMenu") && !e.target.closest("#whoBtn")) closeAcct(); if ($("#calPop") && !e.target.closest("#calPop") && !e.target.closest("#weekBtn")) closeCal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") { closeAcct(); closeCal(); closeSearch(); } });
  $("#whoBtn").onclick = acctMenu;
  $("#actBtn").onclick = () => goTab("activity");
  function closeSearch(){ const s = $("#srchPop"); if (s) s.remove(); }
  function openSearch(){
    if ($("#srchPop")) return closeSearch();
    const pop = document.createElement("div"); pop.id = "srchPop"; pop.className = "srch-pop"; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "Search tasks");
    pop.innerHTML = `<input id="srchIn" type="search" placeholder="Search tasks, references, owners" autocomplete="off"><div id="srchOut" class="srch-out small muted">Type to search the tasks in ${esc(weekLabel(state.week))}.</div>`;
    document.body.append(pop); const inp = pop.querySelector("#srchIn"); inp.focus();
    const run = () => {
      const q = inp.value.trim().toLowerCase(), out = pop.querySelector("#srchOut"); if (q.length < 2) { out.textContent = `Type to search the tasks in ${weekLabel(state.week)}.`; return; }
      const hits = []; state.units.forEach(u => (((state.plans[u.id] || {}).tasks) || []).forEach(t => { if (t.kind !== "KPI / OKR" && [t.title, t.ref, t.owner, t.dept].some(x => String(x || "").toLowerCase().includes(q))) hits.push({ u, t }); }));
      out.innerHTML = hits.length ? hits.slice(0, 12).map(h => `<button class="srch-hit" data-su="${esc(h.u.id)}" data-sr="${esc(h.t.ref || "")}"><b>${esc(h.t.title)}</b><span class="small muted">${esc(h.t.ref || "")} · ${esc(h.u.name)} · ${esc(h.t.status || "No status")}</span></button>`).join("") + (hits.length > 12 ? `<div class="small muted" style="padding:6px 10px">+${hits.length - 12} more. Narrow the search.</div>` : "") : "No tasks found.";
    };
    inp.oninput = run;
    pop.onclick = e => { e.stopPropagation(); const b = e.target.closest("[data-su]"); if (b) { closeSearch(); openTaskByRef(b.dataset.su, b.dataset.sr); } };
  }
  $("#srchBtn").onclick = openSearch;
  document.addEventListener("click", e => { if ($("#srchPop") && !e.target.closest("#srchPop") && !e.target.closest("#srchBtn")) closeSearch(); });

  // Calendar: pick any day to jump to its week (or any Ethiopian month on the monthly report)
  function closeCal(){ const c = $("#calPop"); if (c) c.remove(); }
  function openCal(){
    if ($("#calPop")) return closeCal();
    const pop = document.createElement("div"); pop.id = "calPop"; pop.className = "cal-pop"; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "Pick a week");
    const r = $("#weekBtn").getBoundingClientRect(); pop.style.top = (r.bottom + 8) + "px"; pop.style.right = Math.max(8, innerWidth - r.right - 60) + "px";
    document.body.append(pop);
    if (monthTab()) { let y = state.eth.y; const draw = () => { pop.innerHTML = `<div class="cal-head"><button data-y="-1" aria-label="Previous year">&lsaquo;</button><b>${y} EC</b><button data-y="1" aria-label="Next year">&rsaquo;</button></div><div class="cal-months">${ETH_M.map((n, i) => `<button data-m="${i + 1}" ${y === state.eth.y && i + 1 === state.eth.m ? 'aria-current="true"' : ""}>${n}</button>`).join("")}</div>`; };
      draw(); pop.onclick = e => { e.stopPropagation(); const b = e.target.closest("button"); if (!b) return; if (b.dataset.y) { y += +b.dataset.y; draw(); } else if (b.dataset.m) { state.eth = { y, m: +b.dataset.m }; closeCal(); loadMonth(); } }; return; }
    let cur = parse(state.week); cur = new Date(cur.getFullYear(), cur.getMonth(), 1);
    let cw = (() => { const e = toEth(addDays(state.week, 3)); return FYM.find(f => f.y === e.y && f.m === e.m) || FYM[3]; })();
    const MN = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const draw = () => {
      const y = cur.getFullYear(), mo = cur.getMonth(), first = new Date(y, mo, 1), lead = (first.getDay() + 1) % 7, days = new Date(y, mo + 1, 0).getDate(), cells = [];
      for (let i = 0; i < lead; i++) cells.push(""); for (let d = 1; d <= days; d++) cells.push(d);
      const sel = state.week, selEnd = weekEndOf(sel);
      pop.innerHTML = `<div class="cal-head"><button data-mo="-1" aria-label="Previous month">&lsaquo;</button><b>${MN[mo]} ${y}</b><button data-mo="1" aria-label="Next month">&rsaquo;</button></div>
        <div class="cal-grid"><span>Sa</span><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span>${cells.map(d => { if (!d) return "<i></i>"; const s = iso(new Date(y, mo, d)), inSel = s >= sel && s <= selEnd; return `<button data-d="${s}" class="${inSel ? "in" : ""}${s === todayIso ? " today" : ""}">${d}</button>`; }).join("")}</div>
        <div class="cal-byw"><div class="small muted">Or pick by week number</div><select data-cwm aria-label="Month">${FYM.map(f => { const r2 = ethMonthRange(f); return `<option value="${f.y}-${f.m}" ${f.y === cw.y && f.m === cw.m ? "selected" : ""}>${RM_S[f.m]} · ${esc(fmt(r2.start))} – ${esc(fmt(r2.end))}</option>`; }).join("")}</select><div class="cal-wks">${rmWeeksAll(cw.y, cw.m).map((w, k) => `<button type="button" data-cw="${w}" class="${w === state.week ? "in" : ""}" title="${esc(weekShort(w))}">W${k + 1}<small>${esc(weekShort(w))}</small></button>`).join("")}</div></div>
        <div class="cal-foot small muted">${esc(wkTag(state.week))}${fyWeek(state.week) ? " · fiscal week " + fyWeek(state.week) : ""} · ${esc(ethWeekLabel(state.week))} <button class="lnk" data-today="1">Today</button></div>`;
    };
    draw();
    pop.onchange = e => { const sl = e.target.closest("[data-cwm]"); if (sl) { const [y, m] = sl.value.split("-").map(Number); cw = { y, m }; draw(); } };
    pop.onclick = e => { e.stopPropagation(); const b = e.target.closest("button"); if (!b) return; if (b.dataset.mo) { cur = new Date(cur.getFullYear(), cur.getMonth() + +b.dataset.mo, 1); draw(); } else if (b.dataset.d) { closeCal(); setWeek(weekStartOf(b.dataset.d)); } else if (b.dataset.cw) { closeCal(); setWeek(b.dataset.cw); } else if (b.dataset.today) { closeCal(); $("#thisWeek").click(); } };
  }
  $("#weekBtn").onclick = openCal;

  function goTab(to){ const b = document.querySelector(`nav.tabs button[data-tab="${to}"]`); if (b) b.click(); }
  // A new empty task in a unit's draft; its reference number is requested right away.
  function makeTask(u, extra){
    const d = planFor(u);
    const nt = { id: uid(), title:"", outcome:"", dept: (me && ["manager","staff"].includes(me.role) && (me.departments||[]).length === 1) ? me.departments[0] : "", owner:"", due:"", priority:"Medium", status:"Not started", pct:0, notes:"", kind:"Task", depUnit:"", dep:"", ev:[], ...(extra || {}) };
    d.tasks.push(nt); state.dirty = true; state.dirtyUnits.add(u);
    api.allocRefs(auth(), u, 1).then(r => { if (!r.error && !nt.ref) { nt.ref = `${r.prefix}-${String(r.start).padStart(4, "0")}`; render(); } }).catch(() => {});
    return nt;
  }
  // ---------- task panel ----------
  // state.panel = { u, id }. Editable when this unit's draft is open for editing (This week's update / Next week's plan); otherwise read-only.
  const panelDraft = u => ((state.tab === "update" || state.tab === "plan") && (isAll() || state.editUnit === u)) ? planFor(u) : null;
  function panelTask(){
    const pn = state.panel; if (!pn) return null;
    const d = panelDraft(pn.u), src = d || state.plans[pn.u];
    const t = ((src || {}).tasks || []).find(x => x.id === pn.id);
    return t ? { t, tasks: src.tasks, editable: !!d && canEdit(pn.u) } : null;
  }
  function openPanel(spec){ const [u, id] = spec.split("|"); state.panel = { u, id }; renderPanel(); }
  function closePanel(){ state.panel = null; renderPanel(); render(); }
  function renderPanel(){
    const root = $("#panelRoot"); if (!root) return;
    const pk = panelTask();
    if (!pk) { root.innerHTML = ""; if (state.panel) state.panel = null; return; }
    const { t, tasks, editable } = pk, u = state.panel.u, ed = editable && rowEd(u, t), lk = ed && isLocked(u, t);
    const dis = ed ? "" : "disabled", ldis = (!ed || lk) ? "disabled" : "";
    const kids = t.ref ? tasks.filter(x => x.parent === t.ref) : [], roll = rollupOf(t, kids), auto = (hasTgt(t) && calcPct(t) !== null) || !!roll;
    const choices = parentChoices(tasks, t), parentOpts = `<option value="">None (a deliverable on its own)</option>` + choices.map(c => `<option value="${esc(c.ref)}" ${c.ref === t.parent ? "selected" : ""}>${esc(c.ref)} · ${esc(short(c.title))}</option>`).join("") + (t.parent && !choices.some(c => c.ref === t.parent) ? `<option value="${esc(t.parent)}" selected>${esc(t.parent)}</option>` : "");
    const act = document.activeElement, keep = act && root.contains(act) && act.id ? { id: act.id, s: act.selectionStart, e: act.selectionEnd } : null;
    const fld = (label, inner) => `<label class="pf"><span class="small muted">${label}</span>${inner}</label>`;
    const others = sortedUnits().filter(x => x.id !== u);
    const kidRows = kids.map(k => `<tr><td>${refChip(k, u) || '<span class="muted small">…</span>'}</td><td>${esc(k.title) || '<span class="muted">(no title)</span>'}</td><td class="small">${esc(k.owner || "")}</td><td><span class="pill ${statusClass(k.status)}">${esc(k.status || "No status")}</span></td><td><div class="prog"><div class="bar"><i style="width:${k.status === "Done" ? 100 : (k.pct || 0)}%"></i></div><span class="num">${k.status === "Done" ? 100 : (k.pct || 0)}%</span></div></td><td class="small">${ed && !lk ? `<input type="number" class="w-in" min="0.1" step="any" data-pk="${esc(k.id)}" value="${weightOf(k)}" aria-label="Weight of ${esc(k.ref || "task")}">` : weightOf(k)}</td></tr>`).join("");
    const ev = (t.ev || []).map((e, k) => `<div class="ev-line"><span>📎 ${esc(e.name)} <span class="small muted">${fmtSize(e.size || 0)}</span></span><span class="toolbar"><button class="btn small" type="button" data-pev="${k}">${canPreview(e.name) ? "View" : "Open"}</button><button class="btn small" type="button" data-pdl="${k}">Download</button>${ed ? `<button class="icon-btn" type="button" data-pevdel="${k}" aria-label="Remove ${esc(e.name)}">×</button>` : ""}</span></div>`).join("");
    const canSub = ed && t.ref && !t.parent;
    const locked = lk ? `<div class="small muted">🔒 Saved task: the title, outcome, type, department, due date and priority are fixed. Use <b>Request change</b> in the table to ask Group Strategy.</div>` : "";
    const pnState = state.panel, firstShow = !pnState.shown; pnState.shown = true;
    root.innerHTML = `<div class="scrim" id="pnOverlay"></div><aside class="side task-panel${firstShow ? " anim" : ""}" role="dialog" aria-modal="true" aria-label="Task ${esc(t.ref || "")}">
      <div class="panel-head"><div><div><span class="ref big">${esc(t.ref || "numbering…")}</span> ${t.parent ? `<span class="tag">↳ under ${esc(t.parent)}</span>` : ""} <span class="tag">${esc(unitName(u))}</span> ${t.carried ? '<span class="tag">carried</span>' : ""}</div></div>
        <div class="toolbar">${!ed && editable === false && state.tab !== "update" && state.tab !== "plan" && canEdit(u) && state.filter.period !== "month" && !state.panel.ro ? `<button class="btn" id="pnEdit">Edit in this week's update</button>` : ""}<button class="btn" id="pnPrint" type="button">Print</button><button class="icon-btn" id="pnClose" aria-label="Close">×</button></div></div>
      <div class="panel-body">
        ${locked}
        ${fld("Task", ed && !lk ? `<textarea class="grow" rows="2" id="p-title" data-pf="title">${esc(t.title)}</textarea>` : `<div class="p-val"><b>${esc(t.title) || "(no title)"}</b></div>`)}
        <div class="pgrid2">
          ${fld("Status", `<select id="p-st" data-pf="status" ${dis}><option value="">No status</option>${STATUSES.map(x => `<option ${sel(x === t.status)}>${x}</option>`).join("")}</select>`)}
          ${fld("% complete", `<input type="number" id="p-pct" data-pf="pct" min="0" max="100" step="5" value="${roll ? roll.pct : (t.pct ?? "")}" ${dis} ${auto ? "readonly" : ""}>`)}
          ${fld("Department", `<select id="p-dept" data-pf="dept" ${ldis}>${deptOptions(u, t).replace(/<option value="__new__">[^<]*<\/option>/, "")}</select>`)}
          ${fld("Priority", `<select id="p-pri" data-pf="priority" ${ldis}><option value="">Not set</option>${PRIORITIES.map(p => `<option ${sel(p === t.priority)}>${p}</option>`).join("")}</select>`)}
        </div>
        <div class="pgrid3">
          ${fld("Target", `<input type="number" step="any" id="p-target" data-pf="target" value="${t.target ?? ""}" ${dis}>`)}
          ${fld("Actual", `<input type="number" step="any" id="p-actual" data-pf="actual" value="${t.actual ?? ""}" ${dis}>`)}
          ${fld("Unit", `<input type="text" id="p-measure" data-pf="measure" value="${esc(t.measure || "")}" maxlength="20" placeholder="ETB, %" ${dis}>`)}
        </div>
        <div class="pf"><span class="small muted">Evidence</span>
          ${ev || '<div class="small muted">No files attached.</div>'}
          ${ed ? `<div><label class="btn small ev-add">📎 Attach<input type="file" multiple accept="${EVIDENCE.accept}" id="pnFile" hidden></label></div>` : ""}</div>
        ${fld("Note", `<textarea class="grow" rows="2" id="p-notes" data-pf="notes" placeholder="One line on where it stands" ${dis}>${esc(t.notes || "")}</textarea>`)}
        <details class="more-d" data-pd="more" ${pnState.more ? "open" : ""}><summary>More details <span class="small muted">outcome, owner, due date, type, links</span></summary>
          <div class="d-in">
            ${fld("Expected outcome", ed && !lk ? `<textarea class="grow" rows="2" id="p-outcome" data-pf="outcome">${esc(t.outcome || "")}</textarea>` : `<div class="p-val">${esc(t.outcome || "–")}</div>`)}
            <div class="pgrid2">
              ${fld("Owner", `<input type="text" id="p-owner" data-pf="owner" value="${esc(t.owner)}" ${dis}>`)}
              ${fld("Due", `<input type="date" id="p-due" data-pf="due" value="${esc(t.due)}" ${ldis}>`)}
              ${fld("Type", `<select id="p-kind" data-pf="kind" ${ldis}>${KINDS.map(k => `<option ${sel(k === (t.kind || "Task"))}>${k}</option>`).join("")}</select>`)}
              ${fld("Category", `<select id="p-cat" data-pf="category" ${dis}><option value="">–</option>${CATEGORIES.map(k => `<option value="${k}" ${sel(k === t.category)}>${catLabel(k)}</option>`).join("")}</select>`)}
              ${fld("Part of deliverable", `<select id="p-parent" data-pf="parent" ${ed && !lk && !kids.length ? "" : "disabled"}>${parentOpts}</select>`)}
              ${fld("Weight in it", `<input type="number" min="0.1" step="any" id="p-weight" data-pf="weight" value="${weightOf(t)}" ${ed && !lk ? "" : "disabled"} title="Used when this task is part of a deliverable. Default 1 = equal share.">`)}
              ${fld("Depends on (unit)", `<select id="p-depu" data-pf="depUnit" ${dis}><option value="">–</option>${others.map(x => `<option value="${esc(x.id)}" ${sel(x.id === t.depUnit)}>${esc(x.name)}</option>`).join("")}</select>`)}
              ${fld("Dependency", `<input type="text" id="p-dep" data-pf="dep" value="${esc(t.dep || "")}" ${dis}>`)}
              ${fld("Lower is better", `<input type="checkbox" id="p-lower" data-pf="lower" ${t.lower ? "checked" : ""} ${dis}>`)}
            </div>
            ${kids.length ? `<h3 class="p-h">Tasks under this deliverable <span class="small muted">· ${roll ? roll.pct + "% from " + roll.total + " task" + (roll.total === 1 ? "" : "s") + ", " + roll.done + " done" : ""}</span></h3><div class="scroll"><table><thead><tr><th>Ref</th><th>Task</th><th>Owner</th><th>Status</th><th>Done</th><th>Weight</th></tr></thead><tbody>${kidRows}</tbody></table></div>` : ""}
            ${canSub ? `<div><button class="btn" id="pnAddKid" type="button">＋ Add a task under this</button></div>` : ""}
          </div>
        </details>
        ${t.ref ? `<details class="more-d" data-pd="disc" ${pnState.disc ? "open" : ""}><summary>Discussion and feedback ${(pnState.comments && pnState.comments.length) ? `<span class="pill s-none">${pnState.comments.length}</span>` : ""}</summary><div class="d-in">${fbSection(u, t)}${threadSection(u, t)}</div></details>` : ""}
      </div>
      <div class="panel-foot toolbar">${editable ? `<button class="btn primary" id="pnSave" ${state.dirty ? "" : "disabled"}>Save plan</button>` : ""}<button class="btn" id="pnClose2">Close</button>${editable && state.dirty ? '<span class="small" style="color:var(--accent)"><b>Unsaved changes</b></span>' : ""}</div>
    </aside>`;
    root.querySelectorAll("textarea.grow").forEach(grow);
    if (t.ref && state.panel.loadedRef !== t.ref && !state.panel.loading) { const pn = state.panel; pn.loading = true; pn.loadedRef = t.ref; loadThread().finally(() => { pn.loading = false; }); }
    if (keep) { const el = document.getElementById(keep.id); if (el && el.focus) { el.focus(); try { if (keep.s != null) el.setSelectionRange(keep.s, keep.e); } catch (x) {} } }
  }
  // ----- feedback and corrective actions that belong to this task -----
  function fbSection(u, t){
    const { fbs, acts } = X.forTask(u, t.ref);
    const canAct = isAppr() || canLead(u), canFb = canFeedback(me);
    const fb = fbs.map(f => `<div class="fb-card${f.ackAt ? "" : " new"}"><div class="fb-top"><span class="pill ${f.from === "CEO" ? "s-bad" : f.from === "DCEO" ? "s-prog" : "s-done"}">${esc(f.from)}</span> <span class="small muted">${esc(fmt((f.createdAt || "").slice(0, 10)))}${f.by ? " · " + esc(f.by) : ""}</span></div><div class="fb-body">${esc(f.body)}</div>
      <div class="fb-foot small">${f.ackAt ? `<span class="muted">Acknowledged by ${esc(f.ackBy)} on ${esc(fmt(f.ackAt.slice(0, 10)))}</span>` : (canLead(u) ? `<button class="btn small" data-pfb-ack="${esc(f.id)}">Acknowledge</button> ` : '<span class="muted">Waiting for the unit to acknowledge</span>')}${canFb ? ` <button class="btn small ghost" data-pfb-edit="${esc(f.id)}">Edit</button>` : ""}${canAct ? ` <button class="btn small ghost" data-pact-from="${esc(f.id)}">Log a corrective action</button>` : ""}</div></div>`).join("");
    const ac = acts.map(a => { const late = a.due && a.due < todayIso && ["Open", "In progress"].includes(a.status); return `<div class="fb-card"><div class="fb-top"><span class="pill ${a.status === "Done" || a.status === "Closed" ? "s-done" : a.status === "In progress" ? "s-prog" : "s-not"}">${esc(a.status)}</span> <span class="small muted">${esc(a.source)}${a.owner ? " · " + esc(a.owner) : ""}${a.due ? ` · due ${esc(fmt(a.due))}${late ? " (overdue)" : ""}` : ""}</span></div>
      <div class="fb-body"><b>Issue:</b> ${esc(a.issue)}<br><b>Action:</b> ${esc(a.action)}</div><div class="fb-foot small"><button class="btn small ghost" data-pact-open="${esc(a.id)}">${canLead(u) ? "Open / update" : "View"}</button></div></div>`; }).join("");
    return `<h3 class="p-h">Feedback and corrective actions</h3>
      ${fb || ac ? fb + ac : '<div class="small muted">None linked to this task yet.</div>'}
      <div class="toolbar">${canFb ? '<button class="btn small" id="pnFb" type="button">＋ Give feedback on this task</button>' : ""}${canAct ? '<button class="btn small" id="pnAct" type="button">＋ Log a corrective action</button>' : ""}</div>`;
  }
  // ----- discussion with @mentions -----
  const mentionHtml = c => { let h = esc(c.body); (c.mentions || []).forEach(m => { const t = "@" + esc(m.name); h = h.split(t).join(`<b class="mention">${t}</b>`); }); return h.replace(/\n/g, "<br>"); };
  const stamp = at => { const d = new Date(at); return isNaN(d) ? "" : `${fmt(at.slice(0, 10))} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  function threadSection(u, t){
    const pn = state.panel, list = pn.comments;
    const body = list === null || list === undefined ? '<div class="small muted">Loading the discussion…</div>'
      : pn.threadErr ? `<div class="small muted">You cannot see the discussion of this task.</div>`
      : list.length ? list.map(c => `<div class="cmt${c.byId && c.byId === (me && me.id) ? " mine" : ""}"><div class="small"><b>${esc(c.by || "")}</b> <span class="muted">${esc(stamp(c.at))}</span></div><div class="cmt-body">${mentionHtml(c)}</div></div>`).join("") : '<div class="small muted">No comments yet. Start the discussion, and use @ to bring someone in.</div>';
    return `<h3 class="p-h">Discussion</h3><div class="cmt-list" id="pnThread">${body}</div>
      ${pn.threadErr ? "" : `<div class="cmt-new"><textarea id="p-comment" rows="3" placeholder="Write a comment. Type @ to mention someone." maxlength="4000">${esc(pn.draft || "")}</textarea><div id="pnSug" class="sug" hidden></div>
        <div class="toolbar"><button class="btn primary" id="pnPost" type="button">Post comment</button><span class="small muted">Mentioned people get a notification on the bell.</span></div></div>`}`;
  }
  async function loadThread(){
    const pn = state.panel, pk = panelTask(); if (!pn || !pk || !pk.t.ref) return;
    const ref = pk.t.ref, u = pn.u;
    try {
      const r = await api.taskComments(auth(), u, ref), pp = pn.people ? null : await api.mentionables(auth(), u);
      if (state.panel !== pn) return;
      pn.threadErr = r.error || ""; pn.comments = r.error ? [] : (r.comments || []); if (pp && !pp.error) pn.people = pp.people || [];
      pn.loadedRef = ref; renderPanel(); if (document.activeElement && document.activeElement.id === "p-comment") mentionSuggest();
      if (!r.error) api.readMentions(auth(), u, ref).then(() => refreshMentions()).catch(() => {});
    } catch (e) { if (state.panel === pn) { pn.comments = []; pn.threadErr = "x"; renderPanel(); } }
  }
  setInterval(() => { if (state.panel && !document.hidden && document.activeElement && document.activeElement.id !== "p-comment") loadThread(); }, 30000);
  function mentionSuggest(){
    const ta = $("#p-comment"), box = $("#pnSug"), pn = state.panel; if (!ta || !box || !pn) return;
    const before = ta.value.slice(0, ta.selectionStart), m = /@([^\s@]*)$/.exec(before);
    if (!m) { box.hidden = true; return; }
    const q = m[1].toLowerCase(), me_ = me && me.id;
    const hits = (pn.people || []).filter(p => p.id !== me_ && p.name.toLowerCase().includes(q)).slice(0, 6);
    box.innerHTML = hits.map(p => `<button type="button" class="sug-i" data-pm="${esc(p.id)}">${esc(p.name)} <span class="small muted">${esc(p.title || ROLE_LABEL[p.role] || p.role)}</span></button>`).join("") || '<div class="small muted" style="padding:6px 10px">No one found</div>';
    box.hidden = false;
  }
  async function postComment(){
    const pn = state.panel, pk = panelTask(); if (!pn || !pk) return;
    const body = (pn.draft || "").trim(); if (!body) { toast("Write a comment first"); return; }
    const mentions = Object.entries(pn.ment || {}).filter(([id, name]) => body.includes("@" + name)).map(([id]) => ({ id }));
    const b = $("#pnPost"); if (b) b.disabled = true;
    try {
      const r = await api.addComment(auth(), { unit: pn.u, ref: pk.t.ref, taskId: pk.t.id, week: state.week, body, mentions });
      if (r.error) { toast(errText(r)); if (b) b.disabled = false; return; }
      pn.draft = ""; pn.ment = {}; toast(mentions.length ? "Posted. The people you mentioned were notified." : "Posted"); await loadThread();
    } catch (e) { toast(errText(e)); if (b) b.disabled = false; }
  }
  // ----- the bell: mentions and approvals -----
  state.mentions = [];
  async function refreshMentions(){
    if (!me) return;
    try { const r = await api.myMentions(auth()); state.mentions = Array.isArray(r) ? r : []; } catch (e) { return; }
    renderHero();
  }
  setInterval(() => { if (me && !document.hidden) refreshMentions(); }, 60000);
  function openTaskByRef(unit, ref, week){
    const hit = ((state.plans[unit] || {}).tasks || []).find(t => t.ref === ref);
    if (hit) { state.pendingOpen = null; state.panel = { u: unit, id: hit.id }; renderPanel(); return; }
    if (week && week !== state.week) { if (state.dirty) { toast("Save or discard your changes first"); return; } state.pendingOpen = { unit, ref, week }; setWeek(week); return; }
    toast("This task is not in the week you are viewing, or you cannot see it.");
  }
  function openMsg(g){
    if (g.t === "approvals") goTab("approvals");
    else if (g.t === "menu") showMenu();
    else if (g.t === "fb") { if (state.fbv) { state.fbv.view = "feedback"; state.fbv.unit = g.unit || ""; state.fbv.from = ""; state.fbv.ack = ""; } goTab("fb"); }
    else if (g.t === "unit") { if (state.dirty) { toast("Save or discard your changes first"); return; } state.editUnit = g.unit; store.set("wp-unit", g.unit); if (g.week && g.week !== state.week) setWeek(g.week); goTab("update"); }
  }
  function closeBellMenu(){ const m = $("#bellMenu"); if (m) m.remove(); }
  function bellMenu(){
    if ($("#bellMenu")) { closeBellMenu(); return; }
    const np = pendingFor().length, ms = state.mentions;
    const items = ms.map((m, i) => `<button type="button" class="bm-i" data-bm="${i}"><b>${esc(m.by)}</b> mentioned you on <span class="ref">${esc(m.ref)}</span> <span class="small muted">${esc(unitName(m.unit))}</span><div class="small muted">${esc(m.snippet)}</div></button>`).join("");
    const nrr = state.rr ? state.rr.count : 0, nac = state.rr ? state.rr.access : 0, dec = unseenDecided();
    const rrItems = (isAppr() ? (nrr ? `<button type="button" class="bm-i" data-bm-people="1"><b>${nrr}</b> role request${nrr === 1 ? "" : "s"} waiting for your decision</button>` : "") + (nac ? `<button type="button" class="bm-i" data-bm-people="1"><b>${nac}</b> access request${nac === 1 ? "" : "s"} waiting</button>` : "") : "") + "";
    const groups = new Map(); toDecide().forEach(r => { const k = r.unit + "|" + (r.dept || ""); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    const appItems = [...groups.values()].map(g => { const r0 = g[0], kinds = {}; g.forEach(r => kinds[KIND_LABEL[r.kind] || "Plan"] = (kinds[KIND_LABEL[r.kind] || "Plan"] || 0) + 1);
      return `<button type="button" class="bm-i" data-bm-appr="1"><b>${esc(deptLabel(r0))}</b> · ${esc(unitName(r0.unit))} is asking for approval<div class="small muted">${Object.entries(kinds).map(([k, v]) => v + " " + k.toLowerCase() + (v === 1 ? "" : "s")).join(", ")} · from ${esc([...new Set(g.map(r => r.by))].join(", "))}</div></button>`; }).join("");
    const hist = msgList().slice(0, 40), nun = hist.filter(m => !m.read).length;
    const fyiItems = hist.length ? `<div class="bm-head small muted"><span>History</span>${nun ? `<button type="button" class="lnk" data-bm-allread="1">Mark all as read</button>` : ""}</div>` + hist.map(m => { const det = (m.det || []).map(x => `<div class="bm-d1"><b>${esc(new Date(x.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</b> ${esc(x.s)}${(x.d || []).map(l => `<div class="bm-dl">${esc(l)}</div>`).join("")}</div>`).join("");
      return `<div class="bm-wrap${m.read ? " bm-read" : " bm-new"}"><button type="button" class="bm-i" data-bm-msg="${esc(m.id)}">${m.read ? "" : '<span class="bm-dot" aria-label="New"></span>'}${m.html}<div class="small muted">${esc(fmt(String(m.ts || "").slice(0, 10)))}</div></button>${det ? `<button type="button" class="lnk bm-tgl" data-bm-tgl="1" aria-expanded="false">Show what changed</button><div class="bm-det" hidden>${det}</div>` : ""}</div>`; }).join("") : "";
    const m = document.createElement("div"); m.id = "bellMenu"; m.className = "bell-menu";
    m.innerHTML = `<div class="small muted" style="padding:8px 12px">Notifications</div>${items}${appItems}${fyiItems}${np && !canDecideAny() ? `<button type="button" class="bm-i" data-bm-appr="1"><b>${np}</b> change${np === 1 ? "" : "s"} waiting for approval</button>` : ""}${rrItems}${!items && !np && !rrItems && !appItems && !fyiItems ? '<div class="small muted" style="padding:10px 12px 14px">Nothing new.</div>' : ""}`;
    document.body.appendChild(m);
    const r = $("#bellBtn").getBoundingClientRect(); m.style.top = (r.bottom + 8) + "px"; m.style.right = Math.max(8, innerWidth - r.right) + "px";
    m.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; if (b.dataset.bmTgl) { const d = b.nextElementSibling, open = d.hidden; d.hidden = !open; b.setAttribute("aria-expanded", String(open)); b.textContent = open ? "Hide details" : "Show what changed"; return; } if (!b.dataset.bmAllread) closeBellMenu(); if (b.dataset.bmAppr) goTab("approvals"); else if (b.dataset.bmAllread) { markMsgsRead(); renderHero(); closeBellMenu(); bellMenu(); } else if (b.dataset.bmMsg) { const m = syncMsgs()[b.dataset.bmMsg]; markMsgsRead([b.dataset.bmMsg]); renderHero(); if (m) openMsg(m.go || {}); } else if (b.dataset.bmPeople) goTab("people"); else if (b.dataset.bmProf) { markSeenRR([b.dataset.bmProf]); renderHero(); showMenu(); } else { const x = state.mentions[Number(b.dataset.bm)]; if (x) openTaskByRef(x.unit, x.ref, x.week); } });
  }
  document.addEventListener("click", e => { if ($("#bellMenu") && !e.target.closest("#bellMenu") && !e.target.closest("#bellBtn")) closeBellMenu(); });
  const panelRoot = $("#panelRoot");
  if (panelRoot) {
    panelRoot.addEventListener("toggle", e => { const k = e.target.dataset && e.target.dataset.pd; if (k && state.panel) state.panel[k] = e.target.open; }, true);
    const pOn = () => panelTask();
    panelRoot.addEventListener("input", e => {
      if (e.target.id === "p-comment") { state.panel.draft = e.target.value; mentionSuggest(); return; }
      const el = e.target, pk = pOn(); if (!pk || !pk.editable) return;
      const u = state.panel.u;
      if (el.dataset.pk) { const k = pk.tasks.find(x => x.id === el.dataset.pk); if (k) { applyField(u, k, "weight", el); markDirty(); const b = $("#pnSave"); if (b) b.disabled = false; } return; }
      if (!el.dataset.pf) return;
      if (el.classList.contains("grow")) grow(el);
      const again = applyField(u, pk.t, el.dataset.pf, el);
      markDirty(); const b = $("#pnSave"); if (b) b.disabled = false;
      if (again) render();
    });
    panelRoot.addEventListener("click", async e => {
      if (e.target.id === "pnOverlay" || e.target.id === "pnClose" || e.target.id === "pnClose2") { closePanel(); return; }
      const b = e.target.closest("button"); if (!b) return;
      const pk = pOn(); if (!pk) return; const u = state.panel.u, t = pk.t;
      if (b.dataset.pm) { const pn = state.panel, ta = $("#p-comment"), person = (pn.people || []).find(p => p.id === b.dataset.pm); if (person && ta) { const pos = ta.selectionStart, before = ta.value.slice(0, pos).replace(/@[^\s@]*$/, ""), after = ta.value.slice(pos); ta.value = before + "@" + person.name + " " + after; pn.draft = ta.value; (pn.ment = pn.ment || {})[person.id] = person.name; ta.focus(); const at = (before + "@" + person.name + " ").length; ta.setSelectionRange(at, at); $("#pnSug").hidden = true; } return; }
      if (b.id === "pnPost") { postComment(); return; }
      if (b.id === "pnPrint") { printPanel(); return; }
      if (b.id === "pnFb") { X.openFeedback(u, t.ref, state.week); return; }
      if (b.id === "pnAct") { X.openAction(u, t.ref, t.title); return; }
      if (b.dataset.pfbAck) { X.ackFb(b.dataset.pfbAck); return; }
      if (b.dataset.pfbEdit) { X.openExisting("fb", b.dataset.pfbEdit); return; }
      if (b.dataset.pactOpen) { X.openExisting("act", b.dataset.pactOpen); return; }
      if (b.dataset.pactFrom) { const f = (X.forTask(u, t.ref).fbs || []).find(x => x.id === b.dataset.pactFrom) || {}; X.openAction(u, t.ref, t.title); setTimeout(() => { const i = document.getElementById("ac-issue"); if (i && !i.value) i.value = f.body || ""; }); return; }
      if (b.id === "pnSave") { await saveDraft(); renderPanel(); return; }
      if (b.id === "pnEdit") { const id = t.id; state.panel = null; renderPanel(); openUnit(u); state.pendingPanel = { u, id }; return; }
      if (b.id === "pnAddKid") { const nt = makeTask(u, { parent: t.ref, dept: t.dept || "", owner: t.owner || "", due: t.due || "", priority: t.priority || "Medium", category: t.category || "" }); state.panel = { u, id: nt.id }; render(); setTimeout(() => { const el = document.getElementById("p-title"); el && el.focus(); }); return; }
      const k = Number(b.dataset.pev ?? b.dataset.pdl ?? b.dataset.pevdel), file = (t.ev || [])[k];
      if (file && b.dataset.pev !== undefined) { viewEvidence(file); return; }
      if (file && b.dataset.pdl !== undefined) { downloadEvidence(file); return; }
      if (file && b.dataset.pevdel !== undefined) { t.ev = t.ev.filter((_, j) => j !== k); state.dirtyUnits.add(u); markDirty(); render(); return; }
    });
    panelRoot.addEventListener("change", e => {
      if (e.target.id === "pnFile" && e.target.files && e.target.files.length) { const pk = pOn(); if (pk) { const i = pk.tasks.indexOf(pk.t); addEvidence(`${state.panel.u}|${i}`, e.target.files).then(() => renderPanel()); } e.target.value = ""; }
    });
  }
  document.addEventListener("keydown", e => { if (e.key === "Escape" && state.panel && !$("#viewRoot").innerHTML) closePanel(); });
  function printPanel(){ document.body.classList.add("print-panel"); const done = () => { document.body.classList.remove("print-panel"); window.removeEventListener("afterprint", done); }; window.addEventListener("afterprint", done); window.print(); }
  function downloadEvidence(e){
    api.evidenceUrl(e.path, e.name).then(url => { const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; if (api.mode === "local") a.download = e.name; document.body.appendChild(a); a.click(); a.remove(); }).catch(() => toast("Could not open the file"));
  }
  function viewEvidence(e){
    openViewer($("#viewRoot"), { name: e.name, size: fmtSize(e.size || 0), getBlob: () => api.evidenceBlob(e.path), onDownload: () => downloadEvidence(e) });
  }
  async function openEvidence(spec){
    const [u, i, k] = spec.split("|"), e = ((planFor(u) || {}).tasks || [])[Number(i)]?.ev?.[Number(k)];
    if (e) viewEvidence(e);
  }
  async function addEvidence(spec, files){
    const [u, i] = spec.split("|"), task = planFor(u).tasks[Number(i)];
    if (!canEdit(u) || !task) return;
    files = [...files];
    if (files.length > EVIDENCE.maxFiles) { toast(`Attach up to ${EVIDENCE.maxFiles} files at once.`); return; }
    const total = files.reduce((a, f) => a + f.size, 0);
    if (total > EVIDENCE.maxTotal) { toast(`These files add up to ${fmtSize(total)}. The limit is ${fmtSize(EVIDENCE.maxTotal)} at once.`); return; }
    const bad = files.find(f => !fileType(f)); if (bad) { toast(`"${bad.name}" is not an allowed type. Use PDF, images, Word, Excel, PowerPoint, text or CSV.`); return; }
    toast(`Uploading ${files.length} file${files.length > 1 ? "s" : ""}…`);
    try {
      for (const f of files) {
        const safe = f.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
        const path = `${state.week}/${u}/${task.id}/${uid()}-${safe}`;
        await api.uploadEvidence(f, path);
        (task.ev = task.ev || []).push({ id: uid(), name: f.name, size: f.size, type: fileType(f), path, by: myId || "", at: new Date().toISOString() });
      }
      state.dirtyUnits.add(u); state.dirty = true; render(); toast("Attached. Save the plan to keep the evidence with the task.");
    } catch (e) { render(); toast("Upload failed: " + (e.message || "check your connection")); }
  }
  async function doRestore(){
    const r = state.restore; if (!r) return;
    try { const res = await api.restoreBackup(auth(), r.data); toast(res.error ? errText(res) : `Restored ${res.units} units and ${res.plans} plans`); state.restore = null; state.dashKey = ""; render(); }
    catch (e) { toast(errText(e)); }
  }
  function markDirty(){
    if (!state.dirty) { state.dirty = true; const bar = document.querySelector(".save-bar span"); if (bar) bar.innerHTML = "<b style='color:var(--accent)'>Unsaved changes</b>"; ["saveBtn","discardBtn"].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = false; }); }
  }
  function openUnit(id, stay){
    if (state.dirty && id !== state.editUnit) { toast("Save or discard your changes first"); return; }
    state.editUnit = id || null; store.set("wp-unit", id || ""); state.showLists = false; state.impUnit = id && id !== ALL ? id : state.impUnit;
    loadDraft(); if (state.tab !== "plan") state.tab = "update"; render();
  }
  window.addEventListener("beforeunload", e => { if (state.dirty) { e.preventDefault(); e.returnValue = ""; } });

  async function addUnit(){
    const name = $("#newUnitName").value.trim(); const type = $("#newUnitType").value;
    if (!name) { toast("Type a unit name first"); return; }
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,40) || uid();
    if (state.units.some(u => u.id===id)) { toast("A unit with that name already exists"); return; }
    const r = await api.saveUnit(auth(), "add", { id, name, type, order: state.units.length + 1 }, `Added unit "${name}"`);
    toast(r.error ? errText(r) : "Unit added. Assign people to it in the People tab.");
  }

  async function exportCsv(){
    const cell = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
    const head = ["Week","Unit","Task","Department","Owner (name)","Due","Priority","Status","% complete","Notes","Expected outcome","Previous status","Completed on","Depends on (unit)","Dependency details","Evidence files"];
    const lines = [head.join(",")].concat(filteredTasks().map(t => [state.week, t.unitName, t.title, t.dept||"", t.owner, t.due, t.priority, t.status||"No status", t.pct ?? "", t.notes, t.outcome||"", t.prevStatus||"", t.completedAt||"", t.depUnit ? unitName(t.depUnit) : "", t.dep||"", (t.ev||[]).map(e => e.name).join("; ")].map(cell).join(",")));
    try { await downloads.save({ filename: `Wagwago weekly plans ${state.week}.csv`, data: "﻿" + lines.join("\n") }); toast("CSV saved"); }
    catch (e) { if (e && e.code !== "declined") toast("Could not export the file here"); }
  }


  // ---------- follow-up ----------
  function lateItems(){
    return sortedUnits().map(u => {
      const p = state.plans[u.id], t = realTasks(p);
      return {
        u, noPlan: !t.length,
        noStatus: t.filter(x => !x.status),
        overdue: t.filter(x => x.due && x.due < todayIso && x.status !== "Done"),
        blocked: t.filter(x => x.status === "Blocked"),
        stale: !!(p && p.updatedAt && (Date.now() - Date.parse(p.updatedAt)) > 3*864e5),
      };
    }).filter(r => r.noPlan || r.noStatus.length || r.overdue.length || r.blocked.length);
  }
  function followItems(){
    return sortedUnits().map(u => ({ u, alerts: alertsFor(u.id).filter(a => a.kind !== "pending").sort((a, b) => levelRank[a.level] - levelRank[b.level]) })).filter(r => r.alerts.length);
  }
  function reminderText(r){
    const lines = [`Dear ${r.u.name} team,`, "", `This is a follow-up from the Group Strategy Office on your weekly plan for ${weekLabel(state.week)}.`];
    r.alerts.forEach(a => {
      lines.push("", `- ${a.text}`);
      a.tasks.slice(0, 12).forEach(t => lines.push(`   • ${t.title}${t.fromUnit ? ` (${unitName(t.fromUnit)})` : ""}${t.due ? `, due ${fmt(t.due)}` : ""}${who(t) ? `, ${who(t)}` : ""}${typeof t.pct === "number" ? `, ${t.pct}%` : ""}`));
    });
    lines.push("", "Please update the tracker before the Friday review.", "", "Group Strategy Office");
    return lines.join("\n");
  }
  async function copyReminder(unitId, btn){
    const r = followItems().find(x => x.u.id === unitId); if (!r) return;
    const text = reminderText(r);
    try { await navigator.clipboard.writeText(text); toast("Reminder copied. Paste it into email or Telegram."); }
    catch (e) { const ta = document.getElementById("rem-"+unitId); if (ta) { ta.hidden = false; ta.select(); } toast("Select the text and copy it"); }
  }
  function renderFollow(){
    const items = followItems();
    if (!state.units.length) return `<div class="panel"><div class="empty"><b>No units set up yet</b></div></div>`;
    if (!items.length) return `<div class="panel"><div class="empty"><b>Nothing to follow up</b>Every unit has a plan with status, and no task is overdue or blocked for ${esc(weekLabel(state.week))}.</div></div>`;
    const pill = a => `<span class="pill ${a.level === "bad" ? "s-bad" : a.level === "warn" ? "s-not" : "s-none"}">${esc(a.text)}</span>`;
    const cards = items.map(r => {
      const list = []; const seen = new Set();
      r.alerts.filter(a => ["overdue","blocked_long","blocked","carried","waiting"].includes(a.kind)).forEach(a => a.tasks.forEach(t => { const k = (t.fromUnit || "") + t.id; if (!seen.has(k)) { seen.add(k); list.push({ t, a }); } }));
      return `<div class="panel" style="margin-bottom:12px">
      <div class="panel-head"><div><div class="unit-name">${esc(r.u.name)}</div><div class="follow-pills">${r.alerts.map(pill).join("")}</div></div>
        <button class="btn" data-copy="${esc(r.u.id)}">Copy reminder</button></div>
      ${list.length ? `<div class="scroll"><table><thead><tr><th>Task</th><th>Why</th><th>Department</th><th>Owner (name)</th><th>Due</th><th>Status</th><th>%</th></tr></thead><tbody>${list.slice(0, 25).map(({ t, a }) => `<tr><td title="${esc(t.title)}">${t.priority==="High"?'<span class="hi-dot"></span>':""}${esc(t.title)}${t.fromUnit ? `<div class="small muted">${esc(unitName(t.fromUnit))} is waiting${t.dep ? `: ${esc(t.dep)}` : ""}</div>` : ""}</td><td class="small">${esc(({ overdue: "Overdue", due_soon: "Due soon", blocked_long: "Blocked " + BLOCKED_DAYS + "+ days", blocked: "Blocked", carried: "Carried again", no_status: "No status", waiting: "Others waiting", dep_blocked: "Waiting on another unit" })[a.kind] || "")}</td><td class="small">${esc(t.dept || "")}</td><td class="small">${esc(t.owner)}</td><td class="num small" style="color:${t.due && t.due < todayIso ? "var(--bad)" : "inherit"}">${esc(fmt(t.due))}</td><td><span class="pill ${statusClass(t.status)}">${esc(t.status||"No status")}</span></td><td class="num small">${t.pct ?? "–"}</td></tr>`).join("")}</tbody></table></div>` : ""}
      <textarea id="rem-${esc(r.u.id)}" hidden readonly style="margin:0 16px 16px;width:calc(100% - 32px);min-height:140px">${esc(reminderText(r))}</textarea>
    </div>`; }).join("");
    return `<div class="banner info">Checked automatically for ${esc(weekLabel(state.week))}: missing plans, overdue and soon-due tasks, tasks blocked for ${BLOCKED_DAYS}+ days, work carried for 2+ weeks, and tasks other units are waiting on. Units also see their own reminders when they open their plan. To have these sent to Telegram automatically, see <b>supabase/upgrade-3-reminders.sql</b>. Copy a reminder to send it yourself.</div>${cards}`;
  }

  // ---------- PDF report ----------
  // The dashboard as it looks on screen (cards, bars, charts), cut into landscape A4 pages between sections
  function printDashboard(){
    const opened = [...document.querySelectorAll("details.more:not([open])")];
    opened.forEach((d) => d.setAttribute("open", ""));
    document.body.classList.add("printing-dash");
    const done = () => { document.body.classList.remove("printing-dash"); opened.forEach((d) => d.removeAttribute("open")); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    setTimeout(() => window.print(), 150);
  }
  async function exportPdf(){
    if (!window.jspdf || !downloads) { toast("The report tool did not load. Reload the page and try again."); return; }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const W = doc.internal.pageSize.getWidth(), M = 36;
    const teal = [138,100,0], hero = [245,197,24], amber = [181,86,11], ink = [42,34,8], muted = [107,95,58];
    doc.setFillColor(...hero); doc.rect(0,0,W,78,"F");
    doc.setTextColor(122,62,0); doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.text("WAGWAGO BUSINESS GROUP  ·  GROUP STRATEGY OFFICE", M, 26);
    doc.setTextColor(42,34,8); doc.setFontSize(20); doc.text(`Weekly Performance Report · ${weekLabel(state.week)}`, M, 52);
    doc.setFontSize(9); doc.setFont("helvetica","normal"); doc.setTextColor(92,74,16); doc.text(`Generated ${fmt(todayIso)} ${new Date().getFullYear()}`, M, 68);
    const rows = sortedUnits().map(u => ({ u, p: state.plans[u.id], s: summarize(state.plans[u.id]) }));
    const tot = rows.reduce((a,r) => ({ total:a.total+r.s.total, done:a.done+r.s.done, blocked:a.blocked+r.s.blocked, overdue:a.overdue+r.s.overdue, high:a.high+r.s.high, highDone:a.highDone+r.s.highDone }), { total:0, done:0, blocked:0, overdue:0, high:0, highDone:0 });
    const submitted = rows.filter(r => r.s.total).length;
    const kpis = [[`${submitted} of ${rows.length}`,"units submitted"],[String(tot.total),"tasks planned"],[`${tot.total?Math.round(tot.done/tot.total*100):0}%`,`tasks done (${tot.done})`],[`${tot.highDone} of ${tot.high}`,"High priority done"],[String(tot.blocked+tot.overdue),"blocked or overdue"]];
    const kw = (W - 2*M - 4*10)/5;
    kpis.forEach((k,i) => { const x = M + i*(kw+10); doc.setFillColor(253,240,194); doc.roundedRect(x, 92, kw, 50, 5, 5, "F"); doc.setTextColor(...(i>2?amber:teal)); doc.setFont("helvetica","bold"); doc.setFontSize(16); doc.text(k[0], x+10, 115); doc.setFont("helvetica","normal"); doc.setFontSize(8.5); doc.setTextColor(...ink); doc.text(k[1], x+10, 131); });
    doc.autoTable({
      startY: 158, margin: { left: M, right: M },
      head: [["Unit","Type","Plan","Tasks","Done","High","Blocked","Overdue","Avg. complete","Last update"]],
      body: rows.map(({u,p,s}) => [u.name, u.type||"", !s.total?"No plan":s.noStatus===s.total?"No status":"Submitted", s.total, s.done, s.high, s.blocked, s.overdue, s.avg===null?"–":s.avg+"%", p&&p.updatedAt?fmt(p.updatedAt.slice(0,10)):"–"]),
      styles: { fontSize: 8.5, cellPadding: 4, textColor: ink, lineColor: [236,227,196], lineWidth: 0.5 },
      headStyles: { fillColor: [245,197,24], textColor: [42,34,8], fontStyle: "bold" },
      alternateRowStyles: { fillColor: [253,249,236] },
      didParseCell: d => { if (d.section==="body" && d.column.index===2) { const v = d.cell.raw; d.cell.styles.textColor = v==="Submitted"?[29,127,85]:v==="No plan"?[182,58,38]:[154,106,0]; d.cell.styles.fontStyle = "bold"; } },
    });
    const late = lateItems().flatMap(r => [...r.overdue, ...r.blocked.filter(b => !r.overdue.includes(b))].map(t => [r.u.name, t.title, t.dept||"", t.owner||"", fmt(t.due), t.status||"No status", t.pct ?? "–"]));
    doc.setFont("helvetica","bold"); doc.setFontSize(12); doc.setTextColor(...teal);
    let y = doc.lastAutoTable.finalY + 26; if (y > 520) { doc.addPage(); y = 50; }
    doc.text("Late and blocked tasks", M, y);
    doc.autoTable({ startY: y + 8, margin: { left: M, right: M },
      head: [["Unit","Task","Department","Owner (name)","Due","Status","%"]],
      body: late.length ? late : [["–","No overdue or blocked tasks this week","","","",""]],
      styles: { fontSize: 8.5, cellPadding: 4, textColor: ink, lineColor: [236,227,196], lineWidth: 0.5 },
      headStyles: { fillColor: [182,58,38], textColor: 255 }, columnStyles: { 1: { cellWidth: 260 } } });
    const noPlan = rows.filter(r => !r.s.total).map(r => r.u.name);
    const asks = rows.filter(r => r.p && (r.p.blockers || r.p.asks)).map(r => [r.u.name, r.p.blockers||"", r.p.asks||""]);
    y = doc.lastAutoTable.finalY + 26; if (y > 520) { doc.addPage(); y = 50; }
    doc.setFont("helvetica","bold"); doc.setFontSize(12); doc.setTextColor(...teal); doc.text("Blockers and asks", M, y);
    doc.autoTable({ startY: y + 8, margin: { left: M, right: M }, head: [["Unit","Blockers","Asks"]],
      body: asks.length ? asks : [["–","None entered",""]],
      styles: { fontSize: 8.5, cellPadding: 4, textColor: ink, lineColor: [236,227,196], lineWidth: 0.5 }, headStyles: { fillColor: [245,197,24], textColor: [42,34,8] } });
    if (noPlan.length) { y = doc.lastAutoTable.finalY + 20; if (y > 540) { doc.addPage(); y = 50; } doc.setFont("helvetica","bold"); doc.setFontSize(10); doc.setTextColor(182,58,38); doc.text("No plan submitted: " + noPlan.join(", "), M, y, { maxWidth: W - 2*M }); }
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(...muted); doc.text(`Group Strategy Office · Weekly Performance Report · Page ${i} of ${n}`, M, doc.internal.pageSize.getHeight() - 18); }
    try { await downloads.save({ filename: `Wagwago weekly performance ${state.week}.pdf`, data: doc.output("arraybuffer") }); toast("Report saved. Open it to print."); }
    catch (e) { if (e && e.code !== "declined") toast("Could not save the report here"); }
  }


  // ---------- more downloads ----------
  const Y = { band:[245,197,24], ink:[42,34,8], muted:[107,95,58], soft:[253,240,194], line:[236,227,196], zebra:[253,249,236], brown:[122,62,0] };
  const tableStyle = () => ({ styles: { fontSize: 8.5, cellPadding: 4, textColor: Y.ink, lineColor: Y.line, lineWidth: 0.5, overflow: "linebreak" }, headStyles: { fillColor: Y.band, textColor: Y.ink, fontStyle: "bold" }, alternateRowStyles: { fillColor: Y.zebra } });
  function newPdf(title, sub){
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const W = doc.internal.pageSize.getWidth();
    doc.setFillColor(...Y.band); doc.rect(0,0,W,74,"F");
    doc.setTextColor(...Y.brown); doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.text("WBG STRATEGY OFFICE  ·  WEEKLY ACTIVITY TRACKING", 36, 24);
    doc.setTextColor(...Y.ink); doc.setFontSize(19); doc.text(title, 36, 48);
    doc.setFont("helvetica","normal"); doc.setFontSize(9); doc.setTextColor(92,74,16); doc.text(sub, 36, 64);
    return doc;
  }
  function pdfFooter(doc, label){
    const n = doc.getNumberOfPages(), H = doc.internal.pageSize.getHeight();
    for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(...Y.muted); doc.text(`${label} · ${weekLabel(state.week)} · Page ${i} of ${n}`, 36, H - 18); }
  }
  function sectionTitle(doc, text, y){ if (y > 500) { doc.addPage(); y = 50; } doc.setFont("helvetica","bold"); doc.setFontSize(12); doc.setTextColor(...Y.brown); doc.text(text, 36, y); return y + 8; }
  async function save(filename, data, okMsg){
    try { await downloads.save({ filename, data }); toast(okMsg); }
    catch (e) { if (e && e.code !== "declined") toast("Could not save the file here"); }
  }
  const libsReady = kind => { if (kind==="pdf" && !window.jspdf) { toast("The PDF tool did not load. Reload the page and try again."); return false; } if (kind==="xlsx" && !window.XLSX) { toast("The Excel tool did not load. Reload the page and try again."); return false; } return !!downloads; };
  const titleOut = t => (t.title || "") + (t.outcome ? `\nOutcome: ${t.outcome}` : "");
  const depText = t => [t.depUnit ? unitName(t.depUnit) : "", t.dep || ""].filter(Boolean).join(": ");
  const taskRow = (t,i) => [i+1, titleOut(t), t.dept||"", t.owner||"", fmt(t.due), t.priority||"", t.prevStatus||"", t.status||"No status", typeof t.pct==="number" ? t.pct+"%" : "", fmt(t.completedAt||""), [t.notes||"", depText(t) && "Depends on " + depText(t), (t.ev||[]).length ? `${t.ev.length} evidence file(s)` : ""].filter(Boolean).join("\n")];
  // PDF: every field of a task, in its own labelled column (landscape A4)
  const pdfHead = withUnit => [...(withUnit ? ["Unit"] : ["#"]), "Task / deliverable", "Expected outcome", "Department", "Owner (name)", "Due", "Priority", "Status (previous)", "%", "Completed", "Depends on", "Notes / next step · evidence"];
  const pdfTask = (t, i, unitName_) => [unitName_ !== undefined ? unitName_ : i + 1,
    (t.kind === "KPI / OKR" ? "[KPI / OKR] " : "") + (t.title || "") + (t.carried ? "\n(carried forward)" : ""),
    t.outcome || "", t.dept || "", t.owner || "", fmt(t.due), t.priority || "",
    (t.status || "No status") + (t.prevStatus ? `\n(was: ${t.prevStatus}${typeof t.prevPct === "number" ? " " + t.prevPct + "%" : ""})` : ""),
    typeof t.pct === "number" ? t.pct + "%" : "", fmt(t.completedAt || ""), depText(t),
    [t.notes || "", (t.ev || []).length ? "Evidence: " + t.ev.map(e => e.name).join(", ") : ""].filter(Boolean).join("\n")];
  const pdfStyle = () => { const b = tableStyle(); b.styles = { ...b.styles, fontSize: 7.5, cellPadding: 3 }; b.headStyles = { ...b.headStyles, fontSize: 7.5 }; return b; };
  const safeName = s => s.replace(/[\\/:*?"<>|]/g,"").slice(0,60);

  function currentPlan(){ return state.draft || state.plans[state.editUnit] || emptyPlan(state.editUnit); }

  async function exportUnitPdf(){
    if (!libsReady("pdf") || !state.editUnit) return;
    const p = currentPlan(), name = unitName(state.editUnit), s = summarize(p);
    const doc = newPdf(`${name} · Weekly Plan`, `Week of ${weekLabel(state.week)}${state.dirty ? "  ·  includes unsaved changes" : ""}`);
    const W = doc.internal.pageSize.getWidth();
    const kpis = [[String(s.total),"tasks"],[String(s.done),"done"],[s.avg===null?"–":s.avg+"%","average complete"],[`${s.highDone} of ${s.high}`,"High priority done"],[String(s.blocked + s.overdue),"blocked or overdue"]];
    const kw = (W - 72 - 40)/5;
    kpis.forEach((k,i) => { const x = 36 + i*(kw+10); doc.setFillColor(...Y.soft); doc.roundedRect(x, 88, kw, 46, 5, 5, "F"); doc.setTextColor(...Y.ink); doc.setFont("helvetica","bold"); doc.setFontSize(15); doc.text(k[0], x+10, 109); doc.setFont("helvetica","normal"); doc.setFontSize(8.5); doc.text(k[1], x+10, 125); });
    doc.autoTable({ startY: 148, margin: { left: 30, right: 30 }, head: [pdfHead(false)],
      body: (p.tasks||[]).length ? p.tasks.map((t,i) => pdfTask(t,i)) : [["","No tasks entered","","","","","","","","","",""]],
      columnStyles: { 0: { cellWidth: 18 }, 1: { cellWidth: 120, fontStyle: "bold" }, 2: { cellWidth: 94 }, 3: { cellWidth: 52 }, 4: { cellWidth: 54 }, 5: { cellWidth: 40 }, 6: { cellWidth: 36 }, 7: { cellWidth: 50 }, 8: { cellWidth: 26 }, 9: { cellWidth: 48 }, 10: { cellWidth: 62 } }, ...pdfStyle() });
    let y = doc.lastAutoTable.finalY + 24;
    y = sectionTitle(doc, "Key results, blockers and asks", y);
    doc.autoTable({ startY: y, margin: { left: 36, right: 36 }, head: [["Key results this week","Blockers and issues","Asks to top management or other units"]], body: [[p.wins||"–", p.blockers||"–", p.asks||"–"]], ...tableStyle() });
    y = doc.lastAutoTable.finalY + 40; if (y > 520) { doc.addPage(); y = 80; }
    doc.setDrawColor(...Y.muted); doc.setFontSize(9); doc.setTextColor(...Y.muted);
    [["Prepared by (unit head)",36],["Reviewed by (Group Strategy Office)",310],["Date",584]].forEach(([l,x]) => { doc.line(x, y, x+230, y); doc.text(l, x, y+12); });
    pdfFooter(doc, `${name} weekly plan`);
    await save(`${safeName(name)} weekly plan ${state.week}.pdf`, doc.output("arraybuffer"), "Plan saved. Open it to print.");
  }

  function sheetFromRows(rows, widths){ const ws = XLSX.utils.aoa_to_sheet(rows); ws["!cols"] = widths.map(w => ({ wch: w })); return ws; }
  const taskHead = ["#","Task / deliverable","Department","Owner (name)","Due","Priority","Status","% complete","Notes / next step","Type","Expected outcome","Previous status","Completed on","Depends on (unit)","Dependency details","Evidence files"];
  const taskWidths = [5,55,18,22,12,10,13,11,50,11,40,14,13,24,30,30];
  const xlsxTask = (t,i) => [i+1, t.title||"", t.dept||"", t.owner||"", t.due||"", t.priority||"", t.status||"No status", typeof t.pct==="number" ? t.pct/100 : "", t.notes||"", t.kind||"Task", t.outcome||"", t.prevStatus||"", t.completedAt||"", t.depUnit ? unitName(t.depUnit) : "", t.dep||"", (t.ev||[]).map(e => e.name).join(", ")];
  function pctFormat(ws, col, firstRow){ const r = XLSX.utils.decode_range(ws["!ref"]); for (let R = firstRow; R <= r.e.r; R++) { const c = ws[XLSX.utils.encode_cell({ r: R, c: col })]; if (c && typeof c.v === "number") c.z = "0%"; } }
  async function writeXlsx(wb, filename, msg){ const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" }); await save(filename, buf, msg); }

  async function exportUnitXlsx(){
    if (!libsReady("xlsx") || !state.editUnit) return;
    const p = currentPlan(), name = unitName(state.editUnit);
    const rows = [[`${name} · Weekly Plan`], [`Week of ${weekLabel(state.week)}`], [], taskHead, ...(p.tasks||[]).map(xlsxTask), [], ["Key results this week", p.wins||""], ["Blockers and issues", p.blockers||""], ["Asks", p.asks||""]];
    const ws = sheetFromRows(rows, taskWidths); pctFormat(ws, 7, 4);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Weekly plan");
    await writeXlsx(wb, `${safeName(name)} weekly plan ${state.week}.xlsx`, "Excel plan saved");
  }

  async function exportTasksPdf(){
    if (!libsReady("pdf")) return;
    const list = filteredTasks(), f = state.filter;
    const filt = [f.unit && unitName(f.unit), f.status && (f.status==="none"?"No status":f.status), f.priority, f.q && `"${f.q}"`].filter(Boolean).join(", ");
    const doc = newPdf("Weekly Tasks", `Week of ${weekLabel(state.week)}  ·  ${list.length} tasks${filt ? "  ·  Filter: " + filt : ""}`);
    doc.autoTable({ startY: 92, margin: { left: 30, right: 30 }, head: [pdfHead(true)],
      body: list.length ? list.map((t,i) => pdfTask(t, i, t.unitName)) : [["","No tasks match","","","","","","","","","",""]],
      columnStyles: { 0: { cellWidth: 62, fontStyle: "bold" }, 1: { cellWidth: 104, fontStyle: "bold" }, 2: { cellWidth: 90 }, 3: { cellWidth: 48 }, 4: { cellWidth: 50 }, 5: { cellWidth: 38 }, 6: { cellWidth: 34 }, 7: { cellWidth: 48 }, 8: { cellWidth: 24 }, 9: { cellWidth: 46 }, 10: { cellWidth: 56 } }, ...pdfStyle() });
    pdfFooter(doc, "Weekly tasks");
    await save(`Wagwago weekly tasks ${state.week}.pdf`, doc.output("arraybuffer"), "Task list saved. Open it to print.");
  }

  async function exportTasksXlsx(){
    if (!libsReady("xlsx")) return;
    const list = filteredTasks();
    const rows = [["Unit", ...taskHead.slice(1)], ...list.map((t,i) => [t.unitName, ...xlsxTask(t,i).slice(1)])];
    const ws = sheetFromRows(rows, [30, ...taskWidths.slice(1)]); pctFormat(ws, 7, 1);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Tasks");
    await writeXlsx(wb, `Wagwago weekly tasks ${state.week}.xlsx`, "Excel task list saved");
  }

  async function exportXlsxAll(){
    if (!libsReady("xlsx")) return;
    const wb = XLSX.utils.book_new();
    const units = sortedUnits();
    const sum = [["Wagwago Business Group · Weekly performance", ""], [`Week of ${weekLabel(state.week)}`], [],
      ["Unit","Type","Plan","Tasks","Done","High priority","High done","Blocked","Overdue","Average complete","Last update"],
      ...units.map(u => { const p = state.plans[u.id], s = summarize(p); return [u.name, u.type||"", !s.total?"No plan":s.noStatus===s.total?"No status":"Submitted", s.total, s.done, s.high, s.highDone, s.blocked, s.overdue, s.avg===null ? "" : s.avg/100, p && p.updatedAt ? p.updatedAt.slice(0,10) : ""]; })];
    const ws = sheetFromRows(sum, [34,18,12,8,8,13,11,9,9,16,13]); pctFormat(ws, 9, 4);
    XLSX.utils.book_append_sheet(wb, ws, "Summary");
    const all = allTasks();
    const wsAll = sheetFromRows([["Unit", ...taskHead.slice(1)], ...all.map((t,i) => [t.unitName, ...xlsxTask(t,i).slice(1)])], [30, ...taskWidths.slice(1)]); pctFormat(wsAll, 7, 1);
    XLSX.utils.book_append_sheet(wb, wsAll, "All tasks");
    const asks = units.filter(u => state.plans[u.id] && (state.plans[u.id].wins || state.plans[u.id].blockers || state.plans[u.id].asks)).map(u => { const p = state.plans[u.id]; return [u.name, p.wins||"", p.blockers||"", p.asks||""]; });
    XLSX.utils.book_append_sheet(wb, sheetFromRows([["Unit","Key results","Blockers","Asks"], ...asks], [30,50,50,50]), "Results, blockers, asks");
    const used = new Set();
    units.forEach(u => { const p = state.plans[u.id]; if (!p || !(p.tasks||[]).length) return; let n = u.name.replace(/[\\/?*\[\]:]/g,"").slice(0,31); while (used.has(n)) n = n.slice(0,29) + "_" + used.size; used.add(n);
      const w = sheetFromRows([taskHead, ...p.tasks.map(xlsxTask)], taskWidths); pctFormat(w, 7, 1); XLSX.utils.book_append_sheet(wb, w, n); });
    await writeXlsx(wb, `Wagwago weekly plans ${state.week}.xlsx`, "Excel workbook saved");
  }

  // ---------- template download and import ----------
  const TCOLS = ["Week starting","Unit","Department","Task / deliverable","Type","Category","Owner","Due date","Priority","Status","Target","Target unit","Actual","Lower is better","% complete","Notes / next step","Expected outcome","Depends on (unit)","Dependency details"];
  const TCOLS_OLD = ["Week starting","Unit","Department","Task / deliverable","Type","Owner","Due date","Priority","Status","% complete","Notes / next step","Expected outcome","Depends on (unit)","Dependency details"];
  const SCOLS = ["Week starting","Unit","Key results this week","Blockers and issues","Asks to top management or other units"];
  const TWIDTH = [14,32,22,60,11,13,24,12,10,13,10,12,10,10,11,50,40,26,34];
  function colKey(h){
    const k = String(h ?? "").toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim(); if (!k) return "";
    if (/^category/.test(k)) return "category";
    if (/target unit|^measure|unit of measure/.test(k)) return "measure";
    if (/^target/.test(k)) return "target";
    if (/^actual/.test(k)) return "actual";
    if (/lower/.test(k)) return "lower";
    if (/outcome|expected result/.test(k)) return "outcome";
    if (/depend.*unit|depends on/.test(k)) return "depUnit";
    if (/dependenc/.test(k)) return "dep";
    if (/^prev|previous|completed on|completion date|evidence|updated by/.test(k)) return "";
    if (/^week/.test(k)) return "week";
    if (/dept|department/.test(k)) return "dept";
    if (/owner|responsible|assigned/.test(k)) return "owner";
    if (/due|deadline/.test(k)) return "due";
    if (/priorit/.test(k)) return "priority";
    if (/status/.test(k)) return "status";
    if (/complete|%|progress/.test(k)) return "pct";
    if (/note|remark|next step|comment/.test(k)) return "notes";
    if (/^(type|kind)/.test(k)) return "kind";
    if (/task|deliverable|activity|action/.test(k)) return "title";
    if (/unit|function|^bu\b|business/.test(k)) return "unit";
    return "";
  }
  function sumKey(h){
    const k = String(h ?? "").toLowerCase();
    if (/^week/.test(k)) return "week"; if (/unit|function|bu/.test(k)) return "unit";
    if (/key result|achiev|wins/.test(k)) return "wins"; if (/blocker|issue/.test(k)) return "blockers"; if (/ask/.test(k)) return "asks"; return "";
  }
  function toIso(v, yearHint){
    if (v === "" || v == null) return "";
    if (typeof v === "number") { if (v > 20000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 864e5)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`; } return null; }
    const s = String(v).trim(); let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    if ((m = s.match(/^(\d{1,2})[-\/ ]([A-Za-z]{3})[a-z]*[-\/ ,]*(\d{2,4})?$/))) { const mo = MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase()); if (mo >= 0) { const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : yearHint; return `${y}-${pad(mo+1)}-${pad(+m[1])}`; } }
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
    return null;
  }
  const STATUS_MAP = { "not started":"Not started", "in progress":"In progress", "done":"Done", "blocked":"Blocked", "delayed":"Delayed", "closed":"Closed", "cancelled":"Closed", "started":"In progress", "complete":"Done", "completed":"Done" };
  function matchUnit(v){
    const k = norm(v); if (!k) return null;
    let hit = state.units.find(u => norm(u.name) === k || norm(u.id) === k); if (hit) return hit;
    const part = state.units.filter(u => norm(u.name).includes(k) || k.includes(norm(u.name)));
    return part.length === 1 ? part[0] : null;
  }
  // "Did you mean": closest name by spelling or by shared words
  const lev = (a, b) => { const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]); for (let j = 1; j <= n; j++) d[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1)); return d[m][n]; };
  function suggest(txt, names){
    const k = norm(txt); if (!k) return "";
    const kw = new Set(k.split(" ")); let best = "", bs = 0;
    names.forEach(n => { const nk = norm(n), nw = new Set(nk.split(" ")), inter = [...kw].filter(w => nw.has(w)).length, jac = inter / (new Set([...kw, ...nw]).size || 1), sp = 1 - lev(k, nk) / Math.max(k.length, nk.length, 1), s = Math.max(jac, sp); if (s > bs) { bs = s; best = n; } });
    return bs >= 0.45 ? best : "";
  }
  function parseRow(raw, map, ctx){
    const g = f => (map[f] != null ? raw[map[f]] : "");
    const r = { err: [], warn: [], row: {} };
    const title = String(g("title") ?? "").trim();
    const unitTxt = String(g("unit") ?? "").trim() || ctx.defaultUnit || "";
    if (!title && !unitTxt) return null;
    if (!title && !Object.keys(map).some(f => !["week", "unit", "kind"].includes(f) && String(raw[map[f]] ?? "").trim() !== "")) return null;
    const unit = matchUnit(unitTxt);
    if (!title) r.err.push("No task title");
    if (!unitTxt) r.err.push("No unit"); else if (!unit) { const sg = suggest(unitTxt, state.units.map(u => u.name)); r.err.push(`Unit "${unitTxt}" not found${sg ? `. Did you mean "${sg}"?` : ". Pick it from the dropdown in the template."}`); }
    r.unit = unit; r.unitTxt = unitTxt;
    const wv = g("week"); let week = state.week;
    if (wv !== "" && wv != null) { const w = toIso(wv, ctx.year); if (w) week = weekStartOf(w); else r.warn.push("Week not understood, used the selected week"); }
    r.week = week;
    const kindTxt = norm(g("kind")); const kind = /kpi|okr|indicator/.test(kindTxt) ? "KPI / OKR" : "Task";
    let status = ""; const extra = [];
    const st = String(g("status") ?? "").trim();
    if (st) { status = STATUS_MAP[st.toLowerCase()] || ""; if (!status) { status = "In progress"; extra.push("Status as submitted: " + st); r.warn.push(`Status "${st}" not recognised, set to In progress`); } }
    let pr = String(g("priority") ?? "").trim(); const priority = ["high","medium","low"].includes(pr.toLowerCase()) ? pr[0].toUpperCase() + pr.slice(1).toLowerCase() : "";
    if (pr && !priority) r.warn.push(`Priority "${pr}" not recognised, left blank`);
    let due = toIso(g("due"), ctx.year);
    if (due === null) { extra.push("Due as submitted: " + g("due")); r.warn.push(`Due date "${g("due")}" not understood, kept in notes`); due = ""; }
    let pct = null; const pv = g("pct");
    if (pv !== "" && pv != null) {
      let n = typeof pv === "number" ? pv : parseFloat(String(pv).replace("%", "").replace(",", "."));
      if (typeof pv === "number" && pv <= 1) n = pv * 100;
      if (!isFinite(n)) r.warn.push(`% complete "${pv}" not understood`); else pct = Math.max(0, Math.min(100, Math.round(n)));
    }
    if (status === "Done" && pct === null) pct = 100;
    if (pct === 100 && !status) status = "Done";
    const notes = [String(g("notes") ?? "").trim(), ...extra].filter(Boolean).join(" | ");
    const depTxt = String(g("depUnit") ?? "").trim(), depU = depTxt ? matchUnit(depTxt) : null;
    if (depTxt && !depU) r.warn.push(`Depends-on unit "${depTxt}" not found, kept in dependency details`);
    const dep = [String(g("dep") ?? "").trim(), depTxt && !depU ? depTxt : ""].filter(Boolean).join(" · ");
    let dept = String(g("dept") ?? "").trim();
    if (dept && unit) { const list = unit.departments || [], hit = list.find(d => norm(d) === norm(dept)); if (hit) dept = hit; else { const sg = suggest(dept, list); r.err.push(`Department "${dept}" is not in ${unit.name}${sg ? `. Did you mean "${sg}"?` : list.length ? "" : ". This unit has no departments yet; ask Group Strategy or planning to add them in the app"}. Departments are never created by import.`); } }
    const catTxt = String(g("category") ?? "").trim(), category = CATEGORIES.find(c => c.toLowerCase() === catTxt.toLowerCase()) || "";
    if (catTxt && !category) r.warn.push(`Category "${catTxt}" not recognised, left blank`);
    const num = v => { if (v === "" || v == null) return ""; const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, "")); return isFinite(n) ? n : null; };
    let target = num(g("target")), actual = num(g("actual"));
    if (target === null) { r.warn.push(`Target "${g("target")}" is not a number, ignored`); target = ""; }
    if (actual === null) { r.warn.push(`Actual "${g("actual")}" is not a number, ignored`); actual = ""; }
    const measure = String(g("measure") ?? "").trim(), lower = /^(y|yes|true|1)/i.test(String(g("lower") ?? "").trim());
    const cp = calcPct({ target, actual, lower }); if (cp !== null) { pct = cp; if (cp === 100 && !status) status = "Done"; }
    r.row = { category, target, measure, actual, lower, title, dept, owner: String(g("owner") ?? "").trim(), due, priority, status, pct, notes, kind, outcome: String(g("outcome") ?? "").trim(), depUnit: depU ? depU.id : "", dep };
    return r;
  }
  function findHeader(rows, keyFn, min){
    for (let i = 0; i < Math.min(rows.length, 15); i++) { const map = {}; rows[i].forEach((h, c) => { const k = keyFn(h); if (k && map[k] == null) map[k] = c; }); if (Object.keys(map).length >= min) return { i, map }; }
    return null;
  }
  async function readImportFile(file){
    if (!window.XLSX) { toast("The Excel tool did not load. Reload the page and try again."); return; }
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sn = wb.SheetNames.find(n => /weekly plan|plan/i.test(n)) || wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: "" });
      const h = findHeader(rows, colKey, 3);
      if (!h || h.map.title == null) { state.imp = { error: "Could not find the task columns. Use the template from step 1 and keep its header row." }; render(); return; }
      const year = parse(state.week).getFullYear();
      const parsed = [];
      for (let i = h.i + 1; i < rows.length; i++) { const p = parseRow(rows[i], h.map, { year, defaultUnit: state.impDefaultUnit }); if (p) { p.line = i + 1; parsed.push(p); } }
      const sums = []; const ss = wb.SheetNames.find(n => /summary/i.test(n));
      if (ss) { const sr = XLSX.utils.sheet_to_json(wb.Sheets[ss], { header: 1, raw: true, defval: "" }); const sh = findHeader(sr, sumKey, 2);
        if (sh) for (let i = sh.i + 1; i < sr.length; i++) { const row = sr[i]; const u = matchUnit(row[sh.map.unit]); const txt = f => String(sh.map[f] != null ? row[sh.map[f]] ?? "" : "").trim(); if (!u || !(txt("wins") || txt("blockers") || txt("asks"))) continue;
          const wv = sh.map.week != null ? toIso(row[sh.map.week], year) : ""; sums.push({ unit: u, week: wv ? weekStartOf(wv) : state.week, wins: txt("wins"), blockers: txt("blockers"), asks: txt("asks") }); } }
      state.imp = { fileName: file.name, rows: parsed, sums, mode: state.imp && state.imp.mode || "merge", newDepts: false };
      if (!parsed.length && !sums.length) state.imp.error = "The file has no task rows."; else setTimeout(computeImpact, 0);
    } catch (e) { state.imp = { error: "Could not read this file. Save it as .xlsx or .csv and try again." }; }
    render();
  }
  function templateRows(unitId, prefill){
    const units = unitId ? state.units.filter(u => u.id === unitId) : sortedUnits(); const out = [];
    const row = (u, t) => [state.week, u.name, t.dept || "", t.title || "", t.kind || "Task", t.category || "", t.owner || "", t.due || "", t.priority || "", t.status || "", t.target ?? "", t.measure || "", t.actual ?? "", t.lower ? "Yes" : "", typeof t.pct === "number" ? t.pct / 100 : "", t.notes || "", t.outcome || "", t.depUnit ? unitName(t.depUnit) : "", t.dep || ""];
    if (prefill) units.forEach(u => (state.plans[u.id]?.tasks || []).forEach(t => out.push(row(u, t))));
    else if (unitId) for (let i = 0; i < 15; i++) out.push(row(units[0], {}));
    return out;
  }
  async function downloadTemplate(){
    const unitId = state.impUnit || "", prefill = !!state.impPrefill;
    let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch (e) { toast("The Excel tool did not load. Reload the page and try again."); return; }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Weekly plan", { views: [{ state: "frozen", ySplit: 1 }] });
    const lists = wb.addWorksheet("Lists", { state: "veryHidden" });
    const allU = sortedUnits(), units = unitId ? allU.filter(u => u.id === unitId) : allU;
    // Lists sheet: A = units, B.. = departments of each unit (one column per unit), then fixed lists
    lists.getCell(1, 1).value = "Units"; units.forEach((u, i) => { lists.getCell(i + 2, 1).value = u.name; });
    units.forEach((u, i) => { const c = i + 2; lists.getCell(1, c).value = u.name; const ds = u.departments || []; (ds.length ? ds : [""]).forEach((d, r) => { lists.getCell(r + 2, c).value = d; }); const L = lists.getColumn(c).letter; wb.definedNames.add(`Lists!$${L}$2:$${L}$${Math.max(2, ds.length + 1)}`, "D_" + (i + 1)); });
    const fixed = { Type: KINDS, Category: CATEGORIES, Priority: PRIORITIES, Status: STATUSES, YesNo: ["Yes", "No"] }; const fcol0 = units.length + 3;
    Object.entries(fixed).forEach(([k, v], j) => { const c = fcol0 + j; lists.getCell(1, c).value = k; v.forEach((x, r) => { lists.getCell(r + 2, c).value = x; }); const L = lists.getColumn(c).letter; wb.definedNames.add(`Lists!$${L}$2:$${L}$${v.length + 1}`, "L_" + k); });
    const ul = lists.getColumn(1).letter; wb.definedNames.add(`Lists!$A$2:$A$${Math.max(2, units.length + 1)}`, "L_Units");
    ws.columns = TCOLS.map((h, i) => ({ header: h, key: "c" + i, width: TWIDTH[i] }));
    const hr = ws.getRow(1); hr.font = { bold: true, color: { argb: "FF2A2208" } }; hr.alignment = { vertical: "middle", wrapText: true }; hr.height = 32;
    hr.eachCell(c => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5C518" } }; });
    templateRows(unitId, prefill).forEach(r => ws.addRow(r));
    const LAST = 600, col = n => TCOLS.indexOf(n) + 1, colL = n => ws.getColumn(col(n)).letter;
    const list = (n, f, msg) => { for (let r = 2; r <= LAST; r++) ws.getCell(r, col(n)).dataValidation = { type: "list", allowBlank: true, formulae: [f(r)], showErrorMessage: true, errorStyle: "stop", errorTitle: n, error: msg, showInputMessage: true, promptTitle: n, prompt: "Pick from the list" }; };
    list("Unit", () => "L_Units", "Pick the unit from the dropdown. Do not type or change the name.");
    list("Department", r => `INDIRECT("D_"&MATCH($${colL("Unit")}${r},L_Units,0))`, "Pick a department from the list for the unit chosen. Choose the Unit first.");
    list("Type", () => "L_Type", "Pick Task or KPI / OKR."); list("Category", () => "L_Category", "Pick Operational or Revenue.");
    list("Priority", () => "L_Priority", "Pick High, Medium or Low."); list("Status", () => "L_Status", "Pick a status from the list."); list("Lower is better", () => "L_YesNo", "Pick Yes or No.");
    for (let r = 2; r <= LAST; r++) {
      ws.getCell(r, col("Due date")).dataValidation = { type: "date", operator: "greaterThan", formulae: [new Date(2020, 0, 1)], allowBlank: true, showErrorMessage: true, errorTitle: "Due date", error: "Enter a date, for example 2026-10-16." };
      ws.getCell(r, col("Week starting")).dataValidation = { type: "date", operator: "greaterThan", formulae: [new Date(2020, 0, 1)], allowBlank: true, showErrorMessage: true, errorTitle: "Week starting", error: "Enter a date inside the week." };
      ["Target", "Actual"].forEach(n => { ws.getCell(r, col(n)).dataValidation = { type: "decimal", operator: "between", formulae: [-1e12, 1e12], allowBlank: true, showErrorMessage: true, errorTitle: n, error: "Enter a number only. Put the unit in the Target unit column." }; });
      ws.getCell(r, col("% complete")).dataValidation = { type: "decimal", operator: "between", formulae: [0, 1], allowBlank: true, showErrorMessage: true, errorTitle: "% complete", error: "Enter 0% to 100%. Leave empty if you fill Target and Actual: it is calculated." };
      ws.getCell(r, col("% complete")).numFmt = "0%";
    }
    ["Task / deliverable", "Notes / next step", "Expected outcome", "Dependency details"].forEach(n => { ws.getColumn(col(n)).alignment = { wrapText: true, vertical: "top" }; });
    const su = wb.addWorksheet("Summary"); su.columns = SCOLS.map((h, i) => ({ header: h, key: "s" + i, width: [14,32,50,50,50][i] })); su.getRow(1).font = { bold: true };
    units.forEach(u => { const p = state.plans[u.id]; su.addRow([state.week, u.name, (p && p.wins) || "", (p && p.blockers) || "", (p && p.asks) || ""]); });
    for (let r = 2; r <= units.length + 40; r++) su.getCell(r, 2).dataValidation = { type: "list", allowBlank: true, formulae: ["L_Units"], showErrorMessage: true, errorStyle: "stop", error: "Pick the unit from the dropdown." };
    const ins = wb.addWorksheet("Instructions"); ins.columns = [{ width: 8 }, { width: 110 }];
    [["How to fill in this template"], [],
      ["1","One row per task on the 'Weekly plan' sheet. Keep the header row as it is. Almost every column is a dropdown: pick, do not type."],
      ["2","Unit: pick your function or business unit. Department: pick a department of that unit (choose the Unit first). Departments are never created by import; ask Group Strategy or your planning team to add one in the app."],
      ["3","Type: Task, or KPI / OKR for indicator lines. Category: Operational or Revenue."],
      ["4","Week starting: any date inside the week. Leave blank to use the week selected on the page."],
      ["5","Target, Target unit and Actual: for measurable work, enter the target (for example 500), its unit (ETB, units, %) and the actual so far. % complete is then calculated for you. Pick 'Yes' under Lower is better when less is better, for example cost or delay."],
      ["6","Without a target, enter % complete yourself (0% to 100%). Done with no % counts as 100%."],
      ["7","Due date: a real date. Priority: High, Medium or Low. Status: Not started, In progress, Done, Blocked or Delayed."],
      ["8","On import, rows with the same task title as an existing task update it. New titles are added. You see a review first, and rows with a wrong unit or department are held back with a suggestion."],
      ["9","Once a week has started, saved tasks keep their title, outcome, type, department, due date and priority. Changes to those, and anything for a past week, go to Group Strategy for approval."]].forEach(r => ins.addRow(r));
    ins.getRow(1).font = { bold: true, size: 14 };
    const buf = await wb.xlsx.writeBuffer();
    const nm = unitId ? safeName(unitName(unitId)) : "all units";
    await save(`Weekly plan template ${nm} ${state.week}.xlsx`, buf, "Template saved");
  }
  async function commitImport(){
    if (state.imp && state.imp.mode === "replace" && !state.imp.confirmed) { state.imp.needConfirm = true; render(); return; }
    const imp = state.imp; if (!imp || !db) return;
    if (state.dirty) { toast("Save or discard your open changes first"); return; }
    const good = imp.rows.filter(r => !r.err.length);
    const groups = new Map();
    const grp = (w, u) => { const k = `${w}|${u.id}`; if (!groups.has(k)) groups.set(k, { week: w, unit: u, rows: [], sum: null }); return groups.get(k); };
    good.forEach(r => grp(r.week, r.unit).rows.push(r)); imp.sums.forEach(s => { grp(s.week, s.unit).sum = s; });
    state.importing = true; render();
    let nTasks = 0, nGroups = 0, nReq = 0; const skipped = [];
    try {
      for (const g of groups.values()) {
        if (!canEdit(g.unit.id)) { skipped.push(g.unit.name); continue; }
        const snap = await db.doc(`plans/${planId(g.week, g.unit.id)}`).get();
        const latest = snap.exists ? snap.data() : null;
        const plan = latest ? clone(latest) : { week: g.week, unit: g.unit.id, tasks: [], wins: "", blockers: "", asks: "" };
        if (imp.mode === "replace" && g.rows.length) plan.tasks = [];
        plan.tasks = plan.tasks || [];
        g.rows.forEach(r => {
          const key = norm(r.row.title); const ex = plan.tasks.find(t => norm(t.title) === key);
          if (ex) { FIELDS.forEach(f => { const v = r.row[f]; if (v !== "" && v !== null && v !== undefined) ex[f] = v; }); if (r.row.status) statusSideEffects(ex); }
          else { const nt = { id: uid(), category: r.row.category, target: r.row.target, measure: r.row.measure, actual: r.row.actual, lower: r.row.lower, title: r.row.title, outcome: r.row.outcome, dept: r.row.dept, owner: r.row.owner, due: r.row.due, priority: r.row.priority, status: r.row.status, pct: r.row.pct, notes: r.row.notes, kind: r.row.kind, depUnit: r.row.depUnit, dep: r.row.dep, ev: [] }; if (nt.status) statusSideEffects(nt); if (r.row.pct !== null && r.row.pct !== undefined) nt.pct = r.row.pct; plan.tasks.push(nt); }
        });
        if (g.sum) { ["wins","blockers","asks"].forEach(f => { if (g.sum[f]) plan[f] = g.sum[f]; }); }
        const res = await persistPlan(g.unit.id, g.week, latest, plan, { latest, source: "Import: " + imp.fileName, action: "import", prefix: `Imported ${imp.fileName}: ` });
        if (res.error) throw Object.assign(new Error(res.error), { code: res.error });
        if (res.nothing) continue;
        if (res.saved) { nTasks += g.rows.length; nGroups++; } nReq += res.requested || 0;
      }
      toast([nGroups ? `Imported ${nTasks} rows into ${nGroups} plan${nGroups > 1 ? "s" : ""}` : "", nReq ? `${nReq} change${nReq > 1 ? "s" : ""} sent for approval` : "", skipped.length ? `Skipped (no PIN for): ${[...new Set(skipped)].join(", ")}` : ""].filter(Boolean).join(" · ") || "Nothing changed. The file matches what is saved.");
      state.imp = null;
    } catch (e) { toast(e && e.code === "conflict" ? ERR.conflict : "Import stopped part-way: " + errText(e) + " Check the plans and run it again."); }
    state.importing = false; loadDraft(); render();
  }
  function renderImport(){
    const imp = state.imp;
    const unitOpts = `<option value="">All units</option>` + sortedUnits().map(u => `<option value="${esc(u.id)}" ${state.impUnit === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("");
    let prev = "";
    if (imp && imp.error) prev = `<div class="banner warn" style="margin:16px">${esc(imp.error)}</div>`;
    else if (imp) {
      const ok = imp.rows.filter(r => !r.err.length), bad = imp.rows.length - ok.length, warn = ok.filter(r => r.warn.length).length;
      const gs = new Map(); ok.forEach(r => { const k = `${r.week}|${r.unit.id}`; gs.set(k, (gs.get(k) || 0) + 1); });
      const newD = new Set(); ok.forEach(r => { if (r.row.dept && !(r.unit.departments || []).some(d => d.toLowerCase() === r.row.dept.toLowerCase())) newD.add(`${r.unit.name}: ${r.row.dept}`); });
      const shown = imp.rows.slice(0, 150).map(r => `<tr class="${r.err.length ? "row-err" : r.warn.length ? "row-warn" : ""}"><td class="num small">${r.line}</td><td class="small">${esc(r.unit ? r.unit.name : r.unitTxt)}</td><td class="small num">${esc(fmt(r.week))}</td><td>${esc(r.row.title)}</td><td class="small">${esc(r.row.dept)}</td><td class="small">${esc(r.row.owner)}</td><td class="small num">${esc(fmt(r.row.due))}</td><td class="small">${esc(r.row.priority)}</td><td class="small">${esc(r.row.status)}</td><td class="small num">${r.row.pct ?? ""}</td><td class="small">${esc([...r.err, ...r.warn].join("; "))}</td></tr>`).join("");
      prev = `<div style="padding:16px;display:grid;gap:12px">
        <div class="toolbar"><span class="pill s-done">${ok.length} ready</span>${warn ? `<span class="pill s-not">${warn} with notices</span>` : ""}${bad ? `<span class="pill s-bad">${bad} will be skipped</span>` : ""}${imp.sums.length ? `<span class="pill s-prog">${imp.sums.length} summary row${imp.sums.length > 1 ? "s" : ""}</span>` : ""}<span class="muted small">${esc(imp.fileName)} · goes to ${gs.size} plan${gs.size === 1 ? "" : "s"}</span></div>
        ${newD.size ? `<div class="banner info" style="margin:0">New departments found: ${[...newD].map(esc).join(", ")}</div>` : ""}
        ${imp.impact ? `<div class="banner info" style="margin:0"><b>What this import will do:</b> ${imp.mode === "replace" ? `remove the ${imp.impact.rem} task${imp.impact.rem === 1 ? "" : "s"} now saved in these plan weeks and save the ${imp.impact.n} from the file.` : `update ${imp.impact.upd} existing task${imp.impact.upd === 1 ? "" : "s"} (blank cells in the file never erase saved values), add ${imp.impact.add} new, and leave ${imp.impact.keep} saved task${imp.impact.keep === 1 ? "" : "s"} untouched. Nothing is deleted.`}</div>` : ""}
        ${imp.needConfirm ? `<div class="banner warn" style="margin:0"><b>Replace will delete ${imp.impact ? imp.impact.rem : "the"} saved task(s) in these plan weeks.</b> The replaced versions are kept in History. <button class="btn danger" id="impConfirm" style="margin-left:6px">Yes, replace</button> <button class="btn" id="impNoConfirm">Cancel</button></div>` : ""}
        <div class="toolbar"><label class="small" for="impMode">If a task title already exists</label>
          <select id="impMode"><option value="merge" ${imp.mode === "merge" ? "selected" : ""}>Update it and add new ones</option><option value="replace" ${imp.mode === "replace" ? "selected" : ""}>Replace the unit's whole plan for that week</option></select>
          <span class="small muted">Departments are never created by an import. Rows with an unknown department are held back.</span></div>
        <div class="scroll" style="max-height:420px;overflow:auto"><table><thead><tr><th>Row</th><th>Unit</th><th>Week</th><th>Task</th><th>Department</th><th>Owner</th><th>Due</th><th>Priority</th><th>Status</th><th>%</th><th>Notice</th></tr></thead><tbody>${shown}</tbody></table></div>
        ${imp.rows.length > 150 ? `<div class="small muted">Showing the first 150 of ${imp.rows.length} rows. All ready rows are imported.</div>` : ""}
        <div class="toolbar"><button class="btn primary" id="impGo" ${(!ok.length && !imp.sums.length) || state.importing ? "disabled" : ""}>${state.importing ? "Importing…" : `Import ${ok.length} row${ok.length === 1 ? "" : "s"}`}</button><button class="btn" id="impClear">Cancel</button></div></div>`;
    }
    return `<div class="grid2" style="grid-template-columns:minmax(0,1fr);gap:16px">
      <div class="panel"><div class="panel-head"><h2>1 · Download the template</h2><span class="muted small">Week: ${esc(weekLabel(state.week))}</span></div>
        <div class="reports"><div><label for="impUnit">Unit</label><select id="impUnit" style="width:100%">${unitOpts}</select></div>
          <div><label for="impPrefill">Starting rows</label><label class="small" style="font-weight:500"><input type="checkbox" id="impPrefill" ${state.impPrefill ? "checked" : ""}> Include the tasks already saved for this week</label></div>
          <div style="display:flex;align-items:flex-end"><button class="btn primary" id="tplBtn" ${downloads ? "" : "disabled"}>Download template (Excel)</button></div></div>
        <div class="small muted" style="padding:0 16px 14px">Next week: move to the new week with the arrows above, then download. Pick one unit to get 15 empty rows already carrying its name and week, or tick the box to start from the current tasks and update their status.</div></div>
      <div class="panel"><div class="panel-head"><h2>2 · Import the filled file</h2></div>
        <div class="reports"><div><label for="impFile">Excel or CSV file</label><input type="file" id="impFile" accept=".xlsx,.xls,.csv" style="width:100%"></div>
          <div class="small muted" style="align-self:end">Rows with a Week starting date go to that week, so one file can carry last week's report and next week's plan. Nothing is saved until you press Import.</div></div>
        ${prev}</div></div>`;
  }

  function drill(spec){
    const [uId, kind] = spec.split("|"), f = newFilter(); f.period = "month"; f.from = "monthly"; f.unit = uId; f.group = true;
    const map = { done: ["Done"], prog: ["In progress"], ns: ["Not started", ""], blk: ["Blocked", "Delayed"] };
    if (map[kind]) f.statuses = map[kind];
    if (kind === "high") { f.priority = "High"; }
    state.filter = f; state.tab = "tasks"; state.expanded = new Set(); render();
  }

  // ---------- who is signed in: profile, settings, role requests ----------
  const initials = n => (String(n || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?");
  const avatar = (n, big) => `<span class="avatar${big ? " big" : ""}" aria-hidden="true">${esc(initials(n))}</span>`;
  const rolePill = r => `<span class="pill role-${esc(r)}">${esc(ROLE_LABEL[r] || r)}</span>`;
  // department dropdown: pick one or more from the unit's departments
  const ddLabel = (sel, ph) => sel.length ? (sel.length <= 2 ? sel.map(esc).join(", ") : `${sel.length} departments`) : `<span class="muted">${esc(ph || "Choose departments")}</span>`;
  const ddHtml = (id, unit, sel, ph, open) => {
    const opts = unitOf(unit).departments || [], keep = (sel || []).filter(x => opts.includes(x));
    const add = unit && canEditDepartments(me, unit) ? `<div class="dd-add"><input type="text" maxlength="60" placeholder="New department" data-dd-new aria-label="New department name"><button type="button" class="btn small" data-dd-add>Add</button></div>` : "";
    return `<details class="dd" data-dd="${esc(id)}" data-unit="${esc(unit || "")}"${open ? " open" : ""}><summary class="dd-btn">${ddLabel(keep, unit ? ph : "Choose a unit first")}</summary><div class="dd-menu">${opts.length ? opts.map(o => `<label><input type="checkbox" value="${esc(o)}" ${keep.includes(o) ? "checked" : ""}> ${esc(o)}</label>`).join("") : `<div class="small muted" style="padding:8px 10px">${unit ? "No departments yet" : "Choose a unit first"}</div>`}${add}</div></details>`;
  };
  const ddValues = (root, id) => { const d = (root || document).querySelector(`[data-dd="${CSS.escape(id)}"]`); return d ? [...d.querySelectorAll("input:checked")].map(i => i.value) : []; };
  const ddRefill = (root, id, unit, sel) => { const d = (root || document).querySelector(`[data-dd="${CSS.escape(id)}"]`); if (d) d.outerHTML = ddHtml(id, unit, sel || [], "Choose departments"); };
  document.addEventListener("change", e => { const m = e.target.closest && e.target.closest(".dd-menu"); if (!m) return; const dd = m.closest(".dd"), vals = [...m.querySelectorAll("input:checked")].map(i => i.value); dd.querySelector("summary").innerHTML = ddLabel(vals, "Choose departments"); });
  async function saveDepts(unit, list, text){
    try { const r = await api.saveUnit(auth(), "lists", { id: unit, departments: list }, text); if (r.error) { toast(errText(r)); return false; } } catch (e) { toast(errText(e)); return false; }
    const u = state.units.find(x => x.id === unit); if (u) u.departments = list; state.ddBusy = Date.now(); return true;
  }
  async function ddAddDept(dd){
    const unit = dd.dataset.unit, inp = dd.querySelector("[data-dd-new]"), name = (inp.value || "").trim().replace(/\s+/g, " ");
    if (!name) { toast("Type a department name first"); return; }
    const list = unitOf(unit).departments || [];
    if (list.some(x => x.toLowerCase() === name.toLowerCase())) { toast("That department already exists"); return; }
    const id = dd.dataset.dd, keep = [...dd.querySelectorAll("input:checked")].map(i => i.value);
    if (!(await saveDepts(unit, [...list, name], `Added department "${name}"`))) return;
    dd.outerHTML = ddHtml(id, unit, [...keep, name], "Choose departments", true); toast("Department added");
  }
  document.addEventListener("click", e => { const b = e.target.closest && e.target.closest("[data-dd-add]"); if (b) { e.preventDefault(); ddAddDept(b.closest(".dd")); } });
  document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches && e.target.matches("[data-dd-new]")) { e.preventDefault(); ddAddDept(e.target.closest(".dd")); } });
  document.addEventListener("click", e => { document.querySelectorAll("details.dd[open]").forEach(d => { if (!d.contains(e.target)) d.open = false; }); });

  const REQ_ROLES = ROLES.filter(r => !["super_admin", "executive"].includes(r));
  const seenRR = () => { try { return JSON.parse(store.get("wp-rr-seen") || "[]"); } catch (e) { return []; } };
  const markSeenRR = ids => { const s = new Set([...seenRR(), ...ids]); store.set("wp-rr-seen", JSON.stringify([...s].slice(-60))); };
  const unseenDecided = () => (state.myRR || []).filter(x => (x.status === "approved" || x.status === "rejected") && !seenRR().includes(x.id) && Date.now() - Date.parse(x.decidedAt || 0) < 14 * 864e5);
  state.rr = { list: [], count: 0, access: 0 }; state.myRR = [];
  function applyMe(p){
    if (!p || p.status !== "active" || !me) return;
    const changed = p.role !== me.role || p.unit !== me.unit || JSON.stringify(p.departments || []) !== JSON.stringify(me.departments || []);
    me = { ...me, ...p }; api.setProfile && api.setProfile(me);
    if (changed) { toast("Your access was updated. You are now " + roleText(me) + (me.unit ? " in " + unitName(me.unit) : "") + "."); render(); }
  }
  async function refreshRR(){
    if (!me || !api) return;
    try {
      if (isAppr()) { const r = await api.adminRoleRequests(); if (!r.error) state.rr = { list: r.requests || [], count: (r.requests || []).length, access: Number(r.accessCount) || 0 }; }
      else {
        const r = await api.myRoleRequests(); if (!r.error) state.myRR = r.requests || [];
        if (state.myRR.some(x => x.status === "approved" && !seenRR().includes(x.id))) applyMe(await api.me());
      }
    } catch (e) { return; }
    renderHero();
  }
  setInterval(() => { if (me && !document.hidden) refreshRR(); }, 20000);
  document.addEventListener("visibilitychange", () => { if (me && !document.hidden) refreshRR(); });
  const THEME = { auto: "Match my device", light: "Light", dark: "Dark" };
  function applyTheme(v){ const r = document.documentElement; if (v === "light" || v === "dark") r.dataset.theme = v; else delete r.dataset.theme; }
  applyTheme(store.get("wp-theme") || "auto");
  const ST_PILL = { pending: "s-prog", approved: "s-done", rejected: "s-bad", withdrawn: "s-none" };
  const ST_TXT = { pending: "Waiting for Group Strategy", approved: "Approved", rejected: "Not approved", withdrawn: "Withdrawn" };

  async function showMenu(){
    if (!me) return;
    const root = $("#whoRoot"); let reqs = [];
    const detail = (r, unit, deps) => `${esc(ROLE_LABEL[r] || r)}${unit ? " · " + esc(unitName(unit)) : ""}${(deps || []).length ? " · " + esc(deps.join(", ")) : ""}`;
    const draw = () => {
      const pend = reqs.find(x => x.status === "pending"), hist = reqs.filter(x => x.status !== "pending").slice(0, 3), mu = me.unit || "";
      const lab = (id, t, inner, hint) => `<div class="pf-f"><label for="${id}">${t}</label>${inner}${hint ? `<div class="small muted">${hint}</div>` : ""}</div>`;
      const reqBox = me.role === "super_admin" ? `<div class="small muted">You are Group Strategy. You decide role requests from the People page, so there is nothing to request here.</div>`
        : pend ? `<div class="pf-pend"><span class="pill ${ST_PILL.pending}">${ST_TXT.pending}</span><div style="margin:6px 0"><b>${detail(pend.role, pend.unit, pend.departments)}</b></div>${pend.reason && !/^(Asked for at sign-up|Requested from profile)$/.test(pend.reason) ? `<div class="small muted">“${esc(pend.reason)}”</div>` : ""}<div class="small muted">Sent ${esc(fmt((pend.createdAt || "").slice(0, 10)))} · ${pend.kind === "signup" ? "at sign-up" : "role upgrade"}. You will see the answer on the bell.</div><div style="margin-top:8px"><button class="btn small" type="button" data-pf="rr-wd" data-id="${esc(pend.id)}">Withdraw request</button></div>
          <div class="pf-code"><label for="pfCode">Have an approval code?</label><div class="toolbar"><input id="pfCode" type="password" autocomplete="off" placeholder="Approval code"><button class="btn" type="button" data-pf="rr-code" data-id="${esc(pend.id)}">Approve with code</button></div><div class="small muted">If Group Strategy is with you, they type their code here and your request is approved right away.</div></div></div>`
        : `<div class="pf-grid">${lab("pfRole", "Role you need", `<select id="pfRole">${REQ_ROLES.map(r => `<option value="${r}" ${r === me.role ? "selected" : ""}>${esc(ROLE_LABEL[r] || r)}</option>`).join("")}</select>`, `<span id="pfRoleHelp">${esc(ROLE_HELP[me.role] || "")}</span>`)}
          ${lab("pfUnit", "Unit", `<select id="pfUnit">${UNIT_OPTS(mu).replace("No unit", "Choose a unit")}</select>`)}
          <div class="pf-f" id="pfDeptWrap" ${["planning"].includes(me.role) ? "hidden" : ""}><label>Departments</label>${ddHtml("pf-dept", mu, me.departments || [], "Choose departments")}</div>
          </div>
          <div class="toolbar" style="margin-top:8px"><button class="btn primary" type="button" data-pf="rr-send">Send request to Group Strategy</button></div>`;
      const histH = hist.length ? `<div class="pf-hist">${hist.map(x => `<div><span class="pill ${ST_PILL[x.status]}">${ST_TXT[x.status]}</span> <span class="small">${detail(x.role, x.unit, x.departments)}</span>${x.note ? `<div class="small muted">“${esc(x.note)}”</div>` : ""}</div>`).join("")}</div>` : "";
      root.innerHTML = `<div class="overlay"><div class="modal prof" role="dialog" aria-modal="true" aria-labelledby="whoTitle">
        <div class="panel-head"><div class="pf-who">${avatar(me.name, true)}<div><h2 id="whoTitle">${esc(me.name)}</h2><div class="small muted">${esc(me.email || "")}</div><div style="margin-top:4px">${rolePill(me.role)} <span class="small muted">${me.unit ? esc(unitName(me.unit)) : ""}${(me.departments || []).length ? " · " + esc(me.departments.join(", ")) : ""}</span></div></div></div><button class="icon-btn" id="whoX" aria-label="Close">×</button></div>
        <div class="pf-body">
          <section class="pf-sec"><h3>Your details</h3><div class="pf-grid">
            ${lab("pfName", "Full name", `<input id="pfName" type="text" maxlength="120" value="${esc(me.name || "")}" autocomplete="name">`, "Shown as “updated by” on plans and in comments.")}
            ${lab("pfPhone", "Phone or WhatsApp", `<input id="pfPhone" type="text" maxlength="40" value="${esc(me.phone || "")}" autocomplete="tel" placeholder="09…">`, "So Group Strategy can reach you.")}
            ${lab("pfJob", "Job title", `<input id="pfJob" type="text" maxlength="80" value="${esc(me.jobTitle || "")}" placeholder="For example: Senior planning officer">`)}
            ${lab("pfEmail", "Email", `<input id="pfEmail" type="text" value="${esc(me.email || "")}" disabled>`, "Your sign-in. Ask Group Strategy to change it.")}</div>
            <div class="toolbar" style="margin-top:8px"><button class="btn primary" type="button" data-pf="save">Save details</button></div></section>
          <section class="pf-sec"><h3>Appearance and start page <span class="small muted">this device</span></h3><div class="pf-grid">
            ${lab("pfTheme", "Theme", `<select id="pfTheme">${Object.entries(THEME).map(([k, v]) => `<option value="${k}" ${(store.get("wp-theme") || "auto") === k ? "selected" : ""}>${v}</option>`).join("")}</select>`)}
            ${lab("pfStart", "Open the app on", `<select id="pfStart">${[["dashboard", "Dashboard"], ["update", "This week's update"], ["plan", "Next week's plan"], ["mplan", "Monthly plan"], ["tasks", "All tasks"]].map(([k, v]) => `<option value="${k}" ${(store.get("wp-start") || "dashboard") === k ? "selected" : ""}>${v}</option>`).join("")}</select>`)}</div></section>
          <section class="pf-sec"><h3>Password and security</h3>
            <div id="pwBox" hidden><div class="pf-grid"><div class="pf-f"><label for="pwA">New password (at least 6 characters)</label><input type="password" id="pwA" autocomplete="new-password"></div><div class="pf-f"><label for="pwB">Repeat it</label><input type="password" id="pwB" autocomplete="new-password"></div></div><div id="pwErr" class="small" style="color:var(--bad);min-height:18px" role="alert"></div><div class="toolbar"><button class="btn primary" type="button" id="pwSave">Save password</button><button class="btn" type="button" id="pwCancel">Cancel</button></div></div>
            <div class="toolbar" id="secBtns"><button class="btn" type="button" id="pwOpen">Change password</button><button class="btn" type="button" data-pf="out-all" title="Signs you out on every phone and computer, including this one">Sign out of all devices</button></div></section>
          <section class="pf-sec"><h3>Role and access</h3>
            <div class="small" style="margin-bottom:10px">Now: <b>${detail(me.role, me.unit, me.departments)}</b></div>${reqBox}${histH}</section>
        </div>
        <div class="save-bar"><span class="small muted">Role, unit and departments change only when Group Strategy approves a request.</span><div class="toolbar"><button class="btn" id="whoOut" type="button">Sign out</button></div></div></div></div>`;
    };
    const load = async () => { try { const r = await api.myRoleRequests(); reqs = r.error ? [] : (r.requests || []); } catch (e) { reqs = []; } state.myRR = reqs; markSeenRR(reqs.filter(x => x.status !== "pending").map(x => x.id)); };
    await load(); draw(); renderHero();
    const $$ = s => root.querySelector(s);
    root.onclick = async e => {
      if (e.target.id === "whoX" || e.target.classList.contains("overlay")) { root.innerHTML = ""; return; }
      const b = e.target.closest("button"); if (!b) return;
      if (b.id === "whoOut") { await api.signOut(); location.reload(); return; }
      if (b.id === "pwOpen") { $$("#pwBox").hidden = false; $$("#secBtns").hidden = true; $$("#pwA").focus(); return; }
      if (b.id === "pwCancel") { $$("#pwBox").hidden = true; $$("#secBtns").hidden = false; return; }
      if (b.id === "pwSave") {
        const a = $$("#pwA").value, c = $$("#pwB").value, er = m => { $$("#pwErr").textContent = m; };
        if (a.length < 6) return er("Use at least 6 characters."); if (a !== c) return er("The two passwords are not the same.");
        const r = await api.setPassword(a); if (r.error) return er(/same|different/i.test(r.error) ? "Choose a password you have not used before." : "Could not save: " + r.error);
        root.innerHTML = ""; toast("Password changed"); return;
      }
      const k = b.dataset.pf; if (!k) return;
      try {
        if (k === "save") {
          const r = await api.updateProfile({ name: $$("#pfName").value, phone: $$("#pfPhone").value, jobTitle: $$("#pfJob").value });
          if (r.error) { toast(errText(r)); return; }
          if (r.profile) me = { ...me, ...r.profile }; api.setProfile && api.setProfile(me); toast("Details saved"); render(); draw();
        } else if (k === "out-all") {
          if (!confirm("Sign out on every phone and computer, including this one?")) return;
          await api.signOutEverywhere(); location.reload();
        } else if (k === "rr-send") {
          const role = $$("#pfRole").value, unit = $$("#pfUnit").value, deps = ddValues(root, "pf-dept");
          const r = await api.requestRole({ role, unit, departments: ["planning"].includes(role) ? [] : deps, reason: "Requested from profile", kind: "upgrade" });
          if (r.error) { toast(errText(r)); return; }
          toast("Request sent to Group Strategy"); await load(); draw(); refreshRR();
        } else if (k === "rr-code") {
          const r = await api.approveRoleWithCode(b.dataset.id, $$("#pfCode").value); if (r.error) { toast(errText(r)); return; }
          if (r.profile) applyMe(r.profile); toast("Approved with the code. Your access is updated."); await load(); draw(); refreshRR();
        } else if (k === "rr-wd") {
          const r = await api.withdrawRoleRequest(b.dataset.id); if (r.error) { toast(errText(r)); return; }
          toast("Request withdrawn"); await load(); draw(); refreshRR();
        }
      } catch (x) { toast(errText(x)); }
    };
    root.onchange = e => {
      const el = e.target;
      if (el.id === "pfTheme") { store.set("wp-theme", el.value); applyTheme(el.value); }
      else if (el.id === "pfStart") { store.set("wp-start", el.value); toast("Saved. The app opens there next time"); }
      else if (el.id === "pfRole") { $$("#pfRoleHelp").textContent = ROLE_HELP[el.value] || ""; $$("#pfDeptWrap").hidden = ["planning"].includes(el.value); }
      else if (el.id === "pfUnit") ddRefill(root, "pf-dept", el.value, []);
    };
  }

  // ---------- People (Group Strategy only) ----------
  const ROLE_OPTS = (cur) => ROLES.map(r => `<option value="${r}" ${r === cur ? "selected" : ""}>${esc(ROLE_LABEL[r] || r)}</option>`).join("");
  const REQ_OPTS = (cur) => REQ_ROLES.map(r => `<option value="${r}" ${r === cur ? "selected" : ""}>${esc(ROLE_LABEL[r] || r)}</option>`).join("");
  const UNIT_OPTS = (cur) => `<option value="">No unit</option>` + sortedUnits().map(u => `<option value="${esc(u.id)}" ${u.id === cur ? "selected" : ""}>${esc(u.name)}</option>`).join("");
  state.pp = { q: "", unit: "", role: "", st: "", edit: null };
  async function loadPeople(){
    if (!isAppr() || !api) return;
    state.people = state.people || { loading: true };
    try { const r = await api.adminUsers(); state.people = r.error ? { error: r.error } : { ...r }; } catch (e) { state.people = { error: e.code || "error" }; }
    try { const c = await api.adminApprovalCodeStatus(); state.appCode = c && !c.error ? c : {}; } catch (e) { state.appCode = {}; }
    await refreshRR();
    if (state.tab === "people") render();
  }
  const chips = deps => { const d = deps || []; return d.length ? d.slice(0, 2).map(x => `<span class="chip">${esc(x)}</span>`).join("") + (d.length > 2 ? `<span class="chip more" title="${esc(d.slice(2).join(", "))}">+${d.length - 2}</span>` : "") : '<span class="muted">–</span>'; };
  function ppFiltered(p){
    const f = state.pp, q = f.q.trim().toLowerCase();
    return (p.users || []).filter(u => (!q || (u.name || "").toLowerCase().includes(q) || (u.email || "").toLowerCase().includes(q)) && (!f.unit || u.unit === f.unit) && (!f.role || u.role === f.role) && (!f.st || u.status === f.st));
  }
  function ppRows(p){
    const list = ppFiltered(p);
    return list.map(u => `<tr class="pp-row" data-pp="${esc(u.id)}">
      <td><div class="pp-who">${avatar(u.name || u.email)}<div><b>${esc(u.name || "(no name yet)")}</b>${u.setupDone ? "" : ' <span class="pill s-none">not set up</span>'}<div class="small muted">${esc(u.email)}${u.phone ? " · " + esc(u.phone) : ""}</div>${u.jobTitle ? `<div class="small muted">${esc(u.jobTitle)}</div>` : ""}</div></div></td>
      <td>${rolePill(u.role)}${u.role === "executive" && u.title ? ` <span class="small muted">${esc(u.title)}</span>` : ""}</td>
      <td class="small">${u.unit ? esc(unitName(u.unit)) : '<span class="muted">–</span>'}</td>
      <td>${chips(u.departments)}</td>
      <td><span class="pill ${u.status === "active" ? "s-done" : "s-bad"}">${u.status === "active" ? "Active" : "Disabled"}</span></td>
      <td class="c-act"><button class="btn small" type="button" data-pe="pp-edit" data-id="${esc(u.id)}">${ico(IC.pen)}Edit</button></td></tr>`).join("") || `<tr><td colspan="6" class="muted" style="padding:20px;text-align:center">No one matches these filters.</td></tr>`;
  }
  function ppDecisions(p){
    const rr = state.rr.list || [], acc = p.requests || [];
    if (!rr.length && !acc.length) return "";
    const grant = (key, r) => `<div class="pp-grant"><div class="pf-f"><label>Give the role</label><select data-rr-role="${esc(key)}">${REQ_OPTS(r.role || "staff")}</select></div>
      <div class="pf-f"><label>Unit</label><select data-rr-unit="${esc(key)}">${UNIT_OPTS(r.unit)}</select></div>
      <div class="pf-f" data-rr-deptwrap="${esc(key)}" ${["planning"].includes(r.role) ? "hidden" : ""}><label>Departments</label>${ddHtml("rr-" + key, r.unit, r.departments || [], "Choose departments")}</div></div>`;
    const cards = rr.map(r => `<div class="pp-card" data-rrc="${esc(r.id)}">
      <div class="pp-card-h">${avatar(r.name || r.email)}<div><b>${esc(r.name || r.email)}</b> <span class="pill ${r.kind === "signup" ? "s-prog" : "s-not"}">${r.kind === "signup" ? "Asked at sign-up" : "Role upgrade"}</span><div class="small muted">${esc(r.email)}${r.phone ? " · " + esc(r.phone) : ""}${r.jobTitle ? " · " + esc(r.jobTitle) : ""}</div></div></div>
      <div class="pp-ask"><span class="small muted">Has</span> ${rolePill(r.fromRole)} <span class="small">${esc(r.fromUnit ? unitName(r.fromUnit) : "–")}${(r.fromDepartments || []).length ? " · " + esc(r.fromDepartments.join(", ")) : ""}</span> <span class="pp-arrow">→</span> <span class="small muted">Asks for</span> ${rolePill(r.role)} <span class="small">${esc(r.unit ? unitName(r.unit) : "–")}${(r.departments || []).length ? " · " + esc(r.departments.join(", ")) : ""}</span></div>
      ${r.reason && !/^(Asked for at sign-up|Requested from profile)$/.test(r.reason) ? `<div class="pp-reason">“${esc(r.reason)}”</div>` : ""}
      ${grant(r.id, r)}
      <div class="pp-card-f"><input type="text" data-rr-note="${esc(r.id)}" placeholder="Note to ${esc((r.name || "them").split(" ")[0])} (optional)" maxlength="300"><button class="btn primary" type="button" data-pe="rr-yes" data-id="${esc(r.id)}">Approve</button><button class="btn" type="button" data-pe="rr-no" data-id="${esc(r.id)}">Reject</button></div></div>`).join("");
    const cards2 = acc.map(r => `<div class="pp-card" data-rrc="acc-${esc(r.id)}">
      <div class="pp-card-h">${avatar(r.name || r.email)}<div><b>${esc(r.name)}</b> <span class="pill s-none">Asked for access</span><div class="small muted">${esc(r.email)} · ${esc(r.contact || "")}</div>${r.note ? `<div class="small">${esc(r.note)}</div>` : ""}</div></div>
      ${grant("acc-" + r.id, { role: "staff", unit: r.unit, departments: [] })}
      <div class="pp-card-f"><button class="btn primary" type="button" data-pe="req-yes" data-id="${esc(r.id)}">Approve</button><button class="btn" type="button" data-pe="req-no" data-id="${esc(r.id)}">Reject</button></div></div>`).join("");
    return `<div class="panel pp-need"><div class="panel-head"><div><h2>Needs your decision <span class="count-pill">${rr.length + acc.length}</span></h2><div class="small muted">Check the role, unit and departments, adjust if needed, then approve.</div></div></div><div class="pp-cards">${cards}${cards2}</div></div>`;
  }
  function ppDrawer(p){
    const u = (p.users || []).find(x => x.id === state.pp.edit); if (!u) return "";
    const self = me && me.id === u.id;
    return `<div class="scrim" id="ppScrim"></div><aside class="side task-panel anim pp-drawer" role="dialog" aria-modal="true" aria-label="Edit ${esc(u.name || u.email)}">
      <div class="panel-head"><div class="pp-who">${avatar(u.name || u.email, true)}<div><b style="font-size:16px">${esc(u.name || u.email)}</b><div class="small muted">${esc(u.email)}</div></div></div><button class="icon-btn" type="button" data-pe="pp-close" aria-label="Close">×</button></div>
      <div class="panel-body"><div class="pf-f"><label for="pp-name">Name</label><input id="pp-name" type="text" value="${esc(u.name)}" maxlength="120"></div>
        ${u.phone || u.jobTitle ? `<div class="small muted">${esc([u.jobTitle, u.phone].filter(Boolean).join(" · "))}</div>` : ""}
        <div class="pf-f"><label for="pp-role">Role</label><select id="pp-role">${ROLE_OPTS(u.role)}</select><div class="small muted" id="pp-role-help">${esc(ROLE_HELP[u.role] || "")}</div></div>
        <div class="pf-f" id="pp-title-wrap" ${u.role === "executive" ? "" : "hidden"}><label for="pp-title">Title</label><select id="pp-title"><option ${u.title === "CEO" ? "selected" : ""}>CEO</option><option ${u.title === "DCEO" ? "selected" : ""}>DCEO</option></select></div>
        <div class="pf-f"><label for="pp-unit">Unit</label><select id="pp-unit">${UNIT_OPTS(u.unit)}</select></div>
        <div class="pf-f"><label>Departments</label>${ddHtml("pp-dept", u.unit, u.departments || [], "Choose departments")}<div class="small muted">Optional. Leaders and planning see and edit the whole unit. Managers and staff edit only their departments, so add one for them to start updating tasks.</div></div>
        <div class="pf-f"><label for="pp-status">Access</label><select id="pp-status" ${self ? "disabled" : ""}><option value="active" ${u.status === "active" ? "selected" : ""}>Active</option><option value="disabled" ${u.status === "disabled" ? "selected" : ""}>Disabled (cannot sign in)</option></select></div>
        ${self ? '<div class="banner info">You cannot change your own role or switch yourself off.</div>' : ""}
        <div class="small muted">Last seen ${u.lastSeen ? esc(String(u.lastSeen).slice(0, 16).replace("T", " ")) + " UTC" : "never"} · joined ${u.createdAt ? esc(String(u.createdAt).slice(0, 10)) : "–"}</div></div>
      <div class="panel-foot save-bar"><div class="toolbar">${self ? "" : `<button class="btn" type="button" data-pe="reset-pw" data-id="${esc(u.id)}" title="Removes their password and signs them out. They sign in with a code and choose a new password.">Reset password</button>`}</div><div class="toolbar"><button class="btn" type="button" data-pe="pp-close">Cancel</button><button class="btn primary" type="button" data-pe="save-user" data-id="${esc(u.id)}">Save changes</button></div></div></aside>`;
  }
  function ppDepts(){
    const us = sortedUnits(); if (!us.length) return "";
    const cur = state.pp.deptUnit && us.some(u => u.id === state.pp.deptUnit) ? state.pp.deptUnit : us[0].id, ds = unitOf(cur).departments || [];
    return `<div class="panel pp-depts"><div class="panel-head"><div><h2>Departments</h2><div class="small muted">Add or remove the departments of a unit. Tasks, people and role requests pick from this list.</div></div>
      <select id="ppDeptUnit" aria-label="Unit">${us.map(u => `<option value="${esc(u.id)}" ${u.id === cur ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select></div>
      <div class="asks"><div class="chipset" style="margin-bottom:10px">${ds.map(d => `<span class="chip">${esc(d)}<button type="button" data-pe="dept-del" data-id="${esc(d)}" aria-label="Remove ${esc(d)}">×</button></span>`).join("") || '<span class="muted small">No departments yet. Add the first one below.</span>'}</div>
      <div class="toolbar"><input type="text" id="ppDeptNew" placeholder="New department name" maxlength="60" style="flex:1;min-width:180px"><button class="btn primary" type="button" data-pe="dept-add">Add department</button></div></div></div>`;
  }
  function ppCode(){
    const c = state.appCode || {};
    return `<div class="panel pp-code"><div class="panel-head"><div><h2>Approval code</h2><div class="small muted">A code only you know. When someone is next to you, ask them to type it on their own screen (sign-up screen, or Profile and settings, Role and access). Their waiting role request is approved as they asked, and you don't need your own phone or PC.</div></div><span class="pill ${c.set ? "s-done" : "s-none"}">${c.set ? "On" : "Off"}</span></div>
      <div class="asks"><div class="toolbar"><input type="password" id="ppCodeIn" autocomplete="new-password" placeholder="${c.set ? "New code (at least 6 characters)" : "Choose a code (at least 6 characters)"}" style="min-width:260px"><button class="btn primary" type="button" data-pe="code-save">${c.set ? "Change code" : "Turn on"}</button>${c.set ? '<button class="btn" type="button" data-pe="code-off">Turn off</button>' : ""}</div>
      ${c.set && c.setAt ? `<div class="small muted" style="margin-top:6px">Set ${esc(String(c.setAt).slice(0, 10))}. Keep it to yourself and change it from time to time.</div>` : ""}</div></div>`;
  }
  function renderPeople(){
    const p = state.people;
    if (!p || p.loading) return `<div class="panel"><div class="empty"><b>Loading people…</b></div></div>`;
    if (p.error) return `<div class="panel"><div class="empty"><b>Could not load people</b>${esc(errText({ error: p.error }))}</div></div>`;
    const us = p.users || [], act = us.filter(u => u.status === "active").length, f = state.pp;
    const invs = (p.invites || []).map(i => `<tr><td>${esc(i.email)}<div class="small muted">${esc(i.name || "")}</div></td><td>${rolePill(i.role)}${i.title ? " · " + esc(i.title) : ""}</td><td class="small">${esc(i.unit ? unitName(i.unit) : "–")}</td><td>${chips(i.departments)}</td><td class="c-act"><button class="btn small ghost danger" data-pe="inv-del" data-id="${esc(i.email)}">Remove</button></td></tr>`).join("");
    return `<div class="pp-head"><div class="pp-stats"><span><b>${us.length}</b> people</span><span><b>${act}</b> active</span>${us.length - act ? `<span><b>${us.length - act}</b> disabled</span>` : ""}<span><b>${state.rr.count + (p.requests || []).length}</b> waiting for you</span></div></div>
    ${ppDecisions(p)}
    <div class="panel pp-list"><div class="panel-head"><div><h2>People</h2><div class="small muted">Role and unit decide what each person can see and change. Changes apply on their next action.</div></div>
      <div class="toolbar pp-filters"><input type="search" id="ppQ" placeholder="Search name or email" value="${esc(f.q)}" aria-label="Search people">
        <select id="ppUnit" aria-label="Unit"><option value="">All units</option>${sortedUnits().map(u => `<option value="${esc(u.id)}" ${f.unit === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>
        <select id="ppRole" aria-label="Role"><option value="">All roles</option>${ROLES.map(r => `<option value="${r}" ${f.role === r ? "selected" : ""}>${esc(ROLE_LABEL[r] || r)}</option>`).join("")}</select>
        <select id="ppSt" aria-label="Access"><option value="">Any access</option><option value="active" ${f.st === "active" ? "selected" : ""}>Active</option><option value="disabled" ${f.st === "disabled" ? "selected" : ""}>Disabled</option></select></div></div>
      <div class="scroll"><table class="pp-table" id="peopleTbl"><thead><tr><th>Person</th><th>Role</th><th>Unit</th><th>Departments</th><th>Access</th><th></th></tr></thead><tbody id="ppBody">${ppRows(p)}</tbody></table></div></div>
    <details class="panel pp-invite"><summary><h2 style="display:inline">Invite someone</h2> <span class="muted small">They sign in with their email and get the role you set here.</span></summary>
      <div class="pp-invite-form"><div class="pf-f"><label for="inv-email">Email</label><input type="email" id="inv-email" placeholder="email@company.com"></div><div class="pf-f"><label for="inv-name">Full name (optional)</label><input type="text" id="inv-name"></div>
        <div class="pf-f"><label for="inv-role">Role</label><select id="inv-role">${ROLE_OPTS("staff")}</select></div><div class="pf-f" id="inv-title-wrap" hidden><label for="inv-title">Title</label><select id="inv-title"><option>CEO</option><option>DCEO</option></select></div>
        <div class="pf-f"><label for="inv-unit">Unit</label><select id="inv-unit">${UNIT_OPTS("")}</select></div><div class="pf-f"><label>Departments</label>${ddHtml("inv-dept", "", [], "Choose departments")}</div>
        <div class="pf-f" style="align-self:end"><button class="btn primary" type="button" data-pe="invite">Send invite</button></div></div>
      ${invs ? `<div class="scroll"><table><thead><tr><th>Waiting invites</th><th>Role</th><th>Unit</th><th>Departments</th><th></th></tr></thead><tbody>${invs}</tbody></table></div>` : ""}</details>
    ${ppDepts()}${ppCode()}
    <div class="grid2 even"><div class="panel"><div class="panel-head"><h2>Allowed email domains</h2></div><div class="asks"><p class="small">People with these company email domains can sign themselves up. They start as Staff in the unit they choose and can ask for a different role, which reaches you here and on the bell.</p>
      <div class="toolbar"><input type="text" id="domainsIn" style="min-width:260px" value="${esc((p.domains || []).join(", "))}"><button class="btn" data-pe="domains">Save domains</button></div></div></div>
      <div class="panel"><div class="panel-head"><h2>Daily backups</h2></div><div class="asks"><p class="small">A copy of all units and plans is kept every night. Download one to keep offline.</p><div id="backupList" class="toolbar" style="flex-wrap:wrap"><button class="btn" data-pe="backups">Show available days</button></div></div></div></div>${ppDrawer(p)}`;
  }
  async function peopleClick(t){
    const a = t.dataset.pe, id = t.dataset.id;
    const done = async (r, ok) => { if (r && r.error) { toast(errText(r)); return false; } toast(ok); state.people = null; await loadPeople(); return true; };
    const q = (s) => document.querySelector(s);
    try {
      if (a === "dept-add") {
        const unit = state.pp.deptUnit || (sortedUnits()[0] || {}).id, el = $("#ppDeptNew"), name = (el.value || "").trim().replace(/\s+/g, " "), list = unitOf(unit).departments || [];
        if (!name) { toast("Type a department name first"); return; }
        if (list.some(x => x.toLowerCase() === name.toLowerCase())) { toast("That department already exists"); return; }
        if (await saveDepts(unit, [...list, name], `Added department "${name}"`)) { state.pp.deptUnit = unit; toast("Department added"); render(); setTimeout(() => { const n = $("#ppDeptNew"); n && n.focus(); }); }
        return;
      }
      if (a === "dept-del") {
        const unit = state.pp.deptUnit || (sortedUnits()[0] || {}).id, list = unitOf(unit).departments || [];
        if (!confirm(`Remove the department "${id}"? Tasks keep their label; people already in it keep it until you change them.`)) return;
        if (await saveDepts(unit, list.filter(x => x !== id), `Removed department "${id}"`)) { state.pp.deptUnit = unit; toast("Department removed"); render(); }
        return;
      }
      if (a === "code-save" || a === "code-off") {
        const v = a === "code-off" ? "" : ($("#ppCodeIn").value || "").trim();
        if (a === "code-off" && !confirm("Turn off the approval code? Role requests will then wait for you to approve them.")) return;
        if (a === "code-save" && v.length < 6) { toast("Use at least 6 characters for the code."); return; }
        const r = await api.adminSetApprovalCode(v); if (r.error) { toast(errText(r)); return; }
        toast(a === "code-off" ? "Approval code turned off" : "Approval code saved");
        const c = await api.adminApprovalCodeStatus(); state.appCode = c && !c.error ? c : {}; render(); return;
      }
      if (a === "pp-edit") { state.pp.edit = id; render(); return; }
      if (a === "pp-close") { state.pp.edit = null; render(); return; }
      if (a === "save-user") {
        const role = q("#pp-role").value, unit = q("#pp-unit").value || null, deps = ddValues(document, "pp-dept");
        const r = await api.adminSaveUser(id, { name: q("#pp-name").value, role, title: role === "executive" ? q("#pp-title").value : "", unit, departments: deps, status: q("#pp-status").value });
        if (await done(r, "Saved")) { state.pp.edit = null; render(); }
      } else if (a === "reset-pw") {
        if (!confirm("Remove this person's password and sign them out everywhere? They can sign in again with a code and choose a new password.")) return;
        await done(await api.adminResetPassword(id), "Password reset. They sign in with a code.");
      } else if (a === "invite") {
        const role = q("#inv-role").value, unit = q("#inv-unit").value || null, deps = ddValues(document, "inv-dept");
        await done(await api.adminInvite({ email: q("#inv-email").value, name: q("#inv-name").value, role, title: role === "executive" ? q("#inv-title").value : "", unit, departments: deps }), "Invite saved. They can now sign in with that email.");
      } else if (a === "inv-del") await done(await api.adminDeleteInvite(id), "Invite removed");
      else if (a === "rr-yes" || a === "rr-no") {
        const card = q(`[data-rrc="${CSS.escape(id)}"]`), role = card.querySelector("[data-rr-role]").value, unit = card.querySelector("[data-rr-unit]").value || null, deps = ddValues(card, "rr-" + id), note = card.querySelector("[data-rr-note]").value;
        await done(await api.adminDecideRole(id, a === "rr-yes", { role, unit, departments: ["planning"].includes(role) ? [] : deps, note }), a === "rr-yes" ? "Approved. Their access changes on their next action." : "Rejected");
      } else if (a === "req-yes" || a === "req-no") {
        const card = q(`[data-rrc="acc-${CSS.escape(id)}"]`), role = card.querySelector("[data-rr-role]").value, unit = card.querySelector("[data-rr-unit]").value || null, deps = ddValues(card, "rr-acc-" + id);
        await done(await api.adminDecideAccess(id, a === "req-yes", { role, unit, title: "", departments: ["planning"].includes(role) ? [] : deps }), a === "req-yes" ? "Approved. They can now sign in." : "Rejected");
      } else if (a === "domains") await done(await api.adminSetDomains($("#domainsIn").value.split(/[ ,;]+/).filter(Boolean)), "Domains saved");
      else if (a === "backups") {
        const r = await api.adminBackups(); if (r.error) { toast(errText(r)); return; }
        const days = r.days || []; $("#backupList").innerHTML = days.length ? days.map(d => `<button class="btn small" data-pe="backup-get" data-id="${esc(d.day || d)}">${esc(d.day || d)}</button>`).join("") : `<span class="muted small">No backups yet.</span>`;
      } else if (a === "backup-get") {
        const r = await api.adminGetBackup(id); if (r.error) { toast(errText(r)); return; }
        await save(`WBG tracker backup ${id}.json`, JSON.stringify(r.data || r, null, 1), "Backup downloaded");
      }
    } catch (e) { toast(errText(e)); }
  }
  // people page: filters, department dropdowns and role helpers
  main.addEventListener("input", e => { const el = e.target; if (el.id === "ppQ") { state.pp.q = el.value; const b = $("#ppBody"); if (b && state.people) b.innerHTML = ppRows(state.people); } });
  main.addEventListener("change", e => {
    const el = e.target;
    if (el.id === "ppUnit" || el.id === "ppRole" || el.id === "ppSt") { state.pp[el.id === "ppUnit" ? "unit" : el.id === "ppRole" ? "role" : "st"] = el.value; const b = $("#ppBody"); if (b && state.people) b.innerHTML = ppRows(state.people); return; }
    if (el.id === "ppDeptUnit") { state.pp.deptUnit = el.value; render(); return; }
    if (el.id === "pp-role") { $("#pp-title-wrap").hidden = el.value !== "executive"; $("#pp-role-help").textContent = ROLE_HELP[el.value] || ""; return; }
    if (el.id === "pp-unit") { ddRefill(main, "pp-dept", el.value, []); return; }
    if (el.id === "inv-role") { $("#inv-title-wrap").hidden = el.value !== "executive"; return; }
    if (el.id === "inv-unit") { ddRefill(main, "inv-dept", el.value, []); return; }
    if (el.dataset.rrUnit) { ddRefill(main.querySelector(`[data-rrc="${CSS.escape(el.dataset.rrUnit)}"]`), "rr-" + el.dataset.rrUnit, el.value, []); return; }
    if (el.dataset.rrRole) { const w = main.querySelector(`[data-rr-deptwrap="${CSS.escape(el.dataset.rrRole)}"]`); if (w) w.hidden = ["planning"].includes(el.value); }
  });
  main.addEventListener("click", e => {
    if (e.target.id === "ppScrim") { state.pp.edit = null; render(); return; }
    const tr = e.target.closest("tr[data-pp]"); if (tr && !e.target.closest("button, a, input, select")) { state.pp.edit = tr.dataset.pp; render(); }
  });

  // ---------- boot ----------
  render();
  function startApp(profile){
    me = profile; myId = profile.name; api.setProfile && api.setProfile(profile);
    api.onSignedOut(() => location.reload());
    state.level = store.get("wp-level") || ((isAppr() || me.role === "executive") ? "deliverables" : "tasks");
    if (!state.editUnit || state.editUnit === ALL) { const mu = myUnit(); if (mu) { state.editUnit = mu; store.set("wp-unit", mu); } }
    if (!isAppr() && state.editUnit && !myUnit() && me.role !== "executive" && me.role !== "leader") state.editUnit = null;
    subscribeRequests(); X.subscribe(); refreshMentions(); refreshRR(); if (["planning", "leader", "super_admin", "executive"].includes(me.role)) subscribeActivity();
    { const st = store.get("wp-start"); if (st && st !== "dashboard" && !location.hash && document.querySelector(`nav.tabs button[data-tab="${st}"]`) && !(st === "people" && !isAppr())) setTimeout(() => goTab(st), 0); }
    window.addEventListener("offline", () => banner("You are offline. Changes will not save until the connection returns."));
    window.addEventListener("online", () => { bannerMsg = ""; subscribePlans(); render(); });
    db.collection("units").onSnapshot(snap => {
      state.units = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(u => !NO_PLAN_UNITS.includes(u.id));
      state.unitsLoaded = true;
      if (state.editUnit && state.editUnit !== ALL && !state.units.some(u => u.id===state.editUnit)) { state.editUnit = null; state.draft = null; }
      if (state.tab==="update" && !hasDraft()) loadDraft();
      else if (state.allDrafts) sortedUnits().forEach(u => { if (!state.allDrafts[u.id]) state.allDrafts[u.id] = clone(state.plans[u.id] || emptyPlan(u.id)); });
      if (!(state.tab === "people" && ((state.pp && state.pp.edit) || Date.now() - (state.ddBusy || 0) < 5000))) render();
    }, err => banner(`Could not load units (${err.code}). Reload the page to reconnect.`));
    subscribePlans();
  }
  (async () => {
    const cfgErr = configError();
    if (cfgErr) { bannerMsg = cfgErr; state.unitsLoaded = state.plansLoaded = true; render(); return; }
    const data = createData(); ({ db, api, downloads } = data); dataMode = data.mode;
    let cur = null; try { cur = await api.session(); } catch (e) { cur = null; }
    const p = await startGate(api, cur && cur.status === "active" && cur.setupDone ? cur : cur);
    startApp(p);
  })();
})();
