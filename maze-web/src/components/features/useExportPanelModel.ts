import { useCallback, useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { floorIdsWithCut } from "../../pixi/imageExport/exportContent";
import type { EdgeDto, NodeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import type { ParamDescriptor } from "../../store/parameterLinks";
import { isGateOpen, type GateName } from "../../store/parameterLinkRules";
import type { LinkMode } from "../../store/parameterLinkSchema";
import { computeActivePaths, type ParamActivityContext } from "../../store/parameterLinksActivity";
import { computeVectorByCorridorsWarningsAcrossFloors, computeVectorByWallsWarningsAcrossFloors, type ExportWarning } from "../../pixi/selectors/exportWarnings";
import { resolveEffectiveEndpoints } from "../../pixi/imageExport/exportStyleBuilders";
import { requiredTextPlateDimensions } from "../../pixi/textFit";
import { computeTextFitGroups, fitAcrossGroups } from "./textFitScopes";
import { activeExportContext } from "../../store/exportZoneContext";
import { FLOOR_LABEL_TEXT_SIZE_RANGE } from "../../domain/renderConstants";
import { hasCellAreaSpread } from "../../domain/markerScale";
import { maxSplitNodeCount } from "../../domain/selectors/mazeSelectors";
import { exportModeSupportsZones, settingsWithOverride } from "../../store/exportZoneOverrides";
import type { ExportOverrideMode, ExportZoneOverride } from "../../store/zonesTypes";
import { computeTopologyWarnings } from "../../pixi/selectors/topologyWarnings";
import { hasAnyGlue, type ExportSettings } from "../../pixi/selectors/colorFieldRegistry";
import { buildColorVisibility } from "../../pixi/selectors/projectColorsSelector";
import type { TextFitContextValue } from "./TextFitContext";
import { useTeleportGroupsAndCollisions } from "./TeleportSettingsSection";
import { useTextMetricsKey } from "./useTextMetricsKey";

type FloorEntry = ReturnType<typeof useMazeStore.getState>["floors"][number];

type ComputeWarnings<S extends ExportSettings> = (
  nodes: NodeDto[], edges: EdgeDto[], floors: FloorEntry[], cfg: FieldConfig,
  settings: S, start: number | null, finish: number | null, cutFloorIds: ReadonlySet<string>, hasGlues: boolean,
) => ExportWarning[];

/** The project data every mode warning pass is judged with. */
function useWarningInputs() {
  const rawNodes = useMazeStore((s) => s.nodes);
  const rawEdges = useMazeStore((s) => s.edges);
  const rawStart = useMazeStore((s) => s.start);
  const rawFinish = useMazeStore((s) => s.finish);
  const postEditMeta = useMazeStore((s) => s.postEditMeta);
  const postEditDraftSplitPoints = useMazeStore((s) => s.postEditDraftSplitPoints);
  const cfg = useMazeStore((s) => s.activeFieldConfig);
  const floors = useMazeStore((s) => s.floors);
  // Effective start/finish: `postEditMeta`'s confirmed endpoints once post-edit has confirmed, else
  // the as-generated `start`/`finish` (GitHub issue #303).
  const rawEffectiveEndpoints = useMemo(
    () => resolveEffectiveEndpoints({ nodes: rawNodes, start: rawStart, finish: rawFinish, postEditMeta, postEditDraftSplitPoints }),
    [rawNodes, rawStart, rawFinish, postEditMeta, postEditDraftSplitPoints],
  );

  // Export specific rendering caveats (GitHub issue #298), distinct from the QC issue list.
  const floorTopology = useMazeStore((s) => s.floorTopology);
  const cuts = useMazeStore((s) => s.pngExportSettings.cuts);
  const cutFloorIds = useMemo(
    () => floorIdsWithCut(floors, cfg, floorTopology, cuts),
    [floors, cfg, floorTopology, cuts],
  );
  // Glue tabs (GitHub issue #901) only exist where some floor has a glue.
  const hasGlues = useMemo(() => hasAnyGlue(floorTopology), [floorTopology]);
  // Text overflow is judged against the loaded fonts: a font that lands after the first measurement re-runs the warnings.
  const metricsKey = useTextMetricsKey();
  return { rawNodes, rawEdges, floors, cfg, rawEffectiveEndpoints, cutFloorIds, hasGlues, metricsKey };
}

/** The mode's own warnings of the whole project (`computeWarnings`) and the effective endpoints they were judged with.
 *  Split out so a panel that needs a narrower set (the teleport connector editor, GitHub issue #952) doesn't derive the topology
 *  warnings, text fit, teleport groups and color visibility too. */
export function useModeWarnings<S extends ExportSettings>(settings: S, computeWarnings: ComputeWarnings<S>) {
  const { rawNodes, rawEdges, floors, cfg, rawEffectiveEndpoints, cutFloorIds, hasGlues, metricsKey } = useWarningInputs();
  const modeWarnings = useMemo(
    () => computeWarnings(rawNodes, rawEdges, floors, cfg, settings, rawEffectiveEndpoints.start, rawEffectiveEndpoints.finish, cutFloorIds, hasGlues),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawNodes, rawEdges, floors, cfg, settings, rawEffectiveEndpoints, cutFloorIds, hasGlues, metricsKey],
  );
  return { modeWarnings, rawEffectiveEndpoints };
}

/** `useZoneModeWarnings` of "Vector by walls" with its global settings and the "show zone problems" switch. */
export function useZoneWallsWarnings() {
  const settings = useMazeStore((s) => s.vectorByWallsSettings);
  const enabled = useMazeStore((s) => s.showZoneProblems);
  return useZoneModeWarnings("walls", settings, computeVectorByWallsWarningsAcrossFloors, enabled);
}

/** `useZoneModeWarnings` of "Vector by corridors" with its global settings and the "show zone problems" switch. */
export function useZoneCorridorsWarnings() {
  const settings = useMazeStore((s) => s.vectorByCorridorsSettings);
  const enabled = useMazeStore((s) => s.showZoneProblems);
  return useZoneModeWarnings("corridors", settings, computeVectorByCorridorsWarningsAcrossFloors, enabled);
}

/** The mode warnings of every zone override of `mode` (GitHub issue #1040): the whole project judged with the global
 *  `settings` plus that override's parameters. Empty while `enabled` is off, and for a mode without a zone context. */
export function useZoneModeWarnings<S extends ExportSettings>(mode: ExportOverrideMode, settings: S, computeWarnings: ComputeWarnings<S>, enabled: boolean) {
  const { rawNodes, rawEdges, floors, cfg, rawEffectiveEndpoints, cutFloorIds, hasGlues, metricsKey } = useWarningInputs();
  const overrides = useMazeStore((s) => s.exportZoneOverrides);
  return useMemo<{ override: ExportZoneOverride; warnings: ExportWarning[] }[]>(
    () => (!enabled || !exportModeSupportsZones(mode) ? [] : overrides.filter((o) => o.mode === mode).map((override) => ({
      override,
      warnings: computeWarnings(rawNodes, rawEdges, floors, cfg, settingsWithOverride(mode, settings, override), rawEffectiveEndpoints.start, rawEffectiveEndpoints.finish, cutFloorIds, hasGlues),
    }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, mode, overrides, rawNodes, rawEdges, floors, cfg, settings, rawEffectiveEndpoints, cutFloorIds, hasGlues, metricsKey],
  );
}

/** `useModeWarnings` plus the topology warnings: every export warning of the project. */
export function useExportWarnings<S extends ExportSettings>(settings: S, computeWarnings: ComputeWarnings<S>) {
  const { modeWarnings, rawEffectiveEndpoints } = useModeWarnings(settings, computeWarnings);
  const rawNodes = useMazeStore((s) => s.nodes);
  const rawEdges = useMazeStore((s) => s.edges);
  const cfg = useMazeStore((s) => s.activeFieldConfig);
  const floors = useMazeStore((s) => s.floors);
  const activeFloorId = useMazeStore((s) => s.activeFloorId);
  const floorTopology = useMazeStore((s) => s.floorTopology);
  const pngExportSettings = useMazeStore((s) => s.pngExportSettings);
  // Warnings about the glue tabs (GitHub issue #913) and edge alignment marks (GitHub issue #902) need the tabs and marks themselves,
  // so they are computed apart from the mode's list.
  const floorCreases = useMazeStore((s) => s.floorCreases);
  const topologyWarnings = useMemo(
    () => computeTopologyWarnings(
      { activeFloorId, activeFieldConfig: cfg, floorTopology, floorCreases, pngExportSettings, nodes: rawNodes, edges: rawEdges, floors },
      settings, rawEffectiveEndpoints,
    ),
    // The settings are a dependency as a whole: `computeTopologyWarnings` caches each group on the fields it reads (GitHub issue #928).
    [activeFloorId, cfg, floorTopology, floorCreases, pngExportSettings, rawNodes, rawEdges, floors, settings, rawEffectiveEndpoints],
  );
  const exportWarnings = useMemo(() => [...modeWarnings, ...topologyWarnings], [modeWarnings, topologyWarnings]);
  return { exportWarnings, rawEffectiveEndpoints };
}

/** Store reads and derived data shared by the "Vector by walls" and "Vector by corridors" settings
 *  panels: effective endpoints, export warnings, text fit, color visibility, section gates and the
 *  active parameter-link paths. Every derivation reads the unscoped project nodes/edges, so a floor
 *  switch never changes which sections are shown. */
export function useExportPanelModel<S extends ExportSettings, P extends string>(
  settings: S,
  registry: Record<P, ParamDescriptor>,
  mode: LinkMode,
  computeWarnings: ComputeWarnings<S>,
) {
  const rawNodes = useMazeStore((s) => s.nodes);
  const rawEdges = useMazeStore((s) => s.edges);
  const cfg = useMazeStore((s) => s.activeFieldConfig);
  const floors = useMazeStore((s) => s.floors);
  const activeFloorId = useMazeStore((s) => s.activeFloorId);

  const { exportWarnings, rawEffectiveEndpoints } = useExportWarnings(settings, computeWarnings);
  const floorTopology = useMazeStore((s) => s.floorTopology);
  // Glue tabs (GitHub issue #901) only exist where some floor has a glue.
  const hasGlues = useMemo(() => hasAnyGlue(floorTopology), [floorTopology]);

  // Auto fit data for font size rows (GitHub issue #707); floor labels have their own independent
  // size control, so `fitAll` only covers the shared style label controls.
  const textFitMetricsKey = useTextMetricsKey();
  // A label is fitted against the plate it sits on: the open zone's labels in a zone's context, every zone's variant in the global one (GitHub issue #1040).
  const zones = useMazeStore((s) => s.zones);
  const zoneGroups = useMazeStore((s) => s.zoneGroups);
  const exportZoneOverrides = useMazeStore((s) => s.exportZoneOverrides);
  const zoneTarget = useMazeStore(activeExportContext);
  const textFit = useMemo<TextFitContextValue>(() => {
    const zoned = exportModeSupportsZones(mode);
    const groups = computeTextFitGroups({
      nodes: rawNodes, edges: rawEdges, floors, cfg, start: rawEffectiveEndpoints.start, finish: rawEffectiveEndpoints.finish,
      settings, mode, overrides: zoned ? exportZoneOverrides : [], zones, groups: zoneGroups, target: zoned ? zoneTarget : null,
    });
    const floorItems = groups[0].items.floorLabel;
    return {
      fitFor: (kind) => fitAcrossGroups(groups, [kind], kind === "floorLabel" ? FLOOR_LABEL_TEXT_SIZE_RANGE : undefined),
      fitAll: () => fitAcrossGroups(groups, ["start", "finish", "elevator", "teleport", "markerIndex"]),
      fitFloorLabelWidth: () => requiredTextPlateDimensions(floorItems, settings.floorLabel.textSize)?.width ?? null,
      fitFloorLabelHeight: () => requiredTextPlateDimensions(floorItems, settings.floorLabel.textSize)?.height ?? null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawNodes, rawEdges, floors, cfg, settings, mode, exportZoneOverrides, zones, zoneGroups, zoneTarget, rawEffectiveEndpoints, textFitMetricsKey]);

  // Group customization lists every teleport connection group of the whole project, cross floor
  // pairs included (GitHub issue #484), so switching floors never changes the customizable set.
  const { teleportGroups, teleportCollisionKeys } = useTeleportGroupsAndCollisions(
    rawNodes, rawEdges, cfg, floors, settings, rawEffectiveEndpoints.start, rawEffectiveEndpoints.finish,
  );

  // Splits/One-ways/Teleports sections stay visible whenever their component exists on any floor
  // (GitHub issue #484), checked against the unscoped nodes/edges.
  const maxSplit = useMemo(() => maxSplitNodeCount(rawNodes), [rawNodes]);
  // "Topology" section gates: what the active floor has (cut lines and glue tabs need a glue; the section itself, a glue or a crease).
  const hasActiveFloorGlues = useMazeStore((s) => (s.floorTopology[s.activeFloorId]?.groups.length ?? 0) > 0);
  const hasActiveFloorCreases = useMazeStore((s) => (s.floorCreases[s.activeFloorId]?.length ?? 0) > 0);

  // One visibility context for the whole panel (GitHub issue #717): section gates, priority color
  // lists and the "Project colors" list all derive from it, so they cannot drift.
  const colorVisibility = useMemo(
    () => buildColorVisibility({ nodes: rawNodes, edges: rawEdges, floors, hasGlues }, settings),
    [rawNodes, rawEdges, floors, settings, hasGlues],
  );
  const { activity } = colorVisibility;
  const hasOneWays = activity.hasOneWays;
  const hasTeleports = activity.hasTeleports;
  // The "Floor badges" subsection (GitHub issue #485) only makes sense with a cross floor teleport.
  const hasCrossFloorTeleports = activity.hasCrossFloorTeleports;
  // "Route through seams" (GitHub issue #873) only makes sense when some floor has a fold.
  const hasSeams = useMemo(() => Object.values(floorTopology).some((topology) => topology.folds.length > 0), [floorTopology]);
  const hasTwoWayPassages = activity.hasTwoWayPassages;
  const hasOneWayPassages = activity.hasOneWayPassages;
  const hasElevators = activity.hasElevators;
  const hasVerticalSection = activity.hasVerticalSection;
  // "Marker indices" is shown only when some marker could ever carry an index (GitHub issue #730).
  const hasMarkerIndexSource = activity.hasMarkerIndexSource;
  // Marker size adaptation only matters when cells differ in area (GitHub issue #819).
  const hasAreaSpread = useMemo(() => hasCellAreaSpread(cfg), [cfg]);

  // Every maze-derived gate of the panel, in one object: the panels branch on these flags only, and the
  // parameter-links activity rules read the very same ones, so a field can't be shown by one and hidden
  // by the other (GitHub issue #927).
  const hasMultipleFloors = activity.hasMultipleFloors;
  const hasSplits = activity.hasSplits;
  const activityContext = useMemo<ParamActivityContext>(() => ({
    hasOneWays, hasTeleports, hasCrossFloorTeleports, hasTwoWayPassages, hasOneWayPassages, hasElevators,
    hasVerticalSection, hasMarkerIndexSource, hasAreaSpread, hasSeams, hasMultipleFloors,
    hasSplits, hasGlues: hasActiveFloorGlues, hasCreases: hasActiveFloorCreases,
  }), [hasOneWays, hasTeleports, hasCrossFloorTeleports, hasTwoWayPassages, hasOneWayPassages, hasElevators, hasVerticalSection, hasMarkerIndexSource, hasAreaSpread, hasSeams, hasMultipleFloors, hasSplits, hasActiveFloorGlues, hasActiveFloorCreases]);

  // Which registry paths the panel currently shows (GitHub issue #670), so the parameter links
  // dialog can tell an inactive parameter apart from an active one.
  const activePaths = useMemo(
    () => computeActivePaths(registry, mode, activityContext, settings),
    [registry, mode, activityContext, settings],
  );

  // The panel asks its section/row conditions by schema name instead of reading the flags itself.
  const gate = useCallback(
    (name: GateName) => isGateOpen(name, mode, activityContext, settings),
    [mode, activityContext, settings],
  );

  return {
    floors, activeFloorId, exportWarnings, textFit, teleportGroups, teleportCollisionKeys, maxSplit,
    colorVisibility, gate, activePaths,
  };
}
