// Admin > Access rules: who may do what. Super admin only (hard-wired in the database, so nobody can lock the admins out).
// Rules live in the database (perm_grants). Every change is saved with a note, kept in a history, and can be reverted.
import { setSettings } from "./rules.js";

const BASE_ROLES = [["executive", "CEO / DCEO"], ["leader", "Chief, GM, director"], ["planning", "Planning head"], ["manager", "Department head"], ["staff", "Employee"]];
const FINE_ROLES = [["chief", "Chief"], ["gm", "General manager"], ["director", "Director"], ["lea", "Lead exec. assistant"], ["divhead", "Division head"], ["title:CEO", "Title: CEO"], ["title:DCEO", "Title: DCEO"]];
const LEVEL_LABEL = { none: "No", dept: "Own departments", own: "Own unit", all: "Everyone / all units" };
const LEVEL_SHORT = { none: "No", dept: "Dept", own: "Own unit", all: "All" };
const FIELD_LABEL = { title: "Task title", kind: "Type", dept: "Department", outcome: "Expected outcome", priority: "Priority", owner: "Owner", due: "Due date" };
const TABS = [["roles", "Roles"], ["exceptions", "People, units and titles"], ["flow", "Approvals and task rules"], ["history", "History and safety"]];

export function createAccessPage(c) {
  const { state, esc } = c;
  const X = (state.ax = { data: null, loading: false, tab: "roles", pend: {}, note: "", ex: { kind: "user", subject: "", cap: "", value: "all" }, who: "", whoCaps: null, error: "" });
  const key = (k, s, cap) => `${k}|${s}|${cap}`;
  const grantMap = () => { const m = {}; ((X.data && X.data.grants) || []).forEach((g) => { m[key(g.kind, g.subject, g.cap)] = g.value; }); return m; };
  const defMap = () => { const m = {}; ((X.data && X.data.defaults) || []).forEach((g) => { m[key(g.kind, g.subject, g.cap)] = g.value; }); return m; };
  const levelsOf = (cap) => String((X.data.caps.find((x) => x.cap === cap) || {}).levels || "none,all").split(",");
  const cur = (k, s, cap) => { const kk = key(k, s, cap); return kk in X.pend ? X.pend[kk] : (grantMap()[kk] ?? ""); };
  const pendingCount = () => Object.keys(X.pend).length;
  const peopleList = () => ((state.people && state.people.users) || []).filter((u) => u.setupDone !== false);

  async function load(force) {
    if (X.loading || (X.data && !force)) return;
    X.loading = true; X.error = "";
    try {
      const r = await c.api().adminPermGet();
      if (r && r.error) X.error = r.error === "not_allowed" ? "Only Group Strategy can open this page." : String(r.error);
      else { X.data = r; if (r.settings) setSettings(r.settings); }
    } catch (e) { X.error = "The access rules could not be loaded. They need the live database (this does not work in offline test mode)."; }
    X.loading = false; c.render();
  }

  const selFor = (cap, value, attrs, inherit) => {
    const lv = levelsOf(cap);
    return `<select class="ax-sel" ${attrs} aria-label="${esc(cap)}">${inherit ? `<option value="" ${value === "" ? "selected" : ""}>(same as role)</option>` : ""}${lv.map((l) => `<option value="${l}" ${value === l || (!inherit && value === "" && l === "none") ? "selected" : ""}>${esc(LEVEL_SHORT[l])}</option>`).join("")}</select>`;
  };

  function matrixTable() {
    const d = X.data, def = defMap(), groups = [];
    d.caps.forEach((cp) => { let g = groups.find((x) => x.name === cp.grp); if (!g) groups.push((g = { name: cp.grp, caps: [] })); g.caps.push(cp); });
    const head = `<tr><th>What they can do</th><th class="ax-c" title="Cannot be changed">Group Strategy<br><span class="muted small">locked</span></th>${BASE_ROLES.map(([r, l]) => `<th class="ax-c">${esc(l)}</th>`).join("")}</tr>`;
    const body = groups.map((g) => `<tr class="ax-grp"><td colspan="${BASE_ROLES.length + 2}">${esc(g.name)}</td></tr>` + g.caps.map((cp) => {
      const sa = grantMap()[key("role", "super_admin", cp.cap)] || "none";
      return `<tr><td><b>${esc(cp.label)}</b>${cp.help ? `<div class="small muted">${esc(cp.help)}</div>` : ""}</td><td class="ax-c"><span class="pill ${sa === "none" ? "s-none" : "s-done"}">${esc(LEVEL_SHORT[sa])}</span></td>${BASE_ROLES.map(([r]) => {
        const v = cur("role", r, cp.cap), dv = def[key("role", r, cp.cap)] || "", changedFromDefault = (v || "none") !== (dv || "none"), pend = key("role", r, cp.cap) in X.pend;
        return `<td class="ax-c ${pend ? "ax-pend" : changedFromDefault ? "ax-mod" : ""}">${selFor(cp.cap, v || "none", `data-ax="cell" data-k="role" data-s="${r}" data-cap="${cp.cap}"`, false)}${changedFromDefault && !pend ? `<div class="small muted">default: ${esc(LEVEL_SHORT[dv || "none"])}</div>` : ""}</td>`;
      }).join("")}</tr>`;
    }).join("")).join("");
    return `<div class="ax-scroll"><table class="ax-t">${head}${body}</table></div>`;
  }

  function exceptionList() {
    const d = X.data, rows = d.grants.filter((g) => g.kind !== "role" || !(["super_admin", ...BASE_ROLES.map((x) => x[0])].includes(g.subject)));
    const unitName = (id) => c.unitName(id), person = (id) => { const u = peopleList().find((p) => p.id === id); return u ? (u.name || u.email) : id.slice(0, 8); };
    const who = (g) => g.kind === "user" ? "Person: " + person(g.subject) : g.kind === "unit" ? "Unit: " + unitName(g.subject) : "Job: " + ((FINE_ROLES.find((r) => r[0] === g.subject) || [])[1] || g.subject);
    const capL = (cap) => (d.caps.find((x) => x.cap === cap) || {}).label || cap;
    const list = rows.length ? `<table class="ax-t"><tr><th>Applies to</th><th>Capability</th><th>Level</th><th></th></tr>${rows.map((g) => {
      const dv = defMap()[key(g.kind, g.subject, g.cap)], fromDefault = dv === g.value;
      return `<tr><td>${esc(who(g))}</td><td>${esc(capL(g.cap))}</td><td>${esc(LEVEL_LABEL[g.value] || g.value)}${fromDefault ? ' <span class="small muted">(original rule)</span>' : ""}</td><td><button class="btn small ghost" data-ax="del-rule" data-k="${g.kind}" data-s="${esc(g.subject)}" data-cap="${g.cap}">Remove</button></td></tr>`;
    }).join("")}</table>` : `<div class="small muted">No exceptions yet.</div>`;
    const e = X.ex;
    const subjects = e.kind === "user" ? peopleList().map((u) => [u.id, `${u.name || u.email} (${u.role})`]) : e.kind === "unit" ? c.sortedUnits().map((u) => [u.id, u.name]) : FINE_ROLES;
    const capOpts = d.caps.map((cp) => `<option value="${cp.cap}" ${e.cap === cp.cap ? "selected" : ""}>${esc(cp.grp)}: ${esc(cp.label)}</option>`).join("");
    const lv = e.cap ? levelsOf(e.cap) : ["none", "all"];
    const form = `<div class="ax-form"><b>Add a rule</b><div class="toolbar" style="flex-wrap:wrap;gap:8px;margin-top:6px">
      <select data-ax="ex-kind" aria-label="Applies to"><option value="user" ${e.kind === "user" ? "selected" : ""}>One person</option><option value="unit" ${e.kind === "unit" ? "selected" : ""}>Everyone in a unit</option><option value="role" ${e.kind === "role" ? "selected" : ""}>A specific job or title</option></select>
      <select data-ax="ex-subject" aria-label="Who"><option value="">Choose…</option>${subjects.map(([id, l]) => `<option value="${esc(id)}" ${e.subject === id ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
      <select data-ax="ex-cap" aria-label="Capability"><option value="">Choose what…</option>${capOpts}</select>
      <select data-ax="ex-value" aria-label="Level">${lv.map((l) => `<option value="${l}" ${e.value === l ? "selected" : ""}>${esc(LEVEL_LABEL[l])}</option>`).join("")}</select>
      <button class="btn primary" data-ax="add-rule" type="button">Add rule</button></div>
      <div class="small muted" style="margin-top:6px">A rule for a person wins over everything. A rule for a job or title replaces its base role. A rule for a unit adds to what its members already have (it can only widen access). To give a DCEO, for example, the cash flow, choose "A specific job or title" → Title: DCEO.</div></div>`;
    return list + form;
  }

  function whoPanel() {
    const ppl = peopleList(), sel = X.who;
    const caps = X.whoCaps;
    const rows = caps ? X.data.caps.map((cp) => `<tr><td>${esc(cp.label)}</td><td>${esc(LEVEL_LABEL[caps[cp.cap]] || caps[cp.cap])}</td></tr>`).join("") : "";
    return `<div class="panel"><div class="panel-head"><h2>What can this person do?</h2></div><div class="asks"><div class="toolbar"><select data-ax="who" aria-label="Person"><option value="">Choose a person…</option>${ppl.map((u) => `<option value="${esc(u.id)}" ${sel === u.id ? "selected" : ""}>${esc(u.name || u.email)} (${esc(u.role)})</option>`).join("")}</select></div>${caps ? `<div class="ax-scroll"><table class="ax-t"><tr><th>Capability</th><th>Allowed for</th></tr>${rows}</table></div><div class="small muted">This is the result of the rules below for this person, as they would apply once the access matrix is on.</div>` : ""}</div></div>`;
  }

  function flowPanel() {
    const s = X.data.settings || {}, locked = s.lockedFields || [];
    return `<div class="panel"><div class="panel-head"><div><h2>Task text and locked fields</h2><div class="small muted">After a week has started, people without full plan access cannot change the ticked fields of a saved task without approval. Untick a field to let them change it freely.</div></div></div>
      <div class="asks"><div class="ax-checks">${Object.keys(FIELD_LABEL).map((f) => `<label><input type="checkbox" data-ax="lock" value="${f}" ${locked.includes(f) ? "checked" : ""}> ${esc(FIELD_LABEL[f])}</label>`).join("")}</div>
      <div class="toolbar" style="margin-top:10px"><button class="btn primary" data-ax="save-locks" type="button">Save locked fields</button><span class="small muted">Takes effect for everyone straight away.</span></div></div></div>
      <div class="panel"><div class="panel-head"><div><h2>Approval steps</h2><div class="small muted">Who a change request goes to. Turn a step off and requests skip it. Group Strategy can always decide.</div></div></div>
      <div class="asks"><label class="small" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-ax="route" data-key="route_chief" ${s.routeChief !== false ? "checked" : ""}> <span><b>Chief / GM / director step</b> (staff and managers' requests go to their unit head first)</span></label>
      <label class="small" style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" data-ax="route" data-key="route_planning" ${s.routePlanning !== false ? "checked" : ""}> <span><b>Planning head step</b> (for units that have a planning head)</span></label>
      <div class="small muted" style="margin-top:8px">Who may approve at each step is set in the <b>Roles</b> tab under Approvals. The Saturday cut-off, "keep last week open", approval code and temporary passwords are on the People page.</div></div></div>`;
  }

  function historyPanel() {
    const d = X.data;
    const batches = []; (d.history || []).forEach((h) => { const g = batches.find((b) => b.batch === h.batch); if (g) g.items.push(h); else batches.push({ batch: h.batch, at: h.at, by: h.by_name, action: h.action, note: h.note, items: [h] }); });
    const capL = (cap) => (d.caps.find((x) => x.cap === cap) || {}).label || cap;
    const hist = batches.length ? batches.map((b) => `<div class="ax-h"><div><b>${esc(b.by || "")}</b> <span class="small muted">${esc(String(b.at).slice(0, 16).replace("T", " "))}</span>${b.action !== "set" ? ` <span class="pill s-prog">${esc(b.action)}</span>` : ""}${b.note ? `<div class="small">${esc(b.note)}</div>` : ""}<ul class="small">${b.items.filter((i) => i.cap).slice(0, 8).map((i) => `<li>${esc(i.kind)} ${esc(i.subject)} · ${esc(capL(i.cap))}: ${esc(i.old_value || "(none)")} → ${esc(i.new_value || "(none)")}</li>`).join("")}${b.items.length > 8 ? `<li>+${b.items.length - 8} more</li>` : ""}</ul></div>${b.action === "set" ? `<button class="btn small" data-ax="revert" data-batch="${esc(b.batch)}">Undo this change</button>` : ""}</div>`).join("") : `<div class="small muted">No changes yet.</div>`;
    const snaps = (d.snapshots || []).map((s) => `<tr><td>${esc(String(s.at).slice(0, 16).replace("T", " "))}</td><td>${esc(s.by || "")}</td><td>${esc(s.label || "")}</td><td><button class="btn small ghost" data-ax="restore" data-id="${s.id}">Restore</button></td></tr>`).join("");
    return `<div class="panel"><div class="panel-head"><h2>Change history</h2></div><div class="asks">${hist}</div></div>
      <div class="panel"><div class="panel-head"><div><h2>Safety</h2><div class="small muted">A copy of all rules is saved automatically before every change, reset or switch. Restore any copy below. Group Strategy access itself cannot be removed: this page always works for you.</div></div></div>
      <div class="asks"><div class="toolbar" style="gap:8px;flex-wrap:wrap"><button class="btn danger" data-ax="reset" type="button">Reset every rule to the original defaults</button></div>
      ${snaps ? `<div class="ax-scroll" style="margin-top:10px"><table class="ax-t"><tr><th>Saved</th><th>By</th><th>Why</th><th></th></tr>${snaps}</table></div>` : ""}</div></div>`;
  }

  function render() {
    if (!X.data) {
      if (!X.loading && !X.error) setTimeout(load, 0);
      return `<div class="panel"><div class="empty"><b>${X.error ? "Cannot open Access rules" : "Loading…"}</b>${esc(X.error || "")}</div></div>`;
    }
    const d = X.data, on = d.mode === "matrix";
    const mode = `<div class="panel ax-mode ${on ? "on" : ""}"><div class="asks"><div class="toolbar" style="justify-content:space-between;flex-wrap:wrap;gap:10px"><div><b>${on ? "Access rules are ON" : "Access rules are OFF"}</b><div class="small muted">${on ? "The app follows the rules below. Changes apply to everyone at once." : "The app still uses the fixed built-in rules. Edit the rules below; nothing changes for anyone until you turn them on. The rules start as exact copies of the built-in ones."}</div></div>
      <button class="btn ${on ? "" : "primary"}" data-ax="mode" data-mode="${on ? "legacy" : "matrix"}" type="button">${on ? "Go back to the fixed rules" : "Turn on the access rules"}</button></div></div></div>`;
    const tabs = `<div class="toolbar ax-tabs" role="tablist">${TABS.map(([k, l]) => `<button class="btn ${X.tab === k ? "primary" : "ghost"}" role="tab" aria-selected="${X.tab === k}" data-ax="tab" data-t="${k}" type="button">${esc(l)}</button>`).join("")}</div>`;
    let body = "";
    if (X.tab === "roles") body = `<div class="panel"><div class="panel-head"><div><h2>What each role can do</h2><div class="small muted">Pick a level for each role. "Own unit" means their own unit only; "Own departments" means only the departments on their profile. Cells that differ from the original are marked. Nothing is saved until you press <b>Save changes</b>.</div></div></div>${matrixTable()}</div>`;
    else if (X.tab === "exceptions") body = whoPanel() + `<div class="panel"><div class="panel-head"><div><h2>Exceptions</h2><div class="small muted">Give one person, one unit or one job title different access from their role.</div></div></div><div class="asks">${exceptionList()}</div></div>`;
    else if (X.tab === "flow") body = flowPanel();
    else body = historyPanel();
    const bar = pendingCount() ? `<div class="ax-bar"><b>${pendingCount()} unsaved change${pendingCount() === 1 ? "" : "s"}</b><input type="text" id="axNote" maxlength="200" placeholder="Why? (optional note for the history)" value="${esc(X.note)}"><button class="btn primary" data-ax="save" type="button">Save changes</button><button class="btn ghost" data-ax="discard" type="button">Discard</button></div>` : "";
    return `<div class="ax">${mode}${tabs}${body}${bar}</div>${style()}`;
  }

  const style = () => `<style>.ax-t{width:100%;border-collapse:collapse}.ax-t th,.ax-t td{padding:8px 10px;border-bottom:1px solid var(--line,#e5e7eb);text-align:left;vertical-align:top}.ax-c{text-align:center!important}.ax-grp td{background:var(--soft,#f3f4f6);font-weight:700}.ax-scroll{overflow:auto;max-width:100%}.ax-sel{max-width:150px}.ax-mod{background:rgba(245,158,11,.10)}.ax-pend{background:rgba(59,130,246,.16)}.ax-mode.on{border-left:4px solid #16a34a}.ax-mode:not(.on){border-left:4px solid #f59e0b}.ax-tabs{margin:12px 0;flex-wrap:wrap;gap:6px}.ax-bar{position:sticky;bottom:0;display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:12px;background:var(--card,#fff);border-top:2px solid #3b82f6;box-shadow:0 -4px 12px rgba(0,0,0,.08);z-index:5}.ax-bar input{flex:1;min-width:180px}.ax-checks{display:flex;gap:16px;flex-wrap:wrap}.ax-h{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--line,#e5e7eb)}.ax-form{margin-top:14px;padding-top:12px;border-top:1px dashed var(--line,#e5e7eb)}</style>`;

  async function act(fn, ok) {
    try { const r = await fn(); if (r && r.error) { c.toast(r.detail || c.errText(r)); return null; } if (ok) c.toast(ok); return r || {}; } catch (e) { c.toast("That did not work. Check your connection and try again."); return null; }
  }

  document.addEventListener("change", async (e) => {
    const el = e.target.closest("[data-ax]"); if (!el || !X.data) return;
    const a = el.dataset.ax;
    if (a === "cell") { const kk = key(el.dataset.k, el.dataset.s, el.dataset.cap), orig = grantMap()[kk] ?? "", v = el.value === "none" ? "" : el.value; if (v === orig) delete X.pend[kk]; else X.pend[kk] = v; c.render(); }
    else if (a === "ex-kind") { X.ex.kind = el.value; X.ex.subject = ""; c.render(); }
    else if (a === "ex-subject") { X.ex.subject = el.value; }
    else if (a === "ex-cap") { X.ex.cap = el.value; X.ex.value = levelsOf(el.value).includes(X.ex.value) ? X.ex.value : levelsOf(el.value).slice(-1)[0]; c.render(); }
    else if (a === "ex-value") { X.ex.value = el.value; }
    else if (a === "who") { X.who = el.value; X.whoCaps = null; if (el.value) { const r = await act(() => c.api().adminPermPreview(el.value)); if (r) X.whoCaps = r.caps; } c.render(); }
    else if (a === "route") { const r = await act(() => c.api().adminSetSetting(el.dataset.key, el.checked), "Saved"); if (r) { X.data.settings = r.settings; setSettings(r.settings); } else el.checked = !el.checked; c.render(); }
  });

  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-ax]"); if (!b || !X.data) return;
    const a = b.dataset.ax, api = c.api();
    if (a === "tab") { X.tab = b.dataset.t; c.render(); }
    else if (a === "discard") { X.pend = {}; X.note = ""; c.render(); }
    else if (a === "save") {
      const note = ((document.getElementById("axNote") || {}).value || "").trim();
      const changes = Object.entries(X.pend).map(([kk, v]) => { const [k, s, cap] = kk.split("|"); return { kind: k, subject: s, cap, value: v || null }; });
      const r = await act(() => api.adminPermSet(changes, note || "Edited in the matrix"), "Saved");
      if (r) { X.pend = {}; X.note = ""; X.data = null; await load(true); }
    }
    else if (a === "add-rule") {
      const e2 = X.ex; if (!e2.subject || !e2.cap) { c.toast("Choose who and what first"); return; }
      const r = await act(() => api.adminPermSet([{ kind: e2.kind, subject: e2.subject, cap: e2.cap, value: e2.value }], "Added a rule"), "Rule added");
      if (r) { X.ex.subject = ""; X.data = null; await load(true); }
    }
    else if (a === "del-rule") {
      const r = await act(() => api.adminPermSet([{ kind: b.dataset.k, subject: b.dataset.s, cap: b.dataset.cap, value: null }], "Removed a rule"), "Rule removed");
      if (r) { X.data = null; await load(true); }
    }
    else if (a === "mode") {
      const to = b.dataset.mode;
      if (to === "matrix" && !confirm("Turn the access rules ON? The app will follow the rules on this page for everyone. A copy of the current state is saved first, and you can go back at any time.")) return;
      const r = await act(() => api.adminPermMode(to), to === "matrix" ? "Access rules are on" : "Back to the fixed rules");
      if (r) { X.data = null; await load(true); c.reloadMe && c.reloadMe(); }
    }
    else if (a === "save-locks") {
      const f = [...document.querySelectorAll('[data-ax="lock"]:checked')].map((x) => x.value);
      const r = await act(() => api.adminSetSetting("locked_fields", f), "Locked fields saved");
      if (r) { X.data.settings = r.settings; setSettings(r.settings); c.render(); }
    }
    else if (a === "revert") {
      if (!confirm("Undo this change and put the earlier rules back?")) return;
      const r = await act(() => api.adminPermRevert(b.dataset.batch), "Change undone");
      if (r) { X.data = null; await load(true); }
    }
    else if (a === "restore") {
      if (!confirm("Restore the rules saved at that time? Your current rules are saved first.")) return;
      const r = await act(() => api.adminPermRestore(Number(b.dataset.id)), "Rules restored");
      if (r) { X.data = null; await load(true); }
    }
    else if (a === "reset") {
      if (!confirm("Reset EVERY rule to the original defaults? Your current rules are saved first so you can restore them.")) return;
      const r = await act(() => api.adminPermReset(), "Reset to defaults");
      if (r) { X.pend = {}; X.data = null; await load(true); }
    }
  });

  return { render, load: () => load(true), reset: () => { X.data = null; } };
}
