// PowerPoint summary of the weekly report, with charts. Loaded on demand (pptxgenjs is large).
import { FINAL_LABELS, FINAL_COLOR, finalLabel, finalSummary, pctOf } from "./finalstatus.js";

const INK = "2A2208", MUTED = "6B5F3A", GOLD = "F5C518", SOFT = "FDF3C9", LINE = "E8E4D3", BRAND = "8A6400";
const FONT = "Calibri";

// units: [{ name, type, tasks: [...], wins, blockers, asks }]; opts: { weekLabel, final, scope }
export async function buildDeck(units, opts) {
  const mod = await import("pptxgenjs");
  const Pptx = mod.default || mod;
  const pptx = new Pptx();
  pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
  pptx.title = `Weekly performance · ${opts.weekLabel}`;
  pptx.author = "Wagwago Business Group · Group Strategy";
  const W = 13.33;

  const head = (s, title, sub) => {
    s.background = { color: "FFFFFF" };
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.95, fill: { color: GOLD }, line: { color: GOLD } });
    s.addText(title, { x: 0.5, y: 0.12, w: 9.5, h: 0.5, fontFace: FONT, fontSize: 24, bold: true, color: INK, fit: "shrink" });
    s.addText(sub || opts.weekLabel, { x: 0.5, y: 0.55, w: 9.5, h: 0.3, fontFace: FONT, fontSize: 12, color: "5C4A10" });
    s.addText("Wagwago Business Group · Weekly performance", { x: 8.3, y: 0.3, w: 4.6, h: 0.3, fontFace: FONT, fontSize: 10, color: "5C4A10", align: "right" });
  };
  const kpi = (s, x, y, w, big, label, color) => {
    s.addShape(pptx.ShapeType.roundRect, { x, y, w, h: 1.05, fill: { color: SOFT }, line: { color: LINE }, rectRadius: 0.08 });
    s.addText(String(big), { x: x + 0.15, y: y + 0.08, w: w - 0.3, h: 0.55, fontFace: FONT, fontSize: 26, bold: true, color: color || BRAND });
    s.addText(label, { x: x + 0.15, y: y + 0.62, w: w - 0.3, h: 0.35, fontFace: FONT, fontSize: 11, color: INK, fit: "shrink" });
  };
  const doughnut = (s, counts, x, y, w, h) => {
    const labels = FINAL_LABELS.filter((l) => counts[l]);
    if (!labels.length) { s.addText("No tasks", { x, y, w, h, align: "center", fontFace: FONT, color: MUTED }); return; }
    s.addChart(pptx.charts.DOUGHNUT, [{ name: "Tasks", labels, values: labels.map((l) => counts[l]) }],
      { x, y, w, h, holeSize: 55, chartColors: labels.map((l) => FINAL_COLOR[l]), showLegend: true, legendPos: "r", legendFontSize: 11, legendFontFace: FONT,
        showPercent: false, showValue: true, dataLabelColor: "FFFFFF", dataLabelFontSize: 11, dataLabelFontBold: true });
  };

  const all = units.flatMap((u) => u.tasks);
  const tot = finalSummary(all);
  const rows = units.map((u) => ({ u, s: finalSummary(u.tasks) }));
  const withTasks = rows.filter((r) => r.s.total);

  // 1. title
  let s = pptx.addSlide();
  s.background = { color: GOLD };
  s.addText("WAGWAGO BUSINESS GROUP · GROUP STRATEGY", { x: 0.7, y: 1.5, w: 11.5, h: 0.4, fontFace: FONT, fontSize: 14, bold: true, color: "7A3E00" });
  s.addText("Weekly performance report", { x: 0.7, y: 2.0, w: 11.5, h: 1.0, fontFace: FONT, fontSize: 44, bold: true, color: INK });
  s.addText(opts.weekLabel, { x: 0.7, y: 3.1, w: 11.5, h: 0.6, fontFace: FONT, fontSize: 24, color: INK });
  s.addText(`${opts.scope} · ${opts.final ? "Final status (update period closed)" : "Status so far (update period still open)"}`, { x: 0.7, y: 3.8, w: 11.5, h: 0.4, fontFace: FONT, fontSize: 14, color: "5C4A10" });

  // 2. the week at a glance
  s = pptx.addSlide(); head(s, "The week at a glance", `${opts.weekLabel} · ${opts.scope}`);
  kpi(s, 0.5, 1.25, 2.9, tot.avg === null ? "–" : tot.avg + "%", "average % reached");
  kpi(s, 3.6, 1.25, 2.9, tot.total, "tasks in the report");
  kpi(s, 6.7, 1.25, 2.9, tot.counts["Achieved"], "achieved", FINAL_COLOR["Achieved"]);
  kpi(s, 9.8, 1.25, 3.0, tot.counts["Under performed"], "under performed", FINAL_COLOR["Under performed"]);
  s.addText("Tasks by final status", { x: 0.5, y: 2.55, w: 6, h: 0.35, fontFace: FONT, fontSize: 14, bold: true, color: INK });
  doughnut(s, tot.counts, 0.4, 2.9, 6.4, 4.2);
  const best = [...withTasks].filter((r) => r.s.avg !== null).sort((a, b) => b.s.avg - a.s.avg);
  const lines = [];
  if (best.length) {
    lines.push({ text: "Highlights", options: { bold: true, fontSize: 14, breakLine: true } });
    lines.push({ text: `Strongest: ${best[0].u.name} (${best[0].s.avg}%)`, options: { bullet: true, breakLine: true } });
    if (best.length > 1) lines.push({ text: `Needs attention: ${best[best.length - 1].u.name} (${best[best.length - 1].s.avg}%)`, options: { bullet: true, breakLine: true } });
    lines.push({ text: `${tot.counts["Well performed"]} well performed, ${tot.counts["Partially achieved"]} partially achieved`, options: { bullet: true, breakLine: true } });
    if (tot.counts["Cancelled"]) lines.push({ text: `${tot.counts["Cancelled"]} cancelled (not counted in the average)`, options: { bullet: true, breakLine: true } });
    const none = rows.filter((r) => !r.s.total).map((r) => r.u.name);
    if (none.length) lines.push({ text: `No plan: ${none.slice(0, 6).join(", ")}${none.length > 6 ? "…" : ""}`, options: { bullet: true } });
  }
  s.addText(lines, { x: 7.1, y: 3.0, w: 5.7, h: 3.8, fontFace: FONT, fontSize: 13, color: INK, valign: "top", paraSpaceAfter: 6 });

  // 3. average by unit (bar chart)
  if (withTasks.length) {
    const sorted = [...withTasks].sort((a, b) => (b.s.avg ?? -1) - (a.s.avg ?? -1));
    s = pptx.addSlide(); head(s, "Average % reached by unit", `${opts.weekLabel} · cancelled tasks excluded`);
    s.addChart(pptx.charts.BAR, [{ name: "Average % reached", labels: sorted.map((r) => r.u.name), values: sorted.map((r) => r.s.avg ?? 0) }],
      { x: 0.5, y: 1.2, w: 12.3, h: 5.9, barDir: "bar", chartColors: [GOLD], valAxisMaxVal: 100, valAxisMinVal: 0, valAxisLabelFontSize: 10, catAxisLabelFontSize: 11, catAxisOrientation: "maxMin",
        showValue: true, dataLabelFormatCode: "0\"%\"", dataLabelFontSize: 10, valGridLine: { color: LINE, size: 0.5 }, showLegend: false });

    // 4. status mix by unit (stacked)
    s = pptx.addSlide(); head(s, "Final status by unit", `${opts.weekLabel} · number of tasks`);
    const used = FINAL_LABELS.filter((l) => withTasks.some((r) => r.s.counts[l]));
    s.addChart(pptx.charts.BAR, used.map((l) => ({ name: l, labels: sorted.map((r) => r.u.name), values: sorted.map((r) => r.s.counts[l]) })),
      { x: 0.5, y: 1.2, w: 12.3, h: 5.9, barDir: "bar", barGrouping: "stacked", chartColors: used.map((l) => FINAL_COLOR[l]), catAxisOrientation: "maxMin", catAxisLabelFontSize: 11, valAxisLabelFontSize: 10,
        showLegend: true, legendPos: "b", legendFontSize: 11, valGridLine: { color: LINE, size: 0.5 } });

    // 5. summary table
    const PER = 11;
    for (let i = 0; i < sorted.length; i += PER) {
      s = pptx.addSlide(); head(s, "Performance summary" + (sorted.length > PER ? ` (${i / PER + 1})` : ""), opts.weekLabel);
      const hd = ["Unit", "Tasks", ...FINAL_LABELS, "Average"].map((t) => ({ text: t, options: { bold: true, fill: { color: GOLD }, color: INK, fontSize: 11, align: t === "Unit" ? "left" : "center" } }));
      const body = sorted.slice(i, i + PER).map((r) => [{ text: r.u.name, options: { bold: true, fontSize: 11 } }, { text: String(r.s.total), options: { align: "center", fontSize: 11 } },
        ...FINAL_LABELS.map((l) => ({ text: String(r.s.counts[l]), options: { align: "center", fontSize: 11, color: r.s.counts[l] ? FINAL_COLOR[l] : "BBB7A5", bold: !!r.s.counts[l] } })),
        { text: r.s.avg === null ? "–" : r.s.avg + "%", options: { align: "center", bold: true, fontSize: 11 } }]);
      s.addTable([hd, ...body], { x: 0.5, y: 1.25, w: 12.3, colW: [3.4, 0.9, 1.35, 1.5, 1.7, 1.5, 1.15, 0.8], fontFace: FONT, color: INK, border: { type: "solid", pt: 0.5, color: LINE }, rowH: 0.42 });
    }
  }

  // 6. one slide per unit
  withTasks.forEach(({ u, s: us }) => {
    s = pptx.addSlide(); head(s, u.name, `${opts.weekLabel} · ${u.type || ""}`);
    kpi(s, 0.5, 1.2, 2.0, us.avg === null ? "–" : us.avg + "%", "average");
    kpi(s, 2.65, 1.2, 2.0, us.total, "tasks");
    doughnut(s, us.counts, 0.3, 2.4, 5.0, 3.4);
    const weak = u.tasks.filter((t) => finalLabel(t) === "Under performed").sort((a, b) => pctOf(a) - pctOf(b)).slice(0, 6);
    const strong = u.tasks.filter((t) => finalLabel(t) === "Achieved").slice(0, 4);
    const txt = [];
    if (weak.length) {
      txt.push({ text: "Under performed", options: { bold: true, color: FINAL_COLOR["Under performed"], fontSize: 13, breakLine: true } });
      weak.forEach((t) => txt.push({ text: `${t.title}${t.dept ? " · " + t.dept : ""} (${pctOf(t)}%)`, options: { bullet: true, fontSize: 11, breakLine: true } }));
    }
    if (strong.length) {
      txt.push({ text: "Achieved", options: { bold: true, color: FINAL_COLOR["Achieved"], fontSize: 13, breakLine: true } });
      strong.forEach((t) => txt.push({ text: t.title, options: { bullet: true, fontSize: 11, breakLine: true } }));
    }
    s.addText(txt.length ? txt : [{ text: "Nothing to flag.", options: { fontSize: 12, color: MUTED } }], { x: 5.4, y: 1.2, w: 7.4, h: 4.6, fontFace: FONT, color: INK, valign: "top", fit: "shrink", paraSpaceAfter: 4 });
    const note = [u.blockers && "Blockers: " + u.blockers, u.asks && "Asks: " + u.asks].filter(Boolean).join("   ·   ");
    if (note) s.addText(note, { x: 0.5, y: 6.0, w: 12.3, h: 1.0, fontFace: FONT, fontSize: 11, color: "7A3E00", fit: "shrink", valign: "top" });
  });

  // 7. under performed and cancelled tasks, listed
  const flagged = units.flatMap((u) => u.tasks.filter((t) => ["Under performed", "Cancelled"].includes(finalLabel(t))).map((t) => [u.name, t]));
  if (flagged.length) {
    const PER = 9;
    for (let i = 0; i < flagged.length; i += PER) {
      s = pptx.addSlide(); head(s, "Under performed and cancelled tasks" + (flagged.length > PER ? ` (${i / PER + 1} of ${Math.ceil(flagged.length / PER)})` : ""), opts.weekLabel);
      const hd = ["Unit", "Task", "Department", "Owner", "%", "Result"].map((t) => ({ text: t, options: { bold: true, fill: { color: GOLD }, color: INK, fontSize: 10 } }));
      const body = flagged.slice(i, i + PER).map(([un, t]) => { const l = finalLabel(t); return [un, t.title || "", t.dept || "", t.owner || "", l === "Cancelled" ? "–" : pctOf(t) + "%", { text: l, options: { bold: true, color: FINAL_COLOR[l] } }]; });
      s.addTable([hd, ...body], { x: 0.5, y: 1.2, w: 12.3, colW: [2.2, 4.6, 1.8, 1.7, 0.7, 1.3], fontFace: FONT, fontSize: 10, color: INK, border: { type: "solid", pt: 0.5, color: LINE }, valign: "middle" });
    }
  }
  return pptx;
}
