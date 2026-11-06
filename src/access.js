// Who may see and change what. The database enforces the same rules (supabase/upgrade-5-stage2-login.sql);
// this file is used to hide buttons in the app and to run the same rules in the browser test mode.
import { lockedFields } from "./rules.js";

// Roles are shown as titles. For permissions chief, GM, director and the lead executive assistant behave exactly like the
// old "leader" role, and a division head behaves like an employee (the database reports the base role, see upgrade-17).
export const ROLES = ["super_admin", "executive", "chief", "gm", "director", "lea", "planning", "manager", "divhead", "staff"];
export const ROLE_LABEL = {
  super_admin: "Group Strategy (super admin)", executive: "CEO / DCEO", leader: "Chief, director or GM",
  chief: "Chief", gm: "General manager (GM)", director: "Director", lea: "Lead executive assistant",
  planning: "Planning head", manager: "Department head", divhead: "Division head", staff: "Employee",
};
export const baseRole = (r) => (["chief", "gm", "director", "lea"].includes(r) ? "leader" : r === "divhead" ? "staff" : r);
export const ROLE_HELP = {
  super_admin: "Sees and changes everything, manages people and roles, approves changes, can undo anything.",
  executive: "Sees everything. Writes feedback. Cannot change plans. Set the title to CEO or DCEO.",
  leader: "Sees every unit. Edits everything in their own unit or function. Approves the plans of the departments they cover (leave departments empty to cover the whole unit).",
  chief: "Head of a corporate function. Sees every unit, edits their own function, approves the next-week plans of everyone in their function.",
  gm: "Head of a business unit. Same access as a chief: sees every unit, edits their own unit, approves its next-week plans.",
  director: "Head of a business unit or function. Same access as a chief: sees every unit, edits their own unit, approves its next-week plans.",
  lea: "Lead executive assistant. Sees every unit and the business units' work, and keeps their own plan and activities.",
  planning: "Sees and edits everything in their own unit, including deleting. Manages the unit's departments. Approves plans, including their own.",
  manager: "Sees their whole unit. Updates progress and plans next week for their own departments directly. Their next-week plan goes to the chief for approval.",
  divhead: "Below the department head. View only: sees their own department and asks the department head to update progress.",
  staff: "View only: sees their own department and asks the department head to update progress.",
};

