import { describe, it, expect } from "vitest";
import { DEFAULT_MARKER_TEXT_SIZE } from "../pixi/renderConstants";
import { validateVerticalSettingsFields, validateVerticalDecorativeFields, validateDecorativeLineStyle, validateTeleportSettingsFields, validateTeleportFloorBadgeSettings, validateVectorByWallsSettings, optRenderStyle, validateVectorByCorridorsSettings, validateLinks, validateMarkerSettings, validateMarkerIndexSettings, validateFloorLabelSettings } from "../store/projectExport/validateImageExport";
import { DEFAULT_MARKER_INDEX_SETTINGS, DEFAULT_VERTICAL_SETTINGS, DEFAULT_VERTICAL_DECORATIVE_SETTINGS, DEFAULT_TELEPORT_SETTINGS, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS, DEFAULT_VECTOR_BY_WALLS_SETTINGS } from "../store/slices/imageExportDefaults";
import { DEFAULT_VECTOR_BY_WALLS_LINKS } from "../store/slices/parameterLinksDefaults";
import { VECTOR_BY_WALLS_PARAM_REGISTRY } from "../store/parameterLinksRegistry";

describe("validateMarkerSettings", () => {
  const fallback = DEFAULT_VECTOR_BY_WALLS_SETTINGS.startMarker;

  it("round-trips text, textEnabled, textFontWeight, textSize and textColor", () => {
    const result = validateMarkerSettings(
      { ...fallback, text: "x", textEnabled: false, textFontWeight: "regular", textSize: 1.5, textColor: 0xabcdef },
      "path",
      fallback,
    );
    // sanitizeMarkerGlyph uppercases on the way through, same as the settings-panel input.
    expect(result.text).toBe("X");
    expect(result.textEnabled).toBe(false);
    expect(result.textFontWeight).toBe("regular");
    expect(result.textSize).toBe(1.5);
    expect(result.textColor).toBe(0xabcdef);
  });

  it("falls back to the given fallback's values when the fields are absent (older project file)", () => {
    const result = validateMarkerSettings({ shape: fallback.shape }, "path", { ...fallback, textEnabled: false, textFontWeight: "regular", textSize: 1.5, textColor: 0xabcdef });
    expect(result.textEnabled).toBe(false);
    expect(result.textFontWeight).toBe("regular");
    expect(result.textSize).toBe(1.5);
    expect(result.textColor).toBe(0xabcdef);
  });

  it("falls back to true/bold/default-px/fillColor defaults when both the input and the fallback omit the fields", () => {
    const { textEnabled: _e, textFontWeight: _f, textSize: _s, textColor: _c, ...bareFallback } = fallback;
    const result = validateMarkerSettings({ textEnabled: "not-a-bool", textFontWeight: "bogus", textSize: "bogus", textColor: "bogus" }, "path", bareFallback);
    expect(result.textEnabled).toBe(true);
    expect(result.textFontWeight).toBe("bold");
    expect(result.textSize).toBe(DEFAULT_MARKER_TEXT_SIZE);
    expect(result.textColor).toBe(bareFallback.fillColor);
  });
});

