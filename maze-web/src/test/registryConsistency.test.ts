import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { CheckDescriptor, StrategyDescriptor } from "../wasm/types";
import { checkI18n, strategyI18n, paramI18n, paramOptionI18n, paramOptionExplanationI18n, resolveParamLabel, resolveParamDescription, resolveParamOptionExplanation } from "../components/features/qualityI18n";
import { resolveIssue, DETAIL_LABELS } from "../components/issueRegistry";

// Every check whose maze-core implementation calls `.with_detail(...)` (grep for
// `with_detail(&self.instance_id` / `with_detail(instance_id` across
// maze-core/src/quality_control/checks/*.rs) needs a DETAIL_LABELS entry — otherwise
// `resolveIssueSourceLabel` silently falls back to the generic issue-kind label and only a
// runtime `console.error` (never seen in CI) flags the gap. Kept as an explicit list, not
// derived from the wasm catalog, because a check's *param* ids don't reliably predict its
// *detail* keys (e.g. `min_region_count` has no single-value param but does have a detail).
const CHECK_IDS_WITH_WITH_DETAIL_CALLS = [
  "min_loops_count", "min_loop_density", "loop_length", "external_escape_diversity",
  "loop_distance_from_start", "loop_distance_from_finish", "max_loop_density", "max_loops_count",
  "scc_count", "min_region_size", "min_region_ratio", "max_region_size", "max_region_ratio",
  "min_region_count", "teleport_waypoint_distance", "teleport_geometric_length",
  "teleport_graph_distance", "teleport_super_hub_avoidance", "teleport_group_proximity",
  "one_way_waypoint_distance", "one_way_group_geometric_proximity", "one_way_group_graph_proximity",
  "one_way_group_super_hub", "min_one_way_count", "min_one_way_ratio", "max_one_way_count",
  "max_one_way_ratio", "min_teleport_count", "min_teleport_ratio",
  "max_teleport_count", "max_teleport_density",
  "split_distance_from_waypoint",
  "cross_element_geometric_proximity", "cross_element_graph_proximity",
];

// `src/wasm/pkg/` is gitignored build output produced by `wasm-rebuild.ps1` — absent on a
// fresh checkout until that script has been run at least once. Skip rather than fail so this
// suite doesn't block on a missing local build artifact; it still runs (and catches real
// drift) in any dev environment that has rebuilt wasm, which is the normal workflow here.
const wasmPath = resolve(dirname(__filename), "../wasm/pkg/maze_wasm_bg.wasm");
const describeIfWasmBuilt = existsSync(wasmPath) ? describe : describe.skip;

