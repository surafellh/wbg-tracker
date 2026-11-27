// Downloads for the strategy review: a 2-page PDF and a 5-slide deck, built in the browser from the saved review (no AI).
import { PILLARS } from "./strategy.js";
import { reviewFromItems, RAG_TXT, SHORT } from "./strategyauto.js";
export { reviewFromItems, RAG_TXT };

const NAVY = "0B3C49", GOLD = "D9A93A", INK = "222222", MUTE = "6B7C82";
const RAGC = { green: "2E7D32", amber: "C77D0A", red: "B3261E", none: "7A8A90", gap: "B3261E" };
const short = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; };
const hex = h => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4), 16)];
const rg = p => p.gap ? "gap" : p.rag;
export function priorities(r) {
  const open = r.items.filter(i => i.pillar && !i.done).sort((a, b) => b.w - a.w || a.pct - b.pct);
  const off = open.filter(i => i.pct < 70), gaps = r.pillars.filter(p => p.gap), unders = r.pillars.filter(p => p.under && p.items.length);
  const next = open.slice(0, 4).map(i => `Close "${short(i.name, 70)}" (${i.pct}% now).`);
  gaps.slice(0, 3).forEach(p => next.push(`Start work on Pillar ${p.no}, ${p.name}: ${p.planned}% of effort is planned but nothing was done.`));
  unders.slice(0, 2).forEach(p => next.push(`Raise effort on Pillar ${p.no}: ${p.share}% delivered against ${p.planned}% planned.`));
  if (r.unassigned.length) next.push(`Link ${r.unassigned.length} unassigned ${r.unassigned.length === 1 ? "activity" : "activities"} to a pillar.`);
  const flag = off.slice(0, 5).map(i => `${short(i.name, 80)} is at ${i.pct}%: recovery plan within 30 days, sponsor named.`);
  gaps.forEach(p => flag.push(`No activity on Pillar ${p.no} (${p.planned}% planned).`));
  if (!flag.length) flag.push("Nothing is off track.");
  return { flag, next: next.length ? next : ["Keep every new activity linked to a pillar and weighted at planning."] };
}
const glance = r => [[r.tasks, "tasks tracked"], [r.tasks ? Math.round(r.doneN / r.tasks * 100) + "%" : "0%", "completed"], [r.activities, "activities"], [`${r.touched} of 7`, "pillars reached"], [r.perf + "%", "weighted progress"], [r.match == null ? "–" : Math.round(r.match) + "%", "plan match"]];

