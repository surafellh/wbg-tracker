// Cash flow rules (pure functions, no screen code).
// Finance's own coding is kept: collections are 1, 2, 3 and payables 11, 22, 33.
//   1 / 11 = this calendar month, 2 / 22 = next month, 3 / 33 = the month after (long term). "Within a month" means within the month we are in, not the next 30 days.
// The balance is worked out in steps: bank balance, then 1 minus 11, then 2 minus 22, then 3 minus 33.

export const SECTIONS = [["operating", "Operating"], ["investing", "Investing"], ["financing", "Financing"], ["intercompany", "Intercompany"], ["other", "Other"]];
export const PLAN_SECTIONS = SECTIONS.slice(0, 3);
export const PRIORITIES = ["High", "Normal", "Low"];
export const CURRENCIES = ["ETB", "USD"];
export const bucketCode = (kind, b) => (kind === "in" ? String(b) : String(b) + String(b));
export const BUCKET_TEXT = { 1: "this month", 2: "next month", 3: "the month after, long term" };
export const FIN_UNITS_FALLBACK = ["wagwago-electric", "trucksload", "geez", "niyat-consultancy", "wanza-logistics"];

const n = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? 0 : Number(v));
export const num = n;
export const sum = (arr, f) => arr.reduce((a, x) => a + n(f(x)), 0);

