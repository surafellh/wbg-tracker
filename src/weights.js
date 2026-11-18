// Weight points. Planning heads, chiefs and Group Strategy give each activity points from 1 up to the scale an admin sets (5, 10, up to 20).
// A task with no points counts as 1. The app converts the points of one unit's week to a share out of 100:  weight % = points / total points x 100,
// so nobody has to balance anything and adding a task simply recalculates the rest. The score of the week is each task's % achieved times its weight %.
// This is not the older "weight" field, which is the weight of a sub-task inside a deliverable.
export const SCALE_MAX = 20;
let SCALE = 10, WATCH = 7;
export const setWeightConfig = (scale, watchMin) => {
  const s = Math.round(Number(scale)); if (s >= 2 && s <= SCALE_MAX) SCALE = s;
  const w = Math.round(Number(watchMin)); if (w >= 1) WATCH = Math.min(w, SCALE);
  WATCH = Math.min(WATCH, SCALE);
};
export const weightScale = () => SCALE;
export const watchMin = () => WATCH;

// Points of a task: 1 when none were given; never above the scale.
export const ptsOf = (t) => { const p = Number(t && t.pts); return isFinite(p) && p >= 1 ? Math.min(p, SCALE) : 1; };
export const hasPts = (tasks) => (tasks || []).some((t) => t && t.pts !== undefined && t.pts !== null && t.pts !== "" && ptsOf(t) !== 1);

// Weight in % (out of 100) of each task, in the same order. Equal when no points were given.
export function weightsOf(tasks) {
  const l = tasks || [], tot = l.reduce((a, t) => a + ptsOf(t), 0);
  return l.map((t) => (tot ? (ptsOf(t) / tot) * 100 : 0));
}
// Weighted average of pctFn(task): the sum of weight % x % achieved, over 100. Rounded; null when there are no tasks.
export function wavg(tasks, pctFn) {
  const l = tasks || []; if (!l.length) return null;
  const w = weightsOf(l);
  return Math.round(l.reduce((a, t, i) => a + (w[i] / 100) * pctFn(t), 0));
}
