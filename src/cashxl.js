// Small helpers shared by the Cash flow Excel templates and uploads (ExcelJS to write, SheetJS to read).
export const serialToIso = (v) => { if (v === "" || v == null) return ""; if (typeof v === "number") return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10); if (v instanceof Date) return v.toISOString().slice(0, 10); const s = String(v).trim(); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0]; const d = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); return d ? `${d[3]}-${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}` : ""; };
export const bucketOf = (v) => { const x = parseInt(String(v).trim(), 10); return x === 1 || x === 11 ? 1 : x === 2 || x === 22 ? 2 : x === 3 || x === 33 ? 3 : 0; };
export const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const money = (x) => { if (x === "" || x == null) return null; const n = Number(String(x).replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
export const toDate = (iso) => (iso ? new Date(iso + "T00:00:00Z") : "");

export const YELLOW = "FFF5C518", GREY = "FFEFEFEF", BLUE = "FFDCE9F7";
export const head = (ws, row, heads, widths) => { heads.forEach((t, i) => { const cell = ws.getCell(row, i + 1); cell.value = t; cell.font = { bold: true, color: { argb: "FF2A2208" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: YELLOW } }; cell.alignment = { wrapText: true, vertical: "middle", horizontal: "center" }; cell.border = { bottom: { style: "thin" } }; if (widths) ws.getColumn(i + 1).width = widths[i]; }); ws.getRow(row).height = 30; };
export const fill = (cell, argb) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } }; };
export const bold = (cell) => { cell.font = { ...(cell.font || {}), bold: true }; };
export const listV = (ws, col, from, last, name, msg, warn) => { for (let r = from; r <= last; r++) ws.getCell(r, col).dataValidation = { type: "list", allowBlank: true, formulae: [name], showErrorMessage: true, errorStyle: warn ? "warning" : "stop", errorTitle: "Pick from the list", error: msg }; };
export const numV = (ws, col, from, last, min) => { for (let r = from; r <= last; r++) { ws.getCell(r, col).dataValidation = { type: "decimal", operator: min === null ? "between" : "greaterThanOrEqual", allowBlank: true, formulae: min === null ? [-1e15, 1e15] : [min], showErrorMessage: true, errorTitle: "Amount", error: min === null ? "Enter a number." : "Enter a number, zero or more." }; ws.getCell(r, col).numFmt = "#,##0.00"; } };
export const dateV = (ws, col, from, last) => { for (let r = from; r <= last; r++) { ws.getCell(r, col).dataValidation = { type: "date", operator: "greaterThan", allowBlank: true, formulae: [new Date(Date.UTC(2020, 0, 1))], showErrorMessage: true, errorTitle: "Date", error: "Enter a date, for example 2026-10-22." }; ws.getCell(r, col).numFmt = "yyyy-mm-dd"; } };

// A workbook with a hidden Lists sheet. listsFn(col) adds named lists: col(index, array, name).
export async function newBook(c, listsFn) {
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch (e) { c.toast("The Excel tool did not load. Reload the page and try again."); return null; }
  const wb = new ExcelJS.Workbook(), lists = wb.addWorksheet("Lists", { state: "veryHidden" });
  const col = (i, arr, name) => { arr.forEach((x, k) => { lists.getCell(k + 1, i).value = x; }); const L = lists.getColumn(i).letter; wb.definedNames.add(`Lists!$${L}$1:$${L}$${Math.max(1, arr.length)}`, name); };
  listsFn(col); return wb;
}
export const infoSheet = (wb, title, lines) => { const info = wb.addWorksheet("How to", { views: [{ showGridLines: false }] }); info.getColumn(1).width = 5; info.getColumn(2).width = 120; const t = info.addRow([title]); t.font = { bold: true, size: 14 }; lines.forEach((l, i) => info.addRow([i + 1, l])); wb.worksheets.forEach((w) => { if (w.name !== "Lists") w.properties.tabColor = { argb: w.name === "How to" ? "FF999999" : YELLOW }; }); };
export const readSheets = (X, wb, re) => wb.SheetNames.filter((n) => re.test(n)).map((n) => ({ name: n, rows: X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" }) }));
export async function readBook(c, file) {
  if (!c.libsReady("xlsx")) return null; const X = c.XLSX();
  try { return { X, wb: X.read(await file.arrayBuffer(), { type: "array" }) }; } catch (e) { c.toast("Could not read that file. Use the template from this page."); return null; }
}
