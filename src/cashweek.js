// Cash flow, the weekly plan. It looks like the WEEKLY CASH FLOW statement every unit already uses:
//   Plan | Actual | Variance | % | Next week, with the lines behind each row one click away.
// Lines keep a code for life; the code links the plan to the daily collections and payments.
// Also here: the weekly Excel template and its upload, the reconcile check, and the downloads of what is on screen.
import { SECTIONS, CURRENCIES, STMT, STMT_GROUP, stmtOf, stmtDefault, stmtSection, bucketCode, num, sum, addDays, weekStart, weekEnd, weekLabel, movedIn, reconcileRows, TOLERANCE, bankAt, rateOf, MONTHS } from "./cashcalc.js";
import * as XL from "./cashxl.js";

const SEC_LABEL = Object.fromEntries(SECTIONS);
const dShort = (iso) => { if (!iso) return ""; const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const dMini = (iso) => { if (!iso) return ""; const [, m, d] = String(iso).slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]}`; };

export function createWeek(h) {
  const { S, c, esc, A } = h, plain = h.plain, mny = h.money;

  // ---------------- the numbers behind a week ----------------
  const cashAt = (units, day) => { const eb = h.realBank(); return sum(units, (u) => bankAt(eb, u, day).total); };
  const hasBankBy = (units, day) => { const eb = h.realBank(); return units.some((u) => bankAt(eb, u, day).has); };
  const logEtb = (l) => num(l.amount) * rateOf(l, h.fx());

  // Everything the statement needs for a set of units and one week.
  function buildStmt(units, W) {
    const E = weekEnd(W), items = new Map(S.itemsAll.map((i) => [i.id, i])), fxr = h.fx(), started = W <= c.todayIso;
    const lines = S.week.filter((w) => units.includes(w.unit) && w.week === W).map((w) => {
      const it = w.itemId ? items.get(w.itemId) : null; if (w.itemId && (!it || it.deletedAt)) return null;
      const cur = w.currency || (it && it.currency) || "ETB", rate = rateOf({ currency: cur, rate: w.rate }, fxr);
      const logged = it ? sum(S.log.filter((l) => l.itemId === it.id && l.day >= W && l.day <= E), logEtb) : 0, actual = it ? (logged || (w.actual != null && w.actual !== "" ? num(w.actual) * rate : 0)) : num(w.actual) * rate;
      return { w, it, kind: w.kind, stmt: stmtOf(w, it), plan: num(w.planned) * rate, actual, rate, cur, party: w.party || (it && it.party) || "", description: w.description || (it && it.description) || "", due: w.due || (it && it.expected) || "", remark: w.remark || w.note || "",
        startLeft: it ? h.viewOf(it, addDays(W, -1)).left : 0, endLeft: it ? h.viewOf(it, E).left : 0 };
    }).filter(Boolean).sort((a, b) => b.plan - a.plan);
    const planned = new Set(lines.filter((l) => l.it).map((l) => l.it.id));
    const loose = S.log.filter((l) => units.includes(l.unit) && l.day >= W && l.day <= E && !(l.itemId && planned.has(l.itemId)));
    const next = {}; for (const w of S.week.filter((q) => units.includes(q.unit) && q.week === addDays(W, 7))) { const it = w.itemId ? items.get(w.itemId) : null; if (w.itemId && !it) continue; const k = w.kind + "|" + stmtOf(w, it); next[k] = (next[k] || 0) + num(w.planned) * rateOf({ currency: w.currency || (it && it.currency) || "ETB", rate: w.rate }, fxr); }
    const rows = {}; for (const l of lines) (rows[l.kind + "|" + l.stmt] = rows[l.kind + "|" + l.stmt] || []).push(l);
    const kinds = ["in", "out"].map((k) => { const list = STMT.filter((s) => s[0] === k).map(([, section, label]) => { const key = k + "|" + label, ls = rows[key] || []; return { key, label, section, lines: ls, plan: sum(ls, (x) => x.plan), actual: sum(ls, (x) => x.actual), next: next[key] || 0 }; });
      const un = loose.filter((l) => l.kind === k), unplanned = { key: k + "|unplanned", label: k === "in" ? "Unplanned collections" : "Unplanned payments", section: "", lines: [], moves: un, plan: 0, actual: sum(un, logEtb), next: 0 };
      const all = [...list, unplanned]; return { kind: k, rows: all, plan: sum(all, (x) => x.plan), actual: sum(all, (x) => x.actual), next: sum(all, (x) => x.next) }; });
    const [cin, cout] = kinds, begin = hasBankBy(units, addDays(W, -1)) ? cashAt(units, addDays(W, -1)) : null, endDay = E < c.todayIso ? E : c.todayIso;
    return { W, E, started, units, in: cin, out: cout, begin, endPlan: (begin || 0) + cin.plan - cout.plan, endActual: (begin || 0) + cin.actual - cout.actual, endBank: started && hasBankBy(units, endDay) ? cashAt(units, endDay) : null,
      cand: units.length ? S.items.filter((it) => units.includes(it.unit) && h.canWrite(it.unit) && it.status === "open" && !planned.has(it.id) && (it.enteredOn || "0000") <= E && h.viewOf(it, addDays(W, -1)).left > 0.005).map((it) => ({ it, left: h.viewOf(it, addDays(W, -1)).left })) : [] };
  }
  const pctOf = (a, p) => (p > 0 ? Math.round((a / p) * 100) + "%" : "");

  // ---------------- the weekly plan screen ----------------
  function renderWeek() {
    const units = h.scopeUnits(), W = S.wk, m = buildStmt(units, W), open = S.wx || (S.wx = {});
    const lineRow = (l) => { const cur = l.cur !== "ETB" ? ` <span class="tag" title="Rate used: ${esc(String(l.rate))}">${esc(l.cur)}</span>` : "";
      return `<tr class="cf-sub"><td><span class="tag">${esc((l.it && l.it.code) || l.w.itemCode || "")}</span> <b>${esc(l.party || (l.description === "Weekly statement row" ? "Reported total for this row" : l.description))}</b>${!l.party && l.description === "Weekly statement row" ? '<span class="small muted"> · the unit reported one figure, no lines behind it</span>' : ""}${l.party && l.description ? `<span class="small muted"> · ${esc(l.description)}</span>` : ""}${cur}${l.due ? `<span class="small muted"> · due ${esc(dMini(l.due))}</span>` : ""}${l.remark ? `<div class="small muted">${esc(l.remark)}</div>` : ""}</td>
        <td class="num">${mny(l.plan, false)}</td><td class="num">${l.started === false ? "" : l.actual ? mny(l.actual, false) : '<span class="muted">–</span>'}</td><td></td><td></td><td></td>
        <td></td></tr>`; };
    // Opening a row shows its lines in steps: first by business unit (when more than one is shown), then by category, then the lines themselves.
    const grpRow = (key, label, n, plan, actual, depth, started) => `<tr class="cf-row clickable cf-g${depth}" data-cf="w-x" data-key="${esc(key)}" tabindex="0"><td style="padding-left:${12 + depth * 16}px"><span class="cf-caret">${open[key] ? "▾" : "▸"}</span> <b>${esc(label)}</b> <span class="small muted">${n} line${n === 1 ? "" : "s"}</span></td><td class="num">${plain(plan)}</td><td class="num">${started && actual ? plain(actual) : ""}</td><td colspan="4"></td></tr>`;
    const byKey = (ls, f) => { const mp = new Map(); ls.forEach((l) => { const k = f(l); (mp.get(k) || mp.set(k, []).get(k)).push(l); }); return [...mp.entries()].sort((a, b) => sum(b[1], (x) => x.plan) - sum(a[1], (x) => x.plan)); };
    const catOf = (l) => (l.it && l.it.typeCode) || "No category";
    const catsOf = (r, ls, uk, started, depth) => byKey(ls, catOf).map(([cat, cl]) => { const k = `${r.key}|${uk}|${cat}`, t = h.typeByCode(cat); return grpRow(k, t && t.label && t.label !== t.code ? `${cat} · ${t.label}` : cat, cl.length, sum(cl, (x) => x.plan), sum(cl, (x) => x.actual), depth, started) + (open[k] ? cl.map((l) => lineRow({ ...l, started })).join("") : ""); }).join("");
    const nest = (r, started) => { const multi = units.length > 1 && new Set(r.lines.map((l) => l.w.unit)).size > 1;
      if (!multi) return catsOf(r, r.lines, "all", started, 1);
      return byKey(r.lines, (l) => l.w.unit).map(([u, ul]) => { const k = `${r.key}|${u}`; return grpRow(k, h.uname(u), ul.length, sum(ul, (x) => x.plan), sum(ul, (x) => x.actual), 1, started) + (open[k] ? catsOf(r, ul, u, started, 2) : ""); }).join(""); };
    const block = (b, title, sub) => {
      const shown = b.rows.filter((r) => r.lines.length || r.next || r.actual || r.plan);
      const groups = ["operating", "investing", "financing", ""].map((s) => ({ s, rows: shown.filter((r) => r.section === s) })).filter((g) => g.rows.length);
      const body = groups.map((g) => `${g.s ? `<tr class="cf-sec2"><td colspan="7">${esc(STMT_GROUP[g.s])}</td></tr>` : ""}${g.rows.map((r) => { const un = !r.section, ex = un ? open[r.key] !== false : open[r.key], can = r.lines.length || (un && r.moves.length);
        return `<tr class="cf-row${can ? " clickable" : ""}" ${can ? `data-cf="w-x" data-key="${esc(r.key)}" tabindex="0"` : ""}><td>${can ? `<span class="cf-caret">${ex ? "▾" : "▸"}</span> ` : '<span class="cf-caret"> </span> '}${esc(r.label)}${can ? ` <span class="small muted">${r.lines.length || r.moves.length}</span>` : ""}</td>
          <td class="num">${r.plan ? plain(r.plan) : ""}</td><td class="num">${m.started ? (r.actual ? plain(r.actual) : "") : ""}</td><td class="num ${m.started && r.actual - r.plan < -0.5 ? "neg" : ""}">${m.started && (r.plan || r.actual) ? mny(r.actual - r.plan) : ""}</td><td class="num small">${m.started ? pctOf(r.actual, r.plan) : ""}</td><td class="num muted">${r.next ? plain(r.next) : ""}</td><td></td></tr>
          ${ex && r.lines.length ? nest(r, m.started) : ""}
          ${ex && un ? r.moves.map((l) => `<tr class="cf-sub"><td class="small">${esc(dMini(l.day))} · ${esc(l.party || l.description || "Paid or collected without a plan line")}${l.bank ? ` · ${esc(l.bank)}` : ""}</td><td></td><td class="num">${plain(logEtb(l))}</td><td colspan="4"></td></tr>`).join("") : ""}`; }).join("")}`).join("");
      return `<tr class="cf-sec"><td colspan="7"><b>${title}</b></td></tr>${body}<tr class="tot"><td>${sub}</td><td class="num">${plain(b.plan)}</td><td class="num">${m.started ? plain(b.actual) : ""}</td><td class="num ${m.started && b.actual - b.plan < -0.5 ? "neg" : ""}">${m.started ? mny(b.actual - b.plan) : ""}</td><td class="num small">${m.started ? pctOf(b.actual, b.plan) : ""}</td><td class="num">${b.next ? plain(b.next) : ""}</td><td></td></tr>`; };
    const bg = m.begin;
    const tbl = `<div class="scroll"><table class="cf-table cf-stmt"><thead><tr><th>Description</th><th>Plan</th><th title="What really moved, from the daily collections and payments">Actual</th><th>Var.</th><th>%</th><th title="The plan already entered for the next week">Next week</th><th></th></tr></thead><tbody>
      <tr class="tot"><td>Beginning cash <span class="small muted">${bg === null ? "no bank report the day before" : "bank balance the day before"}</span></td><td class="num">${bg === null ? "" : plain(bg)}</td><td class="num">${m.started && bg !== null ? plain(bg) : ""}</td><td></td><td></td><td></td><td></td></tr>
      ${block(m.in, "Cash inflows", "Total cash inflows")}
      <tr class="tot"><td>Available cash</td><td class="num">${plain((bg || 0) + m.in.plan)}</td><td class="num">${m.started ? plain((bg || 0) + m.in.actual) : ""}</td><td></td><td></td><td></td><td></td></tr>
      ${block(m.out, "Cash outflows", "Total cash outflows")}
      <tr class="tot strong"><td>Ending cash</td><td class="num">${plain(m.endPlan)}</td><td class="num">${m.started ? plain(m.endActual) : ""}</td><td class="num ${m.started && m.endActual - m.endPlan < -0.5 ? "neg" : ""}">${m.started ? mny(m.endActual - m.endPlan) : ""}</td><td></td><td></td><td></td></tr>
      ${m.endBank !== null ? `<tr><td class="small muted">Bank balance at the end (bank report)</td><td></td><td class="num ${Math.abs(m.endBank - m.endActual) > TOLERANCE ? "neg" : ""}">${plain(m.endBank)}</td><td class="num ${Math.abs(m.endBank - m.endActual) > TOLERANCE ? "neg" : ""}">${Math.abs(m.endBank - m.endActual) > TOLERANCE ? mny(m.endBank - m.endActual) : ""}</td><td colspan="3" class="small muted">${Math.abs(m.endBank - m.endActual) > TOLERANCE ? "differs from the cash recorded" : "matches"}</td></tr>` : ""}
      </tbody></table></div>`;
    const empty = !m.in.rows.some((r) => r.lines.length) && !m.out.rows.some((r) => r.lines.length) && !m.in.actual && !m.out.actual ? `<div class="empty"><b>No plan for this week yet</b>Plans are loaded from Collections &amp; payments (Status tab: upload the next plan).</div>` : "";
    return `<div class="cf-body"><div class="cf-bar">${h.allUnits().length > 1 ? h.unitSel(S.scope) : ""}<span class="cf-wk"><button class="btn small" data-cf="w-shift" data-v="-7" aria-label="Previous week">‹</button><b title="Monday to Saturday">${esc(weekLabel(W))}</b><button class="btn small" data-cf="w-shift" data-v="7" aria-label="Next week">›</button><input type="date" data-cfc="wk" value="${esc(W)}" aria-label="Pick any day in the week" class="cf-datemini">${W !== weekStart(c.todayIso) ? '<button class="btn small ghost" data-cf="w-thisweek">This week</button>' : ""}</span>
        <span class="cf-right"><button class="btn small" data-cf="w-dl" data-v="week">Download Excel</button><button class="btn small" data-cf="w-pdf">Download PDF</button></span></div>
      ${empty}${tbl}</div>`;
  }

  // ---------------- add / edit a line ----------------
  function lineForm(m) {
    const r = m.row, ex = !!r.itemId, field = h.field, rows = STMT.filter((s) => s[0] === r.kind), stmt = r.stmt && rows.some((s) => s[2] === r.stmt) ? r.stmt : stmtDefault(r.kind, r.section || "operating"), usd = r.currency === "USD";
    return `<div class="panel-head"><h2>${m.isNew ? "Add a line to the week of " + esc(dShort(S.wk)) : "Planned line " + esc(r.code || "")}</h2></div><div class="xgrid">
      ${field("cw-unit", "Unit", `<select id="cw-unit" ${ex || r.noItem ? "disabled" : ""}>${h.unitOpts(r.unit)}</select>`)}${field("cw-kind", "Collect or pay", `<select id="cw-kind" ${ex || r.noItem ? "disabled" : ""}><option value="in" ${r.kind === "in" ? "selected" : ""}>Collect (inflow)</option><option value="out" ${r.kind === "out" ? "selected" : ""}>Pay (outflow)</option></select>`)}
      ${field("cw-stmt", "Row of the cash flow", `<select id="cw-stmt">${rows.map((s) => `<option ${s[2] === stmt ? "selected" : ""}>${esc(s[2])}</option>`).join("")}</select>`)}${field("cw-party", "Customer or payee", `<input type="text" id="cw-party" value="${esc(r.party)}">`)}
      ${field("cw-ref", "Invoice or reference no.", `<input type="text" id="cw-ref" value="${esc(r.ref)}">`)}${field("cw-due", "Due date", `<input type="date" id="cw-due" value="${esc(r.due || "")}">`)}
      ${field("cw-desc", "Description", `<input type="text" id="cw-desc" value="${esc(r.description)}">`, true)}
      ${field("cw-plan", "Planned this week", `<input type="number" id="cw-plan" min="0" step="any" value="${esc(String(r.planned ?? ""))}"><div class="small muted">What you expect to ${r.kind === "in" ? "collect" : "pay"} from ${esc(dShort(S.wk))} to ${esc(dShort(weekEnd(S.wk)))}. It can be less than the whole amount owed.</div>`)}
      ${field("cw-cur", "Currency", `<select id="cw-cur" ${ex || r.noItem ? "disabled" : ""}>${CURRENCIES.map((x) => `<option ${x === r.currency ? "selected" : ""}>${x}</option>`).join("")}</select>`)}
      ${usd ? field("cw-rate", "Exchange rate (ETB per USD)", `<input type="number" id="cw-rate" min="0" step="any" value="${esc(String(r.rate ?? "") || String(h.fx() || ""))}"><div class="small muted">Kept with this week only, so a new rate never changes earlier weeks.</div>`) : ""}
      ${ex || r.noItem ? "" : field("cw-out", "Total still owed (optional)", `<input type="number" id="cw-out" min="0" step="any" value="${esc(String(r.outstanding ?? ""))}"><div class="small muted">Only if more than this week's plan.</div>`)}
      ${ex || r.noItem ? "" : field("cw-type", "Type", `<select id="cw-type">${h.typeOptions(r.kind, r.typeCode, false)}</select>`)}${ex || r.noItem ? "" : field("cw-buck", "Urgency", `<select id="cw-buck">${[1, 2, 3].map((b) => `<option value="${b}" ${Number(r.bucket) === b ? "selected" : ""}>${b} / ${b}${b}</option>`).join("")}</select>`)}
      ${field("cw-note", "Remark", `<input type="text" id="cw-note" value="${esc(r.note || "")}">`)}</div>
      <div class="save-bar"><div class="toolbar"></div><div class="toolbar"><button class="btn" data-cf="close">Cancel</button><button class="btn primary" data-cf="w-save">Save</button></div></div>`;
  }
  const readLine = () => { const r = S.m.row, g = h.v, has = (id) => !!document.getElementById(id); Object.assign(r, { unit: g("cw-unit") || r.unit, kind: g("cw-kind") || r.kind, stmt: g("cw-stmt") || r.stmt, party: g("cw-party").trim(), ref: g("cw-ref").trim(), description: g("cw-desc").trim(), typeCode: has("cw-type") ? g("cw-type") : r.typeCode, bucket: has("cw-buck") ? Number(g("cw-buck")) || 1 : r.bucket, due: g("cw-due"), planned: g("cw-plan"), outstanding: has("cw-out") ? g("cw-out") : r.outstanding, currency: g("cw-cur") || r.currency, rate: has("cw-rate") ? g("cw-rate") : r.rate, note: g("cw-note") }); };
  const blankLine = (kind) => ({ itemId: "", unit: h.writableUnits().includes(S.scope) ? S.scope : h.writableUnits()[0], kind: kind || "in", stmt: "", party: "", ref: "", description: "", typeCode: "", bucket: 1, due: "", planned: "", outstanding: "", currency: "ETB", rate: "", note: "" });
  function onModalChange(id) { if (!S.m || S.m.type !== "weekline") return; const k = S.m.row.kind; readLine(); if (id === "cw-kind" && S.m.row.kind !== k) S.m.row.stmt = ""; h.drawModal(); }

  async function saveLine() {
    readLine(); const r = S.m.row, planned = num(r.planned);
    if (!r.unit) { c.toast("Choose a unit"); return; } if (!r.party && !r.description) { c.toast("Fill in the customer or payee, or a description"); return; } if (!(planned > 0)) { c.toast("Enter the amount planned for this week"); return; }
    if (r.currency === "USD" && !(num(r.rate) > 0)) { c.toast("Enter the exchange rate for this USD line"); return; }
    const stmt = r.stmt || stmtDefault(r.kind, r.section), section = stmtSection(stmt), rate = r.currency === "USD" ? num(r.rate) : "";
    const ok = await h.run(async () => {
      let itemId = r.itemId, it = itemId ? S.items.find((i) => i.id === itemId) : null;
      if (!r.noItem && !it) { const out = num(r.outstanding) > 0 ? num(r.outstanding) : planned;
        const res = await c.api().saveCfItem(A(), { unit: r.unit, kind: r.kind, party: r.party, description: r.description, ref: r.ref, typeCode: r.typeCode, bucket: r.bucket, amount: out, total: out, currency: r.currency, priority: "Normal", expected: r.due || "", status: "open", enteredOn: c.todayIso, section, firstWeek: S.wk, note: "" });
        if (res && res.error) return res; itemId = res.id; }
      else if (it) { const res = await c.api().saveCfItem(A(), h.itemRow({ ...it, party: r.party, description: r.description, ref: r.ref, typeCode: r.typeCode, bucket: r.bucket, section, expected: r.due || it.expected })); if (res && res.error) return res; }
      return c.api().saveCfWeek(A(), { id: r.weekId, unit: r.unit, week: S.wk, itemId: itemId || "", kind: r.kind, planned, due: r.due || "", rolled: !!r.rolled, note: r.note, stmt, section, party: r.party, description: r.description, ref: r.ref, currency: r.currency, rate, remark: r.remark || "" });
    }, "Saved");
    if (ok) h.closeModal();
  }
  async function rollIn(list) {
    if (!list.length) return;
    await h.run(async () => { for (const x of list) { const prev = S.week.filter((w) => w.itemId === x.it.id).sort((a, b) => b.week.localeCompare(a.week))[0] || {};
      const res = await c.api().saveCfWeek(A(), { unit: x.it.unit, week: S.wk, itemId: x.it.id, planned: Math.round(x.left * 100) / 100, due: x.it.expected || "", rolled: true, note: "", stmt: prev.stmt || stmtDefault(x.it.kind, x.it.section), section: x.it.section, currency: x.it.currency, rate: x.it.currency === "USD" ? prev.rate || h.fx() || "" : "" }); if (res && res.error) return res; } return { ok: true }; }, `${list.length} line${list.length > 1 ? "s" : ""} rolled into this week`);
  }

  // ---------------- trace one line through the weeks and days ----------------
  function traceView(m) {
    const it = S.itemsAll.find((i) => i.id === m.itemId); if (!it) return `<div class="panel-head"><h2>Line not found</h2></div><div class="save-bar"><div></div><button class="btn" data-cf="close">Close</button></div>`;
    const weeks = S.week.filter((w) => w.itemId === it.id).sort((a, b) => a.week.localeCompare(b.week)), logs = S.log.filter((l) => l.itemId === it.id).sort((a, b) => a.day.localeCompare(b.day));
    const first = weeks[0] ? weeks[0].week : it.firstWeek || weekStart(it.enteredOn || c.todayIso);
    return `<div class="panel-head"><div><h2>${esc(it.party || it.description)} <span class="tag">${esc(it.code || "")}</span></h2><div class="small muted">${it.kind === "in" ? "Collection" : "Payment"} · ${esc(h.uname(it.unit))}${it.ref ? " · " + esc(it.ref) : ""}${it.typeCode ? " · type " + esc(it.typeCode) : ""} · first planned in the week of ${esc(dShort(first))} · ${weeks.length} week${weeks.length === 1 ? "" : "s"} in the plan</div></div></div>
      <div class="small" style="margin:8px 0 4px"><b>Week by week</b></div>
      <div class="scroll"><table class="cf-table"><thead><tr><th>Week</th><th>Planned</th><th>${it.kind === "in" ? "Collected" : "Paid"}</th><th>Left</th><th>Due</th></tr></thead><tbody>${weeks.map((w) => `<tr><td>${esc(weekLabel(w.week))}${w.rolled ? ' <span class="tag">rolled</span>' : ""}</td><td class="num">${plain(w.planned)}</td><td class="num">${plain(movedIn(S.log, it.id, w.week, weekEnd(w.week)))}</td><td class="num">${plain(h.viewOf(it, weekEnd(w.week)).left)}</td><td class="small">${esc(dShort(w.due))}</td></tr>`).join("") || `<tr><td colspan="5" class="small muted">Not in any weekly plan yet.</td></tr>`}</tbody></table></div>
      <div class="small" style="margin:12px 0 4px"><b>Cash recorded against it</b></div>
      <div class="scroll"><table class="cf-table"><thead><tr><th>Day</th><th>Bank</th><th>Amount</th><th>Note</th></tr></thead><tbody>${logs.map((l) => `<tr><td>${esc(dShort(l.day))}</td><td>${esc(l.bank || "")}</td><td class="num">${plain(l.amount)}</td><td class="small">${esc(l.note || "")}</td></tr>`).join("") || `<tr><td colspan="4" class="small muted">Nothing ${it.kind === "in" ? "collected" : "paid"} yet.</td></tr>`}</tbody></table></div>
      <div class="small muted" style="margin-top:8px">Left when entered: <b>${plain(it.amount)}</b> · ${it.kind === "in" ? "collected" : "paid"} so far: <b>${plain(sum(logs, (l) => l.amount))}</b> · left now: <b>${plain(h.viewOf(it, "9999-12-31").left)}</b></div>
      <div class="save-bar"><div></div><div class="toolbar"><button class="btn" data-cf="close">Close</button></div></div>`;
  }

  const weekRow = (w) => ({ id: w.itemId ? undefined : w.id, unit: w.unit, week: w.week, itemId: w.itemId || "", kind: w.kind, planned: w.planned, due: w.due || "", rolled: !!w.rolled, note: w.note || "", stmt: w.stmt || "", section: w.section, party: w.party || "", description: w.description || "", ref: w.ref || "", currency: w.currency || "ETB", rate: w.rate === "" || w.rate == null ? "" : w.rate, remark: w.remark || "", actual: w.actual === "" || w.actual == null ? "" : w.actual });
  async function undoUpload() {
    const u = S.uu; if (!u) return; S.uu = null;
    await h.run(async () => { for (const f of [...u.steps].reverse()) { const r = await f(); if (r && r.error) return r; } return { ok: true }; }, `${u.label} was undone`);
  }
  // Imported lines that now have a line with a code for the same name in the same week: the imported copy is the duplicate.
  function dupPairs(units) {
    const out = []; for (const w of S.week) { if (w.itemId || !units.includes(w.unit) || !h.canWrite(w.unit)) continue;
      const q = S.week.find((o) => o.itemId && o.unit === w.unit && o.week === w.week && o.kind === w.kind && (sim(wText(o), wText(w)) >= 0.6 || (!wText(w).trim() && Math.abs(num(o.planned) - num(w.planned)) < 1))); if (q) out.push({ w, q }); }
    return out;
  }
  function cleanView(m) {
    const units = h.scopeUnits();
    if (m.mode === "dup") { const ps = dupPairs(units);
      return `<div class="panel-head"><div><h2>Remove duplicate lines</h2><div class="small muted">A line imported from the old weekly workbooks, and a line with a code for the same name in the same week. The imported copy is removed and its reported actual moves to the line with the code.</div></div></div>
        ${ps.length ? `<div class="scroll"><table class="cf-table"><thead><tr><th>Week</th><th>Unit</th><th>Line</th><th>Imported</th><th>With code</th></tr></thead><tbody>${ps.slice(0, 60).map(({ w, q }) => `<tr><td class="small">${esc(dMini(w.week))}</td><td class="small">${esc(h.ushort(w.unit))}</td><td>${esc(w.party || w.description)} <span class="tag">${esc(q.itemCode || "")}</span></td><td class="num">${plain(w.planned)}</td><td class="num">${plain(q.planned)}</td></tr>`).join("")}</tbody></table></div>${ps.length > 60 ? `<div class="small muted">and ${ps.length - 60} more</div>` : ""}` : `<div class="empty"><b>No duplicates found</b></div>`}
        <div class="save-bar"><div></div><div class="toolbar"><button class="btn" data-cf="close">Close</button>${ps.length ? `<button class="btn primary" data-cf="w-dup-go">Remove ${ps.length} imported cop${ps.length === 1 ? "y" : "ies"}</button>` : ""}</div></div>`; }
    const n = S.week.filter((w) => w.week === S.wk && units.includes(w.unit) && h.canWrite(w.unit)).length;
    return `<div class="panel-head"><div><h2>Take out every line of this week</h2><div class="small muted">${n} line${n === 1 ? "" : "s"} in the week of ${esc(dShort(S.wk))} for ${S.scope === "all" ? "the units you can edit" : esc(h.uname(S.scope))}. The lines themselves, their codes and the cash recorded against them are not deleted, only their place in this week's plan. You can undo it right after.</div></div>
      <div class="save-bar"><div></div><div class="toolbar"><button class="btn" data-cf="close">Cancel</button>${n ? `<button class="btn danger" data-cf="w-clear-go">Take out ${n} line${n === 1 ? "" : "s"}</button>` : ""}</div></div>`;
  }
  async function cleanGo(mode) {
    const units = h.scopeUnits(), undo = []; let n = 0;
    const list = mode === "dup" ? dupPairs(units).map(({ w, q }) => ({ w, q })) : S.week.filter((w) => w.week === S.wk && units.includes(w.unit) && h.canWrite(w.unit)).map((w) => ({ w }));
    const ok = await h.run(async () => { for (const { w, q } of list) { const old = weekRow(w);
      if (q && (q.actual === "" || q.actual == null) && w.actual !== "" && w.actual != null) { const prevQ = weekRow(q), r = await c.api().saveCfWeek(A(), { ...prevQ, actual: w.actual }); if (r && r.error) return r; undo.push(() => c.api().saveCfWeek(A(), prevQ)); }
      const d = await c.api().deleteCf(A(), "cf_week_lines", w.id); if (d && d.error) return d; undo.push(() => c.api().saveCfWeek(A(), { ...old, id: w.itemId ? undefined : w.id })); n++; } return { ok: true }; }, "");
    if (ok) { S.uu = { label: mode === "dup" ? `Removing ${n} duplicate${n === 1 ? "" : "s"}` : `Taking out ${n} line${n === 1 ? "" : "s"}`, steps: undo }; h.closeModal(); }
  }

  // ---------------- link a plan line to a line (same line, different value in another week, for example a part payment) ----------------
  const STOP = new Set("and the for from month plan payment pay collection service services plc".split()), toks = (s) => new Set((String(s || "").toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((x) => !STOP.has(x)));
  const sim = (a, b) => { const x = toks(a), y = toks(b); if (!x.size || !y.size) return 0; let n = 0; x.forEach((t) => { if (y.has(t)) n++; }); return n / (x.size + y.size - n); };
  const wText = (w) => `${w.party || ""} ${w.description || ""}`;
  const sameLines = (w) => S.week.filter((q) => q.id !== w.id && !q.itemId && q.unit === w.unit && q.kind === w.kind && sim(wText(q), wText(w)) >= 0.6);
  function linkForm(m) {
    const w = S.week.find((q) => q.id === m.weekId); if (!w) return `<div class="panel-head"><h2>Line not found</h2></div><div class="save-bar"><div></div><button class="btn" data-cf="close">Close</button></div>`;
    const cands = S.items.filter((i) => i.unit === w.unit && i.kind === w.kind).map((i) => ({ i, s: sim(wText(w), `${i.party} ${i.description}`) + (Math.abs(num(i.amount) - num(w.planned)) < 1 ? 0.5 : 0) })).sort((a, b) => b.s - a.s).slice(0, 80), others = sameLines(w);
    return `<div class="panel-head"><div><h2>Link to a line</h2><div class="small muted">${esc(w.party || w.description)} · ${plain(w.planned)} · week of ${esc(dShort(w.week))}. Linking makes this week's amount part of that line, so its code follows it through the weeks. The amount can differ from week to week, for example a part payment.</div></div></div>
      <div class="xgrid">${h.field("lk-code", "Line", `<input type="text" id="lk-code" list="lk-lines" value="${esc(m.code || (cands[0] && cands[0].s >= 0.6 ? cands[0].i.code : ""))}" placeholder="Type or pick a code, e.g. CF-00012" autocomplete="off"><datalist id="lk-lines">${cands.map((x) => `<option value="${esc(x.i.code)}" label="${esc((x.i.party || x.i.description || "") + " · " + plain(x.i.amount) + " " + x.i.currency)}"></option>`).join("")}</datalist>`, true)}
      <div class="field wide"><label><input type="checkbox" id="lk-all" ${others.length ? "checked" : ""} ${others.length ? "" : "disabled"}> Also link the ${others.length} other week${others.length === 1 ? "" : "s"} with the same name${others.length ? ": " + others.slice(0, 6).map((o) => esc(dMini(o.week)) + " " + plain(o.planned)).join(", ") + (others.length > 6 ? "…" : "") : ""}</label></div></div>
      <div class="save-bar"><div class="toolbar"><button class="btn" data-cf="w-link-new" title="Make a new line (with a code) from this one, and link it">No line fits: create a new one</button></div><div class="toolbar"><button class="btn" data-cf="close">Cancel</button><button class="btn primary" data-cf="w-link-save">Link</button></div></div>`;
  }
  async function linkLines(weeks, item) {
    let n = 0, skipped = 0;
    const res = await h.run(async () => { for (const w of weeks) {
      if (S.week.some((q) => q.itemId === item.id && q.week === w.week)) { skipped++; continue; }
      const r = await c.api().saveCfWeek(A(), { unit: w.unit, week: w.week, itemId: item.id, kind: item.kind, planned: w.planned, due: w.due || "", rolled: !!w.rolled, note: w.note || "", stmt: w.stmt || "", section: w.section, party: w.party, description: w.description, ref: w.ref, currency: w.currency, rate: w.rate === "" || w.rate == null ? "" : w.rate, remark: w.remark || "", actual: w.actual === "" || w.actual == null ? "" : w.actual });
      if (r && r.error) return r; const d = await c.api().deleteCf(A(), "cf_week_lines", w.id); if (d && d.error) return d; n++; } return { ok: true }; }, "");
    if (res) c.toast(`${n} week line${n === 1 ? "" : "s"} linked to ${item.code}${skipped ? `, ${skipped} skipped (that line is already planned that week)` : ""}`);
    return !!res;
  }
  async function onLinkSave(create) {
    const w = S.week.find((q) => q.id === S.m.weekId); if (!w) return; const all = !!(document.getElementById("lk-all") || {}).checked, weeks = [w, ...(all ? sameLines(w) : [])]; let item;
    if (create) { const first = weeks.map((x) => x.week).sort()[0], last = weeks.slice().sort((a, b) => b.week.localeCompare(a.week))[0], out = num(last.planned);
      const r = await h.run(() => c.api().saveCfItem(A(), { unit: w.unit, kind: w.kind, party: w.party, description: w.description, ref: w.ref, typeCode: "", bucket: 1, amount: out, total: out, currency: w.currency || "ETB", priority: "Normal", expected: w.due || "", status: "open", enteredOn: c.todayIso, section: w.section, firstWeek: first, note: "" }), "");
      if (!r || !r.id) return; item = { id: r.id, code: r.code || "the new line", kind: w.kind }; }
    else { const code = h.v("lk-code").trim().toUpperCase(); item = S.items.find((i) => i.unit === w.unit && i.code && i.code.toUpperCase() === code); if (!item) { c.toast("No line has that code. Pick one from the list."); return; } if (item.kind !== w.kind) { c.toast("That line is a " + (item.kind === "in" ? "collection" : "payment") + ". Pick a line of the same kind."); return; } }
    if (await linkLines(weeks, item)) h.closeModal();
  }

  // ---------------- reconcile ----------------
  // Only days from when a unit starts recording daily collections and payments are checked; earlier history has no daily lines to check against.
  const reconRows = (units, from, to) => { const start = {}; S.log.forEach((l) => { if (l.bank && (!start[l.unit] || l.day < start[l.unit])) start[l.unit] = l.day; });
    return { start, rows: reconcileRows(h.realBank(), S.log, units, from, to, h.fx()).filter((x) => start[x.unit] && x.day >= start[x.unit]) }; };
  function renderReconcile() {
    const units = h.scopeUnits(), r = S.rc, to = S.day > c.todayIso ? c.todayIso : S.day, from = addDays(to, -(r.range - 1)), { start, rows } = reconRows(units, from, to);
    const bad = rows.filter((x) => x.flags.length), shown = r.all ? rows : bad, chip = h.chip;
    const body = shown.map((x) => `<tr class="clickable" data-cf="w-goday" data-day="${esc(x.day)}" data-unit="${esc(x.unit)}" tabindex="0"><td class="small">${esc(dMini(x.day))}</td><td class="small">${esc(h.ushort(x.unit))}</td><td><b>${esc(x.bank)}</b></td>
      <td class="num">${x.has_bank ? plain(x.bank_in) : '<span class="muted">–</span>'}</td><td class="num">${plain(x.m_in)}</td><td class="num ${x.diff_in !== undefined && Math.abs(x.diff_in) > TOLERANCE ? "neg" : ""}">${x.diff_in !== undefined ? mny(x.diff_in) : ""}</td>
      <td class="num">${x.has_bank ? plain(x.bank_out) : '<span class="muted">–</span>'}</td><td class="num">${plain(x.m_out)}</td><td class="num ${x.diff_out !== undefined && Math.abs(x.diff_out) > TOLERANCE ? "neg" : ""}">${x.diff_out !== undefined ? mny(x.diff_out) : ""}</td>
      <td class="small">${x.flags.length ? x.flags.map((f) => `<div class="neg">${esc(f)}</div>`).join("") : '<span class="pill s-done">OK</span>'}</td></tr>`).join("");
    const info = Object.keys(start).length ? "" : `<div class="cf-note">The check starts when a unit records its first daily collections and payments in the app. Earlier history has no daily lines to check against.</div>`;
    return `<div class="cf-body"><div class="cf-bar">${h.allUnits().length > 1 ? h.unitSel(S.scope) : ""}<span class="cf-group">${[7, 14, 30, 90].map((n) => chip(r.range === n, `data-cf="w-rcrange" data-v="${n}"`, `${n} days`)).join("")}</span><span class="cf-group">${chip(!r.all, 'data-cf="w-rcall" data-v="0"', "Mismatches")}${chip(r.all, 'data-cf="w-rcall" data-v="1"', "All")}</span>
        <span class="small muted">${rows.length} bank line${rows.length === 1 ? "" : "s"} checked · <b class="${bad.length ? "neg" : ""}">${bad.length}</b> to look at · differences under ${TOLERANCE} ETB ignored</span><span class="cf-right">${h.menu([['data-cf="w-dl" data-v="recon"', "Download this view"]])}</span></div>
      ${info}<section class="cf-card flush">${shown.length ? `<div class="scroll"><table class="cf-table"><thead><tr><th>Day</th><th>Unit</th><th>Bank</th><th title="Total in on the bank report">Bank in</th><th title="Collections recorded with this bank">Colln</th><th>Diff</th><th>Bank out</th><th title="Payments recorded with this bank">Paid</th><th>Diff</th><th>Check</th></tr></thead><tbody>${body}</tbody></table></div>` : `<div class="empty"><b>${rows.length ? "Everything matches" : "Nothing to check yet"}</b>${rows.length ? "Every bank report in this period agrees with the collections and payments." : "Record the bank report and the collections and payments for a day to see the check here."}</div>`}</section></div>`;
  }

  // ---------------- downloads of what is on screen ----------------
  async function weekPdf() {
    if (!c.libsReady("pdf")) return; const units = h.scopeUnits(), W = S.wk, m = buildStmt(units, W), rows = stmtRows(m, "").slice(3);
    const doc = c.newPdf("Weekly cash flow", `${units.length === 1 ? h.uname(units[0]) : "All business units"}  ·  ${weekLabel(W)}`);
    const fmt = (v) => (v === "" || v == null ? "" : typeof v === "number" ? plain(v) : v), body = rows.map((r) => { const head = r.length === 1 || /^(Total|Available|Ending|Beginning)/.test(String(r[0])); return [0, 1, 2, 3].map((i) => ({ content: fmt(r[i]), styles: { fontStyle: head ? "bold" : "normal", halign: i ? "right" : "left" } })); });
    doc.autoTable({ startY: 92, margin: { left: 36, right: 36 }, head: [["Description", "Plan", "Actual", "Variance"]], body, ...c.pdfStyle() });
    await c.save(`Weekly cash flow ${W}.pdf`, doc.output("arraybuffer"), "PDF saved. Open it to print.");
  }
  const sheet = (X, wb, rows, w, name) => X.utils.book_append_sheet(wb, c.sheetFromRows(rows, w), name.slice(0, 31));
  function stmtRows(m, label) {
    const rows = [[label], [], ["Description", "Plan", "Actual", "Variance", "%", "Next week plan"], ["Beginning cash", m.begin === null ? "" : Math.round(m.begin), m.begin === null ? "" : Math.round(m.begin)]];
    for (const b of [m.in, m.out]) { rows.push([b.kind === "in" ? "Cash inflows" : "Cash outflows"]);
      for (const r of b.rows.filter((q) => q.lines.length || q.plan || q.actual || q.next)) rows.push(["   " + r.label, Math.round(r.plan), Math.round(r.actual), Math.round(r.actual - r.plan), r.plan ? Math.round((r.actual / r.plan) * 100) / 100 : "", Math.round(r.next)]);
      rows.push([b.kind === "in" ? "Total cash inflows" : "Total cash outflows", Math.round(b.plan), Math.round(b.actual), Math.round(b.actual - b.plan), b.plan ? Math.round((b.actual / b.plan) * 100) / 100 : "", Math.round(b.next)]);
      if (b.kind === "in") rows.push(["Available cash", Math.round((m.begin || 0) + m.in.plan), Math.round((m.begin || 0) + m.in.actual)]); }
    rows.push(["Ending cash", Math.round(m.endPlan), Math.round(m.endActual), Math.round(m.endActual - m.endPlan)]); if (m.endBank !== null) rows.push(["Bank balance at the end (bank report)", "", Math.round(m.endBank)]); return rows;
  }
  async function download(kind) {
    if (!c.libsReady("xlsx")) return; const X = c.XLSX(), wb = X.utils.book_new(), units = h.scopeUnits(), W = S.wk, to = S.day, from = addDays(to, -29);
    if (kind === "week") {
      for (const u of units) { const m = buildStmt([u], W); sheet(X, wb, stmtRows(m, `${h.uname(u)} · weekly cash flow · ${weekLabel(W)}`), [42, 16, 16, 16, 8, 18], h.ushort(u));
        const ls = [["Code", "Collect or pay", "Cash flow row", "Customer or payee", "Description", "Invoice no", "Due", "Currency", "Rate", "Planned (ETB)", "Actual (ETB)", "Rolled", "Remark"]]; for (const b of [m.in, m.out]) for (const r of b.rows) for (const l of r.lines) ls.push([(l.it && l.it.code) || "", l.kind === "in" ? "Collect" : "Pay", l.stmt, l.party, l.description, (l.it && l.it.ref) || l.w.ref || "", l.due || "", l.cur, l.cur === "USD" ? l.rate : "", Math.round(l.plan), Math.round(l.actual), l.w.rolled ? "Yes" : "", l.remark]);
        sheet(X, wb, ls, [12, 12, 30, 30, 34, 16, 12, 9, 8, 16, 16, 8, 30], h.ushort(u) + " lines"); }
      await c.writeXlsx(wb, `Weekly cash flow ${W}.xlsx`, "Excel saved"); return; }
    if (kind === "history") {
      const rows = [["Week", "Unit", "Code", "Collect or pay", "Cash flow row", "Customer or payee", "Description", "Invoice no", "Currency", "Rate", "Planned", "Actual", "Left at the end", "Rolled", "Due", "Remark", "Source"]]; const items = new Map(S.itemsAll.map((i) => [i.id, i]));
      S.week.filter((w) => units.includes(w.unit)).sort((a, b) => a.week.localeCompare(b.week) || a.unit.localeCompare(b.unit)).forEach((w) => { const it = w.itemId ? items.get(w.itemId) : null; const E = weekEnd(w.week);
        rows.push([w.week, h.uname(w.unit), (it && it.code) || w.itemCode || "", w.kind === "in" ? "Collect" : "Pay", stmtOf(w, it), w.party || (it && it.party) || "", w.description || (it && it.description) || "", w.ref || (it && it.ref) || "", w.currency || "ETB", w.rate || "", Math.round(num(w.planned)), it && movedIn(S.log, it.id, w.week, E) ? Math.round(movedIn(S.log, it.id, w.week, E)) : w.actual === "" || w.actual == null ? "" : Math.round(num(w.actual)), it ? Math.round(h.viewOf(it, E).left) : "", w.rolled ? "Yes" : "", w.due || "", w.remark || w.note || "", w.source || ""]); });
      sheet(X, wb, rows, [12, 26, 12, 12, 28, 32, 34, 16, 9, 8, 16, 16, 16, 8, 12, 30, 30], "Weekly plan history"); await c.writeXlsx(wb, `Weekly plan history ${to}.xlsx`, "Excel saved"); return; }
    if (kind === "recon") {
      const rows = [["Day", "Unit", "Bank", "Bank in", "Collections recorded", "Difference in", "Bank out", "Payments recorded", "Difference out", "Check"]];
      reconRows(units, addDays(to, -(S.rc.range - 1)), to).rows.forEach((x) => rows.push([x.day, h.uname(x.unit), x.bank, Math.round(x.bank_in), Math.round(x.m_in), x.diff_in === undefined ? "" : Math.round(x.diff_in), Math.round(x.bank_out), Math.round(x.m_out), x.diff_out === undefined ? "" : Math.round(x.diff_out), x.flags.length ? x.flags.join("; ") : "OK"]));
      sheet(X, wb, rows, [12, 26, 24, 16, 18, 16, 16, 18, 16, 60], "Reconciliation"); await c.writeXlsx(wb, `Cash reconciliation ${to}.xlsx`, "Excel saved"); return; }
    if (kind === "summary") {
      const rows = [["Business unit", "Cash at the start", "Collect left", "Pay left", "Collected that day", "Paid that day", "Cash at the end (bank)"]], items = S.items;
      for (const u of units) { const vs = items.filter((i) => i.unit === u).map((i) => ({ i, v: h.viewOf(i, to) })).filter((o) => o.v.exists); const f = (k, g) => Math.round(sum(vs.filter((o) => o.i.kind === k), (o) => num(g(o)) * rateOf(o.i, h.fx())));
        rows.push([h.uname(u), Math.round(cashAt([u], addDays(to, -1))), f("in", (o) => o.v.left), f("out", (o) => o.v.left), f("in", (o) => o.v.onDay), f("out", (o) => o.v.onDay), Math.round(cashAt([u], to))]); }
      rows.push(["Total", ...[1, 2, 3, 4, 5, 6].map((i) => sum(rows.slice(1), (r) => r[i]))]);
      sheet(X, wb, [[`Cash flow summary as at ${dShort(to)}`], [], ...rows], [34, 18, 16, 16, 18, 18, 22], "Summary"); await c.writeXlsx(wb, `Cash flow summary ${to}.xlsx`, "Excel saved"); }
  }

  // ---------------- Excel template: the weekly plan ----------------
  const short = (u) => h.ushort(u).replace(/[\\/*?:[\]]/g, "");
  async function weekTemplate() {
    const units = h.scopeUnits().filter((u) => h.canWrite(u)); if (!units.length) { c.toast("You can only download the template for a unit you can edit"); return; }
    const W = S.wk, E = weekEnd(W), types = S.types.filter((t) => t.active).map((t) => t.code);
    const wb = await XL.newBook(c, (col) => { col(1, ["Collect", "Pay"], "L_Kind"); col(2, STMT.map((s) => s[2]), "L_Row"); col(3, types.length ? types : [""], "L_Type"); col(4, ["1", "2", "3"], "L_Urg"); col(5, CURRENCIES, "L_Cur"); }); if (!wb) return;
    for (const u of units) {
      const nm = short(u), det = wb.addWorksheet(`${nm} Detail`.slice(0, 31), { views: [{ state: "frozen", ySplit: 4 }] }), st = wb.addWorksheet(`${nm} Plan`.slice(0, 31), { views: [{ showGridLines: false }] });
      const m = buildStmt([u], W), pre = [...m.in.rows, ...m.out.rows].flatMap((r) => r.lines);
      const rows = pre.length ? pre.map((l) => ({ it: l.it, wl: l, row: l.stmt, planned: Math.round((l.plan / (l.rate || 1)) * 100) / 100, rate: l.rate, due: l.due, remark: l.remark })) : m.cand.map((x) => ({ it: x.it, row: stmtDefault(x.it.kind, x.it.section), planned: Math.round(x.left * 100) / 100, rate: x.it.currency === "USD" ? h.fx() : "", due: x.it.expected, remark: "" }));
      det.getCell("A1").value = "Week starting (Monday)"; det.getCell("B1").value = XL.toDate(W); det.getCell("B1").numFmt = "yyyy-mm-dd"; det.getCell("A2").value = "Business unit"; det.getCell("B2").value = h.uname(u); XL.bold(det.getCell("A1")); XL.bold(det.getCell("A2"));
      det.getCell("D1").value = `${weekLabel(W)}. Planned this week = what you expect to collect or pay in this week. Code links the line to the daily sheet: leave it empty for a new line.`;
      XL.head(det, 4, ["Code", "Collect or pay", "Cash flow row", "Customer or payee", "Invoice no", "Description", "Type", "Cat (1, 2, 3)", "Due date", "Currency", "Rate (ETB per USD)", "Planned this week", "Remark", "Planned in ETB"], [13, 12, 28, 30, 16, 34, 14, 9, 12, 9, 12, 16, 28, 16]);
      rows.forEach((x, k) => { const r = 5 + k, it = x.it || { code: "", kind: x.wl.kind, party: x.wl.party, ref: x.wl.w.ref, description: x.wl.description, typeCode: "", bucket: "", currency: x.wl.cur }; [it.code, it.kind === "in" ? "Collect" : "Pay", x.row, it.party, it.ref, it.description, it.typeCode, it.bucket, XL.toDate(x.due), it.currency, it.currency === "USD" ? x.rate : "", x.planned, x.remark].forEach((val, i) => { det.getCell(r, i + 1).value = val; }); XL.fill(det.getCell(r, 1), XL.GREY); });
      const last = Math.max(5 + rows.length + 100, 300);
      for (let r = 5; r <= last; r++) { det.getCell(r, 14).value = { formula: `IF(L${r}="","",IF(J${r}="USD",L${r}*K${r},L${r}))` }; det.getCell(r, 14).numFmt = "#,##0.00"; XL.fill(det.getCell(r, 14), XL.GREY); }
      XL.listV(det, 2, 5, last, "L_Kind", "Pick Collect or Pay."); XL.listV(det, 3, 5, last, "L_Row", "Pick a row of the cash flow from the list."); XL.listV(det, 7, 5, last, "L_Type", "Pick a type. New types are added in the app under Setup."); XL.listV(det, 8, 5, last, "L_Urg", "Pick 1, 2 or 3."); XL.listV(det, 10, 5, last, "L_Cur", "Pick ETB or USD.");
      XL.dateV(det, 9, 5, last); XL.numV(det, 11, 5, last, 0); XL.numV(det, 12, 5, last, 0);
      // the statement, the same rows every unit already uses; each row adds up the Detail sheet
      st.getColumn(1).width = 44; st.getColumn(2).width = 20; st.getColumn(3).width = 36;
      st.getCell("A1").value = h.uname(u).toUpperCase(); st.getCell("A2").value = "CASH FLOW PROJECTION"; st.getCell("A3").value = "WEEKLY"; st.getCell("A4").value = `FROM ${dShort(W)} TO ${dShort(E)}`; ["A1", "A2", "A3", "A4"].forEach((a) => XL.bold(st.getCell(a)));
      XL.head(st, 6, ["DESCRIPTION", "PLAN", "REMARK"]); let r = 7; const dn = `'${det.name}'`, sumif = (k, label) => `SUMIFS(${dn}!$N$5:$N$${last},${dn}!$B$5:$B$${last},"${k}",${dn}!$C$5:$C$${last},"${label}")`;
      st.getCell(r, 1).value = "Beginning Cash Balance"; st.getCell(r, 2).value = Math.round(cashAt([u], addDays(W, -1)) * 100) / 100; XL.bold(st.getCell(r, 1)); const begin = r; r += 2;
      const put = (label, formula, boldRow) => { st.getCell(r, 1).value = label; if (formula) { st.getCell(r, 2).value = { formula }; st.getCell(r, 2).numFmt = "#,##0.00"; } if (boldRow) { XL.bold(st.getCell(r, 1)); XL.bold(st.getCell(r, 2)); } r++; return r - 1; };
      const inRows = []; put("Cash Inflows (Income)", null, true);
      for (const sec of ["operating", "investing", "financing"]) { put(STMT_GROUP[sec], null, true); for (const s of STMT.filter((q) => q[0] === "in" && q[1] === sec)) inRows.push(put("       " + s[2], sumif("Collect", s[2]))); r++; }
      const tin = put("          Total Cash inflows", `SUM(${inRows.map((x) => "B" + x).join(",")})`, true), avail = put("Available Cash Balance", `B${begin}+B${tin}`, true);
      const outRows = []; put("Cash Outflows (Expenses)", null, true);
      for (const sec of ["operating", "investing", "financing"]) { put(STMT_GROUP[sec].replace("from ", ""), null, true); for (const s of STMT.filter((q) => q[0] === "out" && q[1] === sec)) outRows.push(put("       " + s[2], sumif("Pay", s[2]))); r++; }
      const tout = put("            Total Cash Outflows", `SUM(${outRows.map((x) => "B" + x).join(",")})`, true); put("Ending Cash Balance", `B${avail}-B${tout}`, true);
      st.getCell(`C${begin}`).value = "From the bank balance the day before. Change it if needed."; st.getCell(`C${begin}`).font = { italic: true, color: { argb: "FF777777" } };
    }
    XL.infoSheet(wb, "How to fill in the weekly plan", ["One row per line you expect to collect or pay this week, on the Detail sheet. Lines still open from earlier weeks are already there with what is left.", "Planned this week is what you expect to move in the week. It can be less than the whole amount owed.",
      "Code links the line to the daily collections and payments. Keep it. Leave it empty for a new line; the app gives it a code when you upload.", "Cash flow row says where the line sits in the weekly cash flow (credit collection, operating activities, loan repayment...). The Plan sheet adds the rows up, as in your usual statement.",
      "For a USD line, write the exchange rate you expect for this week. It is kept with this week only, so earlier weeks never change.", "Upload never deletes a line. To take a line out of the week, do it in the app. Upload the file on the Weekly plan page."]);
    await c.saveFile(`Weekly plan ${W}.xlsx`, await wb.xlsx.writeBuffer(), "Excel saved");
  }

  // ---------------- upload: the weekly plan ----------------
  const unitMap = (units) => { const m = new Map(); units.forEach((u) => [h.uname(u), h.ushort(u), c.unitName(u), u].forEach((n) => m.set(XL.norm(n), u))); if (units.includes("wagwago-electric")) m.set("wagwago trading", "wagwago-electric"); return m; };
  function report(rep, title) {
    const lines = Object.values(rep.counts).filter(Boolean); if (rep.skip) lines.push(`<b>${rep.skip}</b> row${rep.skip > 1 ? "s were" : " was"} not saved. Fix ${rep.skip > 1 ? "them" : "it"} in the file and upload again.`); if (!lines.length) lines.push("Nothing was found to save. Use the template from this page and keep its sheet names.");
    S.m = { type: "result", title, lines, notes: rep.notes }; h.drawModal();
  }
  async function uploadWeek(file) {
    const units = h.writableUnits(); if (!units.length) { c.toast("You cannot edit any unit's cash flow"); return; } const bk = await XL.readBook(c, file); if (!bk) return; const { X, wb } = bk;
    const uMap = unitMap(units), tMap = new Map(S.types.map((t) => [XL.norm(t.code), t.code])), rowMap = new Map(STMT.map((s) => [XL.norm(s[2]) + "|" + s[0], s[2]])), rep = { counts: {}, skip: 0, notes: [] };
    const bad = (sheet, line, why) => { rep.skip++; rep.notes.push(`${sheet} row ${line}: ${why}`); }; let added = 0, upd = 0, planned = 0, same = 0, replaced = 0; const undo = [];
    const sheets = XL.readSheets(X, wb, /detail$/i); if (!sheets.length) { c.toast("No “… Detail” sheet found. Use the template from Download template for this week."); return; }
    await h.run(async () => {
      for (const sh of sheets) {
        const unit = uMap.get(XL.norm(sh.rows[1] && sh.rows[1][1])), wk = XL.serialToIso(sh.rows[0] && sh.rows[0][1]);
        if (!unit) { bad(sh.name, 2, `unit “${sh.rows[1] && sh.rows[1][1]}” not found or not yours`); continue; } if (!wk) { bad(sh.name, 1, "the week (cell B1) is missing or not a date"); continue; }
        const W = weekStart(wk);
        for (let i = 4; i < sh.rows.length; i++) { const r = sh.rows[i], line = i + 1; if (!r.some((x) => String(x).trim() !== "")) continue;
          const [code, kindN, rowN, party, ref, desc, typeN, urg, due, cur, rate, plan, remark] = r;
          const old = String(code).trim() ? S.items.find((q) => q.code && q.code.toUpperCase() === String(code).trim().toUpperCase() && q.unit === unit) : null;
          if (String(code).trim() && !old) { bad(sh.name, line, `no line with code ${code} for this unit`); continue; }
          const p = XL.money(plan); if (p === null || p <= 0) { if (old) continue; bad(sh.name, line, "Planned this week is empty or zero"); continue; }
          const kind = old ? old.kind : /^c/i.test(String(kindN).trim()) ? "in" : /^p/i.test(String(kindN).trim()) ? "out" : ""; if (!kind) { bad(sh.name, line, "Collect or pay is empty"); continue; }
          if (!String(party).trim() && !String(desc).trim() && !old) { bad(sh.name, line, "customer or payee and description are both empty"); continue; }
          const stmt = rowMap.get(XL.norm(rowN) + "|" + kind) || stmtDefault(kind, old ? old.section : "operating"), section = stmtSection(stmt), b = XL.bucketOf(urg) || (old ? old.bucket : 1), dueIso = XL.serialToIso(due);
          const currency = CURRENCIES.includes(String(cur).trim().toUpperCase()) ? String(cur).trim().toUpperCase() : old ? old.currency : "ETB", rt = XL.money(rate);
          if (currency === "USD" && !(rt > 0)) { bad(sh.name, line, "USD line without an exchange rate"); continue; }
          const typeCode = String(typeN).trim() ? tMap.get(XL.norm(typeN)) || "" : old ? old.typeCode : ""; if (String(typeN).trim() && !tMap.get(XL.norm(typeN))) rep.notes.push(`${sh.name} row ${line}: type “${typeN}” is not in the list, left without a type`);
          let item = old; if (!item) item = S.items.find((q) => q.unit === unit && q.kind === kind && q.status === "open" && XL.norm(q.party) === XL.norm(party) && XL.norm(q.ref) === XL.norm(ref) && XL.norm(q.description) === XL.norm(desc) && (String(party).trim() || String(desc).trim()));   // the same line uploaded again
          let itemId = item && item.id;
          if (!item) { const res = await c.api().saveCfItem(A(), { unit, kind, party: String(party).trim(), description: String(desc).trim(), ref: String(ref).trim(), typeCode, bucket: b, amount: p, total: p, currency, priority: "Normal", expected: dueIso, status: "open", enteredOn: c.todayIso, section, firstWeek: W, note: "" });
            if (res && res.error) return res; itemId = res.id; added++; undo.push(() => c.api().deleteCf(A(), "cf_items", res.id)); }
          else { const ch = { party: String(party).trim() || item.party, description: String(desc).trim() || item.description, ref: String(ref).trim() || item.ref, typeCode: typeCode || item.typeCode, bucket: b, section, expected: dueIso || item.expected };
            if (Object.entries(ch).some(([k, val]) => (item[k] || "") !== val)) { const before = h.itemRow(item); const res = await c.api().saveCfItem(A(), h.itemRow({ ...item, ...ch })); if (res && res.error) return res; upd++; undo.push(() => c.api().saveCfItem(A(), before)); } }
          // already planned this week with the same values: nothing to do. A history line of the same name in this week is replaced, not added to.
          const here = S.week.find((q) => q.itemId === itemId && q.week === W && q.unit === unit), nameKey = `${String(party)} ${String(desc)}`, twin = !here && S.week.find((q) => !q.itemId && q.unit === unit && q.week === W && q.kind === kind && (sim(wText(q), nameKey) >= 0.6 || (!nameKey.trim() && Math.abs(num(q.planned) - p) < 1)));
          if (here && Math.abs(num(here.planned) - p) < 0.005 && here.stmt === stmt && num(here.rate) === (currency === "USD" ? rt : 0)) { same++; continue; }
          const res = await c.api().saveCfWeek(A(), { unit, week: W, itemId, planned: p, due: dueIso, rolled: here ? here.rolled : false, note: "", stmt, section, currency, rate: currency === "USD" ? rt : "", remark: String(remark).trim(), party: String(party).trim(), description: String(desc).trim(), actual: twin && twin.actual != null ? twin.actual : "" }); if (res && res.error) return res; { const prev = here ? weekRow(here) : null, nid = res.id; undo.push(() => (prev ? c.api().saveCfWeek(A(), prev) : c.api().deleteCf(A(), "cf_week_lines", nid))); } if (twin) { const old = weekRow(twin), d = await c.api().deleteCf(A(), "cf_week_lines", twin.id); if (d && d.error) return d; replaced++; undo.push(() => c.api().saveCfWeek(A(), old)); } planned++;
        }
      }
      return { ok: true };
    });
    rep.counts.a = planned ? `Weekly plan: <b>${planned}</b> line${planned > 1 ? "s" : ""} saved (<b>${added}</b> new line${added === 1 ? "" : "s"}, <b>${upd}</b> existing line${upd === 1 ? "" : "s"} changed${replaced ? `, <b>${replaced}</b> replaced an imported line of the same name` : ""}).` : ""; rep.counts.b = same ? `<b>${same}</b> line${same > 1 ? "s were" : " was"} already in the plan with the same amount, left as they are.` : ""; if (undo.length) S.uu = { label: "The weekly upload", steps: undo }; report(rep, "Upload finished");
  }

  // ---------------- actions ----------------
  async function onAction(el) {
    const x = el.dataset.cf, id = el.dataset.id;
    if (x === "w-shift") { S.wk = addDays(S.wk, Number(el.dataset.v)); c.render(); }
    else if (x === "w-thisweek") { S.wk = weekStart(c.todayIso); c.render(); }
    else if (x === "w-x") { (S.wx || (S.wx = {}))[el.dataset.key] = !S.wx[el.dataset.key]; c.render(); }
    else if (x === "w-cand") { S.wcand = !S.wcand; c.render(); }
    else if (x === "w-new") { if (!h.writableUnits().length) return; S.m = { type: "weekline", isNew: true, row: blankLine("in") }; h.drawModal(); }
    else if (x === "w-edit") { const w = S.week.find((q) => q.id === id), it = w && w.itemId ? S.items.find((q) => q.id === w.itemId) : null; if (!w || (w.itemId && !it)) return;
      S.m = { type: "weekline", isNew: false, row: { weekId: w.id, itemId: it ? it.id : "", noItem: !it, code: it ? it.code : w.itemCode, rolled: w.rolled, unit: w.unit, kind: w.kind, stmt: w.stmt, section: w.section, party: w.party || (it && it.party) || "", ref: w.ref || (it && it.ref) || "", description: w.description || (it && it.description) || "", typeCode: it ? it.typeCode : "", bucket: it ? it.bucket : 1, due: w.due || (it && it.expected) || "", planned: w.planned, currency: w.currency || (it && it.currency) || "ETB", rate: w.rate, note: w.note, remark: w.remark } }; h.drawModal(); }
    else if (x === "w-save") await saveLine();
    else if (x === "w-remove") { const w = S.week.find((q) => q.id === id); if (!w) return; await h.run(() => c.api().deleteCf(A(), "cf_week_lines", id), "Taken out of this week"); }
    else if (x === "w-roll-all") await rollIn(buildStmt(h.scopeUnits(), S.wk).cand);
    else if (x === "w-roll-one") await rollIn(buildStmt(h.scopeUnits(), S.wk).cand.filter((q) => q.it.id === id));
    else if (x === "w-undo-up") await undoUpload();
    else if (x === "w-undo-x") { S.uu = null; c.render(); }
    else if (x === "w-dup") { S.m = { type: "clean", mode: "dup" }; h.drawModal(); }
    else if (x === "w-clear") { S.m = { type: "clean", mode: "clear" }; h.drawModal(); }
    else if (x === "w-dup-go") await cleanGo("dup");
    else if (x === "w-clear-go") await cleanGo("clear");
    else if (x === "w-link") { S.m = { type: "linkline", weekId: id }; h.drawModal(); }
    else if (x === "w-link-save") await onLinkSave(false);
    else if (x === "w-link-new") await onLinkSave(true);
    else if (x === "w-trace") { S.m = { type: "trace", itemId: id }; h.drawModal(); }
    else if (x === "w-xl-down") await weekTemplate();
    else if (x === "w-pick-week") { const i = document.getElementById("cwUploadWeek"); if (i) i.click(); }
    else if (x === "w-dl") await download(el.dataset.v);
    else if (x === "w-pdf") await weekPdf();
    else if (x === "w-rcrange") { S.rc.range = Number(el.dataset.v); c.render(); }
    else if (x === "w-rcall") { S.rc.all = el.dataset.v === "1"; c.render(); }
    else if (x === "w-goday") { S.scope = el.dataset.unit || S.scope; S.view = "coll"; h.setDay(el.dataset.day); }
  }
  return { renderWeek, renderReconcile, lineForm, traceView, linkForm, cleanView, onAction, onModalChange, uploadWeek, download, weekStart, buildStmt };
}
