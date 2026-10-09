import { useColorVisibility } from "../ColorVisibilityContext";
import React, { useEffect, useMemo, useRef } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import type { MarkerShape, TeleportGroupOverride, TeleportConnectorStyle, TeleportArrowMode } from "../../pixi/renderers/types";
import type { MarkerSettings, TeleportSettingsFields } from "../../store/storeTypes";
import { PC, type ProjectColorEntry, type ColorField } from "../../pixi/selectors/projectColorsSelector";
import { indent, spacing, ui, typography } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import { ColorSwatch } from "../ColorSwatch";
import { LinkedToggleRow, LinkedColorRow, LinkedSelectRow, LinkedSliderRow } from "./LinkedRows";
import {
  buildTeleportEdges,
  buildTeleportFloorInputs,
  selectFloorScopedMaze,
} from "../../pixi/selectors/mazeSelectors";
import { buildTeleportGroups, type TeleportGroup } from "../../pixi/selectors/teleportGroups";
import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { MarkerAppearanceRows, TextStyleRows, MARKER_SHAPE_OPTIONS } from "./MarkerFieldRows";
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
      return `${o?.fillColor ?? settings.teleportMarker.fillColor}:${o?.borderColor ?? settings.teleportMarker.borderColor}:${o?.shape ?? settings.teleportMarker.shape}`;
    });
    const counts = new Map<string, number>();
    for (const r of resolved) counts.set(r, (counts.get(r) ?? 0) + 1);
    const collisions = new Set<string>();
    teleportGroups.forEach((g, i) => {
      if ((counts.get(resolved[i]) ?? 0) > 1) collisions.add(g.key);
    });
    return collisions;
  }, [teleportGroups, settings.teleportConnectorStyle, settings.teleportGroupOverrides, settings.teleportMarker.fillColor, settings.teleportMarker.borderColor, settings.teleportMarker.shape]);

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
        name={`teleport-group-${index}-shape`}
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
          field={PC.teleportGroup(index, "fill")}
        />
      </span>
      <span title={m["image_export.vector_by_walls.teleport_group_override_secondary_color"]()} onClick={(e) => e.stopPropagation()}>
        <ColorSwatch
          color={override?.borderColor ?? defaultBorderColor}
          onChange={(borderColor) => onChange({ ...override, borderColor })}
          priorityColors={[PC.teleportGroup(index, "fill").at(override?.fillColor ?? defaultFillColor), ...otherGroupColors, ...commonColors]}
          field={PC.teleportGroup(index, "border")}
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
export function TeleportSettingsSection<P extends string>({
  settings,
  onChange,
  groupOverrides,
  onGroupOverrideChange,
  teleportGroups,
  teleportCollisionKeys,
  hasCrossFloorTeleports,
  linkTargets,
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
  edgeColorField,
  edgeBorderColorField,
  connectorColorField,
  floorBadgeFillColorField,
  floorBadgeBorderColorField,
  floorBadgeTextColorField,
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
  /** Per-field link paths (GitHub issue #652 follow-up) for every `Linked*Row` in this section — a
   *  concrete path where the registry models the field, `null` where it doesn't. */
  linkTargets: {
    lineCornerStyle: P | null;
    lineShape: P | null;
    lineSize: P | null;
    edgeColor: P | null;
    edgeBorderColor: P | null;
    edgeBorderWidth: P | null;
    edgeGapWidth: P | null;
    connectorStyle: P | null;
    avoidFieldExit: P | null;
    connectorColor: P | null;
    connectorWidth: P | null;
    connectorGapWidth: P | null;
    arrowMode: P | null;
    arrowPeriod: P | null;
    arrowSize: P | null;
    floorBadgeShape: P | null;
    floorBadgeLabelType: P | null;
    floorBadgeSize: P | null;
    floorBadgeFillColor: P | null;
    floorBadgeBorderColor: P | null;
    floorBadgeTextColor: P | null;
    floorBadgeBorderWidth: P | null;
    floorBadgeCornerStyle: P | null;
    floorBadgeGapWidth: P | null;
    floorBadgeTextSize: P | null;
    floorBadgeTextFontWeight: P | null;
    groupCustomization: P | null;
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
  edgeColorField: ColorField;
  edgeBorderColorField: ColorField;
  connectorColorField: ColorField;
  floorBadgeFillColorField: ColorField;
  floorBadgeBorderColorField: ColorField;
  floorBadgeTextColorField: ColorField;
}) {
  const setSelectedTeleportGroupKey = useMazeStore((s) => s.setSelectedTeleportGroupKey);
  const patchMarker = (patch: Partial<MarkerSettings>) => onChange({ teleportMarker: { ...settings.teleportMarker, ...patch } });

  // The common teleport colors every group-override swatch lists below its own group's colors
  // (GitHub issue #503 follow-up) — edge/border, connector (when drawn), and the floor badges
  // (when the maze has a cross-floor teleport to badge).
  const commonTeleportColors: ProjectColorEntry[] = [
    PC.teleportEdge.at(settings.teleportMarker.fillColor),
    PC.teleportEdgeBorder.at(settings.teleportMarker.borderColor),
    PC.teleportConnector.at(settings.teleportConnectorColor),
    PC.teleportBadgeFill.at(settings.teleportFloorBadge.fillColor),
    PC.teleportBadgeBorder.at(settings.teleportFloorBadge.borderColor),
    PC.teleportBadgeText.at(settings.teleportFloorBadge.textColor),
  ];
  // Hidden fields (no connector line, no cross-floor teleport) are dropped by the picker's
  // visibility-filtered "Project colors" list — no gating here (GitHub issue #717).
  const colorVisibility = useColorVisibility();
  const connectorShown = colorVisibility === null || connectorColorField.isVisible(colorVisibility);

  return (
    <div style={styles.block}>
      <div style={styles.subsectionLabel}>{m["image_export.vector_by_walls.teleport_subsection_edges"]()}</div>
      <div style={styles.subsection}>
        <MarkerAppearanceRows
          settings={settings.teleportMarker}
          onChange={patchMarker}
          linkTargets={{
            shape: linkTargets.lineShape,
            cornerStyle: linkTargets.lineCornerStyle,
            size: linkTargets.lineSize,
            fillColor: linkTargets.edgeColor,
            borderColor: linkTargets.edgeBorderColor,
            borderWidth: linkTargets.edgeBorderWidth,
            gapWidth: linkTargets.edgeGapWidth,
          }}
          priorityColors={{ fillColor: edgeColorPriority, borderColor: edgeBorderColorPriority }}
          defaultColors={{ fillColor: edgeColorDefault, borderColor: edgeBorderColorDefault }}
          fields={{ fillColor: edgeColorField, borderColor: edgeBorderColorField }}
        />
      </div>

      <div style={styles.subsectionLabel}>{m["image_export.vector_by_walls.teleport_subsection_connector"]()}</div>
      <div style={styles.subsection}>
        <LinkedSelectRow
          label={m["image_export.vector_by_walls.teleport_connector_style"]()}
          value={settings.teleportConnectorStyle}
          options={[
            { value: "none" as TeleportConnectorStyle, label: m["image_export.vector_by_walls.teleport_connector_style_none"]() },
            { value: "straight" as TeleportConnectorStyle, label: m["image_export.vector_by_walls.teleport_connector_style_straight"]() },
            { value: "orthogonal" as TeleportConnectorStyle, label: m["image_export.vector_by_walls.teleport_connector_style_orthogonal"]() },
          ]}
          onChange={(v) => onChange({ teleportConnectorStyle: v })}
          linkTarget={linkTargets.connectorStyle}
        />
        {settings.teleportConnectorStyle === "orthogonal" && (
          <LinkedToggleRow
            label={m["image_export.vector_by_walls.teleport_avoid_field_exit"]()}
            checked={settings.teleportAvoidFieldExit}
            onChange={(v) => onChange({ teleportAvoidFieldExit: v })}
            linkTarget={linkTargets.avoidFieldExit}
          />
        )}

        {connectorShown && (<>
        <div style={styles.subsectionLabel}>{m["image_export.vector_by_walls.teleport_subsection_connector_body"]()}</div>
        <div style={styles.subsectionNested}>
          <LinkedColorRow label={m["image_export.vector_by_walls.teleport_connector_color"]()} color={settings.teleportConnectorColor} onChange={(v) => onChange({ teleportConnectorColor: v })} priorityColors={connectorColorPriority} defaultColor={connectorColorDefault} field={connectorColorField} linkTarget={linkTargets.connectorColor} />
          <LinkedSliderRow
            label={m["image_export.vector_by_walls.teleport_connector_width"]()}
            value={settings.teleportConnectorWidth}
            onChange={(v) => onChange({ teleportConnectorWidth: v })}
            min={1}
            max={10}
            step={1}
            format={(v) => String(v)}
            linkTarget={linkTargets.connectorWidth}
          />
          <LinkedSliderRow
            label={m["image_export.vector_by_walls.teleport_connector_gap_width"]()}
            value={settings.teleportConnectorGapWidth}
            onChange={(v) => onChange({ teleportConnectorGapWidth: v })}
            min={0}
            max={10}
            step={1}
            format={(v) => String(v)}
            linkTarget={linkTargets.connectorGapWidth}
          />
        </div>

        <div style={styles.subsectionLabel}>{m["image_export.vector_by_walls.teleport_subsection_connector_arrow"]()}</div>
        <div style={styles.subsectionNested}>
          <LinkedSelectRow
            label={m["image_export.vector_by_walls.teleport_arrow_mode"]()}
            value={settings.teleportArrowMode}
            options={[
              { value: "none" as TeleportArrowMode, label: m["image_export.vector_by_walls.teleport_arrow_mode_none"]() },
              { value: "center" as TeleportArrowMode, label: m["image_export.vector_by_walls.teleport_arrow_mode_center"]() },
              { value: "double" as TeleportArrowMode, label: m["image_export.vector_by_walls.teleport_arrow_mode_double"]() },
              { value: "periodic" as TeleportArrowMode, label: m["image_export.vector_by_walls.teleport_arrow_mode_periodic"]() },
            ]}
            onChange={(v) => onChange({ teleportArrowMode: v })}
            linkTarget={linkTargets.arrowMode}
          />
          <LinkedSliderRow
            label={m["image_export.vector_by_walls.teleport_arrow_period"]()}
            value={settings.teleportArrowPeriod}
            onChange={(v) => onChange({ teleportArrowPeriod: v })}
            min={1}
            max={20}
            step={1}
            format={(v) => String(v)}
            disabled={settings.teleportArrowMode !== "periodic"}
            linkTarget={linkTargets.arrowPeriod}
          />
          <LinkedSliderRow
            label={m["image_export.vector_by_walls.teleport_arrow_size"]()}
            value={settings.teleportArrowSize}
            onChange={(v) => onChange({ teleportArrowSize: v })}
            min={1}
            max={20}
            step={1}
            format={(v) => String(v)}
            disabled={settings.teleportArrowMode === "none"}
            linkTarget={linkTargets.arrowSize}
          />
        </div>
        </>)}
      </div>

      {hasCrossFloorTeleports && (
        <>
          <div style={styles.subsectionLabel}>{m["image_export.vector_by_walls.teleport_subsection_floor_badges"]()}</div>
          <div style={styles.subsection}>
            <LinkedSelectRow
              label={m["image_export.vector_by_walls.teleport_floor_badge_label_type"]()}
              value={settings.teleportFloorBadge.labelType}
              options={[
                { value: "arabic", label: m["image_export.vector_by_walls.elevator_badges_label_type_arabic"]() },
                { value: "roman", label: m["image_export.vector_by_walls.elevator_badges_label_type_roman"]() },
                { value: "letters", label: m["image_export.vector_by_walls.elevator_badges_label_type_letters"]() },
              ]}
              onChange={(v) => onChange({ teleportFloorBadge: { ...settings.teleportFloorBadge, labelType: v } })}
              linkTarget={linkTargets.floorBadgeLabelType}
            />
            <MarkerAppearanceRows
              settings={settings.teleportFloorBadge}
              onChange={(patch) => onChange({ teleportFloorBadge: { ...settings.teleportFloorBadge, ...patch } })}
              linkTargets={{
                shape: linkTargets.floorBadgeShape,
                cornerStyle: linkTargets.floorBadgeCornerStyle,
                size: linkTargets.floorBadgeSize,
                fillColor: linkTargets.floorBadgeFillColor,
                borderColor: linkTargets.floorBadgeBorderColor,
                borderWidth: linkTargets.floorBadgeBorderWidth,
                gapWidth: linkTargets.floorBadgeGapWidth,
              }}
              priorityColors={{ fillColor: floorBadgeFillColorPriority, borderColor: floorBadgeBorderColorPriority }}
              defaultColors={{ fillColor: floorBadgeFillColorDefault, borderColor: floorBadgeBorderColorDefault }}
              fields={{ fillColor: floorBadgeFillColorField, borderColor: floorBadgeBorderColorField }}
            />
            <TextStyleRows
              settings={settings.teleportFloorBadge}
              onChange={(patch) => onChange({ teleportFloorBadge: { ...settings.teleportFloorBadge, ...patch } })}
              linkTargets={{
                textFontWeight: linkTargets.floorBadgeTextFontWeight,
                textColor: linkTargets.floorBadgeTextColor,
                textSize: linkTargets.floorBadgeTextSize,
              }}
              priorityColors={floorBadgeTextColorPriority}
              defaultColor={floorBadgeTextColorDefault}
              field={floorBadgeTextColorField}
              autoFitKind="teleport"
            />
          </div>
        </>
      )}

      <LinkedToggleRow
        label={m["image_export.vector_by_walls.teleport_group_customization"]()}
        checked={settings.teleportGroupCustomization}
        onChange={(checked) => {
          setSelectedTeleportGroupKey(null);
          onChange({ teleportGroupCustomization: checked });
        }}
        linkTarget={linkTargets.groupCustomization}
      />
      {settings.teleportGroupCustomization && teleportGroups.length > 0 && (() => {
        // Every group's own fill+border colors, computed once (GitHub issue #503 follow-up) — each
        // row's own "other groups" priority list below is a slice of this shared array rather than
        // a fresh `PC.teleportGroup(...).at(...)` pass per row.
        const allGroupColors: ProjectColorEntry[][] = teleportGroups.map((g, gi) => {
          const o = groupOverrides[g.key];
          return [
            PC.teleportGroup(gi, "fill").at(o?.fillColor ?? settings.teleportMarker.fillColor),
            PC.teleportGroup(gi, "border").at(o?.borderColor ?? settings.teleportMarker.borderColor),
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
                defaultFillColor={settings.teleportMarker.fillColor}
                defaultBorderColor={settings.teleportMarker.borderColor}
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
