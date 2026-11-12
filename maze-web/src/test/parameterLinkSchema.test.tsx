import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { and, byMode, isGateOpen } from "../store/parameterLinkRules";
import { LINK_SCHEMA, patchPaths, schemaEntriesFor, type LinkMode, type LinkPath } from "../store/parameterLinkSchema";
import { VECTOR_BY_WALLS_PARAM_REGISTRY, VECTOR_BY_CORRIDORS_PARAM_REGISTRY } from "../store/parameterLinksRegistry";
import { computeActivePaths, isPathActive, type ParamActivityContext, type ParamActivitySettings } from "../store/parameterLinksActivity";
import { applyLinkedPatch, getParamValue, propagateLinkedSources, setParamValue, writeLinkedParam } from "../store/slices/parameterLinksEngine";
import { DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS, DEFAULT_VECTOR_BY_WALLS_SETTINGS } from "../store/slices/imageExportDefaults";
import { LinkStatusIcon } from "../components/LinkStatusIcon";
import { useMazeStore } from "../store/mazeStore";
import type { ParamLink } from "../store/parameterLinks";

// GitHub issue #927 — the declarative link schema is the single source of the parameter registries,
// the activity rules and the link-aware patch metadata; these checks keep the UI and the state
// updates from drifting away from it.

const MODES: LinkMode[] = ["walls", "corridors"];
const REGISTRY = { walls: VECTOR_BY_WALLS_PARAM_REGISTRY, corridors: VECTOR_BY_CORRIDORS_PARAM_REGISTRY } as const;
const DEFAULTS = { walls: DEFAULT_VECTOR_BY_WALLS_SETTINGS, corridors: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS } as const;

type Settings = (typeof DEFAULTS)[LinkMode];

describe("registries derived from the schema", () => {
  it.each(MODES)("%s registry has exactly the paths declared for the mode", (mode) => {
    expect(Object.keys(REGISTRY[mode]).sort()).toEqual(schemaEntriesFor(mode).map(([path]) => path).sort());
  });

  it.each(MODES)("%s: every declared path has a value in the default settings", (mode) => {
    for (const [path] of schemaEntriesFor(mode)) {
      expect(getParamValue(DEFAULTS[mode], path), `${mode}: ${path}`).toBeDefined();
    }
  });
});

/** Settings leaves that are deliberately not linkable, each with the reason. Everything else a mode's
 *  settings object holds must be declared in `LINK_SCHEMA` — a field added to the settings without a
 *  schema entry (or parked behind `linkTarget={null}`) fails the coverage check below. */
const NOT_LINKABLE: Record<string, string> = {
  "creases.mode": "crease display mode: the other crease fields follow it, so it is not linkable (GitHub issue #924)",
  "edgeMarkers.mode": "edge-marker coverage mode: it gates the other edge-marker fields",
  trimWallsAtFaceBoundaries: "linkable in 'Vector by walls' only: the corridors settings carry the leaf but nothing reads it",
  randomWallColorMode: "enum without a `ParamType`; the panel row passes `linkTarget={null}`",
  oneWayPattern: "enum without a `ParamType`; the panel row passes `linkTarget={null}`",
  renderStyle: "enum without a `ParamType`; selects the corridors rendering style",
  "startMarker.text": "free text, not a numeric/enum parameter",
  "finishMarker.text": "free text, not a numeric/enum parameter",
  markerWidenShape: "enum without a `ParamType`",
  teleportConnectorWidth: "number the panel leaves unlinked today (`linkTarget={null}`)",
  teleportConnectorStyle: "enum without a `ParamType`; it gates the other connector fields",
  teleportArrowMode: "enum without a `ParamType`; the panel row passes `linkTarget={null}`",
  teleportArrowPeriod: "number the panel leaves unlinked today (`linkTarget={null}`)",
  teleportArrowSize: "number the panel leaves unlinked today (`linkTarget={null}`)",
  "elevatorBadges.placement": "enum without a `ParamType`; the panel row passes `linkTarget={null}`",
  verticalStyle: "enum without a `ParamType`; it switches the abstract/decorative field sets",
  splitNodeColors: "split-node colour table, not a scalar parameter",
  "floorLabel.labelMode": "enum without a `ParamType`; it gates the other floor-label fields",
  "floorLabel.prefix": "free text",
  "floorLabel.textAlignment": "enum without a `ParamType`",
  "floorLabel.backgroundShape": "enum without a `ParamType`; it gates the other floor-label fields",
  markerLayout: "marker layout mode, not a numeric/enum link parameter",
};

