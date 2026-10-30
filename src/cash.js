// Cash flow. Seven tabs: Summary, Weekly plan (the weekly statement), Collections & payments and Bank (the two daily sheets),
// Reconcile, Forecast (plan against actual, by type, monthly forecast lines) and Setup.
// Shown to Group Finance only (and the super admin who looks after the app).
import { createWeek } from "./cashweek.js";
import { createDay } from "./cashday.js";
import { createSheet } from "./cashsheet.js";
import { SECTIONS, PLAN_SECTIONS, PRIORITIES, CURRENCIES, bucketCode, BUCKET_TEXT, FIN_UNITS_FALLBACK, impliedDate, num, sum, addDays, addMonths, monthOf, keyOf, periods, periodLabel, periodEnd, isOpenAt, etb, bankAt, bankDays, position, funding, timeline, byType, planByMonth, HORIZON, MONTHS } from "./cashcalc.js";

const weekStartOf = (iso) => { const d = new Date(iso + "T00:00:00Z").getUTCDay(); return addDays(iso, -((d + 6) % 7)); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const SHORT = { "wagwago-electric": "Wagwago Trading", trucksload: "TrucksLoad", geez: "Geez", "niyat-consultancy": "Niyat", "wanza-logistics": "Wanza" };
const FULL = { "wagwago-electric": "Wagwago Trading (Electric and Corporate)" };
const PRI_RANK = { High: 0, Normal: 1, Low: 2 };
const TABS = [["summary", "Summary"], ["week", "Weekly plan"], ["coll", "Collections & payments"], ["bank", "Bank"], ["recon", "Reconcile"], ["forecast", "Forecast"], ["setup", "Setup"]];
const serialToIso = (v) => { if (v === "" || v == null) return ""; if (typeof v === "number") return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10); const s = String(v).trim(); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[0] : ""; };
const bucketOf = (v) => { const x = parseInt(String(v).trim(), 10); return x === 1 || x === 11 ? 1 : x === 2 || x === 22 ? 2 : x === 3 || x === 33 ? 3 : 0; };

