// Rule-based helpers for the strategy review: no AI. Suggests a pillar from keywords, merges repeated tasks, builds the review model.
import { PILLARS } from "./strategy.js";

export const SHORT = ["Capital growth", "Innovation & tech", "Operational excellence", "Customer & market", "Talent & leadership", "Partnerships", "Sustainable impact"];
// Keyword suggestions. A person always confirms; anything with no match stays "needs a pillar".
const KEYS = {
  P1: /capital|invest|loan|bank|financ|budget|fund|\bfx\b|foreign currency|cash|working capital|portfolio|business case|feasib|\bboq\b|bill of quantit|payment|tax|audit(?! manual)|revenue/i,
  P2: /innovat|digital|\berp\b|\bbpm\b|software|\bapp\b|\bai\b|technolog|\bit\b|data|dashboard|platform|research|product|prototype|pilot|system|website|smart/i,
  P3: /process|procedure|manual|polic|standard|\biso\b|\bokr|\bkpi|report|operation|corrective|supply|logistic|procure|maintenance|fleet|fuel|quality|governance|follow.?up|review|plan\b|customs|\blc\b|import|factory|contract/i,
  P4: /customer|market|\blead|sales|campaign|brand|tender|\bcrm\b|competitor|client|satisf|prospect|communication|export/i,
  P5: /recruit|hire|train|talent|leadership|successi|payroll|employee|staff|\bhr\b|learning|skill|capacity|onboard|cultur|engagement|insurance|leave|competence/i,
  P6: /partner|stakeholder|supplier|alliance|\bmou\b|chamber|ministry|ecosystem|vendor|consultan|agreement|engage/i,
  P7: /sustain|\besg\b|environment|\bcsr\b|climate|risk|complian|safety|\bosh\b|communit|impact|resilien|social|green|solar|energy/i,
};
export function suggestPillar(text) {
  const t = String(text || ""); let best = "", top = 0;
  PILLARS.forEach(p => { const m = t.match(new RegExp(KEYS[p.id].source, "gi")); const n = m ? m.length : 0; if (n > top) { top = n; best = p.id; } });
  return best;
}
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const pctOf = t => t.status === "Done" ? 100 : Math.max(0, Math.min(100, Number(t.pct) || 0));

// entries: every weekly entry of the month. One activity = same group name (stream), same reference, or same wording; the latest week wins.
export function autoItems(entries) {
  const sorted = [...entries].sort((a, b) => String(a.week).localeCompare(String(b.week)));
  const keyOf = t => t.stream ? "s:" + norm(t.stream) : "t:" + norm(t.title), groups = new Map(), refKey = new Map();
  sorted.forEach(t => {
    let k = keyOf(t); if (t.ref && refKey.has(t.ref) && !t.stream) k = refKey.get(t.ref);
    if (t.ref && !refKey.has(t.ref)) refKey.set(t.ref, k);
    if (!groups.has(k)) groups.set(k, new Map()); groups.get(k).set(norm(t.title), t);
  });
  return [...groups.entries()].map(([k, m], i) => {
    const ts = [...m.values()], lead = ts.find(t => t.goal) || ts[0], pct = Math.round(ts.reduce((a, t) => a + pctOf(t), 0) / ts.length);
    const name = ts.find(t => t.stream) ? ts.find(t => t.stream).stream : lead.title;
    const w = Math.max(0, ...ts.map(t => Number(t.spts) || 0));
    const sum = [...new Set(ts.map(t => String(t.sum || "").trim()).filter(Boolean))].join(" ");
    return { id: "a" + i, name: String(name).replace(/\s+/g, " ").trim(), pillar: /^P[1-7]$/.test(lead.goal || "") ? lead.goal : suggestPillar(ts.map(t => t.title).join(" ")), suggested: !/^P[1-7]$/.test(lead.goal || ""), w: w || 5, wSet: !!w, pct, done: ts.every(t => pctOf(t) >= 100), summary: sum, tasks: ts.map(t => ({ title: String(t.title).replace(/\s+/g, " ").trim(), pct: pctOf(t), done: pctOf(t) >= 100 })) };
  });
}

export const RAG_TXT = { green: "Green", amber: "Amber", red: "Red", none: "No activity", gap: "Gap" };
export const ragOf = (n, avg) => !n ? "none" : avg < 70 ? "red" : avg < 90 ? "amber" : "green";

// items + planned weights -> everything the page and the downloads show
export function reviewFromItems(items, planRaw) {
  const sum = Object.values(planRaw || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const plan = {}; PILLARS.forEach(p => { plan[p.id] = sum ? Math.round((Number((planRaw || {})[p.id]) || 0) / sum * 100) : 0; });
  const linked = items.filter(i => /^P[1-7]$/.test(i.pillar || "")), unassigned = items.filter(i => !/^P[1-7]$/.test(i.pillar || ""));
  const totalW = linked.reduce((a, i) => a + (Number(i.w) || 0), 0);
  const pillars = PILLARS.map((p, k) => {
    const its = linked.filter(i => i.pillar === p.id), w = its.reduce((a, i) => a + (Number(i.w) || 0), 0), avg = w ? Math.round(its.reduce((a, i) => a + (Number(i.w) || 0) * (Number(i.pct) || 0), 0) / w) : 0;
    const share = totalW ? Math.round(w / totalW * 100) : 0, planned = plan[p.id], done = its.filter(i => i.done).length, tasks = its.reduce((a, i) => a + (i.tasks || []).length, 0);
    const rag = ragOf(its.length, avg), under = planned >= 10 && share < planned / 2, over = planned > 0 && share > planned * 1.5;
    let text;
    if (!its.length) text = planned > 0 ? `Planned ${planned}% of effort, but no activity was linked to this pillar this month.` : "No activity linked this month and no allocation planned.";
    else text = `${its.length} ${its.length === 1 ? "activity" : "activities"}, ${done} done; ${share}% of the month's weighted effort${planned ? ` against ${planned}% planned` : ""}; average progress ${avg}%.${under ? " Below plan." : over ? " Above plan." : ""}`;
    return { ...p, short: SHORT[k], items: its, w, share, planned, avg, done, tasks, rag, under, over, gap: !its.length && planned > 0, text };
  });
  const allTasks = items.flatMap(i => i.tasks || []), perf = totalW ? Math.round(linked.reduce((a, i) => a + (Number(i.w) || 0) * (Number(i.pct) || 0), 0) / totalW) : 0;
  const match = sum ? pillars.reduce((a, p) => a + Math.min(p.share, p.planned), 0) : null;
  return { items, pillars, unassigned, plan, planSum: sum, tasks: allTasks.length, doneN: allTasks.filter(t => t.done).length, open: allTasks.filter(t => !t.done).length, activities: items.length, perf, touched: pillars.filter(p => p.items.length).length, plannedCount: pillars.filter(p => p.planned > 0).length, match, totalW };
}