/** Dot-paths of every scalar leaf of `value` (arrays and `links` are state, not parameters). A label
 *  font `{ family, weight }` is one leaf: it is a single linked parameter (GitHub issue #973). */
function scalarLeaves(value: unknown, prefix = ""): string[] {
  const isLabelFont = typeof value === "object" && value !== null && Object.keys(value).sort().join() === "family,weight";
  if (value === null || typeof value !== "object" || Array.isArray(value) || isLabelFont) return prefix === "" ? [] : [prefix];
  return Object.entries(value).flatMap(([key, child]) => (prefix === "" && key === "links" ? [] : scalarLeaves(child, prefix === "" ? key : `${prefix}.${key}`)));
}

describe("settings coverage", () => {
  it.each(MODES)("%s: every settings leaf is declared in the schema or listed as not linkable", (mode) => {
    const declared = new Set<string>(schemaEntriesFor(mode).map(([path]) => path));
    const uncovered = scalarLeaves(DEFAULTS[mode]).filter((leaf) => !declared.has(leaf) && !(leaf in NOT_LINKABLE));
    expect(uncovered).toEqual([]);
  });

  it("the not-linkable list holds no stale entries", () => {
    const undeclaredIn = (leaf: string) => MODES.some((mode) => scalarLeaves(DEFAULTS[mode]).includes(leaf) && !schemaEntriesFor(mode).some(([path]) => path === leaf));
    expect(Object.keys(NOT_LINKABLE).filter((leaf) => !undeclaredIn(leaf))).toEqual([]);
  });
});

describe("per-mode activity rules", () => {
  const ctx = {} as ParamActivityContext;
  const rule = byMode({ walls: (_, s) => s.showGrid === true });

  it("applies the rule of the asked mode and leaves a mode without a rule unrestricted", () => {
    expect(rule(ctx, { showGrid: false }, "walls")).toBe(false);
    expect(rule(ctx, { showGrid: true }, "walls")).toBe(true);
    expect(rule(ctx, { showGrid: false }, "corridors")).toBe(true);
  });

  it("isGateOpen asks the named rule with the mode and the settings", () => {
    expect(isGateOpen("glues", "walls", { ...ctx, hasGlues: true }, {})).toBe(true);
    expect(isGateOpen("glues", "corridors", { ...ctx, hasGlues: false }, {})).toBe(false);
    expect(isGateOpen("cutLines", "walls", { ...ctx, hasGlues: true }, { showCutLines: false })).toBe(false);
    expect(isGateOpen("cutLines", "walls", { ...ctx, hasGlues: true }, {})).toBe(true);
  });

  it("and ignores absent rules and needs every present rule", () => {
    const yes = () => true;
    const no = () => false;
    expect(and(undefined, yes)(ctx, {}, "walls")).toBe(true);
    expect(and(yes, undefined, no)(ctx, {}, "walls")).toBe(false);
    expect(and()(ctx, {}, "walls")).toBe(true);
  });
});

