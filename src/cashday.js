// Cash flow, the daily sheets. They look like the two sheets finance already keeps for the day:
//   Collections and payments: every open line, what was left at the start of the day, what moved today, the bank, what is left (start - moved).
//   Bank: per bank, opening + in - out = closing (worked out, never typed), with the total for the group.
// Also here: the daily Excel template (same two sheets) and its upload, and the downloads of what is on screen.
import { bucketCode, num, sum, addDays, MONTHS, etb } from "./cashcalc.js";
import * as XL from "./cashxl.js";

const PRI = { 1: 0, 2: 1, 3: 2 };
const dShort = (iso) => { if (!iso) return ""; const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

export function createDay(h) {
  const { S, c, esc, A } = h, plain = h.plain, mny = h.money, fx = h.fx;

  // ---------------- the lines of a day ----------------
  function dayLines(units, D) {
    const f = S.lf, q = f.q.trim().toLowerCase();
    return S.items.map((i) => ({ i, v: h.viewOf(i, D), start: h.viewOf(i, addDays(D, -1)) }))
      .filter(({ i, v, start }) => v.exists && units.includes(i.unit) && (!f.kind || i.kind === f.kind) && (f.type === "" || (f.type === "__none" ? !i.typeCode : i.typeCode === f.type))
        && (f.status === "all" || (f.status === "active" ? start.left > 0.005 || v.onDay > 0 || v.open : f.status === "open" ? v.open : f.status === "day" ? v.onDay > 0 : f.status === "settled" ? !v.open && !v.wo : v.wo))
        && (!q || `${i.code} ${i.party} ${i.description} ${i.ref} ${i.typeCode}`.toLowerCase().includes(q)))
      .sort((a, b) => (b.v.onDay > 0) - (a.v.onDay > 0) || (S.dr[b.i.id] && num(S.dr[b.i.id].amt) > 0 ? 1 : 0) - (S.dr[a.i.id] && num(S.dr[a.i.id].amt) > 0 ? 1 : 0) || b.i.kind.localeCompare(a.i.kind) || a.i.bucket - b.i.bucket || etb(b.i, fx()) - etb(a.i, fx()));
  }

  // ---------------- Collections and payments ----------------
  function renderColl() {
    const units = h.scopeUnits(), D = S.day, f = S.lf, list = dayLines(units, D), shown = list.slice(0, f.show), many = units.length > 1, n = h.draftCount(), w = h.writableUnits().length > 0;
    const rows = S.log.filter((l) => l.day === D && units.includes(l.unit));
    const liveIds = new Set(S.items.map((i) => i.id)), other = rows.filter((l) => !l.itemId || !liveIds.has(l.itemId));
    const sumK = (k, g) => sum(list.filter((o) => o.i.kind === k), (o) => num(g(o)) * (o.i.currency === "USD" ? fx() : 1));
    const noType = S.items.filter((i) => h.viewOf(i, D).open && units.includes(i.unit) && !i.typeCode).length;
    const body = shown.map(({ i, v, start }) => {
      const wr = h.canWrite(i.unit), d = h.draftOf(i), done = rows.filter((l) => l.itemId === i.id), over = num(d.amt) > start.left + 0.005, left = Math.max(0, v.left - num(d.amt)), cur = i.currency !== "ETB" ? ` <span class="tag">${esc(i.currency)}</span>` : "";
      const t = h.typeByCode(i.typeCode), bank = (() => { const banks = h.knownBanks(i.unit), cb = d.bank && !banks.includes(d.bank) ? [d.bank, ...banks] : banks; return banks.length || d.bank ? `<select class="cf-bank" data-dr="bank" data-id="${esc(i.id)}" aria-label="Bank">${cb.map((b) => `<option ${b === d.bank ? "selected" : ""}>${esc(b)}</option>`).join("")}</select>` : `<span class="small muted">no bank</span>`; })();
      return `<tr class="${num(d.amt) > 0 ? "cf-fill" : ""}${!v.open && !v.onDay ? " dim" : ""}"><td><span class="tag">${esc(i.code || "")}</span></td>
        <td><span class="cf-kd ${i.kind}" title="${i.kind === "in" ? "Collect" : "Pay"}">${i.kind === "in" ? "▲" : "▼"}</span> <b>${esc(i.party || i.description || "")}</b>${i.party && i.description ? `<span class="small muted"> · ${esc(i.description)}</span>` : ""}${cur}${many ? `<span class="small muted"> · ${esc(h.ushort(i.unit))}</span>` : ""}
          ${done.length ? `<div class="cf-pills">${done.map((l) => `<button type="button" class="cf-pill" data-cf="log-open" data-id="${esc(l.id)}" title="Recorded for this day. Click to edit">${i.kind === "in" ? "+" : "−"}${plain(l.amount)}${l.bank ? " · " + esc(l.bank) : ""}</button>`).join("")}</div>` : ""}</td>
        <td class="small" title="${esc(t ? (t.label && t.label !== t.code ? t.label + ". " : "") + (t.description || "") : "")}">${esc(i.typeCode || "–")}</td><td class="small" title="${esc(i.kind === "in" ? "1 within a month, 2 within two months, 3 long term" : "11 within a month, 22 within two months, 33 long term")}">${bucketCode(i.kind, i.bucket)}</td>
        <td class="num">${start.left > 0.005 ? plain(start.left) : '<span class="muted">–</span>'}</td>
        <td class="num">${wr && v.open ? `<input type="number" min="0" step="any" class="cf-amt${over ? " over" : ""}" data-dr="amt" data-id="${esc(i.id)}" data-start="${esc(String(start.left))}" data-left="${esc(String(v.left))}" value="${esc(String(d.amt))}" placeholder="${v.onDay ? "+" : "0"}" aria-label="Moved today">` : v.onDay ? `<b>${plain(v.onDay)}</b>` : '<span class="muted">–</span>'}</td>
        <td>${wr && v.open ? bank : ""}</td><td class="num"><b data-left-of="${esc(i.id)}">${v.open || left > 0.005 ? plain(left) : '<span class="muted">–</span>'}</b></td>
        <td class="cf-act">${wr ? h.menu([[`data-cf="rec" data-id="${esc(i.id)}"`, i.kind === "in" ? "Record collection with details" : "Record payment with details"], [`data-cf="item-open" data-id="${esc(i.id)}"`, "Edit line"], [`data-cf="w-trace" data-id="${esc(i.id)}"`, "Trace through the weeks"]]) : ""}</td></tr>`; }).join("");
    const opt = (val, l) => `<option value="${val}" ${f.status === val ? "selected" : ""}>${l}</option>`;
    const otherHtml = other.map((l) => `<tr class="clickable" data-cf="log-open" data-id="${esc(l.id)}" tabindex="0"><td class="small">${esc(h.ushort(l.unit))}</td><td class="small">${l.kind === "in" ? "In" : "Out"}</td><td>${esc(l.bank || "")}</td><td><b>${esc(l.party || l.description || "")}</b></td><td class="num">${plain(l.amount)}</td></tr>`).join("");
    return `<div class="cf-body"><div class="cf-bar">${h.allUnits().length > 1 ? h.unitSel(S.scope) : ""}
        <select data-cff="kind" aria-label="Collect or pay"><option value="">Collect and pay</option><option value="in" ${f.kind === "in" ? "selected" : ""}>Collect only</option><option value="out" ${f.kind === "out" ? "selected" : ""}>Pay only</option></select>
        <select data-cff="type" aria-label="Type"><option value="">All types</option><option value="__none" ${f.type === "__none" ? "selected" : ""}>No type (${noType})</option>${S.types.map((t) => `<option value="${esc(t.code)}" ${f.type === t.code ? "selected" : ""}>${esc(t.code)}</option>`).join("")}</select>
        <select data-cff="status" aria-label="Show">${opt("active", "Open or moved")}${opt("day", "Moved today")}${opt("open", "Open at the end")}${opt("settled", "Settled")}${opt("written_off", "Written off")}${opt("all", "All")}</select>
        <input type="search" data-cff="q" placeholder="Search" value="${esc(f.q)}" aria-label="Search" class="cf-s">
        <span class="cf-right">${w ? `<button class="btn primary small" data-cf="dr-save" id="cfDrSave" ${n ? "" : "disabled"}>${n ? `Save ${n} entr${n > 1 ? "ies" : "y"}` : "Save"}</button>` : ""}${h.menu([w ? ['data-cf="item-new"', "Add a line"] : null, w ? ['data-cf="log-new"', "Add cash with no line"] : null, w ? ['data-cf="d-tpl"', "Download daily template"] : null, w ? ['data-cf="d-pick"', "Upload filled template"] : null, ['data-cf="d-dl" data-v="coll"', "Download this view"]])}<input type="file" id="cfUploadDay" accept=".xlsx,.xls" hidden></span></div>
      <div class="cf-sum small muted"><b>${esc(dShort(D))}</b> · ${list.length} line${list.length === 1 ? "" : "s"} · to collect <b>${plain(sumK("in", (o) => o.v.left))}</b> · to pay <b>${plain(sumK("out", (o) => o.v.left))}</b> · collected today <b>${plain(sumK("in", (o) => o.v.onDay))}</b> · paid today <b>${plain(sumK("out", (o) => o.v.onDay))}</b></div>
      ${h.usdWarn()}
      <section class="cf-card flush">${shown.length ? `<div class="scroll"><table class="cf-table cf-sheet cf-coll"><thead><tr><th>Code</th><th>Party</th><th>Type</th><th title="1, 2, 3 for collections; 11, 22, 33 for payments">Cat</th><th title="Left at the end of the day before">Start</th><th title="Collected or paid today. Type the amount here.">Moved</th><th>Bank</th><th title="Start minus moved">Left</th><th></th></tr></thead><tbody>${body}</tbody></table></div>${list.length > shown.length ? `<div class="toolbar cf-pad"><button class="btn" data-cf="more">Show more</button></div>` : ""}` : `<div class="empty"><b>Nothing here</b>Change the filters or the day, or add a line.</div>`}</section>
      ${other.length ? `<details class="cf-card cf-fold" open><summary><b>Cash with no line</b> <span class="small muted">${other.length} today</span></summary><div class="scroll"><table class="cf-table"><tbody>${otherHtml}</tbody></table></div></details>` : ""}</div>`;
  }

  // ---------------- Bank ----------------
  function bankRows(units, D) {
    const eb = h.realBank(), rows = S.log.filter((l) => l.day === D && units.includes(l.unit)), out = [];
    for (const u of units) { const banks = [...new Set([...h.knownBanks(u), ...rows.filter((r) => r.unit === u && r.bank).map((r) => r.bank)])];
      for (const bk of banks) {
        const prev = eb.filter((b) => b.unit === u && b.bank === bk && b.day < D).sort((a, b) => b.day.localeCompare(a.day))[0], saved = S.bank.find((b) => b.unit === u && b.bank === bk && b.day === D);
        const mine = rows.filter((r) => r.unit === u && r.bank === bk), itIn = sum(mine.filter((r) => r.kind === "in"), (r) => num(r.amount)), itOut = sum(mine.filter((r) => r.kind === "out"), (r) => num(r.amount));
        const key = `${u}|${bk}|${D}`, d = S.bd[key] || {}, opening = prev ? num(prev.closing) : saved ? num(saved.opening) : num(d.open);
        const inn = d.in !== undefined ? d.in : saved ? num(saved.inflow) : "", outv = d.out !== undefined ? d.out : saved ? num(saved.outflow) : "";
        const nIn = h.sumExpr(inn) || 0, nOut = h.sumExpr(outv) || 0;
        out.push({ unit: u, bank: bk, key, opening, hasPrev: !!prev, inn, out: outv, nIn, nOut, close: Math.round((opening + nIn - nOut) * 100) / 100, saved, itIn, itOut });
      } }
    return out;
  }
  function renderBank() {
    const units = h.scopeUnits(), D = S.day, rows = bankRows(units, D), w = h.writableUnits().length > 0, many = units.length > 1;
    const tot = { open: sum(rows, (b) => b.opening), inn: sum(rows, (b) => b.nIn), out: sum(rows, (b) => b.nOut), close: sum(rows, (b) => b.close) };
    const trace = (v, rest) => (!(h.sumExpr(v) > 0) ? "" : `<div class="small ${rest < -0.5 ? "neg" : "muted"}">${rest < -0.5 ? plain(-rest) + " more itemized than the total" : rest > 0.5 ? plain(rest) + " not itemized" : "all itemized"}</div>`);
    const body = rows.map((b) => { const wr = h.canWrite(b.unit), restIn = b.nIn - b.itIn, restOut = b.nOut - b.itOut;
      return `<tr data-bkkey="${esc(b.key)}">${many ? `<td class="small">${esc(h.ushort(b.unit))}</td>` : ""}<td><b>${esc(b.bank)}</b></td>
        <td class="num">${b.hasPrev || b.saved ? plain(b.opening) : `<input type="number" step="any" class="cf-bk" data-bd="open" data-key="${esc(b.key)}" value="${esc(String(b.opening || ""))}" ${wr ? "" : "disabled"} aria-label="Opening" title="First time for this bank: type its opening balance">`}</td>
        <td class="num"><input type="text" inputmode="decimal" class="cf-bk" data-bd="in" data-key="${esc(b.key)}" value="${esc(String(b.inn))}" placeholder="0" ${wr ? "" : "disabled"} aria-label="In">${trace(b.inn, restIn)}</td>
        <td class="num"><input type="text" inputmode="decimal" class="cf-bk" data-bd="out" data-key="${esc(b.key)}" value="${esc(String(b.out))}" placeholder="0" ${wr ? "" : "disabled"} aria-label="Out">${trace(b.out, restOut)}</td>
        <td class="num strong" data-bd-close>${plain(b.close)}</td><td class="small cf-bkchk">${b.saved ? '<span class="ok">saved</span>' : '<span class="muted">not saved</span>'}</td></tr>`; }).join("");
    return `<div class="cf-body"><div class="cf-bar">${h.allUnits().length > 1 ? h.unitSel(S.scope) : ""}<span class="small muted">Closing is worked out: opening + in − out. To add several amounts type them with a plus, for example 500000+250000.</span>
        <span class="cf-right">${w ? `<button class="btn primary small" data-cf="bk-save" ${rows.length ? "" : "disabled"}>Save day</button>` : ""}${h.menu([w ? ['data-cf="bank-new"', "Add a bank account"] : null, w ? ['data-cf="d-tpl"', "Download daily template"] : null, w ? ['data-cf="d-pick"', "Upload filled template"] : null, ['data-cf="d-dl" data-v="bank"', "Download this view"]])}</span></div>
      <section class="cf-card flush">${rows.length ? `<div class="scroll"><table class="cf-table cf-bktable"><thead><tr>${many ? "<th>Unit</th>" : ""}<th>Bank</th><th>Opening</th><th>In</th><th>Out</th><th>Closing</th><th></th></tr></thead><tbody>${body}<tr class="tot">${many ? "<td></td>" : ""}<td><b>${many ? "Total" : "Total of the banks"}</b></td><td class="num">${plain(tot.open)}</td><td class="num" id="cfTotIn">${plain(tot.inn)}</td><td class="num" id="cfTotOut">${plain(tot.out)}</td><td class="num strong" id="cfTotClose">${plain(tot.close)}</td><td></td></tr></tbody></table></div>` : `<div class="empty"><b>No bank accounts yet</b>${w ? "Use the ⋯ menu to add the first bank account." : ""}</div>`}</section></div>`;
  }

  // ---------------- downloads of what is on screen ----------------
  async function download(kind) {
    if (!c.libsReady("xlsx")) return; const X = c.XLSX(), wb = X.utils.book_new(), units = h.scopeUnits(), D = S.day;
    if (kind === "coll") {
      const rows = [[`Collections and payments, ${dShort(D)}`], [], ["Code", "Unit", "Collect or pay", "Customer or payee", "Description", "Type", "Cat", "Currency", "Start of day", "Moved", "Left"]];
      dayLines(units, D).forEach(({ i, v, start }) => rows.push([i.code, h.uname(i.unit), i.kind === "in" ? "Collect" : "Pay", i.party, i.description, i.typeCode, bucketCode(i.kind, i.bucket), i.currency, Math.round(start.left), Math.round(v.onDay), Math.round(v.left)]));
      X.utils.book_append_sheet(wb, c.sheetFromRows(rows, [12, 26, 12, 30, 34, 14, 6, 9, 16, 16, 16]), "Collections and payments"); await c.writeXlsx(wb, `Collections and payments ${D}.xlsx`, "Excel saved"); return; }
    const rows = [[`Bank, ${dShort(D)}`], [], ["Unit", "Bank", "Opening", "In", "Out", "Closing"]], bs = bankRows(units, D); bs.forEach((b) => rows.push([h.uname(b.unit), b.bank, Math.round(b.opening), Math.round(b.nIn), Math.round(b.nOut), Math.round(b.close)]));
    rows.push(["Total", "", Math.round(sum(bs, (b) => b.opening)), Math.round(sum(bs, (b) => b.nIn)), Math.round(sum(bs, (b) => b.nOut)), Math.round(sum(bs, (b) => b.close))]);
    X.utils.book_append_sheet(wb, c.sheetFromRows(rows, [26, 28, 16, 16, 16, 16]), "Bank"); await c.writeXlsx(wb, `Bank ${D}.xlsx`, "Excel saved");
  }

  // ---------------- Excel template: the day ----------------
  const short = (u) => h.ushort(u).replace(/[\\/*?:[\]]/g, "");
  async function dayTemplate() {
    const units = h.scopeUnits().filter((u) => h.canWrite(u)); if (!units.length) { c.toast("You can only download the template for a unit you can edit"); return; } const D = S.day, types = S.types.filter((t) => t.active).map((t) => t.code);
    const banksAll = [...new Set(units.flatMap((u) => h.knownBanks(u)))];
    const wb = await XL.newBook(c, (col) => { col(1, ["Collect", "Pay"], "L_Kind"); col(2, types.length ? types : [""], "L_Type"); col(3, banksAll.length ? banksAll : [""], "L_Bank"); }); if (!wb) return;
    for (const u of units) {
      const nm = short(u), cs = wb.addWorksheet(`${nm} Colln`.slice(0, 31), { views: [{ state: "frozen", ySplit: 5 }] }), bs = wb.addWorksheet(`${nm} Bank`.slice(0, 31), { views: [{ showGridLines: false }] });
      const lines = dayLines([u], D).filter(({ i, v, start }) => i.status !== "written_off" && (start.left > 0.005 || v.onDay > 0));
      cs.getCell("A1").value = "Business unit"; cs.getCell("B1").value = h.uname(u); cs.getCell("A2").value = "Day"; cs.getCell("B2").value = XL.toDate(D); cs.getCell("B2").numFmt = "yyyy-mm-dd"; XL.bold(cs.getCell("A1")); XL.bold(cs.getCell("A2"));
      cs.getCell("D1").value = "Type what moved today in the Moved column and pick the bank. Left = Start − Moved. Lines that are not in the list: add a row at the bottom without a code."; cs.getCell("D1").font = { italic: true, color: { argb: "FF777777" } };
      XL.head(cs, 5, ["Code", "Collect or pay", "Customer or payee", "Description", "Type", "Cat", "Cur", "Start of day", "Moved today", "Bank", "Left"], [13, 12, 30, 34, 14, 7, 7, 16, 16, 24, 16]);
      const first = 6, last = first + lines.length + 40;
      cs.getCell("G3").value = "Total"; XL.bold(cs.getCell("G3")); [["H", 8], ["I", 9], ["K", 11]].forEach(([L]) => { cs.getCell(`${L}3`).value = { formula: `SUM(${L}${first}:${L}${last})` }; cs.getCell(`${L}3`).numFmt = "#,##0.00"; XL.bold(cs.getCell(`${L}3`)); });
      lines.forEach(({ i, v, start }, k) => { const r = first + k; [i.code, i.kind === "in" ? "Collect" : "Pay", i.party, i.description, i.typeCode, bucketCode(i.kind, i.bucket), i.currency, Math.round(start.left * 100) / 100, v.onDay > 0 ? Math.round(v.onDay * 100) / 100 : "", (S.log.filter((l) => l.itemId === i.id && l.day === D && l.bank)[0] || {}).bank || h.lastBank(i.unit, i.kind)].forEach((val, ci) => { cs.getCell(r, ci + 1).value = val; }); for (let ci = 1; ci <= 8; ci++) XL.fill(cs.getCell(r, ci), XL.GREY); });
      for (let r = first; r <= last; r++) { cs.getCell(r, 11).value = { formula: `IF(H${r}="","",H${r}-I${r})` }; cs.getCell(r, 11).numFmt = "#,##0.00"; XL.fill(cs.getCell(r, 11), XL.GREY); }
      XL.listV(cs, 2, first, last, "L_Kind", "Pick Collect or Pay."); XL.listV(cs, 5, first, last, "L_Type", "Pick a type from the list."); XL.listV(cs, 10, first, last, "L_Bank", "Pick a bank. Add new banks in the app."); XL.numV(cs, 9, first, last, 0);
      // bank sheet, as the bank sheet finance keeps: opening, in, out, closing worked out, with the total
      bs.getCell("A1").value = h.uname(u).toUpperCase(); bs.getCell("A2").value = "BANK, " + dShort(D); XL.bold(bs.getCell("A1")); XL.bold(bs.getCell("A2")); bs.getCell("F1").value = h.uname(u); bs.getCell("F2").value = XL.toDate(D); bs.getCell("F2").numFmt = "yyyy-mm-dd"; bs.getCell("F1").font = { color: { argb: "FFFFFFFF" } }; bs.getCell("F2").font = { color: { argb: "FFFFFFFF" } };
      XL.head(bs, 4, ["Bank", "Opening", "In", "Out", "Closing"], [34, 18, 18, 18, 18]);
      const bks = bankRows([u], D), n = Math.max(bks.length + 6, 12);
      for (let k = 0; k < n; k++) { const r = 5 + k, b = bks[k]; if (b) { bs.getCell(r, 1).value = b.bank; bs.getCell(r, 2).value = b.opening; bs.getCell(r, 3).value = b.nIn || ""; bs.getCell(r, 4).value = b.nOut || ""; if (b.hasPrev || b.saved) XL.fill(bs.getCell(r, 2), XL.GREY); }
        bs.getCell(r, 5).value = { formula: `IF(B${r}="","",B${r}+C${r}-D${r})` }; XL.fill(bs.getCell(r, 5), XL.GREY); [2, 3, 4, 5].forEach((ci) => { bs.getCell(r, ci).numFmt = "#,##0.00"; }); }
      const tr = 5 + n; bs.getCell(tr, 1).value = "WBG total"; XL.bold(bs.getCell(tr, 1)); ["B", "C", "D", "E"].forEach((L) => { bs.getCell(`${L}${tr}`).value = { formula: `SUM(${L}5:${L}${tr - 1})` }; bs.getCell(`${L}${tr}`).numFmt = "#,##0.00"; XL.bold(bs.getCell(`${L}${tr}`)); });
      XL.listV(bs, 1, 5, tr - 1, "L_Bank", "Pick a bank, or type a new one.", true); XL.numV(bs, 3, 5, tr - 1, null); XL.numV(bs, 4, 5, tr - 1, null);
    }
    XL.infoSheet(wb, "How to fill in the day", ["Each business unit has two sheets: Colln (collections and payments) and Bank. The day is in cell B2 of the Colln sheet.", "Colln: every line that is still open is listed with what was left at the start of the day. Type what moved today in Moved and pick the bank. Left is worked out: Start − Moved.",
      "Moved already shows what was recorded for the day. Type the new total for the day, not just the extra.", "Cash with no line: add a row at the bottom, leave the code empty, write who it is, pick Collect or Pay, the amount and the bank.", "Bank: write In and Out per bank from the bank report. Closing is worked out. Opening is yesterday's closing; type it only the first time for a bank.", "Upload the file on the Collections and payments page or the Bank page. Upload never deletes anything."]);
    await c.saveFile(`Daily ${D}.xlsx`, await wb.xlsx.writeBuffer(), "Excel saved");
  }

  // ---------------- upload: the day ----------------
  const unitMap = (units) => { const m = new Map(); units.forEach((u) => [h.uname(u), h.ushort(u), c.unitName(u), u].forEach((n) => m.set(XL.norm(n), u))); return m; };
  async function uploadDay(file) {
    const units = h.writableUnits(); if (!units.length) { c.toast("You cannot edit any unit's cash flow"); return; } const bk = await XL.readBook(c, file); if (!bk) return; const { X, wb } = bk;
    const uMap = unitMap(units), rep = { counts: {}, skip: 0, notes: [] }, bad = (sh, line, why) => { rep.skip++; rep.notes.push(`${sh} row ${line}: ${why}`); }; let nLog = 0, nBank = 0; const undo = [];
    const colln = XL.readSheets(X, wb, /colln$/i), banks = XL.readSheets(X, wb, /bank$/i); if (!colln.length && !banks.length) { c.toast("No “… Colln” or “… Bank” sheet found. Use the template from this page."); return; }
    await h.run(async () => {
      for (const sh of colln) {
        const unit = uMap.get(XL.norm(sh.rows[0] && sh.rows[0][1])), day = XL.serialToIso(sh.rows[1] && sh.rows[1][1]); if (!unit) { bad(sh.name, 1, `unit “${sh.rows[0] && sh.rows[0][1]}” not found or not yours`); continue; } if (!day) { bad(sh.name, 2, "the day (cell B2) is missing"); continue; }
        const known = h.knownBanks(unit), bankOf = (b) => { const t = XL.norm(b); return known.find((k) => XL.norm(k) === t) || String(b).trim(); }, touched = new Set();
        for (let i = 5; i < sh.rows.length; i++) { const r = sh.rows[i], line = i + 1; if (!r.some((x) => String(x).trim() !== "")) continue;
          const [code, kindN, party, desc, typeN, , cur, , movedV, bankN] = r, m = XL.money(movedV); if (m === null || m <= 0) continue;
          const it = String(code).trim() ? S.items.find((q) => q.unit === unit && q.code && q.code.toUpperCase() === String(code).trim().toUpperCase()) : null; if (String(code).trim() && !it) { bad(sh.name, line, `no line with code ${code}`); continue; }
          const bank = String(bankN).trim() ? bankOf(bankN) : h.lastBank(unit, it ? it.kind : /^p/i.test(String(kindN)) ? "out" : "in"); if (!bank) { bad(sh.name, line, "choose the bank"); continue; }
          if (it) { const have = sum(S.log.filter((l) => l.itemId === it.id && l.day === day), (l) => l.amount), diff = m - have; if (diff < -0.005) { rep.notes.push(`${sh.name} row ${line}: ${it.code} already has ${plain(have)} for this day, more than ${plain(m)}. Edit it in the app.`); continue; } if (diff <= 0.005) continue;
            const res = await c.api().saveCfLog(A(), { unit, day, kind: it.kind, bank, amount: Math.round(diff * 100) / 100, currency: it.currency, party: it.party, description: it.description, typeCode: it.typeCode, itemId: it.id, itemCode: it.code, note: "", fxRate: it.currency === "USD" ? fx() || "" : "" });
            if (res && res.error) return res; touched.add(it.id); nLog++; undo.push(async () => { const d = await c.api().deleteCf(A(), "cf_log", res.id); if (d && d.error) return d; return h.syncLine(it.id, 0, null, res.id); }); }
          else { const kind = /^c/i.test(String(kindN).trim()) ? "in" : /^p/i.test(String(kindN).trim()) ? "out" : ""; if (!kind) { bad(sh.name, line, "Collect or pay is empty"); continue; } if (!String(party).trim() && !String(desc).trim()) { bad(sh.name, line, "write who it is, or a description"); continue; }
            if (S.log.some((l) => l.unit === unit && l.day === day && !l.itemId && l.kind === kind && l.bank === bank && Math.abs(num(l.amount) - m) < 0.005 && XL.norm(l.party) === XL.norm(party))) continue;   // uploaded before
            const tc = S.types.find((t) => XL.norm(t.code) === XL.norm(typeN)), currency = ["ETB", "USD"].includes(String(cur).trim().toUpperCase()) ? String(cur).trim().toUpperCase() : "ETB";
            const res = await c.api().saveCfLog(A(), { unit, day, kind, bank, amount: m, currency, party: String(party).trim(), description: String(desc).trim(), typeCode: tc ? tc.code : "", itemId: "", itemCode: "", note: "", fxRate: currency === "USD" ? fx() || "" : "" }); if (res && res.error) return res; nLog++; undo.push(() => c.api().deleteCf(A(), "cf_log", res.id)); }
        }
        for (const id of touched) { const e = await h.syncLine(id, 0, day); if (e && e.error) return e; }
      }
      for (const sh of banks) {
        const unit = uMap.get(XL.norm(sh.rows[0] && sh.rows[0][5])), day = XL.serialToIso(sh.rows[1] && sh.rows[1][5]); if (!unit) { bad(sh.name, 1, "unit not found or not yours"); continue; } if (!day) { bad(sh.name, 2, "the day is missing"); continue; }
        const known = h.knownBanks(unit);
        for (let i = 4; i < sh.rows.length; i++) { const r = sh.rows[i], line = i + 1, name = String(r[0]).trim(); if (!name || /total/i.test(name)) continue; const inn = XL.money(r[2]), out = XL.money(r[3]); if (inn === null && out === null) continue;
          const bank = known.find((k) => XL.norm(k) === XL.norm(name)) || name, prev = h.realBank().filter((b) => b.unit === unit && b.bank === bank && b.day < day).sort((a, b) => b.day.localeCompare(a.day))[0], opening = prev ? num(prev.closing) : XL.money(r[1]);
          if (opening === null) { bad(sh.name, line, `${bank}: type the opening balance, this bank has no earlier balance`); continue; }
          const saved = S.bank.find((b) => b.unit === unit && b.bank === bank && b.day === day); if (saved && Math.abs(num(saved.inflow) - num(inn)) < 0.005 && Math.abs(num(saved.outflow) - num(out)) < 0.005) continue;
          const res = await c.api().saveCfBank(A(), { unit, day, bank, opening, inflow: num(inn), outflow: num(out), closing: Math.round((opening + num(inn) - num(out)) * 100) / 100 }); if (res && res.error) return res; nBank++; if (saved) { const sv = { unit, day, bank, opening: num(saved.opening), inflow: num(saved.inflow), outflow: num(saved.outflow), closing: num(saved.closing) }; undo.push(() => c.api().saveCfBank(A(), sv)); } }
      }
      return { ok: true };
    });
    rep.counts.a = nLog ? `Collections and payments: <b>${nLog}</b> movement${nLog > 1 ? "s" : ""} recorded.` : ""; rep.counts.b = nBank ? `Bank: <b>${nBank}</b> bank day${nBank > 1 ? "s" : ""} saved.` : "";
    const lines = Object.values(rep.counts).filter(Boolean); if (rep.skip) lines.push(`<b>${rep.skip}</b> row${rep.skip > 1 ? "s were" : " was"} not saved. Fix ${rep.skip > 1 ? "them" : "it"} in the file and upload again.`); if (!lines.length) lines.push("Nothing new to save. Everything in the file is already recorded.");
    if (undo.length) S.uu = { label: "The daily upload", steps: undo }; S.m = { type: "result", title: "Upload finished", lines, notes: rep.notes }; h.drawModal();
  }

  async function onAction(el) {
    const x = el.dataset.cf;
    if (x === "d-tpl") await dayTemplate(); else if (x === "d-pick") { const i = document.getElementById("cfUploadDay"); if (i) i.click(); } else if (x === "d-dl") await download(el.dataset.v);
  }
  return { renderColl, renderBank, onAction, uploadDay, dayTemplate, download, bankRows };
}