export function createCash(c) {
  const { state, esc } = c;
  const S = (state.cf = { items: [], itemsAll: [], logAll: [], undo: null, calOpen: false, calMonth: "", types: [], bank: [], log: [], plan: [], settings: {}, loaded: 0, view: "summary", asOf: c.todayIso, scope: "all", bk: { 1: true, 2: true, 3: true }, typeOn: {}, mode: "month", day: c.todayIso, range: 60, dr: {}, bd: {}, dq: { kind: "", q: "", show: 30 }, busy: false, m: null, week: [], wk: weekStartOf(c.todayIso), rc: { range: 14, all: false }, rp: { from: "" },
    lf: { kind: "", type: "", status: "active", q: "", show: 40 }, pf: { from: "", unit: "all" } });
  const A = () => c.auth() || {};
  const full = () => A().role === "super_admin" || A().unit === "group-finance-function";
  const admin = () => A().role === "super_admin" || A().unit === "group-finance-function";
  const canSee = () => full();
  const canWrite = () => admin();
  const canWriteAny = () => admin();
  const allUnits = () => { const bu = c.sortedUnits().filter((u) => u.type === "Business unit").map((u) => u.id); const ids = bu.length ? bu : FIN_UNITS_FALLBACK; return full() ? ids : [A().unit]; };
  const scopeUnits = () => (S.scope === "all" || !allUnits().includes(S.scope) ? allUnits() : [S.scope]);
  const writableUnits = () => allUnits().filter((u) => canWrite(u));
  const ushort = (u) => SHORT[u] || c.unitName(u);
  const uname = (u) => FULL[u] || c.unitName(u);
  const fx = () => num(S.settings.usd_etb);
  const typeByCode = (code) => S.types.find((t) => t.code === code);
  const plain = (v) => Math.round(num(v)).toLocaleString("en-US");
  const money = (v, dash) => { const x = Math.round(num(v)); return x === 0 && dash !== false ? '<span class="muted">–</span>' : `<span class="${x < 0 ? "neg" : ""}">${x < 0 ? "−" : ""}${Math.abs(x).toLocaleString("en-US")}</span>`; };
  const compact = (v) => { const x = num(v), a = Math.abs(x), s = x < 0 ? "−" : ""; return a >= 1e9 ? s + (a / 1e9).toFixed(2) + " B" : a >= 1e6 ? s + (a / 1e6).toFixed(1) + " M" : a >= 1e3 ? s + (a / 1e3).toFixed(0) + " K" : s + Math.round(a); };
  const pct = (a, b) => (num(b) > 0 ? Math.round((num(a) / num(b)) * 100) + "%" : '<span class="muted">–</span>');
  const dShort = (iso) => { if (!iso) return ""; const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
  const msg = (r) => (r && r.error ? (r.error === "exists" ? "That code already exists" : c.errText(r)) : "");

  // ---------------- data ----------------
  let subs = [];
  function subscribe() {
    if (!c.db() || subs.length || !canSee()) return;
    const on = (col, key, order, fn) => c.db().collection(col).orderBy(order).limit(10000).onSnapshot((snap) => { const arr = fn ? fn(snap) : snap.docs.map((d) => ({ id: d.id, ...d.data() })); if (key === "items" || key === "log") { S[key + "All"] = arr; S[key] = arr.filter((x) => !x.deletedAt); } else S[key] = arr; S.loaded++; if (state.tab === "cashflow" && !S.m && !S.busy) c.render(); }, () => { S.loaded++; });
    subs = [on("cftypes", "types", "sort"), on("cfitems", "items", "createdAt"), on("cfbank", "bank", "day"), on("cflog", "log", "day"), on("cfplan", "plan", "month"), on("cfweek", "week", "week"),
      on("cfsettings", "settings", "updatedAt", (snap) => Object.fromEntries(snap.docs.map((d) => [d.id, d.data().value])))];
  }
  // Run one or more saves under a lock. fn returns the last api result; the first error stops everything and is shown.
  async function run(fn, okMsg) {
    if (S.busy) return false; S.busy = true;
    try { const r = await fn(); if (r && r.error) { c.toast(msg(r)); return false; } if (okMsg) c.toast(okMsg); return r || true; }
    catch (e) { c.toast(c.errText(e)); return false; }
    finally { S.busy = false; c.render(); }
  }
  const itemRow = (it) => ({ id: it.id, unit: it.unit, kind: it.kind, party: it.party, description: it.description, ref: it.ref, typeCode: it.typeCode, bucket: it.bucket, amount: it.amount, total: it.total ?? "", currency: it.currency, priority: it.priority, expected: it.expected || "", status: it.status, settledOn: it.settledOn || "", note: it.note, enteredOn: it.enteredOn, section: it.section || "", unplanned: !!it.unplanned, firstWeek: it.firstWeek || "" });
  const logRow = (l) => ({ fxRate: l.fxRate ?? "", id: l.id, unit: l.unit, day: l.day, kind: l.kind, bank: l.bank, amount: l.amount, currency: l.currency, party: l.party, description: l.description, typeCode: l.typeCode, itemId: l.itemId || "", itemCode: l.itemCode || "", note: l.note });

  // How much of each planned line has been collected or paid (from the daily log), up to a date.
  const loggedFor = (itemId, upTo, skipId) => sum(S.log.filter((l) => l.itemId === itemId && l.id !== skipId && (!upTo || l.day <= upTo)), (l) => l.amount);
  const doneOf = (it) => { const lg = S.log.filter((l) => l.itemId === it.id); return lg.length ? sum(lg, (l) => l.amount) : (it.status === "settled" ? num(it.amount) : 0); };
  // Lines as they stand on the as-of date: the amount left to collect or pay.
  function effItems(asOf) {
    return S.items.map((it) => { const done = loggedFor(it.id, asOf); return done ? { ...it, amount: Math.max(0, num(it.amount) - done) } : it; })
      .filter((it) => !(num(it.amount) <= 0 && it.status === "open"));
  }
  // Types that count in the position: the type's own setting unless this screen overrides it.
  const typesEff = () => S.types.map((t) => ({ ...t, expected: S.typeOn[t.code] === undefined ? t.expected : S.typeOn[t.code] }));
  const inScope = (units, asOf) => effItems(asOf).filter((it) => units.includes(it.unit) && S.bk[it.bucket]);
  // Money that really moved per period: the daily log where one exists for that unit and day, else the bank report's in and out.
  function actuals(units, asOf, mode) {
    const out = {}, add = (day, kind, v) => { const k = keyOf(day, mode); (out[k] = out[k] || { in: 0, out: 0 })[kind] += v; };
    const savedKey = new Set(S.bank.map((b) => b.unit + "|" + b.bank + "|" + b.day));
    for (const b of S.bank) if (units.includes(b.unit) && b.day <= asOf) { add(b.day, "in", num(b.inflow)); add(b.day, "out", num(b.outflow)); }
    for (const l of S.log) if (units.includes(l.unit) && l.day <= asOf && !savedKey.has(l.unit + "|" + (l.bank || "") + "|" + l.day)) add(l.day, l.kind, etb(l, fx()));
    return out;
  }
  // Saved bank balances, plus the days that only have a daily log: the last balance of that bank moved by the day's cash.
  function effBank() {
    const rows = [...S.bank], key = (u, b) => u + "|" + b, last = {}; const saved = new Set(S.bank.map((b) => key(b.unit, b.bank) + "|" + b.day));
    const events = new Map(); for (const l of S.log) { if (!l.bank) continue; const k = key(l.unit, l.bank) + "|" + l.day; const e = events.get(k) || { unit: l.unit, bank: l.bank, day: l.day, inn: 0, out: 0 }; e[l.kind === "in" ? "inn" : "out"] += num(l.amount); events.set(k, e); }
    const all = [...S.bank.map((b) => ({ ...b, ev: false })), ...[...events.values()].map((e) => ({ unit: e.unit, bank: e.bank, day: e.day, ev: true, e }))].sort((a, b) => a.day.localeCompare(b.day));
    for (const x of all) { const k = key(x.unit, x.bank);
      if (!x.ev) { last[k] = num(x.closing); continue; }
      if (saved.has(k + "|" + x.day)) continue;
      const open = last[k] || 0, close = open + x.e.inn - x.e.out; rows.push({ id: "log|" + k + "|" + x.day, unit: x.unit, bank: x.bank, day: x.day, opening: open, inflow: x.e.inn, outflow: x.e.out, closing: close, synthetic: true }); last[k] = close; }
    return rows;
  }
  // Bank reports as entered on the Bank page. Collections and payments never write to them: Reconcile compares the two.
  const realBank = () => S.bank;
  const knownBanks = (unit) => { const all = [...new Set([...S.bank.filter((b) => b.unit === unit).map((b) => b.bank), ...S.log.filter((l) => l.unit === unit && l.bank).map((l) => l.bank)])].sort(); const named = all.filter((b) => b !== "All banks"); return named.length ? named : all; };
  // The bank a unit used last for money in or out: the default on the day sheet.
  const lastBank = (unit, kind) => { const l = S.log.filter((q) => q.unit === unit && q.bank && q.kind === kind).sort((a, b) => b.day.localeCompare(a.day))[0]; return l ? l.bank : knownBanks(unit)[0] || ""; };
  const planDate = (it, asOf) => (it.expected ? String(it.expected).slice(0, 10) : impliedDate(it.bucket, it.enteredOn && it.enteredOn > "2000" ? it.enteredOn : asOf));

  // ---------------- shared pieces ----------------
  const chip = (on, attrs, label, tip) => `<button type="button" class="cf-chip${on ? " on" : ""}" ${attrs} aria-pressed="${on}" ${tip ? `title="${esc(tip)}"` : ""}>${label}</button>`;
  const unitSel = (val) => `<select data-cfc="scope" aria-label="Unit">${`<option value="all">${full() ? "All business units" : "My unit"}</option>`}${allUnits().map((u) => `<option value="${esc(u)}" ${val === u ? "selected" : ""}>${esc(uname(u))}</option>`).join("")}</select>`;
  const urgencyChips = () => `<span class="cf-group" role="group" aria-label="Urgency">${[1, 2, 3].map((b) => chip(S.bk[b], `data-cf="bk" data-v="${b}"`, `${b} <span class="muted">/ ${b}${b}</span>`, BUCKET_TEXT[b])).join("")}</span>`;
  const typeToggles = () => {
    const ts = typesEff().filter((t) => t.active), n = ts.filter((t) => t.expected).length;
    return `<details class="cf-inc"><summary>Counted types <span class="muted">${n} of ${ts.length}</span></summary><div class="cf-incbox"><div class="small muted">Tick the types that are expected to be collected or paid. Untick, for example, related parties that are not expected to pay soon. Hover a type for its meaning.</div>
      <div class="cf-chips">${ts.map((t) => chip(t.expected, `data-cf="type-on" data-code="${esc(t.code)}"`, esc(t.code), (t.label && t.label !== t.code ? t.label + ". " : "") + (t.description || ""))).join("")}</div>
      ${Object.keys(S.typeOn).length ? `<button class="btn small" data-cf="type-reset">Back to the saved settings</button>` : ""}</div></details>`;
  };
  const usdWarn = () => { const n = S.items.filter((i) => i.currency === "USD" && i.status === "open").length; return n && !fx() ? `<div class="cf-note warn">${n} open item${n > 1 ? "s are" : " is"} in USD and left out of the totals until the USD rate is set in Setup.</div>` : ""; };
  const menu = (items) => { const ls = items.filter(Boolean); return ls.length ? `<details class="cf-menu"><summary class="btn small" aria-label="More" title="More">⋯</summary><div class="cf-menu-list">${ls.map(([a, t]) => `<button type="button" class="cf-menu-item" ${a}>${esc(t)}</button>`).join("")}</div></details>` : ""; };
  const stat = (k, v, sub, cls) => `<div class="cf-stat ${cls || ""}"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
  const _unusedExcelBar = () => `<span class="cf-group"><button class="btn small" data-cf="w-day-down" title="The day's sheet with every open line prefilled">Download daily template</button><label class="btn small" title="Fill the moved column and the bank sheet, then upload">Upload day<input type="file" id="cfUploadDay" accept=".xlsx,.xls" hidden></label></span>`;

  // One day for the whole page: the Summary, Report, Daily log and the lines all show that day.
  function setDay(d) { if (!d) return; S.asOf = S.day = d; S.calOpen = false; S.calMonth = monthOf(d); c.render(); }
  // Days when cash moved (for the dots on the calendar): the daily log, and lines settled before the log existed.
  function movesByDay(units) {
    const m = {}, add = (day, kind, v) => { (m[day] = m[day] || { in: 0, out: 0 })[kind] += v; }, withLog = new Set(S.log.map((l) => l.itemId));
    for (const l of S.log) if (units.includes(l.unit)) add(l.day, l.kind, etb(l, fx()));
    for (const i of S.items) if (units.includes(i.unit) && i.status === "settled" && i.settledOn && !withLog.has(i.id)) add(i.settledOn, i.kind, etb(i, fx()));
    return m;
  }
  function calendar() {
    const ym = S.calMonth || monthOf(S.day), [y, mo] = ym.split("-").map(Number), first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay(), lead = (first + 6) % 7, days = new Date(Date.UTC(y, mo, 0)).getUTCDate(), mv = movesByDay(scopeUnits());
    const cells = []; for (let i = 0; i < lead; i++) cells.push('<span></span>');
    for (let d = 1; d <= days; d++) { const iso = `${ym}-${String(d).padStart(2, "0")}`, x = mv[iso], tip = x ? `${x.in ? "Collected " + plain(x.in) : ""}${x.in && x.out ? " · " : ""}${x.out ? "Paid " + plain(x.out) : ""}` : "";
      cells.push(`<button type="button" class="cf-cal-d${iso === S.day ? " sel" : ""}${iso === c.todayIso ? " today" : ""}" data-cf="cal-pick" data-v="${iso}" ${tip ? `title="${esc(tip)}"` : ""}>${d}<span class="cf-dots">${x && x.in ? '<i class="dot in"></i>' : ""}${x && x.out ? '<i class="dot out"></i>' : ""}</span></button>`); }
    return `<div class="cf-cal" role="dialog" aria-label="Choose a day"><div class="cf-cal-h"><button class="btn small" data-cf="cal-month" data-v="-1" aria-label="Previous month">‹</button><b>${esc(periodLabel(ym, "month"))}</b><button class="btn small" data-cf="cal-month" data-v="1" aria-label="Next month">›</button></div>
      <div class="cf-cal-g">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((x) => `<small>${x}</small>`).join("")}${cells.join("")}</div>
      <div class="cf-cal-k small muted"><i class="dot in"></i> collected <i class="dot out"></i> paid</div></div>`;
  }
  const dayBar = () => `<div class="cf-daybar"><span class="cf-lab">Day</span><button class="btn small" data-cf="day-shift" data-v="-1" aria-label="Previous day">‹</button><span class="cf-calwrap"><button class="btn cf-daybtn" data-cf="cal-toggle" aria-expanded="${S.calOpen}">${esc(dShort(S.day))} ▾</button>${S.calOpen ? calendar() : ""}</span><button class="btn small" data-cf="day-shift" data-v="1" aria-label="Next day">›</button>${S.day !== c.todayIso ? `<button class="btn small" data-cf="day-today">Today</button><span class="small muted">${S.day < c.todayIso ? "Looking back: everything on this page shows the position at the end of this day." : "A future day."}</span>` : '<span class="small muted">Today. Pick another day to see its position, or the dots for days when cash moved.</span>'}</div>`;
  const undoBar = () => (S.uu ? `<div class="cf-note cf-undo">${esc(S.uu.label)} was applied. <button class="btn small" data-cf="w-undo-up">Undo</button> <button class="btn small ghost" data-cf="w-undo-x">Dismiss</button></div>` : "") + (S.undo ? `<div class="cf-note cf-undo">${esc(S.undo.label)} was deleted. <button class="btn small" data-cf="undo">Undo</button> <button class="btn small ghost" data-cf="undo-x">Dismiss</button></div>` : "");
  // ---------------- page shell ----------------
  function renderCash() {
    if (!canSee()) return `<div class="cf"><div class="empty"><b>Cash flow</b>Cash flow is shown to Group Finance only.</div></div>`;
    subscribe();
    const nav = `<div class="cf-nav"><div class="cf-tabs">${TABS.map((t) => `<button class="cf-tab${S.view === t[0] ? " on" : ""}" data-cf="view" data-v="${t[0]}">${t[1]}</button>`).join("")}</div></div>`;
    const body = { summary: renderSummary, week: () => W.renderWeek(), coll: () => K.renderColl(), bank: () => D.renderBank(), recon: () => W.renderReconcile(), forecast: renderForecast, setup: renderSetup }[S.view]();
    return `<div class="cf">${dayBar()}${undoBar()}${nav}${S.loaded < 3 ? `<div class="small muted cf-pad">Loading…</div>` : ""}${body}</div>`;
  }

  // Which categories count. Visible on the Summary: tap a category to leave it out of (or bring it back into) every figure.
  function countedBox(units, asOf) {
    const ts = typesEff().filter((t) => t.active), its = effItems(asOf).filter((it) => units.includes(it.unit) && S.bk[it.bucket]);
    const amt = (code, kind) => sum(its.filter((it) => (it.typeCode || "") === code && it.kind === kind), (it) => etb(it, fx()));
    const list = ts.flatMap((t) => ["in", "out"].filter((k) => !t.kind || t.kind === "both" || t.kind === k).map((k) => ({ t, k, a: amt(t.code, k) }))).filter((x) => x.a > 0 || !x.t.expected);
    const rows = list, uniq = new Map(rows.map((x) => [x.t.code, x.t])), on = [...uniq.values()].filter((t) => t.expected).length, open = !!S.cntOpen;
    const grp = (kind, title) => { const own = rows.filter((x) => x.k === kind); if (!own.length) return "";
      return `<div class="cf-cnt-grp"><div class="cf-cnt-h"><b>${title}</b><span class="cf-group"><button type="button" class="btn small ghost" data-cf="type-all" data-v="1" data-kind="${kind}">All</button><button type="button" class="btn small ghost" data-cf="type-all" data-v="0" data-kind="${kind}">None</button></span></div>${own.map(({ t, a }) => `<button type="button" class="cf-chk${t.expected ? " on" : ""}" role="checkbox" aria-checked="${!!t.expected}" data-cf="type-on" data-code="${esc(t.code)}" title="${esc((t.label && t.label !== t.code ? t.label + ". " : "") + (t.description || ""))}"><span class="cf-box">${t.expected ? "✓" : ""}</span><span class="cf-chk-n">${esc(t.code)}${t.label && t.label !== t.code ? ` <span class="muted">${esc(t.label)}</span>` : ""}</span><span class="muted cf-chk-a">${a ? compact(a) : ""}</span></button>`).join("")}</div>`; };
    return `<div class="cf-cntdd"><button type="button" class="btn cf-cnt-btn" data-cf="cnt-toggle" aria-expanded="${open}">What is counted: <b>${on} of ${uniq.size}</b> categories ▾</button>${open ? `<div class="cf-cnt-pop" role="group" aria-label="What is counted"><div class="cf-cnt-top"><span class="small muted">Tick what you expect to be collected or paid. Untick what you do not. Figures change at once.</span><span class="cf-group"><button type="button" class="btn small" data-cf="type-all" data-v="1" data-kind="">Select all</button><button type="button" class="btn small" data-cf="type-all" data-v="0" data-kind="">Clear all</button>${Object.keys(S.typeOn).length ? '<button type="button" class="btn small" data-cf="type-reset">Saved settings</button>' : ""}<button type="button" class="btn small primary" data-cf="cnt-toggle">Done</button></span></div><div class="cf-cnt-cols">${grp("in", "To collect")}${grp("out", "To pay")}</div></div>` : ""}</div>`;
  }
  // ---------------- Summary ----------------
  function renderSummary() {
    const units = scopeUnits(), asOf = S.asOf, pos = position(inScope(units, asOf), effBank(), typesEff(), asOf, units, { fx: fx() }), t = pos.total, posNow = { rows: pos.rows.map((r) => ({ ...r, b: [r.b[0]], need: Math.max(0, -r.b[0]) })), total: { ...pos.total, b: [pos.total.b[0]], need: Math.max(0, -pos.total.b[0]), needUnits: sum(pos.rows, (r) => Math.max(0, -r.b[0])) } }, fu = funding(posNow), nowNeed = Math.max(0, -t.b[0]);
    const days = bankDays(realBank(), units).filter((d) => d <= asOf), last = days[days.length - 1] || "", sel = [1, 2, 3].filter((b) => S.bk[b]);
    const realNow = sum(units, (u) => bankAt(realBank(), u, asOf).total), lastB = sel.length ? sel[sel.length - 1] : 0, endBal = lastB ? t.b[lastB - 1] : t.bank;
    // what already moved, from the daily log: today and this week (Monday to the chosen day)
    const wk0 = weekStartOf(asOf), moved = (u, from) => { const ls = S.log.filter((l) => (u === "all" ? units.includes(l.unit) : l.unit === u) && l.day >= from && l.day <= asOf); return { in: sum(ls.filter((l) => l.kind === "in"), (l) => etb(l, fx())), out: sum(ls.filter((l) => l.kind === "out"), (l) => etb(l, fx())) }; };
    const needNow = (r) => Math.max(0, -r.b[0]), STEPN = { 1: "this month", 2: "next month", 3: "the month after" };
    const stepHead = sel.map((b) => `<th class="num" title="${esc(BUCKET_TEXT[b])}">After step ${b}<div class="small muted">${STEPN[b]}</div></th>`).join("");
    const stepCell = (r, b) => `<td class="num cf-stepc"><div class="cf-pos ${r.b[b - 1] < 0 ? "neg" : ""}">${money(r.b[b - 1], false)}</div><div class="cf-stmini"><span class="in">+${compact(r.c[b - 1])}</span><span class="out">−${compact(r.p[b - 1])}</span></div></td>`;
    const mvTxt = (u) => { const d = moved(u, asOf), w = moved(u, wk0); return d.in || d.out || w.in || w.out ? `<div class="small muted">Cash recorded: today in ${compact(d.in)}, out ${compact(d.out)} · this week in ${compact(w.in)}, out ${compact(w.out)}</div>` : ""; };
    const row = (r, tot) => `<tr class="${tot ? "tot" : ""}${needNow(r) > 0 ? " cf-bad" : ""}"><td><b>${tot ? "Total" : esc(uname(r.unit))}</b>${!tot && !r.hasBank ? '<div class="small muted">no bank balance yet</div>' : !tot && r.bankDay ? `<div class="small muted">bank balance of ${esc(dShort(r.bankDay))}${r.bankDay !== last ? "" : ""}</div>` : ""}${mvTxt(tot ? "all" : r.unit)}</td>
      <td class="num">${money(r.bank)}</td>${sel.map((b) => stepCell(r, b)).join("")}<td class="num">${needNow(r) > 0 ? `<b class="neg">${plain(needNow(r))}</b>` : '<span class="muted">None</span>'}${r.need > needNow(r) ? `<div class="small muted">more later: ${plain(r.need - needNow(r))}</div>` : ""}</td></tr>`;
    const hasData = pos.rows.some((r) => r.hasBank || r.c.some(Boolean) || r.p.some(Boolean));
    const ladder = !hasData ? "" : `<ol class="cf-ladder"><li class="base"><span>Bank balance now</span><b>${money(t.bank)}</b></li>${sel.filter((b) => b === sel[0] || t.c[b - 1] || t.p[b - 1]).map((b) => `<li class="in"><span>▲ Still to collect <small>step ${b} · ${STEPN[b]}</small></span><b>+${money(t.c[b - 1], false)}</b></li><li class="out"><span>▼ Still to pay <small>step ${b} · ${STEPN[b]}</small></span><b>−${money(t.p[b - 1], false)}</b></li><li class="res${t.b[b - 1] < 0 ? " neg" : ""}"><span>= Position after step ${b}</span><b>${money(t.b[b - 1], false)}</b></li>`).join("")}</ol>`;
    const fund = !hasData ? "" : nowNeed > 0
      ? `<p class="lead"><b>Financing needed now: ${plain(nowNeed)}.</b> This is the shortfall within the coming month: the bank balance plus what is due to be collected, minus what is due to be paid (step 1 − 11). ${t.need > nowNeed ? `Later steps would need ${plain(t.need - nowNeed)} more.` : ""}</p>`
      : fu.short.length ? `<p class="lead"><b>The group is positive now, but ${fu.short.length} unit${fu.short.length > 1 ? "s run" : " runs"} short.</b> Units with spare cash can cover them, for example by a sister company loan.</p>`
      : `<p class="lead"><b>No shortfall now.</b> ${t.need > 0 ? `Later steps would need ${plain(t.need)}: see the table.` : "Every unit stays above zero in the steps shown."}</p>`;
    const fundDetail = !hasData || !(fu.short.length || fu.rich.length) ? "" : `${fu.short.length ? `<div class="small">Short: ${fu.short.map((r) => `<b>${esc(ushort(r.unit))}</b> needs ${plain(r.need)}`).join(" · ")}</div>` : ""}${fu.rich.length ? `<div class="small">Spare cash: ${fu.rich.map((r) => `<b>${esc(ushort(r.unit))}</b> ${plain(r.spare)}`).join(" · ")}</div>` : ""}${fu.short.length ? `<div class="small">Covered inside the group: <b>${plain(Math.min(fu.internal, fu.spare))}</b>. Needs outside financing or later payment dates: <b class="${fu.external > 0 ? "neg" : ""}">${plain(fu.external)}</b>.</div>` : ""}`;
    return `<div class="cf-body">
      <div class="cf-filters">${allUnits().length > 1 ? unitSel(S.scope) : ""}${urgencyChips()}${countedBox(units, asOf)}</div>
      <div class="cf-sum wide"><div class="cf-sum-r">
      ${usdWarn()}
      <div class="cf-asof small muted">Live position as of <b>${esc(dShort(asOf))}</b>${asOf === c.todayIso ? " " + new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : ""}. Bank balances and what is left to collect or pay change as the day's cash is recorded.</div>
      <div class="cf-stats">${stat("Bank balance now", compact(t.bank), (last ? "bank report " + dShort(last) : "none entered") + (Math.abs(t.bank - realNow) > 0.5 ? ` · ${t.bank - realNow > 0 ? "+" : "−"}${compact(Math.abs(t.bank - realNow))} recorded since` : ""))}${stat("Still to collect", compact(sum(sel, (b) => t.c[b - 1])), sel.map((b) => `${b}: ${compact(t.c[b - 1])}`).join(" · ") || "no step chosen", "good")}${stat("Still to pay", compact(sum(sel, (b) => t.p[b - 1])), sel.map((b) => `${b}${b}: ${compact(t.p[b - 1])}`).join(" · ") || "no step chosen", "warn")}${stat("Balance at the end", `<span class="${endBal < 0 ? "neg" : ""}">${compact(endBal)}</span>`, sel.length ? `after step ${lastB}` : "bank only")}${stat("Financing needed now", nowNeed > 0 ? `<span class="neg">${compact(nowNeed)}</span>` : "None", "this month, from outside the group", nowNeed > 0 ? "bad" : "")}</div>
      <section class="cf-card"><div class="cf-split"><h3>Position, step by step</h3><button class="btn small" data-cf="k-pdf" data-v="summary">Download PDF</button></div><div class="small muted">Start from the bank balance, add what is still to be collected, take away what is still to be paid. Each step builds on the one before. What was already collected or paid is not counted.</div>
        ${ladder}${hasData && pos.rows.length > 1 ? `<h4 class="cf-h4">By unit</h4><div class="small muted">Each cell is the position after the step. Green is still to collect, red is still to pay.</div>` : ""}
        ${!hasData ? `<div class="empty"><b>Nothing to show yet</b>Add bank balances and collections and payments first.</div>` : pos.rows.length > 1 ? `<div class="scroll"><table class="cf-table"><thead><tr><th>Unit</th><th>Bank now</th>${stepHead}<th title="The shortfall within the coming month (step 1)">Financing needed now</th></tr></thead><tbody>${pos.rows.map((r) => row(r)).join("")}${pos.rows.length > 1 ? row({ ...t, unit: "all" }, true) : ""}</tbody></table></div>` : ""}
        ${t.skipped ? `<div class="small muted">Left out (categories switched off above): ${plain(t.skipped)}.</div>` : ""}</section>
      ${hasData ? `<section class="cf-card"><h3>Shortfall now, and how to finance it</h3>${fund}${fundDetail}${writableUnits().length && t.need > 0 ? `<div class="toolbar"><button class="btn" data-cf="plan-fin">Add a financing line to the plan</button></div>` : ""}</section>` : ""}
      <section class="cf-card"><div class="cf-split"><h3>Bank balance by day</h3><span class="cf-group">${[30, 60, 90, 0].map((n) => chip(S.range === n, `data-cf="range" data-v="${n}"`, n ? n + " days" : "All")).join("")}</span></div>${chart(units, asOf)}</section></div></div></div>`;
  }
  let pts = [];
  function chart(units, asOf) {
    let days = bankDays(effBank(), units).filter((d) => d <= asOf); if (S.range) days = days.filter((d) => d >= addDays(asOf, -S.range));
    if (days.length < 2) { pts = []; return '<div class="small muted">Not enough days of bank balances yet.</div>'; }
    const effB = effBank(), vals = days.map((d) => sum(units, (u) => bankAt(effB, u, d).total)), max = Math.max(...vals), min = Math.min(0, ...vals), W = 760, H = 220, L = 8, R = 8, T = 12, B = 22, rng = max - min || 1;
    pts = days.map((d, i) => ({ d, v: vals[i], x: L + (i / (days.length - 1)) * (W - L - R), y: T + (1 - (vals[i] - min) / rng) * (H - T - B) }));
    const zero = T + (1 - (0 - min) / rng) * (H - T - B), grid = [0, 0.5, 1].map((f) => { const y = T + (1 - f) * (H - T - B); return `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="cf-grid"/><text x="${W - R}" y="${y - 3}" text-anchor="end" class="cf-axis">${compact(min + f * rng)}</text>`; }).join("");
    return `<div class="cf-chartwrap"><svg viewBox="0 0 ${W} ${H}" class="cf-chart" role="img" aria-label="Bank balance by day. Move over the line to see the amount.">${grid}${min < 0 ? `<line x1="${L}" x2="${W - R}" y1="${zero}" y2="${zero}" class="cf-zero"/>` : ""}
      <polyline fill="none" class="cf-line" points="${pts.map((p) => p.x.toFixed(1) + "," + p.y.toFixed(1)).join(" ")}"/>
      <text x="${L}" y="${H - 4}" class="cf-axis">${esc(dShort(pts[0].d))}</text><text x="${W - R}" y="${H - 4}" text-anchor="end" class="cf-axis">${esc(dShort(pts[pts.length - 1].d))}</text>
      <line class="cf-guide" x1="0" x2="0" y1="${T}" y2="${H - B}" style="display:none"/><circle class="cf-dot" r="5" cx="0" cy="0" style="display:none"/></svg><div class="cf-tip" style="display:none"></div></div>`;
  }
  function hover(e) {
    const svg = e.target.closest && e.target.closest(".cf-chart"); if (!svg || !pts.length) return;
    const r = svg.getBoundingClientRect(), W = svg.viewBox.baseVal.width, x = ((e.clientX - r.left) / r.width) * W;
    let best = pts[0]; for (const p of pts) if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
    const g = svg.querySelector(".cf-guide"), d = svg.querySelector(".cf-dot"), tip = svg.parentElement.querySelector(".cf-tip");
    g.setAttribute("x1", best.x); g.setAttribute("x2", best.x); g.style.display = ""; d.setAttribute("cx", best.x); d.setAttribute("cy", best.y); d.style.display = "";
    tip.innerHTML = `<b>${esc(dShort(best.d))}</b><br>${plain(best.v)}`; tip.style.display = "";
    const px = (best.x / W) * r.width; tip.style.left = Math.min(Math.max(px - 40, 0), r.width - 110) + "px"; tip.style.top = Math.max(((best.y / svg.viewBox.baseVal.height) * r.height) - 52, 0) + "px";
  }
  function unhover(e) { const w = e.target.closest && e.target.closest(".cf-chartwrap"); if (w) { w.querySelector(".cf-guide").style.display = "none"; w.querySelector(".cf-dot").style.display = "none"; w.querySelector(".cf-tip").style.display = "none"; } }

  // ---------------- Report ----------------
  function renderReport() {
    const units = scopeUnits(), asOf = S.asOf, mode = S.mode, label = mode === "day" ? "Day" : mode === "month" ? "Month" : "Quarter";
    const keys = periods(asOf, mode), cur = keyOf(asOf, mode), mb = (m, l) => chip(mode === m, `data-cf="mode" data-v="${m}"`, l);
    // planned against done, from the collections and payments lines and the daily log
    const rows = Object.fromEntries(keys.map((k) => [k, { pIn: 0, pOut: 0, dIn: 0, dOut: 0, oIn: 0, oOut: 0 }]));
    const tOn = typesEff();
    for (const it of S.items) {
      if (!units.includes(it.unit) || !S.bk[it.bucket]) continue;
      const tt = tOn.find((t) => t.code === it.typeCode); if (tt && tt.expected === false) continue;
      const v = etb(it, fx()), pk = keyOf(planDate(it, it.enteredOn || asOf), mode), pr = rows[pk]; if (pr) pr[it.kind === "in" ? "pIn" : "pOut"] += v;
      const lg = S.log.filter((l) => l.itemId === it.id);
      if (lg.length) lg.forEach((l) => { const r = rows[keyOf(l.day, mode)]; if (r && l.day <= asOf) r[l.kind === "in" ? "dIn" : "dOut"] += etb(l, fx()); });
      else if (it.status === "settled" && it.settledOn) { const r = rows[keyOf(it.settledOn, mode)]; if (r && it.settledOn <= asOf) r[it.kind === "in" ? "dIn" : "dOut"] += v; }
    }
    for (const l of S.log) if (units.includes(l.unit) && !l.itemId && l.day <= asOf) { const r = rows[keyOf(l.day, mode)]; if (r) r[l.kind === "in" ? "oIn" : "oOut"] += etb(l, fx()); }
    const past = keys.filter((k) => k < cur).slice(-3), rate = (a, b) => { const p = sum(past, (k) => rows[k][b]), d = sum(past, (k) => rows[k][a]); return p > 0 ? Math.min(1.5, d / p) : null; };
    const rIn = rate("dIn", "pIn"), rOut = rate("dOut", "pOut");
    const body = keys.map((k) => { const r = rows[k], isPast = k < cur; return `<tr class="${isPast ? "" : "fut"}${k === cur ? " cf-now" : ""}"><td><b>${esc(periodLabel(k, mode))}</b>${k === cur ? ' <span class="tag">now</span>' : ""}</td>
      <td class="num">${money(r.pIn)}</td><td class="num">${isPast || k === cur ? money(r.dIn) : '<span class="muted">–</span>'}</td><td class="num">${isPast || k === cur ? pct(r.dIn, r.pIn) : ""}</td>
      <td class="num">${money(r.pOut)}</td><td class="num">${isPast || k === cur ? money(r.dOut) : '<span class="muted">–</span>'}</td><td class="num">${isPast || k === cur ? pct(r.dOut, r.pOut) : ""}</td>
      <td class="num">${money(r.oIn - r.oOut)}</td></tr>`; }).join("");
    // forecast: expected from open lines, with the usual follow-through applied
    const tl = timeline(inScope(units, asOf), effBank(), S.plan, typesEff(), asOf, units, mode, { fx: fx() }), act = actuals(units, asOf, mode);
    let adj = tl.start; const fcRows = tl.rows.map((r) => { const a = act[r.key] || { in: 0, out: 0 }, hasAct = r.past || r.now;
      let adjIn = null, adjOut = null; if (!r.past) { adjIn = rIn === null ? r.projIn : r.projIn * rIn; adjOut = rOut === null ? r.projOut : r.projOut * rOut; adj += adjIn - adjOut; }
      return `<tr class="${r.past ? "dim" : ""}${r.now ? " cf-now" : ""}"><td><b>${esc(r.label)}</b></td><td class="num">${hasAct && (a.in || a.out) ? money(a.in) : '<span class="muted">–</span>'}</td><td class="num">${hasAct && (a.in || a.out) ? money(a.out) : '<span class="muted">–</span>'}</td>
        <td class="num">${r.past ? '<span class="muted">–</span>' : money(r.projIn)}</td><td class="num">${r.past ? '<span class="muted">–</span>' : money(r.projOut)}</td>
        <td class="num strong">${r.closing === null ? '<span class="muted">–</span>' : money(r.closing, false)}</td><td class="num">${r.past ? "" : money(adj, false)}</td></tr>`; }).join("");
    // monthly plan lines against the money that moved
    const pm = mode === "day" ? null : (() => { const m = {}; for (const pl of S.plan) { if (!units.includes(pl.unit)) continue; const k = keyOf(pl.month + "-01", mode); if (!keys.includes(k)) continue; (m[k] = m[k] || { in: 0, out: 0 })[pl.kind] += num(pl.amount); } return m; })();
    const planTbl = pm && Object.keys(pm).length ? `<section class="cf-card"><h3>Cash flow plan against actual</h3><div class="small muted">The monthly plan finance prepared, against the cash that really moved (daily log, or the bank report for earlier days).</div><div class="scroll"><table class="cf-table"><thead><tr><th>${label}</th><th>Plan in</th><th>Actual in</th><th>%</th><th>Plan out</th><th>Actual out</th><th>%</th></tr></thead><tbody>${keys.filter((k) => pm[k] || (act[k] && k <= cur)).map((k) => { const p = pm[k] || { in: 0, out: 0 }, a = act[k] || { in: 0, out: 0 }, show = k <= cur;
      return `<tr class="${k === cur ? "cf-now" : ""}"><td><b>${esc(periodLabel(k, mode))}</b></td><td class="num">${money(p.in)}</td><td class="num">${show ? money(a.in) : '<span class="muted">–</span>'}</td><td class="num">${show ? pct(a.in, p.in) : ""}</td><td class="num">${money(p.out)}</td><td class="num">${show ? money(a.out) : '<span class="muted">–</span>'}</td><td class="num">${show ? pct(a.out, p.out) : ""}</td></tr>`; }).join("")}</tbody></table></div></section>` : "";
    // by bank, for the month to date
    const from = asOf.slice(0, 8) + "01", bankRows = {}; for (const l of S.log) if (units.includes(l.unit) && l.day >= from && l.day <= asOf) { const k = l.unit + "|" + (l.bank || "No bank"); (bankRows[k] = bankRows[k] || { unit: l.unit, bank: l.bank || "No bank", in: 0, out: 0 })[l.kind] += etb(l, fx()); }
    const bkList = Object.values(bankRows).sort((a, b) => a.unit.localeCompare(b.unit) || a.bank.localeCompare(b.bank));
    return `<div class="cf-body"><div class="cf-filters">${allUnits().length > 1 ? unitSel(S.scope) : ""}${urgencyChips()}${typeToggles()}<span class="cf-group">${mb("day", "Daily")}${mb("month", "Monthly")}${mb("quarter", "Quarterly")}</span><span class="cf-right">${menu([['data-cf="xl-report"', "Download this view"]])}</span></div>
      ${usdWarn()}
      <section class="cf-card"><h3>Planned against done</h3><div class="small muted">Planned: collections and payments due in the period (the remaining amount of each line when it was entered). Done: cash recorded in the daily log against those lines. “Not in plan” is cash that moved without a line.${rIn !== null || rOut !== null ? ` In the last ${past.length} period${past.length > 1 ? "s" : ""}, <b>${rIn === null ? "–" : Math.round(rIn * 100) + "%"}</b> of planned collections arrived and <b>${rOut === null ? "–" : Math.round(rOut * 100) + "%"}</b> of planned payments went out. The forecast below uses this.` : ""}</div>
        <div class="scroll"><table class="cf-table"><thead><tr><th>${label}</th><th>Collect: planned</th><th>done</th><th>%</th><th>Pay: planned</th><th>done</th><th>%</th><th>Not in plan (net)</th></tr></thead><tbody>${body}</tbody></table></div></section>
      <section class="cf-card"><h3>Forecast</h3><div class="small muted">Actual in and out for periods that have started. Expected comes from the open lines (placed on their expected date, or at the end of this month, next month or the month after by code: 1 and 11 mean this calendar month). The last column applies the follow-through above to the expected amounts.</div>
        <div class="scroll"><table class="cf-table"><thead><tr><th>${label}</th><th>Actual in</th><th>Actual out</th><th>Expected in</th><th>Expected out</th><th>Balance, as expected</th><th>Balance, adjusted</th></tr></thead><tbody>${fcRows}</tbody></table></div></section>
      ${planTbl}
      <section class="cf-card"><h3>By type</h3><div class="small muted">Open lines as of ${esc(dShort(asOf))}. Click a row to see its lines.</div>${typeTable(units, "in", "Collections")}${typeTable(units, "out", "Payments")}</section>
      ${bkList.length ? `<section class="cf-card"><h3>Cash moved by bank, ${esc(dShort(from))} to ${esc(dShort(asOf))}</h3><div class="scroll"><table class="cf-table"><thead><tr><th>Unit</th><th>Bank</th><th>In</th><th>Out</th><th>Net</th></tr></thead><tbody>${bkList.map((r) => `<tr><td>${esc(ushort(r.unit))}</td><td>${esc(r.bank)}</td><td class="num">${money(r.in)}</td><td class="num">${money(r.out)}</td><td class="num">${money(r.in - r.out, false)}</td></tr>`).join("")}</tbody></table></div></section>` : ""}</div>`;
  }
  function typeTable(units, kind, title) {
    const eff = inScope(units, S.asOf), rows = byType(eff, typesEff(), S.asOf, units, kind, { fx: fx() }); if (!rows.length) return "";
    const tot = { byUnit: {}, byBucket: [0, 0, 0], total: 0, n: 0 }; rows.forEach((r) => { tot.total += r.total; tot.n += r.n; r.byBucket.forEach((v, i) => (tot.byBucket[i] += v)); Object.entries(r.byUnit).forEach(([u, v]) => (tot.byUnit[u] = (tot.byUnit[u] || 0) + v)); });
    const cell = (r) => `${units.length > 1 ? units.map((u) => `<td class="num">${money(r.byUnit[u])}</td>`).join("") : ""}${[1, 2, 3].map((b) => (S.bk[b] ? `<td class="num">${money(r.byBucket[b - 1])}</td>` : "")).join("")}<td class="num strong">${money(r.total)}</td>`;
    return `<h4>${title}</h4><div class="scroll"><table class="cf-table"><thead><tr><th>Type</th><th>Lines</th>${units.length > 1 ? units.map((u) => `<th>${esc(ushort(u))}</th>`).join("") : ""}${[1, 2, 3].map((b) => (S.bk[b] ? `<th>${kind === "in" ? b : b + "" + b}</th>` : "")).join("")}<th>Total</th></tr></thead><tbody>
      ${rows.map((r) => { const t = typeByCode(r.code); return `<tr class="clickable${r.code ? "" : " cf-bad"}" data-cf="cat-open" data-kind="${kind}" data-code="${esc(r.code || "__none")}" tabindex="0" title="${esc(t ? t.description || t.label : "Choose a type for these lines")}"><td><b>${esc(r.code || "No type")}</b>${t && t.label && t.label !== t.code ? `<div class="small muted">${esc(t.label)}</div>` : ""}</td><td class="num small">${r.n}</td>${cell(r)}</tr>`; }).join("")}
      <tr class="tot"><td><b>Total</b></td><td class="num small">${tot.n}</td>${cell(tot)}</tr></tbody></table></div>`;
  }

  // ---------------- Daily log: one sheet for the day ----------------
  // Enter the day's cash against the planned lines (amount + bank on the line itself), add anything that was not planned, check the bank closing, save.
  // "500000+250000" or "1,200,000" -> number; NaN when it is not a number or a sum of numbers
  const sumExpr = (t) => { const v = String(t ?? "").replace(/[\s,]/g, ""); if (!v) return 0; const parts = v.split("+"); let n = 0; for (const p of parts) { if (!/^\d*\.?\d+$/.test(p)) return NaN; n += Number(p); } return n; };
  const draftOf = (it) => { const d = S.dr[it.id] || {}; return { amt: d.amt ?? "", bank: d.bank ?? lastBank(it.unit, it.kind) }; };
  const draftCount = () => Object.entries(S.dr).filter(([id, d]) => num(d.amt) > 0 && S.items.some((i) => i.id === id)).length;

  // ---------------- Collections and payments ----------------
  // A line as it stood at the end of the chosen day: what was collected or paid that day, to date, and what was left.
  function viewOf(i, D) {
    const lg = S.log.filter((l) => l.itemId === i.id), legacy = !lg.length && i.status === "settled" && i.settledOn;
    const to = lg.length ? sum(lg.filter((l) => l.day <= D), (l) => l.amount) : legacy && i.settledOn <= D ? num(i.amount) : 0;
    const onDay = lg.length ? sum(lg.filter((l) => l.day === D), (l) => l.amount) : legacy && i.settledOn === D ? num(i.amount) : 0;
    const wo = i.status === "written_off" && i.settledOn && i.settledOn <= D, left = wo ? 0 : Math.max(0, num(i.amount) - to), exists = (i.enteredOn || "0000") <= D || to > 0;
    return { to, onDay, left, wo, exists, open: left > 0.005 };
  }
  function filteredItems() {
    const f = S.lf, q = f.q.trim().toLowerCase(), units = scopeUnits(), D = S.day;
    return S.items.map((i) => ({ i, v: viewOf(i, D) })).filter(({ i, v }) => v.exists && units.includes(i.unit) && S.bk[i.bucket] && (!f.kind || i.kind === f.kind) && (f.type === "" || (f.type === "__none" ? !i.typeCode : i.typeCode === f.type))
      && (f.status === "all" || (f.status === "active" ? v.open || v.onDay > 0 : f.status === "open" ? v.open : f.status === "day" ? v.onDay > 0 : f.status === "settled" ? !v.open && !v.wo : v.wo))
      && (!q || `${i.code} ${i.party} ${i.description} ${i.ref} ${i.typeCode} ${i.note}`.toLowerCase().includes(q)))
      .sort((a, b) => (b.v.onDay > 0) - (a.v.onDay > 0) || a.i.kind.localeCompare(b.i.kind) * -1 || a.i.bucket - b.i.bucket || (PRI_RANK[a.i.priority] ?? 1) - (PRI_RANK[b.i.priority] ?? 1) || etb(b.i, fx()) - etb(a.i, fx()));
  }
  const typeOptions = (kind, cur, withNew) => { const list = S.types.filter((t) => t.active && (!kind || t.kind === "both" || t.kind === kind)); if (cur && !list.some((t) => t.code === cur)) list.push({ code: cur, label: cur });
    return `<option value="">No type</option>${list.map((t) => `<option value="${esc(t.code)}" ${t.code === cur ? "selected" : ""}>${esc(t.code)}${t.label && t.label !== t.code ? " – " + esc(t.label) : ""}</option>`).join("")}${withNew && canWriteAny() ? `<option value="__new__">+ Add a new type…</option>` : ""}`; };

  // ---------------- Plan ----------------
  function renderPlan() {
    const units = scopeUnits(), from = S.pf.from || addMonths(monthOf(S.asOf), -1), plans = S.plan.filter((p) => units.includes(p.unit) && p.month >= from).sort((a, b) => a.month.localeCompare(b.month) || a.unit.localeCompare(b.unit) || a.kind.localeCompare(b.kind));
    const pm = planByMonth(plans, units), mths = pm.months;
    const sec = SECTIONS.slice(0, 3).flatMap(([s, l]) => ["in", "out"].map((k) => { const r = pm.rows[`${s}|${k}`]; return r ? `<tr><td>${l} ${k === "in" ? "inflow" : "outflow"}</td>${mths.map((m) => `<td class="num">${money(r[m])}</td>`).join("")}</tr>` : ""; })).join("");
    const net = `<tr class="tot"><td><b>Net cash flow</b></td>${mths.map((m) => `<td class="num strong">${money(sum(Object.entries(pm.rows), ([k, v]) => (k.endsWith("|in") ? 1 : -1) * num(v[m])), false)}</td>`).join("")}</tr>`;
    return `<div class="cf-body"><div class="cf-filters"><label class="small muted">From <input type="month" data-cfc="pfrom" value="${esc(from)}"></label>${writableUnits().length ? `<button class="btn small" data-cf="plan-new">+ Forecast line</button>` : ""}</div>
      <div class="small muted cf-pad">The monthly forecast lines (for example the Sept to Nov forecast): what is expected to come in and go out each month. The tables above compare them with the cash that really moved.</div>
      ${mths.length ? `<section class="cf-card"><h3>Plan summary</h3><div class="scroll"><table class="cf-table"><thead><tr><th>Line</th>${mths.map((m) => `<th>${esc(periodLabel(m, "month"))}</th>`).join("")}</tr></thead><tbody>${sec}${net}</tbody></table></div></section>` : ""}
      <section class="cf-card flush">${plans.length ? `<div class="scroll"><table class="cf-table"><thead><tr><th>Month</th><th>Unit</th><th>Section</th><th></th><th>Line</th><th>Amount</th><th></th></tr></thead><tbody>${plans.map((p) => `<tr><td>${esc(periodLabel(p.month, "month"))}</td><td class="small">${esc(ushort(p.unit))}</td><td class="small">${esc((SECTIONS.find((s) => s[0] === p.section) || [])[1] || p.section)}</td><td class="small">${p.kind === "in" ? "Inflow" : "Outflow"}</td><td>${esc(p.label)}</td><td class="num">${money(p.amount, false)}</td><td>${canWrite(p.unit) ? `<button class="btn small ghost" data-cf="plan-open" data-id="${esc(p.id)}">Edit</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty"><b>No plan lines yet</b>Add the monthly forecast, for example collections expected, payroll, CAPEX or loan repayments.</div>`}</section></div>`;
  }

  function renderForecast() {
    const r = renderReport(), n = S.plan.filter((p) => scopeUnits().includes(p.unit)).length;
    return r.replace(/<\/div>$/, `<details class="cf-card cf-fold"><summary><b>Monthly forecast lines</b> <span class="small muted">${n}</span></summary>${renderPlan()}</details></div>`);
  }

  // ---------------- Setup ----------------
  function renderSetup() {
    const use = {}; S.items.forEach((i) => { if (i.typeCode) use[i.typeCode] = (use[i.typeCode] || 0) + 1; });
    const unconf = S.types.filter((t) => !t.confirmed).length;
    const rows = [...S.types].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "in" ? -1 : 1) || a.sort - b.sort).map((t) => `<tr class="${t.active ? "" : "dim"}"><td><b>${esc(t.code)}</b></td><td>${esc(t.label)}${!t.label || t.label === t.code ? ' <span class="small muted">no description yet</span>' : ""}<div class="small muted">${esc(t.description || "")}</div></td><td class="small">${t.kind === "in" ? "Collections" : t.kind === "out" ? "Payments" : "Both"}</td>
      <td class="small">${t.expected ? "Yes" : "No"}</td><td class="small">${t.confirmed ? '<span class="pill s-done">Confirmed</span>' : '<span class="pill s-not">To confirm</span>'}</td><td class="num small">${use[t.code] || 0}</td><td>${canWriteAny() ? `<button class="btn small ghost" data-cf="type-open" data-id="${esc(t.id)}">Edit</button>` : ""}</td></tr>`).join("");
    const gone = [...S.itemsAll.filter((x) => x.deletedAt && canWrite(x.unit)).map((x) => ({ table: "cf_items", id: x.id, at: x.deletedAt, by: x.deletedBy, what: `Line ${x.code || ""}: ${x.party || x.description || ""} (${plain(x.amount)} ${x.currency})`, unit: x.unit })), ...S.logAll.filter((x) => x.deletedAt && canWrite(x.unit)).map((x) => ({ table: "cf_log", id: x.id, at: x.deletedAt, by: x.deletedBy, what: `${x.kind === "in" ? "Collected" : "Paid"} ${plain(x.amount)} ${x.currency} on ${dShort(x.day)}${x.bank ? ", " + x.bank : ""}${x.party ? " · " + x.party : ""}${x.itemCode ? " · " + x.itemCode : ""}`, unit: x.unit }))].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 60);
    const backupCard = `<section class="cf-card"><h3>Backup and deleted entries</h3><div class="toolbar"><button class="btn" data-cf="xl-backup">Download a backup (JSON)</button><span class="small muted">Everything in Cash flow that you can see: lines, movements, bank balances, plan and types, including deleted entries. Excel upload on the Enter screens can load lines, movements, balances and plan back.</span></div>
      <h4>Recently deleted</h4>${gone.length ? `<div class="scroll"><table class="cf-table"><tbody>${gone.map((g) => `<tr><td>${esc(g.what)}<div class="small muted">${esc(ushort(g.unit))} · deleted ${esc(dShort(String(g.at).slice(0, 10)))}${g.by ? " by " + esc(g.by) : ""}</div></td><td><button class="btn small" data-cf="restore" data-table="${g.table}" data-id="${esc(g.id)}">Restore</button></td></tr>`).join("")}</tbody></table></div>` : '<div class="small muted">Nothing deleted.</div>'}</section>`;
    return `<div class="cf-body">${backupCard}${admin() ? `<section class="cf-card"><h3>USD rate</h3><div class="toolbar"><label class="small">1 USD in ETB <input type="number" id="cfFx" min="0" step="any" value="${esc(S.settings.usd_etb || "")}" style="width:120px"></label><button class="btn small" data-cf="fx-save">Save rate</button><span class="small muted">Used to add USD lines and movements into the ETB totals.</span></div></section>` : ""}
      <section class="cf-card"><div class="cf-split"><h3>Types</h3><span class="cf-group"><button class="btn small" data-cf="xl-types">Download list for finance</button>${canWriteAny() ? `<button class="btn primary small" data-cf="type-new">+ Add type</button>` : ""}</span></div>
        <div class="small muted">The list behind the Type dropdown. ${unconf} of ${S.types.length} still to confirm with finance. “Counted” means the type is expected to be collected or paid, so it is included in the position.</div>
        <div class="scroll"><table class="cf-table"><thead><tr><th>Code</th><th>Meaning</th><th>For</th><th>Counted</th><th>Status</th><th>Lines</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section></div>`;
  }

  // ---------------- forms ----------------
  function ensureRoot() {
    let root = document.getElementById("cfModalRoot");
    if (!root) { root = document.createElement("div"); root.id = "cfModalRoot"; document.body.append(root);
      root.addEventListener("click", (e) => { const el = e.target.closest("[data-cf]"); if (el) onAction(el); else if (e.target.classList && e.target.classList.contains("overlay")) closeModal(); });
      root.addEventListener("change", (e) => { const id = e.target.id; if (id === "ci-type" && e.target.value === "__new__") onAction({ dataset: { cf: "type-from-item" } }); else if (id === "cl-code") linkPick(); else if (id === "cl-bank") bankPick(); else if (id === "ci-kind") { readItem(); drawModal(); } else if (id === "cw-kind" || id === "cw-cur") W.onModalChange(id); });
      root.addEventListener("input", (e) => { if (e.target.id === "cl-code") linkPick(); }); }
    return root;
  }
  function drawModal() {
    const root = ensureRoot(), m = S.m; if (!m) { root.innerHTML = ""; return; }
    const body = { item: itemForm, log: logForm, bank: bankForm, plan: planForm, type: typeForm, result: resultView, weekline: (q) => W.lineForm(q), trace: (q) => W.traceView(q), ksplit: (q) => K.splitForm(q), linkline: (q) => W.linkForm(q), clean: (q) => W.cleanView(q) }[m.type](m);
    root.innerHTML = `<div class="overlay"><div class="modal wide xmodal" role="dialog" aria-modal="true">${body}</div></div>`;
    const first = root.querySelector("input[type=text], input[type=number]"); if (first && m.isNew && !m.focused) { m.focused = true; first.focus(); }
  }
  const closeModal = () => { S.m = null; drawModal(); c.render(); };
  const field = (id, label, inner, wide) => `<div class="field${wide ? " wide" : ""}"><label for="${id}">${label}</label>${inner}</div>`;
  const opt = (list, cur) => list.map((x) => `<option ${x === cur ? "selected" : ""}>${esc(x)}</option>`).join("");
  const v = (id) => { const e = document.getElementById(id); return e ? e.value : ""; };
  const footer = (m, saveKey, delKey, extra) => `<div class="save-bar"><div class="toolbar">${delKey && !m.isNew ? `<button class="btn danger" data-cf="${delKey}">${m.confirmDel ? "Click again to delete" : "Delete"}</button>` : ""}${extra || ""}</div><div class="toolbar"><button class="btn" data-cf="close">Cancel</button><button class="btn primary" data-cf="${saveKey}">Save</button></div></div>`;
  const unitOpts = (cur) => writableUnits().map((u) => `<option value="${esc(u)}" ${u === cur ? "selected" : ""}>${esc(uname(u))}</option>`).join("");
  const typeHint = (code) => { const t = typeByCode(code); return t ? esc((t.label && t.label !== t.code ? t.label + ". " : "") + (t.description || "")) : ""; };

  function readItem() { const r = S.m.row; Object.assign(r, { unit: v("ci-unit") || r.unit, kind: v("ci-kind") || r.kind, party: v("ci-party").trim(), description: v("ci-desc").trim(), ref: v("ci-ref").trim(), typeCode: v("ci-type") === "__new__" ? r.typeCode : v("ci-type"), bucket: Number(v("ci-bucket")) || 1, amount: v("ci-amt"), total: v("ci-total"), currency: v("ci-cur") || "ETB", priority: v("ci-pri"), expected: v("ci-exp"), note: v("ci-note").trim(), status: v("ci-st") || r.status, settledOn: v("ci-sdate") }); }
  function itemForm(m) {
    const r = m.row, logs = r.id ? S.log.filter((l) => l.itemId === r.id).sort((a, b) => a.day.localeCompare(b.day)) : [];
    return `<div class="panel-head"><h2>${m.isNew ? "Add a line" : "Line " + esc(r.code || "")}</h2></div><div class="xgrid">
      ${field("ci-unit", "Unit", `<select id="ci-unit" ${m.isNew ? "" : "disabled"}>${unitOpts(r.unit)}</select>`)}${field("ci-kind", "Collect or pay", `<select id="ci-kind" ${m.isNew ? "" : "disabled"}><option value="in" ${r.kind === "in" ? "selected" : ""}>Collect (money coming in)</option><option value="out" ${r.kind === "out" ? "selected" : ""}>Pay (money going out)</option></select>`)}
      ${field("ci-party", "Customer or payee", `<input type="text" id="ci-party" value="${esc(r.party)}">`)}${field("ci-ref", "Invoice or reference no.", `<input type="text" id="ci-ref" value="${esc(r.ref)}">`)}
      ${field("ci-desc", "Description", `<input type="text" id="ci-desc" value="${esc(r.description)}">`, true)}
      ${field("ci-type", "Type", `<select id="ci-type">${typeOptions(r.kind, r.typeCode, true)}</select>${r.typeCode ? `<div class="small muted">${typeHint(r.typeCode)}</div>` : ""}`)}${field("ci-bucket", "Urgency", `<select id="ci-bucket"><option value="1" ${r.bucket === 1 ? "selected" : ""}>${bucketCode(r.kind, 1)} · this month</option><option value="2" ${r.bucket === 2 ? "selected" : ""}>${bucketCode(r.kind, 2)} · next month</option><option value="3" ${r.bucket === 3 ? "selected" : ""}>${bucketCode(r.kind, 3)} · the month after, long term</option></select>`)}
      ${field("ci-amt", "Remaining amount", `<input type="number" id="ci-amt" min="0" step="any" value="${esc(String(r.amount ?? ""))}"><div class="small muted">What is still to be ${r.kind === "in" ? "collected" : "paid"}. Cash recorded against this line is taken off it.</div>`)}${field("ci-total", "Original total (optional)", `<input type="number" id="ci-total" min="0" step="any" value="${esc(String(r.total ?? ""))}"><div class="small muted">The full invoice amount, if you know it. It is only shown for reference.</div>`)}
      ${field("ci-cur", "Currency", `<select id="ci-cur">${opt(CURRENCIES, r.currency)}</select>`)}
      ${field("ci-pri", "Priority", `<select id="ci-pri">${opt(PRIORITIES, r.priority)}</select>`)}${field("ci-exp", "Expected date (optional)", `<input type="date" id="ci-exp" value="${esc(r.expected || "")}">`)}
      ${m.isNew ? "" : field("ci-st", "Status", `<select id="ci-st"><option value="open" ${r.status === "open" ? "selected" : ""}>Open</option><option value="settled" ${r.status === "settled" ? "selected" : ""}>${r.kind === "in" ? "Collected" : "Paid"}</option><option value="written_off" ${r.status === "written_off" ? "selected" : ""}>Written off</option></select>`)}${m.isNew ? "" : field("ci-sdate", "Date settled", `<input type="date" id="ci-sdate" value="${esc(r.settledOn || "")}">`)}
      ${field("ci-note", "Note", `<textarea id="ci-note" rows="2">${esc(r.note)}</textarea>`, true)}</div>
      ${logs.length ? `<div class="small" style="margin:8px 0 4px"><b>Cash recorded against this line</b></div><div class="scroll"><table class="cf-table"><tbody>${logs.map((l) => `<tr><td>${esc(dShort(l.day))}</td><td>${esc(l.bank || "")}</td><td class="num">${money(l.amount, false)}</td><td class="cf-act2">${canWrite(l.unit) ? `<button class="btn small ghost" data-cf="log-open" data-id="${esc(l.id)}">Edit or delete</button>` : ""}</td></tr>`).join("")}<tr class="tot"><td colspan="2"><b>Done</b></td><td class="num">${money(sum(logs, (l) => l.amount), false)}</td><td></td></tr></tbody></table></div>` : ""}
      ${footer(m, "item-save", "item-del")}`;
  }
  // a cash movement
  const openLines = (unit, kind) => S.items.filter((i) => i.unit === unit && i.kind === kind && i.status === "open");
  function logForm(m) {
    const r = m.row, banks = knownBanks(r.unit), lines = openLines(r.unit, r.kind), isNewBank = m.newBank || (r.bank && !banks.includes(r.bank));
    return `<div class="panel-head"><h2>${m.isNew ? "Add a cash movement" : "Cash movement"}</h2></div><div class="xgrid">
      ${field("cl-day", "Date", `<input type="date" id="cl-day" value="${esc(r.day)}">`)}${field("cl-unit", "Unit", `<select id="cl-unit">${unitOpts(r.unit)}</select>`)}
      ${field("cl-kind", "In or out", `<select id="cl-kind"><option value="in" ${r.kind === "in" ? "selected" : ""}>In (money received)</option><option value="out" ${r.kind === "out" ? "selected" : ""}>Out (money paid)</option></select>`)}
      ${field("cl-bank", r.kind === "in" ? "Credited to bank" : "Debited from bank", `<select id="cl-bank"><option value="">Choose the bank</option>${banks.map((b) => `<option ${b === r.bank ? "selected" : ""}>${esc(b)}</option>`).join("")}<option value="__new__" ${isNewBank ? "selected" : ""}>+ New bank…</option></select>${isNewBank ? `<input type="text" id="cl-newbank" placeholder="Bank name" value="${esc(banks.includes(r.bank) ? "" : r.bank)}" style="margin-top:6px">` : ""}`)}
      ${field("cl-amt", r.kind === "in" ? "Amount collected" : "Amount paid", `<input type="number" id="cl-amt" min="0" step="any" value="${esc(String(r.amount ?? ""))}" placeholder="0">`)}${field("cl-cur", "Currency", `<select id="cl-cur">${opt(CURRENCIES, r.currency)}</select>`)}
      ${field("cl-code", "Planned line (optional)", `<input type="text" id="cl-code" list="cl-lines" value="${esc(r.itemCode || "")}" placeholder="Type or pick a code, e.g. CF-00012" autocomplete="off"><datalist id="cl-lines">${lines.map((i) => `<option value="${esc(i.code)}" label="${esc((i.party || i.description || "") + " · left " + plain(Math.max(0, num(i.amount) - loggedFor(i.id, null, r.id))) + " " + i.currency)}"></option>`).join("")}</datalist><div class="small muted" id="cl-hint">${linkHint(r)}</div>`, true)}
      ${field("cl-party", "Party", `<input type="text" id="cl-party" value="${esc(r.party)}">`)}${field("cl-type", "Type", `<select id="cl-type">${typeOptions(r.kind, r.typeCode, false)}</select>`)}
      ${field("cl-desc", "Description", `<input type="text" id="cl-desc" value="${esc(r.description)}">`, true)}${field("cl-note", "Note", `<input type="text" id="cl-note" value="${esc(r.note || "")}">`, true)}</div>${footer(m, "log-save", "log-del")}`;
  }
  function linkHint(r) { const it = r.itemId ? S.items.find((i) => i.id === r.itemId) : null; if (!it) return r.itemCode ? '<span class="neg">No open line has this code.</span>' : "Link it so the line shows how much is done. Leave empty for cash that was not planned."; const before = loggedFor(it.id, null, r.id), left = Math.max(0, num(it.amount) - before);
    return `<b>${esc(it.party || it.description)}</b>${num(it.total) > 0 ? ` · total ${plain(it.total)}` : ""} · ${it.kind === "in" ? "collected" : "paid"} so far ${plain(before)} · <b>remaining ${plain(left)}</b> ${esc(it.currency)}`; }
  function readLog() { const r = S.m.row, bank = v("cl-bank"); Object.assign(r, { day: v("cl-day") || r.day, unit: v("cl-unit") || r.unit, kind: v("cl-kind") || r.kind, bank: bank === "__new__" ? (v("cl-newbank").trim() || "") : bank, amount: v("cl-amt"), currency: v("cl-cur") || "ETB", party: v("cl-party").trim(), typeCode: v("cl-type"), description: v("cl-desc").trim(), note: v("cl-note").trim() }); S.m.newBank = bank === "__new__"; }
  function linkPick() {
    const m = S.m; if (!m || m.type !== "log") return; const r = m.row, code = v("cl-code").trim().toUpperCase(); const it = code ? S.items.find((i) => i.code && i.code.toUpperCase() === code) : null;
    r.itemCode = code; r.itemId = it ? it.id : "";
    if (it) { const left = Math.max(0, num(it.amount) - loggedFor(it.id, null, r.id)); readLog(); r.itemCode = it.code; r.itemId = it.id; r.kind = it.kind; r.unit = it.unit; r.currency = it.currency; r.party = r.party || it.party; r.description = r.description || it.description; r.typeCode = r.typeCode || it.typeCode; drawModal(); }
    else { const h = document.getElementById("cl-hint"); if (h) h.innerHTML = linkHint(r); }
  }
  function bankPick() { if (!S.m || S.m.type !== "log") return; readLog(); drawModal(); }
  function bankForm(m) {
    const r = m.row;
    return `<div class="panel-head"><h2>Bank balance</h2></div><div class="xgrid">
      ${field("cb-unit", "Unit", `<select id="cb-unit">${unitOpts(r.unit)}</select>`)}${field("cb-day", "Day", `<input type="date" id="cb-day" value="${esc(r.day)}">`)}
      ${field("cb-bank", "Bank account", `<input type="text" id="cb-bank" list="cb-banks" value="${esc(r.bank)}"><datalist id="cb-banks">${[...new Set(S.bank.map((b) => b.bank))].sort().map((b) => `<option value="${esc(b)}">`).join("")}</datalist>`, true)}
      ${field("cb-open", "Opening balance", `<input type="number" id="cb-open" step="any" value="${esc(String(r.opening ?? 0))}">`)}${field("cb-in", "In", `<input type="number" id="cb-in" step="any" value="${esc(String(r.inflow ?? 0))}">`)}
      ${field("cb-out", "Out", `<input type="number" id="cb-out" step="any" value="${esc(String(r.outflow ?? 0))}">`)}${field("cb-close", "Closing balance", `<input type="number" id="cb-close" step="any" value="${esc(String(r.closing ?? 0))}">`)}</div>${footer(m, "bank-save", null, `<button type="button" class="btn small" data-cf="bank-calc">Work out the closing</button>`)}`;
  }
  function planForm(m) {
    const r = m.row;
    return `<div class="panel-head"><h2>${m.isNew ? "Add a plan line" : "Plan line"}</h2></div><div class="xgrid">
      ${field("cp-unit", "Unit", `<select id="cp-unit">${unitOpts(r.unit)}</select>`)}${field("cp-month", "Month", `<input type="month" id="cp-month" value="${esc(r.month)}">`)}
      ${field("cp-kind", "Inflow or outflow", `<select id="cp-kind"><option value="in" ${r.kind === "in" ? "selected" : ""}>Inflow</option><option value="out" ${r.kind === "out" ? "selected" : ""}>Outflow</option></select>`)}${field("cp-sec", "Section", `<select id="cp-sec">${PLAN_SECTIONS.map(([k, l]) => `<option value="${k}" ${k === r.section ? "selected" : ""}>${l}</option>`).join("")}</select>`)}
      ${field("cp-label", "Line (for example Payroll, CAPEX, Proceeds from borrowings)", `<input type="text" id="cp-label" value="${esc(r.label)}">`, true)}${field("cp-amt", "Amount", `<input type="number" id="cp-amt" min="0" step="any" value="${esc(String(r.amount ?? ""))}">`)}${field("cp-note", "Note", `<input type="text" id="cp-note" value="${esc(r.note || "")}">`)}</div>${footer(m, "plan-save", "plan-del")}`;
  }
  function typeForm(m) {
    const r = m.row, canEditCode = m.isNew || admin();
    return `<div class="panel-head"><h2>${m.isNew ? "Add a type" : "Type " + esc(r.code)}</h2></div><div class="xgrid">
      ${field("ct-code", "Code (as finance writes it)", `<input type="text" id="ct-code" value="${esc(r.code)}" ${canEditCode ? "" : "disabled"}>`)}${field("ct-label", "Meaning", `<input type="text" id="ct-label" value="${esc(r.label)}">`)}
      ${field("ct-kind", "For", `<select id="ct-kind"><option value="in" ${r.kind === "in" ? "selected" : ""}>Collections</option><option value="out" ${r.kind === "out" ? "selected" : ""}>Payments</option><option value="both" ${r.kind === "both" ? "selected" : ""}>Both</option></select>`)}
      ${field("ct-sec", "Cash flow section", `<select id="ct-sec">${SECTIONS.map(([k, l]) => `<option value="${k}" ${k === r.section ? "selected" : ""}>${l}</option>`).join("")}</select>`)}${field("ct-grp", "Group (for summaries)", `<input type="text" id="ct-grp" value="${esc(r.group || "")}">`)}
      ${field("ct-exp", "Counted in the position", `<select id="ct-exp"><option value="yes" ${r.expected ? "selected" : ""}>Yes, expected to be collected or paid</option><option value="no" ${r.expected ? "" : "selected"}>No, not expected soon (for example related parties)</option></select>`)}
      ${admin() ? field("ct-conf", "Finance has confirmed this meaning", `<select id="ct-conf"><option value="no" ${r.confirmed ? "" : "selected"}>Not yet</option><option value="yes" ${r.confirmed ? "selected" : ""}>Confirmed</option></select>`) : ""}${admin() && !m.isNew ? field("ct-act", "In the dropdown", `<select id="ct-act"><option value="yes" ${r.active ? "selected" : ""}>Shown</option><option value="no" ${r.active ? "" : "selected"}>Hidden</option></select>`) : ""}
      ${field("ct-desc", "Description (shown as a hint)", `<textarea id="ct-desc" rows="2">${esc(r.description || "")}</textarea>`, true)}</div>${footer(m, "type-save", null)}`;
  }
  const resultView = (m) => `<div class="panel-head"><h2>${esc(m.title)}</h2></div><div class="cf-result">${m.lines.map((l) => `<p>${l}</p>`).join("")}${m.notes.length ? `<div class="small"><b>To check</b></div><ul class="small">${m.notes.slice(0, 25).map((n) => `<li>${esc(n)}</li>`).join("")}${m.notes.length > 25 ? `<li>…and ${m.notes.length - 25} more</li>` : ""}</ul>` : ""}</div><div class="save-bar"><span></span><button class="btn primary" data-cf="close">OK</button></div>`;

  // ---------------- actions ----------------
  const todayRow = (kind) => ({ id: undefined, unit: writableUnits().includes(S.scope) ? S.scope : writableUnits()[0], kind: kind || "in", party: "", description: "", ref: "", typeCode: "", bucket: 1, amount: "", currency: "ETB", priority: "Normal", expected: "", status: "open", settledOn: "", note: "", enteredOn: c.todayIso });
  // After cash is recorded against a line (or removed): close the line when fully covered, reopen it if it no longer is.
  async function syncLine(itemId, extra, latestDay, skipLogId) {
    const it = S.items.find((q) => q.id === itemId); if (!it || it.status === "written_off") return null;
    const logged = loggedFor(itemId, null, skipLogId) + (extra || 0), any = logged > 0 || S.log.some((l) => l.itemId === itemId && l.id !== skipLogId);
    if (!any) return it.status === "settled" && it.settledOn ? null : null;
    const full = logged >= num(it.amount) - 0.005;
    if (full && it.status === "open") return c.api().saveCfItem(A(), itemRow({ ...it, status: "settled", settledOn: latestDay || c.todayIso }));
    if (!full && it.status === "settled") return c.api().saveCfItem(A(), itemRow({ ...it, status: "open", settledOn: "" }));
    return null;
  }
  // Bring back a deleted line or cash movement. A restored movement may close its line again.
  async function restoreEntry(table, id) {
    const l = table === "cf_log" ? S.logAll.find((q) => q.id === id) : null;
    await run(async () => { const res = await c.api().restoreCf(A(), table, id); if (res && res.error) return res;
      if (l && l.itemId) { const e = await syncLine(l.itemId, num(l.amount), l.day); if (e && e.error) return e; } return res; }, "Restored");
  }
  // Everything in this screen as one JSON file, including what was deleted, as a safety copy.
  function backupJson() {
    const units = allUnits(), keep = (r) => units.includes(r.unit), data = { app: "WBG cash flow backup", made: new Date().toISOString(), by: A().name || "", asOf: c.todayIso, types: S.types, lines: S.itemsAll.filter(keep), movements: S.logAll.filter(keep), bank: S.bank.filter(keep), plan: S.plan.filter(keep), settings: S.settings };
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }), a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `Cash flow backup ${c.todayIso}.json`; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); c.toast("Backup saved");
  }
  async function onAction(el) {
    const x = el.dataset.cf, id = el.dataset.id, m = S.m, it = id ? S.items.find((q) => q.id === id) : null;
    if (x && x.startsWith("w-")) { await W.onAction(el); return; }
    if (x && x.startsWith("d-")) { await D.onAction(el); return; }
    if (x && x.startsWith("k-")) { await K.onAction(el); return; }
    if (x === "view") { S.view = el.dataset.v; c.render(); }
    else if (x === "today") setDay(c.todayIso);
    else if (x === "mode") { S.mode = el.dataset.v; c.render(); }
    else if (x === "range") { S.range = Number(el.dataset.v); c.render(); }
    else if (x === "bk") { const b = Number(el.dataset.v); S.bk[b] = !S.bk[b]; if (!S.bk[1] && !S.bk[2] && !S.bk[3]) S.bk[b] = true; c.render(); }
    else if (x === "type-on") { const t = typesEff().find((q) => q.code === el.dataset.code); if (t) { S.typeOn[t.code] = !t.expected; const base = S.types.find((q) => q.code === t.code); if (base && base.expected === S.typeOn[t.code]) delete S.typeOn[t.code]; } keepOpen(); }
    else if (x === "cnt-toggle") { S.cntOpen = !S.cntOpen; c.render(); }
    else if (x === "type-all") { const on = el.dataset.v === "1", kind = el.dataset.kind, ts = typesEff().filter((t) => t.active && (!kind || (t.kind || kind) === kind)); ts.forEach((t) => { S.typeOn[t.code] = on; const base = S.types.find((q) => q.code === t.code); if (base && base.expected === on) delete S.typeOn[t.code]; }); c.render(); }
    else if (x === "type-reset") { S.typeOn = {}; keepOpen(); }
    else if (x === "lkind") { S.lf.kind = el.dataset.v; S.lf.show = 40; c.render(); }
    else if (x === "more") { S.lf.show += 40; c.render(); }
    else if (x === "no-type") { S.lf.type = "__none"; S.lf.status = "open"; S.view = "coll"; c.render(); }
    else if (x === "cat-open") { S.lf.kind = el.dataset.kind; S.lf.type = el.dataset.code; S.lf.status = "open"; S.lf.q = ""; S.view = "coll"; c.render(); }
    else if (x === "close") closeModal();
    else if (x === "day-shift") setDay(addDays(S.day, Number(el.dataset.v)));
    else if (x === "day-today") setDay(c.todayIso);
    else if (x === "cal-toggle") { S.calOpen = !S.calOpen; S.calMonth = monthOf(S.day); c.render(); }
    else if (x === "cal-month") { S.calMonth = addMonths(S.calMonth || monthOf(S.day), Number(el.dataset.v)); c.render(); }
    else if (x === "cal-pick") setDay(el.dataset.v);
    else if (x === "undo") { const u = S.undo; S.undo = null; if (u) await restoreEntry(u.table, u.id); else c.render(); }
    else if (x === "restore") { await restoreEntry(el.dataset.table, id); }
    else if (x === "xl-backup") backupJson();
    else if (x === "undo-x") { S.undo = null; c.render(); }
    else if (x === "day-pick") setDay(el.dataset.v);
    // lines
    else if (x === "item-new") { S.m = { type: "item", isNew: true, row: todayRow(S.lf.kind || "in") }; drawModal(); }
    else if (x === "item-open" && it) { S.m = { type: "item", isNew: false, row: clone(it) }; drawModal(); }
    else if (x === "item-save") {
      readItem(); const r = m.row; if (!r.unit) { c.toast("Choose the unit"); return; } if (!r.party && !r.description) { c.toast("Write who it is from or to, or a description"); return; } if (num(r.amount) <= 0) { c.toast("Enter the remaining amount"); return; }
      if (r.status !== "open" && !r.settledOn) r.settledOn = c.todayIso; if (r.status === "open") r.settledOn = "";
      if (await run(() => c.api().saveCfItem(A(), itemRow({ ...r, id: m.isNew ? undefined : r.id })), "Saved")) closeModal();
    }
    else if (x === "item-del") { if (!m.confirmDel) { m.confirmDel = true; drawModal(); return; } const row = m.row; if (await run(() => c.api().deleteCf(A(), "cf_items", row.id), "Deleted. You can undo it.")) { S.undo = { table: "cf_items", id: row.id, label: `Line ${row.code || ""} ${row.party || ""}`.trim() }; closeModal(); } }
    else if (x === "rec" && it) { const left = Math.max(0, num(it.amount) - loggedFor(it.id)); S.m = { type: "log", isNew: true, row: { unit: it.unit, day: S.day, kind: it.kind, bank: lastBank(it.unit, it.kind), amount: "", currency: it.currency, party: it.party, description: it.description, typeCode: it.typeCode, itemId: it.id, itemCode: it.code, note: "" } }; drawModal(); }
    // log
    else if (x === "dkind") { S.dq.kind = el.dataset.v; S.dq.show = 30; c.render(); }
    else if (x === "dmore") { S.dq.show += 30; c.render(); }
    else if (x === "dr-save") {
      const ents = Object.entries(S.dr).map(([id, d]) => ({ it: S.items.find((q) => q.id === id), d })).filter((o) => o.it && num(o.d.amt) > 0 && canWrite(o.it.unit));
      if (!ents.length) return; const noBank = ents.find((o) => !(o.d.bank || lastBank(o.it.unit, o.it.kind))); if (noBank) { c.toast("Choose the bank for " + (noBank.it.party || noBank.it.code)); return; }
      const ok = await run(async () => { for (const { it, d } of ents) {
        const res = await c.api().saveCfLog(A(), { unit: it.unit, day: S.day, kind: it.kind, bank: d.bank || lastBank(it.unit, it.kind), amount: num(d.amt), currency: it.currency, party: it.party, description: it.description, typeCode: it.typeCode, itemId: it.id, itemCode: it.code, note: "", fxRate: it.currency === "USD" ? fx() || "" : "" });
        if (res && res.error) return res; const e = await syncLine(it.id, num(d.amt), S.day); if (e && e.error) return e; } return { ok: true }; }, `${ents.length} entr${ents.length > 1 ? "ies" : "y"} saved`);
      if (ok) { ents.forEach((o) => delete S.dr[o.it.id]); c.render(); }
    }
    else if (x === "log-new") { const u = writableUnits().includes(S.scope) ? S.scope : writableUnits()[0]; S.m = { type: "log", isNew: true, row: { unit: u, day: S.day, kind: "in", bank: knownBanks(u)[0] || "", amount: "", currency: "ETB", party: "", description: "", typeCode: "", itemId: "", itemCode: "", note: "" } }; drawModal(); }
    else if (x === "log-open") { const l = S.log.find((q) => q.id === id); if (l && canWrite(l.unit)) { S.m = { type: "log", isNew: false, row: clone(l) }; drawModal(); } }
    else if (x === "log-save") {
      readLog(); const r = m.row; if (!r.unit || !r.day) { c.toast("Choose the date and unit"); return; } if (num(r.amount) <= 0) { c.toast("Enter the amount"); return; } if (!r.bank) { c.toast("Choose the bank"); return; }
      if (r.itemCode && !r.itemId) { c.toast("No line has the code " + r.itemCode + ". Clear it or pick one from the list."); return; }
      const old = m.isNew ? null : S.log.find((q) => q.id === r.id), prevItem = old && old.itemId && old.itemId !== r.itemId ? old.itemId : null;
      const ok = await run(async () => {
        const res = await c.api().saveCfLog(A(), logRow({ ...r, id: m.isNew ? undefined : r.id, amount: num(r.amount) })); if (res && res.error) return res;
        if (r.itemId) { const e = await syncLine(r.itemId, num(r.amount), r.day, r.id); if (e && e.error) return e; }
        if (prevItem) { const e = await syncLine(prevItem, 0, null, r.id); if (e && e.error) return e; }
        return res; }, "Saved");
      if (ok) { S.day = r.day; closeModal(); }
    }
    else if (x === "log-del") { if (!m.confirmDel) { m.confirmDel = true; drawModal(); return; } const l = m.row;
      if (await run(async () => { const res = await c.api().deleteCf(A(), "cf_log", l.id); if (res && res.error) return res; if (l.itemId) { const e = await syncLine(l.itemId, 0, null, l.id); if (e && e.error) return e; } return res; }, "Deleted. You can undo it.")) { S.undo = { table: "cf_log", id: l.id, label: `Cash movement of ${plain(l.amount)} (${l.party || l.itemCode || l.bank || ""})`, itemId: l.itemId }; closeModal(); } }
    else if (x === "bk-save") {
      const rows = [...document.querySelectorAll("tr[data-bkkey]")].map((tr) => { const [unit, bank, day] = tr.dataset.bkkey.split("|"), g = (k) => (tr.querySelector(`[data-bd="${k}"]`) || {}).value; return { unit, bank, day, tr, open: g("open"), inn: sumExpr(g("in")), out: sumExpr(g("out")), close: g("close") }; }).filter((r) => canWrite(r.unit));
      if (!rows.length) return;
      const bad = rows.find((r) => Number.isNaN(r.inn) || Number.isNaN(r.out)); if (bad) { c.toast("In and Out must be numbers, or a sum like 500000+250000"); return; }
      const ok = await run(async () => { for (const r of rows) { const prev = realBank().filter((b) => b.unit === r.unit && b.bank === r.bank && b.day < r.day).sort((a, b) => b.day.localeCompare(a.day))[0], opening = prev ? num(prev.closing) : num(r.open); const closing = Math.round((opening + r.inn - r.out) * 100) / 100;
        const res = await c.api().saveCfBank(A(), { unit: r.unit, day: r.day, bank: r.bank, opening, inflow: r.inn, outflow: r.out, closing }); if (res && res.error) return res; } return { ok: true }; }, "Day saved");
      if (ok) rows.forEach((r) => delete S.bd[`${r.unit}|${r.bank}|${r.day}`]);
    }
    else if (x === "bank-new") { S.m = { type: "bank", isNew: true, row: { unit: writableUnits().includes(S.scope) ? S.scope : writableUnits()[0], day: S.day, bank: "", opening: 0, inflow: 0, outflow: 0, closing: 0 } }; drawModal(); }
    else if (x === "bank-calc") { document.getElementById("cb-close").value = String(Math.round((num(v("cb-open")) + num(v("cb-in")) - num(v("cb-out"))) * 100) / 100); }
    else if (x === "bank-save") {
      const row = { unit: v("cb-unit"), day: v("cb-day"), bank: v("cb-bank").trim(), opening: num(v("cb-open")), inflow: num(v("cb-in")), outflow: num(v("cb-out")), closing: num(v("cb-close")) };
      if (!row.day || !row.bank) { c.toast("Fill in the day and the bank"); return; }
      if (await run(() => c.api().saveCfBank(A(), row), "Saved")) { S.day = row.day; closeModal(); }
    }
    // plan
    else if (x === "plan-new" || x === "plan-fin") { const nm = addMonths(monthOf(S.asOf), 1); S.m = { type: "plan", isNew: true, row: { unit: writableUnits().includes(S.scope) ? S.scope : writableUnits()[0], month: nm, kind: x === "plan-fin" ? "in" : "in", section: x === "plan-fin" ? "financing" : "operating", label: x === "plan-fin" ? "Proceeds from borrowings" : "", amount: "" } }; drawModal(); }
    else if (x === "plan-open") { const p = S.plan.find((q) => q.id === id); if (p) { S.m = { type: "plan", isNew: false, row: clone(p) }; drawModal(); } }
    else if (x === "plan-save") {
      const r = m.row, row = { id: m.isNew ? undefined : r.id, unit: v("cp-unit"), month: v("cp-month"), kind: v("cp-kind"), section: v("cp-sec"), label: v("cp-label").trim(), amount: num(v("cp-amt")), note: v("cp-note").trim() };
      if (!row.label || !row.month) { c.toast("Fill in the month and the line"); return; }
      if (await run(() => c.api().saveCfPlan(A(), row), "Saved")) closeModal();
    }
    else if (x === "plan-del") { if (!m.confirmDel) { m.confirmDel = true; drawModal(); return; } if (await run(() => c.api().deleteCf(A(), "cf_plan", m.row.id), "Deleted")) closeModal(); }
    // types
    else if (x === "type-new") { S.m = { type: "type", isNew: true, row: { code: "", label: "", kind: "both", section: "operating", group: "", description: "", expected: true, confirmed: false, active: true } }; drawModal(); }
    else if (x === "type-open") { const t = S.types.find((q) => q.id === id); if (t) { S.m = { type: "type", isNew: false, row: clone(t) }; drawModal(); } }
    else if (x === "type-from-item") { readItem(); S.m = { type: "type", isNew: true, back: S.m, row: { code: "", label: "", kind: S.m.row.kind, section: "operating", group: "", description: "", expected: true, confirmed: false, active: true } }; drawModal(); }
    else if (x === "type-save") {
      const r = m.row, row = { id: m.isNew ? undefined : r.id, code: v("ct-code").trim(), label: v("ct-label").trim(), kind: v("ct-kind"), section: v("ct-sec"), group: v("ct-grp").trim(), description: v("ct-desc").trim(), expected: v("ct-exp") !== "no", sort: r.sort };
      if (document.getElementById("ct-conf")) row.confirmed = v("ct-conf") === "yes"; if (document.getElementById("ct-act")) row.active = v("ct-act") !== "no";
      if (!row.code) { c.toast("Enter the code"); return; }
      if (!(await run(() => c.api().saveCfType(A(), row), "Saved"))) return;
      if (m.back) { S.m = m.back; S.m.row.typeCode = row.code; drawModal(); }
      else if (m.applyTo) { const target = S.items.find((q) => q.id === m.applyTo); closeModal(); if (target) run(() => c.api().saveCfItem(A(), itemRow({ ...target, typeCode: row.code }))); }
      else closeModal();
    }
    else if (x === "fx-save") { await run(() => c.api().saveCfSetting(A(), "usd_etb", (document.getElementById("cfFx") || {}).value || ""), "Rate saved"); }
    else if (x === "xl-report") reportExcel();
    else if (x === "xl-types") typesExcel();
  }
  // re-render but keep the "Counted types" box open
  function keepOpen() { c.render(); const d = document.querySelector(".cf-inc"); if (d) d.open = true; }

  async function onQuick(el) {
    const it = S.items.find((q) => q.id === el.dataset.id); if (!it || !canWrite(it.unit)) return;
    const k = el.dataset.cfq, val = el.value;
    if (k === "type" && val === "__new__") { S.m = { type: "type", isNew: true, applyTo: it.id, row: { code: "", label: "", kind: it.kind, section: "operating", group: "", description: "", expected: true, confirmed: false, active: true } }; drawModal(); return; }
    await run(() => c.api().saveCfItem(A(), itemRow({ ...it, ...(k === "type" ? { typeCode: val } : { expected: val }) })), "Saved");
  }
  function onControl(el) {
    const k = el.dataset.cfc;
    if (k === "asOf" || k === "day") { if (el.value) { setDay(el.value); return; } } else if (k === "scope") S.scope = el.value; else if (k === "pfrom") S.pf.from = el.value; else if (k === "wk") { if (el.value) S.wk = weekStartOf(el.value); } else if (k === "rpfrom") S.rp.from = el.value;
    c.render();
  }
  function onFilter(el) { S.lf[el.dataset.cff] = el.value; S.lf.show = 40; c.render(); if (el.dataset.cff === "q") { const e = document.querySelector('[data-cff="q"]'); if (e) { e.focus(); e.setSelectionRange(e.value.length, e.value.length); } } }

  const main = document.getElementById("main");
  main.addEventListener("click", (e) => { if (S.cntOpen && !e.target.closest(".cf-cntdd")) { S.cntOpen = false; c.render(); } if (K.onOutside && K.onOutside(e)) return; if (e.target.closest("select,input,label")) return; const el = e.target.closest("[data-cf]"); if (el) { if (el.tagName === "A") e.preventDefault(); onAction(el); } });
  main.addEventListener("keydown", (e) => { const el = e.target.closest && e.target.closest("tr[data-cf]"); if (el && (e.key === "Enter" || e.key === " ") && !e.target.closest("select,input,button")) { e.preventDefault(); onAction(el); } });
  main.addEventListener("change", (e) => { const t = e.target; if (t.id === "cfUploadDay" || t.id === "cwUploadWeek" || t.id === "ckUploadWk" || t.id === "ckUploadSt") { if (t.files[0]) ({ cwUploadWeek: W.uploadWeek, ckUploadWk: K.uploadWeek, ckUploadSt: K.uploadStatus }[t.id] || D.uploadDay)(t.files[0]); t.value = ""; return; } if (!t.dataset) return; if (t.dataset.kb) { K.onBank(t); return; } if (t.dataset.kwk) { K.onWeek(t); return; } if (t.dataset.kdn) { K.onDone(t); return; } if (t.dataset.nl === "unit" || t.dataset.nl === "kind") { K.onNewChange(); return; } if (t.dataset.kd) { K.onInput(t); return; } if (t.dataset.dr) { onDraft(t); return; } if (t.dataset.cfq) onQuick(t); else if (t.dataset.cfc) onControl(t); else if (t.dataset.cff && t.dataset.cff !== "q") onFilter(t); });
  const onBank = (t) => {
    const key = t.dataset.key, d = S.bd[key] || (S.bd[key] = {}), tr = t.closest("tr"), k = t.dataset.bd; d[k] = t.value;
    const g = (n) => (tr.querySelector(`[data-bd="${n}"]`) || {}).value, openCell = tr.querySelector('[data-bd="open"]'), oc = openCell ? null : tr.querySelector("td.num"), opening = openCell ? num(openCell.value) : num(String(oc ? oc.textContent : 0).replace(/,/g, "")), inn = sumExpr(g("in")), out = sumExpr(g("out"));
    const cl = tr.querySelector("[data-bd-close]"); if (cl) { cl.dataset.v = String(opening + (Number.isNaN(inn) ? 0 : inn) - (Number.isNaN(out) ? 0 : out)); cl.textContent = plain(cl.dataset.v); }
    const rowsAll = [...document.querySelectorAll("tr[data-bkkey]")], tot = (n) => sum(rowsAll, (r) => { if (n === "close") return num((r.querySelector("[data-bd-close]") || { dataset: {} }).dataset.v ?? String((r.querySelector("[data-bd-close]") || {}).textContent || "").replace(/,/g, "")); const x = sumExpr((r.querySelector(`[data-bd="${n}"]`) || {}).value); return Number.isNaN(x) ? 0 : x; });
    const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = plain(val); }; set("cfTotIn", tot("in")); set("cfTotOut", tot("out")); set("cfTotClose", tot("close"));
  };
  const onDraft = (t) => { const d = S.dr[t.dataset.id] || (S.dr[t.dataset.id] = {}); d[t.dataset.dr] = t.value; const b = document.getElementById("cfDrSave"), n = draftCount(); if (b) { b.disabled = !n; b.textContent = n ? `Save ${n} entr${n > 1 ? "ies" : "y"}` : "Save entries"; } const row = t.closest("tr"); if (row) { row.classList.toggle("cf-fill", num(d.amt) > 0); const lf = row.querySelector("[data-left-of]"); if (lf && t.dataset.dr === "amt") lf.textContent = plain(Math.max(0, num(t.dataset.left) - num(t.value))); } };
  main.addEventListener("input", (e) => { const t = e.target; if (t.dataset && (t.dataset.kd || t.dataset.pda !== undefined || t.dataset.pdb !== undefined)) { K.onInput(t); return; } if (t.dataset && t.dataset.kq) { K.onSearch(t); return; } if (t.dataset && t.dataset.bd) { onBank(t); return; } if (t.dataset && t.dataset.dr) { onDraft(t); return; } if (t.dataset && t.dataset.cfd === "q") { clearTimeout(onFilter.d); onFilter.d = setTimeout(() => { S.dq.q = t.value; S.dq.show = 30; c.render(); const e2 = document.querySelector('[data-cfd="q"]'); if (e2) { e2.focus(); e2.setSelectionRange(e2.value.length, e2.value.length); } }, 250); return; } if (t.dataset && t.dataset.cff === "q") { clearTimeout(onFilter.t); onFilter.t = setTimeout(() => onFilter(t), 250); } });
  main.addEventListener("pointermove", hover); main.addEventListener("pointerleave", unhover, true); main.addEventListener("pointerdown", hover);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.m) closeModal(); });
  document.addEventListener("click", (e) => { document.querySelectorAll("details.cf-menu[open]").forEach((d) => { if (!d.contains(e.target) || e.target.closest(".cf-menu-item")) d.open = false; }); });

  // ---------------- Excel: report and types ----------------
  async function reportExcel() {
    if (!c.libsReady("xlsx")) return; const X = c.XLSX(), wb = X.utils.book_new(), units = scopeUnits(), asOf = S.asOf, sheet = (rows, w, name) => X.utils.book_append_sheet(wb, c.sheetFromRows(rows, w), name);
    const pos = position(inScope(units, asOf), effBank(), typesEff(), asOf, units, { fx: fx() });
    sheet([["Unit", "Bank balance", "1 collect", "11 pay", "After 1 − 11", "2 collect", "22 pay", "After 2 − 22", "3 collect", "33 pay", "After 3 − 33", "Financing need"], ...[...pos.rows, { ...pos.total, unit: "all" }].map((r) => [r.unit === "all" ? "Total" : uname(r.unit), Math.round(r.bank), Math.round(r.c[0]), Math.round(r.p[0]), Math.round(r.b[0]), Math.round(r.c[1]), Math.round(r.p[1]), Math.round(r.b[1]), Math.round(r.c[2]), Math.round(r.p[2]), Math.round(r.b[2]), Math.round(r.need)])], [26, 16, 14, 14, 16, 14, 14, 16, 14, 14, 16, 16], "Position");
    for (const [kind, name] of [["in", "Collections by type"], ["out", "Payments by type"]]) { const rows = byType(inScope(units, asOf), typesEff(), asOf, units, kind, { fx: fx() }); sheet([["Type", "Lines", ...units.map(ushort), kind === "in" ? "1" : "11", kind === "in" ? "2" : "22", kind === "in" ? "3" : "33", "Total"], ...rows.map((r) => [r.code || "No type", r.n, ...units.map((u) => Math.round(r.byUnit[u] || 0)), ...r.byBucket.map(Math.round), Math.round(r.total)])], [18, 7, ...units.map(() => 14), 14, 14, 14, 16], name); }
    const act = actuals(units, asOf, "month"); sheet([["Month", "Actual in", "Actual out"], ...Object.keys(act).sort().map((k) => [k, Math.round(act[k].in), Math.round(act[k].out)])], [12, 16, 16], "Actual by month");
    await c.writeXlsx(wb, `Cash flow report ${asOf}.xlsx`, "Excel saved");
  }
  async function typesExcel() {
    if (!c.libsReady("xlsx")) return; const X = c.XLSX(), wb = X.utils.book_new(), use = {}; S.items.forEach((i) => { if (i.typeCode) use[i.typeCode] = (use[i.typeCode] || 0) + 1; });
    X.utils.book_append_sheet(wb, c.sheetFromRows([["Code", "Meaning", "For", "Section", "Group", "Counted in the position", "Confirmed by finance", "Lines using it", "Description", "Finance to describe"], ...S.types.map((t) => [t.code, t.label, t.kind, t.section, t.group, t.expected ? "Yes" : "No", t.confirmed ? "Yes" : "No", use[t.code] || 0, t.description, ""])], [20, 36, 10, 14, 18, 14, 14, 10, 50, 40]), "Types");
    await c.writeXlsx(wb, `Cash flow types ${c.todayIso}.xlsx`, "Excel saved");
  }

  async function summaryPdf() {
    if (!c.libsReady("pdf")) return; const units = scopeUnits(), asOf = S.asOf, pos = position(inScope(units, asOf), effBank(), typesEff(), asOf, units, { fx: fx() }), t = pos.total, sel = [1, 2, 3].filter((b) => S.bk[b]);
    const doc = c.newPdf("Cash flow position", `${units.length === 1 ? uname(units[0]) : "All business units"}  ·  as of ${dShort(asOf)}  ·  step by step`), n = (v) => ({ content: plain(v), styles: { halign: "right" } });
    const head = [["Unit", "Bank now", ...sel.flatMap((b) => [`Step ${b} collect`, `Step ${b} pay`, `Position ${b}`]), "Financing needed now"]];
    const line = (r, name) => [{ content: name, styles: { fontStyle: "bold" } }, n(r.bank), ...sel.flatMap((b) => [n(r.c[b - 1]), n(r.p[b - 1]), { content: plain(r.b[b - 1]), styles: { halign: "right", fontStyle: "bold", textColor: r.b[b - 1] < 0 ? [190, 30, 30] : [30, 30, 30] } }]), n(Math.max(0, -r.b[0]))];
    const st = c.pdfStyle(); st.styles = { ...st.styles, fontSize: 8.5, cellPadding: 4 }; st.headStyles = { ...st.headStyles, fontSize: 8 };
    doc.autoTable({ startY: 92, margin: { left: 30, right: 30 }, head, body: [...pos.rows.map((r) => line(r, uname(r.unit))), ...(pos.rows.length > 1 ? [line({ ...t }, "Total")] : [])], ...st });
    let y = doc.lastAutoTable.finalY + 14; doc.setFontSize(8.5); doc.setTextColor(90, 90, 90); doc.text("Bank now, plus what is still to be collected, minus what is still to be paid. Step 1 is this calendar month, step 2 next month, step 3 the month after; each step builds on the one before. Financing needed now is the shortfall of step 1.", 30, y, { maxWidth: 780 }); y += 26;
    const off = S.types.filter((q) => q.active && !typesEff().find((e) => e.code === q.code).expected).map((q) => q.code); if (off.length || t.skipped) { doc.text(`Left out of the totals: ${off.join(", ") || "none"} (${plain(t.skipped)}).`, 30, y); }
    const pgs = doc.getNumberOfPages(), H = doc.internal.pageSize.getHeight(); for (let i = 1; i <= pgs; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(120, 120, 120); doc.text(`Cash flow position · ${dShort(c.todayIso)} · Page ${i} of ${pgs}`, 36, H - 18); }
    await c.save(`Cash flow position ${asOf}.pdf`, doc.output("arraybuffer"), "PDF saved. Open it to print.");
  }

  const hh = { S, c, esc, A, plain, money, scopeUnits, writableUnits, allUnits, canWrite, unitSel, stat, chip, viewOf, effBank, realBank, knownBanks, lastBank, ushort, uname, typeHint, typeOptions, typeByCode, field, v, unitOpts, itemRow, logRow, run, drawModal, closeModal, setDay, fx, menu, usdWarn, draftOf, draftCount, sumExpr, syncLine, typesEff, summaryPdf };
  const W = createWeek(hh), D = createDay(hh), K = createSheet(hh);
  return { renderCash, subscribe, canSee };
}
