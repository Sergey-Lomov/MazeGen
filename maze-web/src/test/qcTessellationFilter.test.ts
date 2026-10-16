import { describe, it, expect, vi } from "vitest";
import { fakeTessellationShapes } from "./tessellationShapesFake";
import { qcForTessellation } from "../store/slices/qcTessellationFilter";
import { selectTessellationWouldLoseData } from "../pixi/selectors/mazeSelectors";
import { getTessellationShapes } from "../wasm/mazeService";
import type { CheckDescriptor, RuleParamDescriptor, StrategyDescriptor } from "../wasm/types";
import type { QcRuleState } from "../store/storeTypes";
import { tessellationConfigOf, type FieldConfig } from "../fieldConfig";

vi.mock("../wasm/mazeService", () => ({ getTessellationShapes: vi.fn((config: Parameters<typeof fakeTessellationShapes>[0]) => fakeTessellationShapes(config)) }));

const HEX = tessellationConfigOf("hex");

const square = { shape: "regular:4", node_count: 1, faces: [[]], weight: 1 };
const hex = { shape: "regular:6", node_count: 1, faces: [[]], weight: 1 };

const checks: CheckDescriptor[] = [
  { id: "split_pattern_shape", label: "", description: "", issue_kinds: ["invalid_split_tile"], params: [{ id: "patterns", label: "", kind: { type: "pattern_list", with_weights: false } }] },
  { id: "split_count", label: "", description: "", issue_kinds: ["missing_split_tiles"], params: [] },
];
const strategies: StrategyDescriptor[] = [
  { id: "add_split", handles: "missing_split_tiles", experimental: false, nested_slots: [], params: [{ id: "split_config", label: "", kind: { type: "add_split_config", max_split_nodes_default: 2 } }] },
  { id: "missing_loops_split", handles: "missing_loops", experimental: false, nested_slots: [], params: [{ id: "split_config", label: "", kind: { type: "split_generation_config" } }] },
];
const ruleParams: RuleParamDescriptor[] = [
  { id: "split_patterns", label: "", kind: { type: "pattern_list", with_weights: false }, applies_to: ["split_count", "split_density", "add_split"] },
];

function rule(id: string, patch: Partial<QcRuleState>): QcRuleState {
  return {
    id, name: null, kind: "k", checks: [], nextLocalCheckId: 1, strategyId: null, disabled: false,
    ruleDisabled: false, nestedStrategies: [], params: {}, collapsed: false, ...patch,
  };
}

function qcState(rules: QcRuleState[], strategyParams: Record<string, Record<string, string>> = {}) {
  return { rules, strategyParams, availableChecks: checks, availableStrategies: strategies, availableRuleParams: ruleParams };
}

