// Group strategy catalogue: 7 pillars and their strategic goals (Wagwago Business Group Strategic Plan 2025/26-2030).
// Wagwago Electric (WWE) goals are excluded on purpose. Units are switched on in blocks.
export const PILLARS = [
  { id: "P1", no: "I", name: "Capital Growth & Investment Enablement", goals: [
    ["P1-G1", "Mobilize capital for investment"], ["P1-G2", "Optimize capital allocation for value creation"]] },
  { id: "P2", no: "II", name: "Innovation & Technology Leadership", goals: [
    ["P2-G1", "Strengthen research & product innovation capability"], ["P2-G2", "Drive digital transformation to improve cost, speed & scalability"],
    ["P2-G3", "Achieve digital product leadership & platform expansion"], ["P2-G4", "Institutionalize a continuous innovation culture"]] },
  { id: "P3", no: "III", name: "Operational Excellence", goals: [
    ["P3-G1", "Standardize processes & reduce the operating cost base"], ["P3-G2", "Improve efficiency, quality & throughput across all operations"],
    ["P3-G3", "Strengthen quality excellence & standardization"]] },
  { id: "P4", no: "IV", name: "Customer Empowerment & Market Leadership", goals: [
    ["P4-G1", "Deliver superior customer experience & reliability"], ["P4-G2", "Expand customer access, inclusion & affordability"],
    ["P4-G3", "Strengthen customer-centric product innovation & customization"], ["P4-G4", "Build customer trust, transparency & community impact"]] },
  { id: "P5", no: "V", name: "Talent, Leadership & Organizational Capability", goals: [
    ["P5-G1", "Build a high-performing workforce for digital, technical & operational growth"], ["P5-G2", "Build leadership strength, accountability & change capability"],
    ["P5-G3", "Build a continuous learning & innovation mindset"]] },
  { id: "P6", no: "VI", name: "Strategic Partnerships & Ecosystem Development", goals: [
    ["P6-G1", "Establish high-value partnerships for growth, innovation & market access"], ["P6-G2", "Build partnership defense capacity against foreign entrants"],
    ["P6-G3", "Build a unified Wagwago ecosystem"], ["P6-G4", "Build trust, governance & win-win structures"]] },
  { id: "P7", no: "VII", name: "Sustainable Growth & Impact", goals: [
    ["P7-G1", "Drive long-term profitable growth with environmental, social & economic impact"], ["P7-G2", "Strengthen social & community value creation"],
    ["P7-G3", "Build global impact credentials (ESG, SDG alignment)"], ["P7-G4", "Ensure climate & resource resilience across the growth portfolio"]] },
];
export const GOALS = PILLARS.flatMap(p => p.goals.map(([id, name]) => ({ id, name, pillar: p.id })));
export const goalName = id => (anyGoal(id) || {}).name || "";
export const pillarName = id => { const p = PILLARS.find(x => x.id === id); return p ? `${p.no} \u00b7 ${p.name}` : ""; };
export const pillarOf = id => { if (/^P[1-7]$/.test(id || "")) return id; const g = anyGoal(id); return g ? g.pillar : ""; };
// Units that link activities to the strategy. Block 1: the Group Strategy Office. Later blocks add all functions, then business units.
export const STRATEGY_UNITS = ["group-strategy-office", "cto", "hrm", "group-ia-ba", "corporate-marketing", "pmo", "csco"];
export const strategyOn = u => STRATEGY_UNITS.includes(u);

// Group Strategy Office (CSO) objectives per pillar, from "Strategy Alignment to the Seven Pillars". The CSO links its activities to these.
export const CSO_OBJ = [
  ["O1.1", "P1", "Allocate capital to the highest-return strategic priorities"], ["O1.2", "P1", "Build a growth pipeline that lifts portfolio returns"],
  ["O2.1", "P2", "Build a disciplined innovation and technology pipeline aligned to strategy"], ["O2.2", "P2", "Anticipate disruption and convert it into revenue"],
  ["O3.1", "P3", "Make strategy executable through OKRs, one cadence and clear reporting"], ["O3.2", "P3", "Standardise and automate core processes with BPM and ERP"],
  ["O3.3", "P3", "Detect off-track pillars early and recover them through one corrective action system"],
  ["O4.1", "P4", "Win in priority segments through market insight and clear positioning"], ["O4.2", "P4", "Expand into East African markets while deepening local leadership"],
  ["O5.1", "P5", "Build a high-calibre CSO team and leadership bench"], ["O5.2", "P5", "Align organisation design and capability with strategic priorities"],
  ["O6.1", "P6", "Build a managed ecosystem of strategic partners and acquisition targets"], ["O6.2", "P6", "Govern partnerships for measurable value"],
  ["O7.1", "P7", "Embed sustainability and impact into strategy and investment decisions"], ["O7.2", "P7", "Track and report impact transparently"],
].map(([id, pillar, name]) => ({ id, pillar, name }));
// the goals a unit can link to: the CSO's own objectives for the Group Strategy Office, the Group goals for the others
export const goalsFor = u => GOALS;
export const anyGoal = id => CSO_OBJ.find(g => g.id === id) || GOALS.find(g => g.id === id);

