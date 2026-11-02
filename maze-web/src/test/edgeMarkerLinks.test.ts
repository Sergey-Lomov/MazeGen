import { describe, expect, it } from "vitest";
import { buildEdgeMarkerLinks, isMarkerRoleLinked, markerRolePath, mergeEdgeMarkerOverridePatch, withResolvedEdgeMarkerFloors, withResolvedEdgeMarkers } from "../store/edgeMarkerLinks";
import { DEFAULT_EDGE_MARKER_STYLE } from "../store/slices/imageExportDefaults";
import type { EdgeMarkerStyle } from "../store/imageExportTypes";
import type { ParamLink } from "../store/parameterLinks";
import { resolveColorField, PC } from "../pixi/selectors/projectColorsSelector";

const style = (overrides: EdgeMarkerStyle["overrides"] = {}): EdgeMarkerStyle => ({ ...DEFAULT_EDGE_MARKER_STYLE, mode: "gluings", color: 0x112233, overrides });

describe("edge marker links", () => {
  it("merge: a value breaks the link, undefined restores it, empty override disappears", () => {
    const set = mergeEdgeMarkerOverridePatch(undefined, { shape: "star" });
    expect(set).toEqual({ shape: "star", linkBroken: { shape: true } });
    expect(isMarkerRoleLinked(set ?? undefined, "shape")).toBe(false);
    expect(mergeEdgeMarkerOverridePatch(set ?? undefined, { shape: undefined })).toBeNull();
  });

  it("merge keeps the other role", () => {
    const prev = { color: 0xff0000, linkBroken: { color: true } };
    expect(mergeEdgeMarkerOverridePatch(prev, { shape: "square" })).toEqual({ color: 0xff0000, shape: "square", linkBroken: { color: true, shape: true } });
  });

  it("resolution: explicit value wins over the shared one", () => {
    const resolved = withResolvedEdgeMarkers(style({ f: { a: { color: 0xff0000, linkBroken: { color: true } } } }), [], "f");
    expect(resolved.overrides.a.color).toBe(0xff0000);
    expect(resolved.overrides.a.shape).toBeUndefined();
  });

  it("a floor without overrides resolves to none, and floors do not leak into each other", () => {
    const s = style({ f: { a: { color: 0xff0000, linkBroken: { color: true } } } });
    expect(withResolvedEdgeMarkers(s, [], "g").overrides).toEqual({});
    expect(withResolvedEdgeMarkers(s, [], "f").overrides.a.color).toBe(0xff0000);
    expect(Object.keys(withResolvedEdgeMarkerFloors(s, []).overrides)).toEqual(["f"]);
  });

  it("display links rebind to the marker's own parameters", () => {
    const links = buildEdgeMarkerLinks([], undefined);
    expect(links.map((l) => l.target).sort()).toEqual([markerRolePath("color"), markerRolePath("shape")]);
    expect(links.every((l) => l.enabled)).toBe(true);
    const broken = buildEdgeMarkerLinks([] as ParamLink<string>[], { shape: "star", linkBroken: { shape: true } });
    expect(broken.find((l) => l.target === markerRolePath("shape"))?.enabled).toBe(false);
  });
});

describe("edge marker colour fields", () => {
  it("resolve by key", () => {
    expect(resolveColorField("edgeMarker")?.key).toBe(PC.edgeMarker.key);
    expect(PC.edgeMarkerAt("f", "g1:0", 2, 0).key).toBe("edgeMarker:f|g1:0");
  });
});
