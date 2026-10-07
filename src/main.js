import "./style.css";
import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import { applyPlugin } from "jspdf-autotable";
import { createData, configError } from "./data.js";
applyPlugin(jsPDF); window.jspdf = { jsPDF }; window.XLSX = XLSX;

(() => {
  const STATUSES = ["Not started","In progress","Done","Blocked","Delayed"];
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
  const weekLabel = w => { const a = parse(w), b = parse(addDays(w,5)); return a.getMonth()===b.getMonth() ? `${a.getDate()}–${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}` : `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`; };
  const uid = () => Math.random().toString(36).slice(2,10);
  const statusClass = s => s==="Done"?"s-done":s==="In progress"?"s-prog":s==="Blocked"?"s-bad":(s==="Not started"||s==="Delayed")?"s-not":"s-none";
  const todayIso = iso(new Date());
  const who = t => [t.dept, t.owner].filter(Boolean).join(" · ");

  const state = {
    week: iso(mondayOf(new Date())),
    tab: "overview",
    units: [], unitsLoaded: false,
    plans: {}, plansLoaded: false,
    editUnit: null, draft: null, dirty: false, remoteChanged: false,
    
    confirmDelete: null,
    names: {}, activity: [], actLoaded: false, actErr: "", actFilter: { unit: "", who: "", action: "" },
    imp: null, impUnit: "", impPrefill: false, impDefaultUnit: "", importing: false,
    monthBasis: "end", monthByDept: false, monthData: null, monthLoading: false, monthKey: "",
  };
  let db = null, user = null, downloads = null, myId = null, isOwner = false, identity = null;
  let unsubPlans = null;
  const store = { get(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }, set(k,v){ try { localStorage.setItem(k,v); } catch(e){} } };
  const savedUnit = store.get("wp-unit"); if (savedUnit) state.editUnit = savedUnit;

  function toast(msg){ const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2600); }

  // ---------- data ----------
  const planId = (week, unit) => `${week}_${unit}`;
  function emptyPlan(unit){ return { week: state.week, unit, tasks: [], wins: "", blockers: "", asks: "", updatedAt: null, updatedBy: null }; }
  function summarize(p){
    const t = ((p && p.tasks) || []).filter(x => x.kind !== "KPI / OKR");
    const kpi = ((p && p.tasks) || []).length - t.length;
    const done = t.filter(x => x.status==="Done").length;
    const blocked = t.filter(x => x.status==="Blocked").length;
    const high = t.filter(x => x.priority==="High").length;
    const highDone = t.filter(x => x.priority==="High" && x.status==="Done").length;
    const nums = t.map(x => x.status==="Done" ? 100 : (typeof x.pct==="number" ? x.pct : null)).filter(v => v!==null);
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
          if (!state.dirtyUnits.has(u)) state.allDrafts[u] = clone(remote || emptyPlan(u));
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
      return;
    }
    state.allDrafts = null;
    state.draft = clone(state.plans[state.editUnit] || emptyPlan(state.editUnit));
  }
  const planFor = u => isAll() ? state.allDrafts && state.allDrafts[u] : state.draft;

  async function writePlan(u, d){
    d.tasks = d.tasks.filter(t => (t.title||"").trim());
    d.week = state.week; d.unit = u;
    const df = diffPlan(state.plans[u], d);
    d.updatedAt = new Date().toISOString(); d.updatedBy = myId; d.source = "";
    await db.doc(`plans/${planId(state.week, u)}`).set(clone(d));
    if (df.changed) logActivity({ unit: u, week: state.week, action: "save", summary: df.summary, details: df.lines });
  }
  async function saveDraft(){
    if (!db || !hasDraft()) return;
    try {
      if (isAll()) {
        const units = [...state.dirtyUnits];
        for (const u of units) await writePlan(u, state.allDrafts[u]);
        toast(`Saved ${units.length} plan${units.length===1?"":"s"}`);
      } else {
        await writePlan(state.editUnit, state.draft);
        toast("Plan saved");
      }
      state.dirty = false; state.remoteChanged = false; state.dirtyUnits = new Set();
      render();
    } catch (e) {
      toast(e && e.code === "quota_exceeded" ? "The plan store is full. Ask the Strategy Office to archive old weeks." : "Could not save. Check your connection and try again.");
    }
  }

  // ---------- Ethiopian calendar ----------
  const ETH_M = ["Meskerem","Tikimt","Hidar","Tahsas","Tir","Yekatit","Megabit","Miazia","Ginbot","Sene","Hamle","Nehase","Pagume"];
  const jdnOf = (y, m, d) => { const a = Math.floor((14 - m) / 12), yy = y + 4800 - a, mm = m + 12 * a - 3; return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045; };
  function toEth(s){
    const [y, m, d] = s.split("-").map(Number), j = jdnOf(y, m, d) - 1723856, r = j % 1461, n = (r % 365) + 365 * Math.floor(r / 1460);
    return { y: 4 * Math.floor(j / 1461) + Math.floor(r / 365) - Math.floor(r / 1460), m: Math.floor(n / 30) + 1, d: (n % 30) + 1 };
  }
  function ethRange(a, b){ const A = toEth(a), B = toEth(b); return A.m === B.m && A.y === B.y ? `${ETH_M[A.m-1]} ${A.d}–${B.d}, ${A.y} EC` : `${ETH_M[A.m-1]} ${A.d} – ${ETH_M[B.m-1]} ${B.d}, ${B.y} EC`; }
  const ethWeekLabel = w => ethRange(w, addDays(w, 5));
  function ethMonthRange(e){
    const g = new Date(e.y + 7, 8, 11 + 30 * (e.m - 1)); let start = null;
    for (let k = -6; k <= 6 && !start; k++) { const s = iso(new Date(g.getFullYear(), g.getMonth(), g.getDate() + k)), x = toEth(s); if (x.y === e.y && x.m === e.m && x.d === 1) start = s; }
    let end = start; for (let i = 1; i < 31; i++) { const s = addDays(start, i), x = toEth(s); if (x.m === e.m && x.y === e.y) end = s; else break; }
    return { start, end };
  }
  const ethName = e => `${ETH_M[e.m - 1]} ${e.y} EC`;
  state.eth = toEth(iso(new Date())); state.monthBasis = "end";
  state.ov = { priority: "High", status: "", unit: "", q: "", all: false };
  state.expanded = new Set(); state.bf = null; state.carryInfo = null; state.carryKey = "";
  const newFilter = () => ({ unit: "", status: "", statuses: [], priority: "", kind: "", dept: "", q: "", period: "week", from: "", group: false });
  state.filter = newFilter();
  const thisMonday = () => iso(mondayOf(new Date()));
  const nextMonday = () => addDays(thisMonday(), 7);

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
    return n ? `<div class="banner warn" style="margin:12px 16px 0">${n} unfinished task${n > 1 ? "s" : ""} from last week ${n > 1 ? "are" : "is"} not in this week yet. <button class="btn" id="bfBtn2" style="margin-left:6px">Review and bring forward</button></div>` : "";
  }
  function fetchCarry(){
    if (!((state.tab === "update" || state.tab === "plan") && db && state.editUnit && !isAll() && state.draft)) return;
    const key = `${state.week}|${state.editUnit}`; if (state.carryKey === key) return; state.carryKey = key;
    db.doc(`plans/${planId(addDays(state.week, -7), state.editUnit)}`).get().then(s => { state.carryInfo = { key, items: s.exists ? realTasks(s.data()).filter(t => t.status !== "Done") : [] }; render(); }).catch(() => {});
  }
  async function openBf(){
    if (!db || isAll() || !state.editUnit || !state.draft) { toast("Choose one unit first"); return; }
    let prev = null;
    try { const s = await db.doc(`plans/${planId(addDays(state.week, -7), state.editUnit)}`).get(); prev = s.exists ? s.data() : null; } catch (e) { toast("Could not read last week's plan"); return; }
    const have = new Set(state.draft.tasks.map(t => norm(t.title)));
    const items = realTasks(prev).filter(t => t.status !== "Done").map(t => ({ t, dup: have.has(norm(t.title)), checked: !have.has(norm(t.title)) && (t.status === "In progress" || t.status === "Not started" || !t.status) }));
    if (!items.length) { toast("Nothing unfinished in last week's plan"); return; }
    state.bf = { items, week: addDays(state.week, -7) }; renderModal();
  }
  function bfCount(){ return state.bf ? state.bf.items.filter(x => x.checked && !x.dup).length : 0; }
  function renderModal(){
    const root = $("#modalRoot"), b = state.bf; if (!b) { root.innerHTML = ""; return; }
    const order = ["In progress","Not started","","Blocked","Delayed"];
    const groups = order.map(s => ({ s, list: b.items.map((x, i) => ({ ...x, i })).filter(x => (x.t.status || "") === s) })).filter(g => g.list.length);
    root.innerHTML = `<div class="overlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="bfTitle">
      <div class="panel-head"><div><h2 id="bfTitle">Bring forward from last week</h2><div class="small muted">${esc(weekLabel(b.week))} → ${esc(weekLabel(state.week))}. Done tasks are not listed. Blocked and Delayed tasks start unticked: bring them only if they will still be worked on. Unticked tasks stay in last week only.</div></div></div>
      <div class="toolbar" style="padding:10px 16px"><button class="btn" id="bfAll">Select all</button><button class="btn" id="bfProg">In progress only</button><button class="btn" id="bfNone">Select none</button></div>
      <div style="padding:0 16px 8px">${groups.map(g => `<div class="small muted" style="margin:10px 0 4px;font-weight:700;text-transform:uppercase;letter-spacing:.05em">${esc(g.s || "No status")} · ${g.list.length}</div>${g.list.map(x => `<label class="bf-row ${x.dup ? "dim" : ""}"><input type="checkbox" data-bf="${x.i}" ${x.checked ? "checked" : ""} ${x.dup ? "disabled" : ""}><span><b>${esc(x.t.title)}</b>${x.dup ? ' <span class="tag">Already in this week</span>' : ""}<br><span class="small muted">${[x.t.dept, x.t.owner, typeof x.t.pct === "number" ? x.t.pct + "%" : "", x.t.due ? "due " + fmt(x.t.due) : ""].filter(Boolean).map(esc).join(" · ")}</span></span></label>`).join("")}`).join("")}</div>
      <div class="save-bar"><span class="small muted">Past due dates are cleared on the copy and kept in its notes.</span><div class="toolbar"><button class="btn" id="bfCancel">Cancel</button><button class="btn primary" id="bfGo">Bring ${bfCount()} task${bfCount() === 1 ? "" : "s"} forward</button></div></div></div></div>`;
  }
  function bfGo(){
    const b = state.bf; if (!b) return; const sel = b.items.filter(x => x.checked && !x.dup);
    sel.forEach(x => {
      const t = clone(x.t), past = t.due && t.due < todayIso;
      state.draft.tasks.push({ ...t, id: uid(), carried: true, due: past ? "" : (t.due || ""), notes: [t.notes, `Carried from ${fmt(b.week)} week${past ? ` (was due ${fmt(t.due)})` : ""}`].filter(Boolean).join(" | ") });
    });
    if (sel.length) { state.dirty = true; state.dirtyUnits.add(state.editUnit); }
    state.bf = null; renderModal(); toast(sel.length ? `${sel.length} task${sel.length > 1 ? "s" : ""} brought forward. Save to keep them.` : "No tasks selected"); render();
  }
  $("#modalRoot").addEventListener("click", e => {
    const t = e.target.closest("button"); if (!t || !state.bf) return;
    const setAll = fn => { state.bf.items.forEach(x => { if (!x.dup) x.checked = fn(x); }); document.querySelectorAll("#modalRoot input[data-bf]").forEach(c => { const x = state.bf.items[Number(c.dataset.bf)]; c.checked = x.checked; }); const g = $("#bfGo"); if (g) g.textContent = `Bring ${bfCount()} task${bfCount() === 1 ? "" : "s"} forward`; };
    if (t.id === "bfAll") setAll(() => true); else if (t.id === "bfNone") setAll(() => false); else if (t.id === "bfProg") setAll(x => x.t.status === "In progress");
    else if (t.id === "bfCancel") { state.bf = null; renderModal(); } else if (t.id === "bfGo") bfGo();
  });
  $("#modalRoot").addEventListener("change", e => { const c = e.target; if (c.dataset.bf !== undefined && state.bf) { state.bf.items[Number(c.dataset.bf)].checked = c.checked; const g = $("#bfGo"); if (g) g.textContent = `Bring ${bfCount()} task${bfCount() === 1 ? "" : "s"} forward`; } });

  // ---------- overview: task detail ----------
  function renderOvTasks(){
    if (!state.units.length || !state.plansLoaded) return "";
    const o = state.ov, pool = allTasks().filter(t => t.kind !== "KPI / OKR"), q = o.q.trim().toLowerCase();
    const cnt = { high: pool.filter(t => t.priority === "High").length, done: pool.filter(t => t.status === "Done").length, ns: pool.filter(t => t.status === "Not started").length };
    const pr = { High: 0, Medium: 1, Low: 2 };
    const list = pool.filter(t => (!o.unit || t.unit === o.unit) && (!o.priority || (o.priority === "none" ? !t.priority : t.priority === o.priority)) && (!o.status || (o.status === "none" ? !t.status : t.status === o.status)) && (!q || `${t.title} ${t.dept || ""} ${t.owner || ""}`.toLowerCase().includes(q)))
      .sort((a, b) => (pr[a.priority] ?? 3) - (pr[b.priority] ?? 3) || a.unitName.localeCompare(b.unitName));
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
      ${list.length ? `<div class="scroll"><table><thead><tr>${readHead}</tr></thead><tbody>${rows}</tbody></table></div>${list.length > shown.length ? `<div class="toolbar" style="padding:12px 16px"><span class="small muted">Showing ${shown.length} of ${list.length}</span><button class="btn" id="ovAll">Show all</button></div>` : ""}` : `<div class="empty"><b>No tasks match</b>Change the priority or status.</div>`}</div>`;
  }

  // ---------- all tasks (with filters, month drill-down and department grouping) ----------
  function allTasks(){
    return sortedUnits().flatMap(u => (state.plans[u.id]?.tasks || []).map(t => ({ ...t, unit: u.id, unitName: u.name })));
  }
  function poolTasks(){
    if (state.filter.period === "month" && state.monthData) return (monthStats() || []).flatMap(r => r.all.map(t => ({ ...t, unit: r.u.id, unitName: r.u.name })));
    return allTasks();
  }
  function filteredTasks(){
    const f = state.filter, q = f.q.trim().toLowerCase();
    return poolTasks().filter(t => (!f.unit || t.unit === f.unit)
      && (f.statuses.length ? f.statuses.includes(t.status || "") : (!f.status || (f.status === "none" ? !t.status : t.status === f.status)))
      && (!f.priority || t.priority === f.priority) && (!f.kind || (t.kind || "Task") === f.kind) && (!f.dept || (t.dept || "") === f.dept)
      && (!q || `${t.title} ${t.dept || ""} ${t.owner} ${t.notes}`.toLowerCase().includes(q)));
  }
  const readHead = `<th>Unit</th><th>Task</th><th>Department</th><th>Owner (name)</th><th>Due</th><th>Status</th><th>Complete</th><th>Notes</th><th>Updated by</th>`;
  function readRow(t){
    return `<tr>
      <td class="small"><b>${esc(t.unitName)}</b></td>
      <td>${t.priority === "High" ? '<span class="hi-dot" title="High priority"></span>' : ""}${esc(t.title)}${t.kind === "KPI / OKR" ? ' <span class="tag">KPI / OKR</span>' : ""}${t.carried ? ' <span class="tag">carried</span>' : ""}</td>
      <td class="small">${esc(t.dept || "")}</td><td class="small">${esc(t.owner)}</td>
      <td class="num small" style="color:${t.due && t.due < todayIso && t.status !== "Done" ? "var(--bad)" : "inherit"}">${esc(fmt(t.due))}</td>
      <td><span class="pill ${statusClass(t.status)}">${esc(t.status || "No status")}</span></td>
      <td>${typeof t.pct === "number" ? `<div class="prog"><div class="bar"><i style="width:${t.pct}%"></i></div><span class="num">${t.pct}%</span></div>` : '<span class="muted small">–</span>'}</td>
      <td class="small muted">${esc(t.notes)}</td>
      <td class="small" style="white-space:nowrap">${t.lu ? `${esc(fmt(t.lu.slice(0, 10)))} ${t.lb ? `<span class="muted" data-person="${esc(t.lb)}"></span>` : `<span class="muted">data load</span>`}` : '<span class="muted">–</span>'}</td></tr>`;
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
  function renderTasks(){
    const f = state.filter, month = f.period === "month";
    if (month && !state.monthData) return `<div class="panel"><div class="empty"><b>Collecting the weeks of ${esc(ETH_M[state.eth.m - 1])}…</b></div></div>`;
    const list = filteredTasks(), chips = filterChips();
    const depts = [...new Set(poolTasks().filter(t => !f.unit || t.unit === f.unit).map(t => t.dept || "").filter(Boolean))].sort();
    let body = "";
    if (f.group) {
      const byU = new Map(); list.forEach(t => { if (!byU.has(t.unit)) byU.set(t.unit, { name: t.unitName, d: new Map() }); const u = byU.get(t.unit), k = t.dept || ""; if (!u.d.has(k)) u.d.set(k, []); u.d.get(k).push(t); });
      byU.forEach((u, uid_) => {
        const n = [...u.d.values()].reduce((a, b) => a + b.length, 0);
        body += `<tr class="group-row"><td colspan="9"><b>${esc(u.name)}</b> <span class="small muted">${n} task${n === 1 ? "" : "s"}</span></td></tr>`;
        const keys = [...u.d.keys()].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b)), flat = keys.length === 1 && keys[0] === "";
        keys.forEach(k => {
          const key = uid_ + "|" + k, open = flat || state.expanded.has(key), ts = u.d.get(k);
          if (!flat) body += `<tr class="clickable" data-tgl="${esc(key)}" tabindex="0"><td colspan="9"><b>${open ? "▾" : "▸"} ${esc(k || "(no department)")}</b> <span class="small muted">${ts.length}</span></td></tr>`;
          if (open) body += ts.map(readRow).join("");
        });
      });
    } else body = list.map(readRow).join("");
    return `<div class="panel">
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
          <input type="text" id="fQ" placeholder="Search tasks, departments or owners" value="${esc(f.q)}" aria-label="Search">
          <label class="small"><input type="checkbox" id="fGroup" ${f.group ? "checked" : ""}> Group by department</label>
        </div>
        <div class="toolbar"><span class="small muted">${list.length} tasks</span>${downloads ? `<button class="btn" id="tasksPdfBtn">PDF</button><button class="btn" id="tasksXlsxBtn">Excel</button><button class="btn" id="exportBtn">CSV</button>` : ""}</div>
      </div>
      ${list.length ? `<div class="scroll"><table><thead><tr>${readHead}</tr></thead><tbody>${body}</tbody></table></div>` : `<div class="empty"><b>No tasks match</b>Change the filters, or pick another period.</div>`}
    </div>`;
  }

  // ---------- monthly consolidation (Ethiopian calendar) ----------
  function monthWeeks(e, basis){
    const { start, end } = ethMonthRange(e), res = []; let w = iso(mondayOf(parse(addDays(start, -7))));
    for (let i = 0; i < 9; i++) { const x = toEth(basis === "end" ? addDays(w, 5) : w); if (x.y === e.y && x.m === e.m) res.push(w); w = addDays(w, 7); if (w > addDays(end, 7)) break; }
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
  const avgOf = arr => { const n = arr.map(x => x.status === "Done" ? 100 : (typeof x.pct === "number" ? x.pct : null)).filter(v => v !== null); return n.length ? Math.round(n.reduce((a, b) => a + b, 0) / n.length) : null; };
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
      <label class="small muted" for="mBasis">A week counts in the month it</label><select id="mBasis"><option value="end" ${state.monthBasis === "end" ? "selected" : ""}>ends in (Saturday)</option><option value="start" ${state.monthBasis === "start" ? "selected" : ""}>starts in (Monday)</option></select></div>
      <div class="toolbar"><label class="small"><input type="checkbox" id="mDept" ${state.monthByDept ? "checked" : ""}> Show departments</label><button class="btn" id="mRefresh">Refresh</button>${downloads && state.monthData ? `<button class="btn primary" id="mPdf">Monthly report (PDF)</button><button class="btn" id="mXlsx">Excel</button>` : ""}</div></div>`;
    if (!db) return `<div class="panel">${head}<div class="empty"><b>No data</b>The shared store is not available in this view.</div></div>`;
    if (state.monthLoading || !state.monthData) return `<div class="panel">${head}<div class="empty"><b>Collecting the weeks of ${esc(ETH_M[e.m - 1])}…</b></div></div>`;
    const st = monthStats(), md = state.monthData;
    const tot = st.reduce((a, r) => { const s = r.s; return { uniq: a.uniq + s.total, done: a.done + s.done, prog: a.prog + s.prog, ns: a.ns + s.notStarted + s.noStatus, blk: a.blk + s.blocked + s.delayed, entries: a.entries + r.entries, rep: a.rep + (r.reported ? 1 : 0), high: a.high + s.high, highDone: a.highDone + s.highDone }; }, { uniq: 0, done: 0, prog: 0, ns: 0, blk: 0, entries: 0, rep: 0, high: 0, highDone: 0 });
    const avgs = st.map(r => r.s.avg).filter(v => v !== null); const gAvg = avgs.length ? Math.round(avgs.reduce((a, b) => a + b, 0) / avgs.length) : null;
    const wk = md.weeks.map(w => `${ethRange(w, addDays(w, 5)).replace(/, \d+ EC$/, "")}`).join(" · ");
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
  function sortedUnits(){ return [...state.units].sort((a,b) => (a.type||"").localeCompare(b.type||"") || (a.order??99)-(b.order??99) || a.name.localeCompare(b.name)); }

  function renderHero(){
    $("#weekLabel").textContent = weekLabel(state.week);
    const units = state.units.length;
    const submitted = state.units.filter(u => (state.plans[u.id]?.tasks||[]).length).length;
    const all = Object.values(state.plans).flatMap(p => realTasks(p));
    const done = all.filter(t => t.status==="Done").length;
    $("#heroChips").innerHTML = state.plansLoaded && units ? `
      <span class="hero-chip"><b>${submitted}/${units}</b> units submitted</span>
      <span class="hero-chip"><b>${all.length}</b> tasks planned</span>
      <span class="hero-chip"><b>${done}</b> done</span>` : "";
    const mo = state.tab === "monthly";
    $("#heroTitle").textContent = mo ? "Monthly Report" : "Weekly Activity Tracking";
    $("#heroSub").textContent = mo ? "Consolidated by Ethiopian calendar month. Select any number to see the tasks behind it." : "Each function and business unit enters and updates its plan for the week.";
    if (mo) { const r = ethMonthRange(state.eth); $("#weekLabel").textContent = ethName(state.eth); $("#weekSub").textContent = `${fmt(r.start)} – ${fmt(r.end)} ${parse(r.end).getFullYear()}`; }
    else $("#weekSub").textContent = (state.week === thisMonday() ? "This week · " : state.week === nextMonday() ? "Next week · " : "") + ethWeekLabel(state.week);
    $("#thisWeek").textContent = mo ? "This month" : "This week";
    $("#prevWeek").setAttribute("aria-label", mo ? "Previous month" : "Previous week"); $("#nextWeek").setAttribute("aria-label", mo ? "Next month" : "Next week");
    document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab===state.tab)));
    $("#unitsTabBtn").hidden = !isOwner;
    $("#whoBtn").textContent = myId ? `${myId}${isOwner && identity && identity.adminRequired() ? " · admin" : ""} · change` : "Set your name";
  }

  function renderOverview(){
    if (!state.units.length) return `<div class="panel"><div class="empty"><b>No units set up yet</b>${isOwner ? "Open the Units tab to add the functions and business units that report weekly." : "The Strategy Office has not added the reporting units yet."}</div></div>`;
    const rows = sortedUnits().map(u => ({ u, p: state.plans[u.id], s: summarize(state.plans[u.id]) }));
    const tot = rows.reduce((a,r) => ({ total: a.total+r.s.total, done: a.done+r.s.done, blocked: a.blocked+r.s.blocked, high: a.high+r.s.high, highDone: a.highDone+r.s.highDone, overdue: a.overdue+r.s.overdue }), { total:0, done:0, blocked:0, high:0, highDone:0, overdue:0 });
    const submitted = rows.filter(r => r.s.total || r.s.kpi).length;
    const avgs = rows.map(r => r.s.avg).filter(v => v!==null);
    const groupAvg = avgs.length ? Math.round(avgs.reduce((a,b)=>a+b,0)/avgs.length) : null;
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
    return `${stats}
    <div class="grid2">
      <div class="panel">
        <div class="panel-head"><h2>Units this week</h2><div class="toolbar"><span class="muted small">Select a unit to open its plan</span>${downloads ? `<button class="btn primary" id="pdfBtn">Performance report (PDF)</button><button class="btn" id="xlsxAllBtn">All plans (Excel)</button>` : ""}</div></div>
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
    return `<option value="">${list.length ? "Choose department" : "No department"}</option>` + list.map(d => `<option ${d===t.dept?"selected":""}>${esc(d)}</option>`).join("") + `<option value="__new__">＋ Add a department…</option>`;
  }
  function taskRowHtml(u, t, i){
    const key = `${u}|${i}`;
    return `<tr data-u="${esc(u)}" data-i="${i}">
      <td class="c-task"><input type="text" id="t-title-${t.id}" data-f="title" value="${esc(t.title)}" placeholder="Task or deliverable" aria-label="Task"></td>
      <td class="c-kind"><select id="t-kind-${t.id}" data-f="kind" aria-label="Type">${KINDS.map(k => `<option ${k===(t.kind||"Task")?"selected":""}>${k}</option>`).join("")}</select></td>
      <td class="c-dept"><select id="t-dept-${t.id}" data-f="dept" aria-label="Department">${deptOptions(u,t)}</select></td>
      <td class="c-owner"><input type="text" list="dl-owners-${esc(u)}" id="t-owner-${t.id}" data-f="owner" value="${esc(t.owner)}" placeholder="Name" aria-label="Owner name"></td>
      <td class="c-due"><input type="date" id="t-due-${t.id}" data-f="due" value="${esc(t.due)}" aria-label="Due date"></td>
      <td class="c-pri"><select id="t-pri-${t.id}" data-f="priority" aria-label="Priority"><option value="" ${!t.priority?"selected":""}>Not set</option>${PRIORITIES.map(p => `<option ${p===t.priority?"selected":""}>${p}</option>`).join("")}</select></td>
      <td class="c-status"><select id="t-st-${t.id}" data-f="status" aria-label="Status"><option value="" ${!t.status?"selected":""}>No status</option>${STATUSES.map(s => `<option ${s===t.status?"selected":""}>${s}</option>`).join("")}</select></td>
      <td class="c-pct"><input type="number" id="t-pct-${t.id}" data-f="pct" min="0" max="100" step="5" value="${t.pct ?? ""}" placeholder="%" aria-label="Percent complete"></td>
      <td class="c-notes"><input type="text" id="t-notes-${t.id}" data-f="notes" value="${esc(t.notes)}" placeholder="Notes / next step" aria-label="Notes"></td>
      <td>${state.confirmDelete===t.id ? `<span class="confirm">Remove? <button class="btn danger" data-del-yes="${esc(key)}">Yes</button><button class="btn" data-del-no>No</button></span>` : `<button class="icon-btn" data-del="${t.id}" aria-label="Remove task">×</button>`}</td>
    </tr>`;
  }
  const editHead = `<thead><tr><th>Task / deliverable</th><th>Type</th><th>Department</th><th>Owner (name)</th><th>Due</th><th>Priority</th><th>Status</th><th>%</th><th>Notes / next step</th><th></th></tr></thead>`;

  // ---------- helpers for task kinds ----------
  const KINDS = ["Task","KPI / OKR"];
  const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const realTasks = p => ((p && p.tasks) || []).filter(t => t.kind !== "KPI / OKR");
  const kpiTasks = p => ((p && p.tasks) || []).filter(t => t.kind === "KPI / OKR");
  const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const short = s => { s = String(s || ""); return s.length > 70 ? s.slice(0, 67) + "…" : s; };
  const nameOf = id => (id ? (state.names[id] || "") : "");

  // ---------- accountability: who changed what ----------
  const FIELDS = ["title","dept","owner","due","priority","status","pct","notes","kind"];
  const FLAB = { title:"Task", dept:"Department", owner:"Owner", due:"Due", priority:"Priority", status:"Status", pct:"%", notes:"Notes", kind:"Type" };
  const showV = v => (v === null || v === undefined || v === "") ? "–" : String(v);
  function diffPlan(prev, next){
    const pm = new Map(((prev && prev.tasks) || []).map(t => [t.id, t]));
    const nm = new Map(next.tasks.map(t => [t.id, t]));
    const now = new Date().toISOString(); let added = 0, updated = 0, removed = 0; const lines = [];
    next.tasks.forEach(t => {
      const o = pm.get(t.id);
      if (!o) { added++; t.lu = now; t.lb = myId || ""; lines.push(`Added "${short(t.title)}"`); return; }
      const ch = FIELDS.filter(f => String(o[f] ?? "") !== String(t[f] ?? ""));
      if (ch.length) { updated++; t.lu = now; t.lb = myId || ""; lines.push(`Updated "${short(t.title)}": ` + ch.map(f => f === "title" ? "title" : `${FLAB[f]} ${showV(o[f])} → ${showV(t[f])}`).join("; ")); }
    });
    pm.forEach((o, id) => { if (!nm.has(id)) { removed++; lines.push(`Removed "${short(o.title)}"`); } });
    const text = ["wins","blockers","asks"].filter(f => ((prev && prev[f]) || "") !== (next[f] || ""));
    if (text.length) lines.push("Edited: " + text.map(f => ({ wins:"key results", blockers:"blockers", asks:"asks" })[f]).join(", "));
    const bits = [added && `${added} added`, updated && `${updated} updated`, removed && `${removed} removed`, text.length && "report text edited"].filter(Boolean);
    return { summary: bits.join(", "), lines: lines.slice(0, 40), changed: bits.length > 0 };
  }
  async function logActivity(a){
    if (!db) return;
    try {
      const id = `${Date.now().toString(36)}${uid()}`;
      await db.doc("activity/" + id).set({ ts: new Date().toISOString(), by: myId || "", unit: a.unit || "", week: a.week || "", action: a.action, summary: a.summary || "", details: (a.details || []).slice(0, 40) });
    } catch (e) { /* the log is best effort */ }
  }
  let unsubAct = null;
  function subscribeActivity(){
    if (!db || unsubAct) return;
    unsubAct = db.collection("activity").orderBy("ts","desc").limit(400).onSnapshot(snap => {
      state.activity = snap.docs.map(d => ({ id: d.id, ...d.data() })); state.actLoaded = true;
      if (state.tab === "activity") render();
    }, err => { state.actLoaded = true; state.actErr = err.code; unsubAct = null; render(); });
  }
  const actionLabel = a => ({ save:"Saved plan", import:"Imported file", "data-load":"Data load", lists:"Departments / staff", unit:"Unit change" })[a] || a;

  function renderActivity(){
    if (!db) return `<div class="panel"><div class="empty"><b>No activity to show</b>The shared store is not available in this view.</div></div>`;
    if (!state.actLoaded) return `<div class="panel"><div class="empty"><b>Loading activity…</b></div></div>`;
    if (state.actErr) return `<div class="banner warn">Could not load the activity log (${esc(state.actErr)}). Reload the page to try again.</div>`;
    const f = state.actFilter, all = state.activity;
    const people = [...new Set(all.map(a => a.by))];
    const list = all.filter(a => (!f.unit || a.unit === f.unit) && (f.who === "" || a.by === (f.who === "__sys__" ? "" : f.who)) && (!f.action || a.action === f.action));
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
      <td class="small">${esc(a.summary)}${(a.details || []).length ? `<details><summary class="muted">${a.details.length} detail${a.details.length > 1 ? "s" : ""}</summary><ul style="margin:6px 0 0;padding-left:18px">${a.details.map(x => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}</td></tr>`).join("");
    return `<div class="banner info">Every save, import and department change is recorded with the person who made it. Task rows also show who last changed them under All tasks.</div>
    <div class="grid2" style="margin-bottom:16px">
      <div class="panel"><div class="panel-head"><h2>Who is updating</h2><span class="muted small">Last 30 days</span></div>
        ${sumRows ? `<div class="scroll"><table><thead><tr><th>Person</th><th>Updates</th><th>Units</th><th>Last active</th></tr></thead><tbody>${sumRows}</tbody></table></div>` : `<div class="empty"><b>No updates yet</b>Saves and imports appear here.</div>`}</div>
      <div class="panel"><div class="panel-head"><h2>Not updated this week</h2></div><div class="asks">${(() => { const ids = state.units.filter(u => { const p = state.plans[u.id]; return !(p && p.updatedAt && p.updatedBy); }).map(u => u.name); return ids.length ? `<p class="small muted" style="margin:6px 0">No saved update by a person for ${esc(weekLabel(state.week))}:</p><div class="chipset">${ids.map(n => `<span class="tag">${esc(n)}</span>`).join("")}</div>` : `<div class="empty" style="padding:20px 0"><b>Every unit has an update</b></div>`; })()}</div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Activity log</h2><div class="toolbar">
        <select id="aUnit" aria-label="Filter by unit"><option value="">All units</option>${sortedUnits().map(u => `<option value="${esc(u.id)}" ${f.unit === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>
        <select id="aWho" aria-label="Filter by person"><option value="">Everyone</option>${people.map(id => `<option value="${id || "__sys__"}" ${f.who === (id || "__sys__") ? "selected" : ""}>${id ? esc(nameOf(id) || "User " + id.slice(-4)) : "System"}</option>`).join("")}</select>
        <select id="aAct" aria-label="Filter by action"><option value="">All actions</option>${["save","import","lists","data-load"].map(a => `<option value="${a}" ${f.action === a ? "selected" : ""}>${actionLabel(a)}</option>`).join("")}</select>
        <span class="muted small">${list.length} entries</span>${downloads ? `<button class="btn" id="actXlsx">Excel</button>` : ""}</div></div>
      ${list.length ? `<div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>Unit</th><th>Week</th><th>Action</th><th>What changed</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><b>No entries match</b>Change the filters.</div>`}
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
    try { await db.doc("units/" + u).update({ [field]: value }); logActivity({ unit: u, action: "lists", summary: text }); return true; }
    catch (e) { toast("Could not save. Check your connection and try again."); return false; }
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
      : `<span class="chip">${esc(d)} <span class="muted small">${cnt(d)} this week</span><button data-dept-del="${esc(d)}" aria-label="Remove ${esc(d)}">×</button></span>`).join("");
    const ppl = people.map((p, i) => state.confirmDelete === "person:" + i
      ? `<li><span class="confirm">Remove ${esc(p.name)}? <button class="btn danger" data-person-yes="${i}">Remove</button><button class="btn" data-del-no>Keep</button></span></li>`
      : `<li><span>${esc(p.name)}${p.dept ? ` <span class="tag">${esc(p.dept)}</span>` : ""}</span><button class="icon-btn" data-person-del="${i}" aria-label="Remove ${esc(p.name)}">×</button></li>`).join("");
    return `<div class="reports" style="border-bottom:1px solid var(--line)">
      <div><label for="newDept">Departments in ${esc(u.name || "")}</label>
        <div class="chipset" style="margin-bottom:10px">${chips || `<span class="muted small">No departments yet. Add the first one below.</span>`}</div>
        <div class="toolbar"><input type="text" id="newDept" placeholder="New department name" style="flex:1;min-width:160px"><button class="btn primary" id="addDeptBtn">Add department</button></div></div>
      <div><label for="newPerson">Staff names (optional, fills the owner suggestions)</label>
        <ul class="plain">${ppl || `<li class="muted small">No names yet.</li>`}</ul>
        <div class="toolbar"><input type="text" id="newPerson" placeholder="Name" style="flex:1;min-width:120px"><select id="newPersonDept" aria-label="Department of this person"><option value="">No department</option>${depts.map(d => `<option>${esc(d)}</option>`).join("")}</select><button class="btn" id="addPersonBtn">Add name</button></div></div>
      <div style="display:flex;flex-direction:column;justify-content:flex-end;gap:8px"><span class="small muted">Changes save straight away and fill the Department dropdown for every task in this unit. Import files can also create departments.</span><div class="toolbar"><button class="btn" id="listsCancel">Close</button></div></div>
    </div>`;
  }

  function renderUpdate(){
    if (!state.units.length) return `<div class="panel"><div class="empty"><b>No units to report for</b>Units appear here once the Strategy Office adds them.</div></div>`;
    const opts = `<option value="${ALL}" ${isAll()?"selected":""}>All units</option>` + sortedUnits().map(u => `<option value="${esc(u.id)}" ${u.id===state.editUnit?"selected":""}>${esc(u.name)}</option>`).join("");
    const single = hasDraft() && !isAll();
    const head = `<div class="panel-head">
      <div class="toolbar"><label for="unitPick" class="small muted">Unit</label>
        <select id="unitPick"><option value="">Choose your function or unit…</option>${opts}</select></div>
      ${single ? `<div class="toolbar"><button class="btn" id="listsBtn">Departments${(unitOf(state.editUnit).departments||[]).length ? ` (${unitOf(state.editUnit).departments.length})` : ""}</button><button class="btn ghost" id="carryBtn">Bring forward unfinished work…</button>${downloads ? `<button class="btn" id="unitPdfBtn">Plan (PDF)</button><button class="btn" id="unitXlsxBtn">Plan (Excel)</button>` : ""}<button class="btn primary" id="addTask">+ Add task</button></div>` : ""}
      ${isAll() && downloads ? `<div class="toolbar"><button class="btn" id="pdfBtn">Performance report (PDF)</button><button class="btn" id="xlsxAllBtn">All plans (Excel)</button></div>` : ""}
    </div>`;
    if (!state.editUnit || !hasDraft()) return `<div class="panel">${head}<div class="empty"><b>Choose your unit to start</b>Pick your function or business unit, or "All units" to update every plan on one screen. Then set each task's department, owner, due date and priority, and update status and % complete as the week goes on.</div></div>`;
    const warn = state.remoteChanged ? `<div class="banner warn" style="margin:12px 16px 0">Someone else saved ${isAll() ? "one of these plans" : "this plan"} while you were editing. <button class="btn" id="reloadRemote" style="margin-left:6px">Load the latest version</button> or save yours to replace it.</div>` : "";
    const saveBar = (meta) => `<div class="save-bar"><span class="small muted">${state.dirty ? `<b style='color:var(--accent)'>Unsaved changes${isAll() && state.dirtyUnits.size ? ` in ${state.dirtyUnits.size} unit${state.dirtyUnits.size>1?"s":""}` : ""}</b>` : meta}</span>
        <div class="toolbar"><button class="btn" id="discardBtn" ${state.dirty?"":"disabled"}>Discard changes</button><button class="btn primary" id="saveBtn" ${state.dirty?"":"disabled"}>${isAll() ? "Save all changes" : "Save plan"}</button></div></div>`;

    const cb = carryBanner();
    if (isAll()) {
      const groups = sortedUnits().map(u => {
        const d = state.allDrafts[u.id] || emptyPlan(u.id);
        const s = summarize(d);
        const rows = d.tasks.map((t,i) => taskRowHtml(u.id, t, i)).join("");
        return `<tbody><tr class="group-row"><td colspan="10"><div class="toolbar" style="justify-content:space-between">
            <div><b>${esc(u.name)}</b> <span class="tag">${esc(u.type||"")}</span> <span class="small muted">${s.total} tasks · ${s.done} done${state.dirtyUnits.has(u.id) ? " · <b style='color:var(--accent)'>edited</b>" : ""}</span></div>
            <button class="btn" data-add-unit="${esc(u.id)}">+ Add task</button></div>${ownerDatalist(u.id)}</td></tr>
          ${rows || `<tr><td colspan="10" class="small muted">No tasks entered yet.</td></tr>`}</tbody>`;
      }).join("");
      return `<div class="panel">${head}${warn}
        <div class="scroll"><table class="edit-table">${editHead}${groups}</table></div>
        <div class="banner info" style="margin:12px 16px">To edit a unit's key results, blockers and asks, or its departments and staff lists, choose that unit on its own.</div>
        ${saveBar("Showing every unit's plan for this week")}</div>`;
    }

    const d = state.draft;
    const p = state.plans[state.editUnit];
    const meta = p && p.updatedAt ? `Last saved ${fmt(p.updatedAt.slice(0,10))} ${p.updatedAt.slice(11,16)} UTC ${p.updatedBy ? `<span data-person="${esc(p.updatedBy)}"></span>` : `· ${esc(p.source || "data load")}`}` : "Not saved yet for this week";
    const u = unitOf(state.editUnit);
    const listHint = !(u.departments||[]).length ? `<div class="banner info" style="margin:12px 16px 0">${esc(u.name||"This unit")} has no departments yet. Select <b>Departments</b> to add them, then pick one for each task.</div>` : "";
    return `<div class="panel">${head}${state.showLists ? renderLists() : ""}${warn}${cb}${listHint}
      ${ownerDatalist(state.editUnit)}${d.tasks.length ? `<div class="scroll"><table class="edit-table">${editHead}<tbody>${d.tasks.map((t,i) => taskRowHtml(state.editUnit, t, i)).join("")}</tbody></table></div>` : `<div class="empty"><b>No tasks yet for ${esc(unitName(state.editUnit))}</b>Add this week's tasks, or copy last week's unfinished ones.</div>`}
      <div class="reports">
        <div><label for="f-wins">Key results this week</label><textarea id="f-wins" data-r="wins" placeholder="What was achieved">${esc(d.wins)}</textarea></div>
        <div><label for="f-blockers">Blockers and issues</label><textarea id="f-blockers" data-r="blockers" placeholder="What is stopping progress">${esc(d.blockers)}</textarea></div>
        <div><label for="f-asks">Asks to top management or other units</label><textarea id="f-asks" data-r="asks" placeholder="Decision, approval or support needed, and by when">${esc(d.asks)}</textarea></div>
      </div>
      ${saveBar(meta)}
    </div>`;
  }

  function renderUnits(){
    const rows = sortedUnits().map(u => `<tr>
      <td><input type="text" id="u-name-${esc(u.id)}" data-unit-name="${esc(u.id)}" value="${esc(u.name)}" aria-label="Unit name"></td>
      <td><select data-unit-type="${esc(u.id)}" id="u-type-${esc(u.id)}" aria-label="Unit type"><option ${u.type==="Corporate function"?"selected":""}>Corporate function</option><option ${u.type==="Business unit"?"selected":""}>Business unit</option></select></td>
      <td>${state.confirmDelete==="unit:"+u.id ? `<span class="confirm">Remove unit? Past plans stay saved. <button class="btn danger" data-unit-del-yes="${esc(u.id)}">Remove</button><button class="btn" data-del-no>Cancel</button></span>` : `<button class="btn ghost danger" data-unit-del="${esc(u.id)}">Remove</button>`}</td></tr>`).join("");
    return `<div class="panel">
      <div class="panel-head"><h2>Reporting units</h2><span class="muted small">Only you, as owner, see this tab. Name changes save when you leave the field.</span></div>
      <div class="scroll"><table><thead><tr><th>Name</th><th>Type</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="save-bar"><div class="toolbar"><input type="text" id="newUnitName" placeholder="New unit name"><select id="newUnitType"><option>Corporate function</option><option>Business unit</option></select><button class="btn primary" id="addUnit">Add unit</button></div></div>
    </div>`;
  }

  async function fillPeople(){
    if (!user) return;
    const els = [...document.querySelectorAll("[data-person]")].filter(e => e.dataset.person);
    if (!els.length) return;
    const ps = await user.profiles([...new Set(els.map(e => e.dataset.person))]);
    let learned = false;
    els.forEach(e => { const id = e.dataset.person, n = ps[id]?.name; if (n && state.names[id] !== n) { state.names[id] = n; learned = true; } const bare = e.hasAttribute("data-bare"); e.textContent = n ? (bare ? n : `by ${n}`) : (bare ? "Someone" : ""); });
    if (learned && state.tab === "activity") render();
  }

  function render(){
    renderHero();
    const main = $("#main");
    const active = document.activeElement && document.activeElement.id;
    let html = bannerMsg ? `<div class="banner warn">${esc(bannerMsg)}</div>` : "";
    if (!db) html += `<div class="banner warn">Not connected to the database, so plans cannot be loaded or saved.</div>`;
    if (!state.unitsLoaded || !state.plansLoaded) html += `<div class="panel"><div class="empty"><b>Loading weekly plans…</b>Fetching plans for ${esc(weekLabel(state.week))}.</div></div>`;
    else if (state.tab==="overview") html += renderOverview() + renderOvTasks();
    else if (state.tab==="update") html += planBanner() + renderUpdate();
    else if (state.tab==="plan") html += planBanner() + renderUpdate() + renderImport();
    else if (state.tab==="tasks") html += renderTasks();
    else if (state.tab==="follow") html += renderFollow();
    else if (state.tab==="monthly") html += renderMonthly();
    else if (state.tab==="activity") html += renderActivity();
    else if (state.tab==="units" && isOwner) html += renderUnits();
    main.innerHTML = html;
    if (active) { const el = document.getElementById(active); if (el && el.focus) { el.focus(); if (el.setSelectionRange && el.type==="text") { const n = el.value.length; try { el.setSelectionRange(n,n); } catch(e){} } } }
    fillPeople(); fetchCarry();
  }

  // ---------- events ----------
  function setWeek(w){
    if (state.dirty) { toast("Save or discard your changes first"); return; }
    state.week = w; state.draft = null; state.allDrafts = null; subscribePlans();
  }
  const monthTab = () => state.tab === "monthly";
  $("#prevWeek").onclick = () => monthTab() ? shiftMonth(-1) : setWeek(addDays(state.week,-7));
  $("#nextWeek").onclick = () => monthTab() ? shiftMonth(1) : setWeek(addDays(state.week,7));
  $("#thisWeek").onclick = () => { if (monthTab()) { state.eth = toEth(todayIso); loadMonth(); } else setWeek(state.tab === "plan" ? nextMonday() : thisMonday()); };
  document.querySelectorAll("nav.tabs button").forEach(b => b.onclick = () => { const to = b.dataset.tab; if (state.dirty && (to === "plan" || to === "update") && to !== state.tab) { const w = to === "plan" ? nextMonday() : thisMonday(); if (w !== state.week) { toast("Save or discard your changes first"); return; } }
    state.tab = to; state.confirmDelete = null;
    if (to === "plan" && state.week < nextMonday() && !state.dirty) { state.week = nextMonday(); state.draft = null; state.allDrafts = null; subscribePlans(); }
    else if (to === "update" && state.week > thisMonday() && !state.dirty) { state.week = thisMonday(); state.draft = null; state.allDrafts = null; subscribePlans(); }
    if ((state.tab==="update"||state.tab==="plan") && !hasDraft()) loadDraft(); if (state.tab==="activity") subscribeActivity(); if (state.tab==="monthly" && db && !state.monthLoading && (!state.monthData || state.monthKey !== `${state.eth.y}-${state.eth.m}${state.monthBasis}`)) { render(); loadMonth(); return; } render(); });

  const main = $("#main");
  main.addEventListener("click", e => {
    const t = e.target.closest("button, tr[data-open-unit], tr[data-tgl]");
    if (!t) return;
    if (t.dataset.tgl) { const k = t.dataset.tgl; state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k); render(); return; }
    if (t.matches("tr[data-open-unit]")) { openUnit(t.dataset.openUnit); return; }
    if (t.id==="addTask" || t.dataset.addUnit) { const u = t.dataset.addUnit || state.editUnit, d = planFor(u); const nt = { id: uid(), title:"", dept:"", owner:"", due:"", priority:"Medium", status:"Not started", pct:0, notes:"", kind:"Task" }; d.tasks.push(nt); state.dirty = true; state.dirtyUnits.add(u); render(); const el = document.getElementById("t-title-"+nt.id); el && el.focus(); }
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
    else if (t.id==="saveBtn") saveDraft();
    else if (t.id==="discardBtn") { loadDraft(); render(); toast("Changes discarded"); }
    else if (t.id==="carryBtn") openBf();
    else if (t.id==="reloadRemote") { loadDraft(); render(); }
    else if (t.dataset.del) { state.confirmDelete = t.dataset.del; render(); }
    else if (t.dataset.delYes !== undefined) { const [u, i] = t.dataset.delYes.split("|"); planFor(u).tasks.splice(Number(i),1); state.confirmDelete = null; state.dirty = true; state.dirtyUnits.add(u); render(); }
    else if (t.hasAttribute("data-del-no")) { state.confirmDelete = null; render(); }
    else if (t.id==="exportBtn") exportCsv();
    else if (t.id==="pdfBtn") exportPdf();
    else if (t.id==="xlsxAllBtn") exportXlsxAll();
    else if (t.id==="unitPdfBtn") exportUnitPdf();
    else if (t.id==="unitXlsxBtn") exportUnitXlsx();
    else if (t.id==="tasksPdfBtn") exportTasksPdf();
    else if (t.id==="tasksXlsxBtn") exportTasksXlsx();
    else if (t.dataset.copy) copyReminder(t.dataset.copy, t);
    else if (t.id==="addUnit") addUnit();
    else if (t.dataset.unitDel) { state.confirmDelete = "unit:"+t.dataset.unitDel; render(); }
    else if (t.dataset.unitDelYes) { db.doc("units/"+t.dataset.unitDelYes).delete().then(() => toast("Unit removed")); state.confirmDelete = null; }
  });
  main.addEventListener("keydown", e => { const tr = e.target.closest("tr[data-open-unit]"); if (tr && (e.key==="Enter"||e.key===" ")) { e.preventDefault(); openUnit(tr.dataset.openUnit); } });
  main.addEventListener("input", e => {
    const el = e.target;
    if (el.dataset.f) {
      const tr = el.closest("tr"), u = tr.dataset.u, i = Number(tr.dataset.i), f = el.dataset.f, task = planFor(u).tasks[i];
      if (f==="dept" && el.value==="__new__") { el.value = task.dept || ""; if (isAll()) { toast("Open the unit on its own to add a department"); return; } state.showLists = true; render(); setTimeout(() => { const n = $("#newDept"); n && n.focus(); }); return; }
      state.dirtyUnits.add(u);
      if (f==="pct") { const v = el.value==="" ? null : Math.max(0, Math.min(100, Number(el.value))); task.pct = v; if (v===100 && task.status!=="Done") { task.status = "Done"; const s = document.getElementById("t-st-"+task.id); if (s) s.value = "Done"; } }
      else { task[f] = el.value; if (f==="status" && el.value==="Done") { task.pct = 100; const p = document.getElementById("t-pct-"+task.id); if (p) p.value = 100; } }
      markDirty();
    } else if (el.dataset.r) { state.draft[el.dataset.r] = el.value; state.dirtyUnits.add(state.editUnit); markDirty(); }
    else if (el.id==="fQ") { state.filter.q = el.value; render(); }
    else if (el.id==="ovQ") { state.ov.q = el.value; render(); }
  });
  main.addEventListener("change", e => {
    const el = e.target;
    if (el.id==="unitPick") {
      if (state.dirty) { el.value = state.editUnit || ""; toast("Save or discard your changes first"); return; }
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
    else if (el.id==="impUnit") { state.impUnit = el.value; state.impDefaultUnit = el.value ? unitName(el.value) : ""; render(); }
    else if (el.id==="impPrefill") { state.impPrefill = el.checked; }
    else if (el.id==="impFile") { if (el.files && el.files[0]) readImportFile(el.files[0]); }
    else if (el.id==="impMode") { state.imp.mode = el.value; state.imp.needConfirm = false; state.imp.confirmed = false; render(); }
    else if (el.id==="impDepts") { state.imp.newDepts = el.checked; }
    else if (el.id==="aUnit") { state.actFilter.unit = el.value; render(); }
    else if (el.id==="aWho") { state.actFilter.who = el.value; render(); }
    else if (el.id==="aAct") { state.actFilter.action = el.value; render(); }
    else if (el.id==="mBasis") { state.monthBasis = el.value; loadMonth(); }
    else if (el.id==="mDept") { state.monthByDept = el.checked; render(); }
    else if (el.dataset.unitName) { const v = el.value.trim(); if (v) db.doc("units/"+el.dataset.unitName).update({ name: v }).then(() => toast("Unit renamed")); }
    else if (el.dataset.unitType) { db.doc("units/"+el.dataset.unitType).update({ type: el.value }).then(() => toast("Unit type updated")); }
  });
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
    await db.doc("units/"+id).set({ name, type, order: state.units.length + 1 });
    toast("Unit added");
  }

  async function exportCsv(){
    const cell = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
    const head = ["Week","Unit","Task","Department","Owner (name)","Due","Priority","Status","% complete","Notes"];
    const lines = [head.join(",")].concat(filteredTasks().map(t => [state.week, t.unitName, t.title, t.dept||"", t.owner, t.due, t.priority, t.status||"No status", t.pct ?? "", t.notes].map(cell).join(",")));
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
  function reminderText(r){
    const lines = [`Dear ${r.u.name} team,`, "", `This is a follow-up from the Group Strategy Office on your weekly plan for ${weekLabel(state.week)}.`];
    if (r.noPlan) lines.push("", "- Your weekly plan has not been submitted yet. Please enter it in WBG Strategy Office Weekly Activity Tracking today.");
    if (r.overdue.length) { lines.push("", "Tasks past their due date and not yet done:"); r.overdue.forEach(t => lines.push(`- ${t.title} (due ${fmt(t.due)}${who(t)?`, ${who(t)}`:""}${typeof t.pct==="number"?`, ${t.pct}%`:""})`)); }
    if (r.blocked.length) { lines.push("", "Blocked tasks (please state the support you need):"); r.blocked.forEach(t => lines.push(`- ${t.title}${who(t)?` (${who(t)})`:""}`)); }
    if (r.noStatus.length) { lines.push("", `${r.noStatus.length} task${r.noStatus.length>1?"s have":" has"} no status. Please update status and % complete.`); }
    lines.push("", "Please update the tracker before the Friday review.", "", "Group Strategy Office");
    return lines.join("\n");
  }
  async function copyReminder(unitId, btn){
    const r = lateItems().find(x => x.u.id === unitId); if (!r) return;
    const text = reminderText(r);
    try { await navigator.clipboard.writeText(text); toast("Reminder copied. Paste it into email or Telegram."); }
    catch (e) { const ta = document.getElementById("rem-"+unitId); if (ta) { ta.hidden = false; ta.select(); } toast("Select the text and copy it"); }
  }
  function renderFollow(){
    const items = lateItems();
    if (!state.units.length) return `<div class="panel"><div class="empty"><b>No units set up yet</b></div></div>`;
    if (!items.length) return `<div class="panel"><div class="empty"><b>Nothing to follow up</b>Every unit has a plan with status, and no task is overdue or blocked for ${esc(weekLabel(state.week))}.</div></div>`;
    const cards = items.map(r => `<div class="panel" style="margin-bottom:12px">
      <div class="panel-head"><div><div class="unit-name">${esc(r.u.name)}</div>
        <div class="toolbar small" style="margin-top:4px">${r.noPlan?'<span class="pill s-bad">No plan</span>':""}${r.overdue.length?`<span class="pill s-bad">${r.overdue.length} overdue</span>`:""}${r.blocked.length?`<span class="pill s-bad">${r.blocked.length} blocked</span>`:""}${r.noStatus.length?`<span class="pill s-not">${r.noStatus.length} without status</span>`:""}${r.stale?'<span class="pill s-none">Not updated for 3+ days</span>':""}</div></div>
        <button class="btn" data-copy="${esc(r.u.id)}">Copy reminder</button></div>
      ${(r.overdue.length||r.blocked.length) ? `<div class="scroll"><table><thead><tr><th>Task</th><th>Department</th><th>Owner (name)</th><th>Due</th><th>Status</th><th>%</th></tr></thead><tbody>${[...r.overdue, ...r.blocked.filter(b => !r.overdue.includes(b))].map(t => `<tr><td>${t.priority==="High"?'<span class="hi-dot"></span>':""}${esc(t.title)}</td><td class="small">${esc(t.owner)}</td><td class="num small" style="color:var(--bad)">${esc(fmt(t.due))}</td><td><span class="pill ${statusClass(t.status)}">${esc(t.status||"No status")}</span></td><td class="num small">${t.pct ?? "–"}</td></tr>`).join("")}</tbody></table></div>` : ""}
      <textarea id="rem-${esc(r.u.id)}" hidden readonly style="margin:0 16px 16px;width:calc(100% - 32px);min-height:140px">${esc(reminderText(r))}</textarea>
    </div>`).join("");
    return `<div class="banner info">Units below need follow-up for ${esc(weekLabel(state.week))}. Copy a reminder and send it by email, Telegram or your usual channel.</div>${cards}`;
  }

  // ---------- PDF report ----------
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
  const taskRow = (t,i) => [i+1, t.title||"", t.dept||"", t.owner||"", fmt(t.due), t.priority||"", t.status||"No status", typeof t.pct==="number" ? t.pct+"%" : "", t.notes||""];
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
    doc.autoTable({ startY: 148, margin: { left: 36, right: 36 }, head: [["#","Task / deliverable","Department","Owner (name)","Due","Priority","Status","%","Notes / next step"]],
      body: (p.tasks||[]).length ? p.tasks.map(taskRow) : [["","No tasks entered","","","","","",""]],
      columnStyles: { 0: { cellWidth: 22 }, 1: { cellWidth: 190 }, 2: { cellWidth: 74 }, 3: { cellWidth: 82 }, 4: { cellWidth: 44 }, 5: { cellWidth: 48 }, 6: { cellWidth: 62 }, 7: { cellWidth: 30 } }, ...tableStyle() });
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
  const taskHead = ["#","Task / deliverable","Department","Owner (name)","Due","Priority","Status","% complete","Notes / next step","Type"];
  const taskWidths = [5,55,18,22,12,10,13,11,50,11];
  const xlsxTask = (t,i) => [i+1, t.title||"", t.dept||"", t.owner||"", t.due||"", t.priority||"", t.status||"No status", typeof t.pct==="number" ? t.pct/100 : "", t.notes||"", t.kind||"Task"];
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
    doc.autoTable({ startY: 92, margin: { left: 36, right: 36 }, head: [["Unit","Task / deliverable","Department","Owner (name)","Due","Priority","Status","%","Notes"]],
      body: list.length ? list.map(t => [t.unitName, t.title||"", t.dept||"", t.owner||"", fmt(t.due), t.priority||"", t.status||"No status", typeof t.pct==="number" ? t.pct+"%" : "", t.notes||""]) : [["","No tasks match","","","","","",""]],
      columnStyles: { 0: { cellWidth: 84, fontStyle: "bold" }, 1: { cellWidth: 180 }, 2: { cellWidth: 70 }, 3: { cellWidth: 76 }, 4: { cellWidth: 42 }, 5: { cellWidth: 46 }, 6: { cellWidth: 60 }, 7: { cellWidth: 28 } }, ...tableStyle() });
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
  const TCOLS = ["Week starting","Unit","Department","Task / deliverable","Type","Owner","Due date","Priority","Status","% complete","Notes / next step"];
  const SCOLS = ["Week starting","Unit","Key results this week","Blockers and issues","Asks to top management or other units"];
  const TWIDTH = [14,32,22,60,11,24,12,10,13,11,50];
  function colKey(h){
    const k = String(h ?? "").toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim(); if (!k) return "";
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
  const STATUS_MAP = { "not started":"Not started", "in progress":"In progress", "done":"Done", "blocked":"Blocked", "delayed":"Delayed", "started":"In progress", "complete":"Done", "completed":"Done" };
  function matchUnit(v){
    const k = norm(v); if (!k) return null;
    let hit = state.units.find(u => norm(u.name) === k || norm(u.id) === k); if (hit) return hit;
    const part = state.units.filter(u => norm(u.name).includes(k) || k.includes(norm(u.name)));
    return part.length === 1 ? part[0] : null;
  }
  function parseRow(raw, map, ctx){
    const g = f => (map[f] != null ? raw[map[f]] : "");
    const r = { err: [], warn: [], row: {} };
    const title = String(g("title") ?? "").trim();
    const unitTxt = String(g("unit") ?? "").trim() || ctx.defaultUnit || "";
    if (!title && !unitTxt) return null;
    const unit = matchUnit(unitTxt);
    if (!title) r.err.push("No task title");
    if (!unitTxt) r.err.push("No unit"); else if (!unit) r.err.push(`Unit "${unitTxt}" not found`);
    r.unit = unit; r.unitTxt = unitTxt;
    const wv = g("week"); let week = state.week;
    if (wv !== "" && wv != null) { const w = toIso(wv, ctx.year); if (w) week = iso(mondayOf(parse(w))); else r.warn.push("Week not understood, used the selected week"); }
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
    r.row = { title, dept: String(g("dept") ?? "").trim(), owner: String(g("owner") ?? "").trim(), due, priority, status, pct, notes, kind };
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
          const wv = sh.map.week != null ? toIso(row[sh.map.week], year) : ""; sums.push({ unit: u, week: wv ? iso(mondayOf(parse(wv))) : state.week, wins: txt("wins"), blockers: txt("blockers"), asks: txt("asks") }); } }
      state.imp = { fileName: file.name, rows: parsed, sums, mode: state.imp && state.imp.mode || "merge", newDepts: true };
      if (!parsed.length && !sums.length) state.imp.error = "The file has no task rows."; else setTimeout(computeImpact, 0);
    } catch (e) { state.imp = { error: "Could not read this file. Save it as .xlsx or .csv and try again." }; }
    render();
  }
  function templateRows(unitId, prefill){
    const units = unitId ? state.units.filter(u => u.id === unitId) : sortedUnits(); const out = [];
    if (prefill) units.forEach(u => (state.plans[u.id]?.tasks || []).forEach(t => out.push([state.week, u.name, t.dept || "", t.title || "", t.kind || "Task", t.owner || "", t.due || "", t.priority || "", t.status || "", typeof t.pct === "number" ? t.pct / 100 : "", t.notes || ""])));
    else if (unitId) for (let i = 0; i < 15; i++) out.push([state.week, units[0].name, "", "", "Task", "", "", "", "", "", ""]);
    return out;
  }
  async function downloadTemplate(){
    if (!libsReady("xlsx")) return;
    const unitId = state.impUnit || "", prefill = !!state.impPrefill;
    const wb = XLSX.utils.book_new();
    const rows = templateRows(unitId, prefill);
    const ws = sheetFromRows([TCOLS, ...rows], TWIDTH); pctFormat(ws, 9, 1);
    XLSX.utils.book_append_sheet(wb, ws, "Weekly plan");
    const su = (unitId ? state.units.filter(u => u.id === unitId) : sortedUnits()).map(u => { const p = state.plans[u.id]; return [state.week, u.name, (p && p.wins) || "", (p && p.blockers) || "", (p && p.asks) || ""]; });
    XLSX.utils.book_append_sheet(wb, sheetFromRows([SCOLS, ...su], [14,32,50,50,50]), "Summary");
    const ins = [["How to fill in this template"], [],
      ["1","One row per task. Fill the 'Weekly plan' sheet. Keep the header row exactly as it is."],
      ["2","Unit: the exact name of your function or business unit (see the list below)."],
      ["3","Department: a department inside your unit. A new name is added to the unit automatically on import."],
      ["4","Week starting: any date inside the week (for example 2026-10-05). Leave blank to use the week selected on the page."],
      ["5","Type: Task, or KPI / OKR for indicator lines."],
      ["6","Due date: write it as 2026-10-09 or 9-Oct-2026. Text such as 'Q1' is kept in the notes instead."],
      ["7","Priority: High, Medium or Low."],
      ["8","Status: Not started, In progress, Done, Blocked or Delayed."],
      ["9","% complete: 0 to 100 (50 or 50%). Done with no % counts as 100%."],
      ["10","'Summary' sheet (optional): key results, blockers and asks for the week, one row per unit."],
      ["11","On import, rows with the same task title as an existing task update it. New titles are added."], [],
      ["Units and their departments"], ["Unit","Type","Departments"],
      ...sortedUnits().map(u => [u.name, u.type || "", (u.departments || []).join(", ")])];
    XLSX.utils.book_append_sheet(wb, sheetFromRows(ins, [28,40,80]), "Instructions");
    const nm = unitId ? safeName(unitName(unitId)) : "all units";
    await writeXlsx(wb, `Weekly plan template ${nm} ${state.week}.xlsx`, "Template saved");
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
    let nTasks = 0, nGroups = 0;
    try {
      for (const g of groups.values()) {
        const ref = db.doc(`plans/${planId(g.week, g.unit.id)}`); const snap = await ref.get();
        const plan = snap.exists ? clone(snap.data()) : { week: g.week, unit: g.unit.id, tasks: [], wins: "", blockers: "", asks: "" };
        const prev = clone(plan); if (imp.mode === "replace" && g.rows.length) plan.tasks = [];
        plan.tasks = plan.tasks || [];
        g.rows.forEach(r => {
          const key = norm(r.row.title); const ex = plan.tasks.find(t => norm(t.title) === key);
          if (ex) { FIELDS.forEach(f => { const v = r.row[f]; if (v !== "" && v !== null && v !== undefined) ex[f] = v; }); }
          else plan.tasks.push({ id: uid(), title: r.row.title, dept: r.row.dept, owner: r.row.owner, due: r.row.due, priority: r.row.priority, status: r.row.status, pct: r.row.pct, notes: r.row.notes, kind: r.row.kind });
        });
        if (g.sum) { ["wins","blockers","asks"].forEach(f => { if (g.sum[f]) plan[f] = g.sum[f]; }); }
        const df = diffPlan(prev, plan); if (!df.changed) continue;
        plan.week = g.week; plan.unit = g.unit.id; plan.updatedAt = new Date().toISOString(); plan.updatedBy = myId; plan.source = "Import: " + imp.fileName;
        await ref.set(clone(plan)); nTasks += g.rows.length; nGroups++;
        logActivity({ unit: g.unit.id, week: g.week, action: "import", summary: `Imported ${imp.fileName}: ${df.summary}`, details: df.lines });
        if (imp.newDepts) {
          const have = g.unit.departments || []; const add = [...new Set(g.rows.map(r => r.row.dept).filter(d => d && !have.some(h => h.toLowerCase() === d.toLowerCase())))];
          if (add.length) { await db.doc("units/" + g.unit.id).update({ departments: [...have, ...add] }); logActivity({ unit: g.unit.id, action: "lists", summary: "Added departments from import: " + add.join(", ") }); }
        }
      }
      toast(nGroups ? `Imported ${nTasks} rows into ${nGroups} plan${nGroups > 1 ? "s" : ""}` : "Nothing changed. The file matches what is saved.");
      state.imp = null;
    } catch (e) { toast(e && e.code === "quota_exceeded" ? "The plan store is full. Ask the Strategy Office to archive old weeks." : "Import stopped part-way. Check the plans and run it again."); }
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
        ${imp.needConfirm ? `<div class="banner warn" style="margin:0"><b>Replace will delete ${imp.impact ? imp.impact.rem : "the"} saved task(s) in these plan weeks.</b> This cannot be undone. <button class="btn danger" id="impConfirm" style="margin-left:6px">Yes, replace</button> <button class="btn" id="impNoConfirm">Cancel</button></div>` : ""}
        <div class="toolbar"><label class="small" for="impMode">If a task title already exists</label>
          <select id="impMode"><option value="merge" ${imp.mode === "merge" ? "selected" : ""}>Update it and add new ones</option><option value="replace" ${imp.mode === "replace" ? "selected" : ""}>Replace the unit's whole plan for that week</option></select>
          <label class="small"><input type="checkbox" id="impDepts" ${imp.newDepts ? "checked" : ""}> Add new departments to the unit</label></div>
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

  // ---------- who is using the app ----------
  function showWho(){
    const root = $("#whoRoot"), cur = identity.name();
    root.innerHTML = `<div class="overlay"><form class="modal" id="whoForm" style="max-width:420px" aria-labelledby="whoTitle">
      <div class="panel-head"><h2 id="whoTitle">Who is updating?</h2></div>
      <div class="small muted" style="padding:10px 16px 0">Your name is saved with every change you make and shown in the Activity tab.</div>
      <div class="field"><label for="whoName">Your name</label><input type="text" id="whoName" value="${esc(cur)}" maxlength="60" autocomplete="name"></div>
      ${identity.adminRequired() ? `<div class="field"><label for="whoCode">Admin code (optional, for the Units tab)</label><input type="password" id="whoCode" autocomplete="off"></div>` : ""}
      <div class="save-bar"><span class="small" id="whoErr" style="color:var(--bad)"></span><div class="toolbar">${cur ? '<button type="button" class="btn" id="whoCancel">Cancel</button>' : ""}<button class="btn primary" type="submit">Continue</button></div></div></form></div>`;
    const input = $("#whoName"); input.focus(); input.select();
    $("#whoForm").onsubmit = e => {
      e.preventDefault();
      const name = input.value.trim(), code = $("#whoCode") ? $("#whoCode").value : "";
      if (!name) { $("#whoErr").textContent = "Enter your name to continue."; return; }
      const r = identity.set(name, code);
      if (!r.ok) { $("#whoErr").textContent = "That admin code is not right."; return; }
      myId = identity.name(); isOwner = identity.isAdmin();
      if (state.tab === "units" && !isOwner) state.tab = "overview";
      root.innerHTML = ""; render(); toast(`Signed in as ${myId}`);
    };
    const c = $("#whoCancel"); if (c) c.onclick = () => { root.innerHTML = ""; };
  }

  // ---------- boot ----------
  render();
  (async () => {
    const cfgErr = configError();
    if (cfgErr) { bannerMsg = cfgErr; state.unitsLoaded = state.plansLoaded = true; render(); return; }
    const data = createData(); ({ db, user, downloads, identity } = data);
    myId = identity.name(); isOwner = identity.isAdmin();
    if (!myId) showWho();
    $("#whoBtn").onclick = showWho;
    window.addEventListener("offline", () => banner("You are offline. Changes will not save until the connection returns."));
    window.addEventListener("online", () => { bannerMsg = ""; subscribePlans(); render(); });
    db.collection("units").onSnapshot(snap => {
      state.units = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      state.unitsLoaded = true;
      if (state.editUnit && state.editUnit !== ALL && !state.units.some(u => u.id===state.editUnit)) { state.editUnit = null; state.draft = null; }
      if (state.tab==="update" && !hasDraft()) loadDraft();
      else if (state.allDrafts) sortedUnits().forEach(u => { if (!state.allDrafts[u.id]) state.allDrafts[u.id] = clone(state.plans[u.id] || emptyPlan(u.id)); });
      render();
    }, err => banner(`Could not load units (${err.code}). Reload the page to reconnect.`));
    subscribePlans();
  })();
})();
