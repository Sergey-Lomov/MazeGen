import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { VerticalArrowStyle } from "../../pixi/renderers/types";
import { indent, inset, spacing, typography, ui } from "../../styles/theme";
import { SelectRow } from "../SelectRow";
import { LinkedColorRow, LinkedSelectRow, LinkedSliderRow, LinkedToggleRow } from "./LinkedRows";
import { LinkContextProvider, type LinkContextValue } from "./LinkContext";
import { CategoryInfoModal } from "../CategoryInfoModal";
import { SectionHeader, SubsectionHeader } from "../SectionHeader";
import { MarkerSettingsGroup, markerShapeSelectOptions } from "./MarkerSettingsGroup";
import { ElevatorBadgesSubsection } from "./ElevatorBadgesSubsection";
import { MarkerIndexSection } from "./MarkerIndexSection";
import { TeleportSettingsSection, useTeleportGroupsAndCollisions } from "./TeleportSettingsSection";
import { SharedStyleSection, SettingsSection } from "./SharedStyleSection";
import { DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS as D } from "../../store/slices/imageExportDefaults";
import { VECTOR_BY_CORRIDORS_PARAM_REGISTRY } from "../../store/parameterLinksRegistry";
import { computeActivePaths } from "../../store/parameterLinksActivity";
import { computeVectorByCorridorsWarningsAcrossFloors } from "../../pixi/selectors/exportWarnings";
import { resolveEffectiveEndpoints } from "../../pixi/imageExport/VectorByWallsRenderer";
import { ExportWarningsSection } from "./ExportWarningsSection";
import { maxSplitNodeCount, hasCrossFloorTeleport } from "../../pixi/selectors/mazeSelectors";
import { splitSlotColor } from "../../pixi/colorUtils";
import { canvas } from "../../pixi/colorTokens";
import { TILE_SIZE } from "../../pixi/constants";
import { PC } from "../../pixi/selectors/projectColorsSelector";
import * as m from "~/paraglide/messages";

const MAX_SPLIT_GAP_WIDTH = 10;

/** "Vector by corridors" mode's own settings panel (GitHub issue #310) — a collapsible "Background"
 * section (GitHub issue #309) reusing `VectorByWallsSettingsPanel`'s own section, same field set
 * (background color, grid visibility, grid color) and same `i18n` message keys (no corridors-specific
 * wording needed, mirrors the "Waypoints" section's own key-reuse convention below), placed first —
 * same position as in `VectorByWallsSettingsPanel`. A collapsible "Cells"
 * section (mirrors `VectorByWallsSettingsPanel`'s own "Tiles" section naming/collapse convention,
 * `vectorByCorridorsSectionsExpanded` keyed the same way) covering the corridor stroke's color,
 * corners & ends (round/miter join, paired with a round/square cap, same convention as
 * `VectorByWallsSettingsPanel`'s wall join setting), thickness (1 to `TILE_SIZE` — a corridor
 * wider than a whole cell has no meaningful upper bound of its own, so the cap tracks the cell size
 * rather than a fixed pixel constant, unlike `VectorByWallsSettings.wallThickness`'s fixed 1-20
 * range) and the widen-patch padding/shape (`markerWidenPadding`/`markerWidenShape`, GitHub issue
 * #313 follow-up moved these here from the Waypoints section — they widen the corridor under every
 * marker kind on this canvas, waypoint and teleport alike, so they're a corridor-line concern, not
 * a waypoint-only one; one shared pair of settings, not a separate one per marker kind). One-ways
 * section (GitHub issue #312) reuses `VectorByWallsSettingsPanel`'s own section title/placement
 * (before Teleports, hidden unless `hasOneWays`), but its own field set — the corridor reading has
 * no wall segment to draw an indicator on, so it's a chevron row breaking the corridor line
 * (`drawOneWayChevronRow`) rather than `VectorByWallsSettings.oneWayPattern`'s single indicator.
 * Teleports section (GitHub issue #313) mirrors `VectorByWallsSettingsPanel`'s own section — same
 * `TeleportSettingsSection`, only the underlying store setters differ (`patch*`), same reuse
 * convention as the Waypoints section's `MarkerSettingsGroup`. Bottom warnings section mirrors
 * `VectorByWallsSettingsPanel`'s own layout so both panels stay visually consistent. */