// ---------- dates ----------
const D = (s) => Date.parse(String(s).slice(0, 10) + "T00:00:00Z");
export const addDays = (iso, k) => new Date(D(iso) + k * 864e5).toISOString().slice(0, 10);
export const monthOf = (iso) => String(iso).slice(0, 7);
export const addMonths = (ym, k) => { const [y, m] = ym.split("-").map(Number), t = y * 12 + (m - 1) + k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; };
export const quarterOf = (iso) => { const [y, m] = String(iso).slice(0, 7).split("-").map(Number); return `${y}-Q${Math.floor((m - 1) / 3) + 1}`; };
export const addQuarters = (q, k) => { const [y, qq] = q.split("-Q").map(Number), t = y * 4 + (qq - 1) + k; return `${Math.floor(t / 4)}-Q${(t % 4) + 1}`; };
export const keyOf = (iso, mode) => (mode === "day" ? String(iso).slice(0, 10) : mode === "quarter" ? quarterOf(iso) : monthOf(iso));
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function periodLabel(key, mode) {
  if (mode === "day") { const [y, m, d] = key.split("-").map(Number); return `${d} ${MONTHS[m - 1]}`; }
  if (mode === "quarter") { const [y, q] = key.split("-Q"); return `Q${q} ${y}`; }
  const [y, m] = key.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`;
}

// ---------- items ----------
export const closedOn = (it) => (it.status && it.status !== "open" ? it.settledOn || it.enteredOn || "0000-00-00" : null);
export const isOpenAt = (it, asOf) => (it.enteredOn || "0000-00-00") <= asOf && !(closedOn(it) && closedOn(it) <= asOf);
export const rateOf = (it, fx) => (it.currency === "USD" ? n(it.rate) || n(it.fxRate) || n(fx) : 1);   // the rate stored with the entry wins over today's rate
export const etb = (it, fx) => n(it.amount) * rateOf(it, fx);
export const typeOf = (types, code) => (types || []).find((t) => t.code === code) || null;
export const countsIn = (it, types, incl) => { if (incl) return true; const t = typeOf(types, it.typeCode); return !t || t.expected !== false; };
// Where an open item falls on the calendar: its expected date, or a date worked out from its urgency code.
// Code 1 / 11 means this calendar month (so on 28 Oct it falls in October, by 31 Oct), 2 / 22 the next month, 3 / 33 the month after.
// A line with no expected date is placed on the last day of its month. Counted from the date given: today for the forecast, the day a line was entered for its plan.
export const monthEnd = (ym) => addDays(addMonths(ym, 1) + "-01", -1);
export const IMPLIED_DAYS = { 1: 30, 2: 60, 3: 120 };
export const impliedDate = (bucket, from) => monthEnd(addMonths(monthOf(from), (Number(bucket) || 1) - 1));
export const dateOf = (it, asOf) => (it.expected ? String(it.expected).slice(0, 10) : impliedDate(it.bucket, asOf));

// ---------- bank ----------
export function bankAt(bank, unit, asOf) {
  // The latest balance of each named bank on or before the date, added up. A unit may also report one "All banks" total per day;
  // it is used only when it is at least as recent as every named bank (never both, or the money is counted twice).
  const named = new Map(); let all = null, day = "";
  for (const b of bank) {
    if (b.unit !== unit || b.day > asOf) continue;
    if (b.bank === "All banks") { if (!all || b.day > all.day) all = b; }
    else { const cur = named.get(b.bank); if (!cur || b.day > cur.day) named.set(b.bank, b); }
    if (b.day > day) day = b.day;
  }
  if (!all && !named.size) return { day: "", total: 0, inflow: 0, outflow: 0, opening: 0, has: false };
  const maxNamed = [...named.values()].reduce((m, r) => (r.day > m ? r.day : m), "");
  const rows = all && all.day >= maxNamed ? [all] : [...named.values()], on = rows.filter((r) => r.day === day);
  return { day, total: sum(rows, (r) => r.closing), inflow: sum(on, (r) => r.inflow), outflow: sum(on, (r) => r.outflow), opening: sum(on, (r) => r.opening), has: true };
}
export const bankDays = (bank, units) => [...new Set(bank.filter((b) => !units || units.includes(b.unit)).map((b) => b.day))].sort();

// ---------- the position: bank, then 1-11, 2-22, 3-33 ----------
export function position(items, bank, types, asOf, units, opts) {
  const o = opts || {}, fx = o.fx || 0;
  const rows = units.map((u) => {
    const bk = bankAt(bank, u, asOf), c = [0, 0, 0], p = [0, 0, 0], cn = [0, 0, 0], pn = [0, 0, 0];
    let skipped = 0;
    for (const it of items) {
      if (it.unit !== u || !isOpenAt(it, asOf)) continue;
      if (!countsIn(it, types, o.incl)) { skipped += etb(it, fx); continue; }
      const i = (it.bucket || 1) - 1;
      if (it.kind === "in") { c[i] += etb(it, fx); cn[i]++; } else { p[i] += etb(it, fx); pn[i]++; }
    }
    const b1 = bk.total + c[0] - p[0], b2 = b1 + c[1] - p[1], b3 = b2 + c[2] - p[2];
    return { unit: u, bank: bk.total, bankDay: bk.day, hasBank: bk.has, c, p, cn, pn, b: [b1, b2, b3], skipped, need: Math.max(0, -Math.min(b1, b2, b3)) };
  });
  const total = { unit: "all", bank: sum(rows, (r) => r.bank), c: [0, 1, 2].map((i) => sum(rows, (r) => r.c[i])), p: [0, 1, 2].map((i) => sum(rows, (r) => r.p[i])), cn: [0, 1, 2].map((i) => sum(rows, (r) => r.cn[i])), pn: [0, 1, 2].map((i) => sum(rows, (r) => r.pn[i])), skipped: sum(rows, (r) => r.skipped) };
  total.b = [0, 1, 2].map((i) => sum(rows, (r) => r.b[i]));
  total.need = Math.max(0, -Math.min(...total.b));
  total.needUnits = sum(rows, (r) => r.need);
  return { rows, total };
}

// How the gap could be covered: surplus held by other units first, the rest from outside the group.
export function funding(pos) {
  const lowest = (r) => Math.min(...r.b);
  const short = pos.rows.filter((r) => r.need > 0).sort((a, b) => b.need - a.need);
  const rich = pos.rows.filter((r) => r.need === 0 && lowest(r) > 0).map((r) => ({ unit: r.unit, spare: Math.min(r.bank, lowest(r)) })).filter((r) => r.spare > 0).sort((a, b) => b.spare - a.spare);
  const external = pos.total.need, internal = Math.max(0, pos.total.needUnits - external);
  return { short, rich, external, internal, spare: sum(rich, (r) => r.spare) };
}

// ---------- by calendar period (daily, monthly, quarterly), rolling from the as-of date ----------
export const HORIZON = { day: { past: 7, future: 30 }, month: { past: 3, future: 6 }, quarter: { past: 2, future: 4 } };
export function periods(asOf, mode) {
  const h = HORIZON[mode], keys = [];
  if (mode === "day") for (let i = -h.past; i <= h.future; i++) keys.push(addDays(asOf, i));
  else if (mode === "quarter") { const q = quarterOf(asOf); for (let i = -h.past; i <= h.future; i++) keys.push(addQuarters(q, i)); }
  else { const m = monthOf(asOf); for (let i = -h.past; i <= h.future; i++) keys.push(addMonths(m, i)); }
  return keys;
}
export const periodEnd = (key, mode) => (mode === "day" ? key : mode === "quarter" ? addDays(addMonths(`${key.split("-Q")[0]}-${String((Number(key.split("-Q")[1]) - 1) * 3 + 1).padStart(2, "0")}`, 3) + "-01", -1) : addDays(addMonths(key, 1) + "-01", -1));
export function timeline(items, bank, plan, types, asOf, units, mode, opts) {
  const o = opts || {}, fx = o.fx || 0, keys = periods(asOf, mode), cur = keyOf(asOf, mode);
  const rows = keys.map((k) => ({ key: k, label: periodLabel(k, mode), past: k < cur, now: k === cur, actIn: 0, actOut: 0, planIn: 0, planOut: 0, projIn: 0, projOut: 0, hasBank: false, closing: null }));
  const at = Object.fromEntries(rows.map((r) => [r.key, r]));
  for (const b of bank) { if (!units.includes(b.unit)) continue; const r = at[keyOf(b.day, mode)]; if (r && b.day <= asOf) { r.actIn += n(b.inflow); r.actOut += n(b.outflow); r.hasBank = true; } }
  for (const it of items) {
    if (!units.includes(it.unit) || !isOpenAt(it, asOf) || !countsIn(it, types, o.incl)) continue;
    const r = at[keyOf(dateOf(it, asOf), mode)]; if (!r || r.past) continue;
    if (it.kind === "in") r.projIn += etb(it, fx); else r.projOut += etb(it, fx);
  }
  if (mode !== "day") for (const pl of plan) {
    if (!units.includes(pl.unit)) continue;
    const r = at[mode === "quarter" ? quarterOf(pl.month + "-01") : pl.month]; if (!r) continue;
    if (pl.kind === "in") r.planIn += n(pl.amount); else r.planOut += n(pl.amount);
  }
  const start = sum(units, (u) => bankAt(bank, u, asOf).total);
  let bal = start;
  const days = bankDays(bank, units);
  for (const r of rows) {
    if (r.past) { const end = periodEnd(r.key, mode); r.closing = days.some((d) => d <= end) ? sum(units, (u) => bankAt(bank, u, end).total) : null; }
    else { bal += r.projIn - r.projOut; r.closing = bal; }
  }
  return { rows, start };
}

// ---------- by type and unit ----------
export function byType(items, types, asOf, units, kind, opts) {
  const o = opts || {}, fx = o.fx || 0, map = new Map();
  for (const it of items) {
    if (it.kind !== kind || !units.includes(it.unit) || !isOpenAt(it, asOf)) continue;
    const key = it.typeCode || "";
    const r = map.get(key) || { code: key, n: 0, byUnit: {}, byBucket: [0, 0, 0], total: 0 };
    const v = etb(it, fx); r.n++; r.total += v; r.byBucket[(it.bucket || 1) - 1] += v; r.byUnit[it.unit] = (r.byUnit[it.unit] || 0) + v;
    map.set(key, r);
  }
  return [...map.values()].sort((a, b) => (a.code === "" ? 1 : b.code === "" ? -1 : b.total - a.total));
}

// ---------- plan lines by month ----------
export function planByMonth(plan, units) {
  const rows = {}; const months = new Set();
  for (const p of plan) { if (!units.includes(p.unit)) continue; months.add(p.month); const k = `${p.section}|${p.kind}`; rows[k] = rows[k] || {}; rows[k][p.month] = (rows[k][p.month] || 0) + n(p.amount); }
  return { rows, months: [...months].sort() };
}

// ---------- default list of types (used when the database has none, and by the local test mode) ----------
export const DEFAULT_TYPES = [
  ["Train I", "Training, internal", "in", "operating"], ["Train E", "Training, external", "in", "operating"], ["Mkt E", "Marketing, external", "in", "operating"], ["Maint", "Maintenance", "in", "operating"],
  ["LC", "Letter of credit (goods to import and sell)", "in", "operating"], ["RP", "Related parties", "in", "other", false], ["Stock", "Stock in inventory", "in", "operating"], ["Sister Comp", "Sister company", "in", "intercompany"],
  ["Pension", "Pension", "out", "operating"], ["Inc Tax", "Income tax", "out", "operating"], ["VAT", "VAT", "out", "operating"], ["purchase", "Purchase", "out", "operating"], ["Salary", "Salary", "out", "operating"],
  ["Rental C", "Rental car", "out", "operating"], ["Rental HO", "Rent, head office", "out", "operating"], ["Utility", "Utilities", "out", "operating"], ["LC RM", "LC, raw materials", "out", "operating"], ["Custom G", "Customs", "out", "operating"], ["Construction", "Construction", "out", "investing"],
].map(([code, label, kind, section, expected], i) => ({ id: "def-" + code, code, label, kind, section, group: "", description: "", expected: expected !== false, confirmed: false, active: true, sort: (i + 1) * 10 }));

// ---------- weeks (Monday to Saturday; a Sunday belongs to the week before it) ----------
export const weekStart = (iso) => { const d = new Date(D(iso)).getUTCDay(); return addDays(String(iso).slice(0, 10), -((d + 6) % 7)); };
export const weekEnd = (w) => addDays(w, 6);      // the Sunday: cash that moves on a Sunday still counts in the week
export const weekDays = (w) => [0, 1, 2, 3, 4, 5].map((k) => addDays(w, k));   // Monday to Saturday
export const DAYN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const weekLabel = (w) => { const a = String(w).slice(0, 10), b = addDays(a, 5), [ya, ma, da] = a.split("-").map(Number), [yb, mb, db] = b.split("-").map(Number); return `${da} ${MONTHS[ma - 1]}${ya !== yb ? " " + ya : ""} to ${db} ${MONTHS[mb - 1]} ${yb}`; };
// Money in a day range for one planned line, from the movements (rows with a day and an amount).
export const movedIn = (log, itemId, from, to) => sum(log.filter((l) => l.itemId === itemId && l.day >= from && l.day <= to), (l) => l.amount);
// Reconcile one bank on one day: what the bank says came in and went out against what the collections and payments add up to.
export const TOLERANCE = 1;
export function reconcileRows(bank, log, units, from, to, fxRate) {
  const keys = new Map(), put = (u, b, d) => { const k = u + "|" + b + "|" + d; if (!keys.has(k)) keys.set(k, { unit: u, bank: b, day: d, bank_in: 0, bank_out: 0, opening: null, closing: null, has_bank: false, m_in: 0, m_out: 0, n: 0 }); return keys.get(k); };
  for (const r of bank) if (units.includes(r.unit) && r.day >= from && r.day <= to) { const x = put(r.unit, r.bank, r.day); x.has_bank = true; x.bank_in = n(r.inflow); x.bank_out = n(r.outflow); x.opening = n(r.opening); x.closing = n(r.closing); }
  for (const l of log) if (units.includes(l.unit) && l.day >= from && l.day <= to) { const x = put(l.unit, l.bank || "(no bank)", l.day); x.n++; x[l.kind === "in" ? "m_in" : "m_out"] += n(l.amount) * (l.currency === "USD" ? n(fxRate) : 1); }
  const rows = [...keys.values()].sort((a, b) => a.day.localeCompare(b.day) || a.unit.localeCompare(b.unit) || a.bank.localeCompare(b.bank));
  // opening against the previous closing of the same bank
  const last = {}; const all = bank.filter((r) => units.includes(r.unit)).sort((a, b) => a.day.localeCompare(b.day));
  const prevClose = new Map(); for (const r of all) { const k = r.unit + "|" + r.bank; if (last[k]) prevClose.set(r.unit + "|" + r.bank + "|" + r.day, last[k]); last[k] = r.closing; }
  for (const x of rows) {
    const flags = [];
    if (x.bank === "(no bank)") flags.push("Cash was itemized without a bank");
    else if (!x.has_bank) flags.push("Collections or payments recorded but no bank report");
    else {
      const dIn = x.bank_in - x.m_in, dOut = x.bank_out - x.m_out;
      if (Math.abs(dIn) > TOLERANCE) flags.push(dIn > 0 ? "Bank in is more than the collections itemized" : "Collections itemized are more than the bank in");
      if (Math.abs(dOut) > TOLERANCE) flags.push(dOut > 0 ? "Bank out is more than the payments itemized" : "Payments itemized are more than the bank out");
      if (Math.abs(x.opening + x.bank_in - x.bank_out - x.closing) > TOLERANCE) flags.push("Opening + in − out does not equal the closing balance");
      const pc = prevClose.get(x.unit + "|" + x.bank + "|" + x.day); if (pc !== undefined && Math.abs(pc - x.opening) > TOLERANCE) flags.push("Opening is not the previous closing");
      x.diff_in = dIn; x.diff_out = dOut;
    }
    x.flags = flags;
  }
  return rows;
}

// ---------- the weekly cash flow statement ----------
// The rows of the statement every unit already uses (WEEKLY CASH FLOW). [kind, section, label]
export const STMT = [
  ["in", "operating", "Collection from cash sales"], ["in", "operating", "Cash collection / refund / service"], ["in", "operating", "Credit collection"], ["in", "operating", "Other income"],
  ["in", "investing", "Sales of PPE"], ["in", "investing", "Sales of stock / bond"],
  ["in", "financing", "Loan proceeds"], ["in", "financing", "Contribution from owners"],
  ["out", "operating", "Operating activities"],
  ["out", "investing", "Capital purchase"], ["out", "investing", "Purchase of investments"],
  ["out", "financing", "Loan repayment"], ["out", "financing", "Dividend"], ["out", "financing", "Lease hold land payments"],
];
export const STMT_GROUP = { operating: "from operating activities", investing: "from investing activities", financing: "from financing activities" };
export const stmtDefault = (kind, section) => (kind === "in" ? (section === "investing" ? "Sales of PPE" : section === "financing" ? "Loan proceeds" : section === "operating" ? "Credit collection" : "Other income") : section === "investing" ? "Capital purchase" : section === "financing" ? "Loan repayment" : "Operating activities");
export const stmtOf = (w, item) => (w.stmt && STMT.some((s) => s[2] === w.stmt && s[0] === w.kind) ? w.stmt : stmtDefault(w.kind, w.section || (item && item.section) || "operating"));
export const stmtSection = (label) => (STMT.find((s) => s[2] === label) || [])[1] || "operating";