describe("validateVerticalSettingsFields", () => {
  it("preserves elevator simplification and defaults it on for older projects", () => {
    expect(validateVerticalSettingsFields({ replaceTwoFloorElevatorsWithStairs: false }, "path", DEFAULT_VERTICAL_SETTINGS).replaceTwoFloorElevatorsWithStairs).toBe(false);
    expect(validateVerticalSettingsFields({}, "path", DEFAULT_VERTICAL_SETTINGS).replaceTwoFloorElevatorsWithStairs).toBe(true);
  });

  // Arrow style/corner-style fields (GitHub issue #347 third follow-up)
  it("reads twoWayArrowStyle/twoWayArrowCornerStyle as-is when valid", () => {
    const result = validateVerticalSettingsFields({ twoWayArrowStyle: "chevron", twoWayArrowCornerStyle: "miter" }, "path", DEFAULT_VERTICAL_SETTINGS);
    expect(result.twoWayArrowStyle).toBe("chevron");
    expect(result.twoWayArrowCornerStyle).toBe("miter");
  });

  it("accepts the vertical sign style for every arrow group", () => {
    const result = validateVerticalSettingsFields(
      { twoWayArrowStyle: "sign", oneWayArrowStyle: "sign", elevatorArrowStyle: "sign" },
      "path",
      DEFAULT_VERTICAL_SETTINGS,
    );
    expect(result.twoWayArrowStyle).toBe("sign");
    expect(result.oneWayArrowStyle).toBe("sign");
    expect(result.elevatorArrowStyle).toBe("sign");
  });

  it("falls back to the default for an invalid arrow style/corner-style", () => {
    const result = validateVerticalSettingsFields({ oneWayArrowStyle: "bogus", elevatorArrowCornerStyle: "bogus" }, "path", DEFAULT_VERTICAL_SETTINGS);
    expect(result.oneWayArrowStyle).toBe(DEFAULT_VERTICAL_SETTINGS.oneWayArrowStyle);
    expect(result.elevatorArrowCornerStyle).toBe(DEFAULT_VERTICAL_SETTINGS.elevatorArrowCornerStyle);
  });

  it("falls back to the default arrow style/corner-style when the fields are absent", () => {
    const result = validateVerticalSettingsFields({}, "path", DEFAULT_VERTICAL_SETTINGS);
    expect(result.twoWayArrowStyle).toBe(DEFAULT_VERTICAL_SETTINGS.twoWayArrowStyle);
    expect(result.twoWayArrowCornerStyle).toBe(DEFAULT_VERTICAL_SETTINGS.twoWayArrowCornerStyle);
    expect(result.oneWayArrowStyle).toBe(DEFAULT_VERTICAL_SETTINGS.oneWayArrowStyle);
    expect(result.oneWayArrowCornerStyle).toBe(DEFAULT_VERTICAL_SETTINGS.oneWayArrowCornerStyle);
    expect(result.elevatorArrowStyle).toBe(DEFAULT_VERTICAL_SETTINGS.elevatorArrowStyle);
    expect(result.elevatorArrowCornerStyle).toBe(DEFAULT_VERTICAL_SETTINGS.elevatorArrowCornerStyle);
  });

  // Legacy single-marker fallback (GitHub issue #347 three-section follow-up): a project file
  // saved before the split had one shared `verticalPassageMarker` for both two-way and one-way
  // passages — both new fields must seed from it on first load, matching how it actually rendered.
  it("seeds both twoWayPassageMarker and oneWayPassageMarker from the legacy verticalPassageMarker field", () => {
    const legacyMarker = { shape: "star", fillColor: 0x123456, borderColor: 0x654321, borderWidth: 5, gapWidth: 2, size: 0.3, cornerStyle: "round" };
    const result = validateVerticalSettingsFields({ verticalPassageMarker: legacyMarker }, "path", DEFAULT_VERTICAL_SETTINGS);
    expect(result.twoWayPassageMarker).toEqual({ ...legacyMarker, text: undefined, textEnabled: undefined, textFontWeight: undefined, textSize: undefined, textColor: undefined });
    expect(result.oneWayPassageMarker).toEqual({ ...legacyMarker, text: undefined, textEnabled: undefined, textFontWeight: undefined, textSize: undefined, textColor: undefined });
  });

  it("prefers the current twoWayPassageMarker/oneWayPassageMarker fields over the legacy shared one", () => {
    const legacyMarker = { shape: "star", fillColor: 0x123456, borderColor: 0x654321, borderWidth: 5, gapWidth: 2, size: 0.3, cornerStyle: "round" };
    const twoWay = { ...legacyMarker, shape: "square", fillColor: 0x111111 };
    const oneWay = { ...legacyMarker, shape: "diamond", fillColor: 0x222222 };
    const result = validateVerticalSettingsFields(
      { verticalPassageMarker: legacyMarker, twoWayPassageMarker: twoWay, oneWayPassageMarker: oneWay },
      "path",
      DEFAULT_VERTICAL_SETTINGS,
    );
    expect(result.twoWayPassageMarker).toEqual({ ...twoWay, text: undefined, textEnabled: undefined, textFontWeight: undefined, textSize: undefined, textColor: undefined });
    expect(result.oneWayPassageMarker).toEqual({ ...oneWay, text: undefined, textEnabled: undefined, textFontWeight: undefined, textSize: undefined, textColor: undefined });
  });

  it("falls back to the default markers when neither the current nor the legacy field is present", () => {
    const result = validateVerticalSettingsFields({}, "path", DEFAULT_VERTICAL_SETTINGS);
    expect(result.twoWayPassageMarker).toEqual(DEFAULT_VERTICAL_SETTINGS.twoWayPassageMarker);
    expect(result.oneWayPassageMarker).toEqual(DEFAULT_VERTICAL_SETTINGS.oneWayPassageMarker);
  });
});

