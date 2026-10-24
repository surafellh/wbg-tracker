// Projects: status and progress follow-up for business and capital (physical) projects.
// Progress comes either from phases and activities (an activity can be linked to a weekly task) or from a cumulative physical % reported each month.
import { TYPES, STATUSES, RAGS, ACT_STATUSES, isCapital, latestUpdate, sortedUpdates, activityState, phasePct, projectProgress, progressSource, timeElapsed, daysUsed, daysToEnd, suggestRag, currentPeriod, monthChange, monthsSinceUpdate, needsUpdate, pendingDecisions, openRisks, latestTasks } from "./projectcalc.js";

const RISK_TYPES = ["Risk", "Issue"];
const RISK_CATS = ["Schedule", "Budget / cost", "Scope", "Quality", "Procurement / supply", "Contractor / vendor", "Land / permits", "Resources / people", "Technical", "Other"];
const SEVERITY = ["Low", "Medium", "High", "Critical"];
const RISK_STATUS = ["Open", "Mitigating", "Resolved", "Closed"];
const DEC_STATUS = ["Pending", "Decided", "Closed"];
const RAG_CLS = { Green: "g", Amber: "a", Red: "r" };
const NIYAT = "niyat-consultancy";
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const num = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const clone = (o) => JSON.parse(JSON.stringify(o));

