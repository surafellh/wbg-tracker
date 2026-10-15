// "Action for the CEO": what the CEO should do about a unit, from its progress and the Performance Evaluation Manual
// (rating scale 7.3.4, corrective actions 7.10, RACI notes). Pure functions, no screen code.
import { calcPct } from "./rules.js";

export const BANDS = [
  { id: "outstanding", label: "Outstanding", min: 95 }, { id: "veryhigh", label: "Very High", min: 90 }, { id: "high", label: "High", min: 80 },
  { id: "satisfactory", label: "Satisfactory", min: 75 }, { id: "needs", label: "Needs Improvement", min: 50 }, { id: "low", label: "Low", min: 0 },
];
export const bandOf = (pct) => BANDS.find((b) => pct >= b.min) || BANDS[BANDS.length - 1];

const pctOf = (t) => (t.status === "Done" ? 100 : typeof t.pct === "number" ? t.pct : 0);
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// tasks: leaf tasks of the selection. type: "Business unit" | "Corporate function". today: ISO date.
export function assess({ name, type, tasks, today }) {
  const t = tasks.filter((x) => x.kind !== "KPI / OKR");
  if (!t.length) return null;
  const isBU = type !== "Corporate function";
  const fin = t.filter((x) => x.category === "Revenue"), ops = t.filter((x) => x.category !== "Revenue");
  const finPct = avg(fin.map((x) => { const c = calcPct(x); return c == null ? pctOf(x) : c; })), opsPct = avg(ops.map(pctOf));
  const overall = avg(t.map(pctOf));
  // Business units are judged mainly on financial performance (50% of the scorecard); functions on delivery to business units.
  const score = isBU ? (finPct != null && opsPct != null ? Math.round((finPct + opsPct) / 2) : finPct != null ? finPct : opsPct) : overall;
  const band = bandOf(score);
  const blocked = t.filter((x) => x.status === "Blocked"), overdue = t.filter((x) => x.due && x.due < today && x.status !== "Done");
  const highOpen = t.filter((x) => x.priority === "High" && x.status !== "Done");
  const short = (x) => (x.ref ? x.ref + " " : "") + (x.title || "(no title)"), top = (arr, f) => arr.slice(0, 6).map(f);
  return { blockedList: top(blocked, short), overdueList: top(overdue, (x) => short(x) + (x.due ? " (due " + x.due + ")" : "")), name, isBU, score, band, overall, finPct, finN: fin.length, opsPct, blocked: blocked.length, overdue: overdue.length, highOpen: highOpen.length, total: t.length };
}

