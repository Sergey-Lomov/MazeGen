import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// GitHub issue #927 — a settings-panel component may not read maze/store state of its own to decide what
// to show: every visibility condition comes from `useExportPanelModel` (the maze-derived flags that the
// schema's activity rules read too) or from the panel's own settings. A condition built on a store field
// the schema rules never see would hide a field the schema calls active, and the panel-vs-schema test
// cannot notice it. Reading the store for anything else (actions, drag state, data a row displays) is
// listed below with the reason; a new read fails here until it is listed.

const featuresDir = join(__dirname, "..", "components", "features");

/** Components that render link-aware rows: the panels and every subsection under them. */
function settingsPanelFiles(): string[] {
  return readdirSync(featuresDir)
    .filter((name) => name.endsWith(".tsx"))
    .filter((name) => /Linked(Select|Slider|Color|Toggle|TextField)Row|LinkContextProvider/.test(readFileSync(join(featuresDir, name), "utf8")));
}

/** Store actions (`setX`, `patchX`, ...) are not state. */
const ACTION = /^(set|patch|add|remove|reset|start|finish|toggle|open|close|clear)[A-Z]/;

/** `file: selector expression` of every store read that is not an action. */
let cachedReads: string[] | undefined;
function stateReads(): string[] {
  cachedReads ??= scanStateReads();
  return cachedReads;
}

function scanStateReads(): string[] {
  const reads: string[] = [];
  for (const name of settingsPanelFiles()) {
    const source = readFileSync(join(featuresDir, name), "utf8");
    for (const match of source.matchAll(/useMazeStore\(\s*\((\w+)\)\s*=>\s*([^;]*?)\);/g)) {
      const expression = match[2].trim();
      const simple = new RegExp(`^${match[1]}\\.(\\w+)$`).exec(expression);
      if (simple && ACTION.test(simple[1])) continue;
      reads.push(`${name}: ${expression.replace(new RegExp(`\\b${match[1]}\\.`, "g"), "s.")}`);
    }
  }
  return reads.sort();
}

const ALLOWED_STATE_READS: Record<string, string> = {
  "EdgeMarkerSettingsSubsection.tsx: s.activeFieldConfig": "data of the per-edge override list it displays",
  "EdgeMarkerSettingsSubsection.tsx: s.activeFloorId": "data of the per-edge override list it displays",
  "EdgeMarkerSettingsSubsection.tsx: s.floorCreases": "data of the per-edge override list it displays",
  "EdgeMarkerSettingsSubsection.tsx: s.floorTopology": "data of the per-edge override list it displays",
  "EdgeMarkerSettingsSubsection.tsx: s.floors": "data of the per-edge override list it displays",
  "EdgeMarkerSettingsSubsection.tsx: s.nodes": "data of the per-edge override list it displays",
  "EdgeMarkerSettingsSubsection.tsx: s.pngExportSettings": "data of the per-edge override list it displays",
  "FloorLabelSection.tsx: s.floorFields[s.activeFloorId].fieldConfig": "geometry of the label drag preview",
  "FloorLabelSection.tsx: s.floorLabelDrag": "transient drag state of the label preview",
  "FloorLabelSection.tsx: s.floors": "floor titles shown in the label preview",
  "FloorLabelSection.tsx: s.nodes": "geometry of the label drag preview",
  "SharedStyleSection.tsx: s.linkIconVisibility": "the link-icon visibility setting itself, not a field's visibility",
  "VectorByCorridorsSettingsPanel.tsx: s.showColorWarnings": "toggle of the warnings block, not a settings field",
  "VectorByCorridorsSettingsPanel.tsx: s.vectorByCorridorsSectionsExpanded": "collapse state of the sections",
  "VectorByCorridorsSettingsPanel.tsx: s.vectorByCorridorsSettings": "the panel's own settings",
  "VectorByWallsSettingsPanel.tsx: s.showColorWarnings": "toggle of the warnings block, not a settings field",
  "VectorByWallsSettingsPanel.tsx: s.vectorByWallsSectionsExpanded": "collapse state of the sections",
  "VectorByWallsSettingsPanel.tsx: s.vectorByWallsSettings": "the panel's own settings",
};

describe("settings panel store reads", () => {
  it("every state read of a settings component is listed with a reason", () => {
    expect(stateReads().filter((read) => !(read in ALLOWED_STATE_READS))).toEqual([]);
  });

  it("the list holds no stale entries", () => {
    const reads = new Set(stateReads());
    expect(Object.keys(ALLOWED_STATE_READS).filter((read) => !reads.has(read))).toEqual([]);
  });

  it("finds the settings components", () => {
    const files = settingsPanelFiles();
    expect(files).toContain("VectorByWallsSettingsPanel.tsx");
    expect(files).toContain("VectorByCorridorsSettingsPanel.tsx");
  });
});