describe("UI link targets", () => {
  const featuresDir = join(__dirname, "..", "components", "features");

  /** The string literals inside every `linkTarget={...}`/`linkTargets={{...}}` attribute of `source`. */
  function linkTargetLiterals(source: string): string[] {
    const found: string[] = [];
    for (const match of source.matchAll(/linkTargets?=\{/g)) {
      let depth = 1;
      let i = match.index! + match[0].length;
      const start = i;
      while (i < source.length && depth > 0) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") depth--;
        i++;
      }
      for (const literal of source.slice(start, i - 1).matchAll(/"([A-Za-z][A-Za-z0-9.]*)"/g)) found.push(literal[1]);
    }
    return found;
  }

  it("every literal link target in the settings components is declared by the schema", () => {
    const files = readdirSync(featuresDir).filter((name) => name.endsWith(".tsx"));
    const undeclared: string[] = [];
    let checked = 0;
    for (const file of files) {
      for (const literal of linkTargetLiterals(readFileSync(join(featuresDir, file), "utf8"))) {
        checked++;
        if (!(literal in LINK_SCHEMA)) undeclared.push(`${file}: ${literal}`);
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(undeclared).toEqual([]);
  });
});

describe("link-status icon", () => {
  beforeEach(() => {
    useMazeStore.setState({ linkIconVisibility: "always" });
  });

  it.each(MODES)("%s: every declared field renders an icon when visibility is 'always'", (mode) => {
    const registry = REGISTRY[mode] as Record<string, (typeof VECTOR_BY_WALLS_PARAM_REGISTRY)[keyof typeof VECTOR_BY_WALLS_PARAM_REGISTRY]>;
    for (const [path] of schemaEntriesFor(mode)) {
      const { container, unmount } = render(
        <LinkStatusIcon<string> target={path} links={[]} registry={registry} onSetLinkEnabled={vi.fn()} onAddLink={vi.fn()} activePaths={new Set<string>([path])} />,
      );
      expect(container.querySelector("svg"), `${mode}: ${path}`).not.toBeNull();
      unmount();
    }
  });
});

describe("link-aware state updates", () => {
  /** Another declared path of the same value type, to act as the other end of a link. */
  function peerOf(mode: LinkMode, path: LinkPath): string {
    const type = LINK_SCHEMA[path].type;
    const peer = schemaEntriesFor(mode).find(([other, def]) => other !== path && def.type === type);
    // A value type used by a single field (an enum) is linked to a stand-in path.
    return peer ? peer[0] : "standIn";
  }

  /** `settings` with `path` set to a value different from the current one. */
  function changedValue(settings: Settings, path: string): unknown {
    const current = getParamValue(settings, path);
    if (typeof current === "number") return current + 1;
    if (typeof current === "boolean") return !current;
    return current === "round" ? "miter" : "round";
  }

  it.each(MODES)("%s: every declared field detaches its incoming link on a hand edit", (mode) => {
    for (const [path, def] of schemaEntriesFor(mode)) {
      if (def.update === "source") continue;
      const peer = peerOf(mode, path);
      const link: ParamLink<string> = { id: "l", source: peer, target: path, enabled: true };
      const settings = { ...DEFAULTS[mode], links: [link] } as Settings;
      const value = changedValue(settings, path);

      let detached: boolean;
      if (def.update === "param") {
        detached = writeLinkedParam(settings, path, value).links[0].enabled === false;
      } else {
        const overridable = patchPaths<string>(mode, def.update);
        expect(overridable, `${mode}: ${path} in ${def.update}`).toContain(path);
        const rootPatch = setParamValue({}, path, value);
        const next = setParamValue(settings, path, value) as Settings;
        detached = applyLinkedPatch(settings, next, rootPatch, overridable).links[0].enabled === false;
      }
      expect(detached, `${mode}: ${path} (${def.update})`).toBe(true);
    }
  });

  it.each(MODES)("%s: every field declared as a source refreshes its dependents", (mode) => {
    for (const [path, def] of schemaEntriesFor(mode)) {
      if (def.update !== "source") continue;
      const peer = peerOf(mode, path);
      const link: ParamLink<string> = { id: "l", source: path, target: peer, enabled: true };
      const settings = { ...DEFAULTS[mode], links: [link] } as Settings;
      const value = changedValue(settings, path);
      const next = propagateLinkedSources<string, { links: ParamLink<string>[] }>(setParamValue(settings, path, value) as unknown as { links: ParamLink<string>[] }, [path]);
      expect(getParamValue(next, peer), `${mode}: ${path}`).toBe(value);
    }
  });
});

describe("activity rules", () => {
  const ALL_FLAGS: ParamActivityContext = {
    hasOneWays: true, hasTeleports: true, hasCrossFloorTeleports: true, hasTwoWayPassages: true, hasOneWayPassages: true,
    hasElevators: true, hasVerticalSection: true, hasMarkerIndexSource: true, hasMultipleFloors: true, hasAreaSpread: true, hasSeams: true,
    hasSplits: true, hasGlues: true, hasCreases: true,
  };
  const NO_FLAGS: ParamActivityContext = {
    hasOneWays: false, hasTeleports: false, hasCrossFloorTeleports: false, hasTwoWayPassages: false, hasOneWayPassages: false,
    hasElevators: false, hasVerticalSection: false, hasMarkerIndexSource: false, hasMultipleFloors: false, hasAreaSpread: false, hasSeams: false,
    hasSplits: false, hasGlues: false, hasCreases: false,
  };
  const floorLabel = { enabled: true, labelMode: "index", backgroundShape: "rectangle" } as const;
  const toggles = { teleportArrowMode: "periodic", splitSpecialShapes: true, join: "round", renderStyle: "contour", teleportGroupCustomization: true, showCutLines: true, cutLinesGlueColor: false, edgeMarkers: { mode: "all" }, glueTabs: { showTabs: true, lineWidth: 1 }, creases: { showCreases: true, mode: "lines" } } as const;
  const SETTINGS: Record<string, ParamActivitySettings> = {
    abstract: { ...toggles, verticalStyle: "abstract", teleportConnectorStyle: "orthogonal", floorLabel },
    decorative: { ...toggles, verticalStyle: "decorative", teleportConnectorStyle: "curved", floorLabel },
    corridors: { ...toggles, teleportConnectorStyle: "orthogonal", floorLabel },
  };

  const activeIn = (mode: LinkMode, ctx: ParamActivityContext, settings: ParamActivitySettings) =>
    computeActivePaths(REGISTRY[mode] as Record<string, never>, mode, ctx, settings);

  it("a maze without any special element hides every maze-gated field", () => {
    for (const mode of MODES) {
      const active = activeIn(mode, NO_FLAGS, SETTINGS.abstract);
      for (const gated of ["teleportMarker.size", "oneWayColor", "elevatorMarker.size", "markerIndex.enabled", "floorLabel.enabled", "twoWayArrowColor", "verticalSize", "markerSizeAdaptation"]) {
        if (gated in REGISTRY[mode]) expect(active.has(gated), `${mode}: ${gated}`).toBe(false);
      }
    }
  });

  it("every field of a mode is reachable in some maze/settings combination", () => {
    const marks = { ...SETTINGS.abstract, creases: { showCreases: true, mode: "marks" } } as ParamActivitySettings;
    const combos: [LinkMode, ParamActivitySettings][] = [["walls", SETTINGS.abstract], ["walls", marks], ["walls", SETTINGS.decorative], ["corridors", SETTINGS.corridors], ["corridors", { ...SETTINGS.corridors, teleportConnectorStyle: "curved" }], ["corridors", { ...SETTINGS.corridors, creases: { showCreases: true, mode: "marks" } }]];
    for (const mode of MODES) {
      const reachable = new Set<string>();
      for (const [m, settings] of combos) {
        if (m !== mode) continue;
        for (const path of activeIn(mode, ALL_FLAGS, settings)) reachable.add(path);
      }
      const unreachable = schemaEntriesFor(mode).map(([path]) => path as string).filter((path) => !reachable.has(path));
      // Fields hidden by a toggle that is on in these settings by default can not be reached here.
      expect(unreachable, mode).toEqual([]);
    }
  });

  it("abstract-only fields are inactive in the decorative style and vice versa ('Vector by walls')", () => {
    const abstractOnly = ["verticalSize", "verticalCornerStyle", "twoWayArrowColor", "oneWayArrowSize", "elevatorArrowStyle", "twoWayPassageMarker.size", "elevatorMarker.fillColor"];
    const decorativeOnly = ["verticalDecorativeSize", "decorativeStairsArrowColor", "decorativeStairsOneWayArrowSize", "decorativeElevator.lineColor", "decorativeStairsTwoWay.size"];
    const abstractActive = activeIn("walls", ALL_FLAGS, SETTINGS.abstract);
    const decorativeActive = activeIn("walls", ALL_FLAGS, SETTINGS.decorative);
    for (const path of abstractOnly) {
      expect(abstractActive.has(path), path).toBe(true);
      expect(decorativeActive.has(path), path).toBe(false);
    }
    for (const path of decorativeOnly) {
      expect(abstractActive.has(path), path).toBe(false);
      expect(decorativeActive.has(path), path).toBe(true);
    }
  });

  it("decorative-only fields are not declared for 'Vector by corridors', which has no vertical style", () => {
    for (const [path] of schemaEntriesFor("corridors")) {
      expect(path, path).not.toMatch(/^decorative|Decorative/);
    }
  });

  it("connector style, text toggles and tab/grid switches gate their dependent fields", () => {
    const ctx = ALL_FLAGS;
    expect(isPathActive("teleportCurveStrength", "walls", ctx, { teleportConnectorStyle: "curved" })).toBe(true);
    expect(isPathActive("teleportCurveStrength", "walls", ctx, { teleportConnectorStyle: "orthogonal" })).toBe(false);
    expect(isPathActive("teleportConnectorCornerStyle", "walls", ctx, { teleportConnectorStyle: "orthogonal" })).toBe(true);
    expect(isPathActive("startMarker.textSize", "walls", ctx, { startMarker: { textEnabled: false } })).toBe(false);
    expect(isPathActive("finishMarker.textSize", "walls", ctx, { startMarker: { textEnabled: false } })).toBe(true);
    expect(isPathActive("teleportConnectorColor", "walls", ctx, { teleportConnectorStyle: "none" })).toBe(false);
    expect(isPathActive("teleportAvoidFieldExit", "walls", ctx, { teleportConnectorStyle: "orthogonal" })).toBe(true);
    expect(isPathActive("teleportAvoidFieldExit", "walls", ctx, { teleportConnectorStyle: "curved" })).toBe(false);
    expect(isPathActive("glueTabs.showTabs", "walls", { ...ctx, hasGlues: false }, {})).toBe(false);
    expect(isPathActive("edgeMarkers.color", "walls", { ...ctx, hasGlues: true }, { edgeMarkers: { mode: "all" } })).toBe(true);
    expect(isPathActive("edgeMarkers.color", "walls", { ...ctx, hasGlues: false, hasCreases: true }, { edgeMarkers: { mode: "all" } })).toBe(false);
    expect(isPathActive("splitSpecialShapes", "walls", { ...ctx, hasSplits: false }, {})).toBe(false);
    expect(isPathActive("glueTabs.inset", "walls", ctx, { glueTabs: { showTabs: false, lineWidth: 1 } })).toBe(false);
    expect(isPathActive("glueTabs.lineColor", "walls", ctx, { glueTabs: { showTabs: true, lineWidth: 0 } })).toBe(false);
  });
});

describe("elevator badge link groups mirror the panel subsections", () => {
  const groupOf = (mode: LinkMode, path: string) => {
    const entry = schemaEntriesFor(mode).find(([p]) => p === path);
    expect(entry, path).toBeDefined();
    return entry![1].group(mode);
  };
  const badgesPrefix = (mode: LinkMode) => groupOf(mode, "elevatorBadges.enabled");

  it.each(MODES)("%s: placement, text and backplate fields sit one level below Floor badges", (mode) => {
    const root = badgesPrefix(mode);
    const sub = (path: string) => {
      const group = groupOf(mode, path);
      expect(group.slice(0, root.length), path).toEqual(root);
      expect(group.length, path).toBe(root.length + 1);
      return group[root.length];
    };
    const placement = sub("elevatorBadges.distance");
    const text = sub("elevatorBadges.labelType");
    const backplate = sub("elevatorBadges.shape");
    expect(new Set([placement, text, backplate]).size).toBe(3);
    for (const path of ["elevatorBadges.evenDistribution", "elevatorBadges.gap"]) expect(sub(path)).toBe(placement);
    for (const path of ["elevatorBadges.textSize", "elevatorBadges.textColor", "elevatorBadges.textMargin"]) expect(sub(path)).toBe(text);
    for (const path of ["elevatorBadges.fillColor", "elevatorBadges.borderWidth", "elevatorBadges.cornerStyle"]) expect(sub(path)).toBe(backplate);
  });
});
