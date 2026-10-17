import React, { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { OneWayPattern, VerticalArrowStyle, RandomWallColorMode } from "../../pixi/renderers/types";
import { indent, inset, spacing, typography, ui } from "../../styles/theme";
import { SectionHeader, SubsectionHeader } from "../SectionHeader";
import { LinkedColorRow, LinkedSelectRow, LinkedSliderRow, LinkedToggleRow } from "./LinkedRows";
import { LinkContextProvider, type LinkContextValue } from "./LinkContext";
import { TextFitContextProvider, type TextFitContextValue } from "./TextFitContext";
import { maxFittingFontSize } from "../../pixi/textFit";
import { maxSplitNodeCount } from "../../pixi/selectors/mazeSelectors";
import { splitSlotColor } from "../../pixi/colorUtils";
import { canvas } from "../../pixi/colorTokens";
import { computeVectorByWallsWarningsAcrossFloors, computeTextFitItemsAcrossFloors } from "../../pixi/selectors/exportWarnings";
import { requiredTextPlateDimensions } from "../../pixi/textFit";
import { FLOOR_LABEL_TEXT_SIZE_RANGE } from "../../pixi/renderConstants";
import { resolveEffectiveEndpoints } from "../../pixi/imageExport/VectorByWallsRenderer";
import { ExportWarningsSection } from "./ExportWarningsSection";
import { MarkerSettingsGroup, markerShapeSelectOptions } from "./MarkerSettingsGroup";
import { DecorativeLineStyleGroup } from "./DecorativeLineStyleGroup";
import { ElevatorBadgesSubsection } from "./ElevatorBadgesSubsection";
import { MarkerIndexSection } from "./MarkerIndexSection";
import { FloorLabelSection } from "./FloorLabelSection";
import { TeleportSettingsSection, useTeleportGroupsAndCollisions } from "./TeleportSettingsSection";
import { SharedStyleSection, SettingsSection } from "./SharedStyleSection";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS as D } from "../../store/slices/imageExportDefaults";
import { TILE_SIZE } from "../../pixi/constants";
import { VECTOR_BY_WALLS_PARAM_REGISTRY } from "../../store/parameterLinksRegistry";
import { computeActivePaths } from "../../store/parameterLinksActivity";
import { ColorVisibilityProvider, LayoutGate } from "../ColorVisibilityContext";
import { PC, buildColorVisibility } from "../../pixi/selectors/projectColorsSelector";
import * as m from "~/paraglide/messages";

/** "Background", "Tiles", "Markers" and "One-ways" sections of the "Vector by walls" render mode's
 * settings panel (GitHub issue #289 for background, #290/#291 for floor/wall settings — folded
 * into one "Tiles" section since both draw on the maze's cells/tiles, unlike background/grid which
 * draw on the viewport — #296 for start/finish markers — #292 for one-ways — all part of #288's
 * epic). Background covers background color, the original behind-maze grid visibility/color, and
 * the independent inside-maze grid visibility/color. Tiles covers the floor's
 * fill color, wall color, corners & ends (round/miter join, paired with a round/square cap) and
 * wall thickness — wall settings applied via `WallStyleOverride` to solid walls, split-junction
 * wall faces and closed-cells fill only (see `renderers/types.ts`), never the faint/background wall
 * styles or split-passage node-identity colors. Markers covers the start/finish marker's shape,
 * fill color, border color and border width, as two plain-label sub-groups ("Start"/"Finish")
 * within the one collapsible section — not two separate `SectionHeader`s, since they're too small
 * to warrant independent collapse. One-ways (placed after Markers, not before, matching the issue's
 * own section order) covers the one-way indicator's pattern (triangle/chevron/arrow —
 * `OneWayStyleOverride`, applied to `WallRenderer`'s plain wall one-ways only, never a split
 * passage's own connector arrow), its own color (always set, no fallback toggle), a border whose
 * color always mirrors the Tiles section's floor color (only its width is settable — `0` draws no
 * border), corners & ends (round/miter join, independent of the Tiles section's own wall join),
 * indicator size (as a fraction of the tile size, geometric scale) and thickness (chevron/arrow's
 * own line width in pixels, independent of size — no effect on the triangle pattern, a filled
 * shape with no line stroke of its own). Defaults are set in `imageExportSlice.ts` to
 * match the editor's normal grid/floor/wall/marker appearance exactly (except the one-way color,
 * which uses a brighter standalone default — GitHub issue #292). Section layout (row gap, divider
 * between sections) mirrors `AnalyticsFeature`'s collapsible sections. */
