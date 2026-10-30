// Cash flow, Collections & payments. Three tabs:
//   Plan    what is planned, by month step (1, 2, 3): collections on the left, payments on the right, folded by category.
//   Actual  the week, Monday to Saturday: what was collected and paid each day, with the bank. Collections on top, payments below.
//   Status  what is left as of the chosen day, the simple view used for next week's plan. Downloads and re-uploads as an Excel sheet.
// Everything is written to the same lines and daily log as the rest of Cash flow.
import { bucketCode, num, sum, addDays, MONTHS, etb, rateOf, countsIn, weekStart, weekEnd, weekDays, weekLabel, DAYN } from "./cashcalc.js";
import * as XL from "./cashxl.js";

const BUCKET_NAME = { 1: "Within one month (this month)", 2: "Within two months (next month)", 3: "Within three months (the month after), long term" };
const dShort = (iso) => { if (!iso) return ""; const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const dMini = (iso) => { const [, m, d] = String(iso).slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]}`; };
const dayHead = (iso, k) => `${DAYN[k]} ${Number(String(iso).slice(8, 10))}`;
const clip = (t, n) => { t = String(t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

export function createSheet(h) {
  const { S, c, esc, A } = h, plain = h.plain, fx = h.fx;
  const K = () => S.ck || (S.ck = { tab: "plan", wk: weekStart(c.todayIso), wkFor: "", open: {}, all: false, q: "", kd: {}, kb: {}, fold: {}, pn: null, pd: null, pwarn: false, nf: null, dn: { range: "month", from: "", to: "", by: "day" } });
  const isOpen = (key) => (key in K().open ? K().open[key] : K().all);
  const conv = (it, v) => num(v) * rateOf(it, fx());
  const catOf = (it) => it.typeCode || "No category";
  const catLabel = (cat) => { const t = h.typeByCode(cat); return t && t.label && t.label !== t.code ? `${cat} · ${t.label}` : cat; };
  const lineText = (it) => `${it.code} ${it.party} ${it.description} ${it.ref} ${it.typeCode}`.toLowerCase();
  const writable = () => h.writableUnits().length > 0;
  const cur = (it) => (it.currency && it.currency !== "ETB" ? ` <span class="tag">${esc(it.currency)}</span>` : "");
  const unitTag = (it, many) => (many ? `<span class="small muted"> · ${esc(h.ushort(it.unit))}</span>` : "");

  // lines of the current view: open at the chosen day, in the chosen units, counted, matching the search
  function openLines(units, D) {
    const q = K().q.trim().toLowerCase(), ty = h.typesEff(); let skipped = 0; const list = [];
    for (const it of S.items) {
      if (!units.includes(it.unit)) continue; const v = h.viewOf(it, D); if (!v.exists || !v.open) continue;
      if (q && !lineText(it).includes(q)) continue;
      if (!countsIn(it, ty, false)) { skipped++; continue; }
      list.push({ it, v });
    }
    return { list, skipped };
  }
  const allOpen = (u, D) => S.items.filter((it) => it.unit === u).map((it) => ({ it, v: h.viewOf(it, D) })).filter(({ v }) => v.exists && v.open);
  const groups = (list, f, amt) => { const m = new Map(); list.forEach((x) => { const k = f(x); (m.get(k) || m.set(k, []).get(k)).push(x); }); return [...m.entries()].sort((a, b) => sum(b[1], amt) - sum(a[1], amt)); };

  // ---------------- shell ----------------
  function renderColl() {
    const k = K(), tabs = [["plan", "Plan"], ["actual", "Actual"], ["done", "Collected & paid"], ["status", "Status"]];
    if (k.wkFor !== S.day) { k.wk = weekStart(S.day); k.wkFor = S.day; }
    const nav = `<div class="cf-ktabs" role="tablist">${tabs.map((t) => `<button class="cf-ktab${k.tab === t[0] ? " on" : ""}" role="tab" aria-selected="${k.tab === t[0]}" data-cf="k-tab" data-v="${t[0]}">${t[1]}</button>`).join("")}<span class="small muted cf-khint">${k.tab === "plan" ? "What is planned, by month" : k.tab === "actual" ? "What came in and went out, day by day" : k.tab === "done" ? "Everything collected and paid, and when" : "What is left to collect and pay, as of the day chosen above"}</span></div>`;
    return `<div class="cf-body">${nav}${{ plan: renderPlan, actual: renderActual, done: renderDone, status: renderStatus }[k.tab]()}</div>`;
  }
  const bar = (right) => `<div class="cf-bar">${h.allUnits().length > 1 ? h.unitSel(S.scope) : ""}<input type="search" data-kq="1" placeholder="Search" value="${esc(K().q)}" aria-label="Search" class="cf-s">${right || ""}</div>`;
const addPlan = () => (writable() ? `<div class="cf-addplan"><button type="button" class="btn primary" data-cf="k-pick" data-v="status">+ Add weekly plan</button><span class="small muted">Upload the plan for the coming week: an Excel sheet with collections and payments, by month. New lines are added, changed amounts are updated and lines marked DROP are taken off.</span><button type="button" class="btn small" data-cf="k-dl" data-v="status">Download the sheet to fill in</button><input type="file" id="ckUploadSt" accept=".xlsx,.xls" hidden></div>` : "");
  const skippedNote = (n) => (n ? `<div class="small muted">${n} line${n > 1 ? "s" : ""} left out because their category is switched off on the Summary page.</div>` : "");

  // ---------------- Plan ----------------
  function sidePlan(kind, b, items, many) {
    const tot = sum(items, (x) => conv(x.it, x.it.amount)), title = kind === "in" ? "Collections" : "Payments";
    const gs = groups(items, (x) => catOf(x.it), (x) => conv(x.it, x.it.amount));
    const body = gs.map(([cat, ls]) => { const key = `plan|${b}|${kind}|${cat}`, o = isOpen(key);
      return `<tr class="cf-row clickable cf-g1" data-cf="k-x" data-key="${esc(key)}" tabindex="0"><td colspan="2"><span class="cf-caret">${o ? "▾" : "▸"}</span> <b>${esc(catLabel(cat))}</b> <span class="small muted">${ls.length}</span></td><td class="num"><b>${plain(sum(ls, (x) => conv(x.it, x.it.amount)))}</b></td></tr>`
        + (o ? ls.slice().sort((p, q) => conv(q.it, q.it.amount) - conv(p.it, p.it.amount)).map(({ it }) => `<tr class="cf-sub"><td>${esc(it.party || it.description || "")}${cur(it)}${unitTag(it, many)}</td><td class="small">${esc(it.party ? it.description : "")}</td><td class="num">${plain(it.amount)}</td></tr>`).join("") : ""); }).join("");
    return `<div class="cf-side"><div class="cf-side-h"><span><b>${title}</b> <span class="small muted">${bucketCode(kind, b)}</span></span><b>${plain(tot)}</b></div>${gs.length ? `<div class="scroll"><table class="cf-table cf-mini"><thead><tr><th>Customer</th><th>Description</th><th>Amount</th></tr></thead><tbody>${body}<tr class="tot"><td colspan="2">Total</td><td class="num">${plain(tot)}</td></tr></tbody></table></div>` : `<div class="small muted cf-pad">Nothing planned.</div>`}</div>`;
  }
  function renderPlan() {
    const units = h.scopeUnits(), many = units.length > 1, { list, skipped } = openLines(units, S.day), k = K();
    const box = (b) => { const ls = list.filter((x) => x.it.bucket === b), inn = ls.filter((x) => x.it.kind === "in"), out = ls.filter((x) => x.it.kind === "out");
      const ti = sum(inn, (x) => conv(x.it, x.it.amount)), to = sum(out, (x) => conv(x.it, x.it.amount));
      return `<section class="cf-card cf-mbox"><div class="cf-split"><h3>${BUCKET_NAME[b]} <span class="small muted">${b} / ${b}${b}</span></h3><span class="small">To collect <b class="ok">${plain(ti)}</b> · To pay <b class="neg">${plain(to)}</b> · Net <b class="${ti - to < 0 ? "neg" : ""}">${plain(ti - to)}</b></span></div>
        <div class="cf-two">${sidePlan("in", b, inn, many)}${sidePlan("out", b, out, many)}</div></section>`; };
    return `${bar(`<span class="cf-group"><button class="btn small" data-cf="k-all" data-v="1">Open all</button><button class="btn small" data-cf="k-all" data-v="0">Fold all</button></span><span class="cf-right"><button class="btn small" data-cf="k-pdf" data-v="plan">Download PDF</button></span>`)}
      <div class="small muted">The plan as of <b>${esc(dShort(S.day))}</b>: lines still open, by month step. Open a category to see its lines.</div>${addPlan()}${skippedNote(skipped)}${h.usdWarn()}${[1, 2, 3].map(box).join("")}`;
  }


  // ---------------- planned and unplanned cash of the week ----------------
  function pvu(units, W, rows) {
    const E = weekEnd(W), loose = S.log.filter((l) => units.includes(l.unit) && l.day >= W && l.day <= E && !l.itemId);
    const one = (kind, title) => { const rs = rows.filter((r) => r.it.kind === kind), pl = rs.filter((r) => !r.it.unplanned), up = rs.filter((r) => r.it.unplanned), lo = loose.filter((l) => l.kind === kind);
      const planned = sum(pl, (r) => conv(r.it, r.planned)), done = sum(pl, (r) => conv(r.it, r.coll)), u = sum(up, (r) => conv(r.it, r.coll)), n = sum(lo, (l) => conv(l, l.amount)), all = done + u + n;
      return `<tr><td><b>${title}</b></td><td class="num">${plain(planned)}</td><td class="num">${plain(done)}</td><td class="num small">${planned ? Math.round((done / planned) * 100) + "%" : ""}</td><td class="num">${u ? plain(u) : '<span class="muted">–</span>'}<div class="small muted">${up.length ? up.length + " line" + (up.length > 1 ? "s" : "") : ""}</div></td><td class="num">${n ? plain(n) : '<span class="muted">–</span>'}<div class="small muted">${lo.length ? lo.length + " entr" + (lo.length > 1 ? "ies" : "y") : ""}</div></td><td class="num"><b>${plain(all)}</b></td><td class="num small">${all ? Math.round(((u + n) / all) * 100) + "%" : ""}</td></tr>`; };
    return `<section class="cf-card"><div class="cf-split"><h3>Planned and unplanned, this week</h3><span class="small muted">Unplanned is cash on a line added in the week, or cash with no line.</span></div><div class="scroll"><table class="cf-table"><thead><tr><th></th><th class="num">Planned</th><th class="num">Done on planned lines</th><th class="num">%</th><th class="num">Unplanned lines</th><th class="num">Cash with no line</th><th class="num">All cash</th><th class="num" title="Share of all cash that was not planned">Unplanned share</th></tr></thead><tbody>${one("in", "Collections")}${one("out", "Payments")}</tbody></table></div></section>`;
  }

  // ---------------- a new line, from the right (cash that was not in the plan) ----------------
  const readNew = () => { const o = {}; document.querySelectorAll(".cf-drawer [data-nl]").forEach((e) => { o[e.dataset.nl] = e.value; }); return o; };
  const newDirty = () => { if (K().pn !== "__new" || !document.querySelector(".cf-drawer")) return false; const f = readNew(); return !!(String(f.party || "").trim() || String(f.desc || "").trim() || num(f.amt) > 0 || num(f.total) > 0); };
  const newDrawer = () => {
    const k = K(), f = k.nf || {}, wu = h.writableUnits(), unit = f.unit && wu.includes(f.unit) ? f.unit : wu.includes(S.scope) ? S.scope : wu[0], kind = f.kind || "in", W = k.wk, day = f.day || (c.todayIso >= W && c.todayIso <= addDays(W, 6) ? c.todayIso : W), banks = h.knownBanks(unit), verb = kind === "in" ? "collected" : "paid";
    return `<aside class="cf-drawer" role="dialog" aria-label="Add a line"><div class="cf-dr-h"><div><b>Add a line</b><div class="small muted">For cash that was not in the plan. It is marked <b>Unplanned</b> and counted in the planned and unplanned comparison.</div></div><button type="button" class="btn small" data-cf="k-pclose" aria-label="Close">✕</button></div>
      ${k.pwarn ? `<div class="cf-dr-warn"><b>You have a line that is not saved.</b><span class="small">Save it, or discard it to close.</span><span class="cf-group"><button type="button" class="btn small primary" data-cf="k-nsave">Save</button><button type="button" class="btn small" data-cf="k-pdiscard">Discard</button></span></div>` : ""}
      <div class="cf-dr-b"><div class="xgrid">
        ${h.field("nl-unit", "Business unit", `<select id="nl-unit" data-nl="unit" ${wu.length > 1 ? "" : "disabled"}>${wu.map((u) => `<option value="${esc(u)}" ${u === unit ? "selected" : ""}>${esc(h.uname(u))}</option>`).join("")}</select>`)}
        ${h.field("nl-kind", "Collection or payment", `<select id="nl-kind" data-nl="kind"><option value="in" ${kind === "in" ? "selected" : ""}>Collection (money in)</option><option value="out" ${kind === "out" ? "selected" : ""}>Payment (money out)</option></select>`)}
        ${h.field("nl-party", kind === "in" ? "Customer" : "Payee", `<input type="text" id="nl-party" data-nl="party" value="${esc(f.party || "")}">`)}
        ${h.field("nl-type", "Category", `<select id="nl-type" data-nl="type">${h.typeOptions(kind, f.type || "", false)}</select>`)}
        ${h.field("nl-desc", "Description", `<input type="text" id="nl-desc" data-nl="desc" value="${esc(f.desc || "")}">`, true)}
        ${h.field("nl-day", "Day", `<input type="date" id="nl-day" data-nl="day" value="${esc(day)}">`)}
        ${h.field("nl-bank", "Bank", `<input list="cf-nbanks" id="nl-bank" data-nl="bank" value="${esc(f.bank || h.lastBank(unit, kind) || "")}" placeholder="Pick or type a new one"><datalist id="cf-nbanks">${banks.map((b) => `<option value="${esc(b)}">`).join("")}</datalist>`)}
        ${h.field("nl-amt", "Amount " + verb, `<input type="number" min="0" step="any" id="nl-amt" data-nl="amt" value="${esc(f.amt || "")}">`)}
        ${h.field("nl-total", "Total of the line (optional)", `<input type="number" min="0" step="any" id="nl-total" data-nl="total" value="${esc(f.total || "")}"><div class="small muted">Only if more is still to come. The rest stays open on the line.</div>`)}
      </div></div>
      <div class="cf-dr-f"><span class="cf-right"><button type="button" class="btn" data-cf="k-pclose">Close</button><button type="button" class="btn primary" data-cf="k-nsave">Save</button></span></div></aside>`;
  };
  async function saveNew() {
    const k = K(), f = readNew(), unit = f.unit, kind = f.kind, amt = Math.round(num(f.amt) * 100) / 100, total = Math.max(amt, Math.round(num(f.total) * 100) / 100), bank = String(f.bank || "").trim(), party = String(f.party || "").trim(), desc = String(f.desc || "").trim();
    if (!unit || !h.canWrite(unit)) { c.toast("You cannot add lines to this unit"); return; } if (!party && !desc) { c.toast("Write who it is, or a description"); return; } if (!(amt > 0)) { c.toast("Write the amount"); return; } if (!bank) { c.toast("Choose or type the bank"); return; } if (!f.day) { c.toast("Choose the day"); return; }
    const ok = await h.run(async () => {
      const full = amt >= total - 0.005;
      const r = await c.api().saveCfItem(A(), h.itemRow({ unit, kind, party, description: desc, ref: "", typeCode: f.type || "", bucket: 1, amount: total, total: "", currency: "ETB", priority: "Normal", expected: "", status: full ? "settled" : "open", settledOn: full ? f.day : "", note: "Added in Collections & payments, not in the plan", enteredOn: f.day, section: "operating", unplanned: true, firstWeek: "" })); if (r && r.error) return r;
      const l = await c.api().saveCfLog(A(), h.logRow({ unit, day: f.day, kind, bank, amount: amt, currency: "ETB", party, description: desc, typeCode: f.type || "", itemId: r.id, itemCode: "", note: "", fxRate: "" })); if (l && l.error) return l;
      return { ok: true }; }, "Line added");
    if (ok) { k.pn = null; k.nf = null; k.pwarn = false; k.wk = weekStart(f.day); c.render(); }
  }

  // ---------------- Collected & paid: what moved, and when ----------------
  const doneRange = () => { const d = K().dn, t = c.todayIso; if (d.range === "week") return [weekStart(t), t]; if (d.range === "month") return [t.slice(0, 8) + "01", t]; if (d.range === "30") return [addDays(t, -29), t]; return [d.from || addDays(t, -29), d.to || t]; };
  function doneRows(units) {
    const [from, to] = doneRange(), q = K().q.trim().toLowerCase(), items = new Map(S.items.map((i) => [i.id, i]));
    return S.log.filter((l) => units.includes(l.unit) && l.day >= from && l.day <= to && (!q || `${l.party} ${l.description} ${l.itemCode} ${l.bank} ${l.typeCode}`.toLowerCase().includes(q)))
      .map((l) => { const it = l.itemId ? items.get(l.itemId) : null; return { l, it, code: (it && it.code) || l.itemCode || "", party: l.party || (it && it.party) || "", desc: l.description || (it && it.description) || "", cat: l.typeCode || (it && it.typeCode) || "", left: it ? h.viewOf(it, c.todayIso).left : null, amt: conv(l, l.amount) }; })
      .sort((a, b) => b.l.day.localeCompare(a.l.day) || b.amt - a.amt);
  }
  function doneBlock(kind, rows, many) {
    const k = K(), by = k.dn.by, title = kind === "in" ? "Collected" : "Paid", key = "done-" + kind, tot = sum(rows, (r) => r.amt), open = !k.fold[key];
    const line = (r, showDay) => `<tr class="cf-sub"><td class="small">${showDay ? esc(dShort(r.l.day)) : ""}</td><td>${r.code ? `<span class="tag">${esc(r.code)}</span>` : '<span class="small muted">no line</span>'}</td><td><b>${esc(r.party || r.desc)}</b>${r.party && r.desc ? `<div class="small muted">${esc(clip(r.desc, 60))}</div>` : ""}${many ? `<span class="small muted">${esc(h.ushort(r.l.unit))}</span>` : ""}</td><td class="small">${esc(r.cat || "")}</td><td class="small">${esc(r.l.bank || "")}</td><td class="num">${plain(r.amt)}</td><td class="num small">${r.left === null ? "" : r.left > 0.5 ? plain(r.left) + " left" : '<span class="muted">complete</span>'}</td></tr>`;
    let body = "";
    if (by === "day") { const days = [...new Set(rows.map((r) => r.l.day))]; body = days.map((d) => { const ds = rows.filter((r) => r.l.day === d); return `<tr class="cf-g1"><td colspan="5"><b>${esc(dShort(d))}</b> <span class="small muted">${ds.length} entr${ds.length > 1 ? "ies" : "y"}</span></td><td class="num"><b>${plain(sum(ds, (r) => r.amt))}</b></td><td></td></tr>${ds.map((r) => line(r, false)).join("")}`; }).join(""); }
    else { const m = new Map(); rows.forEach((r) => { const key2 = (r.party || r.desc || "No name"); (m.get(key2) || m.set(key2, []).get(key2)).push(r); }); body = [...m.entries()].sort((a, b) => sum(b[1], (r) => r.amt) - sum(a[1], (r) => r.amt)).map(([nm, ds]) => `<tr class="cf-g1"><td colspan="5"><b>${esc(nm)}</b> <span class="small muted">${ds.length} entr${ds.length > 1 ? "ies" : "y"}</span></td><td class="num"><b>${plain(sum(ds, (r) => r.amt))}</b></td><td></td></tr>${ds.map((r) => line(r, true)).join("")}`).join(""); }
    return `<section class="cf-card flush cf-kk"><div class="cf-split cf-pad"><button type="button" class="cf-fold" data-cf="k-fold" data-v="${key}" aria-expanded="${open}"><span class="cf-caret">${open ? "▾" : "▸"}</span><h3>${title}</h3></button><span class="small muted">${rows.length} entr${rows.length === 1 ? "y" : "ies"} · <b>${plain(tot)}</b></span></div>
      ${!open ? "" : rows.length ? `<div class="scroll"><table class="cf-table cf-done"><thead><tr><th>${by === "day" ? "" : "Day"}</th><th>Code</th><th>${kind === "in" ? "Customer" : "Payee"}</th><th>Category</th><th>Bank</th><th class="num">Amount</th><th class="num">Line now</th></tr></thead><tbody>${body}<tr class="tot"><td colspan="5">Total</td><td class="num">${plain(tot)}</td><td></td></tr></tbody></table></div>` : `<div class="empty"><b>Nothing ${kind === "in" ? "collected" : "paid"} in this period</b>Cash is recorded in the Actual tab.</div>`}</section>`;
  }
  function renderDone() {
    const units = h.scopeUnits(), many = units.length > 1, d = K().dn, [from, to] = doneRange(), rows = doneRows(units), chip = h.chip;
    const rc = (v, t) => chip(d.range === v, `data-cf="k-drange" data-v="${v}"`, t);
    return `${bar(`<span class="cf-group">${rc("week", "This week")}${rc("month", "This month")}${rc("30", "Last 30 days")}${rc("custom", "Pick dates")}</span>${d.range === "custom" ? `<span class="cf-wk"><input type="date" data-kdn="from" value="${esc(from)}" class="cf-datemini" aria-label="From"><span class="small muted">to</span><input type="date" data-kdn="to" value="${esc(to)}" class="cf-datemini" aria-label="To"></span>` : ""}<span class="cf-group">${chip(d.by === "day", 'data-cf="k-dby" data-v="day"', "By day")}${chip(d.by === "party", 'data-cf="k-dby" data-v="party"', "By customer or payee")}</span><span class="cf-right"><button class="btn small" data-cf="k-ddl">Download Excel</button><button class="btn small" data-cf="k-pdf" data-v="done">Download PDF</button></span>`)}
      <div class="small muted">Everything recorded as collected or paid from <b>${esc(dShort(from))}</b> to <b>${esc(dShort(to))}</b>, with the day, the bank and what is left on each line now. Nothing is cleared: a paid line stays here.</div>${h.usdWarn()}
      ${doneBlock("in", rows.filter((r) => r.l.kind === "in"), many)}${doneBlock("out", rows.filter((r) => r.l.kind === "out"), many)}`;
  }
  async function doneExcel() {
    if (!c.libsReady("xlsx")) return; const X = c.XLSX(), wb = X.utils.book_new(), units = h.scopeUnits(), [from, to] = doneRange(), rows = doneRows(units).slice().sort((a, b) => a.l.day.localeCompare(b.l.day));
    const out = [[`Collected and paid, ${dShort(from)} to ${dShort(to)}`], [], ["Day", "Unit", "Collected or paid", "Code", "Customer or payee", "Description", "Category", "Bank", "Amount (ETB)", "Left on the line now"]];
    rows.forEach((r) => out.push([r.l.day, h.uname(r.l.unit), r.l.kind === "in" ? "Collected" : "Paid", r.code, r.party, r.desc, r.cat, r.l.bank || "", Math.round(r.amt * 100) / 100, r.left === null ? "" : Math.round(r.left * 100) / 100]));
    X.utils.book_append_sheet(wb, c.sheetFromRows(out, [12, 26, 14, 12, 30, 34, 14, 22, 16, 18]), "Collected and paid"); await c.writeXlsx(wb, `Collected and paid ${from} to ${to}.xlsx`, "Excel saved");
  }
  async function pdfDone() {
    if (!c.libsReady("pdf")) return; const units = h.scopeUnits(), many = units.length > 1, [from, to] = doneRange(), rows = doneRows(units).slice().sort((a, b) => a.l.day.localeCompare(b.l.day));
    const doc = c.newPdf("Collected and paid", `${scopeText()}  ·  ${dShort(from)} to ${dShort(to)}`); let y = 92;
    for (const kind of ["in", "out"]) { const rs = rows.filter((r) => r.l.kind === kind); y = secTitle(doc, kind === "in" ? "Collected" : "Paid", y); if (!rs.length) { doc.setFontSize(9); doc.setTextColor(120, 120, 120); doc.text("Nothing in this period.", 36, y + 12); y += 30; continue; }
      const body = rs.map((r) => [dMini(r.l.day), clip(r.party || r.desc, 40) + (many ? " · " + h.ushort(r.l.unit) : ""), r.code, r.cat, r.l.bank || "", { content: plain(r.amt), styles: { halign: "right" } }]); body.push([{ content: "Total", colSpan: 5, styles: { fontStyle: "bold" } }, { content: plain(sum(rs, (r) => r.amt)), styles: { fontStyle: "bold", halign: "right" } }]);
      doc.autoTable({ startY: y, margin: { left: 36, right: 36 }, head: [["Day", kind === "in" ? "Customer" : "Payee", "Code", "Category", "Bank", "Amount"]], body, ...pdfSt() }); y = doc.lastAutoTable.finalY + 18; }
    foot(doc, "Collected and paid"); await c.save(`Collected and paid ${from} to ${to}.pdf`, doc.output("arraybuffer"), "PDF saved. Open it to print.");
  }

  // ---------------- Actual (the week) ----------------
  function weekRows(units, W) {
    const E = weekEnd(W), q = K().q.trim().toLowerCase(), prev = addDays(W, -1), rows = [];
    for (const it of S.items) {
      if (!units.includes(it.unit) || it.status === "written_off") continue; if (q && !lineText(it).includes(q)) continue;
      const start = h.viewOf(it, prev).left, lg = S.log.filter((l) => l.itemId === it.id && l.day >= W && l.day <= E), coll = sum(lg, (l) => l.amount);
      if (start <= 0.005 && coll <= 0) continue; if ((it.enteredOn || "0000") > E && coll <= 0) continue;
      const wl = S.week.find((w) => w.itemId === it.id && w.week === W), planned = wl ? num(wl.planned) : start;
      rows.push({ it, start, planned: Math.max(planned, coll), coll, rem: Math.max(0, start - coll), lg, banks: [...new Set(lg.map((l) => l.bank).filter(Boolean))] });
    }
    return rows.sort((a, b) => a.it.bucket - b.it.bucket || conv(b.it, b.planned) - conv(a.it, a.planned));
  }
  function dayCell(r, d, wr) {
    const ents = r.lg.filter((l) => l.day === d), tot = sum(ents, (l) => l.amount), id = r.it.id, key = id + "|" + d;
    if (ents.length > 1) return `<td class="num cf-dc"><button type="button" class="cf-multi" data-cf="k-open" data-id="${esc(id)}" data-total="${tot}" title="Recorded in ${ents.length} banks. Click to see or change">${plain(tot)}<span class="small"> · ${ents.length} banks</span></button></td>`;
    const dr = K().kd[key], val = dr !== undefined ? dr : tot || "";
    return `<td class="num cf-dc">${wr ? `<input type="number" min="0" step="any" class="cf-amt" data-kd="1" data-id="${esc(id)}" data-day="${esc(d)}" data-was="${tot}" value="${esc(String(val))}" placeholder="" aria-label="${esc(dayHead(d, (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7))}">` : tot ? `<b>${plain(tot)}</b>` : '<span class="muted">–</span>'}${ents[0] && ents[0].bank ? `<div class="small muted cf-bk1">${esc(ents[0].bank)}</div>` : ""}</td>`;
  }
  function sectionActual(kind, rows, W, many) {
    const days = weekDays(W), sun = addDays(W, 6), hasSun = rows.some((r) => r.lg.some((l) => l.day === sun)), cols = hasSun ? [...days, sun] : days, title = kind === "in" ? "Collections" : "Payments", verb = kind === "in" ? "Collected" : "Paid";
    const body = rows.map((r) => { const it = r.it, wr = h.canWrite(it.unit), banks = h.knownBanks(it.unit), kb = K().kb[it.id] || r.banks[0] || h.lastBank(it.unit, it.kind), t = h.typeByCode(it.typeCode);
      const bankCell = r.banks.length > 1 ? `<span class="tag" title="${esc(r.banks.join(", "))}">${r.banks.length} banks</span>` : wr && banks.length ? `<select class="cf-bank" data-kb="1" data-id="${esc(it.id)}" aria-label="Bank">${(kb && !banks.includes(kb) ? [kb, ...banks] : banks).map((b) => `<option ${b === kb ? "selected" : ""}>${esc(b)}</option>`).join("")}</select>` : `<span class="small muted">${esc(r.banks[0] || "no bank")}</span>`;
      return `<tr data-krow="${esc(it.id)}" data-start="${r.start}" class="${K().pn === it.id ? "cf-sel" : ""}"><td class="cf-pick" data-cf="k-open" data-id="${esc(it.id)}" title="Open the details"><span class="tag">${esc(it.code || "")}</span></td><td class="cf-who cf-pick" data-cf="k-open" data-id="${esc(it.id)}" title="Open the details"><b>${esc(it.party || it.description || "")}</b>${cur(it)}${it.unplanned ? ' <span class="tag" title="Not in the plan">Unplanned</span>' : ""}${it.party && it.description ? `<div class="small muted">${esc(clip(it.description, 46))}${many ? " · " + esc(h.ushort(it.unit)) : ""}</div>` : many ? `<div class="small muted">${esc(h.ushort(it.unit))}</div>` : ""}</td>
        <td class="small cf-pick" data-cf="k-open" data-id="${esc(it.id)}" title="${esc(t ? t.label || "" : "Open the details")}">${esc(it.typeCode || "–")}</td><td>${bankCell}</td><td class="num">${plain(r.planned)}</td><td class="num"><b data-kcol>${plain(r.coll)}</b></td><td class="num"><b data-krem>${plain(r.rem)}</b></td>${cols.map((d) => dayCell(r, d, wr)).join("")}
        <td class="cf-act"><button type="button" class="btn small ghost" data-cf="k-open" data-id="${esc(it.id)}" aria-label="Open the details">Details ›</button></td></tr>`; }).join("");
    const colTot = (d) => sum(rows, (r) => conv(r.it, sum(r.lg.filter((l) => l.day === d), (l) => l.amount)));
    return `<section class="cf-card flush cf-kk"><div class="cf-split cf-pad"><button type="button" class="cf-fold" data-cf="k-fold" data-v="${kind}" aria-expanded="${!K().fold[kind]}"><span class="cf-caret">${K().fold[kind] ? "▸" : "▾"}</span><h3>${title}</h3></button><span class="small muted">${rows.length} line${rows.length === 1 ? "" : "s"} · planned <b>${plain(sum(rows, (r) => conv(r.it, r.planned)))}</b> · ${verb.toLowerCase()} <b>${plain(sum(rows, (r) => conv(r.it, r.coll)))}</b> · remaining <b>${plain(sum(rows, (r) => conv(r.it, r.rem)))}</b></span></div>
      ${K().fold[kind] ? "" : rows.length ? `<div class="scroll"><table class="cf-table cf-wkgrid"><thead><tr><th>Code</th><th>${kind === "in" ? "Customer" : "Payee"}</th><th>Category</th><th>Bank</th><th>Planned</th><th>${verb}</th><th>Remaining</th>${cols.map((d, i) => `<th class="cf-dh" title="${esc(dShort(d))}">${esc(dayHead(d, i))}${d === c.todayIso ? '<div class="small">today</div>' : ""}</th>`).join("")}<th></th></tr></thead><tbody>${body}<tr class="tot"><td colspan="4">Total</td><td class="num">${plain(sum(rows, (r) => conv(r.it, r.planned)))}</td><td class="num">${plain(sum(rows, (r) => conv(r.it, r.coll)))}</td><td class="num">${plain(sum(rows, (r) => conv(r.it, r.rem)))}</td>${cols.map((d) => `<td class="num">${colTot(d) ? plain(colTot(d)) : ""}</td>`).join("")}<td></td></tr></tbody></table></div>` : `<div class="empty"><b>Nothing for this week</b>No open ${kind === "in" ? "collections" : "payments"} and nothing recorded.</div>`}</section>`;
  }
  function renderActual() {
    const units = h.scopeUnits(), many = units.length > 1, W = K().wk, rows = weekRows(units, W), n = Object.keys(K().kd).length, w = writable();
    const wkBar = `<span class="cf-wk"><button class="btn small" data-cf="k-shift" data-v="-7" aria-label="Previous week">‹</button><b title="Monday to Saturday">${esc(weekLabel(W))}</b><button class="btn small" data-cf="k-shift" data-v="7" aria-label="Next week">›</button><input type="date" data-kwk="1" value="${esc(W)}" aria-label="Pick any day in the week" class="cf-datemini">${W !== weekStart(c.todayIso) ? '<button class="btn small" data-cf="k-today">This week</button>' : ""}</span>`;
    return `${bar(`${wkBar}<span class="cf-right">${w ? `<button class="btn small" data-cf="k-newline">+ Add a line</button><button class="btn primary small" data-cf="k-save" id="ckSave" ${n ? "" : "disabled"}>${n ? `Save ${n} entr${n > 1 ? "ies" : "y"}` : "Save"}</button>` : ""}${h.menu([w ? ['data-cf="k-dl" data-v="wk"', "Download this week as a template"] : null, w ? ['data-cf="k-pick" data-v="wk"', "Upload the filled week"] : null, ['data-cf="k-dl" data-v="wkview"', "Download this view (Excel)"], ['data-cf="k-pdf" data-v="actual"', "Download PDF"]])}<input type="file" id="ckUploadWk" accept=".xlsx,.xls" hidden></span>`)}
      <div class="small muted">Type what was collected or paid in the day it happened. The bank is the one shown on the line; click a line (code, name or category) to open its details on the right: there you can record each day in one or more banks, including a new bank. Planned is the plan for the week (or what was left at the start of it).</div>${h.usdWarn()}
      ${pvu(units, W, rows)}${sectionActual("in", rows.filter((r) => r.it.kind === "in"), W, many)}${sectionActual("out", rows.filter((r) => r.it.kind === "out"), W, many)}${drawer(W, units)}`;
  }
  // live: the row's collected and remaining, the save button
  function onInput(t) {
    if (t.dataset.pda !== undefined || t.dataset.pdb !== undefined) { onDrawerInput(); return; }
    if (t.dataset.kd) {
      const key = t.dataset.id + "|" + t.dataset.day, was = num(t.dataset.was), val = t.value; const kd = K().kd;
      if (val === "" ? was === 0 : num(val) === was) delete kd[key]; else kd[key] = val;
      const tr = t.closest("tr"), start = num(tr.dataset.start);
      const tot = sum([...tr.querySelectorAll("input[data-kd]")], (e) => num(e.value)) + sum([...tr.querySelectorAll("[data-total]")], (e) => num(e.dataset.total));
      const a = tr.querySelector("[data-kcol]"), b = tr.querySelector("[data-krem]"); if (a) a.textContent = plain(tot); if (b) b.textContent = plain(Math.max(0, start - tot));
      const btn = document.getElementById("ckSave"), n = Object.keys(kd).length; if (btn) { btn.disabled = !n; btn.textContent = n ? `Save ${n} entr${n > 1 ? "ies" : "y"}` : "Save"; }
    }
  }
  function onBank(t) { K().kb[t.dataset.id] = t.value; }

  // one place that writes a day's cash for a line (used by the grid, the split form and the weekly upload)
  async function commitDays(ops) {
    const byItem = new Map(); ops.forEach((o) => (byItem.get(o.it.id) || byItem.set(o.it.id, []).get(o.it.id)).push(o));
    for (const [id, os] of byItem) {
      const it = os[0].it, days = new Set(os.map((o) => o.day)); let logged = sum(S.log.filter((l) => l.itemId === id && !days.has(l.day)), (l) => l.amount), latest = "";
      for (const o of os) {
        const ents = S.log.filter((l) => l.itemId === id && l.day === o.day);
        if (ents.length > 1) { logged += sum(ents, (l) => l.amount); continue; }
        const e = ents[0], amt = Math.round(num(o.amt) * 100) / 100;
        if (amt > 0) {
          const bank = (e && e.bank) || o.bank || h.lastBank(it.unit, it.kind);
          if (!e || Math.abs(num(e.amount) - amt) > 0.005) { const res = await c.api().saveCfLog(A(), h.logRow({ ...(e || { unit: it.unit, day: o.day, kind: it.kind, currency: it.currency, party: it.party, description: it.description, typeCode: it.typeCode, itemId: it.id, itemCode: it.code, note: "", fxRate: it.currency === "USD" ? fx() || "" : "" }), id: e ? e.id : undefined, bank, amount: amt })); if (res && res.error) return res; }
          logged += amt; if (o.day > latest) latest = o.day;
        } else if (e) { const d = await c.api().deleteCf(A(), "cf_log", e.id); if (d && d.error) return d; }
      }
      const full = logged >= num(it.amount) - 0.005;
      if (full && it.status === "open" && logged > 0) { const r = await c.api().saveCfItem(A(), h.itemRow({ ...it, status: "settled", settledOn: latest || c.todayIso })); if (r && r.error) return r; }
      else if (!full && it.status === "settled") { const r = await c.api().saveCfItem(A(), h.itemRow({ ...it, status: "open", settledOn: "" })); if (r && r.error) return r; }
    }
    return { ok: true };
  }
  async function saveGrid() {
    const kd = K().kd, ops = [];
    for (const [key, v] of Object.entries(kd)) { const [id, day] = key.split("|"), it = S.items.find((q) => q.id === id); if (!it || !h.canWrite(it.unit)) continue; const bank = K().kb[id] || h.lastBank(it.unit, it.kind);
      if (num(v) > 0 && !bank && !S.log.some((l) => l.itemId === id && l.day === day)) { c.toast("Choose the bank for " + (it.party || it.code)); return; } ops.push({ it, day, amt: num(v), bank }); }
    if (!ops.length) return; const ok = await h.run(() => commitDays(ops), `${ops.length} entr${ops.length > 1 ? "ies" : "y"} saved`); if (ok) { K().kd = {}; c.render(); }
  }


  // ---------------- the line's details, on the right ----------------
  const drawer = (W, units) => {
    if (K().pn === "__new") return newDrawer();
    const k = K(), it = k.pn && S.items.find((q) => q.id === k.pn); if (!it) return ""; const wr = h.canWrite(it.unit), days = weekDays(W), sun = addDays(W, 6), lg = S.log.filter((l) => l.itemId === it.id), wk = lg.filter((l) => l.day >= W && l.day <= sun), cols = wk.some((l) => l.day === sun) ? [...days, sun] : days;
    const start = h.viewOf(it, addDays(W, -1)).left, coll = sum(wk, (l) => l.amount), wl = S.week.find((w) => w.itemId === it.id && w.week === W), planned = Math.max(wl ? num(wl.planned) : start, coll), verb = it.kind === "in" ? "Collected" : "Paid", banks = h.knownBanks(it.unit), t = h.typeByCode(it.typeCode);
    const dayBox = (d, i) => { const ents = k.pd && k.pd[d] ? k.pd[d] : wk.filter((l) => l.day === d).map((l) => ({ id: l.id, bank: l.bank, amount: l.amount }));
      const row = (e, j) => `<div class="cf-prow"><input list="cf-pbanks" class="cf-pbank" data-pdb="${j}" value="${esc(e.bank || "")}" placeholder="${banks.length ? "Bank: pick or type a new one" : "Type the bank name"}" ${wr ? "" : "disabled"} aria-label="Bank"><input type="number" min="0" step="any" class="cf-amt" data-pda="${j}" value="${esc(String(e.amount === 0 ? "" : e.amount))}" placeholder="Amount" ${wr ? "" : "disabled"} aria-label="Amount"><input type="hidden" data-pdi="${j}" value="${esc(e.id || "")}">${wr ? `<button type="button" class="btn small ghost" data-cf="k-pdel" data-day="${esc(d)}" data-j="${j}" aria-label="Remove this bank">✕</button>` : ""}</div>`;
      return `<div class="cf-pday" data-pday="${esc(d)}"><div class="cf-pd-h"><b>${esc(dayHead(d, i))}</b><span class="small muted">${esc(dMini(d))}${d === c.todayIso ? " · today" : ""}</span></div>${(ents.length ? ents : wr ? [{}] : []).map(row).join("")}${!ents.length && !wr ? '<div class="small muted">Nothing recorded</div>' : ""}${wr ? `<button type="button" class="btn small ghost" data-cf="k-padd" data-day="${esc(d)}">+ Another bank</button>` : ""}</div>`; };
    const hist = lg.slice().sort((a, b) => (b.day + (b.updatedAt || "")).localeCompare(a.day + (a.updatedAt || ""))).slice(0, 12);
    return `<aside class="cf-drawer" role="dialog" aria-label="Line details"><div class="cf-dr-h"><div><span class="tag">${esc(it.code || "")}</span> <b>${esc(it.party || it.description || "")}</b>${cur(it)}<div class="small muted">${esc(it.party ? it.description || "" : "")}${units.length > 1 ? " · " + esc(h.uname(it.unit)) : ""}</div></div><button type="button" class="btn small" data-cf="k-pclose" aria-label="Close">✕</button></div>
      ${k.pwarn ? `<div class="cf-dr-warn"><b>You have changes that are not saved.</b><span class="small">Save them, or discard them to close.</span><span class="cf-group"><button type="button" class="btn small primary" data-cf="k-psave">Save</button><button type="button" class="btn small" data-cf="k-pdiscard">Discard changes</button></span></div>` : ""}<div class="cf-dr-meta small"><span>Category <b>${esc(it.typeCode || "none")}</b>${t && t.label && t.label !== t.code ? ` · ${esc(t.label)}` : ""}</span><span>Line total <b>${plain(it.amount)}</b> ${esc(it.currency)}</span><span>Due <b>${esc(it.expected ? dShort(it.expected) : "not set")}</b></span></div>
      <div class="cf-dr-tot"><div><small>Planned this week</small><b>${plain(planned)}</b></div><div><small>${verb}</small><b data-pcoll>${plain(coll)}</b></div><div><small>Remaining</small><b data-prem>${plain(Math.max(0, start - coll))}</b></div></div>
      <datalist id="cf-pbanks">${banks.map((b) => `<option value="${esc(b)}">`).join("")}</datalist>
      <div class="cf-dr-b" data-pstart="${start}">${wr ? '<div class="small muted">Write what was ' + verb.toLowerCase() + ' on each day, with the bank. A day that used two banks gets two rows. A bank that is not in the list is added when you save.</div>' : ""}${cols.map(dayBox).join("")}</div>
      ${hist.length ? `<details class="cf-dr-hist"><summary>What was recorded for this line (${lg.length})</summary>${hist.map((l) => `<div class="small"><b>${esc(dMini(l.day))}</b> · ${esc(l.bank || "no bank")} · ${plain(l.amount)}<span class="muted"> · ${esc(l.updatedBy || l.createdBy || "")}${l.updatedAt ? " " + esc(String(l.updatedAt).slice(0, 16).replace("T", " ")) : ""}</span></div>`).join("")}</details>` : ""}
      <div class="cf-dr-f">${wr ? `<button type="button" class="btn small ghost" data-cf="item-open" data-id="${esc(it.id)}">Edit line</button>` : ""}<button type="button" class="btn small ghost" data-cf="w-trace" data-id="${esc(it.id)}">Trace</button><span class="cf-right"><button type="button" class="btn" data-cf="k-pclose">Close</button>${wr ? '<button type="button" class="btn primary" data-cf="k-psave">Save</button>' : ""}</span></div></aside>`;
  };
  const readDrawer = () => { const out = {}; document.querySelectorAll(".cf-drawer [data-pday]").forEach((box) => { out[box.dataset.pday] = [...box.querySelectorAll(".cf-prow")].map((r) => ({ id: r.querySelector("[data-pdi]").value, bank: r.querySelector("[data-pdb]").value.trim(), amount: r.querySelector("[data-pda]").value })); }); return out; };
  async function saveDrawer() {
    const k = K(), it = S.items.find((q) => q.id === k.pn); if (!it || !h.canWrite(it.unit)) return; const pd = readDrawer(), W = k.wk, E = weekEnd(W);
    for (const [d, rs] of Object.entries(pd)) { const used = rs.filter((r) => num(r.amount) > 0); if (used.some((r) => !r.bank)) { c.toast("Choose or type the bank on every row (" + dMini(d) + ")"); return; } if (new Set(used.map((r) => r.bank.toLowerCase())).size !== used.length) { c.toast("A bank appears twice on " + dMini(d) + ". Add the amounts together."); return; } }
    const ok = await h.run(async () => {
      let logged = sum(S.log.filter((l) => l.itemId === it.id && (l.day < W || l.day > E)), (l) => l.amount), latest = "";
      for (const [d, rs] of Object.entries(pd)) { const have = S.log.filter((l) => l.itemId === it.id && l.day === d), keep = new Set(rs.filter((r) => r.id && num(r.amount) > 0).map((r) => r.id));
        for (const e of have) if (!keep.has(e.id)) { const x = await c.api().deleteCf(A(), "cf_log", e.id); if (x && x.error) return x; }
        for (const r of rs) { const amt = Math.round(num(r.amount) * 100) / 100; if (!(amt > 0)) continue; const e = r.id ? have.find((q) => q.id === r.id) : null;
          if (!e || e.bank !== r.bank || Math.abs(num(e.amount) - amt) > 0.005) { const res = await c.api().saveCfLog(A(), h.logRow({ ...(e || { unit: it.unit, day: d, kind: it.kind, currency: it.currency, party: it.party, description: it.description, typeCode: it.typeCode, itemId: it.id, itemCode: it.code, note: "", fxRate: it.currency === "USD" ? fx() || "" : "" }), id: e ? e.id : undefined, bank: r.bank, amount: amt })); if (res && res.error) return res; }
          logged += amt; if (d > latest) latest = d; } }
      const full = logged >= num(it.amount) - 0.005;
      if (full && it.status === "open" && logged > 0) { const r = await c.api().saveCfItem(A(), h.itemRow({ ...it, status: "settled", settledOn: latest || c.todayIso })); if (r && r.error) return r; }
      else if (!full && it.status === "settled") { const r = await c.api().saveCfItem(A(), h.itemRow({ ...it, status: "open", settledOn: "" })); if (r && r.error) return r; }
      return { ok: true }; }, "Saved");
    if (ok) { k.pd = null; k.pwarn = false; c.render(); }
  }
  function onDrawerInput() { const pd = readDrawer(), b = document.querySelector(".cf-dr-b"); if (!b) return; const start = num(b.dataset.pstart), tot = sum(Object.values(pd).flat(), (r) => num(r.amount)); const a = document.querySelector("[data-pcoll]"), r = document.querySelector("[data-prem]"); if (a) a.textContent = plain(tot); if (r) r.textContent = plain(Math.max(0, start - tot)); }


  // ---------------- open, close and unsaved changes of the details panel ----------------
  const sigOf = (pd) => JSON.stringify(Object.keys(pd).sort().map((d) => [d, pd[d].filter((r) => num(r.amount) > 0).map((r) => String(r.bank || "").trim().toLowerCase() + "|" + num(r.amount)).sort()]));
  function isDirty() {
    const k = K(); if (k.pn === "__new") return newDirty(); if (!k.pn || !document.querySelector(".cf-drawer")) return false; const now = readDrawer(), base = {};
    Object.keys(now).forEach((d) => { base[d] = S.log.filter((l) => l.itemId === k.pn && l.day === d).map((l) => ({ bank: l.bank, amount: l.amount })); });
    return sigOf(now) !== sigOf(base);
  }
  // returns true when the panel had to stay open because of unsaved changes
  function tryClose() {
    const k = K(); if (!k.pn) return false;
    if (isDirty()) { if (k.pn === "__new") k.nf = readNew(); else k.pd = readDrawer(); k.pwarn = true; c.render(); return true; }
    k.pn = null; k.pd = null; k.pwarn = false; c.render(); return false;
  }
  function onOutside(e) {
    const k = S.ck; if (!k || !k.pn || k.tab !== "actual" || S.view !== "coll") return false; const t = e.target;
    if (!t.isConnected || t.closest(".cf-drawer") || t.closest('[data-cf="k-open"]') || t.closest(".overlay,.modal,.toast,.cf-menu-list")) return false;
    return tryClose();
  }

  // ---------------- one day in several banks ----------------
  function openSplit(id, day) {
    const it = S.items.find((q) => q.id === id); if (!it) return; const d = day || (K().wk <= c.todayIso && c.todayIso <= weekEnd(K().wk) ? c.todayIso : K().wk);
    const rows = S.log.filter((l) => l.itemId === id && l.day === d).map((l) => ({ id: l.id, bank: l.bank, amount: l.amount }));
    S.m = { type: "ksplit", itemId: id, day: d, ask: !day, rows: rows.length ? rows : [{ id: "", bank: h.lastBank(it.unit, it.kind), amount: "" }], orig: rows.map((r) => r.id) }; h.drawModal();
  }
  const readSplit = () => { const m = S.m; m.rows = m.rows.map((r, i) => ({ ...r, bank: h.v(`ks-b${i}`) || r.bank, amount: h.v(`ks-a${i}`) })); const dd = document.getElementById("ks-day"); if (dd && dd.value) m.day = dd.value; };
  function splitForm(m) {
    const it = S.items.find((q) => q.id === m.itemId); if (!it) return `<div class="panel-head"><h2>Line not found</h2></div><div class="save-bar"><div></div><button class="btn" data-cf="close">Close</button></div>`;
    const banks = h.knownBanks(it.unit), tot = sum(m.rows, (r) => num(r.amount));
    return `<div class="panel-head"><div><h2>${it.kind === "in" ? "Collected" : "Paid"} in more than one bank</h2><div class="small muted"><b>${esc(it.party || it.description || "")}</b> ${esc(it.code || "")} · ${plain(it.amount)} ${esc(it.currency)}. One row for each bank used on the day.</div></div></div>
      <div class="xgrid">${h.field("ks-day", "Day", `<input type="date" id="ks-day" value="${esc(m.day)}" ${m.ask ? "" : "disabled"}>`)}</div>
      <div class="scroll"><table class="cf-table"><thead><tr><th>Bank</th><th>Amount</th><th></th></tr></thead><tbody>${m.rows.map((r, i) => `<tr><td><select id="ks-b${i}">${(r.bank && !banks.includes(r.bank) ? [r.bank, ...banks] : banks).map((b) => `<option ${b === r.bank ? "selected" : ""}>${esc(b)}</option>`).join("")}</select></td><td><input type="number" min="0" step="any" id="ks-a${i}" value="${esc(String(r.amount))}"></td><td><button class="btn small ghost" data-cf="k-split-del" data-i="${i}" aria-label="Remove this bank">✕</button></td></tr>`).join("")}<tr class="tot"><td>Total</td><td class="num">${plain(tot)}</td><td></td></tr></tbody></table></div>
      <div class="toolbar"><button class="btn small" data-cf="k-split-add">+ Another bank</button>${m.ask ? `<button class="btn small" data-cf="k-split-day">Show that day</button>` : ""}</div>
      <div class="save-bar"><div class="toolbar"></div><div class="toolbar"><button class="btn" data-cf="close">Cancel</button><button class="btn primary" data-cf="k-split-save">Save</button></div></div>`;
  }
  async function saveSplit() {
    readSplit(); const m = S.m, it = S.items.find((q) => q.id === m.itemId); if (!it) return; const rows = m.rows.filter((r) => num(r.amount) > 0);
    if (rows.some((r) => !r.bank)) { c.toast("Choose the bank on every row"); return; } if (new Set(rows.map((r) => r.bank)).size !== rows.length) { c.toast("Each bank can appear once. Add the amounts together."); return; }
    const ok = await h.run(async () => {
      const keep = new Set(rows.map((r) => r.id).filter(Boolean)); let logged = sum(S.log.filter((l) => l.itemId === it.id && l.day !== m.day), (l) => l.amount);
      for (const id of m.orig) if (!keep.has(id)) { const d = await c.api().deleteCf(A(), "cf_log", id); if (d && d.error) return d; }
      for (const r of rows) { const e = r.id ? S.log.find((l) => l.id === r.id) : null, amt = Math.round(num(r.amount) * 100) / 100;
        if (!e || e.bank !== r.bank || Math.abs(num(e.amount) - amt) > 0.005) { const res = await c.api().saveCfLog(A(), h.logRow({ ...(e || { unit: it.unit, day: m.day, kind: it.kind, currency: it.currency, party: it.party, description: it.description, typeCode: it.typeCode, itemId: it.id, itemCode: it.code, note: "", fxRate: it.currency === "USD" ? fx() || "" : "" }), id: e ? e.id : undefined, bank: r.bank, amount: amt })); if (res && res.error) return res; }
        logged += amt; }
      const full = logged >= num(it.amount) - 0.005;
      if (full && it.status === "open" && logged > 0) { const r = await c.api().saveCfItem(A(), h.itemRow({ ...it, status: "settled", settledOn: m.day })); if (r && r.error) return r; }
      else if (!full && it.status === "settled") { const r = await c.api().saveCfItem(A(), h.itemRow({ ...it, status: "open", settledOn: "" })); if (r && r.error) return r; }
      return { ok: true }; }, "Saved");
    if (ok) { delete K().kd[it.id + "|" + m.day]; h.closeModal(); }
  }

  // ---------------- Status ----------------
  function sideStatus(kind, b, items, many) {
    const tot = sum(items, (x) => conv(x.it, x.v.left)), title = kind === "in" ? "Collections" : "Payments";
    const body = items.slice().sort((p, q) => conv(q.it, q.v.left) - conv(p.it, p.v.left)).map(({ it, v }) => `<tr class="cf-sub"><td>${esc(it.party || it.description || "")}${cur(it)}${unitTag(it, many)}</td><td class="small">${esc(it.party ? clip(it.description, 50) : "")}</td><td class="num">${plain(v.left)}${v.to > 0 ? `<div class="small muted">of ${plain(it.amount)}</div>` : ""}</td><td class="small">${esc(it.expected ? dMini(it.expected) : "")}</td></tr>`).join("");
    return `<div class="cf-side"><div class="cf-side-h"><span><b>${title}</b> <span class="small muted">${bucketCode(kind, b)}</span></span><b>${plain(tot)}</b></div>${items.length ? `<div class="scroll"><table class="cf-table cf-mini"><thead><tr><th>Customer</th><th>Description</th><th>Left</th><th>Date</th></tr></thead><tbody>${body}<tr class="tot"><td colspan="2">Total</td><td class="num">${plain(tot)}</td><td></td></tr></tbody></table></div>` : `<div class="small muted cf-pad">Nothing left.</div>`}</div>`;
  }
  function renderStatus() {
    const units = h.scopeUnits(), many = units.length > 1, D = S.day, { list, skipped } = openLines(units, D), w = writable();
    const box = (b) => { const ls = list.filter((x) => x.it.bucket === b), inn = ls.filter((x) => x.it.kind === "in"), out = ls.filter((x) => x.it.kind === "out");
      return `<section class="cf-card cf-mbox"><div class="cf-split"><h3>${BUCKET_NAME[b]} <span class="small muted">${b} / ${b}${b}</span></h3></div><div class="cf-two">${sideStatus("in", b, inn, many)}${sideStatus("out", b, out, many)}</div></section>`; };
    const todayNote = D === c.todayIso ? "Today" : D < c.todayIso ? "End of " + dShort(D) : dShort(D);
    return `${bar(`<span class="cf-right">${h.menu([['data-cf="k-dl" data-v="status"', "Download as Excel (to add lines and upload as the next plan)"], w ? ['data-cf="k-pick" data-v="status"', "Upload a filled sheet as the plan"] : null])}<button class="btn small" data-cf="k-pdf" data-v="status">Download PDF</button></span>`)}
      ${addPlan()}<div class="cf-asof small muted"><b>Where we stand: ${esc(todayNote)}.</b> What is still to be collected and paid, after the cash already recorded. Use it to plan next week: download it, add lines, and upload it again.</div>${skippedNote(skipped)}${h.usdWarn()}${[1, 2, 3].map(box).join("")}`;
  }

  // ---------------- Excel: the week ----------------
  const shortName = (u) => h.ushort(u).replace(/[\\/*?:[\]]/g, "");
  async function weekTemplate(viewOnly) {
    const units = h.scopeUnits().filter((u) => viewOnly || h.canWrite(u)); if (!units.length) { c.toast("You can only download the template for a unit you can edit"); return; }
    const W = K().wk, days = weekDays(W), banksAll = [...new Set(units.flatMap((u) => h.knownBanks(u)))], types = S.types.filter((t) => t.active).map((t) => t.code);
    const wb = await XL.newBook(c, (col) => { col(1, banksAll.length ? banksAll : [""], "L_Bank"); col(2, types.length ? types : [""], "L_Type"); }); if (!wb) return;
    const snap = [["Unit", "Code", "Day", "Amount when downloaded", "Downloaded at " + new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace("T", " ")]];
    for (const u of units) {
      const ws = wb.addWorksheet(`${shortName(u)} Week`.slice(0, 31), { views: [{ state: "frozen", ySplit: 5 }] }), rows = weekRows([u], W);
      ws.getCell("A1").value = "Business unit"; ws.getCell("B1").value = h.uname(u); ws.getCell("A2").value = "Week starting (Monday)"; ws.getCell("B2").value = XL.toDate(W); ws.getCell("B2").numFmt = "yyyy-mm-dd"; XL.bold(ws.getCell("A1")); XL.bold(ws.getCell("A2"));
      ws.getCell("D1").value = "Type what was collected or paid in each day column. Leave a day empty for no change; type 0 to remove a day's entry. A day that used several banks is shown as its total: change it in the app. To add cash with no line, add a row at the bottom of a block, leave the code empty and write who it is."; ws.getCell("D1").font = { italic: true, color: { argb: "FF777777" } };
      const heads = ["Code", "Customer or payee", "Description", "Category", "Bank", "Planned", "Collected or paid", "Remaining", ...days.map((d, i) => dayHead(d, i))], widths = [13, 30, 32, 14, 22, 15, 16, 15, ...days.map(() => 14)];
      let r = 4;
      for (const kind of ["in", "out"]) {
        ws.getCell(r, 1).value = kind === "in" ? "COLLECTIONS" : "PAYMENTS"; XL.bold(ws.getCell(r, 1)); ws.getCell(r, 1).font = { bold: true, size: 13 }; r++;
        XL.head(ws, r, heads); r++;
        const mine = rows.filter((x) => x.it.kind === kind), first = r;
        mine.forEach((x) => { const bank = x.banks.length > 1 ? "Several banks" : x.banks[0] || h.lastBank(x.it.unit, kind);
          [x.it.code, x.it.party, x.it.description, x.it.typeCode, bank, Math.round(x.planned * 100) / 100].forEach((v, i) => { ws.getCell(r, i + 1).value = v; XL.fill(ws.getCell(r, i + 1), XL.GREY); });
          days.forEach((d, i) => { const t = sum(x.lg.filter((l) => l.day === d), (l) => l.amount); if (x.it.code) snap.push([h.uname(u), x.it.code, d, Math.round(t * 100) / 100]); ws.getCell(r, 9 + i).value = t > 0 ? Math.round(t * 100) / 100 : ""; ws.getCell(r, 9 + i).numFmt = "#,##0.00"; });
          ws.getCell(r, 7).value = { formula: `SUM(I${r}:N${r})` }; ws.getCell(r, 8).value = { formula: `MAX(0,F${r}-G${r})` }; [6, 7, 8].forEach((ci) => { ws.getCell(r, ci).numFmt = "#,##0.00"; XL.fill(ws.getCell(r, ci), XL.GREY); }); r++; });
        const spare = 8, last = r + spare - 1;
        for (let k = 0; k < spare; k++) { ws.getCell(r + k, 7).value = { formula: `SUM(I${r + k}:N${r + k})` }; ws.getCell(r + k, 7).numFmt = "#,##0.00"; XL.fill(ws.getCell(r + k, 7), XL.GREY); for (let ci = 9; ci <= 14; ci++) ws.getCell(r + k, ci).numFmt = "#,##0.00"; }
        XL.listV(ws, 5, first, last, "L_Bank", "Pick a bank.", true); XL.listV(ws, 4, first, last, "L_Type", "Pick a category from the list.", true); XL.numV(ws, 9, first, last, 0); for (let ci = 10; ci <= 14; ci++) XL.numV(ws, ci, first, last, 0);
        r = last + 1; ws.getCell(r, 1).value = kind === "in" ? "Total collections" : "Total payments"; XL.bold(ws.getCell(r, 1));
        ["F", "G", "I", "J", "K", "L", "M", "N"].forEach((L) => { ws.getCell(`${L}${r}`).value = { formula: `SUM(${L}${first}:${L}${last})` }; ws.getCell(`${L}${r}`).numFmt = "#,##0.00"; XL.bold(ws.getCell(`${L}${r}`)); }); r += 3;
      }
      widths.forEach((wd, i) => { ws.getColumn(i + 1).width = wd; });
    }
    { const sw = wb.addWorksheet("Snapshot", { state: "hidden" }); snap.forEach((row, i) => row.forEach((v, j) => { sw.getCell(i + 1, j + 1).value = v; })); }
    XL.infoSheet(wb, "How to fill in the week", ["The file remembers what was recorded when you downloaded it. If you upload it after someone changed a day in the app, your figure for that day is not applied and the newer one is kept: the upload result lists those days.", "One bank for each line: the Bank column is used for new cash. If a day used another bank, record that day in the app (open the line, add a bank).", "One sheet for each business unit. Collections are at the top, payments below. The week is in cell B2 of the sheet.", "Each line shows its plan for the week. Type the cash that moved in the day columns, Monday to Saturday. Collected, Remaining and the totals are worked out.", "A day with more than one bank is shown as one total. Change it in the app with “Record in more than one bank”.", "Empty day = no change. 0 = remove that day's entry. Upload never deletes anything else.", "Cash with no line: add a row at the bottom of a block, leave the code empty, write who it is, the category and the bank."]);
    await c.saveFile(`${viewOnly ? "Week" : "Weekly template"} ${W}.xlsx`, await wb.xlsx.writeBuffer(), "Excel saved");
  }
  async function uploadWeek(file) {
    const units = h.writableUnits(); if (!units.length) { c.toast("You cannot edit any unit's cash flow"); return; } const bk = await XL.readBook(c, file); if (!bk) return; const { X, wb } = bk;
    const uMap = new Map(); units.forEach((u) => [h.uname(u), h.ushort(u), c.unitName(u), u].forEach((n) => uMap.set(XL.norm(n), u)));
    const snapSh = XL.readSheets(X, wb, /^snapshot$/i)[0], snap = snapSh ? new Map(snapSh.rows.slice(1).map((q) => [XL.norm(q[0]) + "|" + String(q[1]).trim().toUpperCase() + "|" + String(q[2]).slice(0, 10), num(q[3])])) : null, dl = snapSh && snapSh.rows[0] ? String(snapSh.rows[0][4] || "").replace("Downloaded at ", "") : "";
    const sheets = XL.readSheets(X, wb, /week$/i); if (!sheets.length) { c.toast("No “… Week” sheet found. Use the template from this page."); return; }
    const rep = { skip: 0, notes: [], n: 0, created: 0 }, bad = (sh, line, why) => { rep.skip++; rep.notes.push(`${sh} row ${line}: ${why}`); }, ops = [], news = [];
    for (const sh of sheets) {
      const unit = uMap.get(XL.norm(sh.rows[0] && sh.rows[0][1])), W0 = XL.serialToIso(sh.rows[1] && sh.rows[1][1]); if (!unit) { bad(sh.name, 1, `unit “${sh.rows[0] && sh.rows[0][1]}” not found or not yours`); continue; } if (!W0) { bad(sh.name, 2, "the week (cell B2) is missing"); continue; }
      const W = weekStart(W0), days = weekDays(W), known = h.knownBanks(unit); let kind = "";
      for (let i = 3; i < sh.rows.length; i++) { const r = sh.rows[i], line = i + 1, a = String(r[0]).trim();
        if (/^collections$/i.test(a)) { kind = "in"; continue; } if (/^payments$/i.test(a)) { kind = "out"; continue; } if (!kind || !a && !String(r[1]).trim() && !String(r[2]).trim() && !r.slice(8, 14).some((x) => String(x).trim() !== "")) continue; if (/^(code|total)/i.test(a)) continue;
        const cells = days.map((d, k) => ({ d, v: XL.money(r[8 + k]) })).filter((x) => x.v !== null); if (!cells.length) continue;
        const bankN = String(r[4]).trim(), bank = /several/i.test(bankN) ? "" : known.find((k) => XL.norm(k) === XL.norm(bankN)) || bankN;
        if (a) { const it = S.items.find((q) => q.unit === unit && q.code && q.code.toUpperCase() === a.toUpperCase()); if (!it) { bad(sh.name, line, `no line with code ${a}`); continue; } if (it.kind !== kind) { bad(sh.name, line, `${a} is a ${it.kind === "in" ? "collection" : "payment"}, it is in the ${kind === "in" ? "collections" : "payments"} block`); continue; }
          for (const { d, v } of cells) { const have = sum(S.log.filter((l) => l.itemId === it.id && l.day === d), (l) => l.amount), ents = S.log.filter((l) => l.itemId === it.id && l.day === d); if (Math.abs(have - v) < 0.005) continue;
            if (snap) { const key = XL.norm(h.uname(unit)) + "|" + a.toUpperCase() + "|" + d; if (snap.has(key)) { const was = snap.get(key); if (Math.abs(v - was) < 0.005) continue; if (Math.abs(have - was) > 0.005) { rep.kept = (rep.kept || 0) + 1; rep.notes.push(`${sh.name} row ${line}: ${a} on ${dMini(d)}: the file says ${plain(v)}, but the app now has ${plain(have)} (changed after the file was downloaded${dl ? " on " + dl : ""}). Kept ${plain(have)}.`); continue; } } }
            if (ents.length > 1) { rep.notes.push(`${sh.name} row ${line}: ${a} on ${dMini(d)} is in ${ents.length} banks. Change it in the app.`); continue; } if (v > 0 && !bank && !ents[0] && !h.lastBank(unit, kind)) { bad(sh.name, line, "choose the bank"); continue; } ops.push({ it, day: d, amt: v, bank, line: `${sh.name} row ${line}` }); } }
        else { const party = String(r[1]).trim(), desc = String(r[2]).trim(); if (!party && !desc) { bad(sh.name, line, "write who it is, or a description"); continue; } const b = bank || h.lastBank(unit, kind); if (!b) { bad(sh.name, line, "choose the bank"); continue; } const tc = S.types.find((t) => XL.norm(t.code) === XL.norm(r[3]));
          for (const { d, v } of cells) { if (v <= 0) continue; if (S.log.some((l) => l.unit === unit && l.day === d && !l.itemId && l.kind === kind && l.bank === b && Math.abs(num(l.amount) - v) < 0.005 && XL.norm(l.party) === XL.norm(party))) continue; news.push({ unit, day: d, kind, bank: b, amount: v, currency: "ETB", party, description: desc, typeCode: tc ? tc.code : "", itemId: "", itemCode: "", note: "", fxRate: "" }); } }
      }
    }
    await h.run(async () => {
      if (ops.length) { const res = await commitDays(ops); if (res && res.error) return res; rep.n += ops.length; }
      for (const row of news) { const res = await c.api().saveCfLog(A(), h.logRow(row)); if (res && res.error) return res; rep.created++; }
      return { ok: true }; });
    const lines = []; if (rep.n) lines.push(`Collections and payments: <b>${rep.n}</b> day entr${rep.n > 1 ? "ies" : "y"} saved.`); if (rep.created) lines.push(`Cash with no line: <b>${rep.created}</b> new entr${rep.created > 1 ? "ies" : "y"}.`); if (rep.kept) lines.push(`<b>${rep.kept}</b> day${rep.kept > 1 ? "s were" : " was"} changed in the app after you downloaded the file, so the newer figure was kept (listed below).`); if (rep.skip) lines.push(`<b>${rep.skip}</b> row${rep.skip > 1 ? "s were" : " was"} not saved. Fix ${rep.skip > 1 ? "them" : "it"} in the file and upload again.`); if (!lines.length) lines.push("Nothing new to save. Everything in the file is already recorded.");
    S.m = { type: "result", title: "Upload finished", lines, notes: rep.notes }; h.drawModal();
  }
  async function weekView() {
    if (!c.libsReady("xlsx")) return; const X = c.XLSX(), wb = X.utils.book_new(), W = K().wk, days = weekDays(W), rows = weekRows(h.scopeUnits(), W);
    const out = [[`Collections and payments, week ${weekLabel(W)}`], [], ["Unit", "Collect or pay", "Code", "Customer or payee", "Description", "Category", "Bank", "Planned", "Collected or paid", "Remaining", ...days.map((d, i) => dayHead(d, i))]];
    rows.forEach((x) => out.push([h.uname(x.it.unit), x.it.kind === "in" ? "Collect" : "Pay", x.it.code, x.it.party, x.it.description, x.it.typeCode, x.banks.join(", "), Math.round(x.planned), Math.round(x.coll), Math.round(x.rem), ...days.map((d) => { const t = sum(x.lg.filter((l) => l.day === d), (l) => l.amount); return t ? Math.round(t) : ""; })]));
    X.utils.book_append_sheet(wb, c.sheetFromRows(out, [26, 12, 12, 30, 34, 14, 22, 14, 16, 14, ...days.map(() => 12)]), "Week"); await c.writeXlsx(wb, `Week ${W}.xlsx`, "Excel saved");
  }

  // ---------------- Excel: status, as the plan sheet ----------------
  const BLOCK = { 1: "ONE MONTH", 2: "TWO MONTHS", 3: "THREE MONTHS" };
  async function statusExcel() {
    const units = h.scopeUnits().filter((u) => h.canWrite(u)); if (!units.length) { c.toast("You can only download the sheet for a unit you can edit"); return; } const D = S.day, types = S.types.filter((t) => t.active).map((t) => t.code);
    const wb = await XL.newBook(c, (col) => { col(1, types.length ? types : [""], "L_Type"); }); if (!wb) return;
    const heads = ["Code", "Customer Name", "Description", "Category", "Amount", "Remark", "Date"], widths = [13, 30, 32, 14, 16, 22, 13];
    for (const u of units) {
      const ws = wb.addWorksheet(`${shortName(u)} Plan`.slice(0, 31), { views: [{ showGridLines: false }] }), all = allOpen(u, D);
      ws.getCell("A1").value = "Business unit"; ws.getCell("B1").value = h.uname(u); ws.getCell("A2").value = "As of"; ws.getCell("B2").value = XL.toDate(D); ws.getCell("B2").numFmt = "yyyy-mm-dd"; XL.bold(ws.getCell("A1")); XL.bold(ws.getCell("A2"));
      ws.getCell("D1").value = "Left of the gap column: collections. Right: payments. Change an amount, move a line to another block to change its month, add new rows (leave the code empty), or write DROP in Remark to take a line off the plan. Upload it to make it the plan."; ws.getCell("D1").font = { italic: true, color: { argb: "FF777777" } };
      [...widths, 3, ...widths].forEach((wd, i) => { ws.getColumn(i + 1).width = wd; });
      let r = 4;
      for (const b of [1, 2, 3]) {
        const inn = all.filter((x) => x.it.kind === "in" && x.it.bucket === b), out = all.filter((x) => x.it.kind === "out" && x.it.bucket === b), n = Math.max(inn.length, out.length) + 10;
        ws.getCell(r, 1).value = `COLLECTION WITHIN ${BLOCK[b]}`; ws.getCell(r, 9).value = `PAYMENT WITHIN ${BLOCK[b]}`; ws.getCell(r, 1).font = { bold: true, size: 12 }; ws.getCell(r, 9).font = { bold: true, size: 12 }; r++;
        XL.head(ws, r, heads); heads.forEach((t, i) => { const cell = ws.getCell(r, 9 + i); cell.value = t; cell.font = { bold: true, color: { argb: "FF2A2208" } }; XL.fill(cell, XL.YELLOW); cell.alignment = { horizontal: "center" }; cell.border = { bottom: { style: "thin" } }; }); r++;
        const first = r, last = r + n - 1;
        const put = (arr, c0) => arr.forEach((x, k) => { const rr = first + k, it = x.it; [it.code, it.party, it.description, it.typeCode, Math.round(x.v.left * 100) / 100, "", it.expected ? XL.toDate(String(it.expected).slice(0, 10)) : ""].forEach((val, i) => { ws.getCell(rr, c0 + i).value = val; if (i < 4) XL.fill(ws.getCell(rr, c0 + i), XL.GREY); }); });
        put(inn, 1); put(out, 9);
        for (let rr = first; rr <= last; rr++) for (const c0 of [1, 9]) { ws.getCell(rr, c0 + 4).numFmt = "#,##0.00"; ws.getCell(rr, c0 + 6).numFmt = "yyyy-mm-dd"; }
        XL.listV(ws, 4, first, last, "L_Type", "Pick a category.", true); XL.listV(ws, 12, first, last, "L_Type", "Pick a category.", true); XL.numV(ws, 5, first, last, 0); XL.numV(ws, 13, first, last, 0);
        ws.getCell(last + 1, 1).value = "Grand Total"; ws.getCell(last + 1, 9).value = "Grand Total"; XL.bold(ws.getCell(last + 1, 1)); XL.bold(ws.getCell(last + 1, 9));
        ws.getCell(last + 1, 5).value = { formula: `SUM(E${first}:E${last})` }; ws.getCell(last + 1, 13).value = { formula: `SUM(M${first}:M${last})` }; [5, 13].forEach((ci) => { ws.getCell(last + 1, ci).numFmt = "#,##0.00"; XL.bold(ws.getCell(last + 1, ci)); XL.fill(ws.getCell(last + 1, ci), XL.BLUE); });
        r = last + 4;
      }
    }
    XL.infoSheet(wb, "How to use this sheet", ["Each business unit has one sheet: collections on the left, payments on the right, in three blocks by month (within one month, two months, three months).", "Amount is what is left to collect or pay. Change it, or leave it.", "To move a line to another month, cut the row and paste it into the other block.", "New line: write it in an empty row, leave Code empty. Add the category and a date if you know them.", "To take a line off the plan, write DROP in Remark.", "Upload the file on Collections and payments, Status, “Upload a filled sheet as the plan”. Rows you did not touch stay as they are."]);
    await c.saveFile(`Plan sheet ${D}.xlsx`, await wb.xlsx.writeBuffer(), "Excel saved");
  }
  async function uploadStatus(file) {
    const units = h.writableUnits(); if (!units.length) { c.toast("You cannot edit any unit's cash flow"); return; } const bk = await XL.readBook(c, file); if (!bk) return; const { X, wb } = bk;
    const uMap = new Map(); units.forEach((u) => [h.uname(u), h.ushort(u), c.unitName(u), u].forEach((n) => uMap.set(XL.norm(n), u)));
    const sheets = XL.readSheets(X, wb, /plan$/i); if (!sheets.length) { c.toast("No “… Plan” sheet found. Use the sheet from Status."); return; }
    const rep = { skip: 0, notes: [], upd: 0, add: 0, drop: 0 }, bad = (sh, line, why) => { rep.skip++; rep.notes.push(`${sh} row ${line}: ${why}`); }, jobs = [];
    for (const sh of sheets) {
      const unit = uMap.get(XL.norm(sh.rows[0] && sh.rows[0][1])), asOf = XL.serialToIso(sh.rows[1] && sh.rows[1][1]) || c.todayIso; if (!unit) { bad(sh.name, 1, `unit “${sh.rows[0] && sh.rows[0][1]}” not found or not yours`); continue; } let b = 0;
      for (let i = 3; i < sh.rows.length; i++) { const r = sh.rows[i], line = i + 1, a0 = String(r[0]).trim();
        const t = /^collection/i.test(a0) ? a0 : ""; if (t) { b = /three|3/i.test(t) ? 3 : /two|2/i.test(t) ? 2 : /one|1/i.test(t) ? 1 : 0; continue; }
        if (!b || /^(code|grand)/i.test(a0) || /^(code|grand)/i.test(String(r[8]).trim())) continue;
        for (const [c0, kind] of [[0, "in"], [8, "out"]]) { const row = r.slice(c0, c0 + 7); if (!row.some((x) => String(x).trim() !== "")) continue;
          const [code, party, desc, cat, amtV, remark, dateV] = row, amt = XL.money(amtV), date = XL.serialToIso(dateV), tc = S.types.find((tt) => XL.norm(tt.code) === XL.norm(cat)), drop = /^\s*drop/i.test(String(remark));
          if (String(code).trim()) { const it = S.items.find((q) => q.unit === unit && q.code && q.code.toUpperCase() === String(code).trim().toUpperCase()); if (!it) { bad(sh.name, line, `no line with code ${code}`); continue; } if (it.kind !== kind) { bad(sh.name, line, `${code} is in the wrong side of the sheet`); continue; }
            jobs.push({ type: "line", it, b, amt, date, tc, drop, asOf, remark: String(remark).trim() }); }
          else { if (!String(party).trim() && !String(desc).trim()) { bad(sh.name, line, "write who it is, or a description"); continue; } if (drop) continue; if (amt === null || amt <= 0) { bad(sh.name, line, "a new line needs an amount"); continue; }
            jobs.push({ type: "new", unit, kind, b, amt, date, tc, party: String(party).trim(), desc: String(desc).trim(), remark: String(remark).trim() }); } }
      }
    }
    await h.run(async () => {
      for (const j of jobs) {
        if (j.type === "new") { const res = await c.api().saveCfItem(A(), h.itemRow({ unit: j.unit, kind: j.kind, party: j.party, description: j.desc, ref: "", typeCode: j.tc ? j.tc.code : "", bucket: j.b, amount: j.amt, total: j.amt, currency: "ETB", priority: "Normal", expected: j.date || "", status: "open", settledOn: "", note: j.remark, enteredOn: c.todayIso, section: "operating", unplanned: false, firstWeek: "" })); if (res && res.error) return res; rep.add++; continue; }
        const it = j.it, logged = sum(S.log.filter((l) => l.itemId === it.id && l.day <= j.asOf), (l) => l.amount), loggedNow = sum(S.log.filter((l) => l.itemId === it.id), (l) => l.amount);   // the sheet shows what was left as of its date
        if (j.drop) { if (it.status === "written_off") continue; const res = await c.api().saveCfItem(A(), h.itemRow({ ...it, status: "written_off", settledOn: c.todayIso, note: it.note ? it.note + " · dropped from the plan" : "Dropped from the plan" })); if (res && res.error) return res; rep.drop++; continue; }
        const total = j.amt !== null ? Math.round((logged + j.amt) * 100) / 100 : num(it.amount), left = j.amt !== null ? Math.max(0, total - loggedNow) : h.viewOf(it, c.todayIso).left;
        const same = Math.abs(total - num(it.amount)) < 0.005 && j.b === it.bucket && (!j.tc || j.tc.code === it.typeCode) && (!j.date || j.date === String(it.expected || "").slice(0, 10));
        if (same && !(it.status !== "open" && left > 0)) continue;
        const res = await c.api().saveCfItem(A(), h.itemRow({ ...it, amount: total, bucket: j.b, typeCode: j.tc ? j.tc.code : it.typeCode, expected: j.date || it.expected || "", status: left > 0.005 ? "open" : it.status, settledOn: left > 0.005 ? "" : it.settledOn })); if (res && res.error) return res; rep.upd++;
      }
      return { ok: true }; });
    const lines = []; if (rep.upd) lines.push(`Lines updated: <b>${rep.upd}</b>.`); if (rep.add) lines.push(`New lines added: <b>${rep.add}</b>.`); if (rep.drop) lines.push(`Lines taken off the plan: <b>${rep.drop}</b> (written off; open the line to bring it back).`); if (rep.skip) lines.push(`<b>${rep.skip}</b> row${rep.skip > 1 ? "s were" : " was"} not used. Fix ${rep.skip > 1 ? "them" : "it"} in the file and upload again.`); if (!lines.length) lines.push("Nothing to change. The file matches what is already planned.");
    S.m = { type: "result", title: "Upload finished", lines, notes: rep.notes }; h.drawModal();
  }

  // ---------------- PDF ----------------
  const pdfSt = () => { const b = c.pdfStyle(); b.styles = { ...b.styles, fontSize: 9, cellPadding: 4 }; b.headStyles = { ...b.headStyles, fontSize: 9 }; return b; };
  const foot = (doc, label) => { const n = doc.getNumberOfPages(), H = doc.internal.pageSize.getHeight(); for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(120, 120, 120); doc.text(`${label} · ${dShort(c.todayIso)} · Page ${i} of ${n}`, 36, H - 18); } };
  const scopeText = () => (h.scopeUnits().length === 1 ? h.uname(h.scopeUnits()[0]) : "All business units");
  const secTitle = (doc, text, y) => { if (y > 500) { doc.addPage(); y = 50; } doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(90, 70, 10); doc.text(text, 36, y); return y + 8; };
  async function pdfPlan(status) {
    if (!c.libsReady("pdf")) return; const units = h.scopeUnits(), many = units.length > 1, { list } = openLines(units, S.day);
    const doc = c.newPdf(status ? "Cash flow status" : "Cash flow plan", `${scopeText()}  ·  ${status ? "what is left, as of " + dShort(S.day) : "planned, as of " + dShort(S.day)}`); let y = 92;
    for (const b of [1, 2, 3]) { y = secTitle(doc, `${BUCKET_NAME[b]}  (${b} / ${b}${b})`, y);
      for (const kind of ["in", "out"]) { const ls = list.filter((x) => x.it.bucket === b && x.it.kind === kind), amt = (x) => status ? x.v.left : x.it.amount; if (!ls.length) continue;
        const body = []; groups(ls, (x) => catOf(x.it), (x) => conv(x.it, amt(x))).forEach(([cat, cl]) => { body.push([{ content: catLabel(cat), colSpan: 2, styles: { fontStyle: "bold", fillColor: [245, 240, 225] } }, { content: plain(sum(cl, (x) => conv(x.it, amt(x)))), styles: { fontStyle: "bold", halign: "right", fillColor: [245, 240, 225] } }]); cl.slice().sort((p, q) => conv(q.it, amt(q)) - conv(p.it, amt(p))).forEach((x) => body.push([clip(x.it.party || x.it.description, 48) + (many ? " · " + h.ushort(x.it.unit) : ""), clip(x.it.party ? x.it.description : "", 60), { content: plain(amt(x)), styles: { halign: "right" } }])); });
        body.push([{ content: "Total", colSpan: 2, styles: { fontStyle: "bold" } }, { content: plain(sum(ls, (x) => conv(x.it, amt(x)))), styles: { fontStyle: "bold", halign: "right" } }]);
        doc.autoTable({ startY: y, margin: { left: 36, right: 36 }, head: [[kind === "in" ? "Collections" : "Payments", "Description", status ? "Left" : "Amount"]], body, columnStyles: { 0: { cellWidth: 260 }, 1: { cellWidth: "auto" }, 2: { cellWidth: 90 } }, ...pdfSt() }); y = doc.lastAutoTable.finalY + 14; } }
    foot(doc, status ? "Cash flow status" : "Cash flow plan"); await c.save(`Cash flow ${status ? "status" : "plan"} ${S.day}.pdf`, doc.output("arraybuffer"), "PDF saved. Open it to print.");
  }
  async function pdfActual() {
    if (!c.libsReady("pdf")) return; const units = h.scopeUnits(), W = K().wk, days = weekDays(W), rows = weekRows(units, W), many = units.length > 1;
    const doc = c.newPdf("Cash flow, the week", `${scopeText()}  ·  ${weekLabel(W)}`); let y = 92;
    for (const kind of ["in", "out"]) { const rs = rows.filter((r) => r.it.kind === kind); y = secTitle(doc, kind === "in" ? "Collections" : "Payments", y); if (!rs.length) { doc.setFontSize(9); doc.setTextColor(120, 120, 120); doc.text("Nothing for this week.", 36, y + 14); y += 30; continue; }
      const body = rs.map((r) => [clip(r.it.party || r.it.description, 34) + (many ? " · " + h.ushort(r.it.unit) : ""), r.banks.join(", ") || "", ...[r.planned, r.coll, r.rem].map((v) => ({ content: plain(v), styles: { halign: "right" } })), ...days.map((d) => { const t = sum(r.lg.filter((l) => l.day === d), (l) => l.amount); return { content: t ? plain(t) : "", styles: { halign: "right" } }; })]);
      const tl = (f) => ({ content: plain(sum(rs, f)), styles: { fontStyle: "bold", halign: "right" } });
      body.push([{ content: "Total", styles: { fontStyle: "bold" } }, "", tl((r) => conv(r.it, r.planned)), tl((r) => conv(r.it, r.coll)), tl((r) => conv(r.it, r.rem)), ...days.map((d) => tl((r) => conv(r.it, sum(r.lg.filter((l) => l.day === d), (l) => l.amount))))]);
      doc.autoTable({ startY: y, margin: { left: 30, right: 30 }, head: [[kind === "in" ? "Customer" : "Payee", "Bank", "Planned", kind === "in" ? "Collected" : "Paid", "Remaining", ...days.map((d, i) => dayHead(d, i))]], body, columnStyles: { 0: { cellWidth: 150 }, 1: { cellWidth: 70 } }, ...pdfSt() }); y = doc.lastAutoTable.finalY + 16; }
    foot(doc, "Cash flow, the week"); await c.save(`Cash flow week ${W}.pdf`, doc.output("arraybuffer"), "PDF saved. Open it to print.");
  }

  // ---------------- events ----------------
  async function onAction(el) {
    const x = el.dataset.cf, v = el.dataset.v, k = K(), m = S.m;
    if (x === "k-tab") { k.tab = v; c.render(); }
    else if (x === "k-x") { k.open[el.dataset.key] = !isOpen(el.dataset.key); c.render(); }
    else if (x === "k-all") { k.all = v === "1"; k.open = {}; c.render(); }
    else if (x === "k-shift") { k.wk = addDays(k.wk, Number(v)); k.kd = {}; c.render(); }
    else if (x === "k-today") { k.wk = weekStart(c.todayIso); k.kd = {}; c.render(); }
    else if (x === "k-save") await saveGrid();
    else if (x === "k-open") { if (k.pn === el.dataset.id) tryClose(); else if (k.pn && isDirty()) { if (k.pn === "__new") k.nf = readNew(); else k.pd = readDrawer(); k.pwarn = true; c.render(); } else { k.pn = el.dataset.id; k.pd = null; k.nf = null; k.pwarn = false; c.render(); } }
    else if (x === "k-pclose") tryClose();
    else if (x === "k-pdiscard") { k.pn = null; k.pd = null; k.nf = null; k.pwarn = false; c.render(); }
    else if (x === "k-newline") { if (k.pn && isDirty()) { if (k.pn === "__new") k.nf = readNew(); else k.pd = readDrawer(); k.pwarn = true; c.render(); } else { k.pn = "__new"; k.nf = null; k.pd = null; k.pwarn = false; c.render(); } }
    else if (x === "k-nsave") await saveNew();
    else if (x === "k-drange") { k.dn.range = v; if (v === "custom" && !k.dn.from) { k.dn.from = addDays(c.todayIso, -29); k.dn.to = c.todayIso; } c.render(); }
    else if (x === "k-dby") { k.dn.by = v; c.render(); }
    else if (x === "k-ddl") await doneExcel();
    else if (x === "k-fold") { k.fold[v] = !k.fold[v]; c.render(); }
    else if (x === "k-padd") { k.pd = readDrawer(); (k.pd[el.dataset.day] = k.pd[el.dataset.day] || []).push({ id: "", bank: "", amount: "" }); c.render(); }
    else if (x === "k-pdel") { k.pd = readDrawer(); const rs = k.pd[el.dataset.day] || []; rs.splice(Number(el.dataset.j), 1); c.render(); }
    else if (x === "k-psave") await saveDrawer();
    else if (x === "k-split") openSplit(el.dataset.id, el.dataset.day || "");
    else if (x === "k-split-add" && m) { readSplit(); const it = S.items.find((q) => q.id === m.itemId); m.rows.push({ id: "", bank: it ? h.lastBank(it.unit, it.kind) : "", amount: "" }); h.drawModal(); }
    else if (x === "k-split-del" && m) { readSplit(); m.rows.splice(Number(el.dataset.i), 1); if (!m.rows.length) m.rows.push({ id: "", bank: "", amount: "" }); h.drawModal(); }
    else if (x === "k-split-day" && m) { readSplit(); const it = S.items.find((q) => q.id === m.itemId); m.ask = false; m.rows = S.log.filter((l) => l.itemId === m.itemId && l.day === m.day).map((l) => ({ id: l.id, bank: l.bank, amount: l.amount })); m.orig = m.rows.map((r) => r.id); if (!m.rows.length) m.rows = [{ id: "", bank: it ? h.lastBank(it.unit, it.kind) : "", amount: "" }]; h.drawModal(); }
    else if (x === "k-split-save") await saveSplit();
    else if (x === "k-dl") { if (v === "wk") await weekTemplate(false); else if (v === "wkview") await weekView(); else await statusExcel(); }
    else if (x === "k-pick") { const i = document.getElementById(v === "wk" ? "ckUploadWk" : "ckUploadSt"); if (i) i.click(); }
    else if (x === "k-pdf") { if (v === "plan") await pdfPlan(false); else if (v === "status") await pdfPlan(true); else if (v === "done") await pdfDone(); else if (v === "actual") await pdfActual(); else await h.summaryPdf(); }
  }
  function onSearch(t) { K().q = t.value; clearTimeout(onSearch.t); onSearch.t = setTimeout(() => { c.render(); const e = document.querySelector('[data-kq]'); if (e) { e.focus(); e.setSelectionRange(e.value.length, e.value.length); } }, 250); }
  function onDone(t) { K().dn[t.dataset.kdn] = t.value; c.render(); }
  function onNewChange() { K().nf = readNew(); c.render(); }
  function onWeek(t) { if (t.value) { K().wk = weekStart(t.value); K().kd = {}; c.render(); } }
  return { onDone, onNewChange, onOutside, renderColl, onAction, onInput, onBank, onSearch, onWeek, splitForm, uploadWeek, uploadStatus };
}
