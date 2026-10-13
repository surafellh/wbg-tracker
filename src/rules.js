// Shared rules: what a unit may change on its own, and what needs Group Strategy approval.
// The same rules run in the database (supabase/upgrade-1-safe.sql, wbg_save_plan); this copy lets the page
// route each change correctly before saving, and powers the offline (local) mode.

// Once a week has started, these task fields are fixed for unit users. Changing them, or removing a saved
// task, needs approval. Status, %, notes, owner, dependencies and evidence stay open.
export const LOCKED = ["title", "kind", "dept", "outcome", "due", "priority"];
// Fields compared when working out what changed (lu / lb are "last updated" stamps, not content).
export const TASK_FIELDS = ["title", "kind", "dept", "outcome", "owner", "due", "priority", "prevStatus", "prevPct", "status", "pct", "completedAt", "depUnit", "dep", "notes", "ev", "carried", "carriedCount", "blockedSince", "category", "target", "measure", "actual", "lower", "ref", "parent", "weight"];
export const DEFAULT_APPROVERS = ["Surafel", "Surafel Hailu", "Ataklti", "Ataklti Nega"];

const pad = (n) => String(n).padStart(2, "0");
const isoOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

// Today's date in Addis Ababa, whatever the computer's time zone.
export function addisToday(now = new Date()) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Addis_Ababa", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  } catch (e) {
    return isoOf(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }
}
export function mondayOfIso(s) {
  const [y, m, d] = s.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1, d));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return isoOf(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
}
export const addisMonday = (now) => mondayOfIso(addisToday(now));

// ---- Weeks -----------------------------------------------------------------------------------------------
// Up to and including the week of Monday 5 Oct 2026 a week runs Monday to Friday (older plans keep their Monday key).
// From Saturday 10 Oct 2026 a week runs Saturday to Friday and is keyed by its Saturday.
export const WEEK_CUTOVER = "2026-10-10";
export const shiftIso = (s, n) => {
  const [y, m, d] = s.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return isoOf(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
};
const dowIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }; // 0 = Sunday
export function weekStartOf(s) {
  if (s < WEEK_CUTOVER) return mondayOfIso(s);
  return shiftIso(s, -((dowIso(s) + 1) % 7)); // days since Saturday
}
export const weekEndOf = (w) => (w >= WEEK_CUTOVER ? shiftIso(w, 6) : (shiftIso(w, 5) < WEEK_CUTOVER ? shiftIso(w, 5) : shiftIso(WEEK_CUTOVER, -1)));
export const nextWeekOf = (w) => (w >= WEEK_CUTOVER ? shiftIso(w, 7) : (shiftIso(w, 7) >= WEEK_CUTOVER ? WEEK_CUTOVER : shiftIso(w, 7)));
export const prevWeekOf = (w) => (w > WEEK_CUTOVER ? shiftIso(w, -7) : (w === WEEK_CUTOVER ? weekStartOf(shiftIso(WEEK_CUTOVER, -1)) : shiftIso(w, -7)));
export const addisWeekStart = (now) => weekStartOf(addisToday(now));

export function isApproverName(name, list = DEFAULT_APPROVERS) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return false;
  return (list || []).some((a) => { const k = String(a || "").trim().toLowerCase(); return k && (n.startsWith(k) || n.includes(k)); });
}

// % complete from a target and an actual figure. null when either is missing.
// Higher is better by default; with "lower is better" (cost, delay) meeting or beating the target is 100%.
export function calcPct(t) {
  if (!t || t.target === "" || t.target == null || t.actual === "" || t.actual == null) return null;
  const tg = Number(t.target), ac = Number(t.actual);
  if (!isFinite(tg) || !isFinite(ac)) return null;
  if (t.lower) return ac <= tg ? 100 : ac <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((tg / ac) * 100)));
  if (tg <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((ac / tg) * 100)));
}
export const CATEGORIES = ["Operational", "Revenue"];