describe("validateVerticalDecorativeFields", () => {
  it("reads the current verticalStyle field as-is", () => {
    const result = validateVerticalDecorativeFields({ verticalStyle: "decorative" }, "path", DEFAULT_VERTICAL_DECORATIVE_SETTINGS);
    expect(result.verticalStyle).toBe("decorative");
  });

  it("migrates a pre-follow-up 'marker' legacy field to 'abstract'", () => {
    const result = validateVerticalDecorativeFields({ verticalPassageDisplayStyle: "marker" }, "path", DEFAULT_VERTICAL_DECORATIVE_SETTINGS);
    expect(result.verticalStyle).toBe("abstract");
  });

  it("migrates a pre-follow-up 'decorative' legacy field as-is", () => {
    const result = validateVerticalDecorativeFields({ verticalPassageDisplayStyle: "decorative" }, "path", DEFAULT_VERTICAL_DECORATIVE_SETTINGS);
    expect(result.verticalStyle).toBe("decorative");
  });

  it("falls back to the default when neither field is present", () => {
    const result = validateVerticalDecorativeFields({}, "path", DEFAULT_VERTICAL_DECORATIVE_SETTINGS);
    expect(result.verticalStyle).toBe(DEFAULT_VERTICAL_DECORATIVE_SETTINGS.verticalStyle);
  });

  it("falls back to the default for a stale/removed value (e.g. a pre-removal 'realistic' project file)", () => {
    const result = validateVerticalDecorativeFields({ verticalStyle: "realistic" }, "path", DEFAULT_VERTICAL_DECORATIVE_SETTINGS);
    expect(result.verticalStyle).toBe(DEFAULT_VERTICAL_DECORATIVE_SETTINGS.verticalStyle);
  });

  it("prefers the current field over a stale legacy field", () => {
    const result = validateVerticalDecorativeFields({ verticalStyle: "abstract", verticalPassageDisplayStyle: "decorative" }, "path", DEFAULT_VERTICAL_DECORATIVE_SETTINGS);
    expect(result.verticalStyle).toBe("abstract");
  });

  // Decorative line style fields (GitHub issue #428)
  it("reads decorativeStairsTwoWay/decorativeStairsOneWay/decorativeElevator as-is when valid", () => {
    const decorative = { lineColor: 0xabcdef, lineWidth: 4, size: 0.3 };
    const result = validateVerticalDecorativeFields(
      { decorativeStairsTwoWay: decorative, decorativeStairsOneWay: decorative, decorativeElevator: decorative },
      "path",
      DEFAULT_VERTICAL_DECORATIVE_SETTINGS,
    );
    expect(result.decorativeStairsTwoWay).toEqual(decorative);
    expect(result.decorativeStairsOneWay).toEqual(decorative);
    expect(result.decorativeElevator).toEqual(decorative);
  });

  it("falls back to the default decorative line styles when the fields are absent", () => {
    const result = validateVerticalDecorativeFields({}, "path", DEFAULT_VERTICAL_DECORATIVE_SETTINGS);
    expect(result.decorativeStairsTwoWay).toEqual(DEFAULT_VERTICAL_DECORATIVE_SETTINGS.decorativeStairsTwoWay);
    expect(result.decorativeStairsOneWay).toEqual(DEFAULT_VERTICAL_DECORATIVE_SETTINGS.decorativeStairsOneWay);
    expect(result.decorativeElevator).toEqual(DEFAULT_VERTICAL_DECORATIVE_SETTINGS.decorativeElevator);
  });

  it("reads decorativeStairsArrowColor/decorativeStairsArrowSize/decorativeStairsOneWayArrowColor/decorativeStairsOneWayArrowSize as-is when present", () => {
    const result = validateVerticalDecorativeFields(
      { decorativeStairsArrowColor: 0x123123, decorativeStairsArrowSize: 0.9, decorativeStairsOneWayArrowColor: 0x321321, decorativeStairsOneWayArrowSize: 0.8 },
      "path",
      DEFAULT_VERTICAL_DECORATIVE_SETTINGS,
    );
    expect(result.decorativeStairsArrowColor).toBe(0x123123);
    expect(result.decorativeStairsArrowSize).toBe(0.9);
    expect(result.decorativeStairsOneWayArrowColor).toBe(0x321321);
    expect(result.decorativeStairsOneWayArrowSize).toBe(0.8);
  });

  it("falls back to the default arrow color/size when the fields are absent", () => {
    const result = validateVerticalDecorativeFields({}, "path", DEFAULT_VERTICAL_DECORATIVE_SETTINGS);
    expect(result.decorativeStairsArrowColor).toBe(DEFAULT_VERTICAL_DECORATIVE_SETTINGS.decorativeStairsArrowColor);
    expect(result.decorativeStairsArrowSize).toBe(DEFAULT_VERTICAL_DECORATIVE_SETTINGS.decorativeStairsArrowSize);
    expect(result.decorativeStairsOneWayArrowColor).toBe(DEFAULT_VERTICAL_DECORATIVE_SETTINGS.decorativeStairsOneWayArrowColor);
    expect(result.decorativeStairsOneWayArrowSize).toBe(DEFAULT_VERTICAL_DECORATIVE_SETTINGS.decorativeStairsOneWayArrowSize);
  });
});

