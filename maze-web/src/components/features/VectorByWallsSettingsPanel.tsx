import React, { useEffect, useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { OneWayPattern, VerticalArrowStyle, RandomWallColorMode } from "../../pixi/renderers/types";
import { inset, spacing, typography, ui } from "../../styles/theme";
import { ToggleRow } from "../ToggleRow";
import { SectionHeader, SubsectionHeader } from "../SectionHeader";
import { ColorRow } from "../ColorRow";
import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
import { maxSplitNodeCount, hasCrossFloorTeleport } from "../../pixi/selectors/mazeSelectors";
import { splitSlotColor } from "../../pixi/colorUtils";
import { canvas } from "../../pixi/colorTokens";
import { computeVectorByWallsWarningsAcrossFloors } from "../../pixi/selectors/exportWarnings";
import { resolveEffectiveEndpoints } from "../../pixi/imageExport/VectorByWallsRenderer";
import { ExportWarningsSection } from "./ExportWarningsSection";
import { MarkerSettingsGroup } from "./MarkerSettingsGroup";
import { DecorativeLineStyleGroup } from "./DecorativeLineStyleGroup";
import { ElevatorBadgesSubsection } from "./ElevatorBadgesSubsection";
import { MarkerIndexSection } from "./MarkerIndexSection";
import { TeleportSettingsSection, useTeleportGroupsAndCollisions } from "./TeleportSettingsSection";
import { SharedStyleSection, sharedStyleFieldReset } from "./SharedStyleSection";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS as D } from "../../store/slices/imageExportDefaults";
import { PC } from "../../pixi/selectors/projectColorsSelector";
import * as m from "~/paraglide/messages";

