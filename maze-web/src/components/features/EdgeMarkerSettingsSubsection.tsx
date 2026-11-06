import type React from "react";
import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import type { EdgeMarkerOverride, EdgeMarkerRole, EdgeMarkerStyle } from "../../store/imageExportTypes";
import type { MarkerShape } from "../../pixi/renderers/types";
import type { ParamDescriptor } from "../../store/parameterLinks";
import { useMazeStore } from "../../store/mazeStore";
import { buildEdgeMarkerLinks, isMarkerRoleLinked, markerRolePath, withResolvedEdgeMarkers } from "../../store/edgeMarkerLinks";
import { indent, spacing, typography, ui } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import { EDGE_MARKER_SIZE_RANGE } from "../../pixi/renderConstants";
import { edgeMarkerKeys, edgeMarkerLook, edgeMarkerLooksAlike, selectExportEdgeMarkers } from "../../pixi/imageExport/edgeMarkerExport";
import { PC, type ColorField, type ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import { distributeHueGroups } from "../../store/colorMath";
import { useLocale } from "../../i18n/useLocale";
import { ColorSwatch } from "../ColorSwatch";
import { LinkStatusIcon } from "../LinkStatusIcon";
import { SectionHeader } from "../SectionHeader";
import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
import { Button } from "../Button";
import { Tooltip } from "../Tooltip";
import { LinkedColorRow, LinkedSelectRow } from "./LinkedRows";
import { useGate, useLinkContext } from "./LinkContext";
import { MARKER_SHAPE_OPTIONS, markerShapeSelectOptions } from "./MarkerFieldRows";
import * as m from "~/paraglide/messages";

/** The title of a marker's card, from its key (`g<glue>` / `c<crease>`); numbered from 1. */
function markerLabel(key: string): string {
  const number = String(Number(key.slice(1)) + 1);
  return key.startsWith("c") ? m["image_export.edge_markers.crease_marker"]({ id: number }) : m["image_export.edge_markers.glue_marker"]({ glue: number });
}

/** One marker's card, the model of the teleport group's cell: its shape and colour, each with a link icon that shows whether
 *  the value follows the shared one (through the parameter links) or is the marker's own. Clicking the icon breaks the link
 *  (keeping the current look as the marker's own value) or restores it. */
function EdgeMarkerCell({ markerKey, index, colorField, override, shape, color, hasCollision, onChange, priorityColors }: {
  markerKey: string;
  /** 0-based order among the shown markers. */
  index: number;
  /** The marker's own project colour field, or undefined while it has no colour of its own. */
  colorField: ColorField | undefined;
  override: EdgeMarkerOverride | undefined;
  shape: MarkerShape;
  color: number;
  hasCollision: boolean;
  onChange: (patch: EdgeMarkerOverride) => void;
  priorityColors: ProjectColorEntry[];
}) {
  const { links, registry } = useLinkContext<string>();
  const { locale } = useLocale();
  const markerLinks = useMemo(() => buildEdgeMarkerLinks(links, override), [links, override]);
  // Virtual registry: the marker's own role parameters, labelled after the shared ones, so the icon's tooltip names
  // "<Marker> / <parameter>" for a rebound source.
  const markerRegistry = useMemo(() => {
    const name = markerLabel(markerKey);
    const reg: Record<string, ParamDescriptor> = { ...registry };
    for (const role of ["shape", "color"] as const) {
      const shared = registry[`edgeMarkers.${role}`];
      if (shared) reg[markerRolePath(role)] = { ...shared, group: [name] };
    }
    return reg;
    // `locale`: the copied labels/groups are resolved at spread time (GitHub issue #742).
  }, [registry, markerKey, locale]);
  const noop = () => {};
  const activePaths = useMemo(() => new Set<string>(), []);
  const linkToggle = (role: EdgeMarkerRole, current: number | MarkerShape) => (
    <LinkStatusIcon
      target={markerRolePath(role)}
      links={markerLinks}
      registry={markerRegistry}
      onSetLinkEnabled={noop}
      onAddLink={noop}
      activePaths={activePaths}
      // Break keeps the current look as an explicit value; restore clears it so the link takes over again.
      alwaysVisible
      onToggleLink={() => onChange({ [role]: isMarkerRoleLinked(override, role) ? current : undefined })}
    />
  );
  return (
    <div style={styles.cell}>
      <div style={styles.cellTop}>
        <span style={{ ...typography.body, color: ui.text.secondary, flex: 1, minWidth: 0 }}>{markerLabel(markerKey)}</span>
        <div style={styles.cellHeader}>
          <Tooltip content={hasCollision ? m["image_export.edge_markers.collision"]() : undefined}><span style={styles.warningIcon}>
            {hasCollision && <AlertTriangle size={13} color={ui.text.warning} />}
          </span></Tooltip>
        </div>
      </div>
      <div style={styles.cellControls}>
        <select
          name={`edge-marker-${index}-shape`}
          style={sharedStyles.selectSm}
          value={shape}
          onChange={(e) => onChange({ shape: e.target.value as MarkerShape })}
        >
          {MARKER_SHAPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label()}</option>
          ))}
        </select>
        {linkToggle("shape", shape)}
        <ColorSwatch
          color={color}
          onChange={(c) => onChange({ color: c })}
          priorityColors={priorityColors}
          field={colorField}
          fallbackName={markerLabel(markerKey)}
        />
        {linkToggle("color", color)}
      </div>
    </div>
  );
}

