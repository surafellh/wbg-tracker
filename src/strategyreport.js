// Strategy review model + downloads (2-page PDF, 5-slide deck). Shared by the app and the October build script.
import { PILLARS, anyGoal, pillarOf } from "./strategy.js";

const pctOf = t => t.status === "Done" ? 100 : (typeof t.pct === "number" ? t.pct : Number(t.pct) || 0);
const isDone = t => t.status === "Done" || pctOf(t) >= 100;
export const ragOf = (n, avg, blocked) => !n ? "none" : blocked || avg < 70 ? "red" : avg < 90 ? "amber" : "green";
export const RAG_TXT = { green: "Green", amber: "Amber", red: "Red", none: "No activity" };

// entries: every weekly entry of the month [{week, ref, title, dept, status, pct, carried, goal, spts, stream}]
// One activity = one stream (or ref, or title): a task carried over several weeks, or a rolling task, is counted once.
export function buildReview(entries, opts = {}) {
  const sorted = [...entries].sort((a, b) => String(a.week).localeCompare(String(b.week)));
  const byKey = new Map();
  sorted.forEach(t => { const k = t.stream || t.ref || String(t.title).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); if (!byKey.has(k)) byKey.set(k, { key: k, name: t.stream || t.title, members: new Map() }); byKey.get(k).members.set(t.ref || t.title, t); });
  const items = [...byKey.values()].map(g => {
    const ms = [...g.members.values()], pct = Math.round(ms.reduce((a, t) => a + pctOf(t), 0) / ms.length);
    const lead = ms.find(t => t.goal) || ms[0], goal = lead.goal || "", w = Math.max(0, ...ms.map(t => Number(t.spts) || 0)) || 1;
    return { key: g.key, name: g.name, n: ms.length, pct, done: ms.every(isDone), blocked: ms.some(t => t.status === "Blocked" || t.status === "Delayed" && pctOf(t) < 50), carried: ms.filter(t => t.carried).length, goal, pillar: pillarOf(goal), w, depts: [...new Set(ms.map(t => t.dept).filter(Boolean))], list: ms.map(t => ({ title: t.title, pct: pctOf(t), status: t.status, done: isDone(t) })), titles: ms.map(t => t.title), open: ms.filter(t => !isDone(t)).map(t => ({ title: t.title, pct: pctOf(t), stream: g.name })), summary: (opts.summaries || {})[g.key] || "" };
  });
  const linked = items.filter(i => i.pillar), totalW = linked.reduce((a, i) => a + i.w, 0);
  const pillars = PILLARS.map(p => {
    const its = linked.filter(i => i.pillar === p.id), w = its.reduce((a, i) => a + i.w, 0), avg = w ? Math.round(its.reduce((a, i) => a + i.w * i.pct, 0) / w) : 0, blocked = its.filter(i => i.blocked && !i.done).length;
    return { ...p, items: its, w, share: totalW ? Math.round(w / totalW * 100) : 0, avg, done: its.filter(i => i.done).length, rag: ragOf(its.length, avg, blocked), blocked, tasks: its.reduce((a, i) => a + i.n, 0) };
  });
  const all = [...byKey.values()].reduce((a, g) => a + g.members.size, 0);
  const depts = new Map(); sorted.forEach(t => { /* latest per ref */ });
  const latest = new Map(); sorted.forEach(t => latest.set(t.ref || t.title, t));
  const dm = new Map(); latest.forEach(t => { const d = t.dept || "CSO"; if (!dm.has(d)) dm.set(d, []); dm.get(d).push(t); });
  const teams = [...dm.entries()].map(([d, ts]) => ({ dept: d, n: ts.length, done: ts.filter(isDone).length, avg: Math.round(ts.reduce((a, t) => a + pctOf(t), 0) / ts.length) })).sort((a, b) => b.n - a.n);
  const tasks = latest.size, doneN = [...latest.values()].filter(isDone).length;
  const carried = [...latest.values()].filter(t => t.carried).length;
  const objs = new Map(); linked.forEach(i => { if (!objs.has(i.goal)) objs.set(i.goal, []); objs.get(i.goal).push(i); });
  const objectives = [...objs.entries()].map(([id, its]) => { const w = its.reduce((a, i) => a + i.w, 0); return { id, name: (anyGoal(id) || {}).name || id, pillar: pillarOf(id), w, avg: Math.round(its.reduce((a, i) => a + i.w * i.pct, 0) / w), n: its.length }; }).sort((a, b) => a.id.localeCompare(b.id));
  const perf = totalW ? Math.round(linked.reduce((a, i) => a + i.w * i.pct, 0) / totalW) : 0;
  return { items, pillars, objectives, teams, tasks, doneN, carried, open: tasks - doneN, activities: items.length, unlinked: items.length - linked.length, perf, touched: pillars.filter(p => p.items.length).length, totalW };
}