// ---- the access matrix (Admin > Access). When the database runs in "matrix" mode the person's capabilities arrive with
// their profile (p.caps = { capability: none | dept | own | all }); otherwise the fixed rules below apply, exactly as before.
export const matrixOn = (p) => !!p && p.permMode === "matrix" && !!p.caps;
const RANK = { none: 0, dept: 1, own: 2, all: 3 };
export const capLevel = (p, cap) => (p && p.caps && p.caps[cap]) || "none";
// May this person use the capability for this unit / department? (unit omitted = anywhere)
export function cap(p, name, unit, dept) {
  const r = RANK[capLevel(p, name)];
  if (r >= 3) return true;
  if (r === 0) return false;
  if (unit === undefined || unit === null) return true;
  if (!p.unit || p.unit !== unit) return false;
  if (r === 2) return true;
  return !!dept && (p.departments || []).includes(dept);
}
export const isSuper = (p) => !!p && p.role === "super_admin";
export const isAdmin = (p) => matrixOn(p) ? cap(p, "approve_admin") : !!p && p.role === "super_admin";
export const canAdminPeople = (p) => matrixOn(p) ? cap(p, "admin_people") : isSuper(p);
export const canAdminSettings = (p) => matrixOn(p) ? cap(p, "admin_settings") : isSuper(p);
export const canAdminBackups = (p) => matrixOn(p) ? cap(p, "admin_backups") : isSuper(p);
export const canAdminAny = (p) => isSuper(p) || canAdminPeople(p) || canAdminSettings(p) || canAdminBackups(p) || isAdmin(p);
export const fullRead = (p) => matrixOn(p) ? capLevel(p, "read_plans") === "all" : !!p && ["super_admin", "executive", "leader"].includes(p.role);
export const unitRead = (p, unit) => matrixOn(p) ? cap(p, "read_plans", unit) : fullRead(p) || (!!p && ["planning", "manager"].includes(p.role) && p.unit === unit);
export const unitMember = (p, unit) => matrixOn(p) ? cap(p, "member_unit", unit) : !!p && ["leader", "planning", "manager", "staff"].includes(p.role) && p.unit === unit;
export const unitLead = (p, unit) => matrixOn(p) ? cap(p, "lead_unit", unit) : !!p && ["leader", "planning", "manager"].includes(p.role) && p.unit === unit;
export const canSave = (p, unit) => matrixOn(p) ? cap(p, "plan_save", unit) : !!p && !["executive", "staff"].includes(p.role) && (p.role === "super_admin" || p.unit === unit);
export const canDiscuss = (p, unit) => matrixOn(p) ? cap(p, "discuss", unit) : !!p && !!p.role && (["super_admin", "executive", "leader"].includes(p.role) || p.unit === unit);
// Can this person change tasks of this department in this unit?
export function deptOk(p, unit, dept) {
  if (!p) return false;
  if (matrixOn(p)) return cap(p, "edit_dept", unit, dept);
  if (p.role === "super_admin") return true;
  if (p.role === "leader" || p.role === "planning") return p.unit === unit;
  if (p.role === "manager" || p.role === "staff") return p.unit === unit && !!dept && (p.departments || []).includes(dept);
  return false;
}
// Edits that skip the "fixed field" rules in a week that has started (Group Strategy, leaders and planning)
export const fullEdit = (p, unit) => matrixOn(p) ? cap(p, "plan_full", unit) : !!p && (p.role === "super_admin" || ((p.role === "leader" || p.role === "planning") && p.unit === unit));
export const canUndo = (p) => matrixOn(p) ? cap(p, "undo_save") : !!p && ["super_admin", "leader", "planning", "manager"].includes(p.role);
export const canFeedback = (p) => matrixOn(p) ? cap(p, "feedback_write") : !!p && ["super_admin", "executive"].includes(p.role);
export const canReplyFeedback = (p, unit) => matrixOn(p) ? cap(p, "feedback_reply", unit) : !!p && (["super_admin", "executive"].includes(p.role) || (["leader", "planning"].includes(p.role) && p.unit === unit));
export const canEditDepartments = (p, unit) => matrixOn(p) ? cap(p, "edit_departments", unit) : !!p && (p.role === "super_admin" || ((p.role === "leader" || p.role === "planning") && p.unit === unit));
export const canEditPeople = (p, unit) => matrixOn(p) ? cap(p, "unit_lists", unit) : !!p && (p.role === "super_admin" || (["leader", "planning", "manager"].includes(p.role) && p.unit === unit));
// May this person see the cash flow / change it? (the group finance function and the DCEO are rules of the default matrix)
export const cashView = (p) => matrixOn(p) ? cap(p, "cash_view") : !!p && (p.role === "super_admin" || p.unit === "group-finance-function" || (p.roleRaw === "executive" && p.title === "DCEO"));
export const cashWrite = (p) => matrixOn(p) ? cap(p, "cash_write") : !!p && (p.role === "super_admin" || p.unit === "group-finance-function");
export const seesOnlyOwnDept = (p) => !!p && p.role === "staff";
export const roleText = (p) => (!p ? "" : p.role === "executive" ? (p.title || "CEO / DCEO") : p.role === "super_admin" ? "Group Strategy" : (ROLE_LABEL[p.roleRaw || p.role] || p.role));

// The plan as this person is allowed to see it (employees see only their own department).
export function visiblePlan(p, plan) {
  if (!plan || !p || p.role !== "staff") return plan;
  return { ...plan, tasks: (plan.tasks || []).filter((t) => (p.departments || []).includes(t.dept || "")), wins: "", blockers: "", asks: "" };
}

const same = (f, a, b) => (f === "kind" ? (a || "Task") === (b || "Task") : (a ?? "") === (b ?? ""));