export function VectorByWallsSettingsPanel() {
  const settings = useMazeStore((s) => s.vectorByWallsSettings);
  const showColorWarnings = useMazeStore((s) => s.showColorWarnings);
  const setShowColorWarnings = useMazeStore((s) => s.setShowColorWarnings);
  const setBackground = useMazeStore((s) => s.setVectorByWallsBackground);
  const setShowGrid = useMazeStore((s) => s.setVectorByWallsShowGrid);
  const setGridColor = useMazeStore((s) => s.setVectorByWallsGridColor);
  const setShowInnerGrid = useMazeStore((s) => s.setVectorByWallsShowInnerGrid);
  const setInnerGridColor = useMazeStore((s) => s.setVectorByWallsInnerGridColor);
  const setFloorColor = useMazeStore((s) => s.setVectorByWallsFloorColor);
  const setWallColor = useMazeStore((s) => s.setVectorByWallsWallColor);
  const setRandomWallColorMode = useMazeStore((s) => s.setVectorByWallsRandomWallColorMode);
  const setWallJoin = useMazeStore((s) => s.setVectorByWallsWallJoin);
  const setWallThickness = useMazeStore((s) => s.setVectorByWallsWallThickness);
  const setOneWayPattern = useMazeStore((s) => s.setVectorByWallsOneWayPattern);
  const setOneWayColor = useMazeStore((s) => s.setVectorByWallsOneWayColor);
  const setOneWayGapWidth = useMazeStore((s) => s.setVectorByWallsOneWayGapWidth);
  const setOneWaySize = useMazeStore((s) => s.setVectorByWallsOneWaySize);
  const setOneWayThickness = useMazeStore((s) => s.setVectorByWallsOneWayThickness);
  const setOneWayJoin = useMazeStore((s) => s.setVectorByWallsOneWayJoin);
  const setStartMarkerShape = useMazeStore((s) => s.setVectorByWallsStartMarkerShape);
  const setStartMarkerText = useMazeStore((s) => s.setVectorByWallsStartMarkerText);
  const setStartMarkerTextEnabled = useMazeStore((s) => s.setVectorByWallsStartMarkerTextEnabled);
  const setStartMarkerTextFontWeight = useMazeStore((s) => s.setVectorByWallsStartMarkerTextFontWeight);
  const setStartMarkerTextSize = useMazeStore((s) => s.setVectorByWallsStartMarkerTextSize);
  const setStartMarkerTextMargin = useMazeStore((s) => s.setVectorByWallsStartMarkerTextMargin);
  const setStartMarkerTextColor = useMazeStore((s) => s.setVectorByWallsStartMarkerTextColor);
  const setStartMarkerCornerStyle = useMazeStore((s) => s.setVectorByWallsStartMarkerCornerStyle);
  const setStartMarkerFillColor = useMazeStore((s) => s.setVectorByWallsStartMarkerFillColor);
  const setStartMarkerBorderColor = useMazeStore((s) => s.setVectorByWallsStartMarkerBorderColor);
  const setStartMarkerBorderWidth = useMazeStore((s) => s.setVectorByWallsStartMarkerBorderWidth);
  const setStartMarkerGapWidth = useMazeStore((s) => s.setVectorByWallsStartMarkerGapWidth);
  const setStartMarkerSize = useMazeStore((s) => s.setVectorByWallsStartMarkerSize);
  const setFinishMarkerShape = useMazeStore((s) => s.setVectorByWallsFinishMarkerShape);
  const setFinishMarkerText = useMazeStore((s) => s.setVectorByWallsFinishMarkerText);
  const setFinishMarkerTextEnabled = useMazeStore((s) => s.setVectorByWallsFinishMarkerTextEnabled);
  const setFinishMarkerTextFontWeight = useMazeStore((s) => s.setVectorByWallsFinishMarkerTextFontWeight);
  const setFinishMarkerTextSize = useMazeStore((s) => s.setVectorByWallsFinishMarkerTextSize);
  const setFinishMarkerTextMargin = useMazeStore((s) => s.setVectorByWallsFinishMarkerTextMargin);
  const setFinishMarkerTextColor = useMazeStore((s) => s.setVectorByWallsFinishMarkerTextColor);
  const setFinishMarkerCornerStyle = useMazeStore((s) => s.setVectorByWallsFinishMarkerCornerStyle);
  const setFinishMarkerFillColor = useMazeStore((s) => s.setVectorByWallsFinishMarkerFillColor);
  const setFinishMarkerBorderColor = useMazeStore((s) => s.setVectorByWallsFinishMarkerBorderColor);
  const setFinishMarkerBorderWidth = useMazeStore((s) => s.setVectorByWallsFinishMarkerBorderWidth);
  const setFinishMarkerGapWidth = useMazeStore((s) => s.setVectorByWallsFinishMarkerGapWidth);
  const setFinishMarkerSize = useMazeStore((s) => s.setVectorByWallsFinishMarkerSize);
  const patchVerticalSettings = useMazeStore((s) => s.patchVectorByWallsVerticalSettings);
  const patchVerticalSharedStyle = useMazeStore((s) => s.patchVectorByWallsVerticalSharedStyle);
  const patchDecorativeLineStyle = useMazeStore((s) => s.patchVectorByWallsDecorativeLineStyle);
  const patchElevatorBadges = useMazeStore((s) => s.patchVectorByWallsElevatorBadges);
  const patchMarkerIndex = useMazeStore((s) => s.patchVectorByWallsMarkerIndexSettings);
  const patchFloorLabel = useMazeStore((s) => s.patchVectorByWallsFloorLabelSettings);
  const setElevatorBadgesCornerStyle = useMazeStore((s) => s.setVectorByWallsElevatorBadgesCornerStyle);
  const setTwoWayPassageMarkerShape = useMazeStore((s) => s.setVectorByWallsTwoWayPassageMarkerShape);
  const setTwoWayPassageMarkerCornerStyle = useMazeStore((s) => s.setVectorByWallsTwoWayPassageMarkerCornerStyle);
  const setTwoWayPassageMarkerFillColor = useMazeStore((s) => s.setVectorByWallsTwoWayPassageMarkerFillColor);
  const setTwoWayPassageMarkerBorderColor = useMazeStore((s) => s.setVectorByWallsTwoWayPassageMarkerBorderColor);
  const setTwoWayPassageMarkerBorderWidth = useMazeStore((s) => s.setVectorByWallsTwoWayPassageMarkerBorderWidth);
  const setTwoWayPassageMarkerGapWidth = useMazeStore((s) => s.setVectorByWallsTwoWayPassageMarkerGapWidth);
  const setTwoWayPassageMarkerSize = useMazeStore((s) => s.setVectorByWallsTwoWayPassageMarkerSize);
  const setOneWayPassageMarkerShape = useMazeStore((s) => s.setVectorByWallsOneWayPassageMarkerShape);
  const setOneWayPassageMarkerCornerStyle = useMazeStore((s) => s.setVectorByWallsOneWayPassageMarkerCornerStyle);
  const setOneWayPassageMarkerFillColor = useMazeStore((s) => s.setVectorByWallsOneWayPassageMarkerFillColor);
  const setOneWayPassageMarkerBorderColor = useMazeStore((s) => s.setVectorByWallsOneWayPassageMarkerBorderColor);
  const setOneWayPassageMarkerBorderWidth = useMazeStore((s) => s.setVectorByWallsOneWayPassageMarkerBorderWidth);
  const setOneWayPassageMarkerGapWidth = useMazeStore((s) => s.setVectorByWallsOneWayPassageMarkerGapWidth);
  const setOneWayPassageMarkerSize = useMazeStore((s) => s.setVectorByWallsOneWayPassageMarkerSize);
  const setElevatorMarkerShape = useMazeStore((s) => s.setVectorByWallsElevatorMarkerShape);
  const setElevatorMarkerCornerStyle = useMazeStore((s) => s.setVectorByWallsElevatorMarkerCornerStyle);
  const setElevatorMarkerFillColor = useMazeStore((s) => s.setVectorByWallsElevatorMarkerFillColor);
  const setElevatorMarkerBorderColor = useMazeStore((s) => s.setVectorByWallsElevatorMarkerBorderColor);
  const setElevatorMarkerBorderWidth = useMazeStore((s) => s.setVectorByWallsElevatorMarkerBorderWidth);
  const setElevatorMarkerGapWidth = useMazeStore((s) => s.setVectorByWallsElevatorMarkerGapWidth);
  const setElevatorMarkerSize = useMazeStore((s) => s.setVectorByWallsElevatorMarkerSize);
  const patchTeleportSettings = useMazeStore((s) => s.patchVectorByWallsTeleportSettings);
  const setTeleportGroupOverride = useMazeStore((s) => s.setVectorByWallsTeleportGroupOverride);
  const patchTeleportGroupOverrides = useMazeStore((s) => s.patchVectorByWallsTeleportGroupOverrides);
  const setSplitNodeColor = useMazeStore((s) => s.setVectorByWallsSplitNodeColor);
  const setSplitSpecialShapes = useMazeStore((s) => s.setVectorByWallsSplitSpecialShapes);
  const patchSharedStyle = useMazeStore((s) => s.patchVectorByWallsSharedStyle);
  const resetAllSettings = useMazeStore((s) => s.resetVectorByWallsSettings);
  const setLinkEnabled = useMazeStore((s) => s.setVectorByWallsLinkEnabled);
  const addLink = useMazeStore((s) => s.addVectorByWallsLink);
  const removeLink = useMazeStore((s) => s.removeVectorByWallsLink);

  const rawNodes = useMazeStore((s) => s.nodes);
  const rawEdges = useMazeStore((s) => s.edges);
  const rawStart = useMazeStore((s) => s.start);
  const rawFinish = useMazeStore((s) => s.finish);
  const postEditMeta = useMazeStore((s) => s.postEditMeta);
  const postEditDraftSplitPoints = useMazeStore((s) => s.postEditDraftSplitPoints);
  const cfg = useMazeStore((s) => s.activeFieldConfig);
  const floors = useMazeStore((s) => s.floors);
  const activeFloorId = useMazeStore((s) => s.activeFloorId);

  // Effective start/finish — `postEditMeta`'s confirmed endpoints once post-edit has confirmed,
  // else the as-generated `start`/`finish` (GitHub issue #303 — `confirmPostEdit` never updates
  // `state.start`/`state.finish`, only `postEditMeta` reflects a post-edit marker move).
  const rawEffectiveEndpoints = useMemo(
    () => resolveEffectiveEndpoints({ nodes: rawNodes, start: rawStart, finish: rawFinish, postEditMeta, postEditDraftSplitPoints }),
    [rawNodes, rawStart, rawFinish, postEditMeta, postEditDraftSplitPoints],
  );

  // Scoped to `activeFloorId` (GitHub issue #347) — mirrors `VectorByWallsRenderer.renderAll`'s own
  // scoping, so this panel's warnings/section-visibility checks see exactly what's drawn.
  // Export-specific rendering caveats (GitHub issue #298) — maze-valid but this render mode can't
  // depict the case correctly (e.g. an invisible teleport marker). Distinct from the QC issue list
  // (Analytics feature) — see `exportWarnings.ts`'s doc comment.
  const exportWarnings = useMemo(
    () => computeVectorByWallsWarningsAcrossFloors(rawNodes, rawEdges, floors, cfg, settings, rawEffectiveEndpoints.start, rawEffectiveEndpoints.finish),
    [rawNodes, rawEdges, floors, cfg, settings, rawEffectiveEndpoints],
  );

  // Auto-fit data for font-size rows (GitHub issue #707) — floor labels have their own independent
  // size control, so `fitAll` only covers the shared-style label controls.
  const textFit = useMemo<TextFitContextValue>(() => {
    const items = computeTextFitItemsAcrossFloors(rawNodes, rawEdges, floors, cfg, settings, rawEffectiveEndpoints.start, rawEffectiveEndpoints.finish);
    return {
      fitFor: (kind) => maxFittingFontSize(items[kind], kind === "floorLabel" ? FLOOR_LABEL_TEXT_SIZE_RANGE : undefined),
      fitAll: () => maxFittingFontSize([...items.start, ...items.finish, ...items.elevator, ...items.teleport, ...(settings.markerIndex.enabled ? items.markerIndex : [])]),
      fitFloorLabelWidth: () => requiredTextPlateDimensions(items.floorLabel, settings.floorLabel.textSize)?.width ?? null,
      fitFloorLabelHeight: () => requiredTextPlateDimensions(items.floorLabel, settings.floorLabel.textSize)?.height ?? null,
    };
  }, [rawNodes, rawEdges, floors, cfg, settings, rawEffectiveEndpoints]);

  // Group customization lists every teleport connection group of the *whole project*, cross-floor
  // pairs included (GitHub issue #484) — not just the active floor's — so switching floors never
  // changes the set of customizable groups. Built per floor exactly the way each floor's own
  // renderer builds it, then merged by key (see the hook's own doc comment), so an override set
  // here always resolves against what that floor's renderer draws.
  const { teleportGroups, teleportCollisionKeys } = useTeleportGroupsAndCollisions(
    rawNodes, rawEdges, cfg, floors, settings, rawEffectiveEndpoints.start, rawEffectiveEndpoints.finish,
  );

  // Splits/One-ways/Teleports sections stay visible whenever their component exists on *any* floor
  // of the project (GitHub issue #484) — checked against `rawNodes`/`rawEdges`, not the floor-scoped
  // `nodes`/`edges` — so switching floors never makes a section appear or disappear (which flickered
  // the panel). Same "hide only when there's genuinely nothing to configure anywhere" rule the
  // "Vertical connections" sub-sections below already follow against `rawEdges`.
  const maxSplit = useMemo(() => maxSplitNodeCount(rawNodes), [rawNodes]);

  // One visibility context for the whole panel (GitHub issue #717): the section gates below, the
  // priority color lists and the "Project colors" list all derive from it, so they cannot drift.
  // Built from the unscoped `rawNodes`/`rawEdges` so a floor switch never changes the answer.
  const colorVisibility = useMemo(
    () => buildColorVisibility({ nodes: rawNodes, edges: rawEdges, floors }, settings),
    [rawNodes, rawEdges, floors, settings],
  );
  const hasOneWays = colorVisibility.oneWayIndicator;
  const hasTeleports = colorVisibility.teleports;
  // The "Floor badges" subsection (GitHub issue #485) only makes sense with a cross-floor teleport.
  const hasCrossFloorTeleports = colorVisibility.crossFloorTeleports;
  const hasTwoWayPassages = colorVisibility.twoWayPassages;
  const hasOneWayPassages = colorVisibility.oneWayPassages;
  const hasElevators = colorVisibility.elevators;
  const hasVerticalSection = hasTwoWayPassages || hasOneWayPassages || hasElevators;
  // "Marker indices" is shown only when some marker could ever carry an index (GitHub issue #730).
  const hasMarkerIndexSource = colorVisibility.markerIndexAvailable;

  // Which registry paths the panel currently shows (GitHub issue #670) — mirrors the section/
  // subsection visibility conditions above, so the parameter-links dialog can tell an inactive
  // parameter (e.g. a teleport field with no teleports in the maze) apart from an active one.
  const activePaths = useMemo(
    () => computeActivePaths(VECTOR_BY_WALLS_PARAM_REGISTRY, {
      hasOneWays, hasTeleports, hasCrossFloorTeleports, hasTwoWayPassages, hasOneWayPassages, hasElevators,
      hasVerticalSection, hasMarkerIndexSource,
      hasMultipleFloors: floors.length > 1,
    }, settings),
    [hasOneWays, hasTeleports, hasCrossFloorTeleports, hasTwoWayPassages, hasOneWayPassages, hasElevators, hasVerticalSection, hasMarkerIndexSource, floors.length, settings],
  );

  const sectionsExpanded = useMazeStore((s) => s.vectorByWallsSectionsExpanded);
  const setSectionExpanded = useMazeStore((s) => s.setVectorByWallsSectionExpanded);
  const isExpanded = (id: string) => sectionsExpanded[id] ?? false;
  const toggleSection = (id: string) => setSectionExpanded(id, !isExpanded(id));

  // "Priority" project colors (GitHub issue #503) — sibling colors that matter for a given color
  // decision, pinned to the top of the picker's "Project colors" section. `floorColor` is the
  // near-universal neighbour here (everything except the outer walls sits on the floor); `background`
  // is relevant only where the outer wall meets it, `wallColor` where a marker/indicator abuts a wall.
  const floor = PC.tilesFloor.at(settings.floorColor);
  const wall = PC.tilesWall.at(settings.wallColor);
  const background = PC.bgFill.at(settings.background);
  const onFloor = [floor, wall];

  // Vertical-connection cross-references (GitHub issue #503): every vertical passage / elevator
  // color row prioritizes the full set of the other two vertical kinds' colors, so recoloring one
  // kind to match another is a one-click pick. `[fill, border/accent, arrow]` per kind, in that
  // order. Self is dropped from a row's own list by `ColorPickerPanel`'s field-key match.
  const vTwoWay = [
    PC.twoWayFill.at(settings.twoWayPassageMarker.fillColor),
    PC.twoWayBorder.at(settings.twoWayPassageMarker.borderColor),
    PC.twoWayArrow.at(settings.twoWayArrowColor),
  ];
  const vOneWay = [
    PC.oneWayFill.at(settings.oneWayPassageMarker.fillColor),
    PC.oneWayBorder.at(settings.oneWayPassageMarker.borderColor),
    PC.oneWayArrow.at(settings.oneWayArrowColor),
  ];
  const vElevator = [
    PC.elevatorFill.at(settings.elevatorMarker.fillColor),
    PC.elevatorBorder.at(settings.elevatorMarker.borderColor),
    PC.elevatorArrow.at(settings.elevatorArrowColor),
  ];
  const badges = [
    PC.elevatorBadgeFill.at(settings.elevatorBadges.fillColor),
    PC.elevatorBadgeText.at(settings.elevatorBadges.textColor),
  ];
  // Every teleport color row also prioritizes the floor-badge colors (GitHub issue #503) — a row's
  // own entry is dropped by the picker's field-key match.
  const tpBadges = [
    PC.teleportBadgeFill.at(settings.teleportFloorBadge.fillColor),
    PC.teleportBadgeBorder.at(settings.teleportFloorBadge.borderColor),
    PC.teleportBadgeText.at(settings.teleportFloorBadge.textColor),
  ];
  // Every vertical-connection / elevator color row ends with the "Vertical connections" section's
  // own "Shared style" fill/arrow colors (GitHub issue #668 — these feed all three marker groups
  // via disabled-by-default links), then the floor color (the corridor-color analogue this mode
  // has), then (for the rows that already carry it) the background — GitHub issue #503.
  const vShared = [PC.verticalFill.at(settings.verticalFillColor), PC.verticalArrow.at(settings.verticalArrowColor)];
  const vTail = [...vShared, floor];
  const vTailBg = [...vShared, floor, background];
  // Elevator floor-badge fill / text prioritize each other first (they sit one on the other), then
  // every elevator color, then the floor and the background.
  const badgeFillPriority = [PC.elevatorBadgeText.at(settings.elevatorBadges.textColor), ...vElevator, ...vTailBg];
  const badgeBorderPriority = [PC.elevatorBadgeFill.at(settings.elevatorBadges.fillColor), PC.elevatorBadgeText.at(settings.elevatorBadges.textColor), ...vElevator, ...vTailBg];
  const badgeTextPriority = [PC.elevatorBadgeFill.at(settings.elevatorBadges.fillColor), PC.elevatorBadgeBorder.at(settings.elevatorBadges.borderColor), ...vElevator, ...vTailBg];

  return (
    <LinkContextProvider value={{ links: settings.links, registry: VECTOR_BY_WALLS_PARAM_REGISTRY, onSetLinkEnabled: setLinkEnabled, onAddLink: addLink, activePaths } as unknown as LinkContextValue<string>}>
    <ColorVisibilityProvider value={colorVisibility}>
    <TextFitContextProvider value={textFit}>
    <div style={styles.root}>
      <ExportWarningsSection
        warnings={exportWarnings}
        expanded={isExpanded("warnings")}
        onToggle={() => toggleSection("warnings")}
        showColorWarnings={showColorWarnings}
        onShowColorWarningsChange={setShowColorWarnings}
      />

      <SectionHeader
        label={m["image_export.vector_by_walls.section_settings"]()}
        expanded={isExpanded("settings")}
        onToggle={() => toggleSection("settings")}
      />
      {isExpanded("settings") && (
        <SettingsSection
          onResetAll={resetAllSettings}
          settings={settings}
          links={settings.links}
          registry={VECTOR_BY_WALLS_PARAM_REGISTRY}
          onSetLinkEnabled={setLinkEnabled}
          onAddLink={addLink}
          onRemoveLink={removeLink}
          activePaths={activePaths}
        />
      )}

      <div style={styles.divider} />

      <SectionHeader
        label={m["image_export.vector_by_walls.section_shared_style"]()}
        expanded={isExpanded("shared_style")}
        onToggle={() => toggleSection("shared_style")}
      />
      {isExpanded("shared_style") && (
        <SharedStyleSection
          settings={settings}
          onChange={patchSharedStyle}
          priorityColors={{ fillColor: [PC.sharedMarkerBorder.at(settings.markerBorderColor), floor, background], borderColor: [PC.sharedMarkerFill.at(settings.markerFillColor), floor, background] }}
        />
      )}

      <div style={styles.divider} />

      <SectionHeader
        label={m["image_export.vector_by_walls.section_background"]()}
        expanded={isExpanded("background")}
        onToggle={() => toggleSection("background")}
      />
      {isExpanded("background") && (
        <div style={styles.block}>
          <LinkedColorRow
            label={m["image_export.vector_by_walls.background_color"]()}
            color={settings.background}
            onChange={setBackground}
            defaultColor={D.background}
            field={PC.bgFill}
            priorityColors={[PC.bgGrid.at(settings.gridColor), PC.innerGrid.at(settings.innerGridColor), floor, wall]}
            linkTarget="background"
          />
          <LinkedToggleRow label={m["image_export.vector_by_walls.show_grid"]()} checked={settings.showGrid} onChange={setShowGrid} linkTarget="showGrid" />
          <LinkedColorRow
            label={m["image_export.vector_by_walls.grid_color"]()}
            color={settings.gridColor}
            onChange={setGridColor}
            defaultColor={D.gridColor}
            field={PC.bgGrid}
            priorityColors={[background, PC.innerGrid.at(settings.innerGridColor), wall]}
            linkTarget="gridColor"
          />
          <LinkedToggleRow label={m["image_export.vector_by_walls.show_inner_grid"]()} checked={settings.showInnerGrid} onChange={setShowInnerGrid} linkTarget="showInnerGrid" />
          <LinkedColorRow
            label={m["image_export.vector_by_walls.inner_grid_color"]()}
            color={settings.innerGridColor}
            onChange={setInnerGridColor}
            defaultColor={D.innerGridColor}
            field={PC.innerGrid}
            priorityColors={[floor, wall, background, PC.bgGrid.at(settings.gridColor)]}
            linkTarget="innerGridColor"
          />
        </div>
      )}

      <div style={styles.divider} />

      <SectionHeader
        label={m["image_export.vector_by_walls.section_tiles"]()}
        expanded={isExpanded("tiles")}
        onToggle={() => toggleSection("tiles")}
      />
      {isExpanded("tiles") && (
        <div style={styles.block}>
          <LinkedColorRow
            label={m["image_export.vector_by_walls.floor_color"]()}
            color={settings.floorColor}
            onChange={setFloorColor}
            defaultColor={D.floorColor}
            field={PC.tilesFloor}
            priorityColors={[wall]}
            linkTarget="floorColor"
          />
          <LinkedToggleRow
            label={m["image_export.vector_by_walls.random_wall_colors"]()}
            checked={settings.randomWallColorMode !== "off"}
            onChange={(enabled) => setRandomWallColorMode(enabled ? "per_pass" : "off")}
            linkTarget={null}
            unsupportedHint={m["link_status.unsupported_hint_random_wall_colors"]()}
          />
          {PC.tilesWall.isVisible(colorVisibility) ? (
            <LinkedColorRow
              label={m["image_export.vector_by_walls.wall_color"]()}
              color={settings.wallColor}
              onChange={setWallColor}
              defaultColor={D.wallColor}
              field={PC.tilesWall}
              priorityColors={[floor, background]}
              linkTarget="wallColor"
            />
          ) : (
            <LinkedSelectRow
              label={m["image_export.vector_by_walls.random_wall_color_mode"]()}
              value={settings.randomWallColorMode}
              options={[
                { value: "per_pass" as RandomWallColorMode, label: m["image_export.vector_by_walls.random_wall_colors_per_segment"]() },
                { value: "per_segment" as RandomWallColorMode, label: m["image_export.vector_by_walls.random_wall_colors_per_pass"]() },
              ]}
              onChange={setRandomWallColorMode}
              linkTarget={null}
            />
          )}
          <LinkedSelectRow
            label={m["image_export.vector_by_walls.wall_join"]()}
            value={settings.wallJoin}
            options={[
              { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
              { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
            ]}
            onChange={setWallJoin}
            linkTarget="wallJoin"
          />
          <LinkedSliderRow
            label={m["image_export.vector_by_walls.wall_thickness"]()}
            value={settings.wallThickness}
            onChange={setWallThickness}
            min={1}
            max={20}
            step={1}
            format={(v) => String(v)}
            linkTarget="wallThickness"
          />
        </div>
      )}

      <div style={styles.divider} />

      {floors.length > 1 && (
        <>
          <SectionHeader label={m["image_export.floors.section"]()} expanded={isExpanded("floors")} onToggle={() => toggleSection("floors")} />
          {isExpanded("floors") && (
            <FloorLabelSection
              renderMode="vector_by_walls"
              settings={settings.floorLabel}
              onChange={patchFloorLabel}
              fields={{ fill: PC.floorLabelFill, border: PC.floorLabelBorder, text: PC.floorLabelText }}
              defaults={{ fill: D.floorLabel.fillColor, border: D.floorLabel.borderColor, text: D.floorLabel.textColor }}
              priorities={{
                fill: [PC.floorLabelText.at(settings.floorLabel.textColor), PC.floorLabelBorder.at(settings.floorLabel.borderColor), background],
                border: [PC.floorLabelFill.at(settings.floorLabel.fillColor), PC.floorLabelText.at(settings.floorLabel.textColor), background],
                text: [PC.floorLabelFill.at(settings.floorLabel.fillColor), PC.floorLabelBorder.at(settings.floorLabel.borderColor), floor, background],
              }}
              activeFloorId={activeFloorId}
              activeFloorTitle={floors.find((item) => item.id === activeFloorId)?.title ?? ""}
              floorIds={floors.map((item) => item.id)}
            />
          )}
          <div style={styles.divider} />
        </>
      )}

      <SectionHeader
        label={m["image_export.vector_by_walls.section_markers"]()}
        expanded={isExpanded("markers")}
        onToggle={() => toggleSection("markers")}
      />
      {isExpanded("markers") && (() => {
        const startFill = PC.startFill.at(settings.startMarker.fillColor);
        const startBorder = PC.startBorder.at(settings.startMarker.borderColor);
        const finishFill = PC.finishFill.at(settings.finishMarker.fillColor);
        const finishBorder = PC.finishBorder.at(settings.finishMarker.borderColor);
        const startText = PC.startText.at(settings.startMarker.textColor ?? D.startMarker.textColor ?? floor.color);
        const finishText = PC.finishText.at(settings.finishMarker.textColor ?? D.finishMarker.textColor ?? floor.color);
        return (
        <div style={styles.block}>
          <MarkerSettingsGroup
            title={m["image_export.vector_by_walls.markers_start"]()}
            sectionId="markers_start"
            textFitKind="start"
            isExpanded={isExpanded}
            onToggle={toggleSection}
            showTextSection
            settings={settings.startMarker}
            priorityColors={{ fillColor: [startBorder, startText, finishFill, finishBorder, floor], borderColor: [startFill, startText, finishBorder, finishFill, floor], textColor: [startFill, startBorder, finishText, floor] }}
            defaultColors={{ fillColor: D.startMarker.fillColor, borderColor: D.startMarker.borderColor, textColor: D.startMarker.textColor }}
            fields={{ fillColor: PC.startFill, borderColor: PC.startBorder, textColor: PC.startText }}
            onChange={(patch) => {
              if (patch.shape !== undefined) setStartMarkerShape(patch.shape);
              if (patch.text !== undefined) setStartMarkerText(patch.text);
              if (patch.textEnabled !== undefined) setStartMarkerTextEnabled(patch.textEnabled);
              if (patch.textFontWeight !== undefined) setStartMarkerTextFontWeight(patch.textFontWeight);
              if (patch.textSize !== undefined) setStartMarkerTextSize(patch.textSize);
              if (patch.textMargin !== undefined) setStartMarkerTextMargin(patch.textMargin);
              if (patch.textColor !== undefined) setStartMarkerTextColor(patch.textColor);
              if (patch.cornerStyle !== undefined) setStartMarkerCornerStyle(patch.cornerStyle);
              if (patch.fillColor !== undefined) setStartMarkerFillColor(patch.fillColor);
              if (patch.borderColor !== undefined) setStartMarkerBorderColor(patch.borderColor);
              if (patch.borderWidth !== undefined) setStartMarkerBorderWidth(patch.borderWidth);
              if (patch.gapWidth !== undefined) setStartMarkerGapWidth(patch.gapWidth);
              if (patch.size !== undefined) setStartMarkerSize(patch.size);
            }}
            linkTargets={{
              shape: "startMarker.shape",
              cornerStyle: "startMarker.cornerStyle",
              size: "startMarker.size",
              fillColor: "startMarker.fillColor",
              borderColor: "startMarker.borderColor",
              borderWidth: "startMarker.borderWidth",
              gapWidth: "startMarker.gapWidth",
              textEnabled: "startMarker.textEnabled",
              textFontWeight: "startMarker.textFontWeight",
              textSize: "startMarker.textSize",
              textMargin: "startMarker.textMargin",
              textColor: "startMarker.textColor",
            }}
          />
          <MarkerSettingsGroup
            title={m["image_export.vector_by_walls.markers_finish"]()}
            sectionId="markers_finish"
            textFitKind="finish"
            isExpanded={isExpanded}
            onToggle={toggleSection}
            showTextSection
            settings={settings.finishMarker}
            priorityColors={{ fillColor: [finishBorder, finishText, startFill, startBorder, floor], borderColor: [finishFill, finishText, startBorder, startFill, floor], textColor: [finishFill, finishBorder, startText, floor] }}
            defaultColors={{ fillColor: D.finishMarker.fillColor, borderColor: D.finishMarker.borderColor, textColor: D.finishMarker.textColor }}
            fields={{ fillColor: PC.finishFill, borderColor: PC.finishBorder, textColor: PC.finishText }}
            onChange={(patch) => {
              if (patch.shape !== undefined) setFinishMarkerShape(patch.shape);
              if (patch.text !== undefined) setFinishMarkerText(patch.text);
              if (patch.textEnabled !== undefined) setFinishMarkerTextEnabled(patch.textEnabled);
              if (patch.textFontWeight !== undefined) setFinishMarkerTextFontWeight(patch.textFontWeight);
              if (patch.textSize !== undefined) setFinishMarkerTextSize(patch.textSize);
              if (patch.textMargin !== undefined) setFinishMarkerTextMargin(patch.textMargin);
              if (patch.textColor !== undefined) setFinishMarkerTextColor(patch.textColor);
              if (patch.cornerStyle !== undefined) setFinishMarkerCornerStyle(patch.cornerStyle);
              if (patch.fillColor !== undefined) setFinishMarkerFillColor(patch.fillColor);
              if (patch.borderColor !== undefined) setFinishMarkerBorderColor(patch.borderColor);
              if (patch.borderWidth !== undefined) setFinishMarkerBorderWidth(patch.borderWidth);
              if (patch.gapWidth !== undefined) setFinishMarkerGapWidth(patch.gapWidth);
              if (patch.size !== undefined) setFinishMarkerSize(patch.size);
            }}
            linkTargets={{
              shape: "finishMarker.shape",
              cornerStyle: "finishMarker.cornerStyle",
              size: "finishMarker.size",
              fillColor: "finishMarker.fillColor",
              borderColor: "finishMarker.borderColor",
              borderWidth: "finishMarker.borderWidth",
              gapWidth: "finishMarker.gapWidth",
              textEnabled: "finishMarker.textEnabled",
              textFontWeight: "finishMarker.textFontWeight",
              textSize: "finishMarker.textSize",
              textMargin: "finishMarker.textMargin",
              textColor: "finishMarker.textColor",
            }}
          />
        </div>
        );
      })()}

      {hasOneWays && (
        <>
          <div style={styles.divider} />

          <SectionHeader
            label={m["image_export.vector_by_walls.section_one_ways"]()}
            expanded={isExpanded("one_ways")}
            onToggle={() => toggleSection("one_ways")}
          />
          {isExpanded("one_ways") && (
            <div style={styles.block}>
              <LinkedSelectRow
                label={m["image_export.vector_by_walls.one_way_pattern"]()}
                value={settings.oneWayPattern}
                options={[
                  { value: "triangle" as OneWayPattern, label: m["image_export.vector_by_walls.one_way_pattern_triangle"]() },
                  { value: "chevron" as OneWayPattern, label: m["image_export.vector_by_walls.one_way_pattern_chevron"]() },
                  { value: "arrow" as OneWayPattern, label: m["image_export.vector_by_walls.one_way_pattern_arrow"]() },
                ]}
                onChange={setOneWayPattern}
                linkTarget={null}
              />
              <LinkedColorRow
                label={m["image_export.vector_by_walls.one_way_color"]()}
                color={settings.oneWayColor}
                onChange={setOneWayColor}
                defaultColor={D.oneWayColor}
                field={PC.oneWaysMarker}
                priorityColors={[floor, wall]}
                linkTarget="oneWayColor"
              />
              <LinkedSliderRow
                label={m["image_export.vector_by_walls.one_way_gap_width"]()}
                value={settings.oneWayGapWidth}
                onChange={setOneWayGapWidth}
                min={0}
                max={10}
                step={1}
                format={(v) => String(v)}
                linkTarget="oneWayGapWidth"
              />
              <LinkedSelectRow
                label={m["image_export.vector_by_walls.one_way_join"]()}
                value={settings.oneWayJoin}
                options={[
                  { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
                  { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
                ]}
                onChange={setOneWayJoin}
                linkTarget="oneWayJoin"
              />
              <LinkedSliderRow
                label={m["image_export.vector_by_walls.one_way_size"]()}
                value={settings.oneWaySize}
                onChange={setOneWaySize}
                min={0.05 * TILE_SIZE}
                max={TILE_SIZE}
                step={1}
                format={(v) => String(Math.round(v))}
                linkTarget="oneWaySize"
              />
              <LinkedSliderRow
                label={m["image_export.vector_by_walls.one_way_thickness"]()}
                value={settings.oneWayThickness}
                onChange={setOneWayThickness}
                min={1}
                max={10}
                step={1}
                format={(v) => String(v)}
                linkTarget="oneWayThickness"
              />
            </div>
          )}
        </>
      )}

      {hasTeleports && (
        <>
          <div style={styles.divider} />

          <SectionHeader
            label={m["image_export.vector_by_walls.section_teleports"]()}
            expanded={isExpanded("teleports")}
            onToggle={() => toggleSection("teleports")}
          />
          {isExpanded("teleports") && (
            <TeleportSettingsSection
              settings={settings}
              onChange={patchTeleportSettings}
              groupOverrides={settings.teleportGroupOverrides}
              onGroupOverrideChange={setTeleportGroupOverride}
              onGroupOverridesPatch={patchTeleportGroupOverrides}
              teleportGroups={teleportGroups}
              teleportCollisionKeys={teleportCollisionKeys}
              hasCrossFloorTeleports={hasCrossFloorTeleports}
              linkTargets={{
                lineCornerStyle: "teleportMarker.cornerStyle",
                lineShape: "teleportMarker.shape",
                lineSize: "teleportMarker.size",
                edgeColor: "teleportMarker.fillColor",
                edgeBorderColor: "teleportMarker.borderColor",
                edgeBorderWidth: "teleportMarker.borderWidth",
                edgeGapWidth: "teleportMarker.gapWidth",
                connectorStyle: null,
                avoidFieldExit: "teleportAvoidFieldExit",
                connectorColor: "teleportConnectorColor",
                connectorWidth: null,
                connectorGapWidth: "teleportConnectorGapWidth",
                arrowMode: null,
                arrowPeriod: null,
                arrowSize: null,
                floorBadgeShape: "teleportFloorBadge.shape",
                floorBadgeLabelType: "teleportFloorBadge.labelType",
                floorBadgeSize: "teleportFloorBadge.size",
                floorBadgeFillColor: "teleportFloorBadge.fillColor",
                floorBadgeBorderColor: "teleportFloorBadge.borderColor",
                floorBadgeTextColor: "teleportFloorBadge.textColor",
                floorBadgeBorderWidth: "teleportFloorBadge.borderWidth",
                floorBadgeCornerStyle: "teleportFloorBadge.cornerStyle",
                floorBadgeGapWidth: "teleportFloorBadge.gapWidth",
                floorBadgeTextSize: "teleportFloorBadge.textSize",
                floorBadgeTextMargin: "teleportFloorBadge.textMargin",
                floorBadgeTextFontWeight: "teleportFloorBadge.textFontWeight",
                groupCustomization: "teleportGroupCustomization",
              }}
              edgeColorPriority={[PC.teleportEdgeBorder.at(settings.teleportMarker.borderColor), PC.teleportConnector.at(settings.teleportConnectorColor), ...tpBadges, floor]}
              edgeBorderColorPriority={[PC.teleportEdge.at(settings.teleportMarker.fillColor), PC.teleportConnector.at(settings.teleportConnectorColor), ...tpBadges, floor]}
              connectorColorPriority={[PC.teleportEdge.at(settings.teleportMarker.fillColor), PC.teleportEdgeBorder.at(settings.teleportMarker.borderColor), ...tpBadges, floor]}
              floorBadgeFillColorPriority={[...tpBadges, PC.teleportEdge.at(settings.teleportMarker.fillColor), PC.teleportEdgeBorder.at(settings.teleportMarker.borderColor), PC.teleportConnector.at(settings.teleportConnectorColor), floor]}
              floorBadgeBorderColorPriority={[...tpBadges, PC.teleportEdge.at(settings.teleportMarker.fillColor), PC.teleportEdgeBorder.at(settings.teleportMarker.borderColor), PC.teleportConnector.at(settings.teleportConnectorColor), floor]}
              floorBadgeTextColorPriority={[...tpBadges, PC.teleportEdge.at(settings.teleportMarker.fillColor), PC.teleportEdgeBorder.at(settings.teleportMarker.borderColor), PC.teleportConnector.at(settings.teleportConnectorColor), floor]}
              edgeColorDefault={D.teleportMarker.fillColor}
              edgeBorderColorDefault={D.teleportMarker.borderColor}
              connectorColorDefault={D.teleportConnectorColor}
              floorBadgeFillColorDefault={D.teleportFloorBadge.fillColor}
              floorBadgeBorderColorDefault={D.teleportFloorBadge.borderColor}
              floorBadgeTextColorDefault={D.teleportFloorBadge.textColor}
              edgeColorField={PC.teleportEdge}
              edgeBorderColorField={PC.teleportEdgeBorder}
              connectorColorField={PC.teleportConnector}
              floorBadgeFillColorField={PC.teleportBadgeFill}
              floorBadgeBorderColorField={PC.teleportBadgeBorder}
              floorBadgeTextColorField={PC.teleportBadgeText}
            />
          )}
        </>
      )}

      {hasVerticalSection && (
        <>
          <div style={styles.divider} />

          <SectionHeader
            label={m["image_export.vector_by_walls.section_vertical"]()}
            expanded={isExpanded("vertical")}
            onToggle={() => toggleSection("vertical")}
          />
          {isExpanded("vertical") && (
            <div style={styles.block}>
              <LinkedSelectRow
                label={m["image_export.vector_by_walls.vertical_style"]()}
                value={settings.verticalStyle}
                options={[
                  { value: "abstract", label: m["image_export.vector_by_walls.vertical_style_abstract"]() },
                  { value: "decorative", label: m["image_export.vector_by_walls.vertical_style_decorative"]() },
                ]}
                onChange={(verticalStyle) => patchVerticalSettings({ verticalStyle })}
                linkTarget={null}
              />

              <div style={styles.subGroupWrap}>
                <SubsectionHeader
                  label={m["image_export.vector_by_walls.vertical_subsection_shared_style"]()}
                  expanded={isExpanded("vertical_shared_style")}
                  onToggle={() => toggleSection("vertical_shared_style")}
                />
                {isExpanded("vertical_shared_style") && (
                <LayoutGate gate="verticalDecorative">
                <div style={styles.subGroup}>
                  <LinkedSliderRow
                    label={m["image_export.vector_by_walls.vertical_shared_style_size"]()}
                    value={settings.verticalDecorativeSize}
                    onChange={(verticalDecorativeSize) => patchVerticalSharedStyle({ verticalDecorativeSize })}
                    min={0.1 * TILE_SIZE}
                    max={TILE_SIZE}
                    step={1}
                    format={(v) => String(Math.round(v))}
                    linkTarget="verticalDecorativeSize"
                  />
                  <LinkedSliderRow
                    label={m["image_export.vector_by_walls.vertical_shared_style_arrow_size"]()}
                    value={settings.verticalDecorativeArrowSize}
                    onChange={(verticalDecorativeArrowSize) => patchVerticalSharedStyle({ verticalDecorativeArrowSize })}
                    min={0.2}
                    max={1}
                    step={0.05}
                    format={(v) => v.toFixed(2)}
                    linkTarget="verticalDecorativeArrowSize"
                  />
                  <LinkedSliderRow
                    label={m["image_export.vector_by_walls.vertical_shared_style_line_width"]()}
                    value={settings.verticalDecorativeLineWidth}
                    onChange={(verticalDecorativeLineWidth) => patchVerticalSharedStyle({ verticalDecorativeLineWidth })}
                    min={0}
                    max={10}
                    step={1}
                    format={(v) => String(v)}
                    linkTarget="verticalDecorativeLineWidth"
                  />
                  <LinkedColorRow
                    label={m["image_export.vector_by_walls.vertical_shared_style_line_color"]()}
                    color={settings.verticalDecorativeLineColor}
                    onChange={(verticalDecorativeLineColor) => patchVerticalSharedStyle({ verticalDecorativeLineColor })}
                    priorityColors={[wall, floor]}
                    defaultColor={D.verticalDecorativeLineColor}
                    field={PC.verticalDecorLine}
                    linkTarget="verticalDecorativeLineColor"
                  />
                </div>
                </LayoutGate>
                )}
                {isExpanded("vertical_shared_style") && (
                <LayoutGate gate="verticalAbstract">
                <div style={styles.subGroup}>
                  <div style={styles.subGroupWrap}>
                    <div style={styles.subHeader}>{m["image_export.vector_by_walls.vertical_subsection_marker"]()}</div>
                    <div style={styles.subGroup}>
                      <LinkedSelectRow
                        label={m["image_export.vector_by_walls.marker_shape"]()}
                        value={settings.verticalShape}
                        options={markerShapeSelectOptions()}
                        onChange={(verticalShape) => patchVerticalSharedStyle({ verticalShape })}
                        linkTarget="verticalShape"
                      />
                      <LinkedSelectRow
                        label={m["image_export.vector_by_walls.marker_corner_style"]()}
                        value={settings.verticalCornerStyle}
                        options={[
                                                    { value: "miter", label: m["image_export.vector_by_walls.corner_style_sharp"]() },
{ value: "round", label: m["image_export.vector_by_walls.corner_style_round"]() },
                        ]}
                        onChange={(verticalCornerStyle) => patchVerticalSharedStyle({ verticalCornerStyle })}
                        linkTarget="verticalCornerStyle"
                      />
                      <LinkedSliderRow
                        label={m["image_export.vector_by_walls.marker_size"]()}
                        value={settings.verticalSize}
                        onChange={(verticalSize) => patchVerticalSharedStyle({ verticalSize })}
                        min={0.1 * TILE_SIZE}
                        max={TILE_SIZE}
                        step={1}
                        format={(v) => String(Math.round(v))}
                        linkTarget="verticalSize"
                      />
                      <LinkedColorRow
                        label={m["image_export.vector_by_walls.marker_fill_color"]()}
                        color={settings.verticalFillColor}
                        onChange={(verticalFillColor) => patchVerticalSharedStyle({ verticalFillColor })}
                        priorityColors={[PC.verticalArrow.at(settings.verticalArrowColor), floor]}
                        defaultColor={D.verticalFillColor}
                        field={PC.verticalFill}
                        linkTarget="verticalFillColor"
                      />
                      <LinkedSliderRow
                        label={m["image_export.vector_by_walls.marker_border_width"]()}
                        value={settings.verticalBorderWidth}
                        onChange={(verticalBorderWidth) => patchVerticalSharedStyle({ verticalBorderWidth })}
                        min={0}
                        max={10}
                        step={1}
                        format={(v) => String(v)}
                        linkTarget="verticalBorderWidth"
                      />
                      <LinkedSliderRow
                        label={m["image_export.vector_by_walls.marker_gap_width"]()}
                        value={settings.verticalGapWidth}
                        onChange={(verticalGapWidth) => patchVerticalSharedStyle({ verticalGapWidth })}
                        min={0}
                        max={10}
                        step={1}
                        format={(v) => String(v)}
                        linkTarget="verticalGapWidth"
                      />
                    </div>
                  </div>

                  <div style={styles.subGroupWrap}>
                    <div style={styles.subHeader}>{m["image_export.vector_by_walls.vertical_subsection_arrows"]()}</div>
                    <div style={styles.subGroup}>
                      <LinkedColorRow
                        label={m["image_export.vector_by_walls.vertical_arrow_color"]()}
                        color={settings.verticalArrowColor}
                        onChange={(verticalArrowColor) => patchVerticalSharedStyle({ verticalArrowColor })}
                        priorityColors={[PC.verticalFill.at(settings.verticalFillColor), floor, background]}
                        defaultColor={D.verticalArrowColor}
                        field={PC.verticalArrow}
                        linkTarget="verticalArrowColor"
                      />
                      <LinkedSliderRow
                        label={m["image_export.vector_by_walls.vertical_arrow_size"]()}
                        value={settings.verticalArrowSize}
                        onChange={(verticalArrowSize) => patchVerticalSharedStyle({ verticalArrowSize })}
                        min={0.2}
                        max={1}
                        step={0.05}
                        format={(v) => v.toFixed(2)}
                        linkTarget="verticalArrowSize"
                      />
                      <LinkedSelectRow
                        label={m["image_export.vector_by_walls.vertical_arrow_style"]()}
                        value={settings.verticalArrowStyle}
                        options={[
                          { value: "triangle" as VerticalArrowStyle, label: m["image_export.vector_by_walls.one_way_pattern_triangle"]() },
                          { value: "chevron" as VerticalArrowStyle, label: m["image_export.vector_by_walls.one_way_pattern_chevron"]() },
                          { value: "arrow" as VerticalArrowStyle, label: m["image_export.vector_by_walls.one_way_pattern_arrow"]() },
                          { value: "sign" as VerticalArrowStyle, label: m["image_export.vector_by_walls.vertical_arrow_style_sign"]() },
                        ]}
                        onChange={(verticalArrowStyle) => patchVerticalSharedStyle({ verticalArrowStyle })}
                        linkTarget="verticalArrowStyle"
                      />
                      <LinkedSelectRow
                        label={m["image_export.vector_by_walls.vertical_arrow_corner_style"]()}
                        value={settings.verticalArrowCornerStyle}
                        options={[
                          { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
                          { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
                        ]}
                        onChange={(verticalArrowCornerStyle) => patchVerticalSharedStyle({ verticalArrowCornerStyle })}
                        linkTarget="verticalArrowCornerStyle"
                      />
                    </div>
                  </div>
                </div>
                </LayoutGate>
                )}
              </div>

              <LayoutGate gate="verticalDecorative">
                <div style={styles.subGroupWrap}>
                  <SubsectionHeader label={m["image_export.vector_by_walls.two_way_passage_marker"]()} expanded={isExpanded("vertical_two_way") && hasTwoWayPassages} disabled={!hasTwoWayPassages} onToggle={() => toggleSection("vertical_two_way")} />
                  {isExpanded("vertical_two_way") && hasTwoWayPassages && (
                  <div style={styles.subGroup}>
                    <DecorativeLineStyleGroup
                      settings={settings.decorativeStairsTwoWay}
                      onChange={(patch) => patchDecorativeLineStyle("decorativeStairsTwoWay", patch)}
                      linkTargets={{ lineColor: "decorativeStairsTwoWay.lineColor", lineWidth: "decorativeStairsTwoWay.lineWidth", size: "decorativeStairsTwoWay.size" }}
                      lineColorPriority={onFloor}
                      lineColorDefault={D.decorativeStairsTwoWay.lineColor}
                      lineColorField={PC.decorLineTwoWay}
                    />
                    <div style={styles.subGroupWrap}>
                      <div style={styles.subHeader}>{m["image_export.vector_by_walls.vertical_subsection_arrows"]()}</div>
                      <div style={styles.subGroup}>
                        <LinkedColorRow
                          label={m["image_export.vector_by_walls.vertical_arrow_color"]()}
                          color={settings.decorativeStairsArrowColor}
                          onChange={(decorativeStairsArrowColor) => patchVerticalSettings({ decorativeStairsArrowColor })}
                          priorityColors={[PC.decorLineTwoWay.at(settings.decorativeStairsTwoWay.lineColor), floor]}
                          defaultColor={D.decorativeStairsArrowColor}
                          field={PC.decorArrowTwoWay}
                          linkTarget="decorativeStairsArrowColor"
                        />
                        <LinkedSliderRow
                          label={m["image_export.vector_by_walls.vertical_arrow_size"]()}
                          value={settings.decorativeStairsArrowSize}
                          onChange={(decorativeStairsArrowSize) => patchVerticalSettings({ decorativeStairsArrowSize })}
                          min={0.2}
                          max={1}
                          step={0.05}
                          format={(v) => v.toFixed(2)}
                          linkTarget="decorativeStairsArrowSize"
                        />
                      </div>
                    </div>
                  </div>
                  )}
                </div>
              </LayoutGate>

              <LayoutGate gate="verticalDecorative">
                <div style={styles.subGroupWrap}>
                  <SubsectionHeader label={m["image_export.vector_by_walls.one_way_passage_marker"]()} expanded={isExpanded("vertical_one_way") && hasOneWayPassages} disabled={!hasOneWayPassages} onToggle={() => toggleSection("vertical_one_way")} />
                  {isExpanded("vertical_one_way") && hasOneWayPassages && (
                  <div style={styles.subGroup}>
                    <DecorativeLineStyleGroup
                      settings={settings.decorativeStairsOneWay}
                      onChange={(patch) => patchDecorativeLineStyle("decorativeStairsOneWay", patch)}
                      linkTargets={{ lineColor: "decorativeStairsOneWay.lineColor", lineWidth: "decorativeStairsOneWay.lineWidth", size: "decorativeStairsOneWay.size" }}
                      lineColorPriority={onFloor}
                      lineColorDefault={D.decorativeStairsOneWay.lineColor}
                      lineColorField={PC.decorLineOneWay}
                    />
                    <div style={styles.subGroupWrap}>
                      <div style={styles.subHeader}>{m["image_export.vector_by_walls.vertical_subsection_arrows"]()}</div>
                      <div style={styles.subGroup}>
                        <LinkedColorRow
                          label={m["image_export.vector_by_walls.vertical_arrow_color"]()}
                          color={settings.decorativeStairsOneWayArrowColor}
                          onChange={(decorativeStairsOneWayArrowColor) => patchVerticalSettings({ decorativeStairsOneWayArrowColor })}
                          priorityColors={[PC.decorLineOneWay.at(settings.decorativeStairsOneWay.lineColor), floor]}
                          defaultColor={D.decorativeStairsOneWayArrowColor}
                          field={PC.decorArrowOneWay}
                          linkTarget="decorativeStairsOneWayArrowColor"
                        />
                        <LinkedSliderRow
                          label={m["image_export.vector_by_walls.vertical_arrow_size"]()}
                          value={settings.decorativeStairsOneWayArrowSize}
                          onChange={(decorativeStairsOneWayArrowSize) => patchVerticalSettings({ decorativeStairsOneWayArrowSize })}
                          min={0.2}
                          max={1}
                          step={0.05}
                          format={(v) => v.toFixed(2)}
                          linkTarget="decorativeStairsOneWayArrowSize"
                        />
                      </div>
                    </div>
                  </div>
                  )}
                </div>
              </LayoutGate>

              <LayoutGate gate="verticalDecorative">
                <div style={styles.subGroupWrap}>
                  <SubsectionHeader label={m["image_export.vector_by_walls.elevator_marker"]()} expanded={isExpanded("vertical_elevator") && hasElevators} disabled={!hasElevators} onToggle={() => toggleSection("vertical_elevator")} />
                  {isExpanded("vertical_elevator") && hasElevators && (
                  <div style={styles.subGroup}>
                    <LinkedToggleRow
                      label={m["image_export.vector_by_walls.replace_two_floor_elevators_with_stairs"]()}
                      checked={settings.replaceTwoFloorElevatorsWithStairs}
                      onChange={(replaceTwoFloorElevatorsWithStairs) => patchVerticalSettings({ replaceTwoFloorElevatorsWithStairs })}
                      linkTarget="replaceTwoFloorElevatorsWithStairs"
                    />
                    <DecorativeLineStyleGroup
                      settings={settings.decorativeElevator}
                      onChange={(patch) => patchDecorativeLineStyle("decorativeElevator", patch)}
                      linkTargets={{ lineColor: "decorativeElevator.lineColor", lineWidth: "decorativeElevator.lineWidth", size: "decorativeElevator.size" }}
                      lineColorPriority={onFloor}
                      lineColorDefault={D.decorativeElevator.lineColor}
                      lineColorField={PC.decorLineElevator}
                    />
                    <ElevatorBadgesSubsection
                      settings={settings.elevatorBadges}
                      onChange={patchElevatorBadges}
                      onCornerStyleChange={setElevatorBadgesCornerStyle}
                      linkTargets={{
                        enabled: "elevatorBadges.enabled",
                        labelType: "elevatorBadges.labelType",
                        textFontWeight: "elevatorBadges.textFontWeight",
                        placement: null,
                        shape: "elevatorBadges.shape",
                        cornerStyle: "elevatorBadges.cornerStyle",
                        size: "elevatorBadges.size",
                        distance: "elevatorBadges.distance",
                        evenDistribution: "elevatorBadges.evenDistribution",
                        gap: "elevatorBadges.gap",
                        gapWidth: "elevatorBadges.gapWidth",
                        fillColor: "elevatorBadges.fillColor",
                        textColor: "elevatorBadges.textColor",
                        borderColor: "elevatorBadges.borderColor",
                        borderWidth: "elevatorBadges.borderWidth",
                        textSize: "elevatorBadges.textSize",
                        textMargin: "elevatorBadges.textMargin",
                      }}
                      fillColorPriority={badgeFillPriority}
                      borderColorPriority={badgeBorderPriority}
                      textColorPriority={badgeTextPriority}
                      fillColorDefault={D.elevatorBadges.fillColor}
                      borderColorDefault={D.elevatorBadges.borderColor}
                      textColorDefault={D.elevatorBadges.textColor}
                      fillColorField={PC.elevatorBadgeFill}
                      borderColorField={PC.elevatorBadgeBorder}
                      textColorField={PC.elevatorBadgeText}
                    />
                  </div>
                  )}
                </div>
              </LayoutGate>

              <LayoutGate gate="verticalAbstract">
                <div style={styles.subGroupWrap}>
                  <SubsectionHeader label={m["image_export.vector_by_walls.two_way_passage_marker"]()} expanded={isExpanded("vertical_two_way") && hasTwoWayPassages} disabled={!hasTwoWayPassages} onToggle={() => toggleSection("vertical_two_way")} />
                  {isExpanded("vertical_two_way") && hasTwoWayPassages && (
                  <div style={styles.subGroup}>
                    <div style={styles.subGroupWrap}>
                      <div style={styles.subHeader}>{m["image_export.vector_by_walls.vertical_subsection_marker"]()}</div>
                      <div style={styles.subGroup}>
                        <MarkerSettingsGroup
                          title=""
                          showTextSection={false}
                          settings={settings.twoWayPassageMarker}
                          priorityColors={{
                            fillColor: [PC.twoWayBorder.at(settings.twoWayPassageMarker.borderColor), PC.twoWayArrow.at(settings.twoWayArrowColor), ...vOneWay, ...vElevator, ...vTail],
                            borderColor: [PC.twoWayFill.at(settings.twoWayPassageMarker.fillColor), PC.twoWayArrow.at(settings.twoWayArrowColor), ...vOneWay, ...vElevator, ...vTail],
                          }}
                          defaultColors={{ fillColor: D.twoWayPassageMarker.fillColor, borderColor: D.twoWayPassageMarker.borderColor }}
                          fields={{
                            fillColor: PC.twoWayFill,
                            borderColor: PC.twoWayBorder,
                          }}
                          onChange={(patch) => {
                            if (patch.shape !== undefined) setTwoWayPassageMarkerShape(patch.shape);
                            if (patch.cornerStyle !== undefined) setTwoWayPassageMarkerCornerStyle(patch.cornerStyle);
                            if (patch.fillColor !== undefined) setTwoWayPassageMarkerFillColor(patch.fillColor);
                            if (patch.borderColor !== undefined) setTwoWayPassageMarkerBorderColor(patch.borderColor);
                            if (patch.borderWidth !== undefined) setTwoWayPassageMarkerBorderWidth(patch.borderWidth);
                            if (patch.gapWidth !== undefined) setTwoWayPassageMarkerGapWidth(patch.gapWidth);
                            if (patch.size !== undefined) setTwoWayPassageMarkerSize(patch.size);
                          }}
                          linkTargets={{
                            shape: "twoWayPassageMarker.shape",
                            cornerStyle: "twoWayPassageMarker.cornerStyle",
                            size: "twoWayPassageMarker.size",
                            fillColor: "twoWayPassageMarker.fillColor",
                            borderColor: "twoWayPassageMarker.borderColor",
                            borderWidth: "twoWayPassageMarker.borderWidth",
                            gapWidth: "twoWayPassageMarker.gapWidth",
                            textEnabled: null,
                            textFontWeight: null,
                            textSize: null,
                            textMargin: null,
                            textColor: null,
                          }}
                        />
                      </div>
                    </div>

                    <div style={styles.subGroupWrap}>
                      <div style={styles.subHeader}>{m["image_export.vector_by_walls.vertical_subsection_arrows"]()}</div>
                      <div style={styles.subGroup}>
                        <LinkedColorRow
                          label={m["image_export.vector_by_walls.vertical_arrow_color"]()}
                          color={settings.twoWayArrowColor}
                          onChange={(twoWayArrowColor) => patchVerticalSettings({ twoWayArrowColor })}
                          priorityColors={[PC.twoWayFill.at(settings.twoWayPassageMarker.fillColor), PC.twoWayBorder.at(settings.twoWayPassageMarker.borderColor), ...vOneWay, ...vElevator, ...vTailBg]}
                          defaultColor={D.twoWayArrowColor}
                          field={PC.twoWayArrow}
                          linkTarget="twoWayArrowColor"
                        />
                        <LinkedSliderRow
                          label={m["image_export.vector_by_walls.vertical_arrow_size"]()}
                          value={settings.twoWayArrowSize}
                          onChange={(twoWayArrowSize) => patchVerticalSettings({ twoWayArrowSize })}
                          min={0.2}
                          max={1}
                          step={0.05}
                          format={(v) => v.toFixed(2)}
                          linkTarget="twoWayArrowSize"
                        />
                        <LinkedSelectRow
                          label={m["image_export.vector_by_walls.vertical_arrow_style"]()}
                          value={settings.twoWayArrowStyle}
                          options={[
                            { value: "triangle" as VerticalArrowStyle, label: m["image_export.vector_by_walls.one_way_pattern_triangle"]() },
                            { value: "chevron" as VerticalArrowStyle, label: m["image_export.vector_by_walls.one_way_pattern_chevron"]() },
                            { value: "arrow" as VerticalArrowStyle, label: m["image_export.vector_by_walls.one_way_pattern_arrow"]() },
                            { value: "sign" as VerticalArrowStyle, label: m["image_export.vector_by_walls.vertical_arrow_style_sign"]() },
                          ]}
                          onChange={(twoWayArrowStyle) => patchVerticalSettings({ twoWayArrowStyle })}
                          linkTarget="twoWayArrowStyle"
                        />
                        <LinkedSelectRow
                          label={m["image_export.vector_by_walls.vertical_arrow_corner_style"]()}
                          value={settings.twoWayArrowCornerStyle}
                          options={[
                            { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
                            { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
                          ]}
                          onChange={(twoWayArrowCornerStyle) => patchVerticalSettings({ twoWayArrowCornerStyle })}
                          linkTarget="twoWayArrowCornerStyle"
                        />
                      </div>
                    </div>
                  </div>
                  )}
                </div>
              </LayoutGate>

              <LayoutGate gate="verticalAbstract">
                <div style={styles.subGroupWrap}>
                  <SubsectionHeader label={m["image_export.vector_by_walls.one_way_passage_marker"]()} expanded={isExpanded("vertical_one_way") && hasOneWayPassages} disabled={!hasOneWayPassages} onToggle={() => toggleSection("vertical_one_way")} />
                  {isExpanded("vertical_one_way") && hasOneWayPassages && (
                  <div style={styles.subGroup}>
                    <div style={styles.subGroupWrap}>
                      <div style={styles.subHeader}>{m["image_export.vector_by_walls.vertical_subsection_marker"]()}</div>
                      <div style={styles.subGroup}>
                        <MarkerSettingsGroup
                          title=""
                          showTextSection={false}
                          settings={settings.oneWayPassageMarker}
                          priorityColors={{
                            fillColor: [PC.oneWayBorder.at(settings.oneWayPassageMarker.borderColor), PC.oneWayArrow.at(settings.oneWayArrowColor), ...vTwoWay, ...vElevator, ...vTail],
                            borderColor: [PC.oneWayFill.at(settings.oneWayPassageMarker.fillColor), PC.oneWayArrow.at(settings.oneWayArrowColor), ...vTwoWay, ...vElevator, ...vTail],
                          }}
                          defaultColors={{ fillColor: D.oneWayPassageMarker.fillColor, borderColor: D.oneWayPassageMarker.borderColor }}
                          fields={{
                            fillColor: PC.oneWayFill,
                            borderColor: PC.oneWayBorder,
                          }}
                          onChange={(patch) => {
                            if (patch.shape !== undefined) setOneWayPassageMarkerShape(patch.shape);
                            if (patch.cornerStyle !== undefined) setOneWayPassageMarkerCornerStyle(patch.cornerStyle);
                            if (patch.fillColor !== undefined) setOneWayPassageMarkerFillColor(patch.fillColor);
                            if (patch.borderColor !== undefined) setOneWayPassageMarkerBorderColor(patch.borderColor);
                            if (patch.borderWidth !== undefined) setOneWayPassageMarkerBorderWidth(patch.borderWidth);
                            if (patch.gapWidth !== undefined) setOneWayPassageMarkerGapWidth(patch.gapWidth);
                            if (patch.size !== undefined) setOneWayPassageMarkerSize(patch.size);
                          }}
                          linkTargets={{
                            shape: "oneWayPassageMarker.shape",
                            cornerStyle: "oneWayPassageMarker.cornerStyle",
                            size: "oneWayPassageMarker.size",
                            fillColor: "oneWayPassageMarker.fillColor",
                            borderColor: "oneWayPassageMarker.borderColor",
                            borderWidth: "oneWayPassageMarker.borderWidth",
                            gapWidth: "oneWayPassageMarker.gapWidth",
                            textEnabled: null,
                            textFontWeight: null,
                            textSize: null,
                            textMargin: null,
                            textColor: null,
                          }}
                        />
                      </div>
                    </div>

                    <div style={styles.subGroupWrap}>
                      <div style={styles.subHeader}>{m["image_export.vector_by_walls.vertical_subsection_arrows"]()}</div>
                      <div style={styles.subGroup}>
                        <LinkedColorRow
                          label={m["image_export.vector_by_walls.vertical_arrow_color"]()}
                          color={settings.oneWayArrowColor}
                          onChange={(oneWayArrowColor) => patchVerticalSettings({ oneWayArrowColor })}
                          priorityColors={[PC.oneWayFill.at(settings.oneWayPassageMarker.fillColor), PC.oneWayBorder.at(settings.oneWayPassageMarker.borderColor), ...vTwoWay, ...vElevator, ...vTailBg]}
                          defaultColor={D.oneWayArrowColor}
                          field={PC.oneWayArrow}
                          linkTarget="oneWayArrowColor"
                        />
                        <LinkedSliderRow
                          label={m["image_export.vector_by_walls.vertical_arrow_size"]()}
                          value={settings.oneWayArrowSize}
                          onChange={(oneWayArrowSize) => patchVerticalSettings({ oneWayArrowSize })}
                          min={0.2}
                          max={1}
                          step={0.05}
                          format={(v) => v.toFixed(2)}
                          linkTarget="oneWayArrowSize"
                        />
                        <LinkedSelectRow
                          label={m["image_export.vector_by_walls.vertical_arrow_style"]()}
                          value={settings.oneWayArrowStyle}
                          options={[
                            { value: "triangle" as VerticalArrowStyle, label: m["image_export.vector_by_walls.one_way_pattern_triangle"]() },
                            { value: "chevron" as VerticalArrowStyle, label: m["image_export.vector_by_walls.one_way_pattern_chevron"]() },
                            { value: "arrow" as VerticalArrowStyle, label: m["image_export.vector_by_walls.one_way_pattern_arrow"]() },
                            { value: "sign" as VerticalArrowStyle, label: m["image_export.vector_by_walls.vertical_arrow_style_sign"]() },
                          ]}
                          onChange={(oneWayArrowStyle) => patchVerticalSettings({ oneWayArrowStyle })}
                          linkTarget="oneWayArrowStyle"
                        />
                        <LinkedSelectRow
                          label={m["image_export.vector_by_walls.vertical_arrow_corner_style"]()}
                          value={settings.oneWayArrowCornerStyle}
                          options={[
                            { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
                            { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
                          ]}
                          onChange={(oneWayArrowCornerStyle) => patchVerticalSettings({ oneWayArrowCornerStyle })}
                          linkTarget="oneWayArrowCornerStyle"
                        />
                      </div>
                    </div>
                  </div>
                  )}
                </div>
              </LayoutGate>

              <LayoutGate gate="verticalAbstract">
                <div style={styles.subGroupWrap}>
                  <SubsectionHeader label={m["image_export.vector_by_walls.elevator_marker"]()} expanded={isExpanded("vertical_elevator") && hasElevators} disabled={!hasElevators} onToggle={() => toggleSection("vertical_elevator")} />
                  {isExpanded("vertical_elevator") && hasElevators && (
                  <div style={styles.subGroup}>
                    <LinkedToggleRow
                      label={m["image_export.vector_by_walls.replace_two_floor_elevators_with_stairs"]()}
                      checked={settings.replaceTwoFloorElevatorsWithStairs}
                      onChange={(replaceTwoFloorElevatorsWithStairs) => patchVerticalSettings({ replaceTwoFloorElevatorsWithStairs })}
                      linkTarget="replaceTwoFloorElevatorsWithStairs"
                    />
                    <div style={styles.subGroupWrap}>
                      <div style={styles.subHeader}>{m["image_export.vector_by_walls.vertical_subsection_marker"]()}</div>
                      <div style={styles.subGroup}>
                        <MarkerSettingsGroup
                          title=""
                          showTextSection={false}
                          settings={settings.elevatorMarker}
                          priorityColors={{
                            fillColor: [PC.elevatorBorder.at(settings.elevatorMarker.borderColor), PC.elevatorArrow.at(settings.elevatorArrowColor), ...badges, ...vTwoWay, ...vOneWay, ...vTail],
                            borderColor: [PC.elevatorFill.at(settings.elevatorMarker.fillColor), PC.elevatorArrow.at(settings.elevatorArrowColor), ...badges, ...vTwoWay, ...vOneWay, ...vTail],
                          }}
                          defaultColors={{ fillColor: D.elevatorMarker.fillColor, borderColor: D.elevatorMarker.borderColor }}
                          fields={{
                            fillColor: PC.elevatorFill,
                            borderColor: PC.elevatorBorder,
                          }}
                          onChange={(patch) => {
                            if (patch.shape !== undefined) setElevatorMarkerShape(patch.shape);
                            if (patch.cornerStyle !== undefined) setElevatorMarkerCornerStyle(patch.cornerStyle);
                            if (patch.fillColor !== undefined) setElevatorMarkerFillColor(patch.fillColor);
                            if (patch.borderColor !== undefined) setElevatorMarkerBorderColor(patch.borderColor);
                            if (patch.borderWidth !== undefined) setElevatorMarkerBorderWidth(patch.borderWidth);
                            if (patch.gapWidth !== undefined) setElevatorMarkerGapWidth(patch.gapWidth);
                            if (patch.size !== undefined) setElevatorMarkerSize(patch.size);
                          }}
                          linkTargets={{
                            shape: "elevatorMarker.shape",
                            cornerStyle: "elevatorMarker.cornerStyle",
                            size: "elevatorMarker.size",
                            fillColor: "elevatorMarker.fillColor",
                            borderColor: "elevatorMarker.borderColor",
                            borderWidth: "elevatorMarker.borderWidth",
                            gapWidth: "elevatorMarker.gapWidth",
                            textEnabled: null,
                            textFontWeight: null,
                            textSize: null,
                            textMargin: null,
                            textColor: null,
                          }}
                        />
                      </div>
                    </div>

                    <div style={styles.subGroupWrap}>
                      <div style={styles.subHeader}>{m["image_export.vector_by_walls.vertical_subsection_arrows"]()}</div>
                      <div style={styles.subGroup}>
                        <LinkedColorRow
                          label={m["image_export.vector_by_walls.vertical_arrow_color"]()}
                          color={settings.elevatorArrowColor}
                          onChange={(elevatorArrowColor) => patchVerticalSettings({ elevatorArrowColor })}
                          priorityColors={[PC.elevatorFill.at(settings.elevatorMarker.fillColor), PC.elevatorBorder.at(settings.elevatorMarker.borderColor), ...badges, ...vTwoWay, ...vOneWay, ...vTailBg]}
                          defaultColor={D.elevatorArrowColor}
                          field={PC.elevatorArrow}
                          linkTarget="elevatorArrowColor"
                        />
                        <LinkedSliderRow
                          label={m["image_export.vector_by_walls.vertical_arrow_size"]()}
                          value={settings.elevatorArrowSize}
                          onChange={(elevatorArrowSize) => patchVerticalSettings({ elevatorArrowSize })}
                          min={0.2}
                          max={1}
                          step={0.05}
                          format={(v) => v.toFixed(2)}
                          linkTarget="elevatorArrowSize"
                        />
                        <LinkedSelectRow
                          label={m["image_export.vector_by_walls.vertical_arrow_style"]()}
                          value={settings.elevatorArrowStyle}
                          options={[
                            { value: "triangle" as OneWayPattern, label: m["image_export.vector_by_walls.one_way_pattern_triangle"]() },
                            { value: "chevron" as OneWayPattern, label: m["image_export.vector_by_walls.one_way_pattern_chevron"]() },
                            { value: "arrow" as OneWayPattern, label: m["image_export.vector_by_walls.one_way_pattern_arrow"]() },
                            { value: "sign" as VerticalArrowStyle, label: m["image_export.vector_by_walls.vertical_arrow_style_sign"]() },
                          ]}
                          onChange={(elevatorArrowStyle) => patchVerticalSettings({ elevatorArrowStyle })}
                          linkTarget="elevatorArrowStyle"
                        />
                        <LinkedSelectRow
                          label={m["image_export.vector_by_walls.vertical_arrow_corner_style"]()}
                          value={settings.elevatorArrowCornerStyle}
                          options={[
                            { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
                            { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
                          ]}
                          onChange={(elevatorArrowCornerStyle) => patchVerticalSettings({ elevatorArrowCornerStyle })}
                          linkTarget="elevatorArrowCornerStyle"
                        />
                      </div>
                    </div>

                    <ElevatorBadgesSubsection
                      settings={settings.elevatorBadges}
                      onChange={patchElevatorBadges}
                      onCornerStyleChange={setElevatorBadgesCornerStyle}
                      linkTargets={{
                        enabled: "elevatorBadges.enabled",
                        labelType: "elevatorBadges.labelType",
                        textFontWeight: "elevatorBadges.textFontWeight",
                        placement: null,
                        shape: "elevatorBadges.shape",
                        cornerStyle: "elevatorBadges.cornerStyle",
                        size: "elevatorBadges.size",
                        distance: "elevatorBadges.distance",
                        evenDistribution: "elevatorBadges.evenDistribution",
                        gap: "elevatorBadges.gap",
                        gapWidth: "elevatorBadges.gapWidth",
                        fillColor: "elevatorBadges.fillColor",
                        textColor: "elevatorBadges.textColor",
                        borderColor: "elevatorBadges.borderColor",
                        borderWidth: "elevatorBadges.borderWidth",
                        textSize: "elevatorBadges.textSize",
                        textMargin: "elevatorBadges.textMargin",
                      }}
                      fillColorPriority={badgeFillPriority}
                      borderColorPriority={badgeBorderPriority}
                      textColorPriority={badgeTextPriority}
                      fillColorDefault={D.elevatorBadges.fillColor}
                      borderColorDefault={D.elevatorBadges.borderColor}
                      textColorDefault={D.elevatorBadges.textColor}
                      fillColorField={PC.elevatorBadgeFill}
                      borderColorField={PC.elevatorBadgeBorder}
                      textColorField={PC.elevatorBadgeText}
                    />
                  </div>
                  )}
                </div>
              </LayoutGate>
            </div>
          )}
        </>
      )}

      {maxSplit > 0 && (
        <>
          <div style={styles.divider} />

          <SectionHeader
            label={m["image_export.vector_by_walls.section_splits"]()}
            expanded={isExpanded("splits")}
            onToggle={() => toggleSection("splits")}
          />
          {isExpanded("splits") && (
            <div style={styles.block}>
              {Array.from({ length: maxSplit }, (_, i) => {
                const slotColor = (j: number) => settings.splitNodeColors[j] ?? splitSlotColor(j, canvas.node.splitSlots);
                return (
                <LinkedColorRow
                  key={i}
                  label={m["image_export.vector_by_walls.split_node_color"]({ index: String(i + 1) })}
                  color={slotColor(i)}
                  onChange={(color) => setSplitNodeColor(i, color)}
                  field={PC.splitNode(i)}
                  defaultColor={D.splitNodeColors[i] ?? splitSlotColor(i, canvas.node.splitSlots)}
                  priorityColors={[
                    ...Array.from({ length: maxSplit }, (_, j) => j).filter((j) => j !== i).map((j) =>
                      PC.splitNode(j).at(slotColor(j)),
                    ),
                    floor,
                    wall,
                  ]}
                  linkTarget={null}
                />
                );
              })}
              <LinkedToggleRow
                label={m["image_export.vector_by_walls.split_special_shapes"]()}
                checked={settings.splitSpecialShapes}
                onChange={setSplitSpecialShapes}
                linkTarget="splitSpecialShapes"
              />
            </div>
          )}
        </>
      )}

      {hasMarkerIndexSource && (
        <>
          <div style={styles.divider} />

          <SectionHeader
            label={m["image_export.vector_by_walls.section_marker_index"]()}
            expanded={isExpanded("marker_index")}
            onToggle={() => toggleSection("marker_index")}
          />
          {isExpanded("marker_index") && (
            <MarkerIndexSection
              settings={settings.markerIndex}
              onChange={patchMarkerIndex}
              linkTargets={{
                enabled: "markerIndex.enabled",
                coverageSingleFloorTeleport: "markerIndex.coverage.singleFloorTeleport",
                coverageCrossFloorTeleport: "markerIndex.coverage.crossFloorTeleport",
                coverageVerticalPassage: "markerIndex.coverage.verticalPassage",
                coverageElevator: "markerIndex.coverage.elevator",
                labelStyle: "markerIndex.labelStyle",
                textFontWeight: "markerIndex.textFontWeight",
                width: "markerIndex.width",
                textSize: "markerIndex.textSize",
                textMargin: "markerIndex.textMargin",
                height: "markerIndex.height",
                offset: "markerIndex.offset",
                cornerRadius: "markerIndex.cornerRadius",
                gap: "markerIndex.gap",
                borderWidthFromMarker: "markerIndex.borderWidthFromMarker",
                borderWidth: "markerIndex.borderWidth",
                fillColor: "markerIndex.fillColor",
                textColor: "markerIndex.textColor",
                borderColorFromMarker: "markerIndex.borderColorFromMarker",
                borderColor: "markerIndex.borderColor",
              }}
              fillColorPriority={[PC.markerIndexText.at(settings.markerIndex.textColor), PC.markerIndexBorder.at(settings.markerIndex.borderColor), floor, background]}
              textColorPriority={[PC.markerIndexFill.at(settings.markerIndex.fillColor), PC.markerIndexBorder.at(settings.markerIndex.borderColor), floor, background]}
              borderColorPriority={[PC.markerIndexFill.at(settings.markerIndex.fillColor), PC.markerIndexText.at(settings.markerIndex.textColor), floor]}
              fillColorDefault={D.markerIndex.fillColor}
              textColorDefault={D.markerIndex.textColor}
              borderColorDefault={D.markerIndex.borderColor}
              fillColorField={PC.markerIndexFill}
              textColorField={PC.markerIndexText}
              borderColorField={PC.markerIndexBorder}
            />
          )}
        </>
      )}

    </div>
    </TextFitContextProvider>
    </ColorVisibilityProvider>
    </LinkContextProvider>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: spacing.itemGap, padding: `${inset.panelInsetY}px ${inset.panelInsetX}px` },
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.itemGap}px 0` },
  subGroupWrap: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  subHeaderRow: { display: "flex", alignItems: "center", gap: spacing.itemGap, cursor: "default", borderRadius: 3 },
  subHeader: { ...typography.body },
  subGroup: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
};
