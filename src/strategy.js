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
export const pillarOf = id => { const g = anyGoal(id); return g ? g.pillar : ""; };
// Units that link activities to the strategy. Block 1: the Group Strategy Office. Later blocks add all functions, then business units.
export const STRATEGY_UNITS = ["group-strategy-office"];
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
export const goalsFor = u => u === "group-strategy-office" ? CSO_OBJ : GOALS;
export const anyGoal = id => CSO_OBJ.find(g => g.id === id) || GOALS.find(g => g.id === id);
