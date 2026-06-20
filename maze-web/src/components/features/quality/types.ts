export type QualitySelection =
  | { type: "check"; id: string }
  | { type: "issue"; id: string }
  | { type: "strategy"; issueId: string; strategyId: string }
  | null;