const NAVY = "0B3C49", GOLD = "D9A93A", RAGC = { green: "2E7D32", amber: "C77D0A", red: "B3261E", none: "7A8A90" };
const short = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; };
export function risksAndNext(r) {
  const open = r.items.filter(i => i.pillar).flatMap(i => i.open.map(o => ({ name: o.title, pct: o.pct, w: i.w, stream: i.name }))).sort((a, b) => b.w - a.w || a.pct - b.pct);
  return { off: open.filter(o => o.pct < 70), open, gaps: r.pillars.filter(p => !p.items.length) };
}

export async function buildPdf(r, o) {
  const { jsPDF } = await import("jspdf"); const atm = await import("jspdf-autotable"); const at = typeof atm.default === "function" ? atm.default : (atm.default && atm.default.default) || atm.autoTable;
  const d = new jsPDF({ unit: "pt", format: "a4" }), W = 595, M = 36;
  const hex = h => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4), 16)];
  const head = (t, sub) => { d.setFillColor(...hex(NAVY)); d.rect(0, 0, W, 64, "F"); d.setFillColor(...hex(GOLD)); d.rect(0, 64, W, 3, "F"); d.setTextColor(255); d.setFont("helvetica", "bold"); d.setFontSize(17); d.text(t, M, 30); d.setFont("helvetica", "normal"); d.setFontSize(9.5); d.text(sub, M, 48); };
  const h2 = (t, y) => { d.setTextColor(...hex(NAVY)); d.setFont("helvetica", "bold"); d.setFontSize(11.5); d.text(t, M, y); d.setDrawColor(...hex(GOLD)); d.setLineWidth(1.2); d.line(M, y + 4, M + 40, y + 4); };
  const foot = n => { d.setFontSize(8); d.setTextColor(120); d.setFont("helvetica", "normal"); d.text(`${o.unit} · Strategy review · ${o.month}`, M, 818); d.text(`Page ${n} of 2`, W - M, 818, { align: "right" }); };
  const colorCell = d2 => { if (d2.section === "body" && d2.column.dataKey === "rag") { const k = d2.cell.raw; d2.cell.styles.textColor = hex(RAGC[k.k]); d2.cell.styles.fontStyle = "bold"; d2.cell.text = [k.t]; } };
  // page 1
  head(`${o.unit}: strategy review`, `${o.month} · contribution to the seven strategic pillars`);
  let y = 92; const boxes = [[r.tasks, "tasks tracked"], [Math.round(r.doneN / r.tasks * 100) + "%", "completed"], [r.open, "still open"], [r.carried, "carried forward"], [r.touched + " of 7", "pillars reached"], [r.perf + "%", "weighted progress"]];
  boxes.forEach(([v, l], i) => { const x = M + i * 90; d.setFillColor(236, 242, 244); d.roundedRect(x, y, 84, 52, 4, 4, "F"); d.setTextColor(...hex(NAVY)); d.setFont("helvetica", "bold"); d.setFontSize(17); d.text(String(v), x + 8, y + 26); d.setFont("helvetica", "normal"); d.setFontSize(8); d.setTextColor(90); d.text(l, x + 8, y + 42); });
  y += 78; h2("Contribution by pillar", y); y += 12;
  at(d, { startY: y, margin: { left: M, right: M }, theme: "grid", styles: { fontSize: 8, cellPadding: 3, valign: "top", lineColor: [210, 220, 224] }, headStyles: { fillColor: hex(NAVY), textColor: 255 },
    head: [["", "Pillar", "Weight share", "Progress", "Rating", "What drove the rating"]], columns: [{ dataKey: "no" }, { dataKey: "name" }, { dataKey: "share" }, { dataKey: "avg" }, { dataKey: "rag" }, { dataKey: "why" }],
    columnStyles: { no: { cellWidth: 22, fontStyle: "bold" }, name: { cellWidth: 110 }, share: { cellWidth: 48 }, avg: { cellWidth: 46 }, rag: { cellWidth: 52 } }, didParseCell: colorCell,
    body: r.pillars.map(p => ({ no: p.no, name: p.name, share: p.items.length ? p.share + "%" : "–", avg: p.items.length ? p.avg + "%" : "–", rag: { k: p.rag, t: RAG_TXT[p.rag] }, why: p.items.length ? p.items.map(i => `${i.name} (${i.pct}%)`).join("; ") : "No activity was linked to this pillar in the month." })) });
  y = d.lastAutoTable.finalY + 8; d.setFontSize(7.5); d.setTextColor(110); d.setFont("helvetica", "normal"); d.text("Weight share: share of the office's total strategic weight. Progress: weighted average % complete. Rating: Green 90%+, Amber 70–89%, Red below 70% or blocked.", M, y);
  y += 22; h2("Objectives reached", y); y += 12;
  at(d, { startY: y, margin: { left: M, right: M }, theme: "striped", styles: { fontSize: 8, cellPadding: 3 }, headStyles: { fillColor: hex(NAVY), textColor: 255 }, head: [["Objective", "Pillar", "Activities", "Weight", "Progress"]],
    columnStyles: { 1: { cellWidth: 40 }, 2: { cellWidth: 52 }, 3: { cellWidth: 44 }, 4: { cellWidth: 52 } }, body: r.objectives.map(x => [`${x.id}  ${x.name}`, PILLARS.find(p => p.id === x.pillar).no, x.n, x.w, x.avg + "%"]) });
  foot(1);
  // page 2
  d.addPage(); head(`${o.unit}: strategy review`, `${o.month} · what was done, what is off track, what comes next`);
  y = 92; h2("What was done, by activity", y); y += 12;
  at(d, { startY: y, margin: { left: M, right: M }, theme: "striped", styles: { fontSize: 7.6, cellPadding: 2.6, valign: "top" }, headStyles: { fillColor: hex(NAVY), textColor: 255 }, head: [["Activity (rolling tasks counted once)", "Goal", "Weight", "Progress", "Summary"]],
    columnStyles: { 1: { cellWidth: 30 }, 2: { cellWidth: 36 }, 3: { cellWidth: 44 }, 4: { cellWidth: 230 } },
    body: r.items.filter(i => i.pillar).sort((a, b) => a.goal.localeCompare(b.goal) || b.w - a.w).map(i => [i.name, i.goal, i.w, i.pct + "%", short(i.summary || i.titles.join("; "), 300)]) });
  y = d.lastAutoTable.finalY + 14; const { off, open, gaps } = risksAndNext(r);
  h2("Off track and corrective action", y); y += 14; d.setFont("helvetica", "normal"); d.setFontSize(8.4); d.setTextColor(40);
  const lines = []; off.slice(0, 4).forEach(i => lines.push(`${i.name} is at ${i.pct}%: recovery plan within 30 days, sponsor named.`)); if (gaps.length) lines.push(`No activity linked to ${gaps.map(p => "Pillar " + p.no).join(", ")}: plan at least one activity for each in the next month.`); if (!lines.length) lines.push("Nothing is off track.");
  lines.forEach(t => { const w = d.splitTextToSize("• " + t, W - 2 * M); d.text(w, M, y); y += w.length * 10.5; });
  y += 10; h2("Priorities for next month", y); y += 14;
  const pr = open.slice(0, 4).map(i => `Close ${i.name} (${i.pct}% now).`); gaps.slice(0, 2).forEach(p => pr.push(`Start work on Pillar ${p.no}, ${p.name}.`)); pr.push("Link every new activity to an objective and weight it when planning.");
  d.setFont("helvetica", "normal"); d.setFontSize(8.4); d.setTextColor(40); pr.forEach((t, i) => { const w = d.splitTextToSize(`${i + 1}. ${t}`, W - 2 * M); d.text(w, M, y); y += w.length * 10.5; });
  foot(2);
  return d.output("arraybuffer");
}