// What each CSO objective is about: the key results from the alignment document, and the CSO goal of each pillar.
export const CSO_GOAL = {
  P1: "Ensure capital is deployed to the strategic priorities that create the greatest long-term value.",
  P2: "Build a structured pipeline of innovation and technology bets that renew the core and open new growth.",
  P3: "Make strategy executable through owned initiatives, clear metrics, standardised processes and a disciplined review rhythm, enabled by BPM and ERP.",
  P4: "Direct the organisation toward the markets, segments and propositions where it can win and lead.",
  P5: "Build the leadership, skills and organisational design needed to deliver the strategy, starting inside the CSO.",
  P6: "Build a managed ecosystem of partners, alliances and acquisition targets that accelerate the strategy.",
  P7: "Make sustainability and long-term impact a built-in lens for strategy, investment and performance.",
};
export const CSO_KR = {
  "O1.1": ["At least 90% of discretionary capital reviewed through the strategic portfolio process by year-end.", "100% of investments above the threshold have a business case and a 12-month post-investment review."],
  "O1.2": ["Pipeline of growth opportunities approved and prioritised each half-year.", "Portfolio return (ROIC / IRR) improves against baseline."],
  "O2.1": ["Innovation and technology thesis approved with 3-5 priority themes within the first quarter.", "At least 3 innovation bets reach pilot, and 1 reaches scale, within 18 months."],
  "O2.2": ["Share of revenue from products or services launched in the last three years.", "Quarterly horizon-scanning report delivered to the executive team (4 per year)."],
  "O3.1": ["100% of pillars and business units have approved OKRs by the end of the planning cycle.", "At least 85% of strategic initiatives on time and on budget; red initiatives have recovery plans within 30 days.", "Strategy dashboard live monthly with at least 95% data completeness, and quarterly reviews held for all 7 pillars."],
  "O3.2": ["100% of core end-to-end processes mapped with a named owner within 6 months, and priority processes redesigned to one standard.", "Priority processes run on ERP with automated workflows, cutting cycle time and cost per transaction."],
  "O3.3": ["RAG status reported for 100% of pillar KRs every month, using one rule set.", "100% of Amber items have an action plan within 14 days and Red items a recovery plan within 30 days; at least 80% of Reds return to Amber or Green."],
  "O4.1": ["Annual market and competitor assessment delivered, with priority segments agreed by the executive team.", "Market share in priority segments and NPS up against baseline."],
  "O4.2": ["Local market revenue growth within 12 months.", "East Africa: entry business case approved for priority countries within 6 months, first market live within 12 months.", "East Africa: revenue target and break-even in the first market within 24 months."],
  "O5.1": ["CSO critical roles filled and development plans in place for 100% of the team.", "100% of senior leaders complete strategy / OKR training, and at least 80% rate it useful."],
  "O5.2": ["Capability gaps assessed and a workforce plan agreed with HR for each pillar.", "High-potential leaders rotated into the CSO each year."],
  "O6.1": ["Partnership strategy and selection criteria approved within the first six months.", "5 priority partnerships signed and 2 delivering measurable value within 18 months; M&A / alliance target list refreshed quarterly."],
  "O6.2": ["Partnership scorecard in place for 100% of strategic partners, reviewed twice a year."],
  "O7.1": ["Sustainability and impact framework approved, with 3-5 measurable targets.", "Sustainability criteria included in 100% of major investment and partnership cases."],
  "O7.2": ["Impact metrics on the strategy dashboard and reported quarterly, with an annual review presented to the board."],
};
