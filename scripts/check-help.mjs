// Drift check for the in-app help (src/guides.js).
//   npm run check-help            -> prints problems, exits 1 on structural errors, 0 otherwise
//   npm run check-help -- --strict -> also exits 1 when a bold label in a guide is not found in the app
// It finds guide wording that no longer matches the app: a button or menu name that was renamed or removed, a page
// that has no guide, a link to a page that does not exist, an unknown {placeholder}.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { GUIDES, GROUPS, TAB_NAMES } = await import(pathToFileURL(join(root, "src/guides.js")).href);
const strict = process.argv.includes("--strict"), soft = process.argv.includes("--soft");

const read = (f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : "");
const SRC = ["index.html", "src/main.js", "src/extras.js", "src/gate.js", "src/dashboard.js", "src/ceoaction.js", "src/finalstatus.js", "src/access.js", "src/rules.js", "src/help.js", "src/data.js"].map(read).join("\n");
const norm = (s) => String(s).toLowerCase().replace(/&amp;/g, "&").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
const HAY = norm(SRC);
const allow = new Set(read("scripts/help-allow.txt").split("\n").map((x) => norm(x)).filter((x) => x && !x.startsWith("#")));

const html = read("index.html");
const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
const TABS = new Set([...tabs, "follow"]);
const errors = [], warns = [];
const PLACEHOLDERS = new Set(["grace", "fixed", "rename", "cutover", "statuses", "priorities", "columns", "templateRows", "evidence"]);
const FACTS = new Set(["ratings", "finals", "roles"]);
const groups = new Set(GROUPS.map((g) => g.id));
const seen = new Set();

for (const g of GUIDES) {
  const at = `[${g.id}]`;
  if (seen.has(g.id)) errors.push(`${at} duplicate id`); seen.add(g.id);
  if (!groups.has(g.g)) errors.push(`${at} unknown group "${g.g}"`);
  if (!g.title) errors.push(`${at} no title`);
  if (!(g.steps && g.steps.length) && !g.intro) errors.push(`${at} has neither steps nor intro`);
  (g.pages || []).forEach((p) => { if (p !== "*" && !TABS.has(p)) errors.push(`${at} pages: "${p}" is not a page of the app`); });
  (g.pin || []).forEach((p) => { if (!TABS.has(p)) errors.push(`${at} pin: "${p}" is not a page of the app`); });
  (g.go || []).forEach(([label, tab]) => { if (tab && !TABS.has(tab)) errors.push(`${at} go: "${label}" points to unknown page "${tab}"`); });
  const texts = [g.title, g.intro, ...(g.steps || []), ...(g.why || []), ...(g.fix || []).flat()];
  for (const t of texts) {
    if (t && typeof t === "object") { if (!FACTS.has(t.fact)) errors.push(`${at} unknown fact "${t.fact}"`); continue; }
    if (typeof t !== "string") continue;
    for (const m of t.matchAll(/\{([A-Za-z]+)\}/g)) if (!PLACEHOLDERS.has(m[1])) errors.push(`${at} unknown placeholder {${m[1]}}`);
    for (const m of t.matchAll(/\*\*(.+?)\*\*/g)) {
      const raw = m[1].trim(); if (raw.length > 70) continue;
      if (/[:.]$/.test(raw) || /^\d/.test(raw)) continue;   // a lead-in heading such as "**Shortcut:**", not a button name
      // "Plans → Next plan" or "⋯ menu → History": check each part; strip a trailing colon, dots, counts and punctuation
      for (let part of raw.split(/\s*(?:→| \/ | N )\s*/)) {
        part = norm(part).replace(/[.:;,!?…]+$/g, "").replace(/\s*[▾▲▼]+$/, "").replace(/^[^\p{L}\p{N}%]+/u, "").trim();
        if (!part || part.length < 3 || allow.has(part)) continue;
        if (/^\{/.test(part) || /^n /.test(part)) continue;
        if (!HAY.includes(part)) warns.push(`${at} "${raw}" is not found in the app text`);
      }
    }
  }
}
// every visible page should have at least one main guide
const PRIMARY = { plan: "plan", update: "upd", mplan: "mp", approvals: "appr", dashboard: "rep", tasks: "rep", monthly: "rep", ceo: "rep", support: "del", fb: "del", people: "adm", units: "adm", activity: "adm" };
for (const t of tabs) {
  if (!PRIMARY[t]) continue;
  const has = GUIDES.some((g) => (g.pages || []).includes(t) && (g.g === PRIMARY[t] || (g.pin || []).includes(t)));
  if (!has) warns.push(`page "${t}" (${TAB_NAMES[t] || t}) has no guide of its own`);
}
// the template columns listed in the template code must still be the ones the guides rely on (they are filled from code, so only a reminder)
const out = (arr, tag) => arr.forEach((x) => console.log(tag + " " + x));
out(errors, "ERROR"); out(warns, "check");
console.log(`\n${GUIDES.length} guides checked: ${errors.length} error(s), ${warns.length} wording item(s) to review.`);
if (warns.length) console.log("If a wording item is only emphasis (not a button or label), add the phrase to scripts/help-allow.txt.");
process.exit(errors.length || (strict && warns.length) ? (soft ? 0 : 1) : 0);
