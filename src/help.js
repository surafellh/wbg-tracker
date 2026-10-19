// The in-app help assistant: a floating Help button that opens a panel with step-by-step guides.
// No AI and no network: it searches the written guides in guides.js. It shows the guides for the page you are on first,
// everything else below in expandable groups, and a search box that understands everyday wording.
import { GROUPS, GUIDES, TAB_NAMES, GUIDES_VERSION } from "./guides.js";
import { getSettings, graceLabel } from "./rules.js";

const STOP = new Set("a an the i me my we our you your is are am was be do does did how what why when where which who can could should would will to of in on at for from with and or but if it its this that these those there then so as by not no yes any some please help need want like get got have has had about into over under up out".split(" "));
// Everyday words people type, mapped to the words the guides use.
const SYN = {
  cant: "cannot", cannot: "cannot", unable: "cannot", wont: "cannot", dont: "", couldnt: "cannot",
  edit: "change", modify: "change", alter: "change", fix: "change", correct: "change", update: "update", rename: "rename",
  login: "sign in", logon: "sign in", signin: "sign in", register: "sign up", registration: "sign up",
  pass: "password", pwd: "password", otp: "code", pin: "code",
  upload: "import", xls: "excel", xlsx: "excel", spreadsheet: "excel", sheet: "excel", csv: "excel",
  delete: "remove", erase: "remove", trash: "remove", bin: "remove",
  late: "deadline", overdue: "deadline", expired: "deadline", cutoff: "deadline", "cut-off": "deadline", extend: "deadline", extension: "deadline",
  approver: "approval", approve: "approval", approved: "approval", reject: "approval", rejected: "approval", authorise: "approval", authorize: "approval",
  wrong: "problem", error: "problem", bug: "problem", broken: "problem", issue: "problem", stuck: "problem", fail: "problem", failed: "problem",
  missing: "missing", disappeared: "missing", vanished: "missing", lost: "missing", gone: "missing",
  percent: "percent", pct: "percent", progress: "progress",
  boss: "manager", supervisor: "manager", head: "manager",
  report: "report", reports: "report", chart: "dashboard", graph: "dashboard", ppt: "powerpoint", pptx: "powerpoint", slides: "powerpoint", deck: "powerpoint",
  notif: "bell", notification: "bell", notifications: "bell", alert: "bell", message: "bell",
  pdf: "pdf", print: "pdf", export: "download", save: "save", saved: "save", saving: "save",
  user: "people", users: "people", staff: "employee", member: "employee", colleague: "people",
  week: "week", weekly: "week", month: "month", monthly: "month",
  sub: "deliverable", subtask: "deliverable", parent: "deliverable", child: "deliverable",
  copy: "bring forward", carry: "bring forward", repeat: "bring forward", unfinished: "bring forward",
  proof: "evidence", attachment: "evidence", attach: "evidence", file: "evidence", photo: "evidence",
};
const norm = (s) => String(s || "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9\- ]+/g, " ");
const stem = (w) => w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w.length > 3 ? w.replace(/s$/, "") : w;
function tokens(s, expand) {
  const out = [];
  norm(s).split(/\s+/).forEach((w) => {
    if (!w || STOP.has(w)) return;
    const m = expand && Object.prototype.hasOwnProperty.call(SYN, w) ? SYN[w] : w;
    String(m).split(/\s+/).forEach((x) => { if (x && !STOP.has(x)) out.push(stem(x)); });
    if (expand && m !== w) out.push(stem(w));
  });
  return out;
}

// One searchable record per guide (built once).
const INDEX = GUIDES.map((g) => ({
  g,
  title: new Set(tokens(g.title)), kw: new Set(tokens(g.kw)),
  fixQ: new Set(tokens((g.fix || []).map((f) => f[0]).join(" "))),
  body: new Set(tokens([g.intro, ...(g.steps || []), ...(g.why || []), ...(g.fix || []).map((f) => f[1])].filter((x) => typeof x === "string").join(" "))),
  titleText: norm(g.title),
}));

export function createHelp({ esc, getTab, getMe, goTab, getFacts, getReport, toast }) {
  const st = { open: false, q: "", topic: null, groups: new Set(), tab: "", pageOpen: true, moreOpen: false };
  let fab, panel, started = false;

  const roleOf = () => { const m = getMe() || {}; return m.role || ""; };
  const PRIMARY = { plan: "plan", update: "upd", mplan: "mp", approvals: "appr", dashboard: "rep", tasks: "rep", monthly: "rep", ceo: "rep", support: "del", fb: "del", people: "adm", units: "adm", activity: "adm" };
  const isMain = (g, tab) => onPage(g, tab) && !(g.pages || []).includes("*") && (g.g === PRIMARY[tab] || (g.pin || []).includes(tab));
  const forMe = (g) => !g.roles || g.roles.includes(roleOf());
  const onPage = (g, tab) => (g.pages || []).includes(tab);
  const pageName = (tab) => TAB_NAMES[tab] || "the dashboard";

  function words(s) {
    const cfg = getSettings();
    const fixed = cfg.allowRename ? "outcome, type, department and priority (the title can still be edited, because Group Strategy has switched renaming on)" : "title, expected outcome, type, department and priority";
    const rename = cfg.allowRename ? "Group Strategy has switched renaming ON right now, so task titles can be edited after the week starts. It may be switched off again later." : "Renaming saved tasks is currently OFF (the default).";
    let h = esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    h = h.split("{grace}").join(esc(graceLabel())).split("{fixed}").join(esc(fixed)).split("{rename}").join(esc(rename));
    const F = (getFacts && getFacts().text) || {};
    Object.keys(F).forEach((k) => { h = h.split("{" + k + "}").join(esc(F[k])); });
    return h;
  }
  // A step can be a text or { fact: "name" }, which expands to a generated list taken from the app's code.
  const expand = (arr) => (arr || []).flatMap((x) => typeof x === "string" ? [x] : (((getFacts && getFacts().lists) || {})[x.fact] || []));

  function score(rec, qt, qraw, tab) {
    let sc = 0, hit = 0;
    qt.forEach((t) => {
      let s = 0;
      if (rec.title.has(t)) s += 6; if (rec.kw.has(t)) s += 5; if (rec.fixQ.has(t)) s += 4; if (rec.body.has(t)) s += 1.5;
      if (s) hit++; sc += s;
    });
    if (!hit) return 0;
    if (qt.length > 1) sc += hit / qt.length * 4;            // reward guides that match most of the words
    if (qraw.length > 3 && rec.titleText.includes(qraw)) sc += 8;
    if (onPage(rec.g, tab)) sc += 2;
    if (!forMe(rec.g)) sc -= 3;
    return sc;
  }
  function search(q, tab) {
    const qraw = norm(q).trim(), qt = [...new Set(tokens(q, true))];
    if (!qt.length) return [];
    return INDEX.map((r) => ({ g: r.g, sc: score(r, qt, qraw, tab) })).filter((x) => x.sc > 1).sort((a, b) => b.sc - a.sc).slice(0, 8).map((x) => x.g);
  }

  function topicHtml(g, open) {
    const tag = !forMe(g) ? `<span class="hp-tag">For ${esc(g.roles.map((r) => r === "super_admin" ? "Group Strategy" : r === "staff" ? "employees" : r).join(" / "))}</span>` : "";
    let body = "";
    if (open) {
      body = `<div class="hp-body">${g.intro ? `<p class="hp-intro">${words(g.intro)}</p>` : ""}
        ${(g.steps || []).length ? `<div class="hp-h">Step by step</div><ol class="hp-steps">${expand(g.steps).map((x) => `<li>${words(x)}</li>`).join("")}</ol>` : ""}
        ${(g.why || []).length ? `<div class="hp-h">Good to know (how it works)</div><ul class="hp-why">${expand(g.why).map((x) => `<li>${words(x)}</li>`).join("")}</ul>` : ""}
        ${(g.fix || []).length ? `<div class="hp-h">If something goes wrong</div>${g.fix.map((f) => `<details class="hp-fix"><summary>${words(f[0])}</summary><div>${words(f[1])}</div></details>`).join("")}` : ""}
        ${(g.go || []).filter((x) => x[1]).length ? `<div class="hp-go">${g.go.filter((x) => x[1]).map((x) => `<button type="button" class="btn small" data-hgo="${esc(x[1])}">Open ${esc(x[0])} →</button>`).join("")}</div>` : ""}
        <div class="hp-fb small muted">Still stuck? Tell Group Strategy which page you were on and what you saw.</div></div>`;
    }
    return `<div class="hp-t${open ? " open" : ""}"><button type="button" class="hp-th" data-htopic="${esc(g.id)}" aria-expanded="${open}"><span>${esc(g.title.replace(/\{grace\}/g, graceLabel()))}${tag}</span><i aria-hidden="true">${open ? "−" : "+"}</i></button>${body}</div>`;
  }

  const byGroup = (list) => GROUPS.map((gr) => ({ gr, items: list.filter((g) => g.g === gr.id) })).filter((x) => x.items.length);

  function bodyHtml() {
    const tab = st.tab, me = getMe() || {};
    const first = String(me.name || "").split(/\s+/)[0] || "there";
    const hello = `<div class="hp-hi"><b>Hi ${esc(first)}.</b> I can walk you through the app, step by step. ${tab ? `You are on <b>${esc(pageName(tab))}</b>.` : ""}</div>`;
    const box = `<div class="hp-search"><input id="hpQ" type="search" autocomplete="off" placeholder="Ask a question or search…" value="${esc(st.q)}" aria-label="Search the help"></div>`;
    if (st.q.trim().length >= 2) {
      const res = search(st.q, tab);
      if (!res.length) return hello + box + `<div class="hp-empty"><b>I could not find a guide for that.</b><div class="small muted">Try fewer or different words (for example: save, deadline, approval, Excel, password). Or browse the groups below.</div></div>` + moreHtml(GUIDES, "Browse all help", true);
      const open = st.topic || res[0].id;
      return hello + box + `<div class="hp-sec">Best matches (${res.length})</div>` + res.map((g) => topicHtml(g, g.id === open)).join("");
    }
    const rank = (a, b) => (forMe(b) ? 1 : 0) - (forMe(a) ? 1 : 0);
    const page = GUIDES.filter((g) => isMain(g, tab)).sort(rank);
    const related = GUIDES.filter((g) => onPage(g, tab) && !page.includes(g) && !(g.pages || []).includes("*")).sort(rank);
    const general = GUIDES.filter((g) => !page.includes(g) && !related.includes(g));
    const chips = page.filter(forMe).slice(0, 4).map((g) => `<button type="button" class="hp-chip" data-htopic="${esc(g.id)}" data-hfocus="1">${esc(g.title.replace(/\{grace\}/g, graceLabel()))}</button>`).join("");
    const pageSec = page.length
      ? `<details class="hp-grp" data-hgrp="__page" ${st.pageOpen ? "open" : ""}><summary><span class="hp-ic">📍</span><span><b>On this page: ${esc(pageName(tab))}</b><small>${page.length} guide${page.length === 1 ? "" : "s"} for what you are doing now</small></span></summary><div class="hp-list">${page.map((g) => topicHtml(g, st.topic === g.id)).join("")}</div></details>`
      : "";
    const relSec = related.length
      ? `<details class="hp-grp" data-hgrp="__rel" ${st.relOpen || related.some((g) => g.id === st.topic) ? "open" : ""}><summary><span class="hp-ic">🔗</span><span><b>Related to this page</b><small>${related.length} more guide${related.length === 1 ? "" : "s"} that touch this page</small></span></summary><div class="hp-list">${related.map((g) => topicHtml(g, st.topic === g.id)).join("")}</div></details>`
      : "";
    return hello + box + (chips && !st.topic ? `<div class="hp-chips">${chips}</div>` : "") + pageSec + relSec + moreHtml(general, page.length ? "More help" : "Help topics", false);
  }

  function moreHtml(list, title, openAll) {
    const groups = byGroup(list);
    return `<div class="hp-sec">${esc(title)}</div>` + groups.map(({ gr, items }) => {
      const open = openAll || st.groups.has(gr.id) || items.some((g) => g.id === st.topic);
      const sorted = [...items].sort((a, b) => (forMe(b) ? 1 : 0) - (forMe(a) ? 1 : 0));
      return `<details class="hp-grp" data-hgrp="${esc(gr.id)}" ${open ? "open" : ""}><summary><span class="hp-ic">${gr.icon}</span><span><b>${esc(gr.title)}</b><small>${esc(gr.blurb)} · ${items.length}</small></span></summary><div class="hp-list">${sorted.map((g) => topicHtml(g, st.topic === g.id)).join("")}</div></details>`;
    }).join("");
  }

  function draw(keepScroll) {
    if (!panel) return;
    const sc = panel.querySelector(".hp-scroll"), top = sc ? sc.scrollTop : 0;
    const q = panel.querySelector("#hpQ"), had = q && document.activeElement === q, pos = q ? q.selectionStart : 0;
    panel.innerHTML = `<div class="hp-head"><div><b>Help assistant</b><span class="small muted">Step-by-step guides · updated ${esc(GUIDES_VERSION)}</span></div><button type="button" class="hp-x" id="hpClose" aria-label="Close help">×</button></div><div class="hp-scroll">${bodyHtml()}</div>${getReport ? `<div class="hp-foot"><span class="small muted">Still stuck, or the guide does not match what you see?</span><button type="button" class="btn small" id="hpReport">Copy problem details</button></div>` : ""}`;
    const sc2 = panel.querySelector(".hp-scroll"); if (sc2 && keepScroll) sc2.scrollTop = top;
    if (had) { const n = panel.querySelector("#hpQ"); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } } }
  }

  function mount() {
    if (fab) return;
    fab = document.createElement("button"); fab.type = "button"; fab.id = "helpFab"; fab.className = "help-fab";
    fab.setAttribute("aria-label", "Open help"); fab.setAttribute("aria-haspopup", "dialog");
    fab.innerHTML = `<span aria-hidden="true">?</span><b>Help</b>`;
    panel = document.createElement("aside"); panel.id = "helpPanel"; panel.className = "help-panel"; panel.hidden = true;
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Help assistant");
    document.body.append(fab, panel);
    fab.onclick = () => toggle();
    panel.addEventListener("click", (e) => {
      if (e.target.closest("#hpClose")) { toggle(false); return; }
      if (e.target.closest("#hpReport")) { copyReport(); return; }
      const go = e.target.closest("[data-hgo]");
      if (go) { const t = go.dataset.hgo; if (window.matchMedia("(max-width: 700px)").matches) toggle(false); goTab(t); return; }
      const th = e.target.closest("[data-htopic]");
      if (th) {
        const id = th.dataset.htopic;
        st.topic = st.topic === id && !th.dataset.hfocus ? null : id;
        if (th.dataset.hfocus) { st.pageOpen = true; }
        draw(true);
        const el = panel.querySelector(`[data-htopic="${CSS.escape(id)}"]`), open = panel.querySelector(`.hp-t.open [data-htopic="${CSS.escape(id)}"]`);
        if (open && open.scrollIntoView) open.scrollIntoView({ block: "nearest", behavior: "smooth" });
        return;
      }
    });
    panel.addEventListener("toggle", (e) => {
      const d = e.target; if (!d.classList || !d.classList.contains("hp-grp")) return;
      const id = d.dataset.hgrp; if (id === "__page") st.pageOpen = d.open; else if (id === "__rel") st.relOpen = d.open; else if (d.open) st.groups.add(id); else st.groups.delete(id);
    }, true);
    panel.addEventListener("input", (e) => {
      if (e.target.id !== "hpQ") return;
      st.q = e.target.value; st.topic = null; draw(false);
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && st.open) toggle(false); });
  }

  async function copyReport() {
    let text = ""; try { text = getReport(); } catch (e) { text = "Could not build the details: " + (e && e.message); }
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
      try { const t = document.createElement("textarea"); t.value = text; t.style.position = "fixed"; t.style.opacity = "0"; document.body.append(t); t.select(); ok = document.execCommand("copy"); t.remove(); } catch (x) { ok = false; }
    }
    if (ok) toast && toast("Problem details copied. Paste them into your message to Group Strategy.");
    else { const sc = panel.querySelector(".hp-scroll"); if (sc) sc.insertAdjacentHTML("beforeend", `<div class="hp-sec">Select and copy this</div><textarea class="hp-rep" readonly rows="10">${esc(text)}</textarea>`); }
  }
  function toggle(on) {
    mount();
    st.open = on === undefined ? !st.open : !!on;
    st.tab = getTab();
    panel.hidden = !st.open; fab.classList.toggle("on", st.open); fab.setAttribute("aria-expanded", String(st.open));
    document.body.classList.toggle("help-open", st.open);
    if (st.open) { draw(false); setTimeout(() => { const q = panel.querySelector("#hpQ"); if (q && window.matchMedia("(min-width: 701px)").matches) q.focus(); }, 30); }
  }
  // Called by the app after every screen change: follows the page the person is on while the panel is open.
  function refresh() {
    if (!started) return;
    const tab = getTab();
    if (st.open && tab !== st.tab) { st.tab = tab; st.topic = null; draw(false); }
    else if (st.open) st.tab = tab;
  }
  function redraw() { if (st.open) draw(true); }
  function start() { started = true; mount(); }
  return { start, mount, toggle, refresh, redraw, search: (q, tab) => search(q, tab || ""), isOpen: () => st.open };
}
