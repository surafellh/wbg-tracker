// Evidence viewer: PDF and images as they are; Excel as tables; Word as formatted text; PowerPoint as slide text; text files as text.
// Only .docx, .xlsx and .pptx are previewed (older .doc/.xls/.ppt are downloaded instead).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ext = (n) => (String(n).split(".").pop() || "").toLowerCase();
export const canPreview = (name) => ["pdf", "png", "jpg", "jpeg", "gif", "webp", "txt", "csv", "docx", "xlsx", "pptx"].includes(ext(name));

// Turns a file into { html } or { url, kind }. Throws if it cannot be shown.
export async function buildPreview(blob, name) {
  const e = ext(name);
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(e)) return { kind: "image", url: URL.createObjectURL(blob) };
  if (e === "pdf") return { kind: "pdf", url: URL.createObjectURL(new Blob([blob], { type: "application/pdf" })) };
  if (e === "txt" || e === "csv") { const txt = await blob.text(); return { kind: "html", html: `<pre class="pv-text">${esc(txt.slice(0, 200000))}</pre>` }; }
  if (e === "xlsx") {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(await blob.arrayBuffer(), { type: "array" });
    const sheets = wb.SheetNames.slice(0, 8).map((n) => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: "" }).slice(0, 300);
      const w = Math.min(40, Math.max(0, ...rows.map((r) => r.length)));
      const body = rows.map((r) => `<tr>${Array.from({ length: w }, (_, i) => `<td>${esc(r[i] ?? "")}</td>`).join("")}</tr>`).join("");
      return { n, html: `<div class="scroll"><table class="pv-table"><tbody>${body || '<tr><td class="muted">Empty sheet</td></tr>'}</tbody></table></div>` };
    });
    return { kind: "sheets", sheets };
  }
  if (e === "docx") {
    const mammoth = await import("mammoth");
    const r = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
    return { kind: "html", html: `<div class="pv-doc">${r.value || '<p class="muted">No text in this document.</p>'}</div>` };
  }
  if (e === "pptx") {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/(\d+)\.xml/)[1]) - Number(b.match(/(\d+)\.xml/)[1]));
    const slides = [];
    for (const n of names) {
      const xml = await zip.files[n].async("string");
      const paras = [...xml.matchAll(/<a:p[ >][\s\S]*?<\/a:p>/g)].map((m) => [...m[0].matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((x) => x[1]).join("")).filter(Boolean);
      slides.push(paras.map((p) => p.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")));
    }
    return { kind: "html", html: `<div class="pv-slides">${slides.map((p, i) => `<div class="pv-slide"><div class="small muted">Slide ${i + 1}</div>${p.map((x, k) => (k === 0 ? `<h3>${esc(x)}</h3>` : `<p>${esc(x)}</p>`)).join("") || '<p class="muted">No text on this slide.</p>'}</div>`).join("") || '<p class="muted">No slides found.</p>'}</div><p class="small muted">Slide text only. Download the file to see images and layout.</p>` };
  }
  throw new Error("no_preview");
}

// Show the viewer. getBlob() returns the file; onDownload() saves it.
export async function openViewer(root, { name, size, getBlob, onDownload }) {
  let urlToFree = "";
  const close = () => { if (urlToFree) URL.revokeObjectURL(urlToFree); root.innerHTML = ""; document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  const frame = (inner) => { root.innerHTML = `<div class="overlay" id="pvOverlay"><div class="modal pv-modal" role="dialog" aria-modal="true" aria-label="${esc(name)}">
      <div class="panel-head"><div><h2>${esc(name)}</h2>${size ? `<div class="small muted">${esc(size)}</div>` : ""}</div><div class="toolbar"><button class="btn" id="pvDl">Download</button><button class="icon-btn" id="pvClose" aria-label="Close">×</button></div></div>
      <div class="pv-body">${inner}</div></div></div>`;
    root.querySelector("#pvClose").onclick = close; root.querySelector("#pvDl").onclick = () => onDownload();
    root.querySelector("#pvOverlay").onclick = (e) => { if (e.target.id === "pvOverlay") close(); }; };
  frame('<div class="empty"><b>Opening…</b></div>');
  try {
    if (!canPreview(name)) { frame(`<div class="empty"><b>No preview for this file type</b>Use Download to open it. Preview works for PDF, images, .docx, .xlsx, .pptx and text files.</div>`); return; }
    const blob = await getBlob(), p = await buildPreview(blob, name);
    if (p.url) urlToFree = p.url;
    if (p.kind === "image") frame(`<img class="pv-img" src="${p.url}" alt="${esc(name)}">`);
    else if (p.kind === "pdf") frame(`<iframe class="pv-pdf" src="${p.url}" title="${esc(name)}"></iframe>`);
    else if (p.kind === "sheets") {
      frame(`<div class="pv-tabs">${p.sheets.map((s, i) => `<button class="btn small ${i ? "" : "primary"}" data-pvs="${i}">${esc(s.n)}</button>`).join("")}</div><div id="pvSheet">${p.sheets[0].html}</div>`);
      root.querySelectorAll("[data-pvs]").forEach((b) => { b.onclick = () => { root.querySelectorAll("[data-pvs]").forEach((x) => x.classList.remove("primary")); b.classList.add("primary"); root.querySelector("#pvSheet").innerHTML = p.sheets[Number(b.dataset.pvs)].html; }; });
    } else frame(p.html);
  } catch (x) { frame(`<div class="empty"><b>Could not preview this file</b>${esc(x.message === "no_preview" ? "Use Download to open it." : "The file may be damaged or password protected. Use Download to open it.")}</div>`); }
}
