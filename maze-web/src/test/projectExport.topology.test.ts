import { describe, it, expect } from "vitest";
import { parseAndValidate, serializeProject } from "../store/projectExport";
import { tessellationFingerprint } from "../store/topologyWire";
import type { WireTopology } from "../wasm/types";
import { makeState, CYLINDER, toJson } from "./projectExportKit";

describe("floorTopology (GitHub issue #836)", () => {
  const withTopology = (topology: WireTopology) => JSON.parse(JSON.stringify(serializeProject(makeState({ floorTopology: { floor_1: topology } }))));

  it("round-trips a floor's topology", () => {
    const state = makeState({ floorTopology: { floor_1: CYLINDER } });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.floorTopology).toEqual({ floor_1: CYLINDER });
    expect(reparsed).toEqual(serialized);
  });

  it("loads a file without the section as no topology", () => {
    const raw = toJson(makeState());
    delete raw.floorTopology;
    expect(parseAndValidate(raw).floorTopology).toEqual({});
  });

  it("rejects a fingerprint of another tessellation config with both configs named", () => {
    const raw = withTopology({ ...CYLINDER, fingerprint: "hex{}" });
    expect(() => parseAndValidate(raw)).toThrow(/authored for tessellation `hex\{\}`, current is `square\{\}`/);
  });

  it("rejects structural violations with reasons", () => {
    const bad = (mutate: (t: WireTopology) => void) => {
      const topology: WireTopology = JSON.parse(JSON.stringify(CYLINDER));
      mutate(topology);
      return withTopology(topology);
    };
    expect(() => parseAndValidate(bad((t) => { t.folds[0].b = t.folds[0].a; }))).toThrow(/glued to itself/);
    expect(() => parseAndValidate(bad((t) => { t.folds.push({ ...t.folds[0], group: 0 }); }))).toThrow(/also belongs to fold 0/);
    expect(() => parseAndValidate(bad((t) => { t.groups = []; }))).toThrow(/group 0 does not exist/);
    expect(() => parseAndValidate(bad((t) => { t.groups[0].folds = [3]; }))).toThrow(/lists unknown fold 3/);
    expect(() => parseAndValidate(bad((t) => { t.folds[0].a.face_idx = -1; }))).toThrow(/face_idx/);
  });
});

describe("tessellationFingerprint", () => {
  it("renders the kind and sorted params", () => {
    expect(tessellationFingerprint("square", {})).toBe("square{}");
    expect(tessellationFingerprint("radial", { max_cells: 3000, first_ring_cells: 9, ring_layout: "smooth" }))
      .toBe('radial{"first_ring_cells":9,"max_cells":3000,"ring_layout":"smooth"}');
  });
});