// An action is { k, text }. k says what the system can do for it: a letter (ack, recognise, stretch, closegaps, nextsteps, catchup,
// meeting, explain, notice, revplan, blockers, overdue, bufunction), or an internal follow-up (rootcause, supportcheck), or nothing (none).
// period: "week" (a check-in, light touch) or "month" (firmer). Leadership changes are quarterly decisions and are not proposed here.
export function actions(a, period) {
  const n = a.name, out = [], head = a.isBU ? "the unit head" : "the function head", wk = period !== "month";
  const add = (k, text) => out.push({ k, text });
  const fin = a.isBU && a.finPct != null && a.finPct < 75 ? `Revenue and profit stand at ${a.finPct}% of target.` : "";
  switch (a.band.id) {
    case "outstanding": case "veryhigh":
      if (wk) add("ack", `Acknowledge ${n}'s week to ${head}.`);
      else { add("recognise", `Recognise ${n} formally under the Incentive System and have ${head} present what is working to the Management Committee.`);
        add("stretch", a.isBU ? `Raise ${n}'s next revenue and profit targets and assign it a stretch growth mandate.` : `Hold ${n} up as the standard for on-time delivery and response to business units, and extend its practice to other functions.`); }
      break;
    case "high":
      add("none", wk ? `No intervention needed.` : `Keep ${n} on its current plan.`);
      add("closegaps", wk ? `Ask ${head} to close the ${plural(a.highOpen, "open high-priority item")}.` : `Instruct ${head} to close the remaining gaps (${plural(a.highOpen, "high-priority item")} still open) before the next review.`);
      break;
    case "satisfactory":
      add("nextsteps", wk ? `Ask ${head} which tasks will be closed next week, and by whom.` : `Instruct ${head} to name the tasks that will lift ${n} above 80% and fix the date of the next review in writing.`);
      if (fin) add("revplan", wk ? fin + ` Ask how the gap will be closed.` : fin + ` Require a revenue catch-up plan.`);
      break;
    case "needs":
      if (wk) add("catchup", `Call ${head} this week and ask for a catch-up plan with dates for the open tasks.`);
      else { add("meeting", `Hold a performance meeting with ${head}. Agree an improvement plan and the next review date in writing at the same meeting.`); add("rootcause", `Have the root causes identified and recorded before the plan is signed.`); }
      if (fin) add("revplan", wk ? fin + ` Ask for the plan to close it.` : fin + ` Order a revenue recovery plan with weekly figures.`);
      else if (!a.isBU && !wk) add("bufunction", `Require ${n} to show the support it delivered to business units this period and what it will deliver on time from now.`);
      break;
    default:
      if (wk) { add("explain", `Meet ${head} this week. Ask for the reasons and a recovery plan for next week.`); if (fin) add("revplan", fin + ` Ask for the plan to close it.`); }
      else {
        add("notice", `Issue a written notice to ${head} with the improvement plan required, and record it in the Performance Portal.`);
        add("supportcheck", `Confirm that the support promised (resources, budget, staffing, systems) has actually been provided, and that root causes are identified.`);
        if (fin) add("revplan", fin + ` Order a revenue recovery plan with weekly figures.`);
      }
  }
  if (a.blocked) add("blockers", wk ? `Ask who clears the ${plural(a.blocked, "blocked task")}.` : `Remove the blockers: ${plural(a.blocked, "task")} blocked. Decide who clears each one.`);
  if (a.overdue >= 3 || (a.total && a.overdue / a.total >= 0.2)) add("overdue", wk ? `${plural(a.overdue, "task")} past due. Ask ${head} to re-date or close them.` : `${plural(a.overdue, "task")} past due. Require ${head} to re-date or close them and report the reasons.`);
  return out;
}

export const INTERNAL = ["rootcause", "supportcheck"];
const fmtD = (iso) => { const d = new Date(iso + "T00:00:00Z"); return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }); };
export const addDaysIso = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export { fmtD };