export function createProjects(c) {
  const { state, esc, fmt } = c;
  const S = (state.pj = { list: [], loaded: false, view: "list", id: null, f: { q: "", type: "", unit: "", rag: "", status: "active" }, links: {}, m: null, busy: false });
  const A = () => c.auth() || {};
  // Who sees what (the database enforces the same rules, see supabase/upgrade-23-projects.sql):
  //  all projects: Group Strategy, CEO / DCEO, the lead executive assistant and the Group PMO function
  //  a unit's own projects (and those that list the unit as involved): its chief / GM / director and planning head; for Niyat Consultancy also its department heads
  //  edit: Group PMO and Group Strategy, and the planning head of the unit that owns the project (add and delete stay with Group PMO and Group Strategy)
  const inPmo = () => { const a = A(); return a.unit === "pmo" && ["leader", "planning", "manager"].includes(a.role); };
  const seesAll = () => { const a = A(); return ["super_admin", "executive"].includes(a.role) || (a.raw || a.role) === "lea" || inPmo(); };
  const canSee = () => { const a = A(); return seesAll() || (["leader", "planning"].includes(a.role) && !!a.unit) || (a.role === "manager" && a.unit === NIYAT); };
  const canEditP = (p) => { const a = A(); return a.role === "super_admin" || inPmo() || (a.role === "planning" && !!p && !!a.unit && p.unit === a.unit); };
  const canCreate = () => A().role === "super_admin" || inPmo();
  const unitChoices = () => c.sortedUnits();
  const money = (n) => (num(n) === null ? "–" : "ETB " + Math.round(Number(n)).toLocaleString("en-US"));
  const pctTxt = (n) => (n === null || n === undefined ? "–" : n + "%");
  const ok = (res, msg) => { if (res && res.error) { c.toast(res.error === "conflict" ? "Someone else changed this project. Reload and try again." : c.errText(res)); return false; } if (msg) c.toast(msg); return true; };
  const find = (id) => S.list.find((p) => p.id === id);
  const fd = (d) => { if (!d) return ""; const t = new Date(String(d).slice(0, 10) + "T00:00:00Z"); return Number.isNaN(t.getTime()) ? String(d) : t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); };
  const monthName = (per) => { if (!per) return ""; const [y, m] = per.split("-"); return new Date(Date.UTC(+y, +m - 1, 1)).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }); };

  // ---------------- data ----------------
  let sub = null;
  function subscribe() {
    if (!c.db() || sub || !canSee()) return;
    sub = c.db().collection("projects").orderBy("name").limit(1000).onSnapshot((snap) => { S.list = snap.docs.map((d) => ({ id: d.id, ...d.data() })); S.loaded = true; if (state.tab === "projects") c.render(); }, () => { S.list = []; S.loaded = true; });
  }
  // latest state of each weekly task of a unit (to link activities to the activity plan)
  function ensureLinks(unit) {
    if (!unit || S.links[unit] || !c.db()) return;
    S.links[unit] = { loading: true, map: {} };
    c.db().collection("plans").where("unit", "==", unit).get().then((snap) => { S.links[unit] = { loading: false, map: latestTasks(snap.docs.map((d) => d.data())) }; if (state.tab === "projects") { c.render(); if (S.m) drawModal(); } })
      .catch(() => { S.links[unit] = { loading: false, map: {}, denied: true }; });
  }
  const resolve = (link) => { const l = link && S.links[link.unit]; return l && l.map[link.ref] ? l.map[link.ref] : null; };
  const stateOf = (a) => activityState(a, resolve);
  const progressOf = (p) => projectProgress(p, resolve);
  const refreshCaches = (p) => { for (const ph of p.phases || []) for (const a of ph.activities || []) if (a.link && a.link.ref) { const t = resolve(a.link); if (t) a.cache = { pct: t.pct, status: t.status, week: t.week, title: t.title }; } };
  const cacheStale = (p) => (p.phases || []).some((ph) => (ph.activities || []).some((a) => { if (!(a.link && a.link.ref)) return false; const t = resolve(a.link); return t && (!a.cache || a.cache.pct !== t.pct || a.cache.status !== t.status); }));

  const toRow = (p) => ({ id: p.id, code: p.code || "", name: p.name, type: p.type, unit: p.unit, directorate: p.directorate || "", sponsor: p.sponsor || "", manager: p.manager || "", budget: num(p.budget), start: p.start || "", end: p.end || "", revisedEnd: p.revisedEnd || "", actualEnd: p.actualEnd || "", strategicLink: p.strategicLink || "", status: p.status, rag: p.rag, mode: p.mode, involved: p.involved || [], phases: p.phases || [], updates: p.updates || [], risks: p.risks || [], decisions: p.decisions || [], notes: p.notes || "", updatedAt: p.updatedAt });
  // change a copy of the project, save it, and let the live subscription bring the saved version back
  async function commit(p, mutate, msg) {
    if (S.busy) return false;
    const copy = clone(p); mutate(copy); refreshCaches(copy);
    S.busy = true;
    try { const res = await c.api().saveProject(A(), toRow(copy)); if (!ok(res, msg)) return false; const i = S.list.findIndex((x) => x.id === p.id); if (i >= 0) S.list[i] = { ...copy, updatedAt: res.updatedAt || copy.updatedAt }; else S.list.push({ ...copy, id: res.id, updatedAt: res.updatedAt }); return res; }
    catch (e) { c.toast(c.errText(e)); return false; } finally { S.busy = false; c.render(); }
  }

  // ---------------- small pieces ----------------
  const ragPill = (r) => (r ? `<span class="rag ${RAG_CLS[r] || ""}">${esc(r)}</span>` : '<span class="muted small">–</span>');
  const stCls = (s) => ({ "In progress": "s-prog", Completed: "s-done", Done: "s-done", "On hold": "s-none", Cancelled: "s-closed", "Not started": "s-not", Blocked: "s-bad" })[s] || "s-none";
  const dueTag = (p) => { const dl = daysToEnd(p, c.todayIso); if (dl === null) return ""; return dl < 0 ? ` <span class="tag warn">${-dl} day${dl === -1 ? "" : "s"} past contract end</span>` : dl <= 30 ? ` <span class="tag">${dl} day${dl === 1 ? "" : "s"} left</span>` : ` <span class="small muted">${dl} days left</span>`; };
  const bar = (pct, cls) => `<div class="pc"><div class="bar"><i class="${cls || ""}" style="width:${Math.min(100, pct || 0)}%"></i></div><span class="num small">${pctTxt(pct)}</span></div>`;
  const field = (id, label, inner, wide) => `<div class="field${wide ? " wide" : ""}"><label for="${id}">${label}</label>${inner}</div>`;
  const opt = (list, cur, blank) => (blank ? `<option value="">${blank}</option>` : "") + list.map((x) => `<option ${x === cur ? "selected" : ""}>${esc(x)}</option>`).join("");
  const v = (id) => { const e = document.getElementById(id); return e ? e.value : ""; };

  // progress in the list: a number that can be typed over, when it is set by hand; worked out from activities otherwise
  const calcFromPhases = (p) => p.mode !== "manual" && (p.phases || []).some((ph) => (ph.activities || []).length);
  function progressCell(p, pr) {
    if (!canEditP(p) || p.status === "Completed" || calcFromPhases(p)) return `<div title="${p.status === "Completed" ? "Completed" : calcFromPhases(p) ? "Worked out from the activities. Open the project to change them." : ""}">${bar(pr)}</div>`;
    return `<div class="pc"><div class="bar"><i style="width:${Math.min(100, pr || 0)}%"></i></div><input type="number" class="pj-pct" min="0" max="100" step="1" value="${pr ?? ""}" placeholder="–" data-pjpct="${esc(p.id)}" aria-label="Progress % of ${esc(p.name)}" title="Type the progress to date (cumulative %) and press Enter"><span class="small muted">%</span></div>`;
  }
  async function setProgress(el) {
    const p = find(el.dataset.pjpct); if (!p || !canEditP(p)) return;
    const raw = el.value.trim(), val = raw === "" ? null : Number(raw);
    if (val !== null && (Number.isNaN(val) || val < 0 || val > 100)) { c.toast("Progress must be between 0 and 100"); c.render(); return; }
    const per = currentPeriod(c.todayIso), lu = latestUpdate(p);
    if (val === (progressOf(p) ?? null)) return;
    await commit(p, (q) => {
      const have = (q.updates || []).find((u) => u.period === per);
      const row = have ? have : { id: uid(), period: per, rag: q.rag, financial: lu ? num(lu.financial) : null, accomplishments: "", concern: "", nextPlan: "", decisionNeeded: "" };
      row.physical = val; row.timePct = timeElapsed(q, c.todayIso) ?? row.timePct ?? null; row.by = A().name || ""; row.at = new Date().toISOString();
      if (!have) { q.updates = q.updates || []; q.updates.push(row); }
    }, "Progress saved");
  }

  // ---------------- portfolio ----------------
  function filtered() {
    const f = S.f, q = f.q.trim().toLowerCase();
    const rank = { Red: 0, Amber: 1, Green: 2 };
    return S.list.filter((p) => (!f.type || p.type === f.type) && (!f.unit || p.unit === f.unit) && (!f.rag || p.rag === f.rag)
      && (f.status === "all" || (f.status === "active" ? ["Not started", "In progress", "On hold"].includes(p.status) : p.status === f.status))
      && (!q || `${p.name} ${p.code} ${p.manager} ${p.sponsor} ${p.directorate}`.toLowerCase().includes(q)))
      .sort((a, b) => (rank[a.rag] ?? 3) - (rank[b.rag] ?? 3) || String(a.name).localeCompare(String(b.name)));
  }
  function renderList() {
    const f = S.f, all = S.list, act = all.filter((p) => ["Not started", "In progress", "On hold"].includes(p.status)), list = filtered();
    const cnt = (r) => act.filter((p) => p.rag === r && p.status !== "On hold").length;
    const due = act.filter((p) => needsUpdate(p, c.todayIso)).length, dec = all.reduce((n, p) => n + pendingDecisions(p).length, 0);
    const card = (k, val, cls) => `<div class="stat ${cls || ""}"><div class="v">${val}</div><div class="k">${k}</div></div>`;
    const unitsIn = [...new Set(all.map((p) => p.unit))].map((id) => ({ id, name: c.unitName(id) })).sort((a, b) => a.name.localeCompare(b.name));
    const rows = list.map((p) => {
      const pr = progressOf(p), du = daysUsed(p, c.todayIso), lu = latestUpdate(p), late = needsUpdate(p, c.todayIso), dc = pendingDecisions(p).length;
      return `<tr class="clickable" data-pj="open" data-id="${esc(p.id)}" tabindex="0"><td><b>${esc(p.name)}</b><div class="small muted">${[p.code, p.directorate].filter(Boolean).map(esc).join(" · ")}</div></td>
        <td class="small">${esc(p.type)}</td><td class="small">${esc(c.unitName(p.unit))}</td><td><span class="pill ${stCls(p.status)}">${esc(p.status)}</span></td><td>${ragPill(p.status === "Completed" ? "Green" : p.rag)}</td>
        <td style="min-width:150px">${progressCell(p, pr)}</td><td class="small">${p.start ? esc(fd(p.start)) : '<span class="muted">–</span>'}</td><td class="small">${p.end ? esc(fd(p.end)) : '<span class="muted">–</span>'}${p.revisedEnd ? `<div class="muted">revised ${esc(fd(p.revisedEnd))}</div>` : ""}${dueTag(p)}</td><td class="num small ${du && du.used > du.total && p.status !== "Completed" ? "late" : ""}">${du ? `${du.used.toLocaleString("en-US")} of ${du.total.toLocaleString("en-US")} days` : '<span class="muted">–</span>'}</td>
        <td class="small">${lu ? esc(monthName(lu.period)) : '<span class="muted">none</span>'}${late ? ' <span class="tag warn">update due</span>' : ""}${dc ? ` <span class="tag">${dc} decision${dc > 1 ? "s" : ""}</span>` : ""}</td></tr>`;
    }).join("");
    return `<div class="panel"><div class="panel-head"><div><h2>Projects</h2><div class="small muted">Status and progress of business and capital projects. Update monthly; physical projects move slowly.</div></div>
      <div class="toolbar"><button class="btn" data-pj="pdf">Download PDF</button><button class="btn" data-pj="xlsx">Download Excel</button>${canCreate() ? `<button class="btn primary" data-pj="new">+ Add project</button>` : ""}</div></div>
      <div class="stats" style="padding:12px 16px;margin:0">${card("active projects", act.length)}${card("Green", cnt("Green"), "ok")}${card("Amber", cnt("Amber"), "warn")}${card("Red", cnt("Red"), "bad")}${card("monthly updates due", due)}${card("decisions pending", dec)}</div>
      <div class="toolbar" style="padding:0 16px 12px;border-bottom:1px solid var(--line)">
        <input type="search" data-pjf="q" placeholder="Search project, code, manager" value="${esc(f.q)}" aria-label="Search projects">
        <select data-pjf="type" aria-label="Type"><option value="">All types</option>${TYPES.map((t) => `<option ${f.type === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
        <select data-pjf="unit" aria-label="Owner unit"><option value="">All units</option>${unitsIn.map((u) => `<option value="${esc(u.id)}" ${f.unit === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>
        <select data-pjf="rag" aria-label="Status colour"><option value="">Any colour</option>${RAGS.map((r) => `<option ${f.rag === r ? "selected" : ""}>${r}</option>`).join("")}</select>
        <select data-pjf="status" aria-label="Status"><option value="active" ${f.status === "active" ? "selected" : ""}>Active</option><option value="all" ${f.status === "all" ? "selected" : ""}>All</option>${STATUSES.map((s) => `<option ${f.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
        <span class="small muted">${list.length} project${list.length === 1 ? "" : "s"}</span></div>
      ${list.length ? `<div class="scroll"><table class="pj-table"><thead><tr><th>Project</th><th>Type</th><th>Owner</th><th>Status</th><th>Colour</th><th>Progress %</th><th>Contract start</th><th>Contract end</th><th title="Days passed since the contract start, out of the contract length. Open a project to see the percentage.">Time used</th><th>Last update</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<div class="empty"><b>${all.length ? "No projects match" : S.loaded ? "No projects yet" : "Loading projects…"}</b>${all.length ? "Change the filters above." : canCreate() ? "Use “Add project” to start following one." : "Projects of your unit appear here once Group PMO adds them."}</div>`}</div>`;
  }

  // ---------------- one project ----------------
  function renderDetail(p) {
    const ed = canEditP(p), pr = progressOf(p), te = timeElapsed(p, c.todayIso), du = daysUsed(p, c.todayIso), sug = suggestRag(pr, te, p.status), lu = latestUpdate(p), manual = p.mode === "manual";
    ensureLinks(p.unit); (p.involved || []).forEach(ensureLinks);
    const late = needsUpdate(p, c.todayIso);
    const sel = (key, list, cur) => ed ? `<select data-pjset="${key}" aria-label="${key}">${opt(list, cur)}</select>` : `<b>${esc(cur)}</b>`;
    const kv = (k, val) => `<div class="pj-kv"><span class="small muted">${k}</span><div>${val || '<span class="muted">–</span>'}</div></div>`;
    const head = `<div class="panel"><div class="panel-head"><div><button class="btn small ghost" data-pj="back">‹ All projects</button>
        <h2 style="margin-top:6px">${esc(p.name)}</h2><div class="small muted">${[p.code, p.type, c.unitName(p.unit), p.directorate].filter(Boolean).map(esc).join(" · ")}</div></div>
      <div class="toolbar"><button class="btn" data-pj="pdf-one" data-id="${esc(p.id)}">Download PDF</button>${ed ? `<button class="btn" data-pj="edit">Edit details</button>` : ""}</div></div>
      ${late && ed ? `<div class="banner warn" style="margin:0 16px 12px">${lu ? `Last monthly update was ${esc(monthName(lu.period))}.` : "No monthly update yet."} <button class="btn small" data-pj="upd-new">Report this month</button></div>` : ""}
      <div class="pj-status">
        <div class="pj-big"><div class="small muted">Overall progress</div>${bar(pr, "")}<div class="small muted">${esc(progressSource(p))}</div></div>
        <div class="pj-grid">
          ${kv("Status", sel("status", STATUSES, p.status))}${kv("Colour", ed ? `<select data-pjset="rag" aria-label="Colour">${opt(RAGS, p.rag)}</select> ${sug && sug !== p.rag ? `<span class="small muted">suggested: ${ragPill(sug)}</span>` : ""}` : ragPill(p.rag))}
          ${kv("Contract period", p.start || p.end ? `${p.start ? esc(fd(p.start)) : "?"} – ${p.end ? esc(fd(p.end)) : "?"}` : "")}${kv("Time used", (du ? `${du.used.toLocaleString("en-US")} of ${du.total.toLocaleString("en-US")} days${te !== null ? " · " + te + "%" : ""}` : pctTxt(te)) + dueTag(p))}${kv("Revised end", p.revisedEnd ? esc(fd(p.revisedEnd)) : "")}${kv("Actual end", p.actualEnd ? esc(fd(p.actualEnd)) : "")}${kv("Budget / contract value", money(p.budget))}
          ${kv("Sponsor", esc(p.sponsor))}${kv("Project manager", esc(p.manager))}${kv("Strategic link", esc(p.strategicLink))}${kv("Also involved", (p.involved || []).map((u) => `<span class="tag">${esc(c.unitName(u))}</span>`).join(" "))}
          ${isCapital(p) && lu ? kv("Financial spent", pctTxt(num(lu.financial))) : ""}
        </div>
        ${ed ? `<div class="small muted" style="margin-top:8px">Progress is taken from: <select data-pjset="mode" aria-label="Where progress comes from"><option value="phases" ${manual ? "" : "selected"}>phases and activities</option><option value="manual" ${manual ? "selected" : ""}>the physical % reported each month</option></select></div>` : ""}
        ${p.notes ? `<div class="small" style="margin-top:8px">${esc(p.notes)}</div>` : ""}</div></div>`;
    return head + phasesPanel(p, ed, manual) + updatesPanel(p, ed) + risksPanel(p, ed) + decisionsPanel(p, ed);
  }
  function phasesPanel(p, ed, manual) {
    const phases = p.phases || [];
    const body = phases.map((ph) => {
      const pp = phasePct(ph, resolve), acts = ph.activities || [];
      const rows = acts.map((a) => { const st = stateOf(a); return `<tr><td>${a.link && a.link.ref ? `<span class="ref">${esc(a.link.ref)}</span> ` : ""}<b>${esc(a.title)}</b>${a.link && a.link.ref ? `<div class="small muted">Linked to the weekly plan${st.live ? "" : " (last saved value)"}</div>` : ""}</td>
        <td class="small">${esc(a.owner || "")}</td><td class="small">${a.end ? esc(fmt(a.end)) : ""}</td><td class="num small">${esc(String(a.weight || 1))}</td>
        <td><span class="pill ${stCls(st.status)}">${esc(st.status || "–")}</span></td><td style="min-width:110px">${bar(st.pct)}</td>
        <td>${ed ? `<button class="btn small" data-pj="act-edit" data-ph="${esc(ph.id)}" data-id="${esc(a.id)}">Edit</button>` : ""}</td></tr>`; }).join("");
      return `<div class="pj-phase"><div class="pj-phase-head"><div><b>${esc(ph.name)}</b> <span class="small muted">weight ${esc(String(ph.weight || 1))}${ph.start || ph.end ? " · " + [ph.start && fmt(ph.start), ph.end && fmt(ph.end)].filter(Boolean).join(" – ") : ""}</span></div>
        <div style="min-width:160px">${bar(pp === null ? null : Math.round(pp))}</div>${ed ? `<div class="toolbar"><button class="btn small" data-pj="ph-edit" data-id="${esc(ph.id)}">Edit phase</button><button class="btn small" data-pj="act-new" data-ph="${esc(ph.id)}">+ Activity</button></div>` : ""}</div>
        ${acts.length ? `<div class="scroll"><table><thead><tr><th>Activity</th><th>Owner</th><th>Due</th><th>Weight</th><th>Status</th><th>Done</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="small muted" style="padding:6px 0">No activities yet.${ph.pct != null ? ` Phase progress is set by hand to ${esc(String(ph.pct))}%.` : ""}</div>`}</div>`;
    }).join("");
    return `<div class="panel"><div class="panel-head"><div><h2>Phases and activities</h2><div class="small muted">${manual ? "This project reports a physical % each month, so phases are optional here." : "Each activity's completion moves its phase, and the phases move the project."} An activity can be linked to a task in the weekly plan; finishing that task then moves the project.</div></div>
      <div class="toolbar">${ed && cacheStale(p) ? `<button class="btn" data-pj="sync" title="Save the latest values of linked tasks">Sync linked tasks</button>` : ""}${ed ? `<button class="btn primary" data-pj="ph-new">+ Add phase</button>` : ""}</div></div>
      <div style="padding:0 16px 16px">${body || `<div class="empty"><b>No phases yet</b>${ed ? "Add a phase such as Design, Procurement or Construction, then list its activities." : ""}</div>`}</div></div>`;
  }
  function updatesPanel(p, ed) {
    const ups = sortedUpdates(p), cap = isCapital(p);
    const rows = ups.map((u) => { const ch = monthChange(p, u.period); return `<tr><td class="small"><b>${esc(monthName(u.period))}</b></td><td>${ragPill(u.rag)}</td><td class="num">${pctTxt(num(u.physical))}${ch !== null ? `<div class="small muted">${ch >= 0 ? "+" : ""}${ch} pts</div>` : ""}</td>
      ${cap ? `<td class="num">${pctTxt(num(u.financial))}</td>` : ""}<td class="num small">${pctTxt(num(u.timePct))}</td>
      <td class="sup-req">${esc(u.accomplishments || "")}${u.nextPlan ? `<div class="small muted">Next: ${esc(u.nextPlan)}</div>` : ""}</td><td class="sup-req">${esc(u.concern || "")}${u.decisionNeeded ? `<div class="small"><b>Decision:</b> ${esc(u.decisionNeeded)}</div>` : ""}</td>
      <td class="small muted">${esc(u.by || "")}</td><td>${ed ? `<button class="btn small" data-pj="upd-edit" data-id="${esc(u.id)}">Edit</button>` : ""}</td></tr>`; }).join("");
    return `<div class="panel"><div class="panel-head"><div><h2>Monthly status</h2><div class="small muted">One entry per month with the cumulative progress. The monthly change is worked out for you.</div></div>
      <div class="toolbar">${ed && ups.length ? `<button class="btn" data-pj="upd-same" title="Copy last month's figures forward">No change since last update</button>` : ""}${ed ? `<button class="btn primary" data-pj="upd-new">Report this month</button>` : ""}</div></div>
      ${ups.length ? `<div class="scroll"><table><thead><tr><th>Month</th><th>Colour</th><th>Physical (cum.)</th>${cap ? "<th>Financial (cum.)</th>" : ""}<th>Time used</th><th>Key accomplishments</th><th>Concern / decision</th><th>By</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<div class="empty"><b>No monthly status yet</b>${ed ? "Use “Report this month” to record where the project stands." : ""}</div>`}</div>`;
  }
  function risksPanel(p, ed) {
    const rows = (p.risks || []).map((r) => `<tr><td><span class="pill ${r.type === "Issue" ? "s-bad" : "s-none"}">${esc(r.type || "Risk")}</span></td><td class="sup-req"><b>${esc(r.title)}</b>${r.impact ? `<div class="small muted">${esc(r.impact)}</div>` : ""}</td><td class="small">${esc(r.category || "")}</td>
      <td class="small">${esc(r.severity || "")}</td><td class="sup-req">${esc(r.mitigation || "")}</td><td class="small">${esc(r.owner || "")}${r.due ? `<div class="muted">${esc(fmt(r.due))}</div>` : ""}</td><td><span class="pill ${["Resolved", "Closed"].includes(r.status) ? "s-done" : "s-prog"}">${esc(r.status || "Open")}</span></td>
      <td>${ed ? `<button class="btn small" data-pj="risk-edit" data-id="${esc(r.id)}">Edit</button>` : ""}</td></tr>`).join("");
    return `<div class="panel"><div class="panel-head"><div><h2>Risks and issues</h2><div class="small muted">${openRisks(p).length} open</div></div><div class="toolbar">${ed ? `<button class="btn primary" data-pj="risk-new">+ Add</button>` : ""}</div></div>
      ${rows ? `<div class="scroll"><table><thead><tr><th>Type</th><th>Description</th><th>Category</th><th>Severity</th><th>Mitigation</th><th>Owner / due</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><b>None recorded</b></div>`}</div>`;
  }
  function decisionsPanel(p, ed) {
    const rows = (p.decisions || []).map((d) => `<tr><td class="sup-req"><b>${esc(d.title)}</b>${d.background ? `<div class="small muted">${esc(d.background)}</div>` : ""}</td><td class="sup-req">${esc(d.recommended || "")}</td><td class="small">${d.needBy ? esc(fmt(d.needBy)) : ""}</td>
      <td><span class="pill ${d.status === "Pending" ? "s-prog" : "s-done"}">${esc(d.status || "Pending")}</span></td><td class="sup-req">${esc(d.response || "")}</td><td>${ed ? `<button class="btn small" data-pj="dec-edit" data-id="${esc(d.id)}">Edit</button>` : ""}</td></tr>`).join("");
    return `<div class="panel"><div class="panel-head"><div><h2>Decisions needed</h2><div class="small muted">${pendingDecisions(p).length} pending</div></div><div class="toolbar">${ed ? `<button class="btn primary" data-pj="dec-new">+ Add</button>` : ""}</div></div>
      ${rows ? `<div class="scroll"><table><thead><tr><th>Decision</th><th>Recommended option</th><th>Needed by</th><th>Status</th><th>Management response</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><b>None recorded</b></div>`}</div>`;
  }
  function renderProjects() {
    if (!canSee()) return `<div class="panel"><div class="empty"><b>Projects</b>Projects are shown to Group PMO, Group Strategy, the CEO, the DCEO and the lead executive assistant, and to the chief, GM, director and planning head of the unit that owns them.</div></div>`;
    subscribe();
    const p = S.view === "detail" ? find(S.id) : null;
    if (S.view === "detail" && !p) { S.view = "list"; }
    return p ? renderDetail(p) : renderList();
  }

  // ---------------- forms ----------------
  function drawModal() {
    let root = document.getElementById("pjModalRoot");
    if (!root) { root = document.createElement("div"); root.id = "pjModalRoot"; document.body.append(root); root.addEventListener("click", (e) => { const el = e.target.closest("[data-pj]"); if (el) onAction(el); else if (e.target.classList && e.target.classList.contains("overlay")) closeModal(); }); root.addEventListener("input", onModalInput); }
    const m = S.m; if (!m) { root.innerHTML = ""; return; }
    const body = m.type === "project" ? projectForm(m) : m.type === "phase" ? phaseForm(m) : m.type === "act" ? actForm(m) : m.type === "upd" ? updForm(m) : m.type === "risk" ? riskForm(m) : decForm(m);
    root.innerHTML = `<div class="overlay"><div class="modal wide xmodal" role="dialog" aria-modal="true">${body}</div></div>`;
    const first = root.querySelector("input[type=text], textarea, select"); if (first && m.isNew && !m.focused) { m.focused = true; first.focus(); }
  }
  const closeModal = () => { S.m = null; drawModal(); };
  const footer = (m, saveKey, delKey) => `<div class="save-bar"><div class="toolbar">${delKey && !m.isNew ? `<button class="btn danger" data-pj="${delKey}">${m.confirmDel ? "Click again to delete" : "Delete"}</button>` : ""}</div><div class="toolbar"><button class="btn" data-pj="close">Cancel</button><button class="btn primary" data-pj="${saveKey}">Save</button></div></div>`;

  function projectForm(m) {
    const r = m.row, units = unitChoices(), others = c.sortedUnits().filter((u) => u.id !== r.unit);
    return `<div class="panel-head"><h2>${m.isNew ? "Add a project" : "Project details"}</h2></div><div class="xgrid">
      ${field("pf-name", "Project name", `<input type="text" id="pf-name" value="${esc(r.name)}">`, true)}
      ${field("pf-code", "Code (optional)", `<input type="text" id="pf-code" value="${esc(r.code)}">`)}
      ${field("pf-type", "Type", `<select id="pf-type">${opt(TYPES, r.type)}</select>`)}
      ${field("pf-unit", "Owner unit", `<select id="pf-unit" ${m.isNew ? "" : units.length < 2 ? "disabled" : ""}>${units.map((u) => `<option value="${esc(u.id)}" ${u.id === r.unit ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>`)}
      ${field("pf-dir", "Directorate / group (optional)", `<input type="text" id="pf-dir" value="${esc(r.directorate)}">`)}
      ${field("pf-spon", "Sponsor", `<input type="text" id="pf-spon" value="${esc(r.sponsor)}">`)}
      ${field("pf-mgr", "Project manager", `<input type="text" id="pf-mgr" value="${esc(r.manager)}">`)}
      ${field("pf-bud", "Approved budget / contract amount (ETB)", `<input type="number" id="pf-bud" min="0" step="any" value="${r.budget ?? ""}">`)}
      ${field("pf-start", "Contract start date", `<input type="date" id="pf-start" value="${esc(r.start)}">`)}
      ${field("pf-end", "Contract end date", `<input type="date" id="pf-end" value="${esc(r.end)}">`)}
      ${field("pf-rev", "Revised end date (new plan, if the contract end moved)", `<input type="date" id="pf-rev" value="${esc(r.revisedEnd || "")}">`)}
      ${field("pf-act", "Actual end date (when finished)", `<input type="date" id="pf-act" value="${esc(r.actualEnd || "")}">`)}
      ${field("pf-link", "Strategic link (optional)", `<input type="text" id="pf-link" value="${esc(r.strategicLink)}">`, true)}
      ${field("pf-mode", "Progress comes from", `<select id="pf-mode"><option value="phases" ${r.mode === "phases" ? "selected" : ""}>Phases and activities</option><option value="manual" ${r.mode === "manual" ? "selected" : ""}>Physical % reported each month</option></select>`)}
      ${field("pf-st", "Status", `<select id="pf-st">${opt(STATUSES, r.status)}</select>`)}
      ${field("pf-inv", "Other units involved (they can read it)", `<div class="chipset">${others.map((u) => `<label class="chk"><input type="checkbox" data-inv="${esc(u.id)}" ${(r.involved || []).includes(u.id) ? "checked" : ""}> ${esc(u.name)}</label>`).join("")}</div>`, true)}
      ${field("pf-notes", "Notes", `<textarea id="pf-notes" rows="2">${esc(r.notes)}</textarea>`, true)}</div>
      ${footer(m, "proj-save", canCreate() ? "proj-del" : "")}`;
  }
  function phaseForm(m) {
    const r = m.row; const has = (m.hasActs);
    return `<div class="panel-head"><h2>${m.isNew ? "Add a phase" : "Edit phase"}</h2></div><div class="xgrid">
      ${field("ph-name", "Phase name", `<input type="text" id="ph-name" value="${esc(r.name)}" placeholder="for example Design, Procurement, Civil works">`, true)}
      ${field("ph-w", "Weight (how much it counts)", `<input type="number" id="ph-w" min="1" step="any" value="${esc(String(r.weight || 1))}">`)}
      ${field("ph-pct", "Progress by hand (%, used only while it has no activities)", `<input type="number" id="ph-pct" min="0" max="100" value="${r.pct ?? ""}" ${has ? "disabled" : ""}>`)}
      ${field("ph-start", "Start", `<input type="date" id="ph-start" value="${esc(r.start || "")}">`)}${field("ph-end", "End", `<input type="date" id="ph-end" value="${esc(r.end || "")}">`)}</div>
      ${footer(m, "ph-save", "ph-del")}`;
  }
  function linkList(m) {
    const L = S.links[m.row.linkUnit], q = (m.lq || "").toLowerCase();
    if (!L || L.loading) return '<div class="small muted">Loading the weekly plan…</div>';
    if (L.denied) return '<div class="small muted">You cannot read this unit\'s weekly plan.</div>';
    const items = Object.values(L.map).filter((t) => !q || `${t.ref} ${t.title} ${t.dept} ${t.owner}`.toLowerCase().includes(q)).sort((a, b) => String(a.ref).localeCompare(String(b.ref))).slice(0, 40);
    if (!items.length) return '<div class="small muted">No matching tasks.</div>';
    return items.map((t) => `<button type="button" class="pj-pick${m.row.link && m.row.link.ref === t.ref && m.row.link.unit === m.row.linkUnit ? " on" : ""}" data-pj="pick" data-ref="${esc(t.ref)}"><span class="ref">${esc(t.ref)}</span> <b>${esc(t.title)}</b><span class="small muted"> · ${esc(t.status || "no status")} · ${t.pct}%${t.dept ? " · " + esc(t.dept) : ""}</span></button>`).join("");
  }
  function actForm(m) {
    const r = m.row, p = find(S.id), linked = r.link && r.link.ref, units = [p.unit, ...(p.involved || [])];
    ensureLinks(r.linkUnit);
    return `<div class="panel-head"><h2>${m.isNew ? "Add an activity" : "Edit activity"}</h2></div><div class="xgrid">
      ${field("ac-title", "Activity", `<input type="text" id="ac-title" value="${esc(r.title)}">`, true)}
      ${field("ac-owner", "Owner (name)", `<input type="text" id="ac-owner" value="${esc(r.owner || "")}">`)}${field("ac-w", "Weight", `<input type="number" id="ac-w" min="1" step="any" value="${esc(String(r.weight || 1))}">`)}
      ${field("ac-start", "Start", `<input type="date" id="ac-start" value="${esc(r.start || "")}">`)}${field("ac-end", "Due", `<input type="date" id="ac-end" value="${esc(r.end || "")}">`)}
      <div class="field wide"><label>Link to a task in the weekly plan (optional)</label>
        ${linked ? `<div class="pj-linked"><span class="ref">${esc(r.link.ref)}</span> <b>${esc(r.link.title || "")}</b> <span class="small muted">from ${esc(c.unitName(r.link.unit))}. Progress and status now follow this task.</span> <button type="button" class="btn small" data-pj="unlink">Remove link</button></div>` : '<div class="small muted">Not linked. Status and % below are set by hand.</div>'}
        <div class="toolbar" style="margin-top:6px">${units.length > 1 ? `<select id="ac-lu" data-lu aria-label="Whose plan">${units.map((u) => `<option value="${esc(u)}" ${u === r.linkUnit ? "selected" : ""}>${esc(c.unitName(u))}</option>`).join("")}</select>` : ""}<input type="search" id="ac-lq" placeholder="Search tasks by reference or title" value="${esc(m.lq || "")}" style="flex:1"></div>
        <div class="pj-picklist" id="ac-list">${linkList(m)}</div></div>
      ${linked ? "" : field("ac-st", "Status", `<select id="ac-st">${opt(ACT_STATUSES, r.status || "Not started")}</select>`)}${linked ? "" : field("ac-pct", "% complete", `<input type="number" id="ac-pct" min="0" max="100" value="${r.pct ?? ""}">`)}</div>
      ${footer(m, "act-save", "act-del")}`;
  }
  function updForm(m) {
    const r = m.row, p = find(S.id), cap = isCapital(p);
    return `<div class="panel-head"><div><h2>${m.isNew ? "Report the month" : "Edit monthly status"}</h2><div class="small muted">Progress figures are cumulative to date, not the change in the month.</div></div></div><div class="xgrid">
      ${field("up-per", "Month", `<input type="month" id="up-per" value="${esc(r.period)}" ${m.isNew ? "" : "disabled"}>`)}${field("up-rag", "Colour", `<select id="up-rag">${opt(RAGS, r.rag)}</select>`)}
      ${field("up-phy", "Physical progress to date (%)", `<input type="number" id="up-phy" min="0" max="100" step="any" value="${r.physical ?? ""}">`)}
      ${cap ? field("up-fin", "Financial progress to date (%)", `<input type="number" id="up-fin" min="0" max="200" step="any" value="${r.financial ?? ""}">`) : ""}
      ${field("up-time", "Time used (%)", `<input type="number" id="up-time" min="0" step="any" value="${r.timePct ?? ""}">`)}
      ${field("up-acc", "Key accomplishments", `<textarea id="up-acc" rows="3">${esc(r.accomplishments || "")}</textarea>`, true)}
      ${field("up-con", "Key concern or challenge", `<textarea id="up-con" rows="2">${esc(r.concern || "")}</textarea>`, true)}
      ${field("up-next", "Plan for next month", `<textarea id="up-next" rows="2">${esc(r.nextPlan || "")}</textarea>`, true)}
      ${field("up-dec", "Decision required from management (optional)", `<input type="text" id="up-dec" value="${esc(r.decisionNeeded || "")}">`, true)}</div>
      ${footer(m, "upd-save", "upd-del")}`;
  }
  function riskForm(m) {
    const r = m.row;
    return `<div class="panel-head"><h2>${m.isNew ? "Add a risk or issue" : "Edit risk or issue"}</h2></div><div class="xgrid">
      ${field("rk-type", "Type", `<select id="rk-type">${opt(RISK_TYPES, r.type || "Risk")}</select>`)}${field("rk-cat", "Category", `<select id="rk-cat">${opt(RISK_CATS, r.category, "Choose")}</select>`)}
      ${field("rk-title", "Description", `<textarea id="rk-title" rows="2">${esc(r.title || "")}</textarea>`, true)}${field("rk-imp", "Impact", `<textarea id="rk-imp" rows="2">${esc(r.impact || "")}</textarea>`, true)}
      ${field("rk-sev", "Severity", `<select id="rk-sev">${opt(SEVERITY, r.severity || "Medium")}</select>`)}${field("rk-st", "Status", `<select id="rk-st">${opt(RISK_STATUS, r.status || "Open")}</select>`)}
      ${field("rk-mit", "Mitigation / corrective action", `<textarea id="rk-mit" rows="2">${esc(r.mitigation || "")}</textarea>`, true)}
      ${field("rk-own", "Owner", `<input type="text" id="rk-own" value="${esc(r.owner || "")}">`)}${field("rk-due", "Due", `<input type="date" id="rk-due" value="${esc(r.due || "")}">`)}
      ${field("rk-sup", "Support needed from the Group", `<input type="text" id="rk-sup" value="${esc(r.support || "")}">`, true)}</div>
      ${footer(m, "risk-save", "risk-del")}`;
  }
  function decForm(m) {
    const r = m.row;
    return `<div class="panel-head"><h2>${m.isNew ? "Add a decision" : "Edit decision"}</h2></div><div class="xgrid">
      ${field("dc-title", "Decision needed", `<textarea id="dc-title" rows="2">${esc(r.title || "")}</textarea>`, true)}${field("dc-bg", "Background", `<textarea id="dc-bg" rows="2">${esc(r.background || "")}</textarea>`, true)}
      ${field("dc-rec", "Recommended option", `<textarea id="dc-rec" rows="2">${esc(r.recommended || "")}</textarea>`, true)}
      ${field("dc-by", "Needed by", `<input type="date" id="dc-by" value="${esc(r.needBy || "")}">`)}${field("dc-st", "Status", `<select id="dc-st">${opt(DEC_STATUS, r.status || "Pending")}</select>`)}
      ${field("dc-resp", "Management response", `<textarea id="dc-resp" rows="2">${esc(r.response || "")}</textarea>`, true)}</div>
      ${footer(m, "dec-save", "dec-del")}`;
  }

  // keep what was typed when the modal is drawn again (for the task picker)
  function syncAct() {
    const m = S.m; if (!m || m.type !== "act" || !document.getElementById("ac-title")) return;
    const r = m.row; r.title = v("ac-title"); r.owner = v("ac-owner"); r.weight = num(v("ac-w")) || 1; r.start = v("ac-start"); r.end = v("ac-end");
    if (document.getElementById("ac-st")) { r.status = v("ac-st"); r.pct = num(v("ac-pct")); }
  }
  function onModalInput(e) {
    const m = S.m; if (!m || m.type !== "act") return;
    if (e.target.id === "ac-lq") { m.lq = e.target.value; const l = document.getElementById("ac-list"); if (l) l.innerHTML = linkList(m); }
    else if (e.target.id === "ac-lu") { syncAct(); m.row.linkUnit = e.target.value; ensureLinks(m.row.linkUnit); drawModal(); }
  }

  // ---------------- actions ----------------
  const newProject = () => ({ name: "", code: "", type: "Business", unit: unitChoices()[0] ? unitChoices()[0].id : "", directorate: "", sponsor: "", manager: "", budget: null, start: "", end: "", strategicLink: "", mode: "phases", status: "In progress", rag: "Green", involved: [], notes: "" });
  async function onAction(el) {
    const x = el.dataset.pj, id = el.dataset.id, p = find(S.id), m = S.m;
    if (x === "open") { S.view = "detail"; S.id = id; c.render(); window.scrollTo(0, 0); }
    else if (x === "back") { S.view = "list"; S.id = null; c.render(); }
    else if (x === "new") { S.m = { type: "project", isNew: true, row: newProject() }; drawModal(); }
    else if (x === "edit") { S.m = { type: "project", isNew: false, row: clone(p) }; drawModal(); }
    else if (x === "close") closeModal();
    else if (x === "xlsx") exportXlsx();
    else if (x === "pdf") pdfList();
    else if (x === "pdf-one") pdfOne(p || find(id));
    else if (x === "proj-save") {
      const r = m.row, row = { ...r, name: v("pf-name").trim(), code: v("pf-code").trim(), type: v("pf-type"), unit: v("pf-unit") || r.unit, directorate: v("pf-dir").trim(), sponsor: v("pf-spon").trim(), manager: v("pf-mgr").trim(), budget: num(v("pf-bud")), start: v("pf-start"), end: v("pf-end"), revisedEnd: v("pf-rev"), actualEnd: v("pf-act"), strategicLink: v("pf-link").trim(), mode: v("pf-mode"), status: v("pf-st"), notes: v("pf-notes").trim(),
        involved: [...document.querySelectorAll("#pjModalRoot [data-inv]:checked")].map((e) => e.dataset.inv).filter((u) => u !== (v("pf-unit") || r.unit)) };
      if (!row.name) { c.toast("Give the project a name"); return; }
      if (row.start && row.end && row.end < row.start) { c.toast("The contract end is before the contract start"); return; }
      if (row.revisedEnd && row.start && row.revisedEnd < row.start) { c.toast("The revised end is before the contract start"); return; }
      if (m.isNew) { const res = await c.api().saveProject(A(), toRow({ id: undefined, phases: [], updates: [], risks: [], decisions: [], ...row })); if (ok(res, "Project added")) { closeModal(); S.view = "detail"; S.id = res.id; c.render(); window.scrollTo(0, 0); } }
      else if (await commit(p, (q) => Object.assign(q, row), "Project saved")) closeModal();
    }
    else if (x === "proj-del") { if (!m.confirmDel) { m.confirmDel = true; drawModal(); return; } const res = await c.api().deleteProject(A(), m.row.id); if (ok(res, "Project deleted")) { closeModal(); S.view = "list"; S.id = null; S.list = S.list.filter((q) => q.id !== m.row.id); c.render(); } }
    else if (x === "sync") { await commit(p, () => {}, "Linked tasks synced"); }
    // phases
    else if (x === "ph-new") { S.m = { type: "phase", isNew: true, row: { id: uid(), name: "", weight: 1, pct: null, start: "", end: "", activities: [] }, hasActs: false }; drawModal(); }
    else if (x === "ph-edit") { const ph = p.phases.find((q) => q.id === id); S.m = { type: "phase", isNew: false, row: clone(ph), hasActs: (ph.activities || []).length > 0 }; drawModal(); }
    else if (x === "ph-save") {
      const r = m.row; r.name = v("ph-name").trim(); r.weight = num(v("ph-w")) || 1; r.start = v("ph-start"); r.end = v("ph-end"); if (!m.hasActs) r.pct = num(v("ph-pct"));
      if (!r.name) { c.toast("Name the phase"); return; }
      if (await commit(p, (q) => { const i = q.phases.findIndex((z) => z.id === r.id); if (i >= 0) q.phases[i] = { ...q.phases[i], ...r, activities: q.phases[i].activities }; else q.phases.push(r); }, "Phase saved")) closeModal();
    }
    else if (x === "ph-del") { if (!m.confirmDel) { m.confirmDel = true; drawModal(); return; } if (await commit(p, (q) => { q.phases = q.phases.filter((z) => z.id !== m.row.id); }, "Phase deleted")) closeModal(); }
    // activities
    else if (x === "act-new") { S.m = { type: "act", isNew: true, ph: el.dataset.ph, lq: "", row: { id: uid(), title: "", owner: "", weight: 1, start: "", end: "", status: "Not started", pct: null, link: null, linkUnit: p.unit } }; ensureLinks(p.unit); drawModal(); }
    else if (x === "act-edit") { const a = p.phases.find((q) => q.id === el.dataset.ph).activities.find((q) => q.id === id); S.m = { type: "act", isNew: false, ph: el.dataset.ph, lq: "", row: { ...clone(a), linkUnit: a.link ? a.link.unit : p.unit } }; ensureLinks(S.m.row.linkUnit); drawModal(); }
    else if (x === "pick") { syncAct(); const t = (S.links[m.row.linkUnit] || { map: {} }).map[el.dataset.ref]; if (t) { m.row.link = { unit: m.row.linkUnit, ref: t.ref, title: t.title }; m.row.cache = { pct: t.pct, status: t.status, week: t.week, title: t.title }; if (!m.row.title) m.row.title = t.title; if (!m.row.end && t.due) m.row.end = t.due; if (!m.row.owner && t.owner) m.row.owner = t.owner; } drawModal(); }
    else if (x === "unlink") { syncAct(); m.row.link = null; delete m.row.cache; drawModal(); }
    else if (x === "act-save") {
      syncAct(); const r = m.row; if (!r.title.trim()) { c.toast("Name the activity"); return; }
      const out = { id: r.id, title: r.title.trim(), owner: r.owner, weight: r.weight || 1, start: r.start, end: r.end, status: r.status, pct: r.pct, link: r.link || null, cache: r.cache };
      if (out.link) { delete out.status; delete out.pct; } else delete out.cache;
      if (await commit(p, (q) => { const ph = q.phases.find((z) => z.id === m.ph); const i = ph.activities.findIndex((z) => z.id === out.id); if (i >= 0) ph.activities[i] = out; else ph.activities.push(out); }, "Activity saved")) closeModal();
    }
    else if (x === "act-del") { if (!m.confirmDel) { m.confirmDel = true; drawModal(); return; } if (await commit(p, (q) => { const ph = q.phases.find((z) => z.id === m.ph); ph.activities = ph.activities.filter((z) => z.id !== m.row.id); }, "Activity deleted")) closeModal(); }
    // monthly status
    else if (x === "upd-new" || x === "upd-same") {
      const lu = latestUpdate(p), pr = progressOf(p), te = timeElapsed(p, c.todayIso), per = currentPeriod(c.todayIso), have = (p.updates || []).find((u) => u.period === per);
      if (x === "upd-same") {
        if (!lu) return;
        const row = { ...clone(lu), id: have ? have.id : uid(), period: per, timePct: te ?? lu.timePct ?? null, accomplishments: "No change since the last update.", nextPlan: lu.nextPlan || "", by: A().name || "", at: new Date().toISOString() };
        if (await commit(p, (q) => { q.updates = (q.updates || []).filter((u) => u.period !== per); q.updates.push(row); q.rag = row.rag || q.rag; }, "Status recorded")) {}
        return;
      }
      S.m = have ? { type: "upd", isNew: false, row: clone(have) } : { type: "upd", isNew: true, row: { id: uid(), period: per, rag: p.rag, physical: pr, financial: lu ? num(lu.financial) : null, timePct: te, accomplishments: "", concern: "", nextPlan: "", decisionNeeded: "" } }; drawModal();
    }
    else if (x === "upd-edit") { S.m = { type: "upd", isNew: false, row: clone((p.updates || []).find((u) => u.id === id)) }; drawModal(); }
    else if (x === "upd-save") {
      const r = m.row; r.period = v("up-per") || r.period; r.rag = v("up-rag"); r.physical = num(v("up-phy")); if (document.getElementById("up-fin")) r.financial = num(v("up-fin")); r.timePct = num(v("up-time"));
      r.accomplishments = v("up-acc").trim(); r.concern = v("up-con").trim(); r.nextPlan = v("up-next").trim(); r.decisionNeeded = v("up-dec").trim(); r.by = A().name || ""; r.at = new Date().toISOString();
      if (!r.period) { c.toast("Choose the month"); return; }
      if (r.physical !== null && (r.physical < 0 || r.physical > 100)) { c.toast("Physical progress must be between 0 and 100"); return; }
      const newest = !(p.updates || []).some((u) => u.period > r.period);
      if (await commit(p, (q) => { q.updates = (q.updates || []).filter((u) => u.id !== r.id && u.period !== r.period); q.updates.push(r); if (newest) q.rag = r.rag || q.rag; }, "Status recorded")) closeModal();
    }
    else if (x === "upd-del") { if (!m.confirmDel) { m.confirmDel = true; drawModal(); return; } if (await commit(p, (q) => { q.updates = q.updates.filter((u) => u.id !== m.row.id); }, "Deleted")) closeModal(); }
    // risks and decisions
    else if (x === "risk-new") { S.m = { type: "risk", isNew: true, row: { id: uid(), type: "Risk", status: "Open", severity: "Medium" } }; drawModal(); }
    else if (x === "risk-edit") { S.m = { type: "risk", isNew: false, row: clone(p.risks.find((q) => q.id === id)) }; drawModal(); }
    else if (x === "risk-save") {
      const r = { ...m.row, type: v("rk-type"), category: v("rk-cat"), title: v("rk-title").trim(), impact: v("rk-imp").trim(), severity: v("rk-sev"), status: v("rk-st"), mitigation: v("rk-mit").trim(), owner: v("rk-own").trim(), due: v("rk-due"), support: v("rk-sup").trim() };
      if (!r.title) { c.toast("Describe the risk or issue"); return; }
      if (await commit(p, (q) => { const i = q.risks.findIndex((z) => z.id === r.id); if (i >= 0) q.risks[i] = r; else q.risks.push(r); }, "Saved")) closeModal();
    }
    else if (x === "risk-del") { if (!m.confirmDel) { m.confirmDel = true; drawModal(); return; } if (await commit(p, (q) => { q.risks = q.risks.filter((z) => z.id !== m.row.id); }, "Deleted")) closeModal(); }
    else if (x === "dec-new") { S.m = { type: "dec", isNew: true, row: { id: uid(), status: "Pending" } }; drawModal(); }
    else if (x === "dec-edit") { S.m = { type: "dec", isNew: false, row: clone(p.decisions.find((q) => q.id === id)) }; drawModal(); }
    else if (x === "dec-save") {
      const r = { ...m.row, title: v("dc-title").trim(), background: v("dc-bg").trim(), recommended: v("dc-rec").trim(), needBy: v("dc-by"), status: v("dc-st"), response: v("dc-resp").trim() };
      if (!r.title) { c.toast("Describe the decision needed"); return; }
      if (await commit(p, (q) => { const i = q.decisions.findIndex((z) => z.id === r.id); if (i >= 0) q.decisions[i] = r; else q.decisions.push(r); }, "Saved")) closeModal();
    }
    else if (x === "dec-del") { if (!m.confirmDel) { m.confirmDel = true; drawModal(); return; } if (await commit(p, (q) => { q.decisions = q.decisions.filter((z) => z.id !== m.row.id); }, "Deleted")) closeModal(); }
  }
  async function onSet(el) {
    const p = find(S.id); if (!p || !canEditP(p)) return;
    const k = el.dataset.pjset, val = el.value;
    await commit(p, (q) => { q[k] = val; }, k === "mode" ? "Saved" : "Saved");
  }
  function onFilter(el) { S.f[el.dataset.pjf] = el.value; c.render(); const e = document.querySelector('[data-pjf="q"]'); if (el.dataset.pjf === "q" && e) { e.focus(); e.setSelectionRange(e.value.length, e.value.length); } }

  const main = document.getElementById("main");
  main.addEventListener("click", (e) => { if (e.target.closest("[data-pjpct]")) return; const el = e.target.closest("[data-pj]"); if (el) onAction(el); });
  main.addEventListener("keydown", (e) => { if (e.target.dataset && e.target.dataset.pjpct && e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
  main.addEventListener("keydown", (e) => { if (e.target.dataset && e.target.dataset.pjpct) return; const el = e.target.closest && e.target.closest("tr[data-pj]"); if (el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onAction(el); } });
  main.addEventListener("change", (e) => { const t = e.target; if (t.dataset && t.dataset.pjpct) setProgress(t); else if (t.dataset && t.dataset.pjset) onSet(t); else if (t.dataset && t.dataset.pjf && t.dataset.pjf !== "q") onFilter(t); });
  main.addEventListener("input", (e) => { const t = e.target; if (t.dataset && t.dataset.pjf === "q") { clearTimeout(onFilter.t); onFilter.t = setTimeout(() => onFilter(t), 250); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.m) closeModal(); });

  // ---------------- Excel ----------------
  async function exportXlsx() {
    if (!c.libsReady("xlsx")) return;
    const list = filtered(), X = c.XLSX(), wb = X.utils.book_new();
    const sheet = (rows, widths, name) => X.utils.book_append_sheet(wb, c.sheetFromRows(rows, widths), name);
    sheet([["Project", "Code", "Type", "Owner unit", "Directorate", "Sponsor", "Manager", "Approved budget (ETB)", "Contract start", "Contract end", "Revised end", "Actual end", "Status", "Colour", "Progress %", "Time used %", "Last update", "Key accomplishments", "Key concern", "Decision required"],
      ...list.map((p) => { const lu = latestUpdate(p); return [p.name, p.code, p.type, c.unitName(p.unit), p.directorate, p.sponsor, p.manager, num(p.budget) ?? "", p.start, p.end, p.revisedEnd || "", p.actualEnd || "", p.status, p.rag, progressOf(p) ?? "", timeElapsed(p, c.todayIso) ?? "", lu ? lu.period : "", lu ? lu.accomplishments : "", lu ? lu.concern : "", lu ? lu.decisionNeeded : ""]; })], [40, 12, 18, 26, 22, 20, 20, 20, 13, 13, 13, 13, 13, 9, 11, 11, 11, 50, 40, 36], "Portfolio");
    sheet([["Project", "Month", "Colour", "Physical % (cum.)", "Financial % (cum.)", "Time used %", "Key accomplishments", "Key concern", "Plan for next month", "Decision required", "By"],
      ...list.flatMap((p) => sortedUpdates(p).map((u) => [p.name, u.period, u.rag, num(u.physical) ?? "", num(u.financial) ?? "", num(u.timePct) ?? "", u.accomplishments, u.concern, u.nextPlan, u.decisionNeeded, u.by]))], [40, 10, 9, 14, 14, 11, 50, 40, 40, 36, 18], "Monthly status");
    sheet([["Project", "Phase", "Activity", "Linked task", "Owner", "Due", "Weight", "Status", "% complete"],
      ...list.flatMap((p) => (p.phases || []).flatMap((ph) => (ph.activities || []).map((a) => { const st = stateOf(a); return [p.name, ph.name, a.title, a.link ? a.link.ref : "", a.owner, a.end, a.weight || 1, st.status, st.pct]; })))], [40, 24, 44, 14, 20, 12, 8, 13, 11], "Phases and activities");
    sheet([["Project", "Type", "Description", "Impact", "Category", "Severity", "Mitigation", "Owner", "Due", "Status", "Support needed"], ...list.flatMap((p) => (p.risks || []).map((r) => [p.name, r.type, r.title, r.impact, r.category, r.severity, r.mitigation, r.owner, r.due, r.status, r.support]))], [40, 8, 44, 36, 18, 10, 44, 18, 12, 11, 30], "Risks and issues");
    sheet([["Project", "Decision needed", "Background", "Recommended option", "Needed by", "Status", "Management response"], ...list.flatMap((p) => (p.decisions || []).map((d) => [p.name, d.title, d.background, d.recommended, d.needBy, d.status, d.response]))], [40, 44, 44, 44, 12, 11, 40], "Decisions");
    await c.writeXlsx(wb, `Projects ${c.todayIso}.xlsx`, "Excel saved");
  }

  // ---------------- PDF (simple and readable) ----------------
  const pdfSt = () => { const b = c.pdfStyle(); b.styles = { ...b.styles, fontSize: 9.5, cellPadding: 5 }; b.headStyles = { ...b.headStyles, fontSize: 9.5 }; return b; };
  const clip = (t, n) => { t = String(t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
  const daysTxt = (p) => { const du = daysUsed(p, c.todayIso); return du ? `${du.used.toLocaleString("en-US")} of ${du.total.toLocaleString("en-US")}` : "–"; };
  const RAGC = { Green: [22, 128, 60], Amber: [200, 130, 0], Red: [190, 30, 30] };
  function pdfFoot(doc, label) {
    const n = doc.getNumberOfPages(), H = doc.internal.pageSize.getHeight();
    for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(120, 120, 120); doc.text(`${label} · ${fd(c.todayIso)} · Page ${i} of ${n}`, 36, H - 18); }
  }
  async function pdfList() {
    if (!c.libsReady("pdf")) return;
    const list = filtered(), f = S.f;
    const doc = c.newPdf("Projects", `${list.length} project${list.length === 1 ? "" : "s"}  ·  ${f.status === "active" ? "Active only" : f.status === "all" ? "All statuses" : f.status}  ·  as of ${fd(c.todayIso)}`);
    const colour = (r) => ({ content: r || "–", styles: { textColor: RAGC[r] || [90, 90, 90], fontStyle: "bold" } });
    doc.autoTable({ startY: 92, margin: { left: 30, right: 30 }, head: [["Project", "Owner", "Status", "Colour", "Progress", "Start", "End", "Days used", "Latest report"]],
      body: list.length ? list.map((p) => { const lu = latestUpdate(p), pr = progressOf(p);
        return [{ content: p.name + (p.code ? "\n" + p.code : ""), styles: { fontStyle: "bold" } }, c.unitName(p.unit), p.status, colour(p.status === "Completed" ? "Green" : p.rag), pr === null ? "–" : pr + "%", p.start ? fd(p.start) : "–", (p.end ? fd(p.end) : "–") + (p.revisedEnd ? "\nrevised " + fd(p.revisedEnd) : ""), daysTxt(p), lu ? monthName(lu.period) + (lu.accomplishments ? ": " + clip(lu.accomplishments, 120) : "") : "No report yet"]; })
        : [[{ content: "No projects match the filters", colSpan: 9 }]],
      columnStyles: { 0: { cellWidth: 135 }, 1: { cellWidth: 95 }, 2: { cellWidth: 58 }, 3: { cellWidth: 48 }, 4: { cellWidth: 58 }, 5: { cellWidth: 72 }, 6: { cellWidth: 80 }, 7: { cellWidth: 66 }, 8: { cellWidth: "auto" } }, ...pdfSt() });
    pdfFoot(doc, "Projects");
    await c.save(`Projects ${c.todayIso}.pdf`, doc.output("arraybuffer"), "PDF saved. Open it to print.");
  }
  async function pdfOne(p) {
    if (!p || !c.libsReady("pdf")) return;
    const pr = progressOf(p), te = timeElapsed(p, c.todayIso), lu = latestUpdate(p), du = daysUsed(p, c.todayIso), dl = daysToEnd(p, c.todayIso);
    const doc = c.newPdf(p.name, [p.code, p.type, c.unitName(p.unit), p.directorate].filter(Boolean).join("  ·  ") + `  ·  as of ${fd(c.todayIso)}`);
    const H = doc.internal.pageSize.getHeight(); let y = 92;
    const section = (t) => { if (y > H - 110) { doc.addPage(); y = 50; } doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(92, 74, 16); doc.text(t, 36, y); y += 6; };
    const table = (head, body, cols, extra) => { doc.autoTable({ startY: y, margin: { left: 36, right: 36 }, head: head ? [head] : undefined, body, columnStyles: cols || {}, ...pdfSt(), ...(extra || {}) }); y = doc.lastAutoTable.finalY + 18; };
    section("At a glance");
    const kv = [["Status", p.status], ["Colour", p.status === "Completed" ? "Green" : p.rag], ["Progress", pr === null ? "Not reported yet" : pr + "%  (" + progressSource(p).toLowerCase() + ")"],
      ["Contract", `${p.start ? fd(p.start) : "?"} to ${p.end ? fd(p.end) : "?"}${p.revisedEnd ? "  ·  revised end " + fd(p.revisedEnd) : ""}${p.actualEnd ? "  ·  finished " + fd(p.actualEnd) : ""}`],
      ["Time used", du ? `${du.used.toLocaleString("en-US")} of ${du.total.toLocaleString("en-US")} days${te !== null ? " (" + te + "%)" : ""}${dl !== null ? (dl < 0 ? "  ·  " + -dl + " days past the contract end" : "  ·  " + dl + " days left") : ""}` : (te !== null ? te + "%" : "–")],
      ["Budget / contract value", money(p.budget)], ["Sponsor", p.sponsor || "–"], ["Project manager", p.manager || "–"], ["Strategic link", p.strategicLink || "–"],
      ["Also involved", (p.involved || []).map((u) => c.unitName(u)).join(", ") || "–"]];
    if (isCapital(p) && lu && num(lu.financial) !== null) kv.splice(3, 0, ["Financial spent", num(lu.financial) + "%"]);
    table(null, kv, { 0: { cellWidth: 130, fontStyle: "bold" } }, { theme: "plain" });
    if (p.notes) { doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(60, 60, 60); const t = doc.splitTextToSize(p.notes, 760); doc.text(t, 36, y - 6); y += t.length * 11 + 6; }
    const phases = p.phases || [];
    if (phases.length) { section("Phases"); table(["Phase", "Done", "Activities"], phases.map((ph) => { const pp = phasePct(ph, resolve), acts = ph.activities || []; return [ph.name, pp === null ? "–" : Math.round(pp) + "%", acts.length ? acts.map((a) => `${a.title} (${stateOf(a).pct}%)`).join("; ") : "–"]; }), { 0: { cellWidth: 170, fontStyle: "bold" }, 1: { cellWidth: 50 } }); }
    section("Latest monthly report");
    if (lu) { table(null, [["Month", monthName(lu.period) + (lu.by ? "  ·  reported by " + lu.by : "")], ["Accomplishments", lu.accomplishments || "–"], ["Concern", lu.concern || "–"], ["Plan for next month", lu.nextPlan || "–"], ["Decision required", lu.decisionNeeded || "–"]], { 0: { cellWidth: 130, fontStyle: "bold" } }, { theme: "plain" }); }
    else { doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(90, 90, 90); doc.text("No monthly report yet.", 36, y + 8); y += 26; }
    const rk = openRisks(p);
    if (rk.length) { section(`Open risks and issues (${rk.length})`); table(["Type", "Description", "Severity", "Mitigation", "Owner"], rk.map((r) => [r.type || "Risk", r.title, r.severity || "", r.mitigation || "", r.owner || ""]), { 0: { cellWidth: 50 }, 2: { cellWidth: 55 }, 4: { cellWidth: 80 } }); }
    const dc = pendingDecisions(p);
    if (dc.length) { section(`Decisions needed (${dc.length})`); table(["Decision", "Recommended option", "Needed by"], dc.map((d) => [d.title, d.recommended || "", d.needBy ? fd(d.needBy) : ""]), { 2: { cellWidth: 80 } }); }
    pdfFoot(doc, p.name);
    await c.save(`Project - ${String(p.name).replace(/[\\/:*?"<>|]/g, "").slice(0, 50)} ${c.todayIso}.pdf`, doc.output("arraybuffer"), "PDF saved. Open it to print.");
  }

  const count = () => (canSee() ? S.list.filter((p) => canEditP(p) && needsUpdate(p, c.todayIso)).length : 0);
  return { renderProjects, subscribe, count, canSee };
}
