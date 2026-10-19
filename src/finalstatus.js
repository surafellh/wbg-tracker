// Final status for the report page. The Progress update page keeps In progress / Done / Blocked.
// Once a week's update period is over (the Saturday cut-off after the week ends, 2:00 PM Addis time unless a super admin changes it) the report shows a final
// label based on the % reached instead. Closed tasks are shown as Cancelled and stay out of the score.
import { addisLockWeek } from "./rules.js";

export const FINAL_LABELS = ["Achieved", "Well performed", "Partially achieved", "Under performed", "Cancelled"];
export const FINAL_CLASS = { "Achieved": "s-done", "Well performed": "s-well", "Partially achieved": "s-not", "Under performed": "s-bad", "Cancelled": "s-closed" };
export const FINAL_COLOR = { "Achieved": "1D7F55", "Well performed": "7BAA2E", "Partially achieved": "E0A800", "Under performed": "B63A26", "Cancelled": "9A9684" };

// The week's update period is over: past weeks always, the latest week once the Saturday cut-off has passed.
export const weekClosed = (week, now = new Date()) => !!week && week < addisLockWeek(now);

export const pctOf = (t) => (t.status === "Done" ? 100 : typeof t.pct === "number" ? t.pct : 0);

// Lowest % that earns each label (checked from the top). The help guides read these, so change them here only.
export const FINAL_BANDS = [[100, "Achieved"], [75, "Well performed"], [40, "Partially achieved"], [0, "Under performed"]];
// The indicative "Week score" words on the Progress update page: [lowest %, word, colour class].
export const RATING_BANDS = [[95, "Outstanding", "s-done"], [90, "Very high", "s-done"], [80, "High", "s-done"], [75, "Satisfactory", "s-prog"], [50, "Needs improvement", "s-not"], [0, "Low", "s-bad"]];
export const ratingOf = (p) => { const b = RATING_BANDS.find((x) => p >= x[0]) || RATING_BANDS[RATING_BANDS.length - 1]; return [b[1], b[2]]; };

export function finalLabel(t) {
  if (t.status === "Closed") return "Cancelled";
  const p = pctOf(t);
  return (FINAL_BANDS.find((b) => p >= b[0]) || FINAL_BANDS[FINAL_BANDS.length - 1])[1];
}

// Counts per label and the average % (cancelled tasks are not counted in the average).
export function finalSummary(tasks) {
  const counts = Object.fromEntries(FINAL_LABELS.map((l) => [l, 0]));
  let sum = 0, n = 0;
  (tasks || []).forEach((t) => {
    const l = finalLabel(t); counts[l]++;
    if (l !== "Cancelled") { sum += pctOf(t); n++; }
  });
  return { counts, total: (tasks || []).length, counted: n, avg: n ? Math.round(sum / n) : null };
}
