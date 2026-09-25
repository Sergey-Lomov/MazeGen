import React, { useEffect, useMemo, useRef } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import type { MarkerShape, TeleportGroupOverride, TeleportConnectorStyle, TeleportArrowMode } from "../../pixi/renderers/types";
import type { TeleportSettingsFields } from "../../store/storeTypes";
import { PC, type ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import { indent, spacing, ui, typography } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import { ToggleRow } from "../ToggleRow";
import { ColorRow } from "../ColorRow";
import { ColorSwatch } from "../ColorSwatch";
import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
import {
  buildTeleportEdges,
  buildTeleportFloorInputs,
  selectFloorScopedMaze,
} from "../../pixi/selectors/mazeSelectors";
import { buildTeleportGroups, type TeleportGroup } from "../../pixi/selectors/teleportGroups";
import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { MARKER_SHAPE_OPTIONS } from "./MarkerSettingsGroup";
import * as m from "~/paraglide/messages";

/** Both render modes' Teleports sections need the same `TeleportGroup[]` (only when
 *  `teleportGroupCustomization` is on) and the same "which groups are visually indistinguishable"
 *  check (only when there's no connector line to tell them apart — with one drawn, two groups
 *  sharing a color/shape are still distinguishable by which links connect to what) — factored out
 *  (GitHub issue #313 follow-up) after `VectorByCorridorsSettingsPanel` copy-pasted
 *  `VectorByWallsSettingsPanel`'s own version of this verbatim. Takes only the `TeleportSettingsFields`
 *  slice it actually reads, so either mode's full settings object satisfies it.
 *
 *  Group list is **project-wide** (GitHub issue #484): built per floor exactly the way that floor's
 *  own `VectorByWallsRenderer`/`VectorByCorridorsRenderer` builds it (`selectFloorScopedMaze` +
 *  `buildTeleportEdges` with the same `floorContext`/badge-spread inputs the renderers pass), then
 *  merged by `TeleportGroup.key`. Building per floor — rather than once over the unscoped
 *  `nodes`/`edges` — is required for the keys to match the renderers': `buildNodePositions` groups
 *  nodes by `(x, y)` alone with no floor component, and `buildTeleportGroups`' union-find merges by
 *  rounded coordinate, so two unrelated teleports at the same cell on different floors would
 *  otherwise collapse into one group whose `key` no per-floor renderer ever produces, and any
 *  override set against it would silently never apply. A cross-floor pair is built once, on its
 *  `from` node's floor (its far endpoint resolved via `floorContext`), so it appears exactly once
 *  in the merged list. */
export function useTeleportGroupsAndCollisions(
  rawNodes: NodeDto[],
  rawEdges: EdgeDto[],
  cfg: TessellationConfig,
  floors: { id: string }[],
  settings: TeleportSettingsFields,
  start: number | null,
  finish: number | null,
): { teleportGroups: TeleportGroup[]; teleportCollisionKeys: Set<string> } {
  const teleportGroups = useMemo(() => {
    if (!settings.teleportGroupCustomization) return [];
    const floorList = floors.length > 0 ? floors : [{ id: "" }];
    // Same `{ floorContext, spread }` the vector renderers build (`buildTeleportFloorInputs`). Only
    // `floorContext.activeFloorIndex` varies per floor below — `spread` (badge blocked-cells map,
    // field cells) is floor-independent — so this is built once for the active floor and the index
    // is swapped in the loop rather than re-deriving the whole thing per iteration.
    const { floorContext, spread } = buildTeleportFloorInputs({
      unscopedNodes: rawNodes,
      unscopedEdges: rawEdges,
      floors: floorList,
      activeFloorId: floorList[0].id,
      start,
      finish,
      allowOutOfField: !settings.teleportAvoidFieldExit,
      fieldCells: rawNodes.map((n): [number, number] => [n.x, n.y]),
    });
    const byKey = new Map<string, TeleportGroup>();
    floorList.forEach((floor, activeFloorIndex) => {
      const scoped = selectFloorScopedMaze(rawNodes, rawEdges, floors, floor.id, start, finish);
      const nodeById = new Map(scoped.nodes.map((n) => [n.id, n]));
      const teleportEdges = buildTeleportEdges(
        nodeById, scoped.edges, cfg,
        { ...floorContext, activeFloorIndex },
        spread,
      );
      for (const group of buildTeleportGroups(teleportEdges)) {
        if (!byKey.has(group.key)) byKey.set(group.key, group);
      }
    });
    return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
  }, [settings.teleportGroupCustomization, settings.teleportAvoidFieldExit, rawNodes, rawEdges, cfg, floors, start, finish]);

  const teleportCollisionKeys = useMemo(() => {
    if (settings.teleportConnectorStyle !== "none") return new Set<string>();
    const resolved = teleportGroups.map((g) => {
      const o = settings.teleportGroupOverrides[g.key];
      return `${o?.fillColor ?? settings.teleportEdgeColor}:${o?.borderColor ?? settings.teleportEdgeBorderColor}:${o?.shape ?? settings.teleportLineShape}`;
    });
    const counts = new Map<string, number>();
    for (const r of resolved) counts.set(r, (counts.get(r) ?? 0) + 1);
    const collisions = new Set<string>();
    teleportGroups.forEach((g, i) => {
      if ((counts.get(resolved[i]) ?? 0) > 1) collisions.add(g.key);
    });
    return collisions;
  }, [teleportGroups, settings.teleportConnectorStyle, settings.teleportGroupOverrides, settings.teleportEdgeColor, settings.teleportEdgeBorderColor, settings.teleportLineShape]);

  return { teleportGroups, teleportCollisionKeys };
}

/** One row of the group customization list — clicking it selects the matching group (highlighting
 *  it, hiding every other group) on the canvas and vice versa (GitHub issue #293 follow-up:
 *  click-to-select, not hover — hover-driven selection flickered whenever the pointer crossed a gap
 *  between two groups' canvas hit areas). Clicking an already-selected row (or its matching canvas
 *  marker again, or `Escape`) clears the selection. Compact, unlabeled single-line layout (per the
 *  issue's own spec: index + warning slot on the left, shape dropdown + fill-color swatch +
 *  border-color swatch + reset icon flush right) — every control's meaning is a `title` tooltip
 *  instead of a visible label, since the row has no room for both. Shared by both render modes'
 *  Teleports sections (GitHub issue #313) — `selectedTeleportGroupKey` is a single, mode-agnostic
 *  store field since only one mode's renderer/panel is ever live at a time
 *  (`createModeRenderer`).
 *
 *  **Priority colors (GitHub issue #503 follow-up)** — each swatch's own project-color list is
 *  ordered: this group's own *other* color first, then every other group's fill+border colors (in
 *  group order), then the section's common teleport colors (edge/border/connector/badges) last. */
function TeleportGroupRow({
  group,
  index,
  override,
  defaultFillColor,
  defaultBorderColor,
  hasCollision,
  onChange,
  otherGroupColors,
  commonColors,
}: {
  group: TeleportGroup;
  index: number;
  override: TeleportGroupOverride | undefined;
  defaultFillColor: number;
  defaultBorderColor: number;
  hasCollision: boolean;
  onChange: (patch: TeleportGroupOverride | null) => void;
  /** Every *other* group's own override colors (fill + border alike), in group order (GitHub issue
   *  #503 follow-up) — listed after this group's own other-role color, before the common teleport
   *  colors. */
  otherGroupColors: ProjectColorEntry[];
  /** The section's common teleport colors (edge/border/connector/badges) — always last. */
  commonColors: ProjectColorEntry[];
}) {
  const selectedKey = useMazeStore((s) => s.selectedTeleportGroupKey);
  const setSelected = useMazeStore((s) => s.setSelectedTeleportGroupKey);
  const isSelected = selectedKey === group.key;
  const hasOverride = override !== undefined && Object.keys(override).length > 0;
  const rowRef = useRef<HTMLDivElement>(null);

  // Canvas -> row selection sync (selecting the group's marker on the canvas scrolls to and
  // highlights its row): a `data-selected` attribute + CSS selector, mirroring the hover-era
  // decoupling of the row's own visual state from the interaction that triggered it — keeps this
  // component correct regardless of which side (row click or canvas click) drove the change.
  const wasSelected = useRef(false);
  useEffect(() => {
    if (isSelected && !wasSelected.current) {
      rowRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }
    wasSelected.current = isSelected;
  }, [isSelected]);

  return (
    <div
      ref={rowRef}
      className="teleport-group-row"
      data-selected={isSelected ? "true" : undefined}
      style={styles.groupRow}
      onClick={() => setSelected(isSelected ? null : group.key)}
    >
      <span style={typography.body}>{index + 1}</span>
      <span style={styles.warningIcon} title={hasCollision ? m["image_export.vector_by_walls.teleport_group_collision"]() : undefined}>
        {hasCollision && <AlertTriangle size={13} color={ui.text.warning} />}
      </span>
      <span style={styles.groupRowSpacer} />
      <select
        title={m["image_export.vector_by_walls.teleport_group_override_shape"]()}
        style={sharedStyles.selectSm}
        value={override?.shape ?? "__default__"}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onChange({ ...override, shape: e.target.value === "__default__" ? undefined : (e.target.value as MarkerShape) })}
      >
        <option value="__default__">{m["image_export.vector_by_walls.teleport_group_override_shape_default"]()}</option>
        {MARKER_SHAPE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label()}</option>
        ))}
      </select>
      <span title={m["image_export.vector_by_walls.teleport_group_override_color"]()} onClick={(e) => e.stopPropagation()}>
        <ColorSwatch
          color={override?.fillColor ?? defaultFillColor}
          onChange={(fillColor) => onChange({ ...override, fillColor })}
          priorityColors={[PC.teleportGroup(index, "border").at(override?.borderColor ?? defaultBorderColor), ...otherGroupColors, ...commonColors]}
          fieldName={PC.teleportGroup(index, "fill").name()}
        />
      </span>
      <span title={m["image_export.vector_by_walls.teleport_group_override_secondary_color"]()} onClick={(e) => e.stopPropagation()}>
        <ColorSwatch
          color={override?.borderColor ?? defaultBorderColor}
          onChange={(borderColor) => onChange({ ...override, borderColor })}
          priorityColors={[PC.teleportGroup(index, "fill").at(override?.fillColor ?? defaultFillColor), ...otherGroupColors, ...commonColors]}
          fieldName={PC.teleportGroup(index, "border").name()}
        />
      </span>
      <button
        type="button"
        className="hoverable"
        title={m["image_export.vector_by_walls.teleport_group_reset"]()}
        style={styles.resetButton}
        disabled={!hasOverride}
        onClick={(e) => { e.stopPropagation(); onChange(null); e.currentTarget.blur(); }}
      >
        <RotateCcw size={14} color={ui.text.tertiary} opacity={hasOverride ? 1 : 0.4} />
      </button>
    </div>
  );
}