export async function buildPpt(r, o) {
  const mod = await import("pptxgenjs"); const Pptx = mod.default || mod; const p = new Pptx(); p.layout = "LAYOUT_WIDE"; p.title = `${o.unit} strategy review ${o.month}`; p.author = "Wagwago Business Group";
  const F = "Calibri", W = 13.33;
  const head = (s, t, sub) => { s.background = { color: "FFFFFF" }; s.addShape(p.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.95, fill: { color: NAVY }, line: { color: NAVY } }); s.addShape(p.ShapeType.rect, { x: 0, y: 0.95, w: W, h: 0.05, fill: { color: GOLD }, line: { color: GOLD } }); s.addText(t, { x: 0.5, y: 0.1, w: 10.5, h: 0.5, fontFace: F, fontSize: 24, bold: true, color: "FFFFFF", fit: "shrink" }); s.addText(sub || "", { x: 0.5, y: 0.55, w: 11, h: 0.3, fontFace: F, fontSize: 12, color: "F2D68A" }); };
  const hdr = a => a.map(t => ({ text: t, options: { bold: true, color: "FFFFFF", fill: { color: NAVY }, fontFace: F, fontSize: 11 } }));
  const cell = (t, o2 = {}) => ({ text: String(t), options: { fontFace: F, fontSize: 10.5, color: "222222", valign: "top", ...o2 } });
  // 1 title and at a glance
  let s = p.addSlide(); s.background = { color: NAVY };
  s.addText(o.unit.toUpperCase(), { x: 0.7, y: 0.5, w: 8, h: 0.4, fontFace: F, fontSize: 14, bold: true, color: GOLD });
  s.addText("Strategy review", { x: 0.7, y: 0.95, w: 9, h: 0.9, fontFace: F, fontSize: 40, bold: true, color: "FFFFFF" }); s.addText(`${o.month} · contribution to the seven strategic pillars`, { x: 0.7, y: 1.85, w: 10, h: 0.4, fontFace: F, fontSize: 16, italic: true, color: "DCE8EB" });
  [[r.tasks, "tasks tracked"], [Math.round(r.doneN / r.tasks * 100) + "%", "completed"], [r.open, "still open"], [r.carried, "carried forward"], [r.touched + " of 7", "pillars reached"], [r.perf + "%", "weighted progress"]].forEach(([v, l], i) => { const x = 0.7 + i * 2.05; s.addShape(p.ShapeType.roundRect, { x, y: 2.8, w: 1.9, h: 1.35, fill: { color: "135566" }, line: { color: "2B7185" }, rectRadius: 0.08 }); s.addText(String(v), { x: x + 0.1, y: 2.9, w: 1.7, h: 0.7, fontFace: F, fontSize: 30, bold: true, color: "FFFFFF" }); s.addText(l, { x: x + 0.1, y: 3.6, w: 1.7, h: 0.4, fontFace: F, fontSize: 12, color: "DCE8EB" }); });
  s.addText(PILLARS.map(q => ({ text: `${q.no}  ${q.name}`, options: { breakLine: true, color: "FFFFFF", fontSize: 12 } })), { x: 0.7, y: 4.5, w: 8, h: 2.6, fontFace: F, valign: "top", paraSpaceAfter: 3 });
  // 2 pillar rating
  s = p.addSlide(); head(s, "Contribution by pillar", `${o.month} · rating and what drove it`);
  s.addTable([hdr(["", "Pillar", "Weight", "Progress", "Rating", "What drove the rating"]), ...r.pillars.map(q => [cell(q.no, { bold: true }), cell(q.name), cell(q.items.length ? q.share + "%" : "–"), cell(q.items.length ? q.avg + "%" : "–"), cell(RAG_TXT[q.rag], { bold: true, color: RAGC[q.rag] }), cell(q.items.length ? short(q.items.map(i => `${i.name} (${i.pct}%)`).join("; "), 150) : "No activity linked to this pillar this month.")])], { x: 0.4, y: 1.2, w: 12.5, colW: [0.5, 2.7, 0.9, 0.95, 1.2, 6.25], border: { type: "solid", color: "D5DEE1", pt: 0.5 }, rowH: 0.62 });
  s.addText("Rating: Green 90%+ · Amber 70–89% · Red below 70% or blocked. Weight = share of the office's strategic weight.", { x: 0.4, y: 6.95, w: 12.5, h: 0.3, fontFace: F, fontSize: 10, color: "6B7C82" });
  // 3 what was done
  s = p.addSlide(); head(s, "What was done", "Rolling and carried tasks are counted once");
  const rows = r.items.filter(i => i.pillar).sort((a, b) => b.w - a.w).slice(0, 9);
  s.addTable([hdr(["Activity", "Goal", "Weight", "Progress", "Summary"]), ...rows.map(i => [cell(i.name, { bold: true }), cell(i.goal), cell(i.w), cell(i.pct + "%"), cell(short(i.summary || i.titles.join("; "), 140), { fontSize: 9.5 })])], { x: 0.4, y: 1.2, w: 12.5, colW: [3.3, 0.7, 0.8, 0.9, 6.8], border: { type: "solid", color: "D5DEE1", pt: 0.5 } });
  // 4 teams and objectives
  s = p.addSlide(); head(s, "Teams and objectives", "Who delivered, and which objectives they served");
  s.addTable([hdr(["Team", "Tasks", "Done", "Progress"]), ...r.teams.map(t => [cell(t.dept), cell(t.n), cell(t.done), cell(t.avg + "%")])], { x: 0.4, y: 1.25, w: 5.6, colW: [3.0, 0.8, 0.8, 1.0], border: { type: "solid", color: "D5DEE1", pt: 0.5 } });
  s.addChart(p.charts.BAR, [{ name: "Weight", labels: r.objectives.map(x => x.id), values: r.objectives.map(x => x.w) }], { x: 6.3, y: 1.2, w: 6.6, h: 3.1, barDir: "col", chartColors: [NAVY], showValue: true, catAxisLabelFontSize: 10, valAxisHidden: true, valGridLine: { style: "none" }, showTitle: true, title: "Strategic weight by objective", titleFontSize: 12 });
  s.addTable([hdr(["Objective", "Weight", "Progress"]), ...r.objectives.map(x => [cell(`${x.id} ${short(x.name, 60)}`, { fontSize: 9.5 }), cell(x.w), cell(x.avg + "%")])], { x: 6.3, y: 4.4, w: 6.6, colW: [4.6, 1.0, 1.0], border: { type: "solid", color: "D5DEE1", pt: 0.5 } });
  // 5 off track + priorities
  s = p.addSlide(); head(s, "Off track and next month", "Corrective action and priorities");
  const { off, open, gaps } = risksAndNext(r);
  const bl = []; off.slice(0, 5).forEach(i => bl.push(`${i.name}: ${i.pct}%. Recovery plan within 30 days, sponsor named.`)); if (gaps.length) bl.push(`No activity linked to ${gaps.map(q => "Pillar " + q.no).join(", ")}.`); if (!bl.length) bl.push("Nothing is off track.");
  s.addText("Off track", { x: 0.5, y: 1.25, w: 6, h: 0.4, fontFace: F, fontSize: 16, bold: true, color: RAGC.red }); s.addText(bl.map(t => ({ text: t, options: { bullet: true, breakLine: true } })), { x: 0.5, y: 1.7, w: 6, h: 4.8, fontFace: F, fontSize: 13, color: "222222", valign: "top", paraSpaceAfter: 6 });
  const pr = open.slice(0, 4).map(i => `Close ${i.name} (${i.pct}% now).`); gaps.slice(0, 3).forEach(q => pr.push(`Start work on Pillar ${q.no}, ${q.name}.`)); pr.push("Link every new activity to an objective and weight it at planning.");
  s.addText("Priorities for next month", { x: 6.9, y: 1.25, w: 6, h: 0.4, fontFace: F, fontSize: 16, bold: true, color: NAVY }); s.addText(pr.map(t => ({ text: t, options: { bullet: { type: "number" }, breakLine: true } })), { x: 6.9, y: 1.7, w: 6, h: 4.8, fontFace: F, fontSize: 13, color: "222222", valign: "top", paraSpaceAfter: 6 });
  return await p.write({ outputType: "arraybuffer" });
}
