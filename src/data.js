// Data layer: connects to Supabase when configured, or falls back to this browser's local storage
// (loaded with the seed data) so the app runs out of the box for trying things on localhost.
// Reads use db.collection / db.doc. Every change goes through `api`, which in Supabase mode calls the
// PIN-checked database functions from supabase/upgrade-1-safe.sql.
import { createClient } from "@supabase/supabase-js";
import { SEED_UNITS, SEED_PLANS, SEED_ACTIVITY } from "./seedData.js";
import { SEED_SUPPORT } from "./seedSupport.js";
import { addisWeekStart, addisLockWeek, addisToday } from "./rules.js";
import { isAdmin, fullRead, unitRead, unitMember, unitLead, canUndo, canFeedback, canEditDepartments, visiblePlan, mergeSave, mergeScope, deptOk, canDecide, routeStage } from "./access.js";

const URL_ = import.meta.env.VITE_SUPABASE_URL;
export const IS_TEST_ENV = !URL_ || String(URL_).includes("pnipdrnpksaglmesifje");   // the test Supabase project (or no database at all)
export const VIEWAS_KEY = "wbg-viewas";
export const viewingAs = () => { try { return !!sessionStorage.getItem(VIEWAS_KEY); } catch (e) { return false; } };
const KEY_ = import.meta.env.VITE_SUPABASE_ANON_KEY;

const isSupabaseConfigured = () => !!(URL_ && KEY_ && !URL_.includes("YOUR-PROJECT-REF") && !KEY_.includes("YOUR-ANON-PUBLIC-KEY"));

// document field -> column. `ts` lists timestamp fields (normalised to ISO strings); `nullText` maps "" <-> NULL.
const COLLECTIONS = {
  units: { table: "units", map: { name: "name", type: "type", order: "sort_order", departments: "departments", people: "people" }, ts: [] },
  plans: { table: "plans", map: { week: "week", unit: "unit_id", tasks: "tasks", wins: "wins", blockers: "blockers", asks: "asks", updatedAt: "updated_at", updatedBy: "updated_by", source: "source" }, ts: ["updatedAt"] },
  activity: { table: "activity", map: { ts: "ts", by: "by_name", unit: "unit_id", week: "week", action: "action", summary: "summary", details: "details", role: "by_role" }, ts: ["ts"], nullText: ["week"] },
  requests: { table: "change_requests", map: { createdAt: "created_at", unit: "unit_id", week: "week", planId: "plan_id", by: "requested_by", status: "status", summary: "summary", details: "details", patch: "patch", decidedBy: "decided_by", decidedAt: "decided_at", note: "decision_note", dept: "dept", kind: "req_kind", stage: "stage" }, ts: ["createdAt", "decidedAt"] },
  support: { table: "support_requests", map: { ref: "ref", function: "function_id", requester: "requester", category: "category", description: "description", priority: "priority", requested: "date_requested", status: "status", responded: "response_date", action: "action_taken", respondedBy: "responded_by", evidence: "evidence_ref", followUp: "follow_up", remarks: "remarks", createdBy: "created_by", createdAt: "created_at", updatedBy: "updated_by", updatedAt: "updated_at" }, ts: ["createdAt", "updatedAt"], nullText: ["requested", "responded"] },
  feedback: { table: "feedback", map: { unit: "unit_id", week: "week", from: "from_role", by: "by_name", body: "body", taskRef: "task_ref", createdAt: "created_at", ackBy: "ack_by", ackAt: "ack_at", toLead: "to_lead" }, ts: ["createdAt", "ackAt"], nullText: ["week", "ackAt"] },
  actions: { table: "corrective_actions", map: { unit: "unit_id", week: "week", source: "source", issue: "issue", action: "action", owner: "owner", due: "due", status: "status", taskTitle: "task_title", taskRef: "task_ref", notes: "notes", createdBy: "created_by", createdAt: "created_at", updatedBy: "updated_by", updatedAt: "updated_at", closedAt: "closed_at" }, ts: ["createdAt", "updatedAt", "closedAt"], nullText: ["week", "due", "closedAt"] },
  history: { table: "row_history", map: { tbl: "tbl", rowId: "row_id", op: "op", old: "old_row", at: "changed_at", by: "changed_by" }, ts: ["at"] },
};
// A history row stores the database row; turn it back into a plan document.
export function planFromRow(r) {
  if (!r) return null;
  return { id: r.id, week: r.week, unit: r.unit_id ?? r.unit, tasks: r.tasks || [], wins: r.wins || "", blockers: r.blockers || "", asks: r.asks || "", updatedAt: r.updated_at ?? r.updatedAt ?? null, updatedBy: r.updated_by ?? r.updatedBy ?? "", source: r.source || "" };
}

const fail = (error) => {
  const e = Object.assign(new Error(error.message || "Request failed"), { code: error.code || "error" });
  window.dispatchEvent(new CustomEvent("wbg-data-error", { detail: e }));
  throw e;
};

export function configError() { return ""; }

