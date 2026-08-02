import { describe, it, expect } from "vitest";
import { RENDER_MODES, resolveRenderMode } from "../components/features/imageExportRegistry";

describe("imageExportRegistry", () => {
  it("resolves a known mode id to its descriptor", () => {
    const mode = resolveRenderMode("vector_by_walls");
    expect(mode?.id).toBe("vector_by_walls");
    expect(mode?.label()).toBeTruthy();
  });

  it("returns null for an unknown mode id instead of throwing", () => {
    expect(resolveRenderMode("not_a_real_mode" as never)).toBeNull();
  });

  it("every registered mode has a non-empty label", () => {
    for (const mode of RENDER_MODES) {
      expect(mode.label()).toBeTruthy();
    }
  });
});
