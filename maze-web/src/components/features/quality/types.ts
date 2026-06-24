export type QualitySelection =
  | { type: "check"; id: string }
  | { type: "strategy"; ruleId: string; strategyId: string }
  | { type: "logging"; ruleId: string }
  | null;
