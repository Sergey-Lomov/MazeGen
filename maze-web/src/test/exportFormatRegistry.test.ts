import { describe, it, expect } from "vitest";
import { EXPORT_FORMATS, resolveExportFormat } from "../components/features/exportFormatRegistry";

describe("exportFormatRegistry", () => {
  it("resolves a known format id to its descriptor", () => {
    const format = resolveExportFormat("png");
    expect(format?.id).toBe("png");
    expect(format?.label()).toBeTruthy();
  });

  it("returns null for an unknown format id instead of throwing", () => {
    expect(resolveExportFormat("not_a_real_format" as never)).toBeNull();
  });

  it("every registered format has a non-empty label", () => {
    for (const format of EXPORT_FORMATS) {
      expect(format.label()).toBeTruthy();
    }
  });
});
