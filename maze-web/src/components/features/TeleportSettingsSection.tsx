import { useColorVisibility } from "../ColorVisibilityContext";
import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import type { MarkerShape, TeleportGroupOverride, TeleportGroupRole, TeleportConnectorStyle, TeleportCurveDirection, TeleportArrowMode } from "../../pixi/renderers/types";
import type { MarkerSettings, TeleportSettingsFields } from "../../store/storeTypes";
import { PC, type ProjectColorEntry, type ColorField } from "../../pixi/selectors/projectColorsSelector";
import { indent, spacing, ui, typography } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import { ColorSwatch } from "../ColorSwatch";
import { Button } from "../Button";
import { SectionHeader } from "../SectionHeader";
import { EntityBubbleRow } from "./EntityBubbleRow";
import { usePostEditSplitLabelContext } from "./usePostEditSplitLabelContext";
import { LinkedToggleRow, LinkedColorRow, LinkedSelectRow, LinkedSliderRow } from "./LinkedRows";
import { useLinkContext } from "./LinkContext";
import { useLocale } from "../../i18n/useLocale";
import { buildGroupLinks, groupRolePath, isGroupRoleLinked, resolveGroupOverrides } from "../../store/teleportGroupLinks";
import { LinkStatusIcon } from "../LinkStatusIcon";
import type { ParamDescriptor, ParamLink } from "../../store/parameterLinks";
import type { TeleportGroup } from "../../pixi/selectors/teleportGroups";
import { buildProjectTeleportGroups } from "../../pixi/selectors/projectTeleportGroups";
import { endpointBubble } from "../../pixi/postEditCommandLabels";
import { nodeEndpoint } from "../../pixi/postEditEndpoint";
import { navigateToFloor } from "../../pixi/renderers/floorNavigation";
import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import { MarkerAppearanceRows, TextStyleRows, MARKER_SHAPE_OPTIONS } from "./MarkerFieldRows";
import { distributeOklchHues } from "../../store/colorMath";
import { Tooltip } from "../Tooltip";
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
 *  merged across floors (`buildProjectTeleportGroups`) — a cross-floor teleport shows up in each
 *  touched floor's own group, and those groups are unioned into one. Building per floor — rather than
 *  once over the unscoped `nodes`/`edges` — is required for the keys to match the renderers': `buildNodePositions` groups
 *  nodes by `(x, y)` alone with no floor component, and `buildTeleportGroups`' union-find merges by
 *  rounded coordinate, so two unrelated teleports at the same cell on different floors would
 *  otherwise collapse into one group whose `key` no per-floor renderer ever produces, and any
 *  override set against it would silently never apply. The renderers resolve overrides through the
 *  same merge (`resolveFloorGroupOverrides`). */
export function useTeleportGroupsAndCollisions(
  rawNodes: NodeDto[],
  rawEdges: EdgeDto[],
  cfg: FieldConfig,
  floors: { id: string }[],
  settings: TeleportSettingsFields & { links: ParamLink<string>[] },
  start: number | null,
  finish: number | null,
): { teleportGroups: TeleportGroup[]; teleportCollisionKeys: Set<string> } {
  const teleportGroups = useMemo(() => {
    if (!settings.teleportGroupCustomization) return [];
    return buildProjectTeleportGroups({
      nodes: rawNodes, edges: rawEdges, cfg, floors, avoidFieldExit: settings.teleportAvoidFieldExit, start, finish,
    });
  }, [settings.teleportGroupCustomization, settings.teleportAvoidFieldExit, rawNodes, rawEdges, cfg, floors, start, finish]);

  const teleportCollisionKeys = useMemo(() => {
    if (settings.teleportConnectorStyle !== "none") return new Set<string>();
    const effective = resolveGroupOverrides(settings);
    const resolved = teleportGroups.map((g) => {
      const o = effective[g.key];
      return `${o?.fillColor ?? settings.teleportMarker.fillColor}:${o?.borderColor ?? settings.teleportMarker.borderColor}:${o?.shape ?? settings.teleportMarker.shape}`;
    });
    const counts = new Map<string, number>();
    for (const r of resolved) counts.set(r, (counts.get(r) ?? 0) + 1);
    const collisions = new Set<string>();
    teleportGroups.forEach((g, i) => {
      if ((counts.get(resolved[i]) ?? 0) > 1) collisions.add(g.key);
    });
    return collisions;
  }, [teleportGroups, settings.teleportConnectorStyle, settings.teleportGroupOverrides, settings.links, settings.teleportMarker.fillColor, settings.teleportMarker.borderColor, settings.teleportMarker.shape]);

  return { teleportGroups, teleportCollisionKeys };
}