const same = (f, a, b) => {
  if (f === "kind") return (a || "Task") === (b || "Task");
  if (f === "ev") return JSON.stringify(a || []) === JSON.stringify(b || []);
  if (f === "pct" || f === "prevPct" || f === "carriedCount") return (a ?? null) === (b ?? null) || (a === "" && b == null) || (b === "" && a == null);
  if (f === "carried" || f === "lower") return !!a === !!b;
  if (f === "weight") return Number(a || 1) === Number(b || 1);
  if (f === "target" || f === "actual") return (a === "" || a == null ? "" : Number(a)) === (b === "" || b == null ? "" : Number(b));
  return String(a ?? "") === String(b ?? "");
};

// Changes from the saved plan to the edited one, as a list of operations.
export function planOps(saved, draft) {
  const ops = [];
  const old = new Map(((saved && saved.tasks) || []).map((t) => [t.id, t]));
  const now = new Map(((draft && draft.tasks) || []).map((t) => [t.id, t]));
  (draft.tasks || []).forEach((t) => {
    const o = old.get(t.id);
    if (!o) { ops.push({ op: "add", id: t.id, task: strip(t) }); return; }
    TASK_FIELDS.forEach((f) => { if (!same(f, o[f], t[f])) ops.push({ op: "set", id: t.id, f, from: o[f] ?? "", to: t[f] ?? "", title: o.title || "" }); });
  });
  old.forEach((o, id) => { if (!now.has(id)) ops.push({ op: "remove", id, task: strip(o) }); });
  ["wins", "blockers", "asks"].forEach((f) => { if (((saved && saved[f]) || "") !== ((draft && draft[f]) || "")) ops.push({ op: "text", f, from: (saved && saved[f]) || "", to: (draft && draft[f]) || "" }); });
  return ops;
}
const strip = (t) => { const c = JSON.parse(JSON.stringify(t)); delete c.lu; delete c.lb; return c; };

// Does a unit user need approval for this operation in this week?
export function needsApproval(op, week, monday, today) {
  if (week < monday) return true;
  if (week > monday) return false;
  if (op.op === "remove") return true;
  if (op.op === "set" && LOCKED.includes(op.f)) return true;
  if (op.op === "set" && op.f === "completedAt" && op.to && op.to !== today) return true;
  return false;
}

// Apply operations to a plan (used for the direct part of a save, and when an approver accepts a request).
export function applyOps(plan, ops, stamp) {
  const p = JSON.parse(JSON.stringify(plan || { tasks: [], wins: "", blockers: "", asks: "" }));
  p.tasks = p.tasks || [];
  const touched = new Set();
  ops.forEach((o) => {
    if (o.op === "add") { if (!p.tasks.some((t) => t.id === o.id)) { p.tasks.push(JSON.parse(JSON.stringify(o.task))); touched.add(o.id); } }
    else if (o.op === "remove") p.tasks = p.tasks.filter((t) => t.id !== o.id);
    else if (o.op === "set") { const t = p.tasks.find((x) => x.id === o.id); if (t) { t[o.f] = o.to === undefined ? "" : JSON.parse(JSON.stringify(o.to)); touched.add(o.id); } }
    else if (o.op === "text") p[o.f] = o.to;
  });
  if (stamp) p.tasks.forEach((t) => { if (touched.has(t.id)) { t.lu = stamp.at; t.lb = stamp.by; } });
  return p;
}

// The database rule for a unit (non-approver) save, used by the offline mode. Returns null or a reason.
export function checkUnitSave(old, plan, monday, today) {
  if (plan.week < monday) return "past_week";
  const ot = (old && old.tasks) || [];
  if (old && plan.week <= monday) {
    const ids = new Set(plan.tasks.map((t) => t.id));
    if (ot.some((t) => !ids.has(t.id))) return "removed";
    const om = new Map(ot.map((t) => [t.id, t]));
    if (plan.tasks.some((t) => { const o = om.get(t.id); return o && LOCKED.some((f) => !same(f, o[f], t[f])); })) return "locked";
  }
  const om = new Map(ot.map((t) => [t.id, t]));
  if (plan.tasks.some((t) => t.completedAt && t.completedAt !== today && t.completedAt !== ((om.get(t.id) || {}).completedAt || ""))) return "completion_date";
  return null;
}
