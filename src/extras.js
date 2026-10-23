// Version 3 additions: Business support log, Feedback (CEO / DCEO / Group Strategy) and Corrective actions.
// Everything the screens need from the main app is passed in as `c`.

export const SUP_STATUS = ["Open", "In progress", "On hold", "Responded", "Closed"];
const ACTIVE = ["Open", "In progress", "On hold"];
export const SUP_CATS = ["OKR / Performance", "Recruitment / Talent", "Learning & Development", "Policy / Governance", "Facilities / Administration", "Insurance / Employee Benefits", "Finance / Capital", "General Management Support"];
const SUP_PRI = ["High", "Medium", "Normal"];
const FROM = ["CEO", "DCEO", "Group Strategy"];
const ACT_STATUS = ["Open", "In progress", "Done", "Closed"];
const supRank = Object.fromEntries(SUP_STATUS.map((s, i) => [s, i]));
const statusCls = (s) => ({ Open: "s-not", "In progress": "s-prog", "On hold": "s-none", Responded: "s-done", Closed: "s-done", Done: "s-done" })[s] || "s-none";
const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);

export function createExtras(c) {
  const { state, esc, fmt } = c;
  state.support = []; state.fbs = []; state.acts = []; state.xm = null;
  state.sup = { fn: "", req: "", status: "active", cat: "", q: "", from: "", to: "", show: 15, init: false };
  state.fbv = { view: "feedback", unit: "", from: "", ack: "", astatus: "active", asrc: "", aq: "", ashow: 15, init: false };
  state.sort.sup = { k: "requested", dir: -1 };

  const fnUnits = () => c.sortedUnits().filter((u) => u.type === "Corporate function");
  const supVal = (r, k) => ({
    ref: parseInt(String(r.ref || "").replace(/\D/g, ""), 10) || -1, fn: c.unitName(r.function).toLowerCase(), requester: (r.requester || "").toLowerCase(), category: (r.category || "").toLowerCase(),
    requested: r.requested || "", status: supRank[r.status] ?? 9, responded: r.responded || "", by: (r.respondedBy || "").toLowerCase(), days: tat(r) ?? -1, follow: r.followUp ? 1 : 0,
  })[k];
  function tat(r) {
    if (r.requested && r.responded && ["Responded", "Closed"].includes(r.status)) return dayDiff(r.requested, r.responded);
    return null;
  }
  const openDays = (r) => (ACTIVE.includes(r.status) && r.requested ? Math.max(0, dayDiff(r.requested, c.todayIso)) : null);
  const ok = (res, msg) => { if (res && res.error) { c.toast(c.errText(res)); return false; } if (msg) c.toast(msg); return true; };
  const A = () => c.auth();

  // ---------------- subscriptions ----------------
  let subs = [];
  function subscribe() {
    if (!c.db() || subs.length) return;
    const on = (col, key, order) => c.db().collection(col).orderBy(order, "desc").limit(1000).onSnapshot((snap) => { state[key] = snap.docs.map((d) => ({ id: d.id, ...d.data() })); c.render(); }, () => { state[key] = []; });
    subs = [on("support", "support", "createdAt"), on("feedback", "fbs", "createdAt"), on("actions", "acts", "createdAt")];
  }

  // ---------------- badge + banner ----------------
  const unacked = (u) => state.fbs.filter((f) => f.unit === u && !f.ackAt);
  const activeActs = (u) => state.acts.filter((a) => (!u || a.unit === u) && ["Open", "In progress"].includes(a.status));
  function badgeCount() {
    if (c.isAppr()) return state.acts.filter((a) => ["Open", "In progress"].includes(a.status) && a.due && a.due < c.todayIso).length;
    const u = c.myUnit(); return u ? unacked(u).length + activeActs(u).length : 0;
  }
  function banner(u) {
    if (!u || u === c.ALL) return "";
    const f = unacked(u).length, a = activeActs(u).length;
    if (!f && !a) return "";
    return `<div class="banner info" style="margin:0 0 12px"><b>${esc(c.unitName(u))}:</b> ${f ? `${f} new feedback message${f > 1 ? "s" : ""}` : ""}${f && a ? " and " : ""}${a ? `${a} open corrective action${a > 1 ? "s" : ""}` : ""}. <button class="btn small" data-x="go-fb" data-unit="${esc(u)}" style="margin-left:6px">Open</button></div>`;
  }

  // ---------------- Business support ----------------
  function supFiltered() {
    const f = state.sup, q = f.q.trim().toLowerCase();
    return state.support.filter((r) => (!f.fn || r.function === f.fn) && (!f.req || r.requester === f.req) && (!f.cat || r.category === f.cat)
      && (f.status === "all" || (f.status === "active" ? ACTIVE.includes(r.status) : f.status === "done" ? ["Responded", "Closed"].includes(r.status) : r.status === f.status))
      && (!f.from || (r.requested && r.requested >= f.from)) && (!f.to || (r.requested && r.requested <= f.to))
      && (!q || `${r.ref} ${r.requester} ${r.description} ${r.action} ${r.respondedBy} ${r.remarks} ${r.category}`.toLowerCase().includes(q)));
  }
  const isMember = () => { const a = c.auth(); return !!a && ["leader", "planning", "manager", "staff"].includes(a.role) && !!a.unit; };
  const canRespond = (fn) => c.isAppr() || c.canLead(fn);
  const canEditReq = (r) => canRespond(r.function) || (isMember() && !!r.requesterUnit && r.requesterUnit === c.myUnit() && r.status === "Open");
  function renderSupport() {
    const f = state.sup;
    if (!f.init) { f.init = true; const mu = c.myUnit(); if (mu && fnUnits().some((u) => u.id === mu)) f.fn = mu; }
    const fns = fnUnits();
    const pool = state.support.filter((r) => !f.fn || r.function === f.fn);
    const reqs = [...new Set(pool.map((r) => r.requester).filter(Boolean))].sort();
    const cnt = (s) => pool.filter((r) => r.status === s).length;
    const list = supFiltered(), order = c.sortOrder(list, "sup", supVal), shown = order.slice(0, f.show).map((i) => list[i]);
    const canAdd = c.isAppr() || isMember();
    const showFn = !f.fn;
    const sh = (k, l) => c.th("sup", k, l);
    const rows = shown.map((r) => {
      const t = tat(r), od = openDays(r), stale = od !== null && od > 14;
      return `<tr class="clickable" data-x="sup-open" data-id="${esc(r.id)}" tabindex="0">
        <td class="num small" style="white-space:nowrap"><b>${esc(r.ref || "")}</b></td>${showFn ? `<td class="small">${esc(c.unitName(r.function))}</td>` : ""}
        <td class="small"><b>${esc(r.requester)}</b></td>
        <td class="sup-req">${r.category ? `<span class="tag">${esc(r.category)}</span> ` : ""}${r.priority === "High" ? '<span class="hi-dot" title="High priority"></span>' : ""}${esc(r.description)}</td>
        <td class="num small">${esc(fmt(r.requested))}</td>
        <td><span class="pill ${statusCls(r.status)}">${esc(r.status)}</span></td>
        <td class="sup-act small">${esc(r.action)}${r.respondedBy ? `<div class="muted">by ${esc(r.respondedBy)}</div>` : ""}</td>
        <td class="num small">${t !== null ? `${t} d` : od !== null ? `<span class="${stale ? "late" : "muted"}" title="Open for ${od} days">open ${od} d</span>` : '<span class="muted">–</span>'}</td>
        <td class="small">${r.followUp ? "Yes" : '<span class="muted">No</span>'}</td></tr>`;
    }).join("");
    const chip = (s, label, n) => `<button class="btn small${f.status === s ? " on" : ""}" data-x="sup-st" data-v="${esc(s)}">${esc(label)}${n !== undefined ? ` · ${n}` : ""}</button>`;
    return `<div class="panel">
      <div class="panel-head"><div><h2>Business support requests</h2><div class="small muted">Requests that business units and functions make to a corporate function, and how each one was answered.</div></div>
        <div class="toolbar">${canAdd ? `<button class="btn primary" data-x="sup-new">+ Log a request</button>` : ""}${c.downloads() ? `<button class="btn" data-x="sup-xlsx">Excel</button><button class="btn" data-x="sup-pdf">PDF</button>` : ""}</div></div>
      <div class="toolbar" style="padding:10px 16px 0">${chip("active", "Active", pool.filter((r) => ACTIVE.includes(r.status)).length)}${chip("Open", "Open", cnt("Open"))}${chip("In progress", "In progress", cnt("In progress"))}${chip("On hold", "On hold", cnt("On hold"))}${chip("done", "Completed", pool.filter((r) => ["Responded", "Closed"].includes(r.status)).length)}${chip("all", "All", pool.length)}</div>
      <div class="toolbar" style="padding:10px 16px 12px;border-bottom:1px solid var(--line)">
        <select data-xf="fn" aria-label="Function"><option value="">All functions</option>${fns.map((u) => `<option value="${esc(u.id)}" ${f.fn === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>
        <select data-xf="req" aria-label="Requested by"><option value="">Requested by: anyone</option>${reqs.map((x) => `<option ${f.req === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>
        <select data-xf="cat" aria-label="Category"><option value="">All categories</option>${SUP_CATS.map((x) => `<option ${f.cat === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>
        <label class="small muted">From <input type="date" data-xf="from" value="${esc(f.from)}"></label><label class="small muted">to <input type="date" data-xf="to" value="${esc(f.to)}"></label>
        <input type="text" data-xf="q" placeholder="Search" value="${esc(f.q)}" aria-label="Search requests" id="supQ">
        <span class="small muted">${list.length} request${list.length === 1 ? "" : "s"}</span></div>
      ${list.length ? `<div class="scroll"><table class="sup-table"><thead><tr>${sh("ref", "Ref")}${showFn ? sh("fn", "Function") : ""}${sh("requester", "Requested by")}${sh("category", "Request")}${sh("requested", "Requested")}${sh("status", "Status")}<th>Response / action taken</th>${sh("days", "Turnaround")}${sh("follow", "Follow-up")}</tr></thead><tbody>${rows}</tbody></table></div>
        ${list.length > shown.length ? `<div class="toolbar" style="padding:12px 16px"><span class="small muted">Showing ${shown.length} of ${list.length}</span><button class="btn" data-x="sup-more">Show 15 more</button><button class="btn ghost" data-x="sup-all">Show all</button></div>` : ""}`
        : `<div class="empty"><b>${pool.length ? "No requests match" : "No support requests logged yet"}</b>${pool.length ? "Change the filters above. Completed requests are hidden unless you choose Completed or All." : "Log the first request with the button above."}</div>`}
    </div>`;
  }
  function supRows() {
    const list = supFiltered(), order = c.sortOrder(list, "sup", supVal);
    return order.map((i) => list[i]);
  }
  async function supXlsx() {
    if (!c.libsReady("xlsx")) return;
    const rows = [["Ref #", "Function", "Business Unit/Group Function", "Request Description", "Category", "Priority", "Date Requested", "Response Date", "Action Taken / Response", "Response Status", "Responded By (Name / Role)", "Evidence / Reference", "Turnaround (Days)", "Follow-up Needed?", "Remarks"],
      ...supRows().map((r) => [r.ref, c.unitName(r.function), r.requester, r.description, r.category, r.priority, r.requested, r.responded, r.action, r.status, r.respondedBy, r.evidence, tat(r) ?? "", r.followUp ? "Yes" : "No", r.remarks])];
    const ws = c.sheetFromRows(rows, [10, 26, 28, 44, 24, 10, 13, 13, 50, 13, 24, 18, 12, 11, 30]);
    const wb = c.XLSX().utils.book_new(); c.XLSX().utils.book_append_sheet(wb, ws, "Support requests");
    await c.writeXlsx(wb, `Business support requests ${c.todayIso}.xlsx`, "Excel saved");
  }
  async function supPdf() {
    if (!c.libsReady("pdf")) return;
    const list = supRows(), f = state.sup;
    const doc = c.newPdf("Business Support Requests", `${f.fn ? c.unitName(f.fn) : "All functions"}  ·  ${list.length} request${list.length === 1 ? "" : "s"}  ·  ${f.status === "active" ? "Active only" : f.status === "all" ? "All statuses" : f.status === "done" ? "Completed" : f.status}  ·  ${fmt(c.todayIso)}`);
    doc.autoTable({ startY: 92, margin: { left: 30, right: 30 }, head: [["Ref", "Requested by", "Request", "Requested", "Status", "Response / action taken", "Responded by", "Days", "Follow-up"]],
      body: list.length ? list.map((r) => [r.ref, r.requester, (r.category ? r.category + "\n" : "") + r.description, fmt(r.requested), r.status, r.action + (r.responded ? `\n(${fmt(r.responded)})` : ""), r.respondedBy, tat(r) ?? "", r.followUp ? "Yes" : "No"]) : [["", "No requests match", "", "", "", "", "", "", ""]],
      columnStyles: { 0: { cellWidth: 44 }, 1: { cellWidth: 90, fontStyle: "bold" }, 2: { cellWidth: 150 }, 3: { cellWidth: 52 }, 4: { cellWidth: 50 }, 5: { cellWidth: 200 }, 6: { cellWidth: 80 }, 7: { cellWidth: 30 }, 8: { cellWidth: 40 } }, ...c.pdfStyle() });
    c.pdfFooter(doc, "Business support requests");
    await c.save(`Business support requests ${c.todayIso}.pdf`, doc.output("arraybuffer"), "PDF saved. Open it to print.");
  }

  // ---------------- Feedback & corrective actions ----------------
  function renderFb() {
    const f = state.fbv;
    if (!f.init) { f.init = true; const mu = c.myUnit(); if (mu) f.unit = mu; }
    const tabBtn = (v, l, n) => `<button class="btn${f.view === v ? " on" : ""}" data-x="fb-view" data-v="${v}">${l}${n ? ` <span class="badge">${n}</span>` : ""}</button>`;
    const nf = c.isAppr() ? 0 : (c.myUnit() ? unacked(c.myUnit()).length : 0);
    const head = `<div class="panel-head"><div><h2>Feedback &amp; corrective actions</h2><div class="small muted">Feedback from the CEO, DCEO and Group Strategy, and the actions taken to correct a gap.</div></div>
      <div class="toolbar">${tabBtn("feedback", "Feedback", nf)}${tabBtn("actions", "Corrective actions", 0)}</div></div>`;
    const unitSel = (attr, val) => `<select data-xf="${attr}" aria-label="Unit"><option value="">All units</option>${c.sortedUnits().map((u) => `<option value="${esc(u.id)}" ${val === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>`;
    if (f.view === "feedback") {
      const list = state.fbs.filter((x) => (!f.unit || x.unit === f.unit) && (!f.from || x.from === f.from) && (!f.ack || (f.ack === "new" ? !x.ackAt : !!x.ackAt)));
      const cards = list.slice(0, f.ashow).map((x) => `<div class="fb-card${x.ackAt ? "" : " new"}">
        <div class="fb-top"><span class="pill ${x.from === "CEO" ? "s-bad" : x.from === "DCEO" ? "s-prog" : "s-done"}">${esc(x.from)}</span> <b>${esc(c.unitName(x.unit))}</b>${x.toLead ? ' <span class="pill s-prog" title="Only the head of the unit, Group Strategy, the CEO and the DCEO can read this letter">Letter to the head of the unit</span>' : ""}
          <span class="small muted">${x.week ? esc(c.weekLabel(x.week)) + " · " : ""}${esc(fmt((x.createdAt || "").slice(0, 10)))}${x.by ? " · " + esc(x.by) : ""}</span></div>
        ${x.taskRef ? `<div class="small"><span class="ref">${esc(x.taskRef)}</span></div>` : ""}<div class="fb-body">${esc(x.body)}</div>
        <div class="fb-foot small">${x.ackAt ? `<span class="muted">Acknowledged by ${esc(x.ackBy)} on ${esc(fmt(x.ackAt.slice(0, 10)))}</span>` : (c.canLead(x.unit) && !(x.toLead && c.myRole && c.myRole() === "planning") ? `<button class="btn small" data-x="fb-ack" data-id="${esc(x.id)}">Acknowledge</button> <button class="btn small ghost" data-x="act-from-fb" data-unit="${esc(x.unit)}" data-id="${esc(x.id)}">Log a corrective action</button>` : '<span class="muted">Not yet acknowledged</span>')}
          ${c.canFeedback() ? `<button class="btn small ghost" data-x="fb-edit" data-id="${esc(x.id)}">Edit</button>` : ""}</div></div>`).join("");
      return `<div class="panel">${head}
        <div class="toolbar" style="padding:10px 16px 12px;border-bottom:1px solid var(--line)">${unitSel("fbunit", f.unit)}
          <select data-xf="fbfrom" aria-label="From"><option value="">From: anyone</option>${FROM.map((x) => `<option ${f.from === x ? "selected" : ""}>${x}</option>`).join("")}</select>
          <select data-xf="fback" aria-label="Acknowledged"><option value="">All</option><option value="new" ${f.ack === "new" ? "selected" : ""}>Not acknowledged</option><option value="done" ${f.ack === "done" ? "selected" : ""}>Acknowledged</option></select>
          <span class="small muted">${list.length} message${list.length === 1 ? "" : "s"}</span>${c.canFeedback() ? `<button class="btn primary" data-x="fb-new" style="margin-left:auto">+ Give feedback</button>` : ""}</div>
        <div style="padding:12px 16px">${cards || `<div class="empty"><b>No feedback yet</b>${c.canFeedback() ? "Use “Give feedback” to record feedback from the CEO, DCEO or Group Strategy for a unit." : "Feedback given to your unit will appear here."}</div>`}
        ${list.length > f.ashow ? `<div class="toolbar"><button class="btn" data-x="fb-more">Show more</button></div>` : ""}</div></div>`;
    }
    const q = f.aq.trim().toLowerCase();
    const list = state.acts.filter((a) => (!f.unit || a.unit === f.unit) && (!f.asrc || a.source === f.asrc) && (f.astatus === "all" || (f.astatus === "active" ? ["Open", "In progress"].includes(a.status) : a.status === f.astatus))
      && (!q || `${a.issue} ${a.action} ${a.owner} ${a.notes} ${a.taskTitle}`.toLowerCase().includes(q)));
    const rows = list.slice(0, f.ashow).map((a) => { const late = a.due && a.due < c.todayIso && ["Open", "In progress"].includes(a.status);
      return `<tr class="clickable" data-x="act-open" data-id="${esc(a.id)}" tabindex="0"><td class="small"><b>${esc(c.unitName(a.unit))}</b></td><td><span class="pill ${a.source === "Self" ? "s-none" : a.source === "CEO" ? "s-bad" : a.source === "DCEO" ? "s-prog" : "s-done"}">${esc(a.source)}</span></td>
        <td class="sup-req">${esc(a.issue)}${a.taskTitle || a.taskRef ? `<div class="small muted">Task: ${a.taskRef ? `<span class="ref">${esc(a.taskRef)}</span> ` : ""}${esc(a.taskTitle || "")}</div>` : ""}</td><td class="sup-req">${esc(a.action)}</td><td class="small">${esc(a.owner)}</td>
        <td class="num small ${late ? "late" : ""}">${esc(fmt(a.due))}${late ? " · overdue" : ""}</td><td><span class="pill ${statusCls(a.status)}">${esc(a.status)}</span></td><td class="small muted">${esc(fmt((a.updatedAt || "").slice(0, 10)))}</td></tr>`; }).join("");
    const canLog = c.isAppr() || c.canLead(c.myUnit());
    return `<div class="panel">${head}
      <div class="toolbar" style="padding:10px 16px 12px;border-bottom:1px solid var(--line)">${unitSel("fbunit", f.unit)}
        <select data-xf="astatus" aria-label="Status"><option value="active" ${f.astatus === "active" ? "selected" : ""}>Active (open, in progress)</option>${ACT_STATUS.map((x) => `<option ${f.astatus === x ? "selected" : ""}>${x}</option>`).join("")}<option value="all" ${f.astatus === "all" ? "selected" : ""}>All</option></select>
        <select data-xf="asrc" aria-label="Source"><option value="">Source: any</option>${["Self", ...FROM].map((x) => `<option ${f.asrc === x ? "selected" : ""}>${x}</option>`).join("")}</select>
        <input type="text" data-xf="aq" placeholder="Search" value="${esc(f.aq)}" aria-label="Search actions" id="actQ"><span class="small muted">${list.length} action${list.length === 1 ? "" : "s"}</span>
        <span style="margin-left:auto" class="toolbar">${c.downloads() ? `<button class="btn" data-x="act-xlsx">Excel</button>` : ""}${canLog ? `<button class="btn primary" data-x="act-new">+ Log a corrective action</button>` : ""}</span></div>
      ${list.length ? `<div class="scroll"><table class="sup-table"><thead><tr><th>Unit</th><th>Source</th><th>Issue / finding</th><th>Corrective action</th><th>Owner</th><th>Due</th><th>Status</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table></div>
        ${list.length > f.ashow ? `<div class="toolbar" style="padding:12px 16px"><span class="small muted">Showing ${f.ashow} of ${list.length}</span><button class="btn" data-x="fb-more">Show 15 more</button></div>` : ""}`
        : `<div class="empty"><b>No corrective actions${f.astatus === "active" ? " open" : ""}</b>${canLog ? "Log one when a plan slips, a target is missed or feedback needs a fix." : "Sign in to log an action."}</div>`}</div>`;
  }
  async function actXlsx() {
    if (!c.libsReady("xlsx")) return;
    const f = state.fbv, q = f.aq.trim().toLowerCase();
    const list = state.acts.filter((a) => (!f.unit || a.unit === f.unit) && (!f.asrc || a.source === f.asrc) && (f.astatus === "all" || (f.astatus === "active" ? ["Open", "In progress"].includes(a.status) : a.status === f.astatus)) && (!q || `${a.issue} ${a.action} ${a.owner}`.toLowerCase().includes(q)));
    const rows = [["Unit", "Source", "Week", "Issue / finding", "Corrective action", "Owner", "Due", "Status", "Related task", "Notes", "Logged by", "Closed on"], ...list.map((a) => [c.unitName(a.unit), a.source, a.week, a.issue, a.action, a.owner, a.due, a.status, a.taskTitle, a.notes, a.createdBy, (a.closedAt || "").slice(0, 10)])];
    const wb = c.XLSX().utils.book_new(); c.XLSX().utils.book_append_sheet(wb, c.sheetFromRows(rows, [28, 14, 12, 44, 44, 20, 12, 12, 30, 30, 20, 12]), "Corrective actions");
    await c.writeXlsx(wb, `Corrective actions ${c.todayIso}.xlsx`, "Excel saved");
  }

  // ---------------- modals ----------------
  const field = (id, label, inner, wide) => `<div class="field${wide ? " wide" : ""}"><label for="${id}">${label}</label>${inner}</div>`;
  const opt = (list, cur, blank) => (blank ? `<option value="">${blank}</option>` : "") + list.map((x) => `<option ${x === cur ? "selected" : ""}>${esc(x)}</option>`).join("");
  function closeModal() { state.xm = null; drawModal(); }
  function drawModal() {
    const root = document.getElementById("xModalRoot"); if (!root) return;
    const m = state.xm; if (!m) { root.innerHTML = ""; return; }
    root.innerHTML = `<div class="overlay"><div class="modal wide xmodal" role="dialog" aria-modal="true">${m.type === "support" ? supModal(m) : m.type === "feedback" ? fbModal(m) : actModal(m)}</div></div>`;
    const first = root.querySelector("textarea, input[type=text], select"); if (first && m.isNew) first.focus();
  }
  function supModal(m) {
    const r = m.row, ed = m.canEdit, d = ed ? "" : "disabled", resp = canRespond(r.function), rd = ed && resp ? "" : "disabled", fns = fnUnits();
    const names = c.sortedUnits().map((u) => `<option value="${esc(u.name)}">`).join("");
    return `<div class="panel-head"><div><h2>${m.isNew ? "Log a support request" : `Request ${esc(r.ref || "")}`}</h2>${!m.isNew && r.updatedBy ? `<div class="small muted">Last updated ${esc(fmt((r.updatedAt || "").slice(0, 10)))} by ${esc(r.updatedBy)}</div>` : ""}</div></div>
      <div class="xgrid">
        ${field("sp-fn", "Function that received it", `<select id="sp-fn" ${m.isNew || c.isAppr() ? d : "disabled"}><option value="">Choose the function</option>${fns.map((u) => `<option value="${esc(u.id)}" ${u.id === r.function ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>`)}
        ${field("sp-req", "Requested by (business unit or function)", `<input type="text" id="sp-req" list="sp-names" value="${esc(r.requester)}" ${resp ? d : "disabled"}><datalist id="sp-names">${names}</datalist>`)}
        ${field("sp-cat", "Category", `<select id="sp-cat" ${d}>${opt(SUP_CATS, r.category, "Choose a category")}</select>`)}
        ${field("sp-pri", "Priority", `<select id="sp-pri" ${d}>${opt(SUP_PRI, r.priority || "Normal")}</select>`)}
        ${field("sp-date", "Date requested", `<input type="date" id="sp-date" value="${esc(r.requested)}" ${d}>`)}
        ${field("sp-st", "Status", `<select id="sp-st" ${rd}>${opt(SUP_STATUS, r.status || "Open")}</select>`)}
        ${field("sp-desc", "What was requested", `<textarea id="sp-desc" rows="3" ${d}>${esc(r.description)}</textarea>`, true)}
        ${field("sp-act", "Action taken / response", `<textarea id="sp-act" rows="3" ${rd}>${esc(r.action)}</textarea>`, true)}
        ${field("sp-rdate", "Response date", `<input type="date" id="sp-rdate" value="${esc(r.responded)}" ${rd}>`)}
        ${field("sp-by", "Responded by (name / role)", `<input type="text" id="sp-by" value="${esc(r.respondedBy)}" ${rd}>`)}
        ${field("sp-ev", "Evidence / reference (for example Email, ERP)", `<input type="text" id="sp-ev" value="${esc(r.evidence)}" ${rd}>`)}
        ${field("sp-fu", "Follow-up needed?", `<select id="sp-fu" ${rd}><option value="no" ${r.followUp ? "" : "selected"}>No</option><option value="yes" ${r.followUp ? "selected" : ""}>Yes</option></select>`)}
        ${field("sp-rem", "Remarks", `<input type="text" id="sp-rem" value="${esc(r.remarks)}" ${d}>`, true)}
      </div>
      <div class="save-bar"><div class="toolbar">${rd === "" && !m.isNew && ACTIVE.includes(r.status) ? `<button class="btn" data-x="sup-done">Mark as responded today</button>` : ""}${c.isAppr() && !m.isNew ? `<button class="btn danger" data-x="sup-del">${m.confirmDel ? "Click again to delete" : "Delete"}</button>` : ""}</div>
        <div class="toolbar"><button class="btn" data-x="close">${ed ? "Cancel" : "Close"}</button>${ed ? `<button class="btn primary" data-x="sup-save">Save</button>` : ""}</div></div>
      ${ed ? "" : `<div class="banner info" style="margin:0 16px 12px">View only. ${r.requesterUnit && r.requesterUnit === c.myUnit() ? "The function has taken this request up, so only it can change it now." : `Only ${esc(c.unitName(r.function))} and Group Strategy can change this request.`}</div>`}`;
  }
  function fbModal(m) {
    const r = m.row, weeks = c.weekChoices();
    return `<div class="panel-head"><div><h2>${m.isNew ? "Give feedback" : "Edit feedback"}</h2></div></div>
      <div class="xgrid">
        ${field("fb-unit", "Unit", `<select id="fb-unit">${c.sortedUnits().map((u) => `<option value="${esc(u.id)}" ${u.id === r.unit ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>`)}
        ${field("fb-from", "Feedback from", `<select id="fb-from">${c.isAppr() ? opt(FROM, r.from || "Group Strategy") : opt([c.auth().title], c.auth().title)}</select>`)}
        ${field("fb-week", "About the week (optional)", `<select id="fb-week"><option value="">No specific week</option>${weeks.map((w) => `<option value="${w}" ${w === r.week ? "selected" : ""}>${esc(c.weekLabel(w))}</option>`).join("")}</select>`)}
        ${field("fb-body", "Feedback", `<textarea id="fb-body" rows="5" placeholder="What was observed, and what is expected">${esc(r.body)}</textarea>`, true)}
      </div>
      <div class="save-bar"><div class="toolbar">${!m.isNew ? `<button class="btn danger" data-x="fb-del">${m.confirmDel ? "Click again to delete" : "Delete"}</button>` : ""}</div><div class="toolbar"><button class="btn" data-x="close">Cancel</button><button class="btn primary" data-x="fb-save">Save</button></div></div>`;
  }
  function actModal(m) {
    const r = m.row, appr = c.isAppr(), ed = m.canEdit, d = ed ? "" : "disabled";
    const units = c.sortedUnits().filter((u) => appr || u.id === c.myUnit() || u.id === r.unit);
    const titles = [...new Set(((state.plans[r.unit] || {}).tasks || []).map((t) => t.title).filter(Boolean))];
    return `<div class="panel-head"><div><h2>${m.isNew ? "Log a corrective action" : "Corrective action"}</h2></div></div>
      <div class="xgrid">
        ${field("ac-unit", "Unit", `<select id="ac-unit" ${m.isNew ? d : "disabled"}>${units.map((u) => `<option value="${esc(u.id)}" ${u.id === r.unit ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>`)}
        ${field("ac-src", "Raised by", appr ? `<select id="ac-src" ${d}>${opt(["Self", ...FROM], r.source || "Group Strategy")}</select>` : `<select id="ac-src" disabled><option>${esc(r.source || "Self")}</option></select>`)}
        ${field("ac-issue", "Issue / finding", `<textarea id="ac-issue" rows="3" placeholder="What went wrong or was missed" ${d}>${esc(r.issue)}</textarea>`, true)}
        ${field("ac-action", "Corrective action", `<textarea id="ac-action" rows="3" placeholder="What will be done to fix it" ${d}>${esc(r.action)}</textarea>`, true)}
        ${field("ac-owner", "Owner (name)", `<input type="text" id="ac-owner" value="${esc(r.owner)}" ${d}>`)}
        ${field("ac-due", "Due", `<input type="date" id="ac-due" value="${esc(r.due)}" ${d}>`)}
        ${field("ac-st", "Status", `<select id="ac-st" ${d}>${opt(appr ? ACT_STATUS : ACT_STATUS.filter((x) => x !== "Closed" || r.status === "Closed"), r.status || "Open")}</select>`)}
        ${field("ac-task", "Related task (optional)", `<input type="text" id="ac-task" list="ac-tasks" value="${esc(r.taskTitle)}" ${d}><datalist id="ac-tasks">${titles.map((t) => `<option value="${esc(t)}">`).join("")}</datalist>`)}
        ${field("ac-notes", "Progress notes", `<textarea id="ac-notes" rows="2" ${d}>${esc(r.notes)}</textarea>`, true)}
      </div>
      <div class="save-bar"><div class="toolbar">${appr && !m.isNew ? `<button class="btn danger" data-x="act-del">${m.confirmDel ? "Click again to delete" : "Delete"}</button>` : ""}</div>
        <div class="toolbar"><button class="btn" data-x="close">${ed ? "Cancel" : "Close"}</button>${ed ? `<button class="btn primary" data-x="act-save">Save</button>` : ""}</div></div>
      ${ed ? `<div class="small muted" style="padding:0 16px 12px">${appr ? "Group Strategy closes an action once the fix is verified." : "Mark it Done when finished; Group Strategy closes it after checking."}</div>` : `<div class="banner info" style="margin:0 16px 12px">View only. Sign in as this unit or as Group Strategy to change it.</div>`}`;
  }
  const v = (id) => { const e = document.getElementById(id); return e ? e.value : ""; };

  async function onAction(el) {
    const x = el.dataset.x, id = el.dataset.id;
    const f = state.sup, g = state.fbv;
    if (x === "sup-st") { f.status = el.dataset.v; f.show = 15; c.render(); }
    else if (x === "sup-more") { f.show += 15; c.render(); } else if (x === "sup-all") { f.show = 100000; c.render(); }
    else if (x === "sup-new") {
      const mine = c.myUnit(), fn = f.fn || (mine && c.canLead(mine) && fnUnits().some((u) => u.id === mine) ? mine : "");
      state.xm = { type: "support", isNew: true, canEdit: true, row: { function: fn, requester: canRespond(fn) ? "" : c.unitName(mine), category: "", description: "", priority: "Normal", requested: c.todayIso, status: "Open", responded: "", action: "", respondedBy: "", evidence: "", followUp: false, remarks: "" } }; drawModal();
    }
    else if (x === "sup-open") { const r = state.support.find((y) => y.id === id); if (r) { state.xm = { type: "support", isNew: false, canEdit: canEditReq(r), row: { ...r } }; drawModal(); } }
    else if (x === "sup-save") {
      const m = state.xm, r = m.row;
      const row = { id: m.isNew ? undefined : r.id, ref: r.ref, function: v("sp-fn"), requester: v("sp-req").trim(), requesterUnit: ((c.sortedUnits().find((u) => u.name === v("sp-req").trim()) || {}).id) || (state.xm.row.requesterUnit || ""), category: v("sp-cat"), description: v("sp-desc").trim(), priority: v("sp-pri"), requested: v("sp-date"), status: v("sp-st"), responded: v("sp-rdate"), action: v("sp-act").trim(), respondedBy: v("sp-by").trim(), evidence: v("sp-ev").trim(), followUp: v("sp-fu") === "yes", remarks: v("sp-rem").trim() };
      if (!row.function) { c.toast("Choose the function that received the request"); return; }
      if (!row.requester || !row.description) { c.toast("Fill in who requested it and what was requested"); return; }
      if (["Responded", "Closed"].includes(row.status) && !row.responded) row.responded = c.todayIso;
      const res = await c.api().saveSupport(A(), row); if (ok(res, "Request saved")) closeModal();
    }
    else if (x === "sup-done") { document.getElementById("sp-st").value = "Responded"; if (!v("sp-rdate")) document.getElementById("sp-rdate").value = c.todayIso; if (!v("sp-by")) document.getElementById("sp-by").value = A().name; }
    else if (x === "sup-del") { const m = state.xm; if (!m.confirmDel) { m.confirmDel = true; drawModal(); return; } const res = await c.api().deleteSupport(A(), m.row.id); if (ok(res, "Request deleted")) closeModal(); }
    else if (x === "sup-xlsx") supXlsx(); else if (x === "sup-pdf") supPdf();
    else if (x === "go-fb") { g.view = "feedback"; g.unit = el.dataset.unit || g.unit; c.goTab("fb"); }
    else if (x === "fb-view") { g.view = el.dataset.v; g.ashow = 15; c.render(); }
    else if (x === "fb-more") { g.ashow += 15; c.render(); }
    else if (x === "fb-new") { state.xm = { type: "feedback", isNew: true, row: { unit: g.unit || (c.sortedUnits()[0] || {}).id || "", from: "Group Strategy", week: c.thisWeek(), body: "" } }; drawModal(); }
    else if (x === "fb-edit") { const r = state.fbs.find((y) => y.id === id); if (r) { state.xm = { type: "feedback", isNew: false, row: { ...r } }; drawModal(); } }
    else if (x === "fb-save") {
      const m = state.xm, row = { id: m.isNew ? undefined : m.row.id, unit: v("fb-unit"), from: v("fb-from"), week: v("fb-week"), body: v("fb-body").trim(), taskRef: m.row.taskRef || "" };
      if (!row.body) { c.toast("Write the feedback first"); return; }
      const res = await c.api().saveFeedback(A(), row); if (ok(res, "Feedback saved")) { g.unit = row.unit; closeModal(); }
    }
    else if (x === "fb-del") { const m = state.xm; if (!m.confirmDel) { m.confirmDel = true; drawModal(); return; } const res = await c.api().deleteFeedback(A(), m.row.id); if (ok(res, "Feedback deleted")) closeModal(); }
    else if (x === "fb-ack") { const res = await c.api().ackFeedback(A(), id); ok(res, "Acknowledged"); }
    else if (x === "act-from-fb") { const fb = state.fbs.find((y) => y.id === id) || {}; g.view = "actions"; state.xm = { type: "action", isNew: true, canEdit: true, row: { unit: el.dataset.unit, source: fb.from || "Self", issue: fb.body || "", action: "", owner: "", due: "", status: "Open", taskTitle: "", notes: "", week: fb.week || "" } }; c.render(); drawModal(); }
    else if (x === "act-new") { const u = g.unit || c.myUnit() || (c.sortedUnits()[0] || {}).id || ""; state.xm = { type: "action", isNew: true, canEdit: true, row: { unit: u, source: c.isAppr() ? "Group Strategy" : "Self", issue: "", action: "", owner: "", due: "", status: "Open", taskTitle: "", notes: "", week: "" } }; drawModal(); }
    else if (x === "act-open") { const r = state.acts.find((y) => y.id === id); if (r) { state.xm = { type: "action", isNew: false, canEdit: c.canLead(r.unit), row: { ...r } }; drawModal(); } }
    else if (x === "act-save") {
      const m = state.xm, r = m.row;
      const row = { id: m.isNew ? undefined : r.id, unit: v("ac-unit") || r.unit, source: c.isAppr() ? v("ac-src") : (r.source || "Self"), issue: v("ac-issue").trim(), action: v("ac-action").trim(), owner: v("ac-owner").trim(), due: v("ac-due"), status: v("ac-st"), taskTitle: v("ac-task").trim(), notes: v("ac-notes").trim(), week: r.week || "", taskRef: r.taskRef || "" };
      if (!row.issue || !row.action) { c.toast("Describe the issue and the corrective action"); return; }
      const res = await c.api().saveAction(A(), row); if (ok(res, "Saved")) closeModal();
    }
    else if (x === "act-del") { const m = state.xm; if (!m.confirmDel) { m.confirmDel = true; drawModal(); return; } const res = await c.api().deleteAction(A(), m.row.id); if (ok(res, "Deleted")) closeModal(); }
    else if (x === "act-xlsx") actXlsx();
    else if (x === "close") closeModal();
  }
  function onFilter(el) {
    const k = el.dataset.xf, val = el.value, f = state.sup, g = state.fbv;
    if (k === "fn") f.fn = val; else if (k === "req") f.req = val; else if (k === "cat") f.cat = val; else if (k === "from") f.from = val; else if (k === "to") f.to = val; else if (k === "q") f.q = val;
    else if (k === "fbunit") g.unit = val; else if (k === "fbfrom") g.from = val; else if (k === "fback") g.ack = val; else if (k === "astatus") g.astatus = val; else if (k === "asrc") g.asrc = val; else if (k === "aq") g.aq = val;
    f.show = 15; g.ashow = 15;
    c.render();
  }
  const main = document.getElementById("main");
  main.addEventListener("click", (e) => { const el = e.target.closest("[data-x]"); if (el) onAction(el); });
  main.addEventListener("keydown", (e) => { const el = e.target.closest && e.target.closest("tr[data-x]"); if (el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onAction(el); } });
  main.addEventListener("change", (e) => { if (e.target.dataset && e.target.dataset.xf && e.target.dataset.xf !== "q" && e.target.dataset.xf !== "aq") onFilter(e.target); });
  main.addEventListener("input", (e) => { const t = e.target; if (t.dataset && (t.dataset.xf === "q" || t.dataset.xf === "aq")) { clearTimeout(onFilter.t); onFilter.t = setTimeout(() => onFilter(t), 250); } });
  const mr = document.getElementById("xModalRoot");
  mr.addEventListener("click", (e) => { const el = e.target.closest("[data-x]"); if (el) onAction(el); else if (e.target.classList && e.target.classList.contains("overlay")) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.xm) closeModal(); });

  // used by the task panel: feedback and corrective actions that belong to one task
  const forTask = (unit, ref) => ({ fbs: state.fbs.filter((f) => f.unit === unit && ref && f.taskRef === ref), acts: state.acts.filter((a) => a.unit === unit && ref && a.taskRef === ref) });
  const openFeedback = (unit, ref, week) => { state.xm = { type: "feedback", isNew: true, row: { unit, from: "Group Strategy", week: week || c.thisWeek(), body: "", taskRef: ref } }; drawModal(); };
  const openAction = (unit, ref, title) => { state.xm = { type: "action", isNew: true, canEdit: true, row: { unit, source: c.isAppr() ? "Group Strategy" : "Self", issue: "", action: "", owner: "", due: "", status: "Open", taskTitle: title || "", taskRef: ref, notes: "", week: "" } }; drawModal(); };
  const openExisting = (kind, id) => { if (kind === "fb") { const r = state.fbs.find((y) => y.id === id); if (r) { state.xm = { type: "feedback", isNew: false, row: { ...r } }; drawModal(); } } else { const r = state.acts.find((y) => y.id === id); if (r) { state.xm = { type: "action", isNew: false, canEdit: c.canLead(r.unit), row: { ...r } }; drawModal(); } } };
  const ackFb = async (id) => { const res = await c.api().ackFeedback(A(), id); ok(res, "Acknowledged"); };
  return { renderSupport, renderFb, subscribe, badgeCount, banner, forTask, openFeedback, openAction, openExisting, ackFb };
}
