// Who may see and change what. The database enforces the same rules (supabase/upgrade-5-stage2-login.sql);
// this file is used to hide buttons in the app and to run the same rules in the browser test mode.
import { LOCKED } from "./rules.js";

export const ROLES = ["super_admin", "executive", "leader", "planning", "manager", "staff"];
export const ROLE_LABEL = {
  super_admin: "Group Strategy (super admin)", executive: "CEO / DCEO", leader: "Chief, director or GM",
  planning: "Planning department", manager: "Manager or department head", staff: "Employee",
};
export const ROLE_HELP = {
  super_admin: "Sees and changes everything, manages people and roles, approves changes, can undo anything.",
  executive: "Sees everything. Writes feedback. Cannot change plans. Set the title to CEO or DCEO.",
  leader: "Sees every unit. Edits everything in their own unit or function.",
  planning: "Sees and edits everything in their own unit, including deleting. Manages the unit's departments.",
  manager: "Sees their whole unit. Edits only their own departments.",
  staff: "Sees and edits only their own department.",
};

export const isAdmin = (p) => !!p && p.role === "super_admin";
export const fullRead = (p) => !!p && ["super_admin", "executive", "leader"].includes(p.role);
export const unitRead = (p, unit) => fullRead(p) || (!!p && ["planning", "manager"].includes(p.role) && p.unit === unit);
export const unitMember = (p, unit) => !!p && ["leader", "planning", "manager", "staff"].includes(p.role) && p.unit === unit;
export const unitLead = (p, unit) => !!p && ["leader", "planning", "manager"].includes(p.role) && p.unit === unit;
// Can this person change tasks of this department in this unit?
export function deptOk(p, unit, dept) {
  if (!p) return false;
  if (p.role === "super_admin") return true;
  if (p.role === "leader" || p.role === "planning") return p.unit === unit;
  if (p.role === "manager" || p.role === "staff") return p.unit === unit && !!dept && (p.departments || []).includes(dept);
  return false;
}
// Edits that skip the "fixed field" rules in a week that has started (Group Strategy, leaders and planning)
export const fullEdit = (p, unit) => !!p && (p.role === "super_admin" || ((p.role === "leader" || p.role === "planning") && p.unit === unit));
export const canUndo = (p) => !!p && ["super_admin", "leader", "planning", "manager"].includes(p.role);
export const canFeedback = (p) => !!p && ["super_admin", "executive"].includes(p.role);
export const canEditDepartments = (p, unit) => !!p && (p.role === "super_admin" || ((p.role === "leader" || p.role === "planning") && p.unit === unit));
export const canEditPeople = (p, unit) => !!p && (p.role === "super_admin" || (["leader", "planning", "manager"].includes(p.role) && p.unit === unit));
export const seesOnlyOwnDept = (p) => !!p && p.role === "staff";
export const roleText = (p) => (!p ? "" : p.role === "executive" ? (p.title || "CEO / DCEO") : p.role === "super_admin" ? "Group Strategy" : (ROLE_LABEL[p.role] || p.role));

// The plan as this person is allowed to see it (employees see only their own department).
export function visiblePlan(p, plan) {
  if (!plan || !p || p.role !== "staff") return plan;
  return { ...plan, tasks: (plan.tasks || []).filter((t) => (p.departments || []).includes(t.dept || "")), wins: "", blockers: "", asks: "" };
}

const same = (f, a, b) => (f === "kind" ? (a || "Task") === (b || "Task") : (a ?? "") === (b ?? ""));

// Apply a save the same way the database does. Returns { error, reason? } or { tasks, wins, blockers, asks, ignored }.
export function mergeSave(p, unit, old, plan, ctx) {
  const { monday, today } = ctx;
  if (!p || p.role === "executive") return { error: "not_allowed" };
  if (p.role !== "super_admin" && p.unit !== unit) return { error: "not_allowed" };
  const week = plan.week, started = !!old && week <= monday, newT = plan.tasks || [], oldT = (old && old.tasks) || [];
  if (p.role !== "super_admin" && week < monday) return { error: "needs_approval", reason: "past_week" };
  let tasks = newT, ignored = 0, wins = plan.wins || "", blockers = plan.blockers || "", asks = plan.asks || "";
  if (p.role === "manager" || p.role === "staff") {
    tasks = [];
    for (const o of oldT) {
      const n = newT.find((x) => x.id === o.id);
      if (!deptOk(p, unit, o.dept || "")) { tasks.push(o); if (n && JSON.stringify(n) !== JSON.stringify(o)) ignored++; }
      else if (!n) { if (started) return { error: "needs_approval", reason: "removed" }; }
      else {
        if (!deptOk(p, unit, n.dept || "")) return { error: "not_allowed_dept" };
        if (started && LOCKED.some((f) => !same(f, o[f], n[f]))) return { error: "needs_approval", reason: "locked" };
        tasks.push(n);
      }
    }
    for (const n of newT) if (!oldT.some((o) => o.id === n.id)) { if (!deptOk(p, unit, n.dept || "")) return { error: "not_allowed_dept" }; tasks.push(n); }
    if (p.role === "staff" && old) { wins = old.wins || ""; blockers = old.blockers || ""; asks = old.asks || ""; }
  }
  if (p.role !== "super_admin") {
    const bad = tasks.some((n) => { const o = oldT.find((x) => x.id === n.id); const c = n.completedAt || ""; return c && c !== today && c !== ((o && o.completedAt) || ""); });
    if (bad) return { error: "needs_approval", reason: "completion_date" };
  }
  return { tasks, wins, blockers, asks, ignored };
}
// Restore for a manager: take the old version of own departments only.
export function mergeScope(p, unit, current, source) {
  return [...(current || []).filter((t) => !deptOk(p, unit, t.dept || "")), ...(source || []).filter((t) => deptOk(p, unit, t.dept || ""))];
}