describe("validateDecorativeLineStyle", () => {
  const fallback = { lineColor: 0x111111, lineWidth: 2, size: 0.22 };

  it("reads a valid object's fields as-is", () => {
    const result = validateDecorativeLineStyle({ lineColor: 0xff0000, lineWidth: 5, size: 0.4 }, "path", fallback);
    expect(result).toEqual({ lineColor: 0xff0000, lineWidth: 5, size: 0.4 });
  });

  it("falls back to the given default when the value is null/undefined", () => {
    expect(validateDecorativeLineStyle(null, "path", fallback)).toEqual(fallback);
    expect(validateDecorativeLineStyle(undefined, "path", fallback)).toEqual(fallback);
  });

  it("falls back to the given default when the value isn't an object", () => {
    expect(validateDecorativeLineStyle("not an object", "path", fallback)).toEqual(fallback);
    expect(validateDecorativeLineStyle(42, "path", fallback)).toEqual(fallback);
  });

  it("fills in individually-missing fields from the fallback instead of discarding the whole object", () => {
    const result = validateDecorativeLineStyle({ lineColor: 0xff0000 }, "path", fallback);
    expect(result).toEqual({ lineColor: 0xff0000, lineWidth: fallback.lineWidth, size: fallback.size });
  });
});

// GitHub issue #485 — the cross-floor teleport floor-badge settings subsection.
describe("validateTeleportFloorBadgeSettings", () => {
  const fallback = DEFAULT_TELEPORT_SETTINGS.teleportFloorBadge;

  it("reads a valid object's fields as-is", () => {
    expect(validateTeleportFloorBadgeSettings({ shape: "hexagon", cornerStyle: "round", gapWidth: 3, labelType: "roman", size: 0.3, fillColor: 0x111111, borderColor: 0x222222, borderWidth: 7, textColor: 0xabcdef, textFontWeight: "regular", textSize: 20, textMargin: 3 }, "path", fallback))
      .toEqual({ shape: "hexagon", cornerStyle: "round", gapWidth: 3, labelType: "roman", size: 0.3, fillColor: 0x111111, borderColor: 0x222222, borderWidth: 7, textColor: 0xabcdef, textFontWeight: "regular", textSize: 20, textMargin: 3 });
  });

  it("falls back to the default for a missing object or invalid field", () => {
    expect(validateTeleportFloorBadgeSettings(undefined, "path", fallback)).toEqual(fallback);
    expect(validateTeleportFloorBadgeSettings({ shape: "bogus", labelType: "bogus" }, "path", fallback))
      .toEqual({ shape: fallback.shape, cornerStyle: fallback.cornerStyle, gapWidth: fallback.gapWidth, labelType: fallback.labelType, size: fallback.size, fillColor: fallback.fillColor, borderColor: fallback.borderColor, borderWidth: fallback.borderWidth, textColor: fallback.textColor, textFontWeight: fallback.textFontWeight, textSize: fallback.textSize, textMargin: fallback.textMargin });
  });

  it("clamps the text margin into its range", () => {
    expect(validateTeleportFloorBadgeSettings({ textMargin: 99 }, "path", fallback).textMargin).toBe(10);
    expect(validateTeleportFloorBadgeSettings({ textMargin: -4 }, "path", fallback).textMargin).toBe(0);
  });

  it("a project file predating the field recovers to the default badge", () => {
    const { teleportFloorBadge, ...preFieldObj } = DEFAULT_TELEPORT_SETTINGS;
    void teleportFloorBadge;
    expect(validateTeleportSettingsFields(preFieldObj, "path", DEFAULT_TELEPORT_SETTINGS).teleportFloorBadge)
      .toEqual(DEFAULT_TELEPORT_SETTINGS.teleportFloorBadge);
  });
});