/** "Background", "Tiles", "Markers" and "One-ways" sections of the "Vector by walls" render mode's
 * settings panel (GitHub issue #289 for background, #290/#291 for floor/wall settings — folded
 * into one "Tiles" section since both draw on the maze's cells/tiles, unlike background/grid which
 * draw on the viewport — #296 for start/finish markers — #292 for one-ways — all part of #288's
 * epic). Background covers background color, grid visibility, grid color. Tiles covers the floor's
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
  const setStartMarkerCornerStyle = useMazeStore((s) => s.setVectorByWallsStartMarkerCornerStyle);
  const setStartMarkerFillColor = useMazeStore((s) => s.setVectorByWallsStartMarkerFillColor);
  const setStartMarkerBorderColor = useMazeStore((s) => s.setVectorByWallsStartMarkerBorderColor);
  const setStartMarkerBorderWidth = useMazeStore((s) => s.setVectorByWallsStartMarkerBorderWidth);
  const setStartMarkerGapWidth = useMazeStore((s) => s.setVectorByWallsStartMarkerGapWidth);
  const setStartMarkerSize = useMazeStore((s) => s.setVectorByWallsStartMarkerSize);
  const setFinishMarkerShape = useMazeStore((s) => s.setVectorByWallsFinishMarkerShape);
  const setFinishMarkerCornerStyle = useMazeStore((s) => s.setVectorByWallsFinishMarkerCornerStyle);
  const setFinishMarkerFillColor = useMazeStore((s) => s.setVectorByWallsFinishMarkerFillColor);
  const setFinishMarkerBorderColor = useMazeStore((s) => s.setVectorByWallsFinishMarkerBorderColor);
  const setFinishMarkerBorderWidth = useMazeStore((s) => s.setVectorByWallsFinishMarkerBorderWidth);
  const setFinishMarkerGapWidth = useMazeStore((s) => s.setVectorByWallsFinishMarkerGapWidth);
  const setFinishMarkerSize = useMazeStore((s) => s.setVectorByWallsFinishMarkerSize);
  const patchVerticalSettings = useMazeStore((s) => s.patchVectorByWallsVerticalSettings);
  const patchDecorativeLineStyle = useMazeStore((s) => s.patchVectorByWallsDecorativeLineStyle);
  const patchElevatorBadges = useMazeStore((s) => s.patchVectorByWallsElevatorBadges);
  const patchMarkerIndex = useMazeStore((s) => s.patchVectorByWallsMarkerIndexSettings);
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
  const setSelectedTeleportGroupKey = useMazeStore((s) => s.setSelectedTeleportGroupKey);
  const setSplitNodeColor = useMazeStore((s) => s.setVectorByWallsSplitNodeColor);
  const setSplitSpecialShapes = useMazeStore((s) => s.setVectorByWallsSplitSpecialShapes);
  const setSharedCornerStyle = useMazeStore((s) => s.setVectorByWallsSharedCornerStyle);
  const setSharedMarkerSize = useMazeStore((s) => s.setVectorByWallsSharedMarkerSize);
  const setSharedMarkerBorderWidth = useMazeStore((s) => s.setVectorByWallsSharedMarkerBorderWidth);
  const setSharedGapWidth = useMazeStore((s) => s.setVectorByWallsSharedGapWidth);
  const resetSharedStyleField = useMazeStore((s) => s.resetVectorByWallsSharedStyleField);
  const forceSharedStyle = useMazeStore((s) => s.forceVectorByWallsSharedStyle);
  const resetAllSettings = useMazeStore((s) => s.resetVectorByWallsSettings);

  // `Escape` clears a click-selected teleport group (GitHub issue #293 follow-up) — global, not
  // scoped to a focused row, so it works regardless of what has focus (including the canvas itself,
  // which has no keyboard listener of its own for this).
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

  const hasOneWays = useMemo(() => {
    const basicEdges = rawEdges.filter((e) => e.kind === "basic");
    const forward = new Set(basicEdges.map((e) => `${e.from}->${e.to}`));
    return basicEdges.some((e) => !forward.has(`${e.to}->${e.from}`));
  }, [rawEdges]);
  const hasTeleports = useMemo(() => rawEdges.some((e) => e.kind === "teleport"), [rawEdges]);
  // The "Floor badges" subsection (GitHub issue #485) only makes sense with a cross-floor teleport
  // to badge — shared helper, same check both export panels run.
  const hasCrossFloorTeleports = useMemo(() => hasCrossFloorTeleport(rawNodes, rawEdges), [rawNodes, rawEdges]);
  // "Vertical connections" splits into three independent panel sections (GitHub issue #347
  // three-section follow-up), each hidden when the maze has none of that kind — same "hide when
  // there's nothing to configure anywhere" rule as Splits/One-ways/Teleports above. A
  // `VerticalPassage` edge is one-way when its reverse pair isn't also present, mirroring
  // `hasOneWays`' own forward/reverse-pair check for `"basic"` edges. Reads `rawEdges` (unscoped by
  // floor) — a bidirectional passage's two directed halves (a->b, b->a) live on *different* floors
  // by construction, so `selectFloorScopedMaze` (which keeps an edge only when its own `from` is on
  // the active floor) never lets both halves of the same pair survive together for any single
  // floor, making the reverse-pair check below always fail against floor-scoped data.
  const { hasTwoWayPassages, hasOneWayPassages, hasElevators } = useMemo(() => {
    const passageEdges = rawEdges.filter((e) => e.kind === "vertical_passage");
    const forward = new Set(passageEdges.map((e) => `${e.from}->${e.to}`));
    const hasOneWayPassages = passageEdges.some((e) => !forward.has(`${e.to}->${e.from}`));
    const hasElevators = rawEdges.some((e) => e.kind === "elevator");
    const hasTwoWayPassages = passageEdges.some((e) => forward.has(`${e.to}->${e.from}`)) ||
      (settings.replaceTwoFloorElevatorsWithStairs && hasElevators);
    return { hasTwoWayPassages, hasOneWayPassages, hasElevators };
  }, [rawEdges, settings.replaceTwoFloorElevatorsWithStairs]);

  const sectionsExpanded = useMazeStore((s) => s.vectorByWallsSectionsExpanded);
  const setSectionExpanded = useMazeStore((s) => s.setVectorByWallsSectionExpanded);
  const isExpanded = (id: string) => sectionsExpanded[id] ?? false;
  // Collapsing the Teleports section stops rendering the group list (and switches the canvas back
  // to non-interactive), so a selection made while it was open would otherwise dangle: nothing on
  // screen shows it's still set, but it'd still hide every other group on the canvas and pop back
  // into view already-selected the next time the section reopens. Cleared synchronously in the
  // toggle handler itself, not via a `useEffect` watching the expanded flag — an effect fires after
  // the closed render has already committed, one frame late; a plain click here fires before any of
  // that, same as toggling group customization off below.
  const toggleSection = (id: string) => {
    if (id === "teleports" && isExpanded(id)) setSelectedTeleportGroupKey(null);
    setSectionExpanded(id, !isExpanded(id));
  };

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
  // order. Self is dropped from a row's own list by `ColorRow`'s `fieldName` match.
  const vTwoWay = [
    PC.twoWayFill.at(settings.twoWayPassageMarker.fillColor),
    PC.twoWayBorder.at(settings.twoWayPassageMarker.borderColor),
    PC.twoWayArrow.at(settings.twoWayArrowColor),
  ];
  const vOneWay = [
    PC.oneWayFill.at(settings.oneWayPassageMarker.fillColor),
    PC.oneWayAccent.at(settings.oneWayAccentColor),
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
  // Every vertical-connection / elevator color row ends with the floor color (the corridor-color
  // analogue this mode has), then (for the rows that already carry it) the background — GitHub
  // issue #503.
  const vTail = [floor];
  const vTailBg = [floor, background];
  // Elevator floor-badge fill / text prioritize each other first (they sit one on the other), then
  // every elevator color, then the floor and the background.
  const badgeFillPriority = [PC.elevatorBadgeText.at(settings.elevatorBadges.textColor), ...vElevator, ...vTailBg];
  const badgeTextPriority = [PC.elevatorBadgeFill.at(settings.elevatorBadges.fillColor), ...vElevator, ...vTailBg];

  return (
    <div style={styles.root}>
      <ExportWarningsSection
        warnings={exportWarnings}
        expanded={isExpanded("warnings")}
        onToggle={() => toggleSection("warnings")}
        showColorWarnings={showColorWarnings}
        onShowColorWarningsChange={setShowColorWarnings}
      />

      <SectionHeader
        label={m["image_export.vector_by_walls.section_shared_style"]()}
        expanded={isExpanded("shared_style")}
        onToggle={() => toggleSection("shared_style")}
      />
      {isExpanded("shared_style") && (
        <SharedStyleSection
          cornerStyle={settings.sharedStyle.cornerStyle}
          markerSize={settings.sharedStyle.markerSize}
          markerBorderWidth={settings.sharedStyle.markerBorderWidth}
          gapWidth={settings.sharedStyle.gapWidth}
          onCornerStyleChange={setSharedCornerStyle}
          onMarkerSizeChange={setSharedMarkerSize}
          onMarkerBorderWidthChange={setSharedMarkerBorderWidth}
          onGapWidthChange={setSharedGapWidth}
          onForce={forceSharedStyle}
          onResetAll={resetAllSettings}
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
          <ColorRow
            label={m["image_export.vector_by_walls.background_color"]()}
            color={settings.background}
            onChange={setBackground}
            defaultColor={D.background}
            fieldName={PC.bgFill.name()}
            priorityColors={[PC.bgGrid.at(settings.gridColor), floor, wall]}
          />
          <ToggleRow label={m["image_export.vector_by_walls.show_grid"]()} checked={settings.showGrid} onChange={setShowGrid} />
          <ColorRow
            label={m["image_export.vector_by_walls.grid_color"]()}
            color={settings.gridColor}
            onChange={setGridColor}
            disabled={!settings.showGrid}
            defaultColor={D.gridColor}
            fieldName={PC.bgGrid.name()}
            priorityColors={[background, wall]}
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
          <ColorRow
            label={m["image_export.vector_by_walls.floor_color"]()}
            color={settings.floorColor}
            onChange={setFloorColor}
            defaultColor={D.floorColor}
            fieldName={PC.tilesFloor.name()}
            priorityColors={[wall]}
          />
          <ToggleRow
            label={m["image_export.vector_by_walls.random_wall_colors"]()}
            checked={settings.randomWallColorMode !== "off"}
            onChange={(enabled) => setRandomWallColorMode(enabled ? "per_pass" : "off")}
          />
          {settings.randomWallColorMode === "off" ? (
            <ColorRow
              label={m["image_export.vector_by_walls.wall_color"]()}
              color={settings.wallColor}
              onChange={setWallColor}
              defaultColor={D.wallColor}
              fieldName={PC.tilesWall.name()}
              priorityColors={[floor, background]}
            />
          ) : (
            <SelectRow
              label={m["image_export.vector_by_walls.random_wall_color_mode"]()}
              value={settings.randomWallColorMode}
              options={[
                { value: "per_pass" as RandomWallColorMode, label: m["image_export.vector_by_walls.random_wall_colors_per_segment"]() },
                { value: "per_segment" as RandomWallColorMode, label: m["image_export.vector_by_walls.random_wall_colors_per_pass"]() },
              ]}
              onChange={setRandomWallColorMode}
            />
          )}
          <SelectRow
            label={m["image_export.vector_by_walls.wall_join"]()}
            value={settings.wallJoin}
            options={[
              { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
              { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
            ]}
            onChange={setWallJoin}
            resetButton={sharedStyleFieldReset(settings.sharedStyle.overrides, "cornerStyle", "wallJoin", () => resetSharedStyleField("cornerStyle", "wallJoin"))}
          />
          <SliderRow
            label={m["image_export.vector_by_walls.wall_thickness"]()}
            value={settings.wallThickness}
            onChange={setWallThickness}
            min={1}
            max={20}
            step={1}
            format={(v) => String(v)}
          />
        </div>
      )}

      <div style={styles.divider} />

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
        return (
        <div style={styles.block}>
          <MarkerSettingsGroup
            title={m["image_export.vector_by_walls.markers_start"]()}
            settings={settings.startMarker}
            priorityColors={{ fillColor: [startBorder, finishFill, finishBorder, floor], borderColor: [startFill, finishBorder, finishFill, floor] }}
            defaultColors={{ fillColor: D.startMarker.fillColor, borderColor: D.startMarker.borderColor }}
            fieldNames={{ fillColor: startFill.name, borderColor: startBorder.name }}
            onChange={(patch) => {
              if (patch.shape !== undefined) setStartMarkerShape(patch.shape);
              if (patch.cornerStyle !== undefined) setStartMarkerCornerStyle(patch.cornerStyle);
              if (patch.fillColor !== undefined) setStartMarkerFillColor(patch.fillColor);
              if (patch.borderColor !== undefined) setStartMarkerBorderColor(patch.borderColor);
              if (patch.borderWidth !== undefined) setStartMarkerBorderWidth(patch.borderWidth);
              if (patch.gapWidth !== undefined) setStartMarkerGapWidth(patch.gapWidth);
              if (patch.size !== undefined) setStartMarkerSize(patch.size);
            }}
            resetButtons={{
              cornerStyle: sharedStyleFieldReset(settings.sharedStyle.overrides, "cornerStyle", "startMarker", () => resetSharedStyleField("cornerStyle", "startMarker")),
              size: sharedStyleFieldReset(settings.sharedStyle.overrides, "markerSize", "startMarker", () => resetSharedStyleField("markerSize", "startMarker")),
              borderWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "markerBorderWidth", "startMarker", () => resetSharedStyleField("markerBorderWidth", "startMarker")),
              gapWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "gapWidth", "startMarker", () => resetSharedStyleField("gapWidth", "startMarker")),
            }}
          />
          <MarkerSettingsGroup
            title={m["image_export.vector_by_walls.markers_finish"]()}
            settings={settings.finishMarker}
            priorityColors={{ fillColor: [finishBorder, startFill, startBorder, floor], borderColor: [finishFill, startBorder, startFill, floor] }}
            defaultColors={{ fillColor: D.finishMarker.fillColor, borderColor: D.finishMarker.borderColor }}
            fieldNames={{ fillColor: finishFill.name, borderColor: finishBorder.name }}
            onChange={(patch) => {
              if (patch.shape !== undefined) setFinishMarkerShape(patch.shape);
              if (patch.cornerStyle !== undefined) setFinishMarkerCornerStyle(patch.cornerStyle);
              if (patch.fillColor !== undefined) setFinishMarkerFillColor(patch.fillColor);
              if (patch.borderColor !== undefined) setFinishMarkerBorderColor(patch.borderColor);
              if (patch.borderWidth !== undefined) setFinishMarkerBorderWidth(patch.borderWidth);
              if (patch.gapWidth !== undefined) setFinishMarkerGapWidth(patch.gapWidth);
              if (patch.size !== undefined) setFinishMarkerSize(patch.size);
            }}
            resetButtons={{
              cornerStyle: sharedStyleFieldReset(settings.sharedStyle.overrides, "cornerStyle", "finishMarker", () => resetSharedStyleField("cornerStyle", "finishMarker")),
              size: sharedStyleFieldReset(settings.sharedStyle.overrides, "markerSize", "finishMarker", () => resetSharedStyleField("markerSize", "finishMarker")),
              borderWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "markerBorderWidth", "finishMarker", () => resetSharedStyleField("markerBorderWidth", "finishMarker")),
              gapWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "gapWidth", "finishMarker", () => resetSharedStyleField("gapWidth", "finishMarker")),
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
              <SelectRow
                label={m["image_export.vector_by_walls.one_way_pattern"]()}
                value={settings.oneWayPattern}
                options={[
                  { value: "triangle" as OneWayPattern, label: m["image_export.vector_by_walls.one_way_pattern_triangle"]() },
                  { value: "chevron" as OneWayPattern, label: m["image_export.vector_by_walls.one_way_pattern_chevron"]() },
                  { value: "arrow" as OneWayPattern, label: m["image_export.vector_by_walls.one_way_pattern_arrow"]() },
                ]}
                onChange={setOneWayPattern}
              />
              <ColorRow
                label={m["image_export.vector_by_walls.one_way_color"]()}
                color={settings.oneWayColor}
                onChange={setOneWayColor}
                defaultColor={D.oneWayColor}
                fieldName={PC.oneWaysMarker.name()}
                priorityColors={[floor, wall]}
              />
              <SliderRow
                label={m["image_export.vector_by_walls.one_way_gap_width"]()}
                value={settings.oneWayGapWidth}
                onChange={setOneWayGapWidth}
                min={0}
                max={10}
                step={1}
                format={(v) => String(v)}
              />
              <SelectRow
                label={m["image_export.vector_by_walls.one_way_join"]()}
                value={settings.oneWayJoin}
                options={[
                  { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
                  { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
                ]}
                onChange={setOneWayJoin}
                resetButton={sharedStyleFieldReset(settings.sharedStyle.overrides, "cornerStyle", "oneWayJoin", () => resetSharedStyleField("cornerStyle", "oneWayJoin"))}
              />
              <SliderRow
                label={m["image_export.vector_by_walls.one_way_size"]()}
                value={settings.oneWaySize}
                onChange={setOneWaySize}
                min={0.05}
                max={0.5}
                step={0.01}
                format={(v) => v.toFixed(2)}
              />
              <SliderRow
                label={m["image_export.vector_by_walls.one_way_thickness"]()}
                value={settings.oneWayThickness}
                onChange={setOneWayThickness}
                min={1}
                max={10}
                step={1}
                format={(v) => String(v)}
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
              resetButtons={{
                lineCornerStyle: sharedStyleFieldReset(settings.sharedStyle.overrides, "cornerStyle", "teleportLine", () => resetSharedStyleField("cornerStyle", "teleportLine")),
                lineSize: sharedStyleFieldReset(settings.sharedStyle.overrides, "markerSize", "teleportLine", () => resetSharedStyleField("markerSize", "teleportLine")),
                edgeBorderWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "markerBorderWidth", "teleportEdge", () => resetSharedStyleField("markerBorderWidth", "teleportEdge")),
                edgeGapWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "gapWidth", "teleportEdge", () => resetSharedStyleField("gapWidth", "teleportEdge")),
                connectorGapWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "gapWidth", "teleportConnector", () => resetSharedStyleField("gapWidth", "teleportConnector")),
              }}
              edgeColorPriority={[PC.teleportEdgeBorder.at(settings.teleportEdgeBorderColor), PC.teleportConnector.at(settings.teleportConnectorColor), ...tpBadges, floor]}
              edgeBorderColorPriority={[PC.teleportEdge.at(settings.teleportEdgeColor), PC.teleportConnector.at(settings.teleportConnectorColor), ...tpBadges, floor]}
              connectorColorPriority={[PC.teleportEdge.at(settings.teleportEdgeColor), PC.teleportEdgeBorder.at(settings.teleportEdgeBorderColor), ...tpBadges, floor]}
              floorBadgeFillColorPriority={[...tpBadges, PC.teleportEdge.at(settings.teleportEdgeColor), PC.teleportEdgeBorder.at(settings.teleportEdgeBorderColor), PC.teleportConnector.at(settings.teleportConnectorColor), floor]}
              floorBadgeBorderColorPriority={[...tpBadges, PC.teleportEdge.at(settings.teleportEdgeColor), PC.teleportEdgeBorder.at(settings.teleportEdgeBorderColor), PC.teleportConnector.at(settings.teleportConnectorColor), floor]}
              floorBadgeTextColorPriority={[...tpBadges, PC.teleportEdge.at(settings.teleportEdgeColor), PC.teleportEdgeBorder.at(settings.teleportEdgeBorderColor), PC.teleportConnector.at(settings.teleportConnectorColor), floor]}
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

      {(hasTwoWayPassages || hasOneWayPassages || hasElevators || floors.length > 1) && (
        <>
          <div style={styles.divider} />

          <SectionHeader
            label={m["image_export.vector_by_walls.section_vertical"]()}
            expanded={isExpanded("vertical")}
            onToggle={() => toggleSection("vertical")}
          />
          {isExpanded("vertical") && (
            <div style={styles.block}>
              <SelectRow
                label={m["image_export.vector_by_walls.vertical_style"]()}
                value={settings.verticalStyle}
                options={[
                  { value: "abstract", label: m["image_export.vector_by_walls.vertical_style_abstract"]() },
                  { value: "decorative", label: m["image_export.vector_by_walls.vertical_style_decorative"]() },
                ]}
                onChange={(verticalStyle) => patchVerticalSettings({ verticalStyle })}
              />
              <ToggleRow
                label={m["image_export.vector_by_walls.replace_two_floor_elevators_with_stairs"]()}
                checked={settings.replaceTwoFloorElevatorsWithStairs}
                onChange={(replaceTwoFloorElevatorsWithStairs) => patchVerticalSettings({ replaceTwoFloorElevatorsWithStairs })}
              />

              {settings.verticalStyle === "decorative" && (
                <div style={styles.subGroupWrap}>
                  <SubsectionHeader label={m["image_export.vector_by_walls.two_way_passage_marker"]()} expanded={isExpanded("vertical_two_way") && hasTwoWayPassages} disabled={!hasTwoWayPassages} onToggle={() => toggleSection("vertical_two_way")} />
                  {isExpanded("vertical_two_way") && hasTwoWayPassages && (
                  <div style={styles.subGroup}>
                    <DecorativeLineStyleGroup
                      settings={settings.decorativeStairsTwoWay}
                      onChange={(patch) => patchDecorativeLineStyle("decorativeStairsTwoWay", patch)}
                      lineColorPriority={onFloor}
                      lineColorDefault={D.decorativeStairsTwoWay.lineColor}
                      lineColorFieldName={PC.decorLineTwoWay.name()}
                    />
                    <div style={styles.subGroupWrap}>
                      <div style={styles.subHeader}>{m["image_export.vector_by_walls.vertical_subsection_arrows"]()}</div>
                      <div style={styles.subGroup}>
                        <ColorRow
                          label={m["image_export.vector_by_walls.vertical_arrow_color"]()}
                          color={settings.decorativeStairsArrowColor}
                          onChange={(decorativeStairsArrowColor) => patchVerticalSettings({ decorativeStairsArrowColor })}
                          priorityColors={[PC.decorLineTwoWay.at(settings.decorativeStairsTwoWay.lineColor), floor]}
                          defaultColor={D.decorativeStairsArrowColor}
                          fieldName={PC.decorArrowTwoWay.name()}
                        />
                        <SliderRow
                          label={m["image_export.vector_by_walls.vertical_arrow_size"]()}
                          value={settings.decorativeStairsArrowSize}
                          onChange={(decorativeStairsArrowSize) => patchVerticalSettings({ decorativeStairsArrowSize })}
                          min={0.2}
                          max={1}
                          step={0.05}
                          format={(v) => v.toFixed(2)}
                        />
                      </div>
                    </div>
                  </div>
                  )}
                </div>
              )}

              {settings.verticalStyle === "decorative" && (
                <div style={styles.subGroupWrap}>
                  <SubsectionHeader label={m["image_export.vector_by_walls.one_way_passage_marker"]()} expanded={isExpanded("vertical_one_way") && hasOneWayPassages} disabled={!hasOneWayPassages} onToggle={() => toggleSection("vertical_one_way")} />
                  {isExpanded("vertical_one_way") && hasOneWayPassages && (
                  <div style={styles.subGroup}>
                    <DecorativeLineStyleGroup
                      settings={settings.decorativeStairsOneWay}
                      onChange={(patch) => patchDecorativeLineStyle("decorativeStairsOneWay", patch)}
                      lineColorPriority={onFloor}
                      lineColorDefault={D.decorativeStairsOneWay.lineColor}
                      lineColorFieldName={PC.decorLineOneWay.name()}
                    />
                    <ColorRow
                      label={m["image_export.vector_by_walls.one_way_accent_color"]()}
                      color={settings.decorativeStairsAccentColor}
                      onChange={(decorativeStairsAccentColor) => patchVerticalSettings({ decorativeStairsAccentColor })}
                      priorityColors={[PC.decorLineOneWay.at(settings.decorativeStairsOneWay.lineColor), floor]}
                      defaultColor={D.decorativeStairsAccentColor}
                      fieldName={PC.oneWayAccent.name()}
                    />
                  </div>
                  )}
                </div>
              )}

              {settings.verticalStyle === "decorative" && (
                <div style={styles.subGroupWrap}>
                  <SubsectionHeader label={m["image_export.vector_by_walls.elevator_marker"]()} expanded={isExpanded("vertical_elevator") && hasElevators} disabled={!hasElevators} onToggle={() => toggleSection("vertical_elevator")} />
                  {isExpanded("vertical_elevator") && hasElevators && (
                  <div style={styles.subGroup}>
                    <DecorativeLineStyleGroup
                      settings={settings.decorativeElevator}
                      onChange={(patch) => patchDecorativeLineStyle("decorativeElevator", patch)}
                      lineColorPriority={onFloor}
                      lineColorDefault={D.decorativeElevator.lineColor}
                      lineColorFieldName={PC.decorLineElevator.name()}
                    />
                    <ElevatorBadgesSubsection
                      settings={settings.elevatorBadges}
                      sharedStyleOverrides={settings.sharedStyle.overrides}
                      onChange={patchElevatorBadges}
                      onCornerStyleChange={setElevatorBadgesCornerStyle}
                      onResetCornerStyle={() => resetSharedStyleField("cornerStyle", "elevatorBadges")}
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
              )}

              {settings.verticalStyle === "abstract" && (
                <div style={styles.subGroupWrap}>
                  <SubsectionHeader label={m["image_export.vector_by_walls.two_way_passage_marker"]()} expanded={isExpanded("vertical_two_way") && hasTwoWayPassages} disabled={!hasTwoWayPassages} onToggle={() => toggleSection("vertical_two_way")} />
                  {isExpanded("vertical_two_way") && hasTwoWayPassages && (
                  <div style={styles.subGroup}>
                    <div style={styles.subGroupWrap}>
                      <div style={styles.subHeader}>{m["image_export.vector_by_walls.vertical_subsection_marker"]()}</div>
                      <div style={styles.subGroup}>
                        <MarkerSettingsGroup
                          title=""
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
                          resetButtons={{
                            cornerStyle: sharedStyleFieldReset(settings.sharedStyle.overrides, "cornerStyle", "twoWayPassage", () => resetSharedStyleField("cornerStyle", "twoWayPassage")),
                            size: sharedStyleFieldReset(settings.sharedStyle.overrides, "markerSize", "twoWayPassage", () => resetSharedStyleField("markerSize", "twoWayPassage")),
                            borderWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "markerBorderWidth", "twoWayPassage", () => resetSharedStyleField("markerBorderWidth", "twoWayPassage")),
                            gapWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "gapWidth", "twoWayPassage", () => resetSharedStyleField("gapWidth", "twoWayPassage")),
                          }}
                        />
                      </div>
                    </div>

                    <div style={styles.subGroupWrap}>
                      <div style={styles.subHeader}>{m["image_export.vector_by_walls.vertical_subsection_arrows"]()}</div>
                      <div style={styles.subGroup}>
                        <ColorRow
                          label={m["image_export.vector_by_walls.vertical_arrow_color"]()}
                          color={settings.twoWayArrowColor}
                          onChange={(twoWayArrowColor) => patchVerticalSettings({ twoWayArrowColor })}
                          priorityColors={[PC.twoWayFill.at(settings.twoWayPassageMarker.fillColor), PC.twoWayBorder.at(settings.twoWayPassageMarker.borderColor), ...vOneWay, ...vElevator, ...vTailBg]}
                          defaultColor={D.twoWayArrowColor}
                          fieldName={PC.twoWayArrow.name()}
                        />
                        <SliderRow
                          label={m["image_export.vector_by_walls.vertical_arrow_size"]()}
                          value={settings.twoWayArrowSize}
                          onChange={(twoWayArrowSize) => patchVerticalSettings({ twoWayArrowSize })}
                          min={0.2}
                          max={1}
                          step={0.05}
                          format={(v) => v.toFixed(2)}
                        />
                        <SelectRow
                          label={m["image_export.vector_by_walls.vertical_arrow_style"]()}
                          value={settings.twoWayArrowStyle}
                          options={[
                            { value: "triangle" as VerticalArrowStyle, label: m["image_export.vector_by_walls.one_way_pattern_triangle"]() },
                            { value: "chevron" as VerticalArrowStyle, label: m["image_export.vector_by_walls.one_way_pattern_chevron"]() },
                            { value: "arrow" as VerticalArrowStyle, label: m["image_export.vector_by_walls.one_way_pattern_arrow"]() },
                            { value: "sign" as VerticalArrowStyle, label: m["image_export.vector_by_walls.vertical_arrow_style_sign"]() },
                          ]}
                          onChange={(twoWayArrowStyle) => patchVerticalSettings({ twoWayArrowStyle })}
                        />
                        <SelectRow
                          label={m["image_export.vector_by_walls.vertical_arrow_corner_style"]()}
                          value={settings.twoWayArrowCornerStyle}
                          options={[
                            { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
                            { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
                          ]}
                          onChange={(twoWayArrowCornerStyle) => patchVerticalSettings({ twoWayArrowCornerStyle })}
                        />
                      </div>
                    </div>
                  </div>
                  )}
                </div>
              )}

              {settings.verticalStyle === "abstract" && (
                <div style={styles.subGroupWrap}>
                  <SubsectionHeader label={m["image_export.vector_by_walls.one_way_passage_marker"]()} expanded={isExpanded("vertical_one_way") && hasOneWayPassages} disabled={!hasOneWayPassages} onToggle={() => toggleSection("vertical_one_way")} />
                  {isExpanded("vertical_one_way") && hasOneWayPassages && (
                  <div style={styles.subGroup}>
                    <div style={styles.subGroupWrap}>
                      <div style={styles.subHeader}>{m["image_export.vector_by_walls.vertical_subsection_marker"]()}</div>
                      <div style={styles.subGroup}>
                        <ColorRow
                          label={m["image_export.vector_by_walls.one_way_accent_color"]()}
                          color={settings.oneWayAccentColor}
                          onChange={(oneWayAccentColor) => patchVerticalSettings({ oneWayAccentColor })}
                          priorityColors={[PC.oneWayFill.at(settings.oneWayPassageMarker.fillColor), PC.oneWayArrow.at(settings.oneWayArrowColor), ...vTwoWay, ...vElevator, ...vTail]}
                          defaultColor={D.oneWayAccentColor}
                          fieldName={PC.oneWayAccent.name()}
                        />
                        <MarkerSettingsGroup
                          title=""
                          settings={settings.oneWayPassageMarker}
                          hideBorderColor
                          priorityColors={{ fillColor: [PC.oneWayAccent.at(settings.oneWayAccentColor), PC.oneWayArrow.at(settings.oneWayArrowColor), ...vTwoWay, ...vElevator, ...vTail] }}
                          defaultColors={{ fillColor: D.oneWayPassageMarker.fillColor }}
                          fieldNames={{ fillColor: PC.oneWayFill.name() }}
                          onChange={(patch) => {
                            if (patch.shape !== undefined) setOneWayPassageMarkerShape(patch.shape);
                            if (patch.cornerStyle !== undefined) setOneWayPassageMarkerCornerStyle(patch.cornerStyle);
                            if (patch.fillColor !== undefined) setOneWayPassageMarkerFillColor(patch.fillColor);
                            if (patch.borderColor !== undefined) setOneWayPassageMarkerBorderColor(patch.borderColor);
                            if (patch.borderWidth !== undefined) setOneWayPassageMarkerBorderWidth(patch.borderWidth);
                            if (patch.gapWidth !== undefined) setOneWayPassageMarkerGapWidth(patch.gapWidth);
                            if (patch.size !== undefined) setOneWayPassageMarkerSize(patch.size);
                          }}
                          resetButtons={{
                            cornerStyle: sharedStyleFieldReset(settings.sharedStyle.overrides, "cornerStyle", "oneWayPassage", () => resetSharedStyleField("cornerStyle", "oneWayPassage")),
                            size: sharedStyleFieldReset(settings.sharedStyle.overrides, "markerSize", "oneWayPassage", () => resetSharedStyleField("markerSize", "oneWayPassage")),
                            borderWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "markerBorderWidth", "oneWayPassage", () => resetSharedStyleField("markerBorderWidth", "oneWayPassage")),
                            gapWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "gapWidth", "oneWayPassage", () => resetSharedStyleField("gapWidth", "oneWayPassage")),
                          }}
                        />
                      </div>
                    </div>

                    <div style={styles.subGroupWrap}>
                      <div style={styles.subHeader}>{m["image_export.vector_by_walls.vertical_subsection_arrows"]()}</div>
                      <div style={styles.subGroup}>
                        <ColorRow
                          label={m["image_export.vector_by_walls.vertical_arrow_color"]()}
                          color={settings.oneWayArrowColor}
                          onChange={(oneWayArrowColor) => patchVerticalSettings({ oneWayArrowColor })}
                          priorityColors={[PC.oneWayFill.at(settings.oneWayPassageMarker.fillColor), PC.oneWayAccent.at(settings.oneWayAccentColor), ...vTwoWay, ...vElevator, ...vTailBg]}
                          defaultColor={D.oneWayArrowColor}
                          fieldName={PC.oneWayArrow.name()}
                        />
                        <SliderRow
                          label={m["image_export.vector_by_walls.vertical_arrow_size"]()}
                          value={settings.oneWayArrowSize}
                          onChange={(oneWayArrowSize) => patchVerticalSettings({ oneWayArrowSize })}
                          min={0.2}
                          max={1}
                          step={0.05}
                          format={(v) => v.toFixed(2)}
                        />
                        <SelectRow
                          label={m["image_export.vector_by_walls.vertical_arrow_style"]()}
                          value={settings.oneWayArrowStyle}
                          options={[
                            { value: "triangle" as VerticalArrowStyle, label: m["image_export.vector_by_walls.one_way_pattern_triangle"]() },
                            { value: "chevron" as VerticalArrowStyle, label: m["image_export.vector_by_walls.one_way_pattern_chevron"]() },
                            { value: "arrow" as VerticalArrowStyle, label: m["image_export.vector_by_walls.one_way_pattern_arrow"]() },
                            { value: "sign" as VerticalArrowStyle, label: m["image_export.vector_by_walls.vertical_arrow_style_sign"]() },
                          ]}
                          onChange={(oneWayArrowStyle) => patchVerticalSettings({ oneWayArrowStyle })}
                        />
                        <SelectRow
                          label={m["image_export.vector_by_walls.vertical_arrow_corner_style"]()}
                          value={settings.oneWayArrowCornerStyle}
                          options={[
                            { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
                            { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
                          ]}
                          onChange={(oneWayArrowCornerStyle) => patchVerticalSettings({ oneWayArrowCornerStyle })}
                        />
                      </div>
                    </div>
                  </div>
                  )}
                </div>
              )}

              {settings.verticalStyle === "abstract" && (
                <div style={styles.subGroupWrap}>
                  <SubsectionHeader label={m["image_export.vector_by_walls.elevator_marker"]()} expanded={isExpanded("vertical_elevator") && hasElevators} disabled={!hasElevators} onToggle={() => toggleSection("vertical_elevator")} />
                  {isExpanded("vertical_elevator") && hasElevators && (
                  <div style={styles.subGroup}>
                    <div style={styles.subGroupWrap}>
                      <div style={styles.subHeader}>{m["image_export.vector_by_walls.vertical_subsection_marker"]()}</div>
                      <div style={styles.subGroup}>
                        <MarkerSettingsGroup
                          title=""
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
                          resetButtons={{
                            cornerStyle: sharedStyleFieldReset(settings.sharedStyle.overrides, "cornerStyle", "elevator", () => resetSharedStyleField("cornerStyle", "elevator")),
                            size: sharedStyleFieldReset(settings.sharedStyle.overrides, "markerSize", "elevator", () => resetSharedStyleField("markerSize", "elevator")),
                            borderWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "markerBorderWidth", "elevator", () => resetSharedStyleField("markerBorderWidth", "elevator")),
                            gapWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "gapWidth", "elevator", () => resetSharedStyleField("gapWidth", "elevator")),
                          }}
                        />
                      </div>
                    </div>

                    <div style={styles.subGroupWrap}>
                      <div style={styles.subHeader}>{m["image_export.vector_by_walls.vertical_subsection_arrows"]()}</div>
                      <div style={styles.subGroup}>
                        <ColorRow
                          label={m["image_export.vector_by_walls.vertical_arrow_color"]()}
                          color={settings.elevatorArrowColor}
                          onChange={(elevatorArrowColor) => patchVerticalSettings({ elevatorArrowColor })}
                          priorityColors={[PC.elevatorFill.at(settings.elevatorMarker.fillColor), PC.elevatorBorder.at(settings.elevatorMarker.borderColor), ...badges, ...vTwoWay, ...vOneWay, ...vTailBg]}
                          defaultColor={D.elevatorArrowColor}
                          fieldName={PC.elevatorArrow.name()}
                        />
                        <SliderRow
                          label={m["image_export.vector_by_walls.vertical_arrow_size"]()}
                          value={settings.elevatorArrowSize}
                          onChange={(elevatorArrowSize) => patchVerticalSettings({ elevatorArrowSize })}
                          min={0.2}
                          max={1}
                          step={0.05}
                          format={(v) => v.toFixed(2)}
                        />
                        <SelectRow
                          label={m["image_export.vector_by_walls.vertical_arrow_style"]()}
                          value={settings.elevatorArrowStyle}
                          options={[
                            { value: "triangle" as OneWayPattern, label: m["image_export.vector_by_walls.one_way_pattern_triangle"]() },
                            { value: "chevron" as OneWayPattern, label: m["image_export.vector_by_walls.one_way_pattern_chevron"]() },
                            { value: "arrow" as OneWayPattern, label: m["image_export.vector_by_walls.one_way_pattern_arrow"]() },
                            { value: "sign" as VerticalArrowStyle, label: m["image_export.vector_by_walls.vertical_arrow_style_sign"]() },
                          ]}
                          onChange={(elevatorArrowStyle) => patchVerticalSettings({ elevatorArrowStyle })}
                        />
                        <SelectRow
                          label={m["image_export.vector_by_walls.vertical_arrow_corner_style"]()}
                          value={settings.elevatorArrowCornerStyle}
                          options={[
                            { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
                            { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
                          ]}
                          onChange={(elevatorArrowCornerStyle) => patchVerticalSettings({ elevatorArrowCornerStyle })}
                        />
                      </div>
                    </div>

                    <ElevatorBadgesSubsection
                      settings={settings.elevatorBadges}
                      sharedStyleOverrides={settings.sharedStyle.overrides}
                      onChange={patchElevatorBadges}
                      onCornerStyleChange={setElevatorBadgesCornerStyle}
                      onResetCornerStyle={() => resetSharedStyleField("cornerStyle", "elevatorBadges")}
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
              )}
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
                <ColorRow
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
                    floor,
                    wall,
                  ]}
                />
                );
              })}
              <ToggleRow
                label={m["image_export.vector_by_walls.split_special_shapes"]()}
                checked={settings.splitSpecialShapes}
                onChange={setSplitSpecialShapes}
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
          gapResetButton={sharedStyleFieldReset(settings.sharedStyle.overrides, "gapWidth", "markerIndex", () => resetSharedStyleField("gapWidth", "markerIndex"))}
          fillColorPriority={[PC.markerIndexText.at(settings.markerIndex.textColor), PC.markerIndexBorder.at(settings.markerIndex.borderColor), floor, background]}
          textColorPriority={[PC.markerIndexFill.at(settings.markerIndex.fillColor), PC.markerIndexBorder.at(settings.markerIndex.borderColor), floor, background]}
          borderColorPriority={[PC.markerIndexFill.at(settings.markerIndex.fillColor), PC.markerIndexText.at(settings.markerIndex.textColor), floor]}
          fillColorDefault={D.markerIndex.fillColor}
          textColorDefault={D.markerIndex.textColor}
          borderColorDefault={D.markerIndex.borderColor}
          fillColorFieldName={PC.markerIndexFill.name()}
          textColorFieldName={PC.markerIndexText.name()}
          borderColorFieldName={PC.markerIndexBorder.name()}
        />
      )}

    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: spacing.itemGap, padding: `${inset.panelInsetY}px ${inset.panelInsetX}px` },
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.itemGap}px 0` },
  subGroupWrap: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  subHeaderRow: { display: "flex", alignItems: "center", gap: spacing.itemGap, cursor: "default", borderRadius: 3 },
  subHeader: { ...typography.body },
  subGroup: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: spacing.sectionGap },
};