/** The "Edge alignment markers" subsection of the "Topology" section (GitHub issue #902): which markers show on the image,
 *  and the shape and colour of each. The shared shape and colour are linkable parameters the marker cards follow by default
 *  (the model of the teleport groups' customization); a card's link icon breaks that for one marker. The parent shows it
 *  only for a floor that has glues or creases. Both render modes use it as is. */
export function EdgeMarkerSettingsSubsection({ expanded, onToggle, style, defaultColor, priorityColors, onChange, onOverride, onOverrides }: {
  expanded: boolean;
  onToggle: () => void;
  style: EdgeMarkerStyle;
  defaultColor: number;
  priorityColors: ProjectColorEntry[];
  onChange: (patch: Partial<Omit<EdgeMarkerStyle, "overrides">>) => void;
  onOverride: (floorId: string, key: string, patch: EdgeMarkerOverride | null) => void;
  /** Several markers of the floor at once. */
  onOverrides: (floorId: string, patches: Record<string, EdgeMarkerOverride | null>) => void;
}) {
  const { links } = useLinkContext<string>();
  const markersShown = useGate("edgeMarkers");
  const activeFloorId = useMazeStore((s) => s.activeFloorId);
  const activeFieldConfig = useMazeStore((s) => s.activeFieldConfig);
  const floorTopology = useMazeStore((s) => s.floorTopology);
  const floorCreases = useMazeStore((s) => s.floorCreases);
  const pngExportSettings = useMazeStore((s) => s.pngExportSettings);
  const nodes = useMazeStore((s) => s.nodes);
  const floors = useMazeStore((s) => s.floors);
  const keys = useMemo(
    () => edgeMarkerKeys(selectExportEdgeMarkers({ activeFloorId, activeFieldConfig, floorTopology, floorCreases, pngExportSettings, nodes, floors }, { mode: style.mode })),
    [activeFloorId, activeFieldConfig, floorTopology, floorCreases, pngExportSettings, nodes, floors, style.mode],
  );
  const level = useMemo(() => floors.findIndex((floor) => floor.id === activeFloorId), [floors, activeFloorId]);
  const resolved = useMemo(() => withResolvedEdgeMarkers(style, links, activeFloorId), [style, links, activeFloorId]);
  // The colour field of a marker that has a colour of its own.
  const fieldOf = (key: string): ColorField | undefined => (style.overrides[activeFloorId]?.[key]?.color !== undefined ? PC.edgeMarkerAt(activeFloorId, key, level, floors.length) : undefined);
  const looks = keys.map((key) => edgeMarkerLook(resolved, key));
  const shapeOptions = markerShapeSelectOptions();
  return (
    <>
      <SectionHeader label={m["image_export.edge_markers.title"]()} expanded={expanded} onToggle={onToggle} />
      {expanded && (
        <div style={styles.block}>
          <SelectRow
            label={m["image_export.edge_markers.mode"]()}
            value={style.mode}
            options={[
              { value: "hidden", label: m["image_export.edge_markers.mode_hidden"]() },
              { value: "gluings", label: m["image_export.edge_markers.mode_gluings"]() },
              { value: "all", label: m["image_export.edge_markers.mode_all"]() },
            ]}
            onChange={(mode) => onChange({ mode })}
          />
          {markersShown && (
            <>
              <SliderRow label={m["image_export.edge_markers.size"]()} value={style.size} onChange={(size) => onChange({ size })} min={EDGE_MARKER_SIZE_RANGE.min} max={EDGE_MARKER_SIZE_RANGE.max} step={1} format={(v) => String(v)} />
              <LinkedSelectRow label={m["image_export.edge_markers.shape"]()} value={style.shape} options={shapeOptions} onChange={(shape) => onChange({ shape })} linkTarget="edgeMarkers.shape" />
              <LinkedColorRow label={m["image_export.edge_markers.color"]()} color={style.color} onChange={(color) => onChange({ color })} priorityColors={priorityColors} defaultColor={defaultColor} field={PC.edgeMarker} linkTarget="edgeMarkers.color" />
              {keys.length > 0 && (
                <Button
                  variant="secondary"
                  onClick={(e) => {
                    // One-off: the shared colour spread by hue over the markers, each set as the marker's own colour.
                    const colors = distributeHueGroups(resolved.color, keys.length);
                    onOverrides(activeFloorId, Object.fromEntries(keys.map((key, i) => [key, { color: colors[i] }])));
                    e.currentTarget.blur();
                  }}
                >
                  {m["image_export.edge_markers.auto_colors"]()}
                </Button>
              )}
              <div style={styles.list}>
                {keys.map((key, i) => {
                  const others = keys.flatMap((other, j) => {
                    const field = j !== i ? fieldOf(other) : undefined;
                    return field ? [field.at(looks[j].color)] : [];
                  });
                  return (
                    <EdgeMarkerCell
                      // Keyed by floor too: marker keys repeat from floor to floor, so a card (and the colour picker open in it) must not carry over to the
                      // same key on another floor, where its edits would land on that floor's marker.
                      key={`${activeFloorId}:${key}`}
                      markerKey={key}
                      index={i}
                      colorField={fieldOf(key)}
                      override={style.overrides[activeFloorId]?.[key]}
                      shape={looks[i].shape}
                      color={looks[i].color}
                      hasCollision={looks.some((other, j) => j !== i && edgeMarkerLooksAlike(other, looks[i]))}
                      onChange={(patch) => onOverride(activeFloorId, key, patch)}
                      priorityColors={[...others, ...priorityColors]}
                    />
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  list: { display: "flex", flexDirection: "column", gap: spacing.itemGap, marginTop: spacing.itemGap },
  cell: {
    display: "flex", flexDirection: "column", gap: spacing.itemGap,
    padding: spacing.itemGap, borderRadius: 3, border: `1px solid ${ui.border.default}`,
  },
  cellTop: { display: "flex", flexDirection: "row", alignItems: "center", gap: spacing.itemGap },
  cellHeader: { display: "flex", flexDirection: "row", alignItems: "center", gap: spacing.itemGap, flexShrink: 0 },
  cellControls: { display: "flex", flexDirection: "row", alignItems: "center", gap: spacing.itemGap },
  warningIcon: { display: "inline-flex", alignItems: "center", cursor: "default", width: 13 },
};
