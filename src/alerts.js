// Automatic reminders and blocker detection. Pure functions: given plans, return what needs attention.
// Used by the unit's reminder panel, the Follow-up tab and the executive dashboard.
// (The same checks run on a schedule in supabase/upgrade-3-reminders.sql to send Telegram reminders.)

const DAY = 864e5;
const real = (p) => ((p && p.tasks) || []).filter((t) => t.kind !== "KPI / OKR");
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const addDays = (s, n) => { const d = new Date(Date.parse(s + "T00:00:00Z") + n * DAY); return d.toISOString().slice(0, 10); };

export const BLOCKED_DAYS = 5;     // blocked this long = escalate
export const STALE_DAYS = 3;       // no save this long in the current week = reminder
export const DUE_SOON_DAYS = 2;

// ctx: { unit, plan, nextPlan, weekPlans (unit id -> plan, same week), week, thisMonday, today, requests }
export function unitAlerts(ctx) {
  const { unit, plan, nextPlan, weekPlans = {}, week, thisMonday, today, requests = [] } = ctx;
  const out = [];
  const tasks = real(plan);
  const open = tasks.filter((t) => t.status !== "Done");
  const current = week === thisMonday;
  const add = (level, kind, text, list = []) => out.push({ level, kind, text, tasks: list, unit: unit.id });

  if (week <= thisMonday && !((plan && plan.tasks) || []).length) add("bad", "no_plan", "No plan has been entered for this week.");
  const overdue = open.filter((t) => t.due && t.due < today);
  if (overdue.length) add("bad", "overdue", `${overdue.length} task${overdue.length > 1 ? "s are" : " is"} past the due date.`, overdue);
  const soon = open.filter((t) => t.due && t.due >= today && daysBetween(today, t.due) <= DUE_SOON_DAYS);
  if (soon.length) add("warn", "due_soon", `${soon.length} task${soon.length > 1 ? "s are" : " is"} due in the next ${DUE_SOON_DAYS} days.`, soon);
  const blocked = open.filter((t) => t.status === "Blocked");
  const stuck = blocked.filter((t) => t.blockedSince && daysBetween(t.blockedSince, today) >= BLOCKED_DAYS);
  if (stuck.length) add("bad", "blocked_long", `${stuck.length} task${stuck.length > 1 ? "s have" : " has"} been blocked for ${BLOCKED_DAYS}+ days. Escalate to the unit head or Group Strategy.`, stuck);
  const blockedNew = blocked.filter((t) => !stuck.includes(t));
  if (blockedNew.length) add("warn", "blocked", `${blockedNew.length} blocked task${blockedNew.length > 1 ? "s" : ""}: say in the notes what support is needed.`, blockedNew);
  const carried = open.filter((t) => (t.carriedCount || 0) >= 2);
  if (carried.length) add("warn", "carried", `${carried.length} task${carried.length > 1 ? "s have" : " has"} been carried forward 2 or more weeks.`, carried);
  const noStatus = tasks.filter((t) => !t.status);
  if (noStatus.length) add("warn", "no_status", `${noStatus.length} task${noStatus.length > 1 ? "s have" : " has"} no status.`, noStatus);
  const depBlocked = open.filter((t) => t.depUnit && t.status === "Blocked");
  if (depBlocked.length) add("info", "dep_blocked", `${depBlocked.length} blocked task${depBlocked.length > 1 ? "s depend" : " depends"} on another unit. They are shown on that unit's follow-up.`, depBlocked);

  // Other units waiting on this one
  const waiting = [];
  Object.entries(weekPlans).forEach(([u, p]) => { if (u !== unit.id) real(p).forEach((t) => { if (t.depUnit === unit.id && t.status !== "Done") waiting.push({ ...t, fromUnit: u }); }); });
  if (waiting.length) add(waiting.some((t) => t.status === "Blocked") ? "bad" : "info", "waiting", `${waiting.length} task${waiting.length > 1 ? "s" : ""} in other units ${waiting.length > 1 ? "depend" : "depends"} on ${unit.name}.`, waiting);

  if (current && plan && plan.updatedAt && Date.now() - Date.parse(plan.updatedAt) > STALE_DAYS * DAY && open.length)
    add("warn", "stale", `Not updated for ${Math.floor((Date.now() - Date.parse(plan.updatedAt)) / DAY)} days.`);
  const wd = new Date(today + "T00:00:00Z").getUTCDay(); // 4 = Thursday
  if (current && (wd >= 4 || wd === 0) && nextPlan !== undefined && !real(nextPlan).length) add("warn", "next_plan", "Next week's plan has not been entered yet.");

  const mine = requests.filter((r) => r.unit === unit.id);
  const pend = mine.filter((r) => r.status === "pending");
  if (pend.length) add("info", "pending", `${pend.length} change${pend.length > 1 ? "s are" : " is"} waiting for Group Strategy approval.`);
  const rejected = mine.filter((r) => r.status === "rejected" && r.decidedAt && Date.now() - Date.parse(r.decidedAt) < 7 * DAY);
  rejected.forEach((r) => add("warn", "rejected", `Group Strategy rejected: ${r.summary}${r.note ? ` (${r.note})` : ""}.`));
  return out;
}

export const levelRank = { bad: 0, warn: 1, info: 2 };

export function groupAlerts(units, ctxFor) {
  return units.flatMap((u) => unitAlerts(ctxFor(u))).sort((a, b) => levelRank[a.level] - levelRank[b.level]);
}

export { addDays, daysBetween };
