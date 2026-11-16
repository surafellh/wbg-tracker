// Reporting lines from 1 November 2026: two Deputy CEOs report to the Group CEO.
//   dceo-bu : Business unit general managers report to the DCEO - Business Units Operations.
//   dceo-st : CSO, CPMO, R&D and CTO report to the DCEO - Strategy and Transformation.
//   ceo     : every other group function keeps its current reporting line.
// Each unit carries its own "reports to" value (Admin, Reporting units), so a future change needs no code change.
export const PORTFOLIOS = [
  { key: "dceo-bu", label: "DCEO – Business Units Operations", short: "Business Units Operations" },
  { key: "dceo-st", label: "DCEO – Strategy and Transformation", short: "Strategy and Transformation" },
  { key: "ceo", label: "Other group functions", short: "Other functions" },
];
const ST_DEFAULT = ["group-strategy-office", "pmo", "research-development", "cto"];
export const portfolioOf = (u) => (u && u.reportsTo && PORTFOLIOS.some((p) => p.key === u.reportsTo) ? u.reportsTo : u && u.type === "Business unit" ? "dceo-bu" : u && ST_DEFAULT.includes(u.id) ? "dceo-st" : "ceo");
export const portfolioLabel = (k) => (PORTFOLIOS.find((p) => p.key === k) || {}).label || k;
