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

describe("validateFieldShape — polyhedra", () => {
  const nets = { tetrahedron: 2, octahedron: 2, icosahedron: 1 };

  it.each(Object.keys(nets))("round-trips a full %s shape", (shape) => {
    const full = { shape, side: 5, net: 0, mode: 1, aspect: 150 };
    expect(validateFieldShape(JSON.parse(JSON.stringify(full)), "s")).toEqual(full);
  });

  it("defaults net, mode and aspect for older project files", () => {
    expect(validateFieldShape({ shape: "octahedron", side: 3 }, "s")).toEqual({ shape: "octahedron", side: 3, net: 0, mode: 0, aspect: 100 });
  });

  it.each(Object.entries(nets))("forces by-faces mode for the compact net of %s", (shape, compact) => {
    expect(validateFieldShape({ shape, side: 3, net: compact, mode: 0 }, "s")).toMatchObject({ net: compact, mode: 1 });
  });

  it.each(Object.entries(nets))("rejects a net past the compact one for %s", (shape, compact) => {
    expect(() => validateFieldShape({ shape, side: 3, net: compact + 1 }, "s")).toThrow();
    expect(() => validateFieldShape({ shape, side: 3, mode: 2 }, "s")).toThrow();
  });

  it("rejects a missing side", () => {
    expect(() => validateFieldShape({ shape: "icosahedron" }, "s")).toThrow(/side/);
  });
});

describe("validateFieldShape — cylinder and torus", () => {
  const size = { cols: 5, rows: 4 };

  it("round-trips a cylinder with its axis and a torus without one", () => {
    const cylinder = { shape: "cylinder", ...size, axis: 1 };
    expect(validateFieldShape(JSON.parse(JSON.stringify(cylinder)), "s")).toEqual(cylinder);
    const torus = { shape: "torus", ...size };
    expect(validateFieldShape({ ...torus, axis: 1 }, "s")).toEqual(torus);
  });

  it("defaults the axis of a cylinder to left and right", () => {
    expect(validateFieldShape({ shape: "cylinder", ...size }, "s")).toEqual({ shape: "cylinder", ...size, axis: 0 });
  });

  it.each([{ axis: 2 }, { axis: -1 }, { axis: 0.5 }])("rejects the cylinder %j", (bad) => {
    expect(() => validateFieldShape({ shape: "cylinder", ...size, ...bad }, "s")).toThrow();
  });
});