/** One group of the group customization list — a three-row cell: (1) the group title + collision
 *  warning on the left and the "Reset all values" button on the right, (2) every teleport of the
 *  group as the shared post-edit bubble pair (`EntityBubbleRow`, labels from `endpointBubble` with
 *  the post-edit split-label context), (3) the shape dropdown + fill/border color swatches.
 *
 *  Hovering the cell highlights every teleport cell of the group on the export canvas; hovering one
 *  bubble highlights only that cell, hovering an arrow only its teleport's two cells
 *  (`hoveredTeleportNodeIds`, drawn by the mode renderer's cell-highlight overlay). Clicking a
 *  bubble switches to its floor.
 *
 *  **Priority colors (GitHub issue #503 follow-up)** — each swatch's own project-color list is
 *  ordered: this group's own *other* color first, then every other group's fill+border colors (in
 *  group order), then the section's common teleport colors (edge/border/connector/badges) last. */
function TeleportGroupCell({
  group,
  index,
  override,
  effective,
  links,
  defaultShape,
  defaultFillColor,
  defaultBorderColor,
  hasCollision,
  onChange,
  otherGroupColors,
  commonColors,
}: {
  group: TeleportGroup;
  index: number;
  /** Stored override (explicit values + `linkBroken` flags). */
  override: TeleportGroupOverride | undefined;
  /** Resolved override (explicit, else link-derived, else unset = common) — what the group actually draws. */
  effective: TeleportGroupOverride | undefined;
  /** Links of the render mode — the common marker parameters' incoming links drive each role (GitHub issue #729). */
  links: ParamLink<string>[];
  defaultShape: MarkerShape;
  defaultFillColor: number;
  defaultBorderColor: number;
  hasCollision: boolean;
  onChange: (patch: TeleportGroupOverride) => void;
  /** Every *other* group's own override colors (fill + border alike), in group order (GitHub issue
   *  #503 follow-up) — listed after this group's own other-role color, before the common teleport
   *  colors. */
  otherGroupColors: ProjectColorEntry[];
  /** The section's common teleport colors (edge/border/connector/badges) — always last. */
  commonColors: ProjectColorEntry[];
}) {
  const setHovered = useMazeStore((s) => s.setHoveredTeleportNodeIds);
  const { nodeById, multiFloor, splitCtx } = usePostEditSplitLabelContext();
  const fillColor = effective?.fillColor ?? defaultFillColor;
  const borderColor = effective?.borderColor ?? defaultBorderColor;
  const { registry } = useLinkContext<string>();
  const { locale } = useLocale();
  const groupLinks = useMemo(() => buildGroupLinks(links, override), [links, override]);
  // Virtual registry: the group's own role parameters, labelled after the common marker's ones, so the
  // icon's tooltip names "Group N / <parameter>" for a rebound source.
  const groupRegistry = useMemo(() => {
    const groupName = m["image_export.vector_by_walls.teleport_group_title"]({ index: index + 1 });
    const roles = [["shape", "teleportMarker.shape"], ["fillColor", "teleportMarker.fillColor"], ["borderColor", "teleportMarker.borderColor"]] as const;
    const reg: Record<string, ParamDescriptor> = { ...registry };
    for (const [role, commonPath] of roles) {
      const common = registry[commonPath];
      if (!common) continue;
      // The group's border is its "secondary" color (it also drives connectors and floor badges).
      reg[groupRolePath(role)] = { ...common, group: [groupName], ...(role === "borderColor" ? { label: m["image_export.vector_by_walls.teleport_group_secondary_color_label"]() } : {}) };
    }
    return reg;
    // `locale`: the copied labels/groups are resolved at spread time (GitHub issue #742).
  }, [registry, index, locale]);
  const noop = () => {};
  const activePaths = useMemo(() => new Set<string>(), []);
  const linkToggle = (role: TeleportGroupRole, currentValue: number | MarkerShape | undefined) => (
    <LinkStatusIcon
      target={groupRolePath(role)}
      links={groupLinks}
      registry={groupRegistry}
      onSetLinkEnabled={noop}
      onAddLink={noop}
      activePaths={activePaths}
      // Break keeps the current look as an explicit value; restore clears it so the link takes over again.
      alwaysVisible
      onToggleLink={() => {
        onChange({ [role]: isGroupRoleLinked(override, role) ? currentValue : undefined } as TeleportGroupOverride);
      }}
    />
  );

  // A cell that unmounts while hovered (section collapsed, customization switched off) would
  // otherwise leave its canvas highlight stuck on.
  useEffect(() => () => setHovered(null), [setHovered]);

  const allNodeIds = Array.from(new Set(group.links.flatMap((link) => [link.from, link.to])));

  return (
    <div style={styles.groupCell} onMouseEnter={() => setHovered(allNodeIds)} onMouseLeave={() => setHovered(null)}>
      <div style={styles.groupCellTop}>
        <div style={styles.groupCellLinks}>
          {group.links.map((link) => (
            <div
              key={`${link.from}-${link.to}`}
              style={styles.groupCellLink}
              onMouseOver={(e) => { if (e.target === e.currentTarget) setHovered(allNodeIds); }}
            >
              <div style={styles.groupCellLinkBody}>
                <EntityBubbleRow
                  bubbles={[
                    endpointBubble(nodeEndpoint(link.from), nodeById, multiFloor, splitCtx),
                    endpointBubble(nodeEndpoint(link.to), nodeById, multiFloor, splitCtx),
                  ]}
                  arrow={link.oneWay ? "->" : "<->"}
                  onBubbleEnter={(_, j) => setHovered([j === 0 ? link.from : link.to])}
                  onArrowEnter={() => setHovered([link.from, link.to])}
                  onBubbleClick={(bubble) => {
                    if (bubble.highlight?.kind === "point") navigateToFloor(bubble.highlight.level ?? 0);
                  }}
                />
              </div>
            </div>
          ))}
        </div>
        <div style={styles.groupCellHeader} onMouseEnter={() => setHovered(allNodeIds)}>
          <Tooltip content={hasCollision ? m["image_export.vector_by_walls.teleport_group_collision"]() : undefined}><span style={styles.warningIcon}>
            {hasCollision && <AlertTriangle size={13} color={ui.text.warning} />}
          </span></Tooltip>
          <span style={{ ...typography.body, color: ui.text.tertiary }}>{`#${index + 1}`}</span>
        </div>
      </div>
      <div style={styles.groupCellControls} onMouseEnter={() => setHovered(allNodeIds)}>
        <Tooltip content={m["image_export.vector_by_walls.teleport_group_override_shape"]()}><select
          name={`teleport-group-${index}-shape`}
          style={sharedStyles.selectSm}
          value={effective?.shape ?? defaultShape}
          onChange={(e) => onChange({ shape: e.target.value as MarkerShape })}
        >
          {MARKER_SHAPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label()}</option>
          ))}
        </select></Tooltip>
        {linkToggle("shape", effective?.shape ?? defaultShape)}
        <Tooltip content={m["image_export.vector_by_walls.teleport_group_override_color"]()}><span>
          <ColorSwatch
            color={fillColor}
            onChange={(c) => onChange({ fillColor: c })}
            priorityColors={[PC.teleportGroup(index, "border").at(borderColor), ...otherGroupColors, ...commonColors]}
            field={PC.teleportGroup(index, "fill")}
          />
        </span></Tooltip>
        {linkToggle("fillColor", fillColor)}
        <Tooltip content={m["image_export.vector_by_walls.teleport_group_override_secondary_color"]()}><span>
          <ColorSwatch
            color={borderColor}
            onChange={(c) => onChange({ borderColor: c })}
            priorityColors={[PC.teleportGroup(index, "fill").at(fillColor), ...otherGroupColors, ...commonColors]}
            field={PC.teleportGroup(index, "border")}
          />
        </span></Tooltip>
        {linkToggle("borderColor", borderColor)}
      </div>
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
  onGroupOverridesPatch,
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
  /** Merges one patch per group key in a single store update (the "Auto fills"/"Auto borders" buttons). */
  onGroupOverridesPatch: (patches: Record<string, TeleportGroupOverride>) => void;
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
    lineSizeAdaptation: P | null;
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
    floorBadgeSizeAdaptation: P | null;
    floorBadgeFillColor: P | null;
    floorBadgeBorderColor: P | null;
    floorBadgeTextColor: P | null;
    floorBadgeBorderWidth: P | null;
    floorBadgeCornerStyle: P | null;
    floorBadgeGapWidth: P | null;
    floorBadgeTextSize: P | null;
    floorBadgeTextMargin: P | null;
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
  // Expand state of the Teleports section's subsections — local and per mount, all collapsed by default.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setExpanded((c) => ({ ...c, [id]: !c[id] }));
  const { links } = useLinkContext<string>();
  const effectiveOverrides = useMemo(
    () => resolveGroupOverrides({ teleportMarker: settings.teleportMarker, links, teleportGroupOverrides: groupOverrides }),
    [settings.teleportMarker, links, groupOverrides],
  );
  // With group customization on, connectors and floor badges take each group's secondary (border) color.
  const groupSecondaryColorHint = m["image_export.vector_by_walls.teleport_group_secondary_color_hint"]();
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
      <SectionHeader label={m["image_export.vector_by_walls.teleport_subsection_edges"]()} expanded={expanded.markers} onToggle={() => toggle("markers")} />
      {expanded.markers && <div style={styles.subsection}>
        <MarkerAppearanceRows
          settings={settings.teleportMarker}
          onChange={patchMarker}
          linkTargets={{
            shape: linkTargets.lineShape,
            cornerStyle: linkTargets.lineCornerStyle,
            size: linkTargets.lineSize,
            sizeAdaptation: linkTargets.lineSizeAdaptation,
            fillColor: linkTargets.edgeColor,
            borderColor: linkTargets.edgeBorderColor,
            borderWidth: linkTargets.edgeBorderWidth,
            gapWidth: linkTargets.edgeGapWidth,
          }}
          priorityColors={{ fillColor: edgeColorPriority, borderColor: edgeBorderColorPriority }}
          defaultColors={{ fillColor: edgeColorDefault, borderColor: edgeBorderColorDefault }}
          fields={{ fillColor: edgeColorField, borderColor: edgeBorderColorField }}
        />
      </div>}

      <SectionHeader label={m["image_export.vector_by_walls.teleport_subsection_connector"]()} expanded={expanded.connector} onToggle={() => toggle("connector")} />
      {expanded.connector && <div style={styles.subsection}>
        <LinkedSelectRow
          label={m["image_export.vector_by_walls.teleport_connector_style"]()}
          value={settings.teleportConnectorStyle}
          options={[
            { value: "none" as TeleportConnectorStyle, label: m["image_export.vector_by_walls.teleport_connector_style_none"]() },
            { value: "straight" as TeleportConnectorStyle, label: m["image_export.vector_by_walls.teleport_connector_style_straight"]() },
            { value: "orthogonal" as TeleportConnectorStyle, label: m["image_export.vector_by_walls.teleport_connector_style_orthogonal"]() },
            { value: "curved" as TeleportConnectorStyle, label: m["image_export.vector_by_walls.teleport_connector_style_curved"]() },
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
        {settings.teleportConnectorStyle === "curved" && (<>
          <LinkedSelectRow
            label={m["image_export.vector_by_walls.teleport_curve_direction"]()}
            value={settings.teleportCurveDirection ?? "inward"}
            options={[
              { value: "inward" as TeleportCurveDirection, label: m["image_export.vector_by_walls.teleport_curve_direction_inward"]() },
              { value: "outward" as TeleportCurveDirection, label: m["image_export.vector_by_walls.teleport_curve_direction_outward"]() },
            ]}
            onChange={(v) => onChange({ teleportCurveDirection: v })}
            linkTarget={null}
          />
          <LinkedSliderRow
            label={m["image_export.vector_by_walls.teleport_curve_strength"]()}
            value={settings.teleportCurveStrength ?? 0.25}
            onChange={(v) => onChange({ teleportCurveStrength: v })}
            min={0}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            linkTarget={null}
          />
        </>)}

        {connectorShown && (<>
        <div style={styles.subsectionLabel}>{m["image_export.vector_by_walls.teleport_subsection_connector_body"]()}</div>
        <div style={styles.subsectionNested}>
          <LinkedColorRow label={m["image_export.vector_by_walls.teleport_connector_color"]()} color={settings.teleportConnectorColor} onChange={(v) => onChange({ teleportConnectorColor: v })} priorityColors={connectorColorPriority} defaultColor={connectorColorDefault} field={connectorColorField} linkTarget={linkTargets.connectorColor} disabled={settings.teleportGroupCustomization} disabledHint={groupSecondaryColorHint} />
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
      </div>}

      {hasCrossFloorTeleports && (
        <>
          <SectionHeader label={m["image_export.vector_by_walls.teleport_subsection_floor_badges"]()} expanded={expanded.floorBadges} onToggle={() => toggle("floorBadges")} />
          {expanded.floorBadges && <div style={styles.subsection}>
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
                sizeAdaptation: linkTargets.floorBadgeSizeAdaptation,
                fillColor: linkTargets.floorBadgeFillColor,
                borderColor: linkTargets.floorBadgeBorderColor,
                borderWidth: linkTargets.floorBadgeBorderWidth,
                gapWidth: linkTargets.floorBadgeGapWidth,
              }}
              priorityColors={{ fillColor: floorBadgeFillColorPriority, borderColor: floorBadgeBorderColorPriority }}
              defaultColors={{ fillColor: floorBadgeFillColorDefault, borderColor: floorBadgeBorderColorDefault }}
              fields={{ fillColor: floorBadgeFillColorField, borderColor: floorBadgeBorderColorField }}
              colorsDisabledHint={settings.teleportGroupCustomization ? groupSecondaryColorHint : undefined}
            />
            <TextStyleRows
              settings={settings.teleportFloorBadge}
              onChange={(patch) => onChange({ teleportFloorBadge: { ...settings.teleportFloorBadge, ...patch } })}
              linkTargets={{
                textFontWeight: linkTargets.floorBadgeTextFontWeight,
                textColor: linkTargets.floorBadgeTextColor,
                textSize: linkTargets.floorBadgeTextSize,
                textMargin: linkTargets.floorBadgeTextMargin,
              }}
              priorityColors={floorBadgeTextColorPriority}
              defaultColor={floorBadgeTextColorDefault}
              field={floorBadgeTextColorField}
              autoFitKind="teleport"
            />
          </div>}
        </>
      )}

      <SectionHeader label={m["image_export.vector_by_walls.teleport_group_customization"]()} expanded={expanded.groups} onToggle={() => toggle("groups")} />
      {expanded.groups && (
        <div style={styles.subsection}>
          <LinkedToggleRow
            label={m["image_export.vector_by_walls.teleport_group_customization_enable"]()}
            checked={settings.teleportGroupCustomization}
            onChange={(checked) => onChange({ teleportGroupCustomization: checked })}
            linkTarget={linkTargets.groupCustomization}
          />
          {settings.teleportGroupCustomization && teleportGroups.length > 0 && (
            <div style={styles.autoFillRow}>
              {(["fillColor", "borderColor"] as const).map((role) => (
                <Button
                  key={role}
                  variant="secondary"
                  layoutStyle={{ flex: 1 }}
                  onClick={(e) => {
                    const colors = distributeOklchHues(settings.teleportMarker[role], teleportGroups.length);
                    onGroupOverridesPatch(Object.fromEntries(teleportGroups.map((g, i) => [g.key, { [role]: colors[i] }])));
                    e.currentTarget.blur();
                  }}
                >
                  {role === "fillColor" ? m["image_export.vector_by_walls.teleport_group_auto_fill"]() : m["image_export.vector_by_walls.teleport_group_auto_border"]()}
                </Button>
              ))}
            </div>
          )}
          {settings.teleportGroupCustomization && teleportGroups.length > 0 && (() => {
            // Every group's own fill+border colors, computed once (GitHub issue #503 follow-up) —
            // each cell's own "other groups" priority list below is a slice of this shared array
            // rather than a fresh `PC.teleportGroup(...).at(...)` pass per cell.
            const allGroupColors: ProjectColorEntry[][] = teleportGroups.map((g, gi) => {
              const o = effectiveOverrides[g.key];
              return [
                PC.teleportGroup(gi, "fill").at(o?.fillColor ?? settings.teleportMarker.fillColor),
                PC.teleportGroup(gi, "border").at(o?.borderColor ?? settings.teleportMarker.borderColor),
              ];
            });
            return (
              <div style={styles.groupList}>
                {teleportGroups.map((group, i) => (
                  <TeleportGroupCell
                    key={group.key}
                    group={group}
                    index={i}
                    override={groupOverrides[group.key]}
                    effective={effectiveOverrides[group.key]}
                    links={links}
                    defaultShape={settings.teleportMarker.shape}
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
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  subsectionLabel: { ...typography.body },
  subsection: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  subsectionNested: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  autoFillRow: { display: "flex", flexDirection: "row", gap: spacing.itemGap },
  groupList: { display: "flex", flexDirection: "column", gap: spacing.itemGap, marginTop: spacing.itemGap },
  groupCell: {
    display: "flex", flexDirection: "column", gap: spacing.itemGap,
    padding: spacing.itemGap, borderRadius: 3, border: `1px solid ${ui.border.default}`,
  },
  // Links (left) and the group index + collision warning (right) share the card's first line.
  groupCellTop: { display: "flex", flexDirection: "row", alignItems: "flex-start", gap: spacing.itemGap },
  groupCellHeader: { display: "flex", flexDirection: "row", alignItems: "center", gap: spacing.itemGap, alignSelf: "flex-start", flexShrink: 0, padding: `${spacing.itemGap / 4}px 0` },
  // No gap between link rows: each row carries its own vertical padding so hover zones touch.
  groupCellLinks: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0 },
  groupCellLink: { display: "flex" },
  // Padding lives on the content-sized body, so it keeps the bubble highlight; the empty space to its right is the row itself and counts as the whole card.
  groupCellLinkBody: { padding: `${spacing.itemGap / 4}px 0` },
  groupCellControls: { display: "flex", flexDirection: "row", alignItems: "center", gap: spacing.itemGap },
  warningIcon: { display: "inline-flex", alignItems: "center", cursor: "default", width: 13 },
};