export async function buildPdf(r, o) {
  const { jsPDF } = await import("jspdf"); const atm = await import("jspdf-autotable"); const at = typeof atm.default === "function" ? atm.default : (atm.default && atm.default.default) || atm.autoTable;
  const make = lim => {
    const d = new jsPDF({ unit: "pt", format: "a4" }), W = 595, M = 34;
    const head = (t, sub) => { d.setFillColor(...hex(NAVY)); d.rect(0, 0, W, 62, "F"); d.setFillColor(...hex(GOLD)); d.rect(0, 62, W, 3, "F"); d.setTextColor(255); d.setFont("helvetica", "bold"); d.setFontSize(16); d.text(t, M, 28); d.setFont("helvetica", "normal"); d.setFontSize(9.5); d.text(sub, M, 46); if (o.status !== "final") { d.setFontSize(8); d.setTextColor(...hex("F2D68A")); d.text("DRAFT, pending unit confirmation", W - M, 28, { align: "right" }); } };
    const h2 = (t, y) => { d.setTextColor(...hex(NAVY)); d.setFont("helvetica", "bold"); d.setFontSize(11.5); d.text(t, M, y); d.setDrawColor(...hex(GOLD)); d.setLineWidth(1.2); d.line(M, y + 4, M + 40, y + 4); };
    const foot = n => { d.setFontSize(8); d.setTextColor(120); d.setFont("helvetica", "normal"); d.text(`${o.unit} · Strategy review · ${o.month}`, M, 820); d.text(`Page ${n} of 2`, W - M, 820, { align: "right" }); };
    head(`${o.unit}: strategy review`, `${o.month} · contribution to the seven strategic pillars`);
    let y = 86; glance(r).forEach(([v, l], i) => { const x = M + i * 91; d.setFillColor(236, 242, 244); d.roundedRect(x, y, 85, 50, 4, 4, "F"); d.setTextColor(...hex(NAVY)); d.setFont("helvetica", "bold"); d.setFontSize(16); d.text(String(v), x + 8, y + 25); d.setFont("helvetica", "normal"); d.setFontSize(8); d.setTextColor(90); d.text(l, x + 8, y + 40); });
    y += 76; h2("Planned against actual, by pillar", y); y += 16;
    const labW = 120, barX = M + labW, barW = 255, mx = Math.max(20, ...r.pillars.map(p => Math.max(p.planned, p.share)));
    d.setFontSize(7.5); d.setFillColor(...hex(GOLD)); d.rect(barX, y - 8, 8, 6, "F"); d.setTextColor(90); d.text("Planned share of effort", barX + 12, y - 3); d.setFillColor(...hex(NAVY)); d.rect(barX + 110, y - 8, 8, 6, "F"); d.text("Actual share of this month's weighted effort", barX + 122, y - 3); y += 8;
    r.pillars.forEach(p => {
      d.setFont("helvetica", "bold"); d.setFontSize(8.5); d.setTextColor(...hex(NAVY)); d.text(`${p.no}  ${p.short}`, M, y + 9);
      d.setFillColor(...hex(GOLD)); d.rect(barX, y, Math.max(0, p.planned / mx * barW), 8, "F"); d.setFillColor(...hex(NAVY)); d.rect(barX, y + 10, Math.max(0, p.share / mx * barW), 8, "F");
      d.setFont("helvetica", "normal"); d.setFontSize(7.5); d.setTextColor(70); d.text(`${p.planned}%`, barX + p.planned / mx * barW + 4, y + 7); d.text(`${p.share}%`, barX + p.share / mx * barW + 4, y + 17);
      d.setFont("helvetica", "bold"); d.setFontSize(8.5); d.setTextColor(...hex(RAGC[rg(p)])); d.text(RAG_TXT[rg(p)], W - M - 80, y + 9); d.setFont("helvetica", "normal"); d.setTextColor(70); d.text(p.items.length ? `${p.avg}% progress` : "", W - M - 80, y + 18);
      y += 27;
    });
    y += 4; h2("How the unit contributed", y); y += 10;
    at(d, { startY: y, margin: { left: M, right: M }, theme: "grid", styles: { fontSize: 7.8, cellPadding: 3, valign: "top", lineColor: [210, 220, 224] }, headStyles: { fillColor: hex(NAVY), textColor: 255 }, head: [["", "Pillar", "Plan", "Actual", "Rating", "Contribution"]], columnStyles: { 0: { cellWidth: 20, fontStyle: "bold" }, 1: { cellWidth: 100 }, 2: { cellWidth: 30 }, 3: { cellWidth: 34 }, 4: { cellWidth: 46 } },
      didParseCell: c => { if (c.section === "body" && c.column.index === 4) { c.cell.styles.textColor = hex(RAGC[c.cell.raw.k]); c.cell.styles.fontStyle = "bold"; c.cell.text = [c.cell.raw.t]; } },
      body: r.pillars.map(p => [p.no, p.name, p.planned ? p.planned + "%" : "–", p.items.length ? p.share + "%" : "–", { k: rg(p), t: RAG_TXT[rg(p)] }, p.text]) });
    d.setFontSize(7); d.setTextColor(110); d.text("Rating: Green 90%+, Amber 70–89%, Red below 70%. Actual share = weighted effort of the activities linked to the pillar.", M, d.lastAutoTable.finalY + 10);
    foot(1);
    d.addPage(); head(`${o.unit}: what was done`, `${o.month} · activities under each pillar, rolling tasks counted once`);
    const body = []; r.pillars.forEach(p => { body.push([{ content: `${p.no}  ${p.name}   ·   plan ${p.planned || 0}%   ·   actual ${p.share}%   ·   ${RAG_TXT[rg(p)]}`, colSpan: 4, styles: { fillColor: hex("E6EDF0"), textColor: hex(NAVY), fontStyle: "bold" } }]);
      if (!p.items.length) body.push([{ content: "No activity this month.", colSpan: 4, styles: { textColor: [130, 140, 145], fontStyle: "italic" } }]);
      [...p.items].sort((a, b) => b.w - a.w).forEach(i => body.push([short(i.name, 70), i.w, i.pct + "%", short(i.summary || (i.tasks || []).map(t => t.title).join("; "), lim)])); });
    if (r.unassigned.length) { body.push([{ content: "Needs a pillar", colSpan: 4, styles: { fillColor: hex("FBE1DB"), textColor: hex("B3261E"), fontStyle: "bold" } }]); r.unassigned.forEach(i => body.push([short(i.name, 70), i.w, i.pct + "%", short(i.summary, lim)])); }
    at(d, { startY: 82, margin: { left: M, right: M, bottom: 120 }, theme: "plain", styles: { fontSize: 7.2, cellPadding: { top: 1.8, bottom: 1.8, left: 3, right: 3 }, valign: "top", lineColor: [225, 230, 232], lineWidth: 0.3 }, head: [["Activity", "Weight", "Progress", "What was done"]], headStyles: { fillColor: hex(NAVY), textColor: 255, fontStyle: "bold" }, columnStyles: { 0: { cellWidth: 150 }, 1: { cellWidth: 36 }, 2: { cellWidth: 42 } }, body });
    const pr = priorities(r); let yy = Math.max(d.lastAutoTable.finalY + 14, 0);
    if (yy < 700) { h2("Off track and next month", yy); yy += 14; d.setFont("helvetica", "normal"); d.setFontSize(7.8); d.setTextColor(40);
      [...pr.flag.slice(0, 3).map(t => "• " + t), ...pr.next.slice(0, 4).map((t, i) => `${i + 1}. ${t}`)].forEach(t => { if (yy > 800) return; const w = d.splitTextToSize(t, W - 2 * M); d.text(w, M, yy); yy += w.length * 9.2; }); }
    foot(2); return d;
  };
  for (const lim of [230, 170, 120, 80, 50]) { const d = make(lim); if (d.getNumberOfPages() === 2) return d.output("arraybuffer"); }
  const d = make(50); while (d.getNumberOfPages() > 2) d.deletePage(d.getNumberOfPages()); return d.output("arraybuffer");
}