describe("qcForTessellation", () => {
  it("returns the same references when every pattern survives", () => {
    const state = qcState(
      [rule("r", { checks: [{ localId: 0, typeId: "split_pattern_shape", params: { patterns: JSON.stringify([hex]) }, disabled: false }] })],
      { missing_loops_split: { split_config: JSON.stringify({ pattern_mode: true, max_split_nodes: 2, patterns: [hex] }) } },
    );
    const result = qcForTessellation(state, HEX);
    expect(result.rules).toBe(state.rules);
    expect(result.strategyParams).toBe(state.strategyParams);
  });

  it("keeps only patterns of the new kind's shapes in check params", () => {
    const state = qcState([rule("r", { checks: [{ localId: 0, typeId: "split_pattern_shape", params: { patterns: JSON.stringify([square, hex]) }, disabled: false }] })]);
    const result = qcForTessellation(state, HEX);
    expect(JSON.parse(result.rules[0].checks[0].params.patterns)).toEqual([hex]);
  });

  it("removes a check whose non-empty pattern filter loses every pattern", () => {
    const state = qcState([rule("r", { checks: [
      { localId: 0, typeId: "split_pattern_shape", params: { patterns: JSON.stringify([square]) }, disabled: false },
      { localId: 1, typeId: "split_pattern_shape", params: { patterns: "[]" }, disabled: false },
    ] })]);
    const result = qcForTessellation(state, HEX);
    expect(result.rules[0].checks.map((c) => c.localId)).toEqual([1]);
  });

  it("filters rule-level patterns and re-indexes the rule strategy's weights", () => {
    const state = qcState(
      [rule("r", {
        strategyId: "add_split",
        params: { split_patterns: JSON.stringify([square, hex]) },
        checks: [{ localId: 0, typeId: "split_count", params: {}, disabled: false }],
      })],
      { add_split: { split_config: "[0.5,3]" } },
    );
    const result = qcForTessellation(state, HEX);
    expect(JSON.parse(result.rules[0].params.split_patterns)).toEqual([hex]);
    expect(result.rules[0].checks).toHaveLength(1);
    expect(result.strategyParams.add_split.split_config).toBe("[3]");
  });

  it("re-indexes shared strategy weights once even when several rules lose patterns", () => {
    const state = qcState(
      [
        rule("a", { strategyId: "add_split", params: { split_patterns: JSON.stringify([square, hex, hex]) } }),
        rule("b", { strategyId: "add_split", params: { split_patterns: JSON.stringify([square, hex, hex]) } }),
      ],
      { add_split: { split_config: "[1,2,3]" } },
    );
    const result = qcForTessellation(state, HEX);
    expect(result.strategyParams.add_split.split_config).toBe("[2,3]");
  });

  it("drops rule-filtered checks and resets weights when every rule-level pattern is lost", () => {
    const state = qcState(
      [rule("r", {
        strategyId: "add_split",
        params: { split_patterns: JSON.stringify([square]) },
        checks: [{ localId: 0, typeId: "split_count", params: {}, disabled: false }],
      })],
      { add_split: { split_config: "[0.5]" } },
    );
    const result = qcForTessellation(state, HEX);
    expect(result.rules[0].params.split_patterns).toBe("[]");
    expect(result.rules[0].checks).toEqual([]);
    expect(result.strategyParams.add_split.split_config).toBe("2");
  });

  it("filters split generation config patterns in top-level and nested strategy params", () => {
    const config = JSON.stringify({ pattern_mode: true, max_split_nodes: 2, patterns: [square, hex] });
    const state = qcState(
      [rule("r", { nestedStrategies: [{ slotId: "s", strategyId: "missing_loops_split", params: { split_config: config }, nested: [] }] })],
      { missing_loops_split: { split_config: config } },
    );
    const result = qcForTessellation(state, HEX);
    expect(JSON.parse(result.strategyParams.missing_loops_split.split_config).patterns).toEqual([hex]);
    expect(JSON.parse(result.rules[0].nestedStrategies[0].params.split_config).patterns).toEqual([hex]);
  });
});

describe("selectTessellationWouldLoseData split patterns", () => {
  const clean = {
    previewKind: "hex" as const, tessellationKind: "square" as const, floorFields: {},
    previewFieldConfig: { tessellation: HEX, shape: { shape: "custom", points: [] } } as FieldConfig,
    presetsDirty: false, mazeDirty: false, postEditDirty: false,
  };

  it("reports loss when a generation split pattern has no template in the preview kind", () => {
    expect(selectTessellationWouldLoseData({ ...clean, ...qcState([]), splitPatterns: [square] })).toBe(true);
    expect(selectTessellationWouldLoseData({ ...clean, ...qcState([]), splitPatterns: [hex] })).toBe(false);
  });

  it("reports loss on a params-only config change that drops a template", () => {
    vi.mocked(getTessellationShapes).mockReturnValueOnce({ keys: [], point_shapes: [] });
    const sameKind = {
      ...clean, previewKind: "hex" as const, tessellationKind: "hex" as const,
      previewFieldConfig: { tessellation: { kind: "hex", params: { variant: 1 } }, shape: { shape: "custom", points: [] } } as FieldConfig,
    };
    expect(selectTessellationWouldLoseData({ ...sameKind, ...qcState([]), splitPatterns: [hex] })).toBe(true);
  });

  it("reports loss when quality control would drop split patterns", () => {
    const rules = [rule("r", { checks: [{ localId: 0, typeId: "split_pattern_shape", params: { patterns: JSON.stringify([square, hex]) }, disabled: false }] })];
    expect(selectTessellationWouldLoseData({ ...clean, ...qcState(rules), splitPatterns: [] })).toBe(true);
  });
});
