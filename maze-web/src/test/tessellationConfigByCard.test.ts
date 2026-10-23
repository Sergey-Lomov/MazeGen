import { describe, it, expect } from "vitest";
import { TESSELLATION_CONFIG_BY_CARD } from "../pixi/MazeScene";
import type { FeatureId } from "../store/storeTypes";
import type { FieldConfig } from "../fieldConfig";
import { fieldOf } from "./fieldConfigFixtures";

const fieldConfig = fieldOf("square", { shape: "rect", cols: 1, rows: 1 }) as FieldConfig;
const activeFieldConfig = fieldOf("square", { shape: "rect", cols: 2, rows: 2 }) as FieldConfig;
const previewFieldConfig = fieldOf("square", { shape: "rect", cols: 3, rows: 3 }) as FieldConfig;

function fakeState(openCard: FeatureId) {
  return {
    openCard, activeFieldConfig, previewFieldConfig,
    activeFloorId: "floor_1", floorFields: { floor_1: { fieldConfig } },
  } as unknown as Parameters<(typeof TESSELLATION_CONFIG_BY_CARD)[FeatureId]>[0];
}

describe("TESSELLATION_CONFIG_BY_CARD", () => {
  it("resolves basic_config to previewFieldConfig", () => {
    expect(TESSELLATION_CONFIG_BY_CARD.basic_config(fakeState("basic_config"))).toBe(previewFieldConfig);
  });

  it.each(["field_setup", "preset_connections", "quality"] as const)(
    "resolves %s to fieldConfig",
    (card) => {
      expect(TESSELLATION_CONFIG_BY_CARD[card](fakeState(card))).toBe(fieldConfig);
    },
  );

  it.each(["generation", "post_edit", "analytics"] as const)(
    "resolves %s to activeFieldConfig",
    (card) => {
      expect(TESSELLATION_CONFIG_BY_CARD[card](fakeState(card))).toBe(activeFieldConfig);
    },
  );
});
