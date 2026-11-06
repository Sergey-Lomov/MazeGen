import { describe, it, expect, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { resolveDrop, initialPreview, movePreview, finalizeRuleDrop, ruleDndId, stageDndId, stageHeadDndId, NEW_STAGE_START_ID, NEW_STAGE_END_ID } from "../components/features/quality/qcDnd";

const stage = (id: string, ruleIds: string[]) => ({ id, name: id, ruleIds, disabled: false, collapsed: false });
const ids = () => useMazeStore.getState().stages.map((s) => ({ id: s.id, rules: s.ruleIds }));

beforeEach(() => {
  useMazeStore.setState({
    ...baseStoreState(),
    stages: [stage("A", ["r1", "r2"]), stage("B", ["r3"]), stage("C", [])],
  });
});

describe("reorderRule / moveRuleToNewStage / reorderStage (issue #39)", () => {
  it("reorderRule within a stage", () => {
    useMazeStore.getState().reorderRule("r1", "A", 1);
    expect(ids()[0].rules).toEqual(["r2", "r1"]);
  });

  it("reorderRule across stages, including into an empty one", () => {
    useMazeStore.getState().reorderRule("r2", "B", 0);
    useMazeStore.getState().reorderRule("r3", "C", 5);
    expect(ids()).toEqual([{ id: "A", rules: ["r1"] }, { id: "B", rules: ["r2"] }, { id: "C", rules: ["r3"] }]);
  });

  it("reorderRule no-op for unknown rule or stage", () => {
    useMazeStore.getState().reorderRule("nope", "A", 0);
    useMazeStore.getState().reorderRule("r1", "nope", 0);
    expect(ids()[0].rules).toEqual(["r1", "r2"]);
  });

  it("moveRuleToNewStage creates a stage at either end", () => {
    useMazeStore.getState().moveRuleToNewStage("r1", "start");
    let st = useMazeStore.getState().stages;
    expect(st).toHaveLength(4);
    expect(st[0].ruleIds).toEqual(["r1"]);
    expect(st[1].ruleIds).toEqual(["r2"]);
    useMazeStore.getState().moveRuleToNewStage("r3", "end");
    st = useMazeStore.getState().stages;
    expect(st).toHaveLength(5);
    expect(st[4].ruleIds).toEqual(["r3"]);
    expect(new Set(st.map((s) => s.id)).size).toBe(5);
  });

  it("moveRuleToNewStage numbers the new stage like addStage (highest suffix, not count)", () => {
    useMazeStore.setState({ stages: [stage("A", ["r1"]), { ...stage("S3", []), name: "Stage 3" }] });
    useMazeStore.getState().moveRuleToNewStage("r1", "end");
    expect(useMazeStore.getState().stages[2].name).toBe("Stage 4");
  });

  it("reorderStage moves whole stage, keeps rules, creates none", () => {
    useMazeStore.getState().reorderStage("A", 2);
    expect(ids()).toEqual([{ id: "B", rules: ["r3"] }, { id: "C", rules: [] }, { id: "A", rules: ["r1", "r2"] }]);
    useMazeStore.getState().reorderStage("A", 0);
    expect(ids().map((s) => s.id)).toEqual(["A", "B", "C"]);
  });
});

const stages = [{ stageId: "A", ruleIds: ["r1", "r2"] }, { stageId: "B", ruleIds: ["r3"] }, { stageId: "C", ruleIds: [] }];

describe("resolveDrop", () => {
  it("null for no target or self", () => {
    expect(resolveDrop(ruleDndId("r1"), null, stages)).toBeNull();
    expect(resolveDrop(ruleDndId("r1"), ruleDndId("r1"), stages)).toBeNull();
  });

  it("rule over outer zone creates a stage; over anything else is left to the preview", () => {
    expect(resolveDrop(ruleDndId("r1"), NEW_STAGE_START_ID, stages)).toEqual({ type: "moveRuleToNewStage", ruleId: "r1", position: "start" });
    expect(resolveDrop(ruleDndId("r1"), NEW_STAGE_END_ID, stages)).toEqual({ type: "moveRuleToNewStage", ruleId: "r1", position: "end" });
    expect(resolveDrop(ruleDndId("r1"), ruleDndId("r3"), stages)).toBeNull();
  });

  it("stage over stage / rule maps to stage index, never creates a stage", () => {
    expect(resolveDrop(stageDndId("A"), stageDndId("C"), stages)).toEqual({ type: "reorderStage", stageId: "A", index: 2 });
    expect(resolveDrop(stageDndId("C"), ruleDndId("r1"), stages)).toEqual({ type: "reorderStage", stageId: "C", index: 0 });
    expect(resolveDrop(stageDndId("A"), ruleDndId("r2"), stages)).toBeNull();
  });
});

describe("movePreview", () => {
  const preview = initialPreview(stages);

  it("over a rule: above in the upper half, below in the lower half", () => {
    expect(movePreview(preview, "r1", ruleDndId("r3"), false)).toEqual({ A: ["r2"], B: ["r1", "r3"], C: [] });
    expect(movePreview(preview, "r1", ruleDndId("r3"), true)).toEqual({ A: ["r2"], B: ["r3", "r1"], C: [] });
  });

  it("same stage reorder follows the half too", () => {
    expect(movePreview(preview, "r1", ruleDndId("r2"), true)).toEqual({ A: ["r2", "r1"], B: ["r3"], C: [] });
    expect(movePreview(preview, "r1", ruleDndId("r2"), false)).toBeNull();
  });

  it("over a stage head: first slot of that stage (also an empty one)", () => {
    expect(movePreview(preview, "r2", stageHeadDndId("B"), false)).toEqual({ A: ["r1"], B: ["r2", "r3"], C: [] });
    expect(movePreview(preview, "r1", stageHeadDndId("C"), false)).toEqual({ A: ["r2"], B: ["r3"], C: ["r1"] });
    expect(movePreview(preview, "r1", stageHeadDndId("A"), false)).toBeNull();
  });

  it("over a stage body: only an empty stage accepts the rule", () => {
    expect(movePreview(preview, "r1", stageDndId("C"), false)).toEqual({ A: ["r2"], B: ["r3"], C: ["r1"] });
    expect(movePreview(preview, "r1", stageDndId("B"), false)).toBeNull();
  });

  it("ignores itself, unknown targets and outer zones", () => {
    expect(movePreview(preview, "r1", ruleDndId("r1"), false)).toBeNull();
    expect(movePreview(preview, "r1", ruleDndId("nope"), false)).toBeNull();
    expect(movePreview(preview, "nope", ruleDndId("r3"), false)).toBeNull();
    expect(movePreview(preview, "r1", NEW_STAGE_END_ID, false)).toBeNull();
  });

  it("does not mutate the input layout", () => {
    movePreview(preview, "r1", ruleDndId("r3"), false);
    expect(preview).toEqual({ A: ["r1", "r2"], B: ["r3"], C: [] });
  });
});

describe("finalizeRuleDrop", () => {
  it("null when the rule ended up in its original slot", () => {
    expect(finalizeRuleDrop(initialPreview(stages), "r1", stages)).toBeNull();
  });

  it("returns target stage and index of the preview slot", () => {
    expect(finalizeRuleDrop({ A: ["r2"], B: ["r1", "r3"], C: [] }, "r1", stages)).toEqual({ targetStageId: "B", index: 0 });
    expect(finalizeRuleDrop({ A: ["r2", "r1"], B: ["r3"], C: [] }, "r1", stages)).toEqual({ targetStageId: "A", index: 1 });
  });

  it("null for a rule missing from the preview", () => {
    expect(finalizeRuleDrop({ A: [], B: [], C: [] }, "r1", stages)).toBeNull();
  });
});
