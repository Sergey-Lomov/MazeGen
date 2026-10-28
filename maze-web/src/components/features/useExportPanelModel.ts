import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { EdgeDto, NodeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import type { ParamDescriptor } from "../../store/parameterLinks";
import { computeActivePaths } from "../../store/parameterLinksActivity";
import { computeTextFitItemsAcrossFloors, type ExportWarning } from "../../pixi/selectors/exportWarnings";
import { resolveEffectiveEndpoints } from "../../pixi/imageExport/exportStyleBuilders";
import { maxFittingFontSize, requiredTextPlateDimensions } from "../../pixi/textFit";
import { FLOOR_LABEL_TEXT_SIZE_RANGE } from "../../pixi/renderConstants";
import { hasCellAreaSpread } from "../../pixi/markerScale";
import { maxSplitNodeCount } from "../../pixi/selectors/mazeSelectors";
import type { ExportSettings } from "../../pixi/selectors/colorFieldRegistry";
import { buildColorVisibility } from "../../pixi/selectors/projectColorsSelector";
import type { TextFitContextValue } from "./TextFitContext";
import { useTeleportGroupsAndCollisions } from "./TeleportSettingsSection";

type FloorEntry = ReturnType<typeof useMazeStore.getState>["floors"][number];

/** Store reads and derived data shared by the "Vector by walls" and "Vector by corridors" settings
 *  panels: effective endpoints, export warnings, text fit, color visibility, section gates and the
 *  active parameter-link paths. Every derivation reads the unscoped project nodes/edges, so a floor
 *  switch never changes which sections are shown. */
export function useExportPanelModel<S extends ExportSettings, P extends string>(
  settings: S,
  registry: Record<P, ParamDescriptor>,
  computeWarnings: (
    nodes: NodeDto[], edges: EdgeDto[], floors: FloorEntry[], cfg: FieldConfig,
    settings: S, start: number | null, finish: number | null,
  ) => ExportWarning[],
) {
  const rawNodes = useMazeStore((s) => s.nodes);
  const rawEdges = useMazeStore((s) => s.edges);
  const rawStart = useMazeStore((s) => s.start);
  const rawFinish = useMazeStore((s) => s.finish);
  const postEditMeta = useMazeStore((s) => s.postEditMeta);
  const postEditDraftSplitPoints = useMazeStore((s) => s.postEditDraftSplitPoints);
  const cfg = useMazeStore((s) => s.activeFieldConfig);
  const floors = useMazeStore((s) => s.floors);
  const activeFloorId = useMazeStore((s) => s.activeFloorId);

  // Effective start/finish: `postEditMeta`'s confirmed endpoints once post-edit has confirmed, else
  // the as-generated `start`/`finish` (GitHub issue #303).
  const rawEffectiveEndpoints = useMemo(
    () => resolveEffectiveEndpoints({ nodes: rawNodes, start: rawStart, finish: rawFinish, postEditMeta, postEditDraftSplitPoints }),
    [rawNodes, rawStart, rawFinish, postEditMeta, postEditDraftSplitPoints],
  );

  // Export specific rendering caveats (GitHub issue #298), distinct from the QC issue list.
  const exportWarnings = useMemo(
    () => computeWarnings(rawNodes, rawEdges, floors, cfg, settings, rawEffectiveEndpoints.start, rawEffectiveEndpoints.finish),
    [rawNodes, rawEdges, floors, cfg, settings, rawEffectiveEndpoints],
  );

  // Auto fit data for font size rows (GitHub issue #707); floor labels have their own independent
  // size control, so `fitAll` only covers the shared style label controls.
  const textFit = useMemo<TextFitContextValue>(() => {
    const items = computeTextFitItemsAcrossFloors(rawNodes, rawEdges, floors, cfg, settings, rawEffectiveEndpoints.start, rawEffectiveEndpoints.finish);
    return {
      fitFor: (kind) => maxFittingFontSize(items[kind], kind === "floorLabel" ? FLOOR_LABEL_TEXT_SIZE_RANGE : undefined),
      fitAll: () => maxFittingFontSize([...items.start, ...items.finish, ...items.elevator, ...items.teleport, ...(settings.markerIndex.enabled ? items.markerIndex : [])]),
      fitFloorLabelWidth: () => requiredTextPlateDimensions(items.floorLabel, settings.floorLabel.textSize)?.width ?? null,
      fitFloorLabelHeight: () => requiredTextPlateDimensions(items.floorLabel, settings.floorLabel.textSize)?.height ?? null,
    };
  }, [rawNodes, rawEdges, floors, cfg, settings, rawEffectiveEndpoints]);

  // Group customization lists every teleport connection group of the whole project, cross floor
  // pairs included (GitHub issue #484), so switching floors never changes the customizable set.
  const { teleportGroups, teleportCollisionKeys } = useTeleportGroupsAndCollisions(
    rawNodes, rawEdges, cfg, floors, settings, rawEffectiveEndpoints.start, rawEffectiveEndpoints.finish,
  );

  // Splits/One-ways/Teleports sections stay visible whenever their component exists on any floor
  // (GitHub issue #484), checked against the unscoped nodes/edges.
  const maxSplit = useMemo(() => maxSplitNodeCount(rawNodes), [rawNodes]);

  // One visibility context for the whole panel (GitHub issue #717): section gates, priority color
  // lists and the "Project colors" list all derive from it, so they cannot drift.
  const colorVisibility = useMemo(
    () => buildColorVisibility({ nodes: rawNodes, edges: rawEdges, floors }, settings),
    [rawNodes, rawEdges, floors, settings],
  );
  const hasOneWays = colorVisibility.oneWayIndicator;
  const hasTeleports = colorVisibility.teleports;
  // The "Floor badges" subsection (GitHub issue #485) only makes sense with a cross floor teleport.
  const hasCrossFloorTeleports = colorVisibility.crossFloorTeleports;
  const hasTwoWayPassages = colorVisibility.twoWayPassages;
  const hasOneWayPassages = colorVisibility.oneWayPassages;
  const hasElevators = colorVisibility.elevators;
  const hasVerticalSection = hasTwoWayPassages || hasOneWayPassages || hasElevators;
  // "Marker indices" is shown only when some marker could ever carry an index (GitHub issue #730).
  const hasMarkerIndexSource = colorVisibility.markerIndexAvailable;
  // Marker size adaptation only matters when cells differ in area (GitHub issue #819).
  const hasAreaSpread = useMemo(() => hasCellAreaSpread(cfg), [cfg]);

  // Which registry paths the panel currently shows (GitHub issue #670), so the parameter links
  // dialog can tell an inactive parameter apart from an active one.
  const activePaths = useMemo(
    () => computeActivePaths(registry, {
      hasOneWays, hasTeleports, hasCrossFloorTeleports, hasTwoWayPassages, hasOneWayPassages, hasElevators,
      hasVerticalSection, hasMarkerIndexSource, hasAreaSpread,
      hasMultipleFloors: floors.length > 1,
    }, settings),
    [registry, hasOneWays, hasTeleports, hasCrossFloorTeleports, hasTwoWayPassages, hasOneWayPassages, hasElevators, hasVerticalSection, hasMarkerIndexSource, hasAreaSpread, floors.length, settings],
  );

  return {
    floors, activeFloorId, exportWarnings, textFit, teleportGroups, teleportCollisionKeys, maxSplit,
    colorVisibility, hasOneWays, hasTeleports, hasCrossFloorTeleports, hasTwoWayPassages, hasOneWayPassages,
    hasElevators, hasVerticalSection, hasMarkerIndexSource, activePaths,
  };
}
