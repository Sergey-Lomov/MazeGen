import { describe, it, expect } from "vitest";
import { parseAndValidate, serializeProject } from "../store/projectExport";
import { makeState, toJson } from "./projectExportKit";

describe("serializeProject / parseAndValidate round-trip: underlay and settings", () => {
  it("round-trips the synchronized editor underlay", () => {
    const serialized = serializeProject(makeState({
      showBackgroundImage: true,
      backgroundImageManualPositioning: false,
      backgroundImageCropping: true,
      backgroundImage: {
        dataUrl: "data:image/png;base64,abc",
        naturalWidth: 200,
        naturalHeight: 100,
        cropX: 20,
        cropY: 10,
        cropWidth: 150,
        cropHeight: 70,
        displayWidth: 400,
        displayHeight: 200,
        centerX: 12,
        centerY: -8,
        layer: "above_floor",
        opacity: 0.35,
      },
    }));
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.showBackgroundImage).toBe(true);
    expect(reparsed.backgroundImageManualPositioning).toBe(false);
    expect(reparsed.backgroundImageCropping).toBe(true);
    expect(reparsed.backgroundImage).toEqual(serialized.backgroundImage);
  });

  it("defaults new underlay settings when loading a file saved before issue #674", () => {
    const raw = JSON.parse(JSON.stringify(serializeProject(makeState({
      backgroundImage: {
        dataUrl: "data:image/png;base64,abc",
        naturalWidth: 100,
        naturalHeight: 100,
        displayWidth: 100,
        displayHeight: 100,
        centerX: 0,
        centerY: 0,
        layer: "below_grid",
        opacity: 0.5,
      },
    }))));
    delete raw.backgroundImage.layer;
    delete raw.backgroundImage.opacity;
    delete raw.backgroundImage.cropX;
    delete raw.backgroundImage.cropY;
    delete raw.backgroundImage.cropWidth;
    delete raw.backgroundImage.cropHeight;
    delete raw.backgroundImageManualPositioning;
    delete raw.backgroundImageCropping;

    const reparsed = parseAndValidate(raw);
    expect(reparsed.backgroundImage).toMatchObject({ layer: "below_grid", opacity: 0.5 });
    expect(reparsed.backgroundImage).toMatchObject({ cropX: 0, cropY: 0, cropWidth: 100, cropHeight: 100 });
    expect(reparsed.backgroundImageManualPositioning).toBe(false);
    expect(reparsed.backgroundImageCropping).toBe(false);
  });

  it("does not enable an underlay without persisted image data", () => {
    const serialized = serializeProject(makeState({ showBackgroundImage: true, backgroundImage: null }));
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.showBackgroundImage).toBe(false);
    expect(reparsed.backgroundImage).toBeNull();
  });

  it("rejects non-positive persisted underlay dimensions", () => {
    const serialized = serializeProject(makeState({
      backgroundImage: {
        dataUrl: "data:image/png;base64,abc",
        naturalWidth: 0,
        naturalHeight: 100,
        displayWidth: 200,
        displayHeight: 200,
        centerX: 0,
        centerY: 0,
        layer: "below_grid",
        opacity: 0.5,
      },
    }));
    expect(() => parseAndValidate(JSON.parse(JSON.stringify(serialized)))).toThrow(/backgroundImage\.naturalWidth/);
  });

  it("round-trips the export color-warning visibility setting", () => {
    const state = makeState({ showColorWarnings: false });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.imageExport.showColorWarnings).toBe(false);
  });

  it("defaults export color-warning visibility on files saved before the setting existed", () => {
    const raw = toJson(makeState());
    delete raw.imageExport.showColorWarnings;
    expect(parseAndValidate(raw).imageExport.showColorWarnings).toBe(true);
  });

  it("round-trips a non-default linkIconVisibility (GitHub issue #652 follow-up)", () => {
    const state = makeState({ linkIconVisibility: "always" });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.imageExport.linkIconVisibility).toBe("always");
  });

  it("falls back to 'linked' for a missing or unknown linkIconVisibility", () => {
    const raw = toJson(makeState());
    delete raw.imageExport.linkIconVisibility;
    expect(parseAndValidate(raw).imageExport.linkIconVisibility).toBe("linked");

    raw.imageExport.linkIconVisibility = "not_a_real_value";
    expect(parseAndValidate(raw).imageExport.linkIconVisibility).toBe("linked");
  });

  it("round-trips explicitly disabled repair limits (both null), not the default", () => {
    const state = makeState({ repairMaxIterations: null, repairTimeBudgetSecs: null });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.quality.repairMaxIterations).toBeNull();
    expect(reparsed.quality.repairTimeBudgetSecs).toBeNull();
  });

  it("defaults showPureCyclesOverlay/showRegionClassesOverlay for a project file saved before these toggles existed", () => {
    const state = makeState({ showPureCyclesOverlay: true, showRegionClassesOverlay: true });
    const serialized = serializeProject(state);
    const raw = JSON.parse(JSON.stringify(serialized));
    delete raw.analytics.showPureCyclesOverlay;
    delete raw.analytics.showRegionClassesOverlay;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.analytics.showPureCyclesOverlay).toBe(false);
    expect(reparsed.analytics.showRegionClassesOverlay).toBe(false);
  });

  it("defaults generation.qcExperiment to false for a project file saved before this toggle existed", () => {
    const state = makeState({ qcExperiment: true });
    const serialized = serializeProject(state);
    const raw = JSON.parse(JSON.stringify(serialized));
    delete raw.generation.qcExperiment;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.generation.qcExperiment).toBe(false);
  });

  it("defaults generation.vertexSettingsPanelOpen to false for a project file saved before this toggle existed", () => {
    const state = makeState({ vertexSettingsPanelOpen: true });
    const serialized = serializeProject(state);
    const raw = JSON.parse(JSON.stringify(serialized));
    delete raw.generation.vertexSettingsPanelOpen;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.generation.vertexSettingsPanelOpen).toBe(false);
  });
});