// GitHub issue #510 — the "Round junctions" boolean was replaced by a Contour/Line rendering-mode enum.
describe("optRenderStyle (VectorByCorridorsSettings.renderStyle recovery)", () => {
  it("reads a valid value as-is", () => {
    expect(optRenderStyle({ renderStyle: "legacy_line" }, "renderStyle", "contour")).toBe("legacy_line");
    expect(optRenderStyle({ renderStyle: "contour" }, "renderStyle", "legacy_line")).toBe("contour");
  });

  it("recovers a pre-#510 project (missing field, or carrying only the removed roundJunctions boolean) to the fallback", () => {
    expect(optRenderStyle({}, "renderStyle", "contour")).toBe("contour");
    expect(optRenderStyle({ roundJunctions: true }, "renderStyle", "contour")).toBe("contour");
    expect(optRenderStyle({ renderStyle: "bogus" }, "renderStyle", "contour")).toBe("contour");
  });

  it("validateVectorByCorridorsSettings maps a legacy roundJunctions-only object onto renderStyle: 'contour'", () => {
    const { renderStyle, ...legacyObj } = DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS as typeof DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS & { roundJunctions?: boolean };
    void renderStyle;
    const recovered = validateVectorByCorridorsSettings({ ...legacyObj, roundJunctions: true }, "path", []);
    expect(recovered.renderStyle).toBe("contour");
  });

  it("validateVectorByCorridorsSettings keeps a stored junctionRadius and defaults a missing one", () => {
    const { junctionRadius, ...withoutRadius } = DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS;
    expect(validateVectorByCorridorsSettings({ ...withoutRadius, junctionRadius: 9 }, "path", []).junctionRadius).toBe(9);
    expect(validateVectorByCorridorsSettings(withoutRadius, "path", []).junctionRadius).toBe(junctionRadius);
    expect(validateVectorByCorridorsSettings({ ...withoutRadius, junctionRadius: "x" }, "path", []).junctionRadius).toBe(junctionRadius);
  });
});

