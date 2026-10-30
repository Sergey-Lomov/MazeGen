import { describe, it, expect } from "vitest";
import { validateFieldShape } from "../store/projectExport/validateSections";

const box = { shape: "box", width: 3, height: 4, depth: 5 };

describe("validateFieldShape — box", () => {
  it("round-trips a full box shape", () => {
    const shape = { ...box, net: 1, mode: 1, aspect: 150 };
    expect(validateFieldShape(JSON.parse(JSON.stringify(shape)), "s")).toEqual(shape);
  });

  it("defaults net, mode and aspect for older project files", () => {
    expect(validateFieldShape(box, "s")).toEqual({ ...box, net: 0, mode: 0, aspect: 100 });
  });

  it("forces by-faces mode for the compact net", () => {
    expect(validateFieldShape({ ...box, net: 2, mode: 0 }, "s")).toMatchObject({ net: 2, mode: 1 });
  });

  it.each([
    { net: 3 },
    { net: -1 },
    { net: 0, mode: 2 },
    { net: 0.5 },
  ])("rejects out-of-range switches %j", (bad) => {
    expect(() => validateFieldShape({ ...box, ...bad }, "s")).toThrow();
  });

  it("rejects a missing dimension", () => {
    expect(() => validateFieldShape({ shape: "box", width: 3, height: 4 }, "s")).toThrow(/depth/);
  });
});
