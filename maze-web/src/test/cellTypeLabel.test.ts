import { describe, expect, it } from "vitest";
import { cellTypeLabel } from "../i18n/cellTypeLabel";
import * as m from "~/paraglide/messages";

describe("cellTypeLabel", () => {
  it("names the Cairo pentagon, not a generic cell (GitHub issue #1002)", () => {
    expect(cellTypeLabel("pentagon")).toBe(m["generation.cell_type.pentagon"]());
    expect(cellTypeLabel("pentagon")).not.toBe(m["generation.cell_type.cell"]());
  });
});
