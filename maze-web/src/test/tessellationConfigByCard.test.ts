import { describe, it, expect } from "vitest";
import { TESSELLATION_CONFIG_BY_CARD } from "../pixi/MazeScene";
import type { FeatureId } from "../store/storeTypes";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

const tessellationConfig = { type: "square", width: 1, height: 1 } as TessellationConfig;
const activeTessellationConfig = { type: "square", width: 2, height: 2 } as TessellationConfig;
const previewTessellationConfig = { type: "square", width: 3, height: 3 } as TessellationConfig;

function fakeState(openCard: FeatureId) {
  return {
    openCard, activeTessellationConfig, previewTessellationConfig,
    activeFloorId: "floor_1", floorFields: { floor_1: { tessellationConfig } },
  } as unknown as Parameters<(typeof TESSELLATION_CONFIG_BY_CARD)[FeatureId]>[0];
}

describe("TESSELLATION_CONFIG_BY_CARD", () => {
  it("resolves basic_config to previewTessellationConfig", () => {
    expect(TESSELLATION_CONFIG_BY_CARD.basic_config(fakeState("basic_config"))).toBe(previewTessellationConfig);
  });

  it.each(["field_setup", "preset_connections", "quality"] as const)(
    "resolves %s to tessellationConfig",
    (card) => {
      expect(TESSELLATION_CONFIG_BY_CARD[card](fakeState(card))).toBe(tessellationConfig);
    },
  );

  it.each(["generation", "post_edit", "analytics"] as const)(
    "resolves %s to activeTessellationConfig",
    (card) => {
      expect(TESSELLATION_CONFIG_BY_CARD[card](fakeState(card))).toBe(activeTessellationConfig);
    },
  );
});
