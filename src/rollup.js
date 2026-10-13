// Deliverables: a task can sit under another task of the same plan (task.parent = the parent's ref).
// The parent's progress is the weighted average of its tasks: weight defaults to 1 (equal share).
// Tasks without a parent are the "deliverables"; each existing task is simply its own deliverable.

export const weightOf = (t) => { const w = Number(t && t.weight); return isFinite(w) && w > 0 ? w : 1; };
const pctOf = (t) => (t.status === "Done" ? 100 : typeof t.pct === "number" ? t.pct : 0);

// Group a plan's tasks: top-level tasks, each with its kids. A task whose parent is not in the list
// (for example an employee who only sees their own department) counts as top-level.
export function groupTasks(tasks) {
  const list = tasks || [], refs = new Set(list.filter((t) => t.ref).map((t) => t.ref));
  const kids = new Map();
  list.forEach((t) => { if (t.parent && refs.has(t.parent) && t.parent !== t.ref) { if (!kids.has(t.parent)) kids.set(t.parent, []); kids.get(t.parent).push(t); } });
  // one level only: a task that has its own tasks stays top-level even if it names a parent
  const isKid = (t) => t.parent && refs.has(t.parent) && t.parent !== t.ref && !kids.has(t.ref);
  return { top: list.filter((t) => !isKid(t)), kids };
}

// Progress and status of a deliverable from its tasks (weighted).
export function rollupOf(parent, kids) {
  if (!kids || !kids.length) return null;
  const sw = kids.reduce((a, k) => a + weightOf(k), 0);
  const pct = Math.round(kids.reduce((a, k) => a + weightOf(k) * pctOf(k), 0) / sw);
  const st = kids.map((k) => k.status || "");
  let status = "Not started";
  if (st.every((s) => s === "Done")) status = "Done";
  else if (st.includes("Blocked")) status = "Blocked";
  else if (st.includes("Delayed")) status = "Delayed";
  else if (pct > 0 || st.some((s) => s === "In progress" || s === "Done")) status = "In progress";
  const done = kids.filter((k) => k.status === "Done").length;
  const last = status === "Done" ? kids.map((k) => k.completedAt || "").sort().pop() : "";
  return { pct, status, done, total: kids.length, completedAt: last || "" };
}

// A plan with only its deliverables, each carrying the rolled-up progress (for the dashboard and executive views).
export function rolledPlan(plan) {
  if (!plan) return plan;
  const { top, kids } = groupTasks(plan.tasks);
  const tasks = top.map((t) => { const r = rollupOf(t, kids.get(t.ref)); return r ? { ...t, pct: r.pct, status: r.status, completedAt: r.completedAt, kidCount: r.total } : t; });
  return { ...plan, tasks };
}
export const rolledPlans = (plans) => Object.fromEntries(Object.entries(plans || {}).map(([k, p]) => [k, rolledPlan(p)]));

// Valid parents for a task: top-level tasks of the same plan, not itself, and only if the task has no tasks of its own.
export function parentChoices(tasks, task) {
  const list = tasks || [], hasKids = list.some((t) => t.parent && t.parent === task.ref);
  if (hasKids) return [];
  return list.filter((t) => t.ref && t.ref !== task.ref && !t.parent && (t.kind || "Task") !== "KPI / OKR");
}

// Tasks that are real work: everything except tasks that only group other tasks.
export function leafTasks(tasks) {
  const { kids } = groupTasks(tasks);
  return (tasks || []).filter((t) => !(t.ref && kids.has(t.ref)));
}
export const leafPlan = (plan) => (plan ? { ...plan, tasks: leafTasks(plan.tasks) } : plan);