describe("validateLinks (GitHub issue #651)", () => {
  const registry = VECTOR_BY_WALLS_PARAM_REGISTRY;
  const defaults = DEFAULT_VECTOR_BY_WALLS_LINKS;

  it("returns the fallback when the persisted value is null/absent", () => {
    expect(validateLinks(null, "path", defaults, registry)).toBe(defaults);
    expect(validateLinks(undefined, "path", defaults, registry)).toBe(defaults);
  });

  it("returns the fallback when the persisted value isn't an array", () => {
    expect(validateLinks("not-an-array", "path", defaults, registry)).toBe(defaults);
    expect(validateLinks({}, "path", defaults, registry)).toBe(defaults);
  });

  it("returns an explicit empty array as-is, distinct from null (user removed every link)", () => {
    expect(validateLinks([], "path", defaults, registry)).toEqual([]);
  });

  it("drops a malformed individual entry but keeps the rest", () => {
    const valid = defaults[0];
    const result = validateLinks([valid, { bogus: true }, "nonsense"], "path", defaults, registry);
    expect(result).toEqual([valid]);
  });

  it("parses modifiers on a valid entry", () => {
    const withModifiers = { ...defaults[0], modifiers: [{ op: "add", value: 2 }] };
    const result = validateLinks([withModifiers], "path", defaults, registry);
    expect(result[0].modifiers).toEqual([{ op: "add", value: 2 }]);
  });

  it("drops an invalid modifier entry while keeping the link itself (no modifiers)", () => {
    const withBadModifiers = { ...defaults[0], modifiers: [{ op: "bogus", value: 2 }] };
    const result = validateLinks([withBadModifiers], "path", defaults, registry);
    expect(result[0].modifiers).toBeUndefined();
  });

  it("falls back to the defaults when the array fails validateLinkGraph (duplicate target)", () => {
    const duplicateTarget = [defaults[0], { ...defaults[1], target: defaults[0].target }];
    expect(validateLinks(duplicateTarget, "path", defaults, registry)).toBe(defaults);
  });

  it("falls back to the defaults when a link references an unknown path", () => {
    const unknownPath = [{ id: "x", source: "not.a.real.path", target: "also.not.real", enabled: true }];
    expect(validateLinks(unknownPath, "path", defaults, registry)).toBe(defaults);
  });
});

// GitHub issue #701 — the new shared-style marker sources survive a project round trip.
describe("validateVectorByWallsSettings shared marker sources (GitHub issue #701)", () => {
  it("falls back to the default for missing / invalid markerShape and marker colors", () => {
    const d = DEFAULT_VECTOR_BY_WALLS_SETTINGS;
    const result = validateVectorByWallsSettings({ markerShape: "bogus", markerFillColor: "x" }, "path", DEFAULT_VECTOR_BY_WALLS_LINKS);
    expect(result.markerShape).toBe(d.markerShape);
    expect(result.markerFillColor).toBe(d.markerFillColor);
    expect(result.markerBorderColor).toBe(d.markerBorderColor);
  });

  it("reads valid values as-is", () => {
    const result = validateVectorByWallsSettings({ markerShape: "star", markerFillColor: 0x112233, markerBorderColor: 0x445566 }, "path", DEFAULT_VECTOR_BY_WALLS_LINKS);
    expect(result.markerShape).toBe("star");
    expect(result.markerFillColor).toBe(0x112233);
    expect(result.markerBorderColor).toBe(0x445566);
  });
});

describe("validateMarkerIndexSettings", () => {
  it("clamps the fixed plate width and height into their ranges and keeps a fractional margin", () => {
    const fb = DEFAULT_MARKER_INDEX_SETTINGS;
    expect(validateMarkerIndexSettings({ width: 99, height: 2 }, "path", fb)).toMatchObject({ width: 20, height: 8 });
    expect(validateMarkerIndexSettings({ width: 1 }, "path", fb).width).toBe(8);
    expect(validateMarkerIndexSettings({ textMargin: 1.5 }, "path", fb).textMargin).toBe(1.5);
  });
});

describe("validateFloorLabelSettings", () => {
  it("clamps persisted floor-label size and width to the panel ranges", () => {
    const fallback = DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorLabel;
    expect(validateFloorLabelSettings({ textSize: 999, width: 999 }, "path", fallback)).toMatchObject({ textSize: 72, width: 250 });
    expect(validateFloorLabelSettings({ textSize: 1, width: 1 }, "path", fallback)).toMatchObject({ textSize: 6, width: 20 });
  });
});
