// Messages: the icon beside the bell. One to one, within your unit plus Group Strategy, the CEO and the DCEO.
// A message is text and can carry a link to a task or to a feedback thread.
export function createMessages(c) {
  const { esc } = c;
  const st = { list: [], people: null, open: false, with: "", compose: false, link: null, sub: null };
  const me = () => c.auth().id || "";
  const other = (m) => (m.fromId === me() ? { id: m.toId, name: m.to } : { id: m.fromId, name: m.from });
  const unread = () => st.list.filter((m) => m.toId === me() && !m.readAt);
  const convs = () => {
    const by = new Map();
    st.list.forEach((m) => { const o = other(m); if (!by.has(o.id)) by.set(o.id, { id: o.id, name: o.name, msgs: [] }); by.get(o.id).msgs.push(m); });
    const out = [...by.values()];
    out.forEach((g) => { g.msgs.sort((a, b) => ((a.createdAt || "") < (b.createdAt || "") ? -1 : 1)); g.last = g.msgs[g.msgs.length - 1]; g.un = g.msgs.filter((m) => m.toId === me() && !m.readAt).length; });
    return out.sort((a, b) => ((a.last.createdAt || "") < (b.last.createdAt || "") ? 1 : -1));
  };
  const when = (t) => { try { const d = new Date(t); return d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } };

  function subscribe() {
    if (!c.db() || st.sub || !me()) return;
    st.sub = c.db().collection("messages").orderBy("createdAt", "desc").limit(500).onSnapshot((s) => { st.list = s.docs.map((d) => ({ id: d.id, ...d.data() })); c.badge(); if (st.open) draw(); }, () => { st.list = []; });
  }
  async function loadPeople() { if (st.people) return; const r = await c.api().messagePeople(c.auth()); st.people = (r && r.people) || []; }

  const linkChip = (l, m) => l && l.linkKind ? `<button type="button" class="btn small ghost dm-link" data-dm="go" data-k="${esc(l.linkKind)}" data-u="${esc(l.linkUnit || "")}" data-r="${esc(l.linkRef || "")}" data-w="${esc(l.linkWeek || "")}">${l.linkKind === "task" ? "Task" : "Feedback"}: ${esc(l.linkLabel || l.linkRef || "")}</button>` : "";

  function draw() {
    let root = document.getElementById("dmMenu");
    if (!st.open) { if (root) root.remove(); return; }
    if (!root) { root = document.createElement("div"); root.id = "dmMenu"; root.className = "bell-menu dm-menu"; document.body.appendChild(root); const r = document.getElementById("msgBtn").getBoundingClientRect(); root.style.top = (r.bottom + 8) + "px"; root.style.right = Math.max(8, innerWidth - r.right) + "px"; }
    const keep = (document.getElementById("dmBody") || {}).value || "";
    let html = "";
    if (st.compose) {
      const ppl = st.people || [];
      html = `<div class="dm-head"><button class="lnk" data-dm="back">‹ Back</button><b>New message</b></div>
        <div class="dm-pad"><label class="small muted" for="dmTo">To</label>
        <select id="dmTo"><option value="">Choose a person</option>${ppl.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.title ? " · " + esc(p.title) : ""}${p.unit ? " · " + esc(c.unitName(p.unit)) : ""}</option>`).join("")}</select>
        ${st.link ? `<div class="small" style="margin-top:8px">Link: ${esc(st.link.linkLabel || st.link.linkRef)} <button class="lnk" data-dm="unlink">remove</button></div>` : ""}
        <textarea id="dmBody" rows="4" maxlength="4000" placeholder="Write your message" style="margin-top:8px">${esc(keep)}</textarea>
        <div class="toolbar" style="margin-top:8px"><button class="btn primary" data-dm="send-new">Send</button></div></div>`;
    } else if (st.with) {
      const g = convs().find((x) => x.id === st.with) || { id: st.with, name: st.withName || "", msgs: [] };
      html = `<div class="dm-head"><button class="lnk" data-dm="back">‹ Back</button><b>${esc(g.name)}</b></div>
        <div class="dm-thread" id="dmThread">${g.msgs.map((m) => `<div class="dm-msg ${m.fromId === me() ? "mine" : "theirs"}"><div class="dm-b">${esc(m.body)}${m.linkKind ? `<div>${linkChip(m, m)}</div>` : ""}</div><div class="small muted">${esc(when(m.createdAt))}</div></div>`).join("") || '<div class="small muted" style="padding:10px">No messages yet.</div>'}</div>
        <div class="dm-pad">${st.link ? `<div class="small">Link: ${esc(st.link.linkLabel || st.link.linkRef)} <button class="lnk" data-dm="unlink">remove</button></div>` : ""}
        <textarea id="dmBody" rows="2" maxlength="4000" placeholder="Write a message">${esc(keep)}</textarea>
        <div class="toolbar" style="margin-top:6px"><button class="btn primary" data-dm="send">Send</button></div></div>`;
    } else {
      const cv = convs();
      html = `<div class="dm-head"><b>Messages</b><button class="btn small primary" data-dm="new">New message</button></div>
        ${cv.map((g) => `<button type="button" class="bm-i dm-row${g.un ? " bm-new" : ""}" data-dm="open" data-id="${esc(g.id)}" data-n="${esc(g.name)}">${g.un ? '<span class="bm-dot" aria-label="New"></span>' : ""}<b>${esc(g.name)}</b>${g.un ? ` <span class="badge">${g.un}</span>` : ""}<div class="small muted">${g.last.fromId === me() ? "You: " : ""}${esc((g.last.body || "").slice(0, 80))}</div><div class="small muted">${esc(when(g.last.createdAt))}</div></button>`).join("") || '<div class="small muted" style="padding:12px">No messages yet. Choose New message to write to someone in your unit, Group Strategy, the CEO or the DCEO.</div>'}`;
    }
    root.innerHTML = html;
    const th = document.getElementById("dmThread"); if (th) th.scrollTop = th.scrollHeight;
  }

  async function act(el) {
    const a = el.dataset.dm;
    if (a === "new") { await loadPeople(); st.compose = true; st.with = ""; draw(); }
    else if (a === "back") { st.compose = false; st.with = ""; draw(); }
    else if (a === "open") { st.with = el.dataset.id; st.withName = el.dataset.n; draw(); if (unread().some((m) => m.fromId === st.with)) { await c.api().readMessages(c.auth(), st.with); } }
    else if (a === "unlink") { st.link = null; draw(); }
    else if (a === "go") { close(); c.openLink({ kind: el.dataset.k, unit: el.dataset.u, ref: el.dataset.r, week: el.dataset.w }); }
    else if (a === "send" || a === "send-new") {
      const to = a === "send" ? st.with : (document.getElementById("dmTo") || {}).value, body = ((document.getElementById("dmBody") || {}).value || "").trim();
      if (!to) { c.toast("Choose who to send it to"); return; }
      if (!body) { c.toast("Write a message first"); return; }
      const row = { to, body, ...(st.link || {}) };
      const res = await c.api().sendMessage(c.auth(), row);
      if (res && res.error) { c.toast(c.errText(res)); return; }
      st.link = null; st.compose = false; st.with = to; const b = document.getElementById("dmBody"); if (b) b.value = ""; draw(); c.toast("Sent");
    }
  }

  function close() { st.open = false; st.compose = false; st.with = ""; draw(); }
  function toggle() { if (st.open) { close(); return; } st.open = true; st.link = null; draw(); }
  // open the composer from a task or a feedback ("Message about this")
  async function compose(link) {
    await loadPeople(); st.open = true; st.compose = true; st.with = ""; st.link = link || null; draw();
  }
  document.addEventListener("click", (e) => {
    const m = document.getElementById("dmMenu"); if (!m) return;
    const el = e.target.closest && e.target.closest("[data-dm]");
    if (el && m.contains(el)) { act(el); return; }
    if (!m.contains(e.target) && !e.target.closest("#msgBtn") && !e.target.closest("[data-dm-compose]")) close();
  });
  return { subscribe, toggle, compose, unreadCount: () => unread().length, close };
}