export async function buildPpt(r, o) {
  const mod = await import("pptxgenjs"); const Pptx = mod.default || mod; const p = new Pptx(); p.layout = "LAYOUT_WIDE"; p.title = `${o.unit} strategy review ${o.month}`; p.author = "Wagwago Business Group";
  const F = "Calibri", W = 13.33;
  const head = (s, t, sub) => { s.background = { color: "FFFFFF" }; s.addShape(p.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.95, fill: { color: NAVY }, line: { color: NAVY } }); s.addShape(p.ShapeType.rect, { x: 0, y: 0.95, w: W, h: 0.05, fill: { color: GOLD }, line: { color: GOLD } }); s.addText(t, { x: 0.5, y: 0.1, w: 10.5, h: 0.5, fontFace: F, fontSize: 24, bold: true, color: "FFFFFF", fit: "shrink" }); s.addText(sub || "", { x: 0.5, y: 0.55, w: 10.5, h: 0.3, fontFace: F, fontSize: 12, color: "F2D68A" }); if (o.status !== "final") s.addText("DRAFT, pending unit confirmation", { x: 9.3, y: 0.15, w: 3.8, h: 0.3, fontFace: F, fontSize: 10, color: "F2D68A", align: "right" }); };
  const hdr = a => a.map(t => ({ text: t, options: { bold: true, color: "FFFFFF", fill: { color: NAVY }, fontFace: F, fontSize: 11 } }));
  const cell = (t, o2 = {}) => ({ text: String(t), options: { fontFace: F, fontSize: 10.5, color: INK, valign: "top", ...o2 } });
  let s = p.addSlide(); s.background = { color: NAVY };
  s.addText(o.unit.toUpperCase(), { x: 0.7, y: 0.5, w: 9, h: 0.4, fontFace: F, fontSize: 14, bold: true, color: GOLD });
  s.addText("Strategy review", { x: 0.7, y: 0.95, w: 9, h: 0.9, fontFace: F, fontSize: 40, bold: true, color: "FFFFFF" }); s.addText(`${o.month} · contribution to the seven strategic pillars`, { x: 0.7, y: 1.85, w: 10, h: 0.4, fontFace: F, fontSize: 16, italic: true, color: "DCE8EB" });
  glance(r).forEach(([v, l], i) => { const x = 0.7 + i * 2.05; s.addShape(p.ShapeType.roundRect, { x, y: 2.8, w: 1.9, h: 1.35, fill: { color: "135566" }, line: { color: "2B7185" }, rectRadius: 0.08 }); s.addText(String(v), { x: x + 0.1, y: 2.9, w: 1.7, h: 0.7, fontFace: F, fontSize: 30, bold: true, color: "FFFFFF" }); s.addText(l, { x: x + 0.1, y: 3.6, w: 1.7, h: 0.4, fontFace: F, fontSize: 12, color: "DCE8EB" }); });
  s.addText(r.pillars.map(q => ({ text: `${q.no}  ${q.name}   ${q.items.length ? q.share + "% of effort" : "no activity"}`, options: { breakLine: true, color: q.items.length ? "FFFFFF" : "F2D68A", fontSize: 12 } })), { x: 0.7, y: 4.5, w: 9, h: 2.6, fontFace: F, valign: "top", paraSpaceAfter: 3 });
  if (o.status !== "final") s.addText("DRAFT, pending unit confirmation", { x: 8.5, y: 0.5, w: 4.3, h: 0.3, fontFace: F, fontSize: 11, color: "F2D68A", align: "right" });
  s = p.addSlide(); head(s, "Contribution to the pillars", "Planned against actual share of effort, with progress and rating");
  s.addChart(p.charts.BAR, [{ name: "Planned", labels: SHORT, values: r.pillars.map(q => q.planned) }, { name: "Actual", labels: SHORT, values: r.pillars.map(q => q.share) }], { x: 0.4, y: 1.15, w: 6.4, h: 5.9, barDir: "bar", barGrouping: "clustered", chartColors: [GOLD, NAVY], showLegend: true, legendPos: "b", legendFontSize: 11, showValue: true, dataLabelFontSize: 9, catAxisOrientation: "maxMin", catAxisLabelFontSize: 10, valAxisHidden: true, valGridLine: { style: "none" } });
  s.addTable([hdr(["Pillar", "Plan", "Actual", "Progress", "Rating"]), ...r.pillars.map(q => [cell(`${q.no}  ${q.short}`, { fontSize: 10.5 }), cell(q.planned ? q.planned + "%" : "–"), cell(q.items.length ? q.share + "%" : "–"), cell(q.items.length ? q.avg + "%" : "–"), cell(RAG_TXT[rg(q)], { bold: true, color: RAGC[rg(q)] })])], { x: 7.0, y: 1.2, w: 5.9, colW: [2.5, 0.7, 0.8, 0.95, 0.95], border: { type: "solid", color: "D5DEE1", pt: 0.5 }, rowH: 0.5 });
  s.addText("Actual = weighted effort of the activities linked to the pillar. Rating: Green 90%+, Amber 70–89%, Red below 70%.", { x: 7.0, y: 5.4, w: 5.9, h: 0.6, fontFace: F, fontSize: 10, color: MUTE });
  const doneSlide = (title, ps) => { const sl = p.addSlide(); head(sl, title, "What the unit did under each pillar, rolling tasks counted once");
    const rows = [hdr(["Pillar / activity", "Weight", "Progress", "What was done"])];
    ps.forEach(q => { rows.push([{ text: `${q.no}  ${q.name}   plan ${q.planned || 0}%  ·  actual ${q.share}%  ·  ${RAG_TXT[rg(q)]}`, options: { colspan: 4, bold: true, color: NAVY, fill: { color: "E6EDF0" }, fontFace: F, fontSize: 10.5 } }]);
      if (!q.items.length) rows.push([{ text: q.planned ? `Nothing was done, although ${q.planned}% of effort was planned.` : "No activity this month.", options: { colspan: 4, italic: true, color: "8A979C", fontFace: F, fontSize: 10 } }]);
      const top = [...q.items].sort((a, b) => b.w - a.w); top.slice(0, 3).forEach(i => rows.push([cell(short(i.name, 62), { fontSize: 9.5, bold: true }), cell(i.w, { fontSize: 9.5 }), cell(i.pct + "%", { fontSize: 9.5 }), cell(short(i.summary || (i.tasks || []).map(t => t.title).join("; "), 150), { fontSize: 9 })]));
      if (top.length > 3) rows.push([{ text: `and ${top.length - 3} more ${top.length - 3 === 1 ? "activity" : "activities"}: ${short(top.slice(3).map(i => i.name).join("; "), 120)}`, options: { colspan: 4, italic: true, color: MUTE, fontFace: F, fontSize: 9 } }]); });
    sl.addTable(rows, { x: 0.4, y: 1.15, w: 12.5, colW: [3.8, 0.8, 0.9, 7.0], border: { type: "solid", color: "D5DEE1", pt: 0.5 } }); };
  doneSlide("What was done: pillars I to III", r.pillars.slice(0, 3)); doneSlide("What was done: pillars IV to VII", r.pillars.slice(3));
  s = p.addSlide(); head(s, "Off track and next month", "Corrective action and priorities"); const pr = priorities(r);
  s.addText("Off track", { x: 0.5, y: 1.25, w: 6, h: 0.4, fontFace: F, fontSize: 16, bold: true, color: RAGC.red }); s.addText(pr.flag.map(t => ({ text: t, options: { bullet: true, breakLine: true } })), { x: 0.5, y: 1.7, w: 6, h: 5, fontFace: F, fontSize: 13, color: INK, valign: "top", paraSpaceAfter: 6 });
  s.addText("Priorities for next month", { x: 6.9, y: 1.25, w: 6, h: 0.4, fontFace: F, fontSize: 16, bold: true, color: NAVY }); s.addText(pr.next.map(t => ({ text: t, options: { bullet: { type: "number" }, breakLine: true } })), { x: 6.9, y: 1.7, w: 6, h: 5, fontFace: F, fontSize: 13, color: INK, valign: "top", paraSpaceAfter: 6 });
  return await p.write({ outputType: "arraybuffer" });
}