describeIfWasmBuilt("wasm registry vs web i18n consistency", () => {
  let checks: CheckDescriptor[];
  let strategies: StrategyDescriptor[];

  beforeAll(async () => {
    // wasm-bindgen's default `init()` fetches its .wasm by URL, which doesn't work under
    // vitest's node environment — load the bytes from disk instead and pass them directly.
    const wasm = await import("../wasm/pkg/maze_wasm");
    await wasm.default(readFileSync(wasmPath));
    checks = wasm.available_checks() as CheckDescriptor[];
    strategies = wasm.available_strategies() as StrategyDescriptor[];
  });

  it("every wasm check id has a checkI18n entry", () => {
    for (const check of checks) {
      expect(checkI18n[check.id], `missing checkI18n entry for "${check.id}"`).toBeDefined();
      expect(checkI18n[check.id].label().length).toBeGreaterThan(0);
      expect(checkI18n[check.id].description().length).toBeGreaterThan(0);
    }
  });

  it("every wasm check param id has a paramI18n entry", () => {
    for (const check of checks) {
      for (const param of check.params) {
        expect(paramI18n[param.id], `missing paramI18n entry for "${param.id}" (check "${check.id}")`).toBeDefined();
        expect(paramI18n[param.id].label().length).toBeGreaterThan(0);
        expect(paramI18n[param.id].description().length).toBeGreaterThan(0);
      }
    }
  });

  it("every check with a maze-core with_detail call has a DETAIL_LABELS entry", () => {
    const wasmCheckIds = new Set(checks.map((c) => c.id));
    for (const typeId of CHECK_IDS_WITH_WITH_DETAIL_CALLS) {
      // Guards against this list itself drifting from the live wasm catalog (e.g. a check
      // renamed on the Rust side without updating this list).
      expect(wasmCheckIds.has(typeId), `"${typeId}" is not a registered wasm check id`).toBe(true);
      expect(DETAIL_LABELS[typeId], `missing DETAIL_LABELS entry for "${typeId}"`).toBeDefined();
    }
  });

  it("every wasm check issue kind resolves to a known issue", () => {
    for (const check of checks) {
      for (const kind of check.issue_kinds) {
        const info = resolveIssue(kind);
        expect(info.label, `issue kind "${kind}" (check "${check.id}") has no resolveIssue entry`).not.toBe(kind);
      }
    }
  });

  it("every wasm strategy id has a strategyI18n entry", () => {
    for (const strategy of strategies) {
      expect(strategyI18n[strategy.id], `missing strategyI18n entry for "${strategy.id}"`).toBeDefined();
      expect(strategyI18n[strategy.id].label().length).toBeGreaterThan(0);
      expect(strategyI18n[strategy.id].description().length).toBeGreaterThan(0);
    }
  });

  it("every wasm strategy param id has a paramI18n entry", () => {
    for (const strategy of strategies) {
      for (const param of strategy.params) {
        expect(paramI18n[param.id], `missing paramI18n entry for "${param.id}" (strategy "${strategy.id}")`).toBeDefined();
        expect(paramI18n[param.id].label().length).toBeGreaterThan(0);
        expect(paramI18n[param.id].description().length).toBeGreaterThan(0);
      }
    }
  });

  it("every enum-kind param option has a paramOptionI18n and paramOptionExplanationI18n entry", () => {
    for (const [ownerKind, entity] of [
      ...checks.map((c) => ["check", c] as const),
      ...strategies.map((s) => ["strategy", s] as const),
    ]) {
      for (const param of entity.params) {
        if (param.kind.type !== "enum") continue;
        for (const opt of param.kind.options) {
          const key = `${param.id}.${opt}`;
          expect(paramOptionI18n[key], `missing paramOptionI18n entry for "${key}" (${ownerKind} "${entity.id}")`).toBeDefined();
          expect(paramOptionI18n[key]().length).toBeGreaterThan(0);
          // comparison options (lt/gt/le/ge/eq) are self-explanatory from their label alone —
          // no separate explanation entry is kept for them.
          if (param.id === "comparison") continue;
          expect(paramOptionExplanationI18n[key], `missing paramOptionExplanationI18n entry for "${key}" (${ownerKind} "${entity.id}")`).toBeDefined();
          expect(paramOptionExplanationI18n[key]().length).toBeGreaterThan(0);
        }
      }
    }
  });

  // `priority`-kind params (GitHub issue #381 follow-up) share one hardcoded label set
  // (`resolvePriorityOptionLabel`) instead of per-param `paramOptionI18n` entries, but each
  // param's own explanation text is still per-param -- this is the `priority`-kind analogue of
  // the `enum`-kind completeness check above.
  const PRIORITY_LEVELS = ["required", "preferred", "indifferent", "discouraged", "forbidden"];
  it("every priority-kind param has a paramOptionExplanationI18n entry for all 5 levels", () => {
    for (const [ownerKind, entity] of [
      ...checks.map((c) => ["check", c] as const),
      ...strategies.map((s) => ["strategy", s] as const),
    ]) {
      for (const param of entity.params) {
        if (param.kind.type !== "priority") continue;
        for (const level of PRIORITY_LEVELS) {
          const key = `${param.id}.${level}`;
          expect(paramOptionExplanationI18n[key], `missing paramOptionExplanationI18n entry for "${key}" (${ownerKind} "${entity.id}")`).toBeDefined();
          expect(paramOptionExplanationI18n[key]().length).toBeGreaterThan(0);
        }
      }
    }
  });

  // Regression guard for `resolveParamDescription`/`resolveParamOptionExplanation`'s per-strategy
  // override registries (`paramDescriptionOverrideI18n`/`paramOptionExplanationOverrideI18n` in
  // qualityI18n.ts) -- a typo in an override key, or a strategy id rename on the Rust side without
  // updating the TS override key, would otherwise silently fall through to the generic text with
  // no test failure. Confirms `split_route_cut` is still a live strategy id (guards the key itself
  // against drift) and that its override actually overrides, not just falls back to generic.
  it("split_route_cut's priority param override actually overrides the generic text", () => {
    expect(strategies.some((s) => s.id === "split_route_cut"), "\"split_route_cut\" is not a registered wasm strategy id").toBe(true);

    const generic = resolveParamDescription("priority");
    const overridden = resolveParamDescription("priority", "split_route_cut");
    expect(overridden).toBeDefined();
    expect(overridden).not.toBe(generic);

    for (const value of ["random", "problematic"]) {
      const genericExplanation = resolveParamOptionExplanation("priority", value);
      const overriddenExplanation = resolveParamOptionExplanation("priority", value, "split_route_cut");
      expect(overriddenExplanation, `missing override explanation for priority.${value}.split_route_cut`).toBeDefined();
      expect(overriddenExplanation).not.toBe(genericExplanation);
    }
  });

  // Same regression guard as above, for `one_way_group_super_hub`'s `max_connections` override
  // (GitHub issue #377 follow-up) -- the shared `max_connections` param's generic description is
  // worded for the teleport super-hub check ("... vertex of the teleport ..."), wrong for the
  // one-way super-hub check, which doesn't involve a teleport at all.
  it("one_way_group_super_hub's max_connections param override actually overrides the generic text", () => {
    expect(checks.some((c) => c.id === "one_way_group_super_hub"), "\"one_way_group_super_hub\" is not a registered wasm check id").toBe(true);

    const generic = resolveParamDescription("max_connections");
    const overridden = resolveParamDescription("max_connections", "one_way_group_super_hub");
    expect(overridden).toBeDefined();
    expect(overridden).not.toBe(generic);
  });

  // Same regression guard as above, for `resolveParamLabel`'s `paramLabelOverrideI18n` (qualityI18n
  // params.ts) -- `remove_split`'s own "Kept node" label must win over the generic `selection`
  // label ("Node selection method") shared by `split_node_group_select`/
  // `split_node_connection_group_select`, and only for `remove_split`'s own contextId.
  it("remove_split's selection param label override actually overrides the generic text", () => {
    expect(strategies.some((s) => s.id === "remove_split"), "\"remove_split\" is not a registered wasm strategy id").toBe(true);

    const generic = resolveParamLabel("selection", "fallback");
    const overridden = resolveParamLabel("selection", "fallback", "remove_split");
    expect(overridden).not.toBe(generic);

    // A sibling strategy sharing the same `selection` param must still see the generic label.
    const sibling = resolveParamLabel("selection", "fallback", "split_node_group_select");
    expect(sibling).toBe(generic);
  });
});
