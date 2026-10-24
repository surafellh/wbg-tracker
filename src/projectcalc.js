// Project progress rules (pure functions, no screen code).
// A project is either "phases" (progress comes from its phases and their activities) or "manual" (a cumulative physical % reported each month).

export const TYPES = ["Business", "Capital (physical)", "Strategic", "Digital", "Other"];
export const STATUSES = ["Not started", "In progress", "On hold", "Completed", "Cancelled"];
export const RAGS = ["Green", "Amber", "Red"];
export const ACT_STATUSES = ["Not started", "In progress", "Done", "Blocked"];
export const isCapital = (p) => /capital|physical/i.test(p.type || "");

const num = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const clamp = (n) => Math.max(0, Math.min(100, n));
const wt = (x) => { const w = num(x && x.weight); return w !== null && w > 0 ? w : 1; };
const wavg = (items, val) => {
  let sw = 0, s = 0;
  for (const it of items) { const v = val(it); if (v === null) continue; const w = wt(it); sw += w; s += v * w; }
  return sw ? s / sw : null;
};

// The latest monthly update (periods are "YYYY-MM").
export const latestUpdate = (p) => [...(p.updates || [])].sort((a, b) => String(a.period).localeCompare(String(b.period))).pop() || null;
export const sortedUpdates = (p) => [...(p.updates || [])].sort((a, b) => String(b.period).localeCompare(String(a.period)));

// What a linked weekly task looks like now. `resolve(link)` returns { pct, status } or null (when the task cannot be read); the saved copy on the activity is the fallback.
export function activityState(a, resolve) {
  if (a.link && a.link.ref) {
    const live = resolve ? resolve(a.link) : null;
    const src = live || (a.cache ? { pct: a.cache.pct, status: a.cache.status } : null);
    if (src) { const done = src.status === "Done" || src.status === "Closed"; return { pct: done ? 100 : clamp(num(src.pct) ?? 0), status: src.status || "", linked: true, live: !!live }; }
    return { pct: 0, status: "", linked: true, live: false };
  }
  const done = a.status === "Done";
  return { pct: done ? 100 : clamp(num(a.pct) ?? 0), status: a.status || "Not started", linked: false, live: false };
}
export const activityPct = (a, resolve) => activityState(a, resolve).pct;

export function phasePct(ph, resolve) {
  const acts = ph.activities || [];
  if (!acts.length) return num(ph.pct) === null ? null : clamp(num(ph.pct));
  const v = wavg(acts, (a) => activityPct(a, resolve));
  return v === null ? null : v;
}

// Overall progress, 0 to 100 (whole number), or null when nothing has been reported yet.
export function projectProgress(p, resolve) {
  if (p.status === "Completed") return 100;
  const lu = latestUpdate(p);
  if (p.mode !== "manual") {
    const phases = p.phases || [];
    if (phases.some((ph) => (ph.activities || []).length || num(ph.pct) !== null)) {
      const v = wavg(phases, (ph) => phasePct(ph, resolve));
      if (v !== null) return Math.round(v);
    }
  }
  const x = lu ? num(lu.physical) : null;
  return x === null ? null : Math.round(clamp(x));
}

export function progressSource(p) {
  if (p.status === "Completed") return "Completed";
  if (p.mode !== "manual" && (p.phases || []).some((ph) => (ph.activities || []).length || num(ph.pct) !== null)) return "From phases and activities";
  return latestUpdate(p) ? "Latest monthly report" : "Not reported yet";
}

const dayMs = 864e5;
const d0 = (s) => (s ? Date.parse(String(s).slice(0, 10) + "T00:00:00Z") : NaN);
// Share of the planned period that has passed (can go above 100 when the end date is missed).
export function timeElapsed(p, today) {
  const a = d0(p.start), b = d0(p.end), t = d0(today);
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(t) || b <= a) { const lu = latestUpdate(p); return lu && num(lu.timePct) !== null ? Math.round(num(lu.timePct)) : null; }
  if (t <= a) return 0;
  return Math.round(((t - a) / (b - a)) * 100);
}

// A suggestion only; the person reporting chooses the status colour.
export function suggestRag(progress, elapsed, status) {
  if (status === "Completed") return "Green";
  if (progress === null || elapsed === null) return null;
  const gap = Math.min(elapsed, 100) - progress;
  return gap <= 10 ? "Green" : gap <= 25 ? "Amber" : "Red";
}

export const currentPeriod = (today) => String(today).slice(0, 7);
export const monthChange = (p, period) => {
  const ups = sortedUpdates(p), i = ups.findIndex((u) => u.period === period);
  if (i < 0) return null;
  const cur = num(ups[i].physical), prev = ups[i + 1] ? num(ups[i + 1].physical) : null;
  return cur === null || prev === null ? null : Math.round((cur - prev) * 10) / 10;
};
// Months since the last monthly update (0 = this month); null when there has never been one.
export function monthsSinceUpdate(p, today) {
  const lu = latestUpdate(p); if (!lu) return null;
  const [y, m] = String(lu.period).split("-").map(Number), [ty, tm] = currentPeriod(today).split("-").map(Number);
  return (ty - y) * 12 + (tm - m);
}
export const needsUpdate = (p, today) => !["Completed", "Cancelled", "On hold"].includes(p.status) && (monthsSinceUpdate(p, today) === null || monthsSinceUpdate(p, today) >= 1);

export const pendingDecisions = (p) => (p.decisions || []).filter((d) => !["Decided", "Closed", "Done"].includes(d.status));
export const openRisks = (p) => (p.risks || []).filter((r) => !["Closed", "Resolved"].includes(r.status));

// Latest state of each weekly task, by reference, from plans of several weeks: { "REF": { title, status, pct, week } }
export function latestTasks(planDocs) {
  const out = {};
  for (const pl of planDocs) for (const t of pl.tasks || []) {
    if (!t.ref || t.kind === "KPI / OKR") continue;
    const cur = out[t.ref];
    if (!cur || String(pl.week) >= String(cur.week)) out[t.ref] = { ref: t.ref, title: t.title || "", status: t.status || "", pct: typeof t.pct === "number" ? t.pct : (t.status === "Done" ? 100 : 0), week: pl.week, dept: t.dept || "", owner: t.owner || "", due: t.due || "" };
  }
  return out;
}

// Days left to the contract end (negative = overdue). Null when there is no contract end date or the project is finished.
export function daysToEnd(p, today) {
  if (["Completed", "Cancelled"].includes(p.status)) return null;
  const b = d0(p.end), t = d0(today);
  return Number.isNaN(b) || Number.isNaN(t) ? null : Math.round((b - t) / dayMs);
}

// Days of the contract used: { used, total }. Both are whole days; used can pass total when the end date is missed.
// Null when the project has no start and end date. A finished project stops counting at its actual end.
export function daysUsed(p, today) {
  const a = d0(p.start), b = d0(p.end); let t = d0(today);
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(t) || b <= a) return null;
  const fin = d0(p.actualEnd); if (p.status === "Completed" && !Number.isNaN(fin)) t = fin;
  return { used: Math.max(0, Math.round((t - a) / dayMs)), total: Math.round((b - a) / dayMs) };
}
