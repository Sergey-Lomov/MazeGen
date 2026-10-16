import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QualityFeature } from "../components/features/QualityFeature";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { serializeProject, QUALITY_PRESET_KIND, QUALITY_PRESET_VERSION } from "../store/projectExport";
import type { CheckDescriptor, StrategyDescriptor } from "../wasm/types";
import * as m from "~/paraglide/messages";
import { resetNotifications } from "../notifications/notificationStore";
import { errorCards, errorDetails } from "./notificationTestHelpers";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

const preset = {
  kind: QUALITY_PRESET_KIND,
  version: QUALITY_PRESET_VERSION,
  quality: {
    rules: [{
      id: "r1",
      name: null,
      kind: "invalid_loop",
      checks: [{ localId: 0, typeId: "min_loop_length", params: {}, disabled: false }, { localId: 1, typeId: "removed_check", params: {}, disabled: false }],
      strategyId: "removed_strategy",
      disabled: false,
    }],
    stages: [{ id: "s1", name: "S1", ruleIds: ["r1"] }],
    strategyParams: {},
    repairMaxIterations: 42,
    repairTimeBudgetSecs: null,
  },
};

function pickPresetFile(content: unknown, container: HTMLElement) {
  const input = container.querySelector('input[name="quality-preset-file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([JSON.stringify(content)], "rules.mazequality")] } });
}

beforeEach(() => {
  resetNotifications();
  useMazeStore.setState({
    ...baseStoreState(),
    error: null,
    registryLoaded: true,
    availableChecks: [{ id: "min_loop_length", issue_kinds: ["invalid_loop"] } as unknown as CheckDescriptor],
    availableStrategies: [] as StrategyDescriptor[],
    rules: [],
    stages: [],
    repairMaxIterations: 100,
  });
});

describe("QualityFeature quality preset load (GitHub issue #751)", () => {
  it("applies a picked preset and warns about skipped unknown ids", async () => {
    const { container } = render(<QualityFeature />);
    pickPresetFile(preset, container);
    await waitFor(() => expect(useMazeStore.getState().repairMaxIterations).toBe(42));
    const rules = useMazeStore.getState().rules;
    expect(rules.map((r) => r.checks.map((c) => c.typeId))).toEqual([["min_loop_length"]]);
    expect(rules[0].strategyId).toBeNull();
    expect(errorCards()).toEqual([]);
    expect(screen.getByText(m["quality.preset.skipped_ids"]({ ids: "removed_check, removed_strategy" }))).toBeTruthy();
  });

  it("raises a dedicated error toast and changes nothing when a project file is picked", async () => {
    const { container } = render(<QualityFeature />);
    pickPresetFile(serializeProject(useMazeStore.getState()), container);
    await waitFor(() => expect(errorCards()).toEqual(["quality_preset_load/quality.preset.load_error_project_file"]));
    expect(useMazeStore.getState().rules).toEqual([]);
  });

  it("rejects a malformed preset without applying any part of it", async () => {
    const { container } = render(<QualityFeature />);
    pickPresetFile({ ...preset, quality: { ...preset.quality, stages: [{ id: "s1", name: "S1", ruleIds: [] }] } }, container);
    await waitFor(() => expect(errorCards()).toEqual(["quality_preset_load/quality.preset.load_error"]));
    expect(errorDetails("quality.preset.load_error")).toMatch(/not assigned to any stage/);
    expect(useMazeStore.getState().rules).toEqual([]);
    expect(useMazeStore.getState().repairMaxIterations).not.toBe(42);
  });

  it("raises an error toast and changes nothing for a file that is not JSON", async () => {
    const { container } = render(<QualityFeature />);
    const input = container.querySelector('input[name="quality-preset-file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["{not json"], "rules.mazequality")] } });
    await waitFor(() => expect(errorCards()).toEqual(["quality_preset_load/file_load.invalid_json"]));
    expect(useMazeStore.getState().repairMaxIterations).toBe(100);
  });
});
