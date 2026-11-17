import type { WireFold, WireTopology } from "../wasm/types";

export const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/// A topology whose folds form one glue (group 0).
export const oneGlue = (fingerprint: string, folds: WireFold[]): WireTopology => ({
  fingerprint,
  folds,
  groups: [{ id: 0, folds: range(folds.length) }],
});