// Apply a save the same way the database does. Returns { error, reason? } or { tasks, wins, blockers, asks, ignored }.
export function mergeSave(p, unit, old, plan, ctx) {
  const { monday, today } = ctx;
  if (!canSave(p, unit)) return { error: p && p.role === "staff" ? "view_only_role" : "not_allowed" };
  const m = matrixOn(p), full = m ? cap(p, "plan_full", unit) : ["super_admin", "leader", "planning"].includes(p.role);
  const past = m ? cap(p, "plan_past_week", unit) : p.role === "super_admin", anyDate = m ? cap(p, "plan_any_completion", unit) : p.role === "super_admin", unitText = m ? cap(p, "plan_unit_text", unit) : p.role !== "staff";
  const week = plan.week, started = !!old && week <= monday, newT = plan.tasks || [], oldT = (old && old.tasks) || [];
  if (!past && week < monday) return { error: "needs_approval", reason: "past_week" };
  let tasks = newT, ignored = 0, wins = plan.wins || "", blockers = plan.blockers || "", asks = plan.asks || "";
  if (!full) {
    tasks = [];
    for (const o of oldT) {
      const n = newT.find((x) => x.id === o.id);
      if (!deptOk(p, unit, o.dept || "")) { tasks.push(o); if (n && JSON.stringify(n) !== JSON.stringify(o)) ignored++; }
      else if (!n) { if (started) return { error: "needs_approval", reason: "removed" }; }
      else {
        if (!deptOk(p, unit, n.dept || "")) return { error: "not_allowed_dept" };
        if (started && lockedFields().some((f) => !same(f, o[f], n[f]))) return { error: "needs_approval", reason: "locked" };
        tasks.push(n);
      }
    }
    for (const n of newT) if (!oldT.some((o) => o.id === n.id)) { if (!deptOk(p, unit, n.dept || "")) return { error: "not_allowed_dept" }; tasks.push(n); }
    if (!unitText && old) { wins = old.wins || ""; blockers = old.blockers || ""; asks = old.asks || ""; }
  }
  if (!anyDate) {
    const bad = tasks.some((n) => { const o = oldT.find((x) => x.id === n.id); const c = n.completedAt || ""; return c && c !== today && c !== ((o && o.completedAt) || ""); });
    if (bad) return { error: "needs_approval", reason: "completion_date" };
  }
  return { tasks, wins, blockers, asks, ignored };
}
// Restore for a manager: take the old version of own departments only.
export function mergeScope(p, unit, current, source) {
  return [...(current || []).filter((t) => !deptOk(p, unit, t.dept || "")), ...(source || []).filter((t) => deptOk(p, unit, t.dept || ""))];
}

// ---- approval chain: who decides a request (the database enforces the same rules) ----
export const STAGE_LABEL = { chief: "Chief", planning: "Planning head", group: "Group Strategy", dept: "Department head" };
const deptList = (r) => String((r && r.dept) || "").split(",").map((x) => x.trim()).filter(Boolean);
export function canDecide(p, r) {
  if (!p || !p.role || !r) return false;
  if (matrixOn(p)) {
    if (cap(p, "decide_group")) return true;
    if (!p.unit || p.unit !== r.unit) return false;
    if (r.kind === "ask") { const l = capLevel(p, "decide_ask"); if (l === "own" || l === "all") return true; if (l === "dept") { const ds = deptList(r); return !ds.length || ds.some((d) => (p.departments || []).includes(d)); } return false; }
    if (r.by && p.name && r.by === p.name && !cap(p, "decide_own", r.unit)) return false;
    const st2 = r.stage || "group";
    return (["chief", "planning"].includes(st2) && cap(p, "decide_planning", r.unit)) || (st2 === "chief" && cap(p, "decide_chief", r.unit));
  }
  if (p.role === "super_admin") return true;
  if (!p.unit || p.unit !== r.unit) return false;
  if (r.kind === "ask") {   // a view-only employee asks for a progress update: their department head, chief or planning head
    if (p.role === "leader" || p.role === "planning") return true;
    if (p.role === "manager") { const ds = deptList(r); return !ds.length || ds.some((d) => (p.departments || []).includes(d)); }
    return false;
  }
  if (r.by && p.name && r.by === p.name && p.role !== "planning") return false; // nobody approves their own request (the planning head may approve their own plan)
  const st = r.stage || "group";
  if (p.role === "planning") return st === "chief" || st === "planning";
  if (p.role === "leader") return st === "chief";   // a chief, GM or director answers for everyone in their own unit or function, whatever department is set on their profile
  return false;
}
// Which step must decide a request made by `role` in `unit` for `depts`? (people = profiles, units = unit rows)
export function routeStage(people, units, unit, role, depts) {
  const fn = ((units || []).find((u) => u.id === unit) || {}).type === "Corporate function";
  const act = (people || []).filter((x) => x.unit === unit && x.status === "active" && x.setupDone !== false);
  const chief = act.some((x) => baseRole(x.role) === "leader");
  const plan = act.some((x) => x.role === "planning");
  if (role === "planning") return "planning";   // the planning head approves their own plan
  if (role === "staff" || role === "manager") return chief ? "chief" : (plan && !fn ? "planning" : "group");
  if (role === "leader") return plan && !fn ? "planning" : "group";
  return "group";
}
