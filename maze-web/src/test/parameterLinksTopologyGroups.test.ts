import { describe, expect, it } from "vitest";
import * as m from "~/paraglide/messages";
import { VECTOR_BY_WALLS_PARAM_REGISTRY } from "../store/parameterLinksRegistry";

describe("Topology parameter-link groups", () => {
  it("mirrors the Topology settings hierarchy", () => {
    const topology = m["topology.title"]();
    expect(VECTOR_BY_WALLS_PARAM_REGISTRY.trimWallsAtFaceBoundaries.group).toEqual([topology]);
    expect(VECTOR_BY_WALLS_PARAM_REGISTRY.showCutLines.group).toEqual([topology, m["image_export.topology.cut_lines"]()]);
    expect(VECTOR_BY_WALLS_PARAM_REGISTRY.cutLinesGlueColor.group).toEqual([topology, m["image_export.topology.cut_lines"]()]);
    expect(VECTOR_BY_WALLS_PARAM_REGISTRY.cutLinesColor.group).toEqual([topology, m["image_export.topology.cut_lines"]()]);
    expect(VECTOR_BY_WALLS_PARAM_REGISTRY["glueTabs.showTabs"].group).toEqual([topology, m["image_export.glue_tabs.title"]()]);
    for (const path of ["creases.showCreases", "creases.lineStyle", "creases.lineWidth", "creases.markSize", "creases.markTipLength", "creases.color", "creases.markColor"] as const) {
      expect(VECTOR_BY_WALLS_PARAM_REGISTRY[path].group).toEqual([topology, m["image_export.creases.title"]()]);
    }
    expect(VECTOR_BY_WALLS_PARAM_REGISTRY["creases.lineStyle"].type).toBe(VECTOR_BY_WALLS_PARAM_REGISTRY["glueTabs.lineStyle"].type);
    expect("creases.mode" in VECTOR_BY_WALLS_PARAM_REGISTRY).toBe(false);
    expect("edgeMarkers.mode" in VECTOR_BY_WALLS_PARAM_REGISTRY).toBe(false);
    expect(VECTOR_BY_WALLS_PARAM_REGISTRY["edgeMarkers.shape"].group).toEqual([topology, m["image_export.edge_markers.title"]()]);
  });
});