/** "Edges"/"Connector"/"Arrow" subsections + group customization list of a render mode's Teleports
 *  section (GitHub issue #293) — extracted out of `VectorByWallsSettingsPanel` (GitHub issue #313)
 *  so `VectorByCorridorsSettingsPanel` can mount the exact same UI against its own
 *  `TeleportSettingsFields`-shaped settings slice, mirroring `MarkerSettingsGroup`'s own
 *  per-mode-setters-only-differ reuse convention. The caller owns the `SectionHeader`/expand-collapse
 *  chrome and the "only show when the maze actually has teleports" gating — this component always
 *  renders its full body once mounted. */
export function TeleportSettingsSection({
  settings,
  onChange,
  groupOverrides,
  onGroupOverrideChange,
  teleportGroups,
  teleportCollisionKeys,
  hasCrossFloorTeleports,
  resetButtons,
  edgeColorPriority,
  edgeBorderColorPriority,
  connectorColorPriority,
  floorBadgeFillColorPriority,
  floorBadgeBorderColorPriority,
  floorBadgeTextColorPriority,
  edgeColorDefault,
  edgeBorderColorDefault,
  connectorColorDefault,
  floorBadgeFillColorDefault,
  floorBadgeBorderColorDefault,
  floorBadgeTextColorDefault,
  edgeColorFieldName,
  edgeBorderColorFieldName,
  connectorColorFieldName,
  floorBadgeFillColorFieldName,
  floorBadgeBorderColorFieldName,
  floorBadgeTextColorFieldName,
}: {
  settings: TeleportSettingsFields;
  onChange: (patch: Partial<TeleportSettingsFields>) => void;
  groupOverrides: Record<string, TeleportGroupOverride>;
  onGroupOverrideChange: (groupKey: string, patch: TeleportGroupOverride | null) => void;
  teleportGroups: TeleportGroup[];
  teleportCollisionKeys: Set<string>;
  /** Whether the project has at least one cross-floor teleport (its two endpoints on different
   *  floors) — the "Floor badges" subsection is hidden entirely otherwise (GitHub issue #485). */
  hasCrossFloorTeleports: boolean;
  /** Per-field "Shared style" reset buttons (GitHub issue #322) — same opt-in convention as
   *  `MarkerSettingsGroup`'s own `resetButtons` prop. */
  resetButtons?: {
    lineCornerStyle?: React.ReactNode;
    lineSize?: React.ReactNode;
    edgeBorderWidth?: React.ReactNode;
    edgeGapWidth?: React.ReactNode;
    connectorGapWidth?: React.ReactNode;
  };
  /** "Priority" project colors (GitHub issue #503) for the Teleports section's color rows. */
  edgeColorPriority?: ProjectColorEntry[];
  edgeBorderColorPriority?: ProjectColorEntry[];
  connectorColorPriority?: ProjectColorEntry[];
  floorBadgeFillColorPriority?: ProjectColorEntry[];
  floorBadgeBorderColorPriority?: ProjectColorEntry[];
  floorBadgeTextColorPriority?: ProjectColorEntry[];
  /** Factory defaults (GitHub issue #503) — pinned as each row's first "Default" project color. */
  edgeColorDefault?: number;
  edgeBorderColorDefault?: number;
  connectorColorDefault?: number;
  floorBadgeFillColorDefault?: number;
  floorBadgeBorderColorDefault?: number;
  floorBadgeTextColorDefault?: number;
  /** "Project colors" list names (GitHub issue #503) for the four color rows — shown in the picker
   *  header and used to drop the row itself from the list. Built by the caller from the shared
   *  `PC` registry so they match `selectActiveProfileColors`. */
  edgeColorFieldName?: string;
  edgeBorderColorFieldName?: string;
  connectorColorFieldName?: string;
  floorBadgeFillColorFieldName?: string;
  floorBadgeBorderColorFieldName?: string;
  floorBadgeTextColorFieldName?: string;
}) {
  const setSelectedTeleportGroupKey = useMazeStore((s) => s.setSelectedTeleportGroupKey);

  // The common teleport colors every group-override swatch lists below its own group's colors
  // (GitHub issue #503 follow-up) — edge/border, connector (when drawn), and the floor badges
  // (when the maze has a cross-floor teleport to badge).
  const commonTeleportColors: ProjectColorEntry[] = [
    PC.teleportEdge.at(settings.teleportEdgeColor),
    PC.teleportEdgeBorder.at(settings.teleportEdgeBorderColor),
    ...(settings.teleportConnectorStyle !== "none" ? [PC.teleportConnector.at(settings.teleportConnectorColor)] : []),
    ...(hasCrossFloorTeleports
      ? [
          PC.teleportBadgeFill.at(settings.teleportFloorBadge.fillColor),
          PC.teleportBadgeBorder.at(settings.teleportFloorBadge.borderColor),
          PC.teleportBadgeText.at(settings.teleportFloorBadge.textColor),
        ]
      : []),
  ];

  return (
    <div style={styles.block}>
      <div style={styles.subsectionLabel}>{m["image_export.vector_by_walls.teleport_subsection_edges"]()}</div>
      <div style={styles.subsection}>
        <SelectRow
          label={m["image_export.vector_by_walls.teleport_corner_style"]()}
          value={settings.teleportLineCornerStyle}
          options={[
            { value: "sharp", label: m["image_export.vector_by_walls.corner_style_sharp"]() },
            { value: "round", label: m["image_export.vector_by_walls.corner_style_round"]() },
          ]}
          onChange={(v) => onChange({ teleportLineCornerStyle: v })}
          resetButton={resetButtons?.lineCornerStyle}
        />
        <SelectRow
          label={m["image_export.vector_by_walls.teleport_shape"]()}
          value={settings.teleportLineShape}
          options={MARKER_SHAPE_OPTIONS.map((o) => ({ value: o.value, label: o.label() }))}
          onChange={(v) => onChange({ teleportLineShape: v })}
        />
        <SliderRow
          label={m["image_export.vector_by_walls.teleport_size"]()}
          value={settings.teleportLineSize}
          onChange={(v) => onChange({ teleportLineSize: v })}
          min={0}
          max={1}
          step={0.01}
          format={(v) => v.toFixed(2)}
          resetButton={resetButtons?.lineSize}
        />
        <ColorRow label={m["image_export.vector_by_walls.teleport_edge_color"]()} color={settings.teleportEdgeColor} onChange={(v) => onChange({ teleportEdgeColor: v })} priorityColors={edgeColorPriority} defaultColor={edgeColorDefault} fieldName={edgeColorFieldName} />
        <ColorRow label={m["image_export.vector_by_walls.teleport_edge_border_color"]()} color={settings.teleportEdgeBorderColor} onChange={(v) => onChange({ teleportEdgeBorderColor: v })} priorityColors={edgeBorderColorPriority} defaultColor={edgeBorderColorDefault} fieldName={edgeBorderColorFieldName} />
        <SliderRow
          label={m["image_export.vector_by_walls.teleport_border_width"]()}
          value={settings.teleportEdgeBorderWidth}
          onChange={(v) => onChange({ teleportEdgeBorderWidth: v })}
          min={0}
          max={10}
          step={1}
          format={(v) => String(v)}
          resetButton={resetButtons?.edgeBorderWidth}
        />
        <SliderRow
          label={m["image_export.vector_by_walls.teleport_edge_gap_width"]()}
          value={settings.teleportEdgeGapWidth}
          onChange={(v) => onChange({ teleportEdgeGapWidth: v })}
          min={0}
          max={10}
          step={1}
          format={(v) => String(v)}
          resetButton={resetButtons?.edgeGapWidth}
        />
      </div>

      <div style={styles.subsectionLabel}>{m["image_export.vector_by_walls.teleport_subsection_connector"]()}</div>
      <div style={styles.subsection}>
        <SelectRow
          label={m["image_export.vector_by_walls.teleport_connector_style"]()}
          value={settings.teleportConnectorStyle}
          options={[
            { value: "none" as TeleportConnectorStyle, label: m["image_export.vector_by_walls.teleport_connector_style_none"]() },
            { value: "straight" as TeleportConnectorStyle, label: m["image_export.vector_by_walls.teleport_connector_style_straight"]() },
            { value: "orthogonal" as TeleportConnectorStyle, label: m["image_export.vector_by_walls.teleport_connector_style_orthogonal"]() },
          ]}
          onChange={(v) => onChange({ teleportConnectorStyle: v })}
        />
        {settings.teleportConnectorStyle === "orthogonal" && (
          <ToggleRow
            label={m["image_export.vector_by_walls.teleport_avoid_field_exit"]()}
            checked={settings.teleportAvoidFieldExit}
            onChange={(v) => onChange({ teleportAvoidFieldExit: v })}
          />
        )}

        {settings.teleportConnectorStyle !== "none" && (<>
        <div style={styles.subsectionLabel}>{m["image_export.vector_by_walls.teleport_subsection_connector_body"]()}</div>
        <div style={styles.subsectionNested}>
          <ColorRow label={m["image_export.vector_by_walls.teleport_connector_color"]()} color={settings.teleportConnectorColor} onChange={(v) => onChange({ teleportConnectorColor: v })} priorityColors={connectorColorPriority} defaultColor={connectorColorDefault} fieldName={connectorColorFieldName} />
          <SliderRow
            label={m["image_export.vector_by_walls.teleport_connector_width"]()}
            value={settings.teleportConnectorWidth}
            onChange={(v) => onChange({ teleportConnectorWidth: v })}
            min={1}
            max={10}
            step={1}
            format={(v) => String(v)}
          />
          <SliderRow
            label={m["image_export.vector_by_walls.teleport_connector_gap_width"]()}
            value={settings.teleportConnectorGapWidth}
            onChange={(v) => onChange({ teleportConnectorGapWidth: v })}
            min={0}
            max={10}
            step={1}
            format={(v) => String(v)}
            resetButton={resetButtons?.connectorGapWidth}
          />
        </div>

        <div style={styles.subsectionLabel}>{m["image_export.vector_by_walls.teleport_subsection_connector_arrow"]()}</div>
        <div style={styles.subsectionNested}>
          <SelectRow
            label={m["image_export.vector_by_walls.teleport_arrow_mode"]()}
            value={settings.teleportArrowMode}
            options={[
              { value: "none" as TeleportArrowMode, label: m["image_export.vector_by_walls.teleport_arrow_mode_none"]() },
              { value: "center" as TeleportArrowMode, label: m["image_export.vector_by_walls.teleport_arrow_mode_center"]() },
              { value: "double" as TeleportArrowMode, label: m["image_export.vector_by_walls.teleport_arrow_mode_double"]() },
              { value: "periodic" as TeleportArrowMode, label: m["image_export.vector_by_walls.teleport_arrow_mode_periodic"]() },
            ]}
            onChange={(v) => onChange({ teleportArrowMode: v })}
          />
          <SliderRow
            label={m["image_export.vector_by_walls.teleport_arrow_period"]()}
            value={settings.teleportArrowPeriod}
            onChange={(v) => onChange({ teleportArrowPeriod: v })}
            min={1}
            max={20}
            step={1}
            format={(v) => String(v)}
            disabled={settings.teleportArrowMode !== "periodic"}
          />
          <SliderRow
            label={m["image_export.vector_by_walls.teleport_arrow_size"]()}
            value={settings.teleportArrowSize}
            onChange={(v) => onChange({ teleportArrowSize: v })}
            min={1}
            max={20}
            step={1}
            format={(v) => String(v)}
            disabled={settings.teleportArrowMode === "none"}
          />
        </div>
        </>)}
      </div>

      {hasCrossFloorTeleports && (
        <>
          <div style={styles.subsectionLabel}>{m["image_export.vector_by_walls.teleport_subsection_floor_badges"]()}</div>
          <div style={styles.subsection}>
            <SelectRow
              label={m["image_export.vector_by_walls.teleport_floor_badge_shape"]()}
              value={settings.teleportFloorBadge.shape}
              options={MARKER_SHAPE_OPTIONS.map((o) => ({ value: o.value, label: o.label() }))}
              onChange={(v) => onChange({ teleportFloorBadge: { ...settings.teleportFloorBadge, shape: v } })}
            />
            <SelectRow
              label={m["image_export.vector_by_walls.teleport_floor_badge_label_type"]()}
              value={settings.teleportFloorBadge.labelType}
              options={[
                { value: "arabic", label: m["image_export.vector_by_walls.elevator_badges_label_type_arabic"]() },
                { value: "roman", label: m["image_export.vector_by_walls.elevator_badges_label_type_roman"]() },
                { value: "letters", label: m["image_export.vector_by_walls.elevator_badges_label_type_letters"]() },
              ]}
              onChange={(v) => onChange({ teleportFloorBadge: { ...settings.teleportFloorBadge, labelType: v } })}
            />
            <SliderRow
              label={m["image_export.vector_by_walls.teleport_floor_badge_size"]()}
              value={settings.teleportFloorBadge.size}
              onChange={(v) => onChange({ teleportFloorBadge: { ...settings.teleportFloorBadge, size: v } })}
              min={0}
              max={1}
              step={0.01}
              format={(v) => v.toFixed(2)}
            />
            <ColorRow
              label={m["image_export.vector_by_walls.teleport_floor_badge_fill_color"]()}
              color={settings.teleportFloorBadge.fillColor}
              onChange={(v) => onChange({ teleportFloorBadge: { ...settings.teleportFloorBadge, fillColor: v } })}
              priorityColors={floorBadgeFillColorPriority}
              defaultColor={floorBadgeFillColorDefault}
              fieldName={floorBadgeFillColorFieldName}
            />
            <ColorRow
              label={m["image_export.vector_by_walls.teleport_floor_badge_border_color"]()}
              color={settings.teleportFloorBadge.borderColor}
              onChange={(v) => onChange({ teleportFloorBadge: { ...settings.teleportFloorBadge, borderColor: v } })}
              priorityColors={floorBadgeBorderColorPriority}
              defaultColor={floorBadgeBorderColorDefault}
              fieldName={floorBadgeBorderColorFieldName}
            />
            <ColorRow
              label={m["image_export.vector_by_walls.teleport_floor_badge_text_color"]()}
              color={settings.teleportFloorBadge.textColor}
              onChange={(v) => onChange({ teleportFloorBadge: { ...settings.teleportFloorBadge, textColor: v } })}
              priorityColors={floorBadgeTextColorPriority}
              defaultColor={floorBadgeTextColorDefault}
              fieldName={floorBadgeTextColorFieldName}
            />
            <SliderRow
              label={m["image_export.vector_by_walls.teleport_floor_badge_border_width"]()}
              value={settings.teleportFloorBadge.borderWidth ?? 3}
              onChange={(v) => onChange({ teleportFloorBadge: { ...settings.teleportFloorBadge, borderWidth: v } })}
              min={0}
              max={10}
              step={1}
              format={(v) => String(v)}
            />
            <SliderRow
              label={m["image_export.vector_by_walls.teleport_floor_badge_text_padding"]()}
              value={settings.teleportFloorBadge.textPadding}
              onChange={(v) => onChange({ teleportFloorBadge: { ...settings.teleportFloorBadge, textPadding: v } })}
              min={0}
              max={5}
              step={0.25}
              format={(v) => v.toFixed(2)}
            />
          </div>
        </>
      )}

      <ToggleRow
        label={m["image_export.vector_by_walls.teleport_group_customization"]()}
        checked={settings.teleportGroupCustomization}
        onChange={(checked) => {
          setSelectedTeleportGroupKey(null);
          onChange({ teleportGroupCustomization: checked });
        }}
      />
      {settings.teleportGroupCustomization && teleportGroups.length > 0 && (() => {
        // Every group's own fill+border colors, computed once (GitHub issue #503 follow-up) — each
        // row's own "other groups" priority list below is a slice of this shared array rather than
        // a fresh `PC.teleportGroup(...).at(...)` pass per row.
        const allGroupColors: ProjectColorEntry[][] = teleportGroups.map((g, gi) => {
          const o = groupOverrides[g.key];
          return [
            PC.teleportGroup(gi, "fill").at(o?.fillColor ?? settings.teleportEdgeColor),
            PC.teleportGroup(gi, "border").at(o?.borderColor ?? settings.teleportEdgeBorderColor),
          ];
        });
        return (
          <div style={styles.groupList}>
            {teleportGroups.map((group, i) => (
              <TeleportGroupRow
                key={group.key}
                group={group}
                index={i}
                override={groupOverrides[group.key]}
                defaultFillColor={settings.teleportEdgeColor}
                defaultBorderColor={settings.teleportEdgeBorderColor}
                hasCollision={teleportCollisionKeys.has(group.key)}
                onChange={(patch) => onGroupOverrideChange(group.key, patch)}
                otherGroupColors={allGroupColors.filter((_, gi) => gi !== i).flat()}
                commonColors={commonTeleportColors}
              />
            ))}
          </div>
        );
      })()}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  subsectionLabel: { ...typography.body },
  subsection: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  subsectionNested: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  groupList: { display: "flex", flexDirection: "column", gap: spacing.itemGap, marginTop: spacing.itemGap, paddingLeft: indent.tree },
  groupRow: {
    display: "flex", flexDirection: "row", alignItems: "center", gap: spacing.itemGap, outline: "none",
    padding: spacing.itemGap, borderRadius: 3, border: `1px solid ${ui.border.default}`,
  },
  groupRowSpacer: { flex: 1 },
  warningIcon: { display: "inline-flex", alignItems: "center", cursor: "default", width: 13 },
  resetButton: {
    ...typography.caption, color: ui.text.tertiary, display: "inline-flex", alignItems: "center",
    background: "none", border: "none", outline: "none", cursor: "default", padding: 0,
  },
};
