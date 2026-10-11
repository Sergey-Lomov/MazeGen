import { describe, it, expect } from "vitest";
import { DEFAULT_TELEPORT_SETTINGS } from "../store/slices/imageExportDefaults";
import type { ParamLink } from "../store/parameterLinks";
import { buildGroupLinks, mergeGroupOverridePatch, resolveGroupOverride, resolveGroupOverrides, isGroupRoleLinked } from "../store/teleportGroupLinks";

const marker = { ...DEFAULT_TELEPORT_SETTINGS.teleportMarker, fillColor: 0x808080, borderColor: 0x707070, shape: "circle" as const };

// Common border follows common fill (-15 L in HSL, a visible change), like the issue's example.
const borderFromFill: ParamLink<string> = {
  id: "l1", source: "teleportMarker.fillColor", target: "teleportMarker.borderColor", enabled: true,
  colorModifiers: [{ model: "oklch", channel: "oklch-l", op: "sub", value: 15 }],
};

describe("resolveGroupOverride", () => {
  it("rebinds a group-scoped source to the group's own parameter", () => {
    const out = resolveGroupOverride(marker, [borderFromFill], { fillColor: 0xff0000 });
    expect(out.fillColor).toBe(0xff0000);
    expect(out.borderColor).not.toBe(marker.borderColor);
    expect(out.borderColor).not.toBeUndefined();
  });

  it("explicit override beats the link-derived value", () => {
    const out = resolveGroupOverride(marker, [borderFromFill], { fillColor: 0xff0000, borderColor: 0x123456 });
    expect(out.borderColor).toBe(0x123456);
  });

  it("a broken link falls back to the common value", () => {
    const out = resolveGroupOverride(marker, [borderFromFill], { fillColor: 0xff0000, linkBroken: { borderColor: true } });
    expect(out.borderColor).toBeUndefined();
  });

  it("a disabled or missing common link falls back to the common value", () => {
    expect(resolveGroupOverride(marker, [{ ...borderFromFill, enabled: false }], { fillColor: 0xff0000 }).borderColor).toBeUndefined();
    expect(resolveGroupOverride(marker, [], { fillColor: 0xff0000 }).borderColor).toBeUndefined();
  });

  it("a link from a non-group source resolves to the common value", () => {
    const link: ParamLink<string> = { id: "l2", source: "markerBorderColor", target: "teleportMarker.borderColor", enabled: true };
    expect(resolveGroupOverride(marker, [link], { fillColor: 0xff0000 }).borderColor).toBeUndefined();
  });

  it("returns the same object when there are no overrides", () => {
    const overrides = {};
    expect(resolveGroupOverrides({ teleportMarker: marker, links: [borderFromFill], teleportGroupOverrides: overrides })).toBe(overrides);
  });
});

describe("mergeGroupOverridePatch", () => {
  it("setting a value breaks that role's link only", () => {
    expect(mergeGroupOverridePatch(undefined, { fillColor: 1 })).toEqual({ fillColor: 1, linkBroken: { fillColor: true } });
  });

  it("clearing a role restores its link and drops an empty entry", () => {
    const prev = { fillColor: 1, linkBroken: { fillColor: true } };
    expect(mergeGroupOverridePatch(prev, { fillColor: undefined })).toBeNull();
  });

  it("linkBroken in a patch breaks a link without a value", () => {
    const merged = mergeGroupOverridePatch({ fillColor: 1, linkBroken: { fillColor: true } }, { linkBroken: { borderColor: true } });
    expect(merged).toEqual({ fillColor: 1, linkBroken: { fillColor: true, borderColor: true } });
    expect(isGroupRoleLinked(merged!, "borderColor")).toBe(false);
  });
});

describe("buildGroupLinks", () => {
  it("rebinds group-role sources and reflects the broken state", () => {
    const link = buildGroupLinks([borderFromFill], undefined).find((l) => l.target === "group.borderColor");
    expect(link).toMatchObject({ source: "group.fillColor", target: "group.borderColor", enabled: true });
    expect(buildGroupLinks([borderFromFill], { linkBroken: { borderColor: true } }).find((l) => l.target === "group.borderColor")?.enabled).toBe(false);
  });

  it("keeps a non-group source and skips disabled common links", () => {
    const link: ParamLink<string> = { id: "l2", source: "markerBorderColor", target: "teleportMarker.borderColor", enabled: true };
    expect(buildGroupLinks([link], undefined).find((l) => l.target === "group.borderColor")?.source).toBe("markerBorderColor");
    // A disabled common link is no inheritance: the group follows the common parameter itself.
    const fallback = buildGroupLinks([{ ...link, enabled: false }], undefined).find((l) => l.target === "group.borderColor");
    expect(fallback).toMatchObject({ source: "teleportMarker.borderColor", enabled: true });
  });

  it("gives every role a link, following the common parameter when it has none", () => {
    expect(buildGroupLinks([], undefined).map((l) => `${l.source}->${l.target}`)).toEqual([
      "teleportMarker.fillColor->group.fillColor",
      "teleportMarker.borderColor->group.borderColor",
      "teleportMarker.shape->group.shape",
    ]);
    expect(buildGroupLinks([], { shape: "star" }).find((l) => l.target === "group.shape")?.enabled).toBe(false);
  });
});