// Task reference numbers (WE-0001). The database hands them out; local test mode does the same from here.
const PREFIX_STOP = new Set(["PLC", "AND", "OF", "THE", "FOR"]);
export function unitPrefixes(units) {
  const base = (u) => String(u.name || "").toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w && !PREFIX_STOP.has(w)).map((w) => w[0]).join("").slice(0, 3) || "U";
  const sorted = [...units].sort((a, b) => (a.id < b.id ? -1 : 1)), out = {};
  sorted.forEach((u) => { const b = base(u), rank = sorted.filter((x) => x.id < u.id && base(x) === b).length; out[u.id] = b + (rank ? rank + 1 : ""); });
  return out;
}
const titleKey = (t) => String(t.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// number every task that has none; the same title in a unit keeps one number from week to week
function assignRefs(plans, units, counters) {
  const pre = unitPrefixes(units), maps = {}; let changed = false;
  [...plans].sort((a, b) => (a.week + a.id < b.week + b.id ? -1 : 1)).forEach((p) => {
    const m = maps[p.unit] = maps[p.unit] || {};
    (p.tasks || []).forEach((t) => {
      const k = titleKey(t);
      if (t.ref) { if (!m[k]) m[k] = t.ref; const n = /-(\d+)$/.exec(t.ref); if (n) counters[p.unit] = Math.max(counters[p.unit] || 0, Number(n[1])); return; }
      if (!m[k]) { counters[p.unit] = (counters[p.unit] || 0) + 1; m[k] = `${pre[p.unit] || "T"}-${String(counters[p.unit]).padStart(4, "0")}`; }
      t.ref = m[k]; changed = true;
    });
  });
  return changed;
}

export function createData() {
  return isSupabaseConfigured() ? createSupabaseData() : createLocalData();
}

// Evidence: allowed file types and limits (also enforced by the Storage bucket: 5 MB per file).
export const EVIDENCE = {
  maxFiles: 3, maxTotal: 5 * 1024 * 1024,
  accept: ".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx",
  types: ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/csv", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
};
const extType = (name) => ({ pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", txt: "text/plain", csv: "text/csv", doc: "application/msword", docx: EVIDENCE.types[8], xls: "application/vnd.ms-excel", xlsx: EVIDENCE.types[10], ppt: "application/vnd.ms-powerpoint", pptx: EVIDENCE.types[12] })[String(name).split(".").pop().toLowerCase()] || "";
export const fileType = (f) => (EVIDENCE.types.includes(f.type) ? f.type : extType(f.name));

function planJson(p) {
  return { unit: p.unit, week: p.week, tasks: p.tasks || [], wins: p.wins || "", blockers: p.blockers || "", asks: p.asks || "", source: p.source || "" };
}

// "Stay signed in": the session lives in localStorage (kept across restarts) or sessionStorage (ends when the browser closes).
const REMEMBER_KEY = "wbg_remember";
const remember = () => { try { return localStorage.getItem(REMEMBER_KEY) !== "0"; } catch (e) { return true; } };
const sessionStore = {
  getItem: (k) => { try { return localStorage.getItem(k) ?? sessionStorage.getItem(k); } catch (e) { return null; } },
  setItem: (k, v) => { try { if (remember()) { localStorage.setItem(k, v); sessionStorage.removeItem(k); } else { sessionStorage.setItem(k, v); localStorage.removeItem(k); } } catch (e) {} },
  removeItem: (k) => { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) {} },
};
const setRemember = (on) => { try { localStorage.setItem(REMEMBER_KEY, on ? "1" : "0"); } catch (e) {} };

function createSupabaseData() {
  const sb = createClient(URL_, KEY_, { auth: { storage: sessionStore, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }, realtime: { params: { eventsPerSecond: 5 } } });
  // "View as" (Group Strategy trying other roles): on the live app it is read-only, so nothing can be written while pretending to be another role.
  if (!IS_TEST_ENV) {
    const READ_RPC = /^wbg_(me|read_|my_|task_comments|mentionables|public_units|check_email|admin_role_requests|admin_users|admin_backups|admin_get_backup|admin_approval_code_status|reminder_texts)/;
    const realRpc = sb.rpc.bind(sb);
    sb.rpc = (fn, args) => (viewingAs() && !READ_RPC.test(fn) ? Promise.resolve({ data: { error: "view_only" }, error: null }) : realRpc(fn, args));
  }
  let roleNow = "";   // employees read plans through a function that hides other departments
  const live = new Map();
  const bump = (table) => (live.get(table) || new Set()).forEach((f) => f());
  const bumpAll = () => ["plans", "units", "activity", "change_requests", "row_history", "support_requests", "feedback", "corrective_actions"].forEach(bump);

  const fromRow = (cfg, row) => {
    const doc = {};
    for (const [k, col] of Object.entries(cfg.map)) {
      let v = row[col];
      if (v === undefined) continue;
      if (v === null && cfg.nullText && cfg.nullText.includes(k)) v = "";
      if (v && cfg.ts.includes(k)) v = new Date(v).toISOString();
      doc[k] = v;
    }
    return doc;
  };
  const snapDoc = (cfg, row) => ({ id: row.id, exists: true, data: () => JSON.parse(JSON.stringify(fromRow(cfg, row))) });
  const OPS = { "==": "eq", "!=": "neq", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" };

  function query(colName, filters = [], ord = null, lim = null) {
    const cfg = COLLECTIONS[colName];
    if (!cfg) throw new Error(`Unknown collection: ${colName}`);
    const col = (f) => (f === "id" ? "id" : cfg.map[f] || f);
    const run = async () => {
      if (colName === "plans" && roleNow === "staff") {
        let from = null, to = null;
        for (const [f, op, v] of filters) if (f === "week") { if (op === "==") from = to = v; else if (op === ">=" || op === ">") from = v; else if (op === "<=" || op === "<") to = v; }
        const { data, error } = await sb.rpc("wbg_read_plans", { p_from: from, p_to: to });
        if (error) fail(error);
        const docs = (data || []).map((r) => snapDoc(cfg, r));
        return { docs, size: docs.length, empty: !docs.length };
      }
      let q = sb.from(cfg.table).select("*");
      for (const [f, op, v] of filters) q = q[OPS[op]](col(f), v);
      if (ord) q = q.order(col(ord[0]), { ascending: ord[1] !== "desc" });
      if (lim) q = q.limit(lim);
      const { data, error } = await q;
      if (error) fail(error);
      const docs = (data || []).map((r) => snapDoc(cfg, r));
      return { docs, size: docs.length, empty: !docs.length };
    };
    return {
      where: (f, op, v) => query(colName, [...filters, [f, op, v]], ord, lim),
      orderBy: (f, d = "asc") => query(colName, filters, [f, d], lim),
      limit: (n) => query(colName, filters, ord, n),
      get: run,
      onSnapshot(next, onError) {
        let stopped = false, timer = null;
        const refetch = () => { if (stopped) return; clearTimeout(timer); timer = setTimeout(() => run().then((s) => !stopped && next(s)).catch((e) => !stopped && onError && onError(e)), 120); };
        run().then((s) => !stopped && next(s)).catch((e) => !stopped && onError && onError(e));
        if (!live.has(cfg.table)) live.set(cfg.table, new Set());
        live.get(cfg.table).add(refetch);
        const ch = sb.channel(`wbg-${cfg.table}-${Math.random().toString(36).slice(2)}`)
          .on("postgres_changes", { event: "*", schema: "public", table: cfg.table }, refetch)
          .subscribe();
        const poll = colName === "plans" && roleNow === "staff" ? setInterval(refetch, 20000) : null;
        return () => { stopped = true; clearTimeout(timer); if (poll) clearInterval(poll); live.get(cfg.table).delete(refetch); sb.removeChannel(ch); };
      },
    };
  }
  function docRef(path) {
    const [colName, id] = path.split("/");
    const cfg = COLLECTIONS[colName];
    if (!cfg) throw new Error(`Unknown collection: ${colName}`);
    return {
      id, path,
      async get() {
        const { data, error } = await sb.from(cfg.table).select("*").eq("id", id).maybeSingle();
        if (error) fail(error);
        return data ? snapDoc(cfg, data) : { id, exists: false, data: () => undefined };
      },
    };
  }

  const rpc = async (fn, args) => {
    const { data, error } = await sb.rpc(fn, args || {});
    if (error) fail(error);
    bumpAll();
    return data || { error: "no_response" };
  };
  // reads that change nothing: no refresh of the live lists
  const rpcq = async (fn, args) => { const { data, error } = await sb.rpc(fn, args || {}); if (error) fail(error); return data || { error: "no_response" }; };
  const api = {
    mode: "supabase",
    // ----- sign-in (Supabase Auth, one-time code sent to the email) -----
    async session() { const { data } = await sb.auth.getSession(); return data.session ? this.me() : null; },
    async me() { const { data, error } = await sb.rpc("wbg_me"); if (error) fail(error); roleNow = (data && data.status === "active" && data.setupDone) ? data.role : ""; return data; },
    setProfile(p) { roleNow = p && p.status === "active" && p.setupDone ? p.role : ""; },
    async checkEmail(email) { const { data, error } = await sb.rpc("wbg_check_email", { p_email: email }); if (error) return { allowed: false, error: error.message }; return data; },
    async sendCode(email) { const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } }); return error ? { error: error.message, status: error.status } : { ok: true }; },
    async verifyCode(email, token) { const { error } = await sb.auth.verifyOtp({ email, token, type: "email" }); if (error) return { error: error.message }; return { profile: await this.me() }; },
    async signOut() { roleNow = ""; await sb.auth.signOut(); },
    async signInPassword(email, password, stay) {
      setRemember(stay !== false);
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return { error: error.message, status: error.status };
      return { profile: await this.me() };
    },
    // a code sign-in also honours "stay signed in": the choice is stored before the session is created
    setRemember(on) { setRemember(on); },
    async hasPassword() { const { data } = await sb.auth.getUser(); return !!(data && data.user && data.user.user_metadata && data.user.user_metadata.has_password); },
    async setPassword(password) { const { error } = await sb.auth.updateUser({ password, data: { has_password: true } }); return error ? { error: error.message } : { ok: true }; },
    adminResetPassword: (id) => rpc("wbg_admin_reset_password", { p_user: id }),
    // ----- profile settings and role requests -----
    updateProfile: (data) => rpc("wbg_update_profile", { p_data: data }),
    requestRole: (r) => rpc("wbg_request_role", { p_role: r.role, p_unit: r.unit || "", p_departments: r.departments || [], p_reason: r.reason || "", p_kind: r.kind || "upgrade" }),
    myRoleRequests: () => rpcq("wbg_my_role_requests"),
    withdrawRoleRequest: (id) => rpc("wbg_withdraw_role_request", { p_id: id }),
    adminRoleRequests: () => rpcq("wbg_admin_role_requests"),
    adminDecideRole: (id, approve, data) => rpc("wbg_admin_decide_role", { p_id: id, p_approve: approve, p_data: data || {} }),
    adminSetApprovalCode: (code) => rpc("wbg_admin_set_approval_code", { p_code: code || "" }),
    adminApprovalCodeStatus: () => rpcq("wbg_admin_approval_code_status"),
    approveRoleWithCode: (id, code) => rpc("wbg_approve_role_with_code", { p_id: id, p_code: code || "" }),
    async signOutEverywhere() { roleNow = ""; await sb.auth.signOut({ scope: "global" }); },
    allocRefs: (auth, unit, n) => rpc("wbg_alloc_refs", { p_unit: unit, p_n: n }),
    taskComments: (auth, unit, ref) => rpcq("wbg_task_comments", { p_unit: unit, p_ref: ref }),
    mentionables: (auth, unit) => rpcq("wbg_mentionables", { p_unit: unit }),
    addComment: (auth, c) => rpc("wbg_add_comment", { p_unit: c.unit, p_ref: c.ref, p_task_id: c.taskId || "", p_week: c.week || null, p_body: c.body, p_mentions: c.mentions || [] }),
    myMentions: () => rpcq("wbg_my_mentions"),
    readMentions: (auth, unit, ref) => rpcq("wbg_read_mentions", { p_unit: unit, p_ref: ref }),
    onSignedOut(fn) { sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") fn(); }); },
    async publicUnits() { const { data, error } = await sb.rpc("wbg_public_units"); if (error) fail(error); return data || []; },
    async requestAccess(r) { const { data, error } = await sb.rpc("wbg_request_access", { p_email: r.email, p_name: r.name, p_unit: r.unit || "", p_contact: r.contact || "", p_note: r.note || "" }); if (error) return { error: error.message }; return data; },
    async completeSignup(name, unit, departments) { const { data, error } = await sb.rpc("wbg_complete_signup", { p_name: name, p_unit: unit || "", p_departments: departments || [] }); if (error) return { error: error.message }; if (data && data.error) return data; roleNow = data.status === "active" && data.setupDone ? data.role : ""; return { profile: data }; },
    // ----- people (Group Strategy only) -----
    adminUsers: () => rpc("wbg_admin_users"),
    adminSaveUser: (id, data) => rpc("wbg_admin_save_user", { p_user: id, p_data: data }),
    adminInvite: (data) => rpc("wbg_admin_invite", { p_data: data }),
    adminDeleteInvite: (email) => rpc("wbg_admin_delete_invite", { p_email: email }),
    adminDecideAccess: (id, approve, data) => rpc("wbg_admin_decide_access", { p_id: id, p_approve: approve, p_data: data || {} }),
    adminSetDomains: (domains) => rpc("wbg_admin_set_domains", { p_domains: domains }),
    appSettings: () => rpcq("wbg_settings"),
    adminSetSetting: (key, value) => rpc("wbg_admin_set_setting", { p_key: key, p_value: value }),
    adminBackups: () => rpc("wbg_admin_backups"),
    adminGetBackup: (day) => rpc("wbg_admin_get_backup", { p_day: day }),
    savePlan: (auth, plan, base, force, activity) => rpc("wbg_save_plan", { p_auth: auth, p_plan: planJson(plan), p_base: base || null, p_force: !!force, p_activity: activity || null }),
    requestChange: (auth, req) => rpc("wbg_request_change", { p_auth: auth, p_req: req }),
    askUpdate: (auth, req) => rpc("wbg_ask_update", { p_auth: auth, p_req: req }),
    decideRequest: (auth, id, approve, note, plan) => rpc("wbg_decide_request", { p_auth: auth, p_id: id, p_approve: approve, p_note: note || "", p_plan: plan ? planJson(plan) : null }),
    withdrawRequest: (auth, id) => rpc("wbg_withdraw_request", { p_auth: auth, p_id: id }),
    restoreVersion: (auth, hid) => rpc("wbg_restore_version", { p_auth: auth, p_history_id: Number(hid) }),
    undoLast: (auth, planId) => rpc("wbg_undo_last_save", { p_auth: auth, p_plan_id: planId }),
    saveUnit: (auth, op, data, summary) => rpc("wbg_save_unit", { p_auth: auth, p_op: op, p_data: data, p_summary: summary || "" }),
    log: (auth, entry) => rpc("wbg_log", { p_auth: auth, p_entry: entry }),
    restoreBackup: (auth, backup) => rpc("wbg_restore_backup", { p_auth: auth, p_backup: backup }),
    saveSupport: (auth, row) => rpc("wbg_save_support", { p_auth: auth, p_row: row }),
    deleteSupport: (auth, id) => rpc("wbg_delete_support", { p_auth: auth, p_id: id }),
    saveFeedback: (auth, row) => rpc("wbg_save_feedback", { p_auth: auth, p_row: row }),
    deleteFeedback: (auth, id) => rpc("wbg_delete_feedback", { p_auth: auth, p_id: id }),
    ackFeedback: (auth, id) => rpc("wbg_ack_feedback", { p_auth: auth, p_id: id }),
    saveAction: (auth, row) => rpc("wbg_save_action", { p_auth: auth, p_row: row }),
    deleteAction: (auth, id) => rpc("wbg_delete_action", { p_auth: auth, p_id: id }),
    async uploadEvidence(file, path) {
      const { error } = await sb.storage.from("evidence").upload(path, file, { contentType: fileType(file), upsert: false });
      if (error) fail({ code: "upload_failed", message: error.message });
      return { path };
    },
    async evidenceBlob(path) { const { data, error } = await sb.storage.from("evidence").download(path); if (error) fail(error); return data; },
    async evidenceUrl(path, name) {
      const { data, error } = await sb.storage.from("evidence").createSignedUrl(path, 3600, { download: name || true });
      if (error) fail({ code: "not_found", message: error.message });
      return data.signedUrl;
    },
    async readAll(table) {
      const out = []; let from = 0;
      for (;;) { const { data, error } = await sb.from(table).select("*").range(from, from + 999); if (error) fail(error); out.push(...data); if (data.length < 1000) break; from += 1000; }
      return out;
    },
  };

  const db = { doc: docRef, collection: (c) => query(c) };
  return { db, api, downloads: getDownloads(), mode: "supabase" };
}

// ---------------------------------------------------------------------------
// Local mode: everything lives in this browser. Same rules as the database, for trying the app on localhost.
// ---------------------------------------------------------------------------
function createLocalData() {
  const KEYS = { units: "wbg_local_units", plans: "wbg_local_plans", activity: "wbg_local_activity", requests: "wbg_local_requests", history: "wbg_local_history", support: "wbg_local_support", feedback: "wbg_local_feedback", actions: "wbg_local_actions" };
  const DOMAINS = ["wagwagoelectric.com", "geezinstitute.com", "wanzalogistics.com", "niyatconsultancy.com", "niyatconsultnacy.com", "trucksload.net"];
  const SEEDS = { units: SEED_UNITS, plans: SEED_PLANS, activity: SEED_ACTIVITY, requests: [], history: [], support: SEED_SUPPORT, feedback: [], actions: [] };
  const listeners = new Map();
  const getStore = (c) => {
    try {
      const raw = localStorage.getItem(KEYS[c]);
      if (!raw) { const seed = SEEDS[c] || []; localStorage.setItem(KEYS[c], JSON.stringify(seed)); return JSON.parse(JSON.stringify(seed)); }
      return JSON.parse(raw);
    } catch (e) { return JSON.parse(JSON.stringify(SEEDS[c] || [])); }
  };
  const setStore = (c, items) => { try { localStorage.setItem(KEYS[c], JSON.stringify(items)); } catch (e) { fail({ code: "quota_exceeded", message: "Browser storage is full" }); } notify(c); };
  const notify = (c) => (listeners.get(c) || new Set()).forEach((fn) => fn());
  const snapDoc = (item) => ({ id: item.id, exists: true, data: () => JSON.parse(JSON.stringify(item)) });
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  function query(c, filters = [], ord = null, lim = null) {
    const run = async () => {
      let items = readFilter(c, getStore(c));
      for (const [f, op, v] of filters) items = items.filter((it) => { const x = it[f]; return op === "==" ? x === v : op === "!=" ? x !== v : op === ">" ? x > v : op === ">=" ? x >= v : op === "<" ? x < v : op === "<=" ? x <= v : true; });
      if (ord) { const [f, dir] = ord; items.sort((a, b) => { const A = a[f] ?? "", B = b[f] ?? ""; return A < B ? (dir === "desc" ? 1 : -1) : A > B ? (dir === "desc" ? -1 : 1) : 0; }); }
      if (lim) items = items.slice(0, lim);
      const docs = items.map(snapDoc);
      return { docs, size: docs.length, empty: !docs.length };
    };
    return {
      where: (f, op, v) => query(c, [...filters, [f, op, v]], ord, lim),
      orderBy: (f, d = "asc") => query(c, filters, [f, d], lim),
      limit: (n) => query(c, filters, ord, n),
      get: run,
      onSnapshot(next, onError) {
        let stopped = false;
        const refetch = () => { if (!stopped) run().then((s) => !stopped && next(s)).catch((e) => !stopped && onError && onError(e)); };
        refetch();
        if (!listeners.has(c)) listeners.set(c, new Set());
        listeners.get(c).add(refetch);
        return () => { stopped = true; listeners.get(c)?.delete(refetch); };
      },
    };
  }
  function docRef(path) {
    const [c, id] = path.split("/");
    return { id, path, async get() { const it = getStore(c).find((x) => x.id === id); return it ? snapDoc(it) : { id, exists: false, data: () => undefined }; } };
  }

  // writes, with the same automatic history the database trigger keeps
  let hid = Date.now();
  const keepHistory = (tbl, old, op, by) => {
    const h = getStore("history");
    const row = tbl === "plans" ? { id: old.id, week: old.week, unit_id: old.unit, tasks: old.tasks, wins: old.wins, blockers: old.blockers, asks: old.asks, updated_at: old.updatedAt, updated_by: old.updatedBy, source: old.source } : { id: old.id, name: old.name, type: old.type, sort_order: old.order, departments: old.departments, people: old.people };
    h.unshift({ id: String(++hid), tbl, rowId: old.id, op, old: row, at: new Date().toISOString(), by: by || null });
    setStore("history", h.slice(0, 2000));
  };
  const put = (c, rec, by) => {
    const items = getStore(c), i = items.findIndex((x) => x.id === rec.id);
    if (i >= 0) { if (c === "plans" || c === "units") keepHistory(c, items[i], "UPDATE", by); items[i] = rec; } else items.push(rec);
    setStore(c, items);
  };
  const del = (c, id) => { const items = getStore(c), i = items.findIndex((x) => x.id === id); if (i < 0) return; if (c === "plans" || c === "units") keepHistory(c, items[i], "DELETE"); items.splice(i, 1); setStore(c, items); };
  const addActivity = (by, unit, week, e) => { const a = getStore("activity"); a.push({ id: e.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 8), ts: new Date().toISOString(), by: by || "", unit: unit || "", week: week || "", action: e.action || "save", summary: e.summary || "", details: e.details || [], role: (A().role || "") }); setStore("activity", a); };

  // ----- people in test mode: pick who you are; the same rules as the database apply -----
  const PEOPLE0 = [
    { id: "surafel.h@wagwagoelectric.com", name: "Surafel Hailu", role: "super_admin", title: "Group Strategy", unit: "group-strategy-office", departments: [] },
    { id: "ceo@wagwagoelectric.com", name: "CEO (test)", role: "executive", title: "CEO", unit: null, departments: [] },
    { id: "dceo@wagwagoelectric.com", name: "DCEO (test)", role: "executive", title: "DCEO", unit: null, departments: [] },
    { id: "gm@wagwagoelectric.com", name: "Wagwago GM (test)", role: "gm", title: "GM", unit: "wagwago-electric", departments: [] },
    { id: "planning@wagwagoelectric.com", name: "Tsedenya (Wagwago planning)", role: "planning", title: "Planning", unit: "wagwago-electric", departments: ["Planning"] },
    { id: "hr.manager@wagwagoelectric.com", name: "Eden (Wagwago HR manager)", role: "manager", title: "Manager", unit: "wagwago-electric", departments: ["HR"] },
    { id: "hr.chief@wagwagoelectric.com", name: "Selam (Wagwago HR chief)", role: "chief", title: "Chief", unit: "wagwago-electric", departments: ["HR"] },
    { id: "design@wagwagoelectric.com", name: "Alem (Wagwago Design)", role: "staff", title: "", unit: "wagwago-electric", departments: ["Design and Engineering"] },
    { id: "planning@trucksload.net", name: "Trucksload planning (test)", role: "planning", title: "Planning", unit: "trucksload", departments: ["Planning"] },
    { id: "chro@wagwagoelectric.com", name: "Group HR chief (test)", role: "chief", title: "Chief", unit: "hrm", departments: [] },
  ].map((p) => ({ email: p.id, status: "active", setupDone: true, invited: true, ...p }));
  const NEWBIE = { id: "new.person@wagwagoelectric.com", email: "new.person@wagwagoelectric.com", name: "", role: "staff", title: "", unit: null, departments: [], status: "active", setupDone: false, invited: false };
  const people = () => { let p = read("wbg_local_people"); if (!p) { p = [...PEOPLE0, NEWBIE]; write("wbg_local_people", p); } return p; };
  const setPeople = (p) => write("wbg_local_people", p);
  const roleReqs = () => read("wbg_local_rolereq") || [];
  const setRoleReqs = (l) => write("wbg_local_rolereq", l);
  const invites = () => read("wbg_local_invites") || [];
  const accessReqs = () => read("wbg_local_access") || [];
  const domains = () => read("wbg_local_domains") || DOMAINS;
  const curId = () => read("wbg_local_session");
  const prof = () => people().find((x) => x.id === curId()) || null;
  // the caller as the database sees them
  const A = () => { const p = prof(); return p && p.status === "active" && p.setupDone ? { id: p.id, name: p.name, role: p.role, title: p.title, unit: p.unit, departments: p.departments || [] } : {}; };
  const meOut = (p) => (p ? { status: p.status, setupDone: p.setupDone, invited: p.invited, id: p.id, email: p.email, name: p.name, role: p.role, title: p.title, unit: p.unit, departments: p.departments || [], phone: p.phone || "", jobTitle: p.jobTitle || "" } : null);
  // what each collection shows this person (same as the row level security policies)
  function readFilter(c, items) {
    const a = A(); if (!a.role) return [];
    if (c === "units") return items;
    const U = (u) => unitRead(a, u);
    if (c === "plans") return items.filter((p) => U(p.unit) || (a.role === "staff" && a.unit === p.unit)).map((p) => visiblePlan(a, p));
    if (c === "activity") return items.filter((x) => (x.unit ? U(x.unit) : fullRead(a)));
    if (c === "feedback") return items.filter((x) => ["super_admin", "executive"].includes(a.role) || (x.toLead ? ["leader", "planning"].includes(a.role) && a.unit === x.unit : U(x.unit)));
    if (c === "requests" || c === "actions") return items.filter((x) => U(x.unit));
    if (c === "support") return items.filter((x) => U(x.function));
    if (c === "history") return items.filter((x) => U(x.tbl === "plans" ? x.old.unit_id : x.rowId));
    return items;
  }

  { // number tasks that have no reference yet (seed data and older local data)
    const plans = getStore("plans"), counters = read("wbg_local_refs") || {};
    if (assignRefs(plans, getStore("units"), counters)) { setStore("plans", plans); write("wbg_local_refs", counters); }
  }
  const isAppr = (a) => isAdmin(a);
  const discussOk = (a, unit) => !!a.role && (["super_admin", "executive", "leader"].includes(a.role) || a.unit === unit);
  const unitOk = (a, unit) => unitMember(a, unit);
  const leadOk = (a, unit) => unitLead(a, unit);
  const ok = (x) => Promise.resolve({ ok: true, ...(x || {}) });
  const err = (e, x) => Promise.resolve({ error: e, ...(x || {}) });
  const planId = (w, u) => `${w}_${u}`;
  const savePlanRaw = (auth, plan, source) => {
    const id = planId(plan.week, plan.unit), at = new Date().toISOString();
    put("plans", { id, week: plan.week, unit: plan.unit, tasks: plan.tasks || [], wins: plan.wins || "", blockers: plan.blockers || "", asks: plan.asks || "", updatedAt: at, updatedBy: (auth.name || "").trim(), source: source ?? (plan.source || "") }, (auth.name || "").trim());
    return at;
  };

  const api = {
    mode: "local",
    savePlan(auth, plan, base, force, activity) {
      if (!auth.role) return err("not_allowed");
      const old = getStore("plans").find((x) => x.id === planId(plan.week, plan.unit));
      if (old && base && !force && old.updatedAt !== base) return err("conflict", { updatedAt: old.updatedAt, updatedBy: old.updatedBy });
      const r = mergeSave(auth, plan.unit, old, plan, { monday: addisLockWeek(), today: addisToday() });
      if (r.error) return err(r.error, r.reason ? { reason: r.reason } : {});
      const at = savePlanRaw(auth, { ...plan, tasks: r.tasks, wins: r.wins, blockers: r.blockers, asks: r.asks });
      if (activity) addActivity(auth.name, plan.unit, plan.week, activity);
      return ok({ updatedAt: at, ignored: r.ignored });
    },
    askUpdate(auth, req) {
      if (!auth.role || auth.unit !== req.unit || !String(req.text || "").trim()) return err("not_allowed");
      const r = getStore("requests"), depts = (req.depts || []).filter((d) => (auth.departments || []).includes(d));
      r.push({ id: req.id, createdAt: new Date().toISOString(), unit: req.unit, week: req.week, planId: planId(req.week, req.unit), by: (auth.name || "").trim(), status: "pending", summary: String(req.text).trim().slice(0, 500), details: [String(req.text).trim().slice(0, 500)], patch: [], decidedBy: null, decidedAt: null, note: "", dept: (depts.length ? depts : (auth.departments || [])).join(","), kind: "ask", stage: "dept" });
      setStore("requests", r);
      addActivity(auth.name, req.unit, req.week, { action: "request", summary: "Asked their department head for an update: " + String(req.text).trim().slice(0, 200) });
      return ok();
    },
    requestChange(auth, req) {
      if (auth.role === "staff") return err("view_only_role");
      if (!unitOk(auth, req.unit) && !isAppr(auth)) return err("not_allowed");
      const r = getStore("requests");
      let depts = [...new Set((req.depts || []).filter(Boolean))];
      if (["manager", "staff"].includes(auth.role)) { depts = depts.filter((d) => (auth.departments || []).includes(d)); if (!depts.length) depts = [...(auth.departments || [])]; }
      const kind = (req.patch || []).some((o) => o.op === "submit") ? "plan" : (req.week < addisLockWeek() ? "actual" : "plan");
      const stage = isAppr(auth) ? "group" : routeStage(people(), getStore("units"), req.unit, auth.role, depts);
      r.push({ id: req.id, createdAt: new Date().toISOString(), unit: req.unit, week: req.week, planId: planId(req.week, req.unit), by: (auth.name || "").trim(), status: "pending", summary: req.summary || "", details: req.details || [], patch: req.patch || [], decidedBy: null, decidedAt: null, note: "", dept: depts.join(","), kind, stage });
      setStore("requests", r);
      addActivity(auth.name, req.unit, req.week, { action: "request", summary: "Asked for approval: " + (req.summary || ""), details: req.details || [] });
      return ok();
    },
    decideRequest(auth, id, approve, note, plan) {
      const r = getStore("requests"), q = r.find((x) => x.id === id);
      if (!q || q.status !== "pending") return err("not_pending");
      if (!canDecide(auth, q)) return err("not_allowed");
      if (!approve && !String(note || "").trim()) return err("reason_needed");
      if (approve && q.kind !== "ask") savePlanRaw(auth, { ...plan, unit: q.unit, week: q.week }, "");
      Object.assign(q, { status: approve ? "approved" : "rejected", decidedBy: auth.name.trim(), decidedAt: new Date().toISOString(), note: note || "" });
      setStore("requests", r);
      addActivity(auth.name, q.unit, q.week, { action: "approval", summary: `${approve ? "Approved" : "Rejected"} request from ${q.by}: ${q.summary}${note ? " · Note: " + note : ""}`, details: q.details });
      return ok();
    },
    withdrawRequest(auth, id) {
      const r = getStore("requests"), q = r.find((x) => x.id === id);
      if (!q || q.status !== "pending") return err("not_pending");
      if (!unitOk(auth, q.unit) && !isAppr(auth)) return err("not_allowed");
      Object.assign(q, { status: "withdrawn", decidedBy: auth.name.trim(), decidedAt: new Date().toISOString() });
      setStore("requests", r); return ok();
    },
    restoreVersion(auth, hidv) {
      if (!canUndo(auth)) return err("not_allowed");
      const h = getStore("history").find((x) => x.id === String(hidv)); if (!h) return err("not_found");
      const when = h.at.slice(0, 16).replace("T", " ");
      if (h.tbl === "plans") {
        const p = planFromRow(h.old);
        if (!isAppr(auth) && (auth.unit !== p.unit || p.week < addisLockWeek())) return err("not_allowed");
        let tasks = p.tasks;
        if (auth.role === "manager") { const cur = getStore("plans").find((x) => x.id === p.id); tasks = mergeScope(auth, p.unit, cur && cur.tasks, p.tasks); }
        savePlanRaw(auth, { ...p, tasks }, "Restored copy from " + when);
        addActivity(auth.name, p.unit, p.week, { action: "restore", summary: "Restored the plan to the copy saved before " + when + " UTC" + (auth.role === "manager" ? " (own departments only)" : "") });
      } else {
        if (!isAppr(auth)) return err("not_allowed");
        const o = h.old; put("units", { id: o.id, name: o.name, type: o.type, order: o.sort_order, departments: o.departments || [], people: o.people || [] }); addActivity(auth.name, o.id, "", { action: "restore", summary: `Restored unit "${o.name}"` });
      }
      return ok();
    },
    undoLast(auth, id) {
      if (!canUndo(auth)) return err("not_allowed");
      const p = getStore("plans").find((x) => x.id === id); if (!p) return err("not_found");
      if (!isAppr(auth) && auth.unit !== p.unit) return err("not_allowed");
      if (p.updatedBy !== (auth.name || "").trim() || Date.now() - Date.parse(p.updatedAt) > 30 * 60e3) return err("too_late");
      const h = getStore("history").find((x) => x.tbl === "plans" && x.rowId === id && x.op !== "SNAPSHOT"); if (!h) return err("not_found");
      savePlanRaw(auth, { ...planFromRow(h.old), unit: p.unit, week: p.week }, "Undo");
      addActivity(auth.name, p.unit, p.week, { action: "restore", summary: "Undid the last save" });
      return ok();
    },
    saveUnit(auth, op, data, summary) {
      const appr = isAppr(auth), units = getStore("units"), u = units.find((x) => x.id === data.id);
      if (op === "lists") { if (!appr && !leadOk(auth, data.id)) return err("not_allowed"); if (data.departments && !canEditDepartments(auth, data.id)) return err("not_allowed"); if (!u) return err("not_found"); put("units", { ...u, ...(data.departments ? { departments: data.departments } : {}), ...(data.people ? { people: data.people } : {}) }); }
      else if (!appr) return err("not_allowed");
      else if (op === "add") { if (!u) put("units", { id: data.id, name: data.name, type: data.type || "Business unit", order: data.order || 99, departments: [], people: [] }); }
      else if (op === "update") { if (u) put("units", { ...u, ...(data.name ? { name: data.name } : {}), ...(data.type ? { type: data.type } : {}) }); }
      else if (op === "remove") del("units", data.id);
      addActivity(auth.name, data.id, "", { action: op === "lists" ? "lists" : "unit", summary: summary || op + " unit" });
      return ok();
    },
    log(auth, e) { if (!isAppr(auth) && !unitOk(auth, e.unit)) return err("not_allowed"); addActivity(auth.name, e.unit, e.week, e); return ok(); },
    restoreBackup(auth, b) {
      if (!isAppr(auth)) return err("not_allowed");
      (b.units || []).forEach((u) => put("units", { id: u.id, name: u.name, type: u.type, order: u.order, departments: u.departments || [], people: u.people || [] }));
      (b.plans || []).forEach((p) => put("plans", { ...p }, auth.name));
      addActivity(auth.name, "", "", { action: "restore", summary: `Restored from backup file: ${(b.units || []).length} units, ${(b.plans || []).length} plans` });
      return ok({ units: (b.units || []).length, plans: (b.plans || []).length });
    },
    saveSupport(auth, row) {
      const fn = row.function || ""; if (!fn) return err("bad_request");
      if (!isAppr(auth) && !leadOk(auth, fn)) return err("not_allowed");
      const items = getStore("support"), old = row.id ? items.find((x) => x.id === row.id) : null, name = (auth.name || "").trim(), now = new Date().toISOString();
      if (old && old.function !== fn && !isAppr(auth)) return err("not_allowed");
      const n = items.reduce((m, x) => Math.max(m, parseInt(String(x.ref || "").replace(/\D/g, ""), 10) || 0), 0) + 1;
      const rec = { requester: "", category: "", description: "", priority: "Normal", requested: "", status: "Open", responded: "", action: "", respondedBy: "", evidence: "", followUp: false, remarks: "", ...(old || {}), ...row, function: fn,
        id: old ? old.id : (row.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 8)), ref: old ? old.ref : (row.ref || "SR-" + String(n).padStart(4, "0")),
        createdBy: old ? old.createdBy : name, createdAt: old ? old.createdAt : now, updatedBy: name, updatedAt: now };
      put("support", rec);
      addActivity(name, fn, "", { action: "support", summary: `${old ? "Updated" : "Logged"} support request ${rec.ref} from ${rec.requester} (${rec.status})` });
      return ok({ id: rec.id, ref: rec.ref });
    },
    deleteSupport(auth, id) { if (!isAppr(auth)) return err("not_allowed"); const o = getStore("support").find((x) => x.id === id); if (!o) return err("not_found"); del("support", id); addActivity(auth.name, o.function, "", { action: "support", summary: "Deleted support request " + o.ref }); return ok(); },
    saveFeedback(auth, row) {
      if (!canFeedback(auth)) return err("not_allowed");
      const from = auth.role === "executive" ? auth.title : (row.from || "Group Strategy");
      if (!row.unit || !(row.body || "").trim() || !["CEO", "DCEO", "Group Strategy"].includes(from)) return err("bad_request");
      const old = row.id ? getStore("feedback").find((x) => x.id === row.id) : null;
      put("feedback", { ackBy: "", ackAt: "", ...(old || {}), id: old ? old.id : (row.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 8)), unit: row.unit, week: row.week || "", taskRef: row.taskRef || (old && old.taskRef) || "", from, body: row.body, toLead: row.toLead !== undefined ? !!row.toLead : !!(old && old.toLead), by: old ? old.by : (auth.name || "").trim(), createdAt: old ? old.createdAt : new Date().toISOString() });
      addActivity(auth.name, row.unit, row.week || "", { action: "feedback", summary: (row.toLead ? "Letter from " : "Feedback from ") + from });
      return ok();
    },
    deleteFeedback(auth, id) { const f = getStore("feedback").find((x) => x.id === id); if (!f) return err("not_found"); if (!(isAppr(auth) || (auth.role === "executive" && f.by === auth.name))) return err("not_allowed"); del("feedback", id); return ok(); },
    ackFeedback(auth, id) {
      const f = getStore("feedback").find((x) => x.id === id); if (!f) return err("not_found");
      if (!isAppr(auth) && !leadOk(auth, f.unit)) return err("not_allowed");
      put("feedback", { ...f, ackBy: (auth.name || "").trim(), ackAt: new Date().toISOString() }); return ok();
    },
    saveAction(auth, row) {
      const unit = row.unit || ""; if (!unit) return err("bad_request");
      const appr = isAppr(auth); if (!appr && !leadOk(auth, unit)) return err("not_allowed");
      const status = row.status || "Open"; if (!["Open", "In progress", "Done", "Closed"].includes(status)) return err("bad_request");
      if (status === "Closed" && !appr) return err("not_allowed");
      const old = row.id ? getStore("actions").find((x) => x.id === row.id) : null; if (old && old.unit !== unit) return err("not_allowed");
      const name = (auth.name || "").trim(), now = new Date().toISOString(), src = appr && ["Self", "CEO", "DCEO", "Group Strategy"].includes(row.source) ? row.source : (old ? old.source : "Self");
      const rec = { week: "", issue: "", action: "", owner: "", due: "", taskTitle: "", notes: "", closedAt: "", ...(old || {}), ...row, id: old ? old.id : (row.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 8)), unit, status, source: src,
        createdBy: old ? old.createdBy : name, createdAt: old ? old.createdAt : now, updatedBy: name, updatedAt: now, closedAt: ["Done", "Closed"].includes(status) ? ((old && old.closedAt) || now) : "" };
      put("actions", rec);
      addActivity(name, unit, rec.week || "", { action: "corrective", summary: `${old ? "Updated corrective action (" + status + "): " : "Logged corrective action: "}${(rec.action || "").slice(0, 120)}` });
      return ok({ id: rec.id });
    },
    deleteAction(auth, id) { if (!isAppr(auth)) return err("not_allowed"); del("actions", id); return ok(); },
    // ----- sign-in (test mode: pick a person) -----
    async session() { const p = prof(); return p ? meOut(p) : null; },
    async me() { return meOut(prof()); },
    setProfile() {},
    localPeople: () => people().map(meOut),
    localSignIn(id) { const p = people().find((x) => x.id === id); if (!p) return null; write("wbg_local_session", id); return meOut(p); },
    async checkEmail(email) { const e = (email || "").trim().toLowerCase(), d = e.split("@")[1] || ""; return { allowed: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && (domains().includes(d) || invites().some((i) => i.email === e) || people().some((p) => p.email === e)) }; },
    async sendCode() { return { ok: true }; },
    setRemember() {},
    async signInPassword(email, password) { const e = (email || "").trim().toLowerCase(), p = people().find((x) => x.email === e); if (!p || !p.pw || p.pw !== password) return { error: "Invalid login credentials" }; write("wbg_local_session", p.id); return { profile: meOut(p) }; },
    async hasPassword() { const p = prof(); return !!(p && p.pw); },
    async setPassword(password) { const l = people(), p = l.find((x) => x.id === curId()); if (!p) return { error: "not_signed_in" }; p.pw = password; setPeople(l); return { ok: true }; },
    // ----- discussion on tasks (same rules as the database functions) -----
    async taskComments(auth, unit, ref) {
      if (!discussOk(auth, unit)) return err("not_allowed");
      return ok({ comments: (read("wbg_local_comments") || []).filter((c) => c.unit === unit && c.ref === ref).sort((a, b) => (a.at < b.at ? -1 : 1)) });
    },
    async mentionables(auth, unit) {
      if (!discussOk(auth, unit)) return err("not_allowed");
      return ok({ people: people().filter((p) => p.status === "active" && p.setupDone && p.name && (p.unit === unit || ["super_admin", "executive"].includes(p.role))).map((p) => ({ id: p.id, name: p.name, role: p.role, title: p.title })) });
    },
    async addComment(auth, c) {
      if (!discussOk(auth, c.unit)) return err("not_allowed");
      const body = (c.body || "").trim(); if (!body || !c.ref || body.length > 4000) return err("bad_request");
      const valid = people().filter((p) => p.status === "active" && p.setupDone && (p.unit === c.unit || ["super_admin", "executive"].includes(p.role)));
      const ment = (c.mentions || []).map((m) => valid.find((p) => p.id === m.id)).filter(Boolean).map((p) => ({ id: p.id, name: p.name }));
      const rec = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), unit: c.unit, ref: c.ref, taskId: c.taskId || "", week: c.week || "", byId: auth.id, by: (auth.name || "").trim(), body, mentions: ment, at: new Date().toISOString() };
      write("wbg_local_comments", [...(read("wbg_local_comments") || []), rec]);
      write("wbg_local_mentions", [...(read("wbg_local_mentions") || []), ...ment.filter((m) => m.id !== auth.id).map((m) => ({ id: rec.id + m.id, userId: m.id, unit: c.unit, ref: c.ref, taskId: rec.taskId, week: rec.week, by: rec.by, snippet: body.slice(0, 140), at: rec.at, read: false }))]);
      addActivity(rec.by, c.unit, rec.week, { action: "comment", summary: `Comment on ${c.ref}: ${body.slice(0, 100)}` });
      return ok({ id: rec.id });
    },
    async myMentions(auth) { return (read("wbg_local_mentions") || []).filter((m) => m.userId === auth.id && !m.read).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 50); },
    async readMentions(auth, unit, ref) { write("wbg_local_mentions", (read("wbg_local_mentions") || []).map((m) => (m.userId === auth.id && m.unit === unit && m.ref === ref ? { ...m, read: true } : m))); return ok(); },
    allocRefs(auth, unit, n) {
      const c = read("wbg_local_refs") || {}, pre = unitPrefixes(getStore("units"));
      const start = (c[unit] || 0) + 1; c[unit] = (c[unit] || 0) + n; write("wbg_local_refs", c);
      return ok({ prefix: pre[unit] || "T", start });
    },
    async adminResetPassword(id) { if (!isAppr(A())) return err("not_allowed"); const l = people(), p = l.find((x) => x.id === id); if (!p) return err("not_found"); delete p.pw; setPeople(l); addActivity(A().name, p.unit || "", "", { action: "user", summary: `Reset the password of ${p.email}` }); return ok(); },
    async verifyCode(email, code) { const e = (email || "").trim().toLowerCase(); let p = people().find((x) => x.email === e); if (!p) { const inv = invites().find((i) => i.email === e); p = { id: e, email: e, name: inv ? inv.name : "", role: inv ? inv.role : "staff", title: inv ? inv.title : "", unit: inv ? inv.unit : null, departments: inv ? inv.departments : [], status: "active", setupDone: false, invited: !!inv }; setPeople([...people(), p]); } write("wbg_local_session", p.id); return { profile: meOut(p) }; },
    async signOut() { try { localStorage.removeItem("wbg_local_session"); } catch (x) {} },
    onSignedOut() {},
    async publicUnits() { return getStore("units").map((u) => ({ id: u.id, name: u.name, type: u.type, departments: u.departments || [] })); },
    async requestAccess(r) { if (!r.email || (r.name || "").trim().length < 3) return { error: "bad_request" }; if ((r.contact || "").trim().length < 5) return { error: "contact_needed" }; const l = accessReqs(); l.push({ id: Date.now().toString(36), email: r.email.trim().toLowerCase(), name: r.name.trim(), unit: r.unit || "", contact: r.contact, note: r.note || "", status: "pending", createdAt: new Date().toISOString() }); write("wbg_local_access", l); return { ok: true }; },
    async completeSignup(name, unit, departments) {
      const list = people(), p = list.find((x) => x.id === curId()); if (!p || p.status !== "active") return { error: "not_allowed" };
      if ((name || "").trim().length < 3) return { error: "name_needed" };
      if (!p.invited) { if (p.setupDone) return { error: "not_allowed" }; const u = getStore("units").find((x) => x.id === unit); if (!u) return { error: "unit_needed" }; p.unit = unit; p.departments = (departments || []).filter((d) => (u.departments || []).includes(d)); }
      p.name = name.trim(); p.setupDone = true; setPeople(list);
      addActivity(p.name, p.unit || "", "", { action: "user", summary: `Signed up: ${p.name} (${p.email})` });
      return { profile: meOut(p) };
    },
    // ----- profile settings and role requests (same rules as the database functions) -----
    async updateProfile(d) {
      const l = people(), p = l.find((x) => x.id === curId()); if (!p || p.status !== "active") return { error: "not_allowed" };
      const name = "name" in d ? String(d.name || "").trim().slice(0, 120) : p.name; if (name.length < 3) return { error: "name_needed" };
      p.name = name; if ("phone" in d) p.phone = String(d.phone || "").trim().slice(0, 40); if ("jobTitle" in d) p.jobTitle = String(d.jobTitle || "").trim().slice(0, 80);
      setPeople(l); return { ok: true, profile: meOut(p) };
    },
    async requestRole(r) {
      const p = prof(); if (!p || p.status !== "active" || !p.setupDone || p.role === "super_admin") return { error: "not_allowed" };
      if (!["leader", "planning", "manager", "staff"].includes(r.role)) return { error: "bad_role" };
      const list = roleReqs(); if (list.some((x) => x.userId === p.id && x.status === "pending")) return { error: "already_pending" };
      const unit = r.unit || null, deps = r.departments || [], u = getStore("units").find((x) => x.id === unit);
      if (!u) return { error: "unit_needed" };
      if (deps.some((d) => !(u.departments || []).includes(d))) return { error: "department_needed" };
      const kind = r.kind === "signup" ? "signup" : "upgrade";
      if (kind === "upgrade") { if (r.role === p.role && unit === p.unit && JSON.stringify(deps) === JSON.stringify(p.departments || [])) return { error: "no_change" }; if ((r.reason || "").trim().length < 5) return { error: "reason_needed" }; }
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      list.push({ id, userId: p.id, email: p.email, name: p.name, kind, fromRole: p.role, fromUnit: p.unit, fromDepartments: p.departments || [], role: r.role, unit, departments: deps, reason: (r.reason || "").trim().slice(0, 500), status: "pending", createdAt: new Date().toISOString() });
      setRoleReqs(list); addActivity(p.name, unit || "", "", { action: "user", summary: `${p.name} asked for the role ${r.role}${kind === "signup" ? " (at sign-up)" : " (upgrade)"}` });
      return { ok: true, id };
    },
    async myRoleRequests() { const p = prof(); if (!p) return { error: "not_allowed" }; return { ok: true, requests: roleReqs().filter((x) => x.userId === p.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 6) }; },
    async withdrawRoleRequest(id) { const p = prof(), l = roleReqs(), q = l.find((x) => x.id === id && p && x.userId === p.id && x.status === "pending"); if (!q) return { error: "not_found" }; Object.assign(q, { status: "withdrawn", decidedAt: new Date().toISOString(), decidedBy: p.name }); setRoleReqs(l); return { ok: true }; },
    async signOutEverywhere() { try { localStorage.removeItem("wbg_local_session"); } catch (x) {} },
    async adminSetApprovalCode(code) {
      const a = A(); if (!isAppr(a)) return err("not_allowed");
      if (!code) { write("wbg_local_appcode", null); return { ok: true, set: false }; }
      if (String(code).trim().length < 6) return err("code_too_short");
      write("wbg_local_appcode", { code: String(code).trim(), at: new Date().toISOString() }); return { ok: true, set: true };
    },
    async adminApprovalCodeStatus() { if (!isAppr(A())) return err("not_allowed"); const c = read("wbg_local_appcode"); return { ok: true, set: !!c, setAt: c ? c.at : null }; },
    async approveRoleWithCode(id, code) {
      const p = prof(); if (!p || p.status !== "active" || !p.setupDone) return { error: "not_allowed" };
      const tries = (read("wbg_local_codetries") || []).filter((t) => t.u === p.id && Date.now() - t.at < 900000);
      if (tries.length >= 5) return { error: "too_many" };
      const c = read("wbg_local_appcode"); if (!c) return { error: "code_off" };
      if (String(code || "").trim() !== c.code) { write("wbg_local_codetries", [...tries, { u: p.id, at: Date.now() }]); return { error: "bad_code" }; }
      const l = roleReqs(), r = l.find((x) => x.id === id && x.userId === p.id && x.status === "pending"); if (!r) return { error: "not_found" };
      const list = people(), q = list.find((x) => x.id === p.id), was = `${q.role} · ${q.unit || "-"}`;
      Object.assign(q, { role: r.role, title: "", unit: r.unit, departments: r.departments || [], invited: true }); setPeople(list);
      Object.assign(r, { status: "approved", decidedBy: "Approval code", decidedAt: new Date().toISOString(), note: "Approved in person with the approval code" }); setRoleReqs(l);
      addActivity("Approval code", r.unit || "", "", { action: "user", summary: `Approved the role request of ${r.name} (${r.email}) with the approval code`, details: ["Was: " + was, `Now: ${r.role} · ${r.unit || "-"}`] });
      return { ok: true, profile: meOut(q) };
    },
    async adminRoleRequests() {
      if (!isAppr(A())) return err("not_allowed");
      const ppl = people();
      return ok({ requests: roleReqs().filter((x) => x.status === "pending").map((x) => { const u = ppl.find((q) => q.id === x.userId) || {}; return { ...x, phone: u.phone || "", jobTitle: u.jobTitle || "" }; }), accessCount: accessReqs().filter((r) => r.status === "pending").length });
    },
    async adminDecideRole(id, approve, d) {
      const a = A(); if (!isAppr(a)) return err("not_allowed");
      const l = roleReqs(), r = l.find((x) => x.id === id && x.status === "pending"); if (!r) return err("not_found");
      const list = people(), p = list.find((x) => x.id === r.userId); if (!p) return err("not_found");
      const was = `${p.role} · ${p.unit || "-"} · ${JSON.stringify(p.departments || [])}`;
      let role = r.role, unit = r.unit, deps = r.departments;
      if (approve) {
        role = (d && d.role) || r.role; unit = d && "unit" in d ? (d.unit || null) : r.unit; deps = (d && d.departments) || r.departments;
        if (role === "super_admin") return err("not_allowed");
        if (!getStore("units").some((u) => u.id === unit)) return err("unit_needed");
        Object.assign(p, { role, title: "", unit, departments: deps, invited: true }); setPeople(list);
      }
      Object.assign(r, { status: approve ? "approved" : "rejected", decidedBy: a.name, decidedAt: new Date().toISOString(), note: (d && d.note) || "" }); setRoleReqs(l);
      addActivity(a.name, (approve ? unit : r.unit) || "", "", { action: "user", summary: `${approve ? "Approved" : "Rejected"} the role request of ${r.name} (${r.email})`, details: ["Was: " + was, approve ? `Now: ${role} · ${unit || "-"} · ${JSON.stringify(deps)}` : `Asked for: ${r.role} · ${r.unit || "-"}`] });
      return ok();
    },
    // ----- people (Group Strategy only) -----
    async adminUsers() { if (!isAppr(A())) return err("not_allowed"); return ok({ users: people().map((p) => ({ ...meOut(p), createdAt: "", lastSeen: "" })), invites: invites(), requests: accessReqs().filter((r) => r.status === "pending"), domains: domains() }); },
    async adminSaveUser(id, d) {
      const a = A(); if (!isAppr(a)) return err("not_allowed");
      const list = people(), p = list.find((x) => x.id === id); if (!p) return err("not_found");
      const role = d.role || p.role, status = d.status || p.status;
      if (id === curId() && (role !== "super_admin" || status !== "active")) return err("cannot_change_self");
      if (role === "executive" && !["CEO", "DCEO"].includes(d.title ?? p.title)) return err("title_needed");
      if (["leader", "planning", "manager", "staff"].includes(role) && !getStore("units").some((u) => u.id === (d.unit ?? p.unit))) return err("unit_needed");
      const before = `${p.role} · ${p.unit || "-"} · ${p.status}`;
      Object.assign(p, { name: d.name ? d.name.trim() : p.name, role, title: d.title ?? p.title, unit: "unit" in d ? (d.unit || null) : p.unit, departments: d.departments ?? p.departments, status });
      setPeople(list); addActivity(a.name, p.unit || "", "", { action: "user", summary: `${status === "disabled" ? "Disabled " : "Updated "}${p.email} (${role})`, details: ["Before: " + before, `After: ${role} · ${p.unit || "-"} · ${status}`] }); return ok();
    },
    async adminInvite(d) {
      const a = A(); if (!isAppr(a)) return err("not_allowed");
      const e = (d.email || "").trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return err("bad_email");
      if (people().some((p) => p.email === e)) return err("already_registered");
      const l = invites().filter((i) => i.email !== e); l.push({ email: e, name: d.name || "", role: d.role, title: d.title || "", unit: d.unit || null, departments: d.departments || [], invitedBy: a.name, createdAt: new Date().toISOString() }); write("wbg_local_invites", l);
      addActivity(a.name, d.unit || "", "", { action: "user", summary: `Invited ${e} as ${d.role}` }); return ok();
    },
    async adminDeleteInvite(email) { if (!isAppr(A())) return err("not_allowed"); write("wbg_local_invites", invites().filter((i) => i.email !== email)); return ok(); },
    async adminDecideAccess(id, approve, d) {
      const a = A(); if (!isAppr(a)) return err("not_allowed");
      const l = accessReqs(), r = l.find((x) => x.id === id && x.status === "pending"); if (!r) return err("not_found");
      if (approve) { const x = await this.adminInvite({ ...d, email: r.email, name: r.name }); if (x.error) return x; }
      r.status = approve ? "approved" : "rejected"; write("wbg_local_access", l); return ok();
    },
    async appSettings() { return { graceTime: "14:00", extendUntil: "", allowRename: false, ...(read("wbg_local_settings") || {}) }; },
    async adminSetSetting(key, value) {
      if (!isAppr(A())) return err("not_allowed");
      const cur = { graceTime: "14:00", extendUntil: "", allowRename: false, ...(read("wbg_local_settings") || {}) };
      if (key === "grace_time") { if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(value))) return err("bad_request"); cur.graceTime = String(value).padStart(5, "0"); }
      else if (key === "extend_until") cur.extendUntil = String(value || "").slice(0, 16);
      else if (key === "allow_rename") cur.allowRename = !!value;
      else return err("bad_request");
      write("wbg_local_settings", cur); return { ok: true, settings: cur };
    },
    async adminSetDomains(list) { if (!isAppr(A())) return err("not_allowed"); write("wbg_local_domains", list.map((x) => String(x).trim().toLowerCase()).filter(Boolean)); return ok(); },
    async adminBackups() { if (!isAppr(A())) return err("not_allowed"); return ok({ days: [] }); },
    async adminGetBackup() { return err("not_found"); },
    async uploadEvidence(file, path) { await idbPut(path, file); return { path }; },
    async evidenceBlob(path) { const b = await idbGet(path); if (!b) fail({ code: "not_found", message: "File not found in this browser" }); return b; },
    async evidenceUrl(path) { const b = await idbGet(path); if (!b) fail({ code: "not_found", message: "File not found in this browser" }); return URL.createObjectURL(b); },
    async readAll(table) { const c = Object.entries(COLLECTIONS).find(([, v]) => v.table === table); return c ? getStore(c[0]) : []; },
  };
  // every change runs as the signed-in person, never as what the page says
  for (const k of Object.keys(api)) {
    if (typeof api[k] !== "function" || /^(session|me|appSettings|setProfile|setRemember|signInPassword|hasPassword|setPassword|localPeople|localSignIn|checkEmail|sendCode|verifyCode|signOut|onSignedOut|publicUnits|requestAccess|completeSignup|updateProfile|requestRole|myRoleRequests|withdrawRoleRequest|signOutEverywhere|approveRoleWithCode|admin\w+|uploadEvidence|evidenceUrl|evidenceBlob|readAll)$/.test(k)) continue;
    const f = api[k]; api[k] = (_ignored, ...rest) => f(A(), ...rest);
  }

  const db = { doc: docRef, collection: (c) => query(c) };
  return { db, api, downloads: getDownloads(), mode: "local" };
}

// Evidence files in local mode live in this browser's IndexedDB.
function idb() {
  return new Promise((res, rej) => { const r = indexedDB.open("wbg-evidence", 1); r.onupgradeneeded = () => r.result.createObjectStore("files"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function idbPut(k, v) { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction("files", "readwrite"); t.objectStore("files").put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
async function idbGet(k) { const d = await idb(); return new Promise((res, rej) => { const r = d.transaction("files").objectStore("files").get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

function getDownloads() {
  return {
    async save({ filename, data }) {
      const type = /\.xlsx$/i.test(filename) ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : /\.pdf$/i.test(filename) ? "application/pdf" : /\.json$/i.test(filename) ? "application/json" : "text/csv;charset=utf-8";
      const blob = new Blob([data], { type });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    },
  };
}