// The drafted letter for one action. ctx = { sender, senderTitle, perLabel, period, today }. Returns { subject, body, needsReply, due }.
export function letter(act, a, ctx) {
  const wk = ctx.period !== "month", head = a.isBU ? "Unit Head" : "Function Head", due = addDaysIso(ctx.today, wk ? 3 : 7);
  const DUE = "{DUE}", list = (arr) => arr.map((x) => "  - " + x).join("\n"), score = `${a.band.label} (${a.score}%)`;
  const fin = a.isBU && a.finPct != null ? ` Revenue and profit stand at ${a.finPct}% of target.` : "";
  const open = `Dear Head of ${a.name},\n\n`, close = `\n\nRegards,\n${ctx.sender}\n${ctx.senderTitle}`;
  const reply = `Please reply in writing by ${DUE}.`;
  const L = {
    ack: { subject: `Acknowledgement: ${a.name}, ${ctx.perLabel}`, body: `${open}I have reviewed the progress of ${a.name} for ${ctx.perLabel}. It is rated ${score}. Thank you and your team for the work.\n\nPlease keep up the pace, and tell me early if anything is getting in the way.${close}` },
    recognise: { subject: `Recognition: ${a.name}, ${ctx.perLabel}`, body: `${open}${a.name} is rated ${score} for ${ctx.perLabel}. On behalf of Wagwago Business Group I formally recognise the team's results.\n\nI ask you to present what is working to the Management Committee at its next meeting. This recognition will be recorded under the Incentive System.${close}` },
    stretch: { needsReply: true, subject: `Stretch targets for ${a.name}`, body: a.isBU
      ? `${open}Given the ${score} result for ${ctx.perLabel}, the next revenue and profit targets for ${a.name} will be raised and the unit will carry a stretch growth mandate.\n\nPlease send me your proposed stretch plan and the resources you need. ${reply}${close}`
      : `${open}Given the ${score} result for ${ctx.perLabel}, I ask ${a.name} to document how it delivers on time and responds to business units, so that other functions can adopt the practice.\n\nPlease send me a short note of the practice. ${reply}${close}` },
    closegaps: { needsReply: !wk, subject: `Open high-priority items: ${a.name}`, body: `${open}${a.name} is rated ${score} for ${ctx.perLabel}. ${plural0(a.highOpen, "high-priority item")} ${a.highOpen === 1 ? "is" : "are"} still open.\n\nPlease close ${a.highOpen === 1 ? "it" : "them"} before the next review.${wk ? "" : " Confirm in writing when done. " + reply}${close}` },
    nextsteps: { needsReply: true, subject: `Next steps: ${a.name}`, body: `${open}${a.name} is rated ${score} for ${ctx.perLabel}.\n\nPlease tell me which tasks will be closed ${wk ? "next week" : "to lift the unit above 80%"}, who owns each, and the date of the next review. ${reply}${close}` },
    catchup: { needsReply: true, subject: `Catch-up plan: ${a.name}`, body: `${open}${a.name} is rated ${score} for ${ctx.perLabel}.${fin}\n\nPlease send me a catch-up plan with dates for the open tasks. ${reply}${close}` },
    meeting: { subject: `Performance meeting: ${a.name}`, body: `${open}${a.name} is rated ${score} for ${ctx.perLabel}.${fin}\n\nI am calling a performance meeting with you. Please come with:\n  - the root causes of the gap\n  - an improvement plan with owners and dates\n  - the date of the next review\n\nThe plan and the next review date will be agreed in writing at the meeting. Please confirm a time this week.${close}` },
    explain: { needsReply: true, subject: `Request for a written explanation: ${a.name}`, body: `${open}${a.name} is rated ${score} for ${ctx.perLabel}.${fin}\n\nI request a written explanation of:\n  - why the planned work is not done\n  - which tasks are furthest behind\n  - what you will do to recover next week\n\n${reply}${close}` },
    notice: { needsReply: true, subject: `Written notice: low performance, ${a.name}`, body: `${open}This is a written notice. ${a.name} is rated ${score} for ${ctx.perLabel}, which is in the Low band of the Performance Evaluation Manual.${fin}\n\nUnder the Manual's corrective action procedure you are required to submit an improvement plan. Management will confirm that the support promised has been provided, and the root causes will be recorded.\n\n${reply}${close}` },
    revplan: { needsReply: true, subject: `Revenue recovery plan: ${a.name}`, body: `${open}${a.name} is rated ${score} for ${ctx.perLabel}.${fin}\n\nPlease send me a revenue recovery plan with ${wk ? "the steps and dates to close the gap" : "weekly figures"}. ${reply}${close}` },
    blockers: { needsReply: true, subject: `Blocked tasks: ${a.name}`, body: `${open}These tasks are blocked in ${ctx.perLabel}:\n${list(a.blockedList)}\n\nPlease tell me who will clear each one and by when. ${reply}${close}` },
    overdue: { needsReply: true, subject: `Overdue tasks: ${a.name}`, body: `${open}${plural0(a.overdue, "task")} ${a.overdue === 1 ? "is" : "are"} past due in ${ctx.perLabel}${a.overdueList.length < a.overdue ? " (the first " + a.overdueList.length + " are listed)" : ""}:\n${list(a.overdueList)}\n\nPlease re-date or close each one and give the reason. ${reply}${close}` },
    bufunction: { needsReply: true, subject: `Support to business units: ${a.name}`, body: `${open}${a.name} is rated ${score} for ${ctx.perLabel}.\n\nPlease show the support you delivered to business units this period, and what you will deliver on time from now. ${reply}${close}` },
  };
  const l = L[act.k]; if (!l) return null;
  return { subject: l.subject, body: l.body.split(DUE).join(fmtD(due)), needsReply: !!l.needsReply, due };
}
const plural0 = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
