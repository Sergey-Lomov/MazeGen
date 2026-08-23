import { describe, it, expect } from "vitest";
import { validateVerticalSettingsFields, validateDecorativeLineStyle } from "../store/projectExport/validateImageExport";
import { DEFAULT_VERTICAL_SETTINGS } from "../store/slices/imageExportDefaults";

describe("validateVerticalSettingsFields", () => {
  it("reads the current verticalStyle field as-is", () => {
    const result = validateVerticalSettingsFields({ verticalStyle: "decorative" }, "path", DEFAULT_VERTICAL_SETTINGS);
    expect(result.verticalStyle).toBe("decorative");
  });

  it("accepts the reserved 'realistic' value", () => {
    const result = validateVerticalSettingsFields({ verticalStyle: "realistic" }, "path", DEFAULT_VERTICAL_SETTINGS);
    expect(result.verticalStyle).toBe("realistic");
  });

  it("migrates a pre-follow-up 'marker' legacy field to 'abstract'", () => {
    const result = validateVerticalSettingsFields({ verticalPassageDisplayStyle: "marker" }, "path", DEFAULT_VERTICAL_SETTINGS);
    expect(result.verticalStyle).toBe("abstract");
  });

  it("migrates a pre-follow-up 'decorative' legacy field as-is", () => {
    const result = validateVerticalSettingsFields({ verticalPassageDisplayStyle: "decorative" }, "path", DEFAULT_VERTICAL_SETTINGS);
    expect(result.verticalStyle).toBe("decorative");
  });

  it("falls back to the default when neither field is present", () => {
    const result = validateVerticalSettingsFields({}, "path", DEFAULT_VERTICAL_SETTINGS);
    expect(result.verticalStyle).toBe(DEFAULT_VERTICAL_SETTINGS.verticalStyle);
  });

  it("prefers the current field over a stale legacy field", () => {
    const result = validateVerticalSettingsFields({ verticalStyle: "abstract", verticalPassageDisplayStyle: "decorative" }, "path", DEFAULT_VERTICAL_SETTINGS);
    expect(result.verticalStyle).toBe("abstract");
  });

  // Arrow style/corner-style fields (GitHub issue #347 third follow-up)
  it("reads twoWayArrowStyle/twoWayArrowCornerStyle as-is when valid", () => {
    const result = validateVerticalSettingsFields({ twoWayArrowStyle: "chevron", twoWayArrowCornerStyle: "miter" }, "path", DEFAULT_VERTICAL_SETTINGS);
    expect(result.twoWayArrowStyle).toBe("chevron");
    expect(result.twoWayArrowCornerStyle).toBe("miter");
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
    expect(result.twoWayPassageMarker).toEqual(legacyMarker);
    expect(result.oneWayPassageMarker).toEqual(legacyMarker);
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
    expect(result.twoWayPassageMarker).toEqual(twoWay);
    expect(result.oneWayPassageMarker).toEqual(oneWay);
  });

  it("falls back to the default markers when neither the current nor the legacy field is present", () => {
    const result = validateVerticalSettingsFields({}, "path", DEFAULT_VERTICAL_SETTINGS);
    expect(result.twoWayPassageMarker).toEqual(DEFAULT_VERTICAL_SETTINGS.twoWayPassageMarker);
    expect(result.oneWayPassageMarker).toEqual(DEFAULT_VERTICAL_SETTINGS.oneWayPassageMarker);
  });

  // Decorative line style fields (GitHub issue #428)
  it("reads decorativeStairsTwoWay/decorativeStairsOneWay/decorativeElevator as-is when valid", () => {
    const decorative = { lineColor: 0xabcdef, lineWidth: 4, size: 0.3 };
    const result = validateVerticalSettingsFields(
      { decorativeStairsTwoWay: decorative, decorativeStairsOneWay: decorative, decorativeElevator: decorative },
      "path",
      DEFAULT_VERTICAL_SETTINGS,
    );
    expect(result.decorativeStairsTwoWay).toEqual(decorative);
    expect(result.decorativeStairsOneWay).toEqual(decorative);
    expect(result.decorativeElevator).toEqual(decorative);
  });

  it("falls back to the default decorative line styles when the fields are absent", () => {
    const result = validateVerticalSettingsFields({}, "path", DEFAULT_VERTICAL_SETTINGS);
    expect(result.decorativeStairsTwoWay).toEqual(DEFAULT_VERTICAL_SETTINGS.decorativeStairsTwoWay);
    expect(result.decorativeStairsOneWay).toEqual(DEFAULT_VERTICAL_SETTINGS.decorativeStairsOneWay);
    expect(result.decorativeElevator).toEqual(DEFAULT_VERTICAL_SETTINGS.decorativeElevator);
  });

  it("reads decorativeStairsArrowColor/decorativeStairsArrowSize/decorativeStairsAccentColor as-is when present", () => {
    const result = validateVerticalSettingsFields(
      { decorativeStairsArrowColor: 0x123123, decorativeStairsArrowSize: 0.9, decorativeStairsAccentColor: 0x321321 },
      "path",
      DEFAULT_VERTICAL_SETTINGS,
    );
    expect(result.decorativeStairsArrowColor).toBe(0x123123);
    expect(result.decorativeStairsArrowSize).toBe(0.9);
    expect(result.decorativeStairsAccentColor).toBe(0x321321);
  });

  it("falls back to the default arrow color/size/accent color when the fields are absent", () => {
    const result = validateVerticalSettingsFields({}, "path", DEFAULT_VERTICAL_SETTINGS);
    expect(result.decorativeStairsArrowColor).toBe(DEFAULT_VERTICAL_SETTINGS.decorativeStairsArrowColor);
    expect(result.decorativeStairsArrowSize).toBe(DEFAULT_VERTICAL_SETTINGS.decorativeStairsArrowSize);
    expect(result.decorativeStairsAccentColor).toBe(DEFAULT_VERTICAL_SETTINGS.decorativeStairsAccentColor);
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