export function VectorByCorridorsSettingsPanel() {
  const settings = useMazeStore((s) => s.vectorByCorridorsSettings);
  const showColorWarnings = useMazeStore((s) => s.showColorWarnings);
  const setShowColorWarnings = useMazeStore((s) => s.setShowColorWarnings);
  const setBackground = useMazeStore((s) => s.setVectorByCorridorsBackground);
  const setShowGrid = useMazeStore((s) => s.setVectorByCorridorsShowGrid);
  const setGridColor = useMazeStore((s) => s.setVectorByCorridorsGridColor);
  const setColor = useMazeStore((s) => s.setVectorByCorridorsColor);
  const setJoin = useMazeStore((s) => s.setVectorByCorridorsJoin);
  const setRenderStyle = useMazeStore((s) => s.setVectorByCorridorsRenderStyle);
  const [renderStyleInfoOpen, setRenderStyleInfoOpen] = useState(false);
  const setThickness = useMazeStore((s) => s.setVectorByCorridorsThickness);

  const setStartMarkerShape = useMazeStore((s) => s.setVectorByCorridorsStartMarkerShape);
  const setStartMarkerText = useMazeStore((s) => s.setVectorByCorridorsStartMarkerText);
  const setStartMarkerTextEnabled = useMazeStore((s) => s.setVectorByCorridorsStartMarkerTextEnabled);
  const setStartMarkerTextFontWeight = useMazeStore((s) => s.setVectorByCorridorsStartMarkerTextFontWeight);
  const setStartMarkerTextSize = useMazeStore((s) => s.setVectorByCorridorsStartMarkerTextSize);
  const setStartMarkerTextColor = useMazeStore((s) => s.setVectorByCorridorsStartMarkerTextColor);
  const setStartMarkerCornerStyle = useMazeStore((s) => s.setVectorByCorridorsStartMarkerCornerStyle);
  const setStartMarkerFillColor = useMazeStore((s) => s.setVectorByCorridorsStartMarkerFillColor);
  const setStartMarkerBorderColor = useMazeStore((s) => s.setVectorByCorridorsStartMarkerBorderColor);
  const setStartMarkerBorderWidth = useMazeStore((s) => s.setVectorByCorridorsStartMarkerBorderWidth);
  const setStartMarkerGapWidth = useMazeStore((s) => s.setVectorByCorridorsStartMarkerGapWidth);
  const setStartMarkerSize = useMazeStore((s) => s.setVectorByCorridorsStartMarkerSize);
  const setFinishMarkerShape = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerShape);
  const setFinishMarkerText = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerText);
  const setFinishMarkerTextEnabled = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerTextEnabled);
  const setFinishMarkerTextFontWeight = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerTextFontWeight);
  const setFinishMarkerTextSize = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerTextSize);
  const setFinishMarkerTextColor = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerTextColor);
  const setFinishMarkerCornerStyle = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerCornerStyle);
  const setFinishMarkerFillColor = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerFillColor);
  const setFinishMarkerBorderColor = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerBorderColor);
  const setFinishMarkerBorderWidth = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerBorderWidth);
  const setFinishMarkerGapWidth = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerGapWidth);
  const setFinishMarkerSize = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerSize);
  const setMarkerWidenPadding = useMazeStore((s) => s.setVectorByCorridorsMarkerWidenPadding);
  const setMarkerWidenShape = useMazeStore((s) => s.setVectorByCorridorsMarkerWidenShape);
  const patchOneWaySettings = useMazeStore((s) => s.patchVectorByCorridorsOneWaySettings);
  const patchVerticalSettings = useMazeStore((s) => s.patchVectorByCorridorsVerticalSettings);
  const patchVerticalSharedStyle = useMazeStore((s) => s.patchVectorByCorridorsVerticalSharedStyle);
  const patchElevatorBadges = useMazeStore((s) => s.patchVectorByCorridorsElevatorBadges);
  const patchMarkerIndex = useMazeStore((s) => s.patchVectorByCorridorsMarkerIndexSettings);
  const setElevatorBadgesCornerStyle = useMazeStore((s) => s.setVectorByCorridorsElevatorBadgesCornerStyle);
  const setTwoWayPassageMarkerShape = useMazeStore((s) => s.setVectorByCorridorsTwoWayPassageMarkerShape);
  const setTwoWayPassageMarkerCornerStyle = useMazeStore((s) => s.setVectorByCorridorsTwoWayPassageMarkerCornerStyle);
  const setTwoWayPassageMarkerFillColor = useMazeStore((s) => s.setVectorByCorridorsTwoWayPassageMarkerFillColor);
  const setTwoWayPassageMarkerBorderColor = useMazeStore((s) => s.setVectorByCorridorsTwoWayPassageMarkerBorderColor);
  const setTwoWayPassageMarkerBorderWidth = useMazeStore((s) => s.setVectorByCorridorsTwoWayPassageMarkerBorderWidth);
  const setTwoWayPassageMarkerGapWidth = useMazeStore((s) => s.setVectorByCorridorsTwoWayPassageMarkerGapWidth);
  const setTwoWayPassageMarkerSize = useMazeStore((s) => s.setVectorByCorridorsTwoWayPassageMarkerSize);
  const setOneWayPassageMarkerShape = useMazeStore((s) => s.setVectorByCorridorsOneWayPassageMarkerShape);
  const setOneWayPassageMarkerCornerStyle = useMazeStore((s) => s.setVectorByCorridorsOneWayPassageMarkerCornerStyle);
  const setOneWayPassageMarkerFillColor = useMazeStore((s) => s.setVectorByCorridorsOneWayPassageMarkerFillColor);
  const setOneWayPassageMarkerBorderColor = useMazeStore((s) => s.setVectorByCorridorsOneWayPassageMarkerBorderColor);
  const setOneWayPassageMarkerBorderWidth = useMazeStore((s) => s.setVectorByCorridorsOneWayPassageMarkerBorderWidth);
  const setOneWayPassageMarkerGapWidth = useMazeStore((s) => s.setVectorByCorridorsOneWayPassageMarkerGapWidth);
  const setOneWayPassageMarkerSize = useMazeStore((s) => s.setVectorByCorridorsOneWayPassageMarkerSize);
  const setElevatorMarkerShape = useMazeStore((s) => s.setVectorByCorridorsElevatorMarkerShape);
  const setElevatorMarkerCornerStyle = useMazeStore((s) => s.setVectorByCorridorsElevatorMarkerCornerStyle);
  const setElevatorMarkerFillColor = useMazeStore((s) => s.setVectorByCorridorsElevatorMarkerFillColor);
  const setElevatorMarkerBorderColor = useMazeStore((s) => s.setVectorByCorridorsElevatorMarkerBorderColor);
  const setElevatorMarkerBorderWidth = useMazeStore((s) => s.setVectorByCorridorsElevatorMarkerBorderWidth);
  const setElevatorMarkerGapWidth = useMazeStore((s) => s.setVectorByCorridorsElevatorMarkerGapWidth);
  const setElevatorMarkerSize = useMazeStore((s) => s.setVectorByCorridorsElevatorMarkerSize);
  const patchTeleportSettings = useMazeStore((s) => s.patchVectorByCorridorsTeleportSettings);
  const setTeleportGroupOverride = useMazeStore((s) => s.setVectorByCorridorsTeleportGroupOverride);
  const setSelectedTeleportGroupKey = useMazeStore((s) => s.setSelectedTeleportGroupKey);
  const setSplitNodeColor = useMazeStore((s) => s.setVectorByCorridorsSplitNodeColor);
  const setSplitSpecialShapes = useMazeStore((s) => s.setVectorByCorridorsSplitSpecialShapes);
  const setSplitGapWidth = useMazeStore((s) => s.setVectorByCorridorsSplitGapWidth);
  const setSplitDiagonalBowAmount = useMazeStore((s) => s.setVectorByCorridorsSplitDiagonalBowAmount);
  const setSharedCornerStyle = useMazeStore((s) => s.setVectorByCorridorsSharedCornerStyle);
  const setSharedMarkerSize = useMazeStore((s) => s.setVectorByCorridorsSharedMarkerSize);
  const setSharedMarkerBorderWidth = useMazeStore((s) => s.setVectorByCorridorsSharedMarkerBorderWidth);
  const setSharedGapWidth = useMazeStore((s) => s.setVectorByCorridorsSharedGapWidth);
  const resetAllSettings = useMazeStore((s) => s.resetVectorByCorridorsSettings);
  const setLinkEnabled = useMazeStore((s) => s.setVectorByCorridorsLinkEnabled);
  const addLink = useMazeStore((s) => s.addVectorByCorridorsLink);
  const removeLink = useMazeStore((s) => s.removeVectorByCorridorsLink);

  const sectionsExpanded = useMazeStore((s) => s.vectorByCorridorsSectionsExpanded);
  const setSectionExpanded = useMazeStore((s) => s.setVectorByCorridorsSectionExpanded);
  const isExpanded = (id: string) => sectionsExpanded[id] ?? false;
  // Collapsing the Teleports section dangles a click-selection the same way
  // `VectorByWallsSettingsPanel` guards against — see that component's own doc comment on this.
  const toggleSection = (id: string) => {
    if (id === "teleports" && isExpanded(id)) setSelectedTeleportGroupKey(null);
    setSectionExpanded(id, !isExpanded(id));
  };

  // "Priority" project colors (GitHub issue #503) — see `VectorByWallsSettingsPanel`'s own note.
  // Here the corridor stroke (`color`) is what sits on the background; every marker/badge sits on
  // the corridor, itself on the background, so `floor`-analogue is the corridor color.
  const corridor = PC.corridorFill.at(settings.color);
  const bg = PC.bgFill.at(settings.background);

  // Vertical-connection cross-references (GitHub issue #503) — see `VectorByWallsSettingsPanel`'s
  // note. `[fill, border/accent, arrow]` per vertical kind; each vertical color row prioritizes the
  // other two kinds' full triples. Self is dropped from a row's own list by `ColorRow`'s `fieldName`.
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
  // own entry is dropped by `ColorRow`'s `fieldName`.
  const tpBadges = [
    PC.teleportBadgeFill.at(settings.teleportFloorBadge.fillColor),
    PC.teleportBadgeBorder.at(settings.teleportFloorBadge.borderColor),
    PC.teleportBadgeText.at(settings.teleportFloorBadge.textColor),
  ];
  // Every vertical-connection / elevator color row ends with the "Vertical connections" section's
  // own "Shared style" fill/arrow colors (GitHub issue #668 — these feed all three marker groups
  // via disabled-by-default links), then the corridor color, then (for the rows that already
  // carry it) the background (GitHub issue #503).
  const vShared = [PC.verticalFill.at(settings.verticalFillColor), PC.verticalArrow.at(settings.verticalArrowColor)];
  const vTail = [...vShared, corridor];
  const vTailBg = [...vShared, corridor, bg];
  const badgeFillPriority = [PC.elevatorBadgeText.at(settings.elevatorBadges.textColor), ...vElevator, ...vTailBg];
  const badgeTextPriority = [PC.elevatorBadgeFill.at(settings.elevatorBadges.fillColor), ...vElevator, ...vTailBg];

  // `Escape` clears a click-selected teleport group — same global convention
  // `VectorByWallsSettingsPanel` uses (see its own doc comment on this).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedTeleportGroupKey(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setSelectedTeleportGroupKey]);

  const rawNodes = useMazeStore((s) => s.nodes);
  const rawEdges = useMazeStore((s) => s.edges);
  const rawStart = useMazeStore((s) => s.start);
  const rawFinish = useMazeStore((s) => s.finish);
  const postEditMeta = useMazeStore((s) => s.postEditMeta);
  const postEditDraftSplitPoints = useMazeStore((s) => s.postEditDraftSplitPoints);
  const cfg = useMazeStore((s) => s.activeTessellationConfig);
  const floors = useMazeStore((s) => s.floors);

  const rawEffectiveEndpoints = useMemo(
    () => resolveEffectiveEndpoints({ nodes: rawNodes, start: rawStart, finish: rawFinish, postEditMeta, postEditDraftSplitPoints }),
    [rawNodes, rawStart, rawFinish, postEditMeta, postEditDraftSplitPoints],
  );

  // Scoped to `activeFloorId` (GitHub issue #348, parity follow-up to #347) — mirrors
  // `VectorByWallsSettingsPanel`'s own scoping, so this panel's warnings/section-visibility checks
  // see exactly what's drawn.
  const exportWarnings = useMemo(
    () => computeVectorByCorridorsWarningsAcrossFloors(rawNodes, rawEdges, floors, cfg, settings, rawEffectiveEndpoints.start, rawEffectiveEndpoints.finish),
    [rawNodes, rawEdges, floors, cfg, settings, rawEffectiveEndpoints],
  );

  // Splits/One-ways/Teleports sections stay visible whenever their component exists on *any* floor
  // of the project (GitHub issue #484) — checked against `rawNodes`/`rawEdges`, not the floor-scoped
  // `nodes`/`edges` — so switching floors never makes a section appear or disappear. Mirrors
  // `VectorByWallsSettingsPanel`'s own rule.
  const hasOneWays = useMemo(() => {
    const basicEdges = rawEdges.filter((e) => e.kind === "basic");
    const forward = new Set(basicEdges.map((e) => `${e.from}->${e.to}`));
    return basicEdges.some((e) => !forward.has(`${e.to}->${e.from}`));
  }, [rawEdges]);
  const hasTeleports = useMemo(() => rawEdges.some((e) => e.kind === "teleport"), [rawEdges]);
  // The "Floor badges" subsection (GitHub issue #485) only makes sense with a cross-floor teleport
  // to badge — shared helper, same check both export panels run.
  const hasCrossFloorTeleports = useMemo(() => hasCrossFloorTeleport(rawNodes, rawEdges), [rawNodes, rawEdges]);
  // "Vertical connections" splits into three independent panel sections, each hidden when the maze
  // has none of that kind on any floor — same rule as `VectorByWallsSettingsPanel`'s own (GitHub
  // issue #348, parity follow-up to #347's three-section split). Reads `rawEdges` (unscoped by
  // floor), not the floor-scoped `edges` — see that panel's own doc comment on why a bidirectional
  // passage's two directed halves never survive floor-scoping together.
  const { hasTwoWayPassages, hasOneWayPassages, hasElevators } = useMemo(() => {
    const passageEdges = rawEdges.filter((e) => e.kind === "vertical_passage");
    const forward = new Set(passageEdges.map((e) => `${e.from}->${e.to}`));
    const hasOneWayPassages = passageEdges.some((e) => !forward.has(`${e.to}->${e.from}`));
    const hasElevators = rawEdges.some((e) => e.kind === "elevator");
    const hasTwoWayPassages = passageEdges.some((e) => forward.has(`${e.to}->${e.from}`)) ||
      (settings.replaceTwoFloorElevatorsWithStairs && hasElevators);
    return { hasTwoWayPassages, hasOneWayPassages, hasElevators };
  }, [rawEdges, settings.replaceTwoFloorElevatorsWithStairs]);
  const hasVerticalSection = hasTwoWayPassages || hasOneWayPassages || hasElevators;

  // Which registry paths the panel currently shows (GitHub issue #670) — see
  // `VectorByWallsSettingsPanel`'s own doc comment on this.
  const activePaths = useMemo(
    () => computeActivePaths(VECTOR_BY_CORRIDORS_PARAM_REGISTRY, {
      hasOneWays, hasTeleports, hasCrossFloorTeleports, hasTwoWayPassages, hasOneWayPassages, hasElevators,
      hasVerticalSection,
    }, settings),
    [hasOneWays, hasTeleports, hasCrossFloorTeleports, hasTwoWayPassages, hasOneWayPassages, hasElevators, hasVerticalSection, settings],
  );

  // Group customization lists every teleport connection group of the *whole project*, cross-floor
  // pairs included (GitHub issue #484) — see `VectorByWallsSettingsPanel`'s own doc comment on this.
  const { teleportGroups, teleportCollisionKeys } = useTeleportGroupsAndCollisions(
    rawNodes, rawEdges, cfg, floors, settings, rawEffectiveEndpoints.start, rawEffectiveEndpoints.finish,
  );

  // Splits section (GitHub issue #314) — visible whenever a split point exists on any floor (GitHub
  // issue #484), same rule as `VectorByWallsSettingsPanel`'s own Splits section.
  const maxSplit = useMemo(() => maxSplitNodeCount(rawNodes), [rawNodes]);

  return (
    <LinkContextProvider value={{ links: settings.links, registry: VECTOR_BY_CORRIDORS_PARAM_REGISTRY, onSetLinkEnabled: setLinkEnabled, onAddLink: addLink, activePaths } as unknown as LinkContextValue<string>}>
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
          registry={VECTOR_BY_CORRIDORS_PARAM_REGISTRY}
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
          cornerStyle={settings.cornerStyle}
          markerSize={settings.markerSize}
          markerBorderWidth={settings.markerBorderWidth}
          gapWidth={settings.gapWidth}
          onCornerStyleChange={setSharedCornerStyle}
          onMarkerSizeChange={setSharedMarkerSize}
          onMarkerBorderWidthChange={setSharedMarkerBorderWidth}
          onGapWidthChange={setSharedGapWidth}
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
            fieldName={PC.bgFill.name()}
            priorityColors={[PC.bgGrid.at(settings.gridColor), corridor]}
            linkTarget="background"
          />
          <LinkedToggleRow label={m["image_export.vector_by_walls.show_grid"]()} checked={settings.showGrid} onChange={setShowGrid} linkTarget="showGrid" />
          <LinkedColorRow
            label={m["image_export.vector_by_walls.grid_color"]()}
            color={settings.gridColor}
            onChange={setGridColor}
            disabled={!settings.showGrid}
            defaultColor={D.gridColor}
            fieldName={PC.bgGrid.name()}
            priorityColors={[bg, corridor]}
            linkTarget="gridColor"
          />
        </div>
      )}

      <div style={styles.divider} />

      <SectionHeader
        label={m["image_export.vector_by_corridors.section_cells"]()}
        expanded={isExpanded("cells")}
        onToggle={() => toggleSection("cells")}
      />
      {isExpanded("cells") && (
        <div style={styles.block}>
          <LinkedColorRow label={m["image_export.vector_by_corridors.color"]()} color={settings.color} onChange={setColor} defaultColor={D.color} priorityColors={[PC.bgGrid.at(settings.gridColor), bg]} fieldName={PC.corridorFill.name()} linkTarget="color" />
          <LinkedSelectRow
            label={m["image_export.vector_by_corridors.join"]()}
            value={settings.join}
            options={[
              { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
              { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
            ]}
            onChange={setJoin}
            linkTarget="join"
          />
          <SelectRow
            label={m["image_export.vector_by_corridors.render_style"]()}
            value={settings.renderStyle}
            options={[
              { value: "contour", label: m["image_export.vector_by_corridors.render_style_contour"]() },
              { value: "legacy_line", label: m["image_export.vector_by_corridors.render_style_legacy_line"]() },
            ]}
            onChange={setRenderStyle}
            info={() => setRenderStyleInfoOpen(true)}
          />
          <LinkedSliderRow
            label={m["image_export.vector_by_corridors.thickness"]()}
            value={settings.thickness}
            onChange={setThickness}
            min={1}
            max={TILE_SIZE}
            step={1}
            format={(v) => String(v)}
            linkTarget="thickness"
          />
          <LinkedSliderRow
            label={m["image_export.vector_by_corridors.marker_widen_padding"]()}
            value={settings.markerWidenPadding}
            onChange={setMarkerWidenPadding}
            min={0}
            max={20}
            step={1}
            format={(v) => String(v)}
            linkTarget="markerWidenPadding"
          />
          <LinkedSelectRow
            label={m["image_export.vector_by_corridors.marker_widen_shape"]()}
            value={settings.markerWidenShape}
            options={[
              { value: "match_marker", label: m["image_export.vector_by_corridors.marker_widen_shape_match_marker"]() },
              { value: "circle", label: m["image_export.vector_by_corridors.marker_widen_shape_circle"]() },
              { value: "square", label: m["image_export.vector_by_corridors.marker_widen_shape_square"]() },
            ]}
            onChange={setMarkerWidenShape}
            linkTarget={null}
          />
        </div>
      )}

      <div style={styles.divider} />

      <SectionHeader
        label={m["image_export.vector_by_walls.section_markers"]()}
        expanded={isExpanded("waypoints")}
        onToggle={() => toggleSection("waypoints")}
      />
      {isExpanded("waypoints") && (() => {
        const startFill = PC.startFill.at(settings.startMarker.fillColor);
        const startBorder = PC.startBorder.at(settings.startMarker.borderColor);
        const finishFill = PC.finishFill.at(settings.finishMarker.fillColor);
        const finishBorder = PC.finishBorder.at(settings.finishMarker.borderColor);
        return (
        <div style={styles.block}>
          <MarkerSettingsGroup
            title={m["image_export.vector_by_walls.markers_start"]()}
            sectionId="markers_start"
            isExpanded={isExpanded}
            onToggle={toggleSection}
            showTextSection
            settings={settings.startMarker}
            priorityColors={{ fillColor: [startBorder, finishFill, finishBorder, corridor], borderColor: [startFill, finishBorder, finishFill, corridor], textColor: [startFill, startBorder, corridor] }}
            defaultColors={{ fillColor: D.startMarker.fillColor, borderColor: D.startMarker.borderColor, textColor: D.startMarker.textColor }}
            fieldNames={{ fillColor: startFill.name, borderColor: startBorder.name, textColor: PC.startText.name() }}
            onChange={(patch) => {
              if (patch.shape !== undefined) setStartMarkerShape(patch.shape);
              if (patch.text !== undefined) setStartMarkerText(patch.text);
              if (patch.textEnabled !== undefined) setStartMarkerTextEnabled(patch.textEnabled);
              if (patch.textFontWeight !== undefined) setStartMarkerTextFontWeight(patch.textFontWeight);
              if (patch.textSize !== undefined) setStartMarkerTextSize(patch.textSize);
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
              textColor: "startMarker.textColor",
            }}
          />
          <MarkerSettingsGroup
            title={m["image_export.vector_by_walls.markers_finish"]()}
            sectionId="markers_finish"
            isExpanded={isExpanded}
            onToggle={toggleSection}
            showTextSection
            settings={settings.finishMarker}
            priorityColors={{ fillColor: [finishBorder, startFill, startBorder, corridor], borderColor: [finishFill, startBorder, startFill, corridor], textColor: [finishFill, finishBorder, corridor] }}
            defaultColors={{ fillColor: D.finishMarker.fillColor, borderColor: D.finishMarker.borderColor, textColor: D.finishMarker.textColor }}
            fieldNames={{ fillColor: finishFill.name, borderColor: finishBorder.name, textColor: PC.finishText.name() }}
            onChange={(patch) => {
              if (patch.shape !== undefined) setFinishMarkerShape(patch.shape);
              if (patch.text !== undefined) setFinishMarkerText(patch.text);
              if (patch.textEnabled !== undefined) setFinishMarkerTextEnabled(patch.textEnabled);
              if (patch.textFontWeight !== undefined) setFinishMarkerTextFontWeight(patch.textFontWeight);
              if (patch.textSize !== undefined) setFinishMarkerTextSize(patch.textSize);
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
              <LinkedColorRow
                label={m["image_export.vector_by_corridors.one_way_color"]()}
                color={settings.oneWayColor}
                onChange={(color) => patchOneWaySettings({ oneWayColor: color })}
                defaultColor={D.oneWayColor}
                fieldName={PC.oneWaysMarker.name()}
                priorityColors={[bg, corridor]}
                linkTarget="oneWayColor"
              />
              <LinkedSliderRow
                label={m["image_export.vector_by_corridors.one_way_count"]()}
                value={settings.oneWayCount}
                onChange={(v) => patchOneWaySettings({ oneWayCount: v })}
                min={1}
                max={10}
                step={1}
                format={(v) => String(v)}
                linkTarget="oneWayCount"
              />
              <LinkedSliderRow
                label={m["image_export.vector_by_corridors.one_way_thickness"]()}
                value={settings.oneWayThickness}
                onChange={(v) => patchOneWaySettings({ oneWayThickness: v })}
                min={1}
                max={TILE_SIZE / 4}
                step={1}
                format={(v) => String(v)}
                linkTarget="oneWayThickness"
              />
              <LinkedSliderRow
                label={m["image_export.vector_by_corridors.one_way_gap"]()}
                value={settings.oneWayGap}
                onChange={(v) => patchOneWaySettings({ oneWayGap: v })}
                min={0}
                max={TILE_SIZE / 4}
                step={1}
                format={(v) => String(v)}
                linkTarget="oneWayGap"
              />
              <LinkedSliderRow
                label={m["image_export.vector_by_corridors.one_way_width"]()}
                value={settings.oneWayWidth}
                onChange={(v) => patchOneWaySettings({ oneWayWidth: v })}
                min={0.01}
                max={1}
                step={0.01}
                format={(v) => v.toFixed(2)}
                linkTarget="oneWayWidth"
              />
              <LinkedSliderRow
                label={m["image_export.vector_by_corridors.one_way_length"]()}
                value={settings.oneWayLength}
                onChange={(v) => patchOneWaySettings({ oneWayLength: v })}
                min={0.1}
                max={1}
                step={0.1}
                format={(v) => v.toFixed(1)}
                linkTarget="oneWayLength"
              />
              <LinkedSelectRow
                label={m["image_export.vector_by_corridors.one_way_join"]()}
                value={settings.oneWayJoin}
                options={[
                  { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
                  { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
                ]}
                onChange={(join) => patchOneWaySettings({ oneWayJoin: join })}
                linkTarget="oneWayJoin"
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
              teleportGroups={teleportGroups}
              teleportCollisionKeys={teleportCollisionKeys}
              hasCrossFloorTeleports={hasCrossFloorTeleports}
              linkTargets={{
                lineCornerStyle: "teleportLineCornerStyle",
                lineShape: "teleportLineShape",
                lineSize: "teleportLineSize",
                edgeColor: "teleportEdgeColor",
                edgeBorderColor: "teleportEdgeBorderColor",
                edgeBorderWidth: "teleportEdgeBorderWidth",
                edgeGapWidth: "teleportEdgeGapWidth",
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
                floorBadgeSize: null,
                floorBadgeFillColor: "teleportFloorBadge.fillColor",
                floorBadgeBorderColor: "teleportFloorBadge.borderColor",
                floorBadgeTextColor: "teleportFloorBadge.textColor",
                floorBadgeBorderWidth: null,
                floorBadgeTextPadding: null,
                groupCustomization: "teleportGroupCustomization",
              }}
              edgeColorPriority={[PC.teleportEdgeBorder.at(settings.teleportEdgeBorderColor), PC.teleportConnector.at(settings.teleportConnectorColor), ...tpBadges, corridor]}
              edgeBorderColorPriority={[PC.teleportEdge.at(settings.teleportEdgeColor), PC.teleportConnector.at(settings.teleportConnectorColor), ...tpBadges, corridor]}
              connectorColorPriority={[PC.teleportEdge.at(settings.teleportEdgeColor), PC.teleportEdgeBorder.at(settings.teleportEdgeBorderColor), ...tpBadges, corridor]}
              floorBadgeFillColorPriority={[...tpBadges, PC.teleportEdge.at(settings.teleportEdgeColor), PC.teleportEdgeBorder.at(settings.teleportEdgeBorderColor), PC.teleportConnector.at(settings.teleportConnectorColor), corridor]}
              floorBadgeBorderColorPriority={[...tpBadges, PC.teleportEdge.at(settings.teleportEdgeColor), PC.teleportEdgeBorder.at(settings.teleportEdgeBorderColor), PC.teleportConnector.at(settings.teleportConnectorColor), corridor]}
              floorBadgeTextColorPriority={[...tpBadges, PC.teleportEdge.at(settings.teleportEdgeColor), PC.teleportEdgeBorder.at(settings.teleportEdgeBorderColor), PC.teleportConnector.at(settings.teleportConnectorColor), corridor]}
              edgeColorDefault={D.teleportEdgeColor}
              edgeBorderColorDefault={D.teleportEdgeBorderColor}
              connectorColorDefault={D.teleportConnectorColor}
              floorBadgeFillColorDefault={D.teleportFloorBadge.fillColor}
              floorBadgeBorderColorDefault={D.teleportFloorBadge.borderColor}
              floorBadgeTextColorDefault={D.teleportFloorBadge.textColor}
              edgeColorFieldName={PC.teleportEdge.name()}
              edgeBorderColorFieldName={PC.teleportEdgeBorder.name()}
              connectorColorFieldName={PC.teleportConnector.name()}
              floorBadgeFillColorFieldName={PC.teleportBadgeFill.name()}
              floorBadgeBorderColorFieldName={PC.teleportBadgeBorder.name()}
              floorBadgeTextColorFieldName={PC.teleportBadgeText.name()}
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
              <LinkedToggleRow
                label={m["image_export.vector_by_walls.replace_two_floor_elevators_with_stairs"]()}
                checked={settings.replaceTwoFloorElevatorsWithStairs}
                onChange={(replaceTwoFloorElevatorsWithStairs) => patchVerticalSettings({ replaceTwoFloorElevatorsWithStairs })}
                linkTarget="replaceTwoFloorElevatorsWithStairs"
              />

              <div style={styles.subGroupWrap}>
                <SubsectionHeader
                  label={m["image_export.vector_by_walls.vertical_subsection_shared_style"]()}
                  expanded={isExpanded("vertical_shared_style")}
                  onToggle={() => toggleSection("vertical_shared_style")}
                />
                {isExpanded("vertical_shared_style") && (
                <div style={styles.subGroup}>
                  <div style={styles.subGroupWrap}>
                    <div style={styles.subHeader}>{m["image_export.vector_by_walls.vertical_subsection_marker"]()}</div>
                    <div style={styles.subGroup}>
                      <LinkedSelectRow
                        label={m["image_export.vector_by_walls.shared_style_corner_style"]()}
                        value={settings.verticalCornerStyle}
                        options={[
                          { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
                          { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
                        ]}
                        onChange={(verticalCornerStyle) => patchVerticalSharedStyle({ verticalCornerStyle })}
                        linkTarget="verticalCornerStyle"
                      />
                      <LinkedSelectRow
                        label={m["image_export.vector_by_walls.marker_shape"]()}
                        value={settings.verticalShape}
                        options={markerShapeSelectOptions()}
                        onChange={(verticalShape) => patchVerticalSharedStyle({ verticalShape })}
                        linkTarget="verticalShape"
                      />
                      <LinkedSliderRow
                        label={m["image_export.vector_by_walls.vertical_shared_style_size"]()}
                        value={settings.verticalSize}
                        onChange={(verticalSize) => patchVerticalSharedStyle({ verticalSize })}
                        min={0.1 * TILE_SIZE}
                        max={TILE_SIZE}
                        step={1}
                        format={(v) => String(Math.round(v))}
                        linkTarget="verticalSize"
                      />
                      <LinkedSliderRow
                        label={m["image_export.vector_by_walls.vertical_shared_style_border_width"]()}
                        value={settings.verticalBorderWidth}
                        onChange={(verticalBorderWidth) => patchVerticalSharedStyle({ verticalBorderWidth })}
                        min={0}
                        max={10}
                        step={1}
                        format={(v) => String(v)}
                        linkTarget="verticalBorderWidth"
                      />
                      <LinkedSliderRow
                        label={m["image_export.vector_by_walls.shared_style_gap_width"]()}
                        value={settings.verticalGapWidth}
                        onChange={(verticalGapWidth) => patchVerticalSharedStyle({ verticalGapWidth })}
                        min={0}
                        max={10}
                        step={1}
                        format={(v) => String(v)}
                        linkTarget="verticalGapWidth"
                      />
                      <LinkedColorRow
                        label={m["image_export.vector_by_walls.vertical_shared_style_fill_color"]()}
                        color={settings.verticalFillColor}
                        onChange={(verticalFillColor) => patchVerticalSharedStyle({ verticalFillColor })}
                        priorityColors={[PC.verticalArrow.at(settings.verticalArrowColor), corridor]}
                        defaultColor={D.verticalFillColor}
                        fieldName={PC.verticalFill.name()}
                        linkTarget="verticalFillColor"
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
                        priorityColors={[PC.verticalFill.at(settings.verticalFillColor), corridor, bg]}
                        defaultColor={D.verticalArrowColor}
                        fieldName={PC.verticalArrow.name()}
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
                )}
              </div>

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
                          fieldNames={{
                            fillColor: PC.twoWayFill.name(),
                            borderColor: PC.twoWayBorder.name(),
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
                          fieldName={PC.twoWayArrow.name()}
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
                          fieldNames={{
                            fillColor: PC.oneWayFill.name(),
                            borderColor: PC.oneWayBorder.name(),
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
                          fieldName={PC.oneWayArrow.name()}
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

              <div style={styles.subGroupWrap}>
                  <SubsectionHeader label={m["image_export.vector_by_walls.elevator_marker"]()} expanded={isExpanded("vertical_elevator") && hasElevators} disabled={!hasElevators} onToggle={() => toggleSection("vertical_elevator")} />
                  {isExpanded("vertical_elevator") && hasElevators && (
                  <div style={styles.subGroup}>
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
                          fieldNames={{
                            fillColor: PC.elevatorFill.name(),
                            borderColor: PC.elevatorBorder.name(),
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
                          fieldName={PC.elevatorArrow.name()}
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
                            { value: "triangle" as VerticalArrowStyle, label: m["image_export.vector_by_walls.one_way_pattern_triangle"]() },
                            { value: "chevron" as VerticalArrowStyle, label: m["image_export.vector_by_walls.one_way_pattern_chevron"]() },
                            { value: "arrow" as VerticalArrowStyle, label: m["image_export.vector_by_walls.one_way_pattern_arrow"]() },
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
                        fontWeight: "elevatorBadges.fontWeight",
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
                      }}
                      fillColorPriority={badgeFillPriority}
                      textColorPriority={badgeTextPriority}
                      fillColorDefault={D.elevatorBadges.fillColor}
                      textColorDefault={D.elevatorBadges.textColor}
                      fillColorFieldName={PC.elevatorBadgeFill.name()}
                      textColorFieldName={PC.elevatorBadgeText.name()}
                    />
                  </div>
                )}
                </div>
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
                    fieldName={PC.splitNode(i).name()}
                    defaultColor={D.splitNodeColors[i] ?? splitSlotColor(i, canvas.node.splitSlots)}
                    priorityColors={[
                      ...Array.from({ length: maxSplit }, (_, j) => j).filter((j) => j !== i).map((j) =>
                        PC.splitNode(j).at(slotColor(j)),
                      ),
                      corridor,
                      bg,
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
              <LinkedSliderRow
                label={m["image_export.vector_by_corridors.split_gap_width"]()}
                value={settings.splitGapWidth}
                onChange={setSplitGapWidth}
                min={0}
                max={MAX_SPLIT_GAP_WIDTH}
                step={1}
                format={(v) => String(v)}
                disabled={!settings.splitSpecialShapes}
                linkTarget="splitGapWidth"
              />
              <LinkedSliderRow
                label={m["image_export.vector_by_corridors.split_diagonal_bow_amount"]()}
                value={settings.splitDiagonalBowAmount}
                onChange={setSplitDiagonalBowAmount}
                min={0}
                max={1}
                step={0.01}
                format={(v) => v.toFixed(2)}
                disabled={!settings.splitSpecialShapes || settings.join === "miter"}
                linkTarget="splitDiagonalBowAmount"
              />
            </div>
          )}
        </>
      )}

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
            fontWeight: "markerIndex.fontWeight",
            paddingX: "markerIndex.paddingX",
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
          fillColorPriority={[PC.markerIndexText.at(settings.markerIndex.textColor), PC.markerIndexBorder.at(settings.markerIndex.borderColor), corridor, bg]}
          textColorPriority={[PC.markerIndexFill.at(settings.markerIndex.fillColor), PC.markerIndexBorder.at(settings.markerIndex.borderColor), corridor, bg]}
          borderColorPriority={[PC.markerIndexFill.at(settings.markerIndex.fillColor), PC.markerIndexText.at(settings.markerIndex.textColor), corridor]}
          fillColorDefault={D.markerIndex.fillColor}
          textColorDefault={D.markerIndex.textColor}
          borderColorDefault={D.markerIndex.borderColor}
          fillColorFieldName={PC.markerIndexFill.name()}
          textColorFieldName={PC.markerIndexText.name()}
          borderColorFieldName={PC.markerIndexBorder.name()}
        />
      )}

      {renderStyleInfoOpen && (
        <CategoryInfoModal
          title={m["image_export.vector_by_corridors.render_style"]()}
          params={[
            { label: m["image_export.vector_by_corridors.render_style_legacy_line"](), description: m["image_export.vector_by_corridors.render_style_info_line"]() },
            { label: m["image_export.vector_by_corridors.render_style_contour"](), description: m["image_export.vector_by_corridors.render_style_info_contour"]() },
          ]}
          onClose={() => setRenderStyleInfoOpen(false)}
        />
      )}
    </div>
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
