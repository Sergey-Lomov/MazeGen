import { ArrowLeftRight, Settings, Trash2 } from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { type PresetConnectionEntry, type PresetElevatorEntry, type PresetTeleportEntry, type PresetVerticalPassageEntry } from "../../pixi/fieldEditUtils";
import { canonicalizePresetPair, presetEdgeKey, presetSplitPointKey } from "../../pixi/presetSplitResolve";
import type { PresetPointEntityDescriptor } from "../../pixi/pointEntities";
import { type PresetEndpoint } from "../../pixi/presetEndpoint";
import { presetTargetLabel, resolvePresetSplitShapeLabel, type PresetSplitLabelContext } from "../../pixi/presetSplitLabels";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { formatTargetLabel } from "../../pixi/targetLabel";
import { navigateToFloor } from "../../pixi/renderers/floorNavigation";
import type { NodeLockKind } from "../../wasm/types";
import { useLocale } from "../../i18n/useLocale";
import { indent, muted, radius, spacing, typography, ui } from "../../styles/theme";
import { SidePanel } from "../SidePanel";
import { SectionHeader } from "../SectionHeader";
import { SelectRow } from "../SelectRow";
import { ToolIconButton } from "../ToolIconButton";
import { Tooltip } from "../Tooltip";
import { Button } from "../Button";
import { ToolGlyph } from "./ToolGlyph";
import type { ToolGlyphKey } from "./toolGlyphs";
import * as m from "~/paraglide/messages";

export const PRESET_LIST_TYPES = [
  "wall", "passage", "undefined", "one_way", "start", "finish", "gen_source",
  "teleport", "vertical_passage_one_way", "vertical_passage_two_way", "elevator",
  "lock_in", "lock_out", "full_lock", "split",
] as const;

export type PresetListType = typeof PRESET_LIST_TYPES[number];
export type PresetListFloor = number | "all";

export const PRESET_LIST_TYPES_OFF_BY_DEFAULT = ["wall", "passage", "undefined"] as const;
const PRESET_LIST_TYPES_OFF_BY_DEFAULT_SET = new Set<PresetListType>(PRESET_LIST_TYPES_OFF_BY_DEFAULT);

interface PresetListFilterDefinition {
  type: PresetListType;
  glyph: ToolGlyphKey;
  label: string;
  multiFloorOnly?: boolean;
}

export interface PresetListFilters {
  types: ReadonlySet<PresetListType>;
  floor: PresetListFloor;
}

export interface PresetListBubble {
  text: string;
  endpoint: PresetEndpoint;
}

export type PresetListControl =
  | { kind: "direction"; id: string }
  | { kind: "elevator"; id: number; endpoint: PresetEndpoint }
  | { kind: "split"; endpoint: PresetEndpoint };

export interface PresetListCell {
  key: string;
  /** One filter is shared by one-way and two-way teleport rows. */
  type: PresetListType;
  title: string;
  id?: string;
  bubbles: PresetListBubble[];
  arrow?: "->" | "<-" | "<->";
  control?: PresetListControl;
  descriptor: PresetPointEntityDescriptor;
  link?: { from: PresetEndpoint; to: PresetEndpoint };
  linkHighlightStyle?: "boundary" | "one_way";
  entityHighlightMode?: "inset" | "outset";
}

export interface PresetListInput {
  presetConnections: Map<string, PresetConnectionEntry>;
  presetStart: PresetEndpoint | null;
  presetFinish: PresetEndpoint | null;
  presetGenSource: PresetEndpoint | null;
  presetTeleports: PresetTeleportEntry[];
  presetVerticalPassages: PresetVerticalPassageEntry[];
  presetElevators: PresetElevatorEntry[];
  lockedNodes: Map<string, NodeLockKind>;
  presetSplitPoints: Record<string, number[]>;
  presetSplitPointIds?: Record<string, string>;
  presetSplitShapeLabels?: Record<string, string>;
  presetEntityOrder?: string[];
  splitCtx?: PresetSplitLabelContext | null;
  multiFloor: boolean;
}

function endpointText(
  endpoint: PresetEndpoint,
  multiFloor: boolean,
  splitCtx: PresetSplitLabelContext | null | undefined,
): string {
  return splitCtx
    ? presetTargetLabel(splitCtx, endpoint, multiFloor)
    : formatTargetLabel(endpoint.point, endpoint.level ?? 0, multiFloor, undefined);
}

function bubble(
  endpoint: PresetEndpoint,
  multiFloor: boolean,
  splitCtx: PresetSplitLabelContext | null | undefined,
): PresetListBubble {
  return { text: endpointText(endpoint, multiFloor, splitCtx), endpoint };
}

function edgeTitle(state: PresetConnectionEntry["state"]): string {
  switch (state) {
    case "wall": return m["preset.wall"]();
    case "passage": return m["preset.passage"]();
    case "one_way_forward":
    case "one_way_backward": return m["preset.one_way"]();
    case "undefined": return m["preset.default_undefined"]();
  }
  return m["preset.default_undefined"]();
}

function edgeType(state: PresetConnectionEntry["state"]): PresetListType {
  switch (state) {
    case "wall": return "wall";
    case "passage": return "passage";
    case "one_way_forward":
    case "one_way_backward": return "one_way";
    case "undefined": return "undefined";
    case "teleport_forward":
    case "teleport_backward":
    case "teleport_two_way": return "teleport";
  }
}

function presetTypeLabel(type: PresetListType): string {
  switch (type) {
    case "wall": return m["preset.wall"]();
    case "passage": return m["preset.passage"]();
    case "undefined": return m["preset.default_undefined"]();
    case "one_way": return m["preset.one_way"]();
    case "start": return m["status.cell_start"]();
    case "finish": return m["status.cell_finish"]();
    case "gen_source": return m["status.cell_gen_source"]();
    case "teleport": return m["preset.list_filter_teleport"]();
    case "vertical_passage_one_way": return m["preset.vertical_passage_one_way"]();
    case "vertical_passage_two_way": return m["preset.vertical_passage_two_way"]();
    case "elevator": return m["preset.elevator"]();
    case "lock_in": return m["preset.lock_in"]();
    case "lock_out": return m["preset.lock_out"]();
    case "full_lock": return m["preset.full_lock"]();
    case "split": return m["preset.split"]();
  }
}

function presetListFilterDefinitions(): PresetListFilterDefinition[] {
  return PRESET_LIST_TYPES.map((type) => ({
    type,
    glyph: type === "undefined" ? "reset"
      : type === "start" ? "set_start"
      : type === "finish" ? "set_finish"
        : type === "split" ? "manage_split_nodes"
            : type === "teleport" ? "teleport_two_way"
            : type,
    label: presetTypeLabel(type),
    ...(type === "vertical_passage_one_way" || type === "vertical_passage_two_way" || type === "elevator"
      ? { multiFloorOnly: true }
      : {}),
  }));
}

function lockTitle(kind: NodeLockKind): string {
  const label = kind === "in"
    ? m["status.cell_lock_in"]()
    : kind === "out"
      ? m["status.cell_lock_out"]()
      : m["status.cell_lock_both"]();
  return m["status.cell_lock"]({ kind: label });
}

function edgeArrow(entry: PresetConnectionEntry): "->" | "<-" | "<->" {
  if (entry.state === "one_way_forward") return "->";
  if (entry.state === "one_way_backward") return "<-";
  return "<->";
}

function directedArrow(direction: "forward" | "backward" | "two_way"): "->" | "<-" | "<->" {
  return direction === "two_way" ? "<->" : direction === "forward" ? "->" : "<-";
}

function descriptor(kind: PresetPointEntityDescriptor["kind"], id: string, endpoint: PresetEndpoint, title: string): PresetPointEntityDescriptor {
  return { kind, id, endpoint, nodeIndex: 0, title };
}

/** Builds the complete user-authored preset list. Default-edge entries and auto-locks are derived
 * state, so they intentionally stay out of this list. The shape mirrors post-edit's event cells:
 * a title/id row and a coordinate-bubble/action row. */
export function buildPresetListCells(input: PresetListInput): PresetListCell[] {
  const { multiFloor } = input;
  const pointBubble = (endpoint: PresetEndpoint) => bubble(endpoint, multiFloor, input.splitCtx);
  const cells: PresetListCell[] = [];
  const add = (cell: PresetListCell) => cells.push(cell);
  const splitKeys = new Set(Object.entries(input.presetSplitPoints)
    .filter(([, slotIds]) => slotIds.length > 0)
    .map(([key]) => key));
  const touchesSplitPoint = (endpoint: PresetEndpoint) => splitKeys.has(presetSplitPointKey(endpoint.point, endpoint.level));

  for (const [key, entry] of input.presetConnections) {
    if (entry.source !== "user") continue;
    // A split tile is one authored entity. Its face-by-face records are implementation details of
    // that shape, not separate list rows (same contract as post-edit's split-point rows).
    if (touchesSplitPoint(entry.from) || touchesSplitPoint(entry.to)) continue;
    const title = edgeTitle(entry.state);
    const arrow = edgeArrow(entry);
    const [from, to] = canonicalizePresetPair(entry.from, entry.to);
    const edgeId = presetEdgeKey(from, to);
    add({
      key: `edge:${edgeId}`,
      type: edgeType(entry.state),
      title,
      bubbles: [pointBubble(entry.from), pointBubble(entry.to)],
      arrow,
      control: entry.state === "one_way_forward" || entry.state === "one_way_backward"
        ? { kind: "direction", id: key }
        : undefined,
      descriptor: descriptor("edge", key, entry.from, title),
      link: { from: entry.from, to: entry.to },
      linkHighlightStyle: entry.state === "wall" || entry.state === "passage" || entry.state === "undefined"
        ? "boundary"
        : entry.state === "one_way_forward" || entry.state === "one_way_backward" ? "one_way" : undefined,
    });
  }

  const addMarker = (key: string, id: string, title: string, endpoint: PresetEndpoint, kind: "start" | "finish" | "gen_source") => {
    add({
      key,
      type: kind,
      title,
      id,
      bubbles: [pointBubble(endpoint)],
      descriptor: descriptor(kind, key, endpoint, title),
    });
  };
  if (input.presetStart) addMarker("start", "s", m["status.cell_start"](), input.presetStart, "start");
  if (input.presetFinish) addMarker("finish", "f", m["status.cell_finish"](), input.presetFinish, "finish");
  if (input.presetGenSource) addMarker("gen_source", "gs", m["status.cell_gen_source"](), input.presetGenSource, "gen_source");

  for (const entry of input.presetTeleports) {
    const title = entry.direction === "two_way" ? m["preset.teleport_two_way"]() : m["preset.teleport_one_way"]();
    add({
      key: `teleport:${entry.id}`,
      type: "teleport",
      title,
      id: `t${entry.id}`,
      bubbles: [pointBubble(entry.from), pointBubble(entry.to)],
      arrow: directedArrow(entry.direction),
      control: entry.direction === "two_way" ? undefined : { kind: "direction", id: String(entry.id) },
      descriptor: descriptor("teleport", String(entry.id), entry.from, title),
    });
  }

  for (const entry of input.presetVerticalPassages) {
    const title = entry.direction === "two_way" ? m["preset.vertical_passage_two_way"]() : m["preset.vertical_passage_one_way"]();
    add({
      key: `vertical_passage:${entry.id}`,
      type: entry.direction === "two_way" ? "vertical_passage_two_way" : "vertical_passage_one_way",
      title,
      id: `v${entry.id}`,
      bubbles: [pointBubble(entry.from), pointBubble(entry.to)],
      arrow: directedArrow(entry.direction),
      control: entry.direction === "two_way" ? undefined : { kind: "direction", id: String(entry.id) },
      descriptor: descriptor("vertical_passage", String(entry.id), entry.from, title),
    });
  }

  for (const entry of input.presetElevators) {
    if (entry.floors.length === 0) continue;
    const title = m["preset.elevator"]();
    add({
      key: `elevator:${entry.id}`,
      type: "elevator",
      title,
      id: `e${entry.id}`,
      bubbles: entry.floors.map(pointBubble),
      control: { kind: "elevator", id: entry.id, endpoint: entry.floors[0] },
      descriptor: descriptor("elevator", String(entry.id), entry.floors[0], title),
    });
  }

  let lockIndex = 0;
  for (const [key, kind] of input.lockedNodes) {
    const endpoint = endpointFromKey(key);
    if (!endpoint) continue;
    const title = lockTitle(kind);
    add({
      key: `lock:${key}`,
      type: kind === "in" ? "lock_in" : kind === "out" ? "lock_out" : "full_lock",
      title,
      id: `l${++lockIndex}`,
      bubbles: [pointBubble(endpoint)],
      descriptor: descriptor("lock", `lock:${key}`, endpoint, title),
    });
  }

  for (const [key, slotIds] of Object.entries(input.presetSplitPoints)) {
    const endpoint = endpointFromKey(key);
    if (!endpoint || slotIds.length === 0) continue;
    const shapeLabel = input.presetSplitShapeLabels?.[key];
    const title = shapeLabel ? `${shapeLabel} (${m["preset.split"]()})` : m["preset.split_tile"]();
    add({
      key: `split:${key}`,
      type: "split",
      title,
      id: input.presetSplitPointIds?.[key] ?? `s${Object.keys(input.presetSplitPoints).indexOf(key) + 1}`,
      bubbles: [pointBubble(endpoint)],
      control: { kind: "split", endpoint },
      entityHighlightMode: "outset",
      descriptor: descriptor("split_node", `split:${key}`, endpoint, title),
    });
  }

  const order = new Map((input.presetEntityOrder ?? []).map((key, index) => [key, index]));
  cells.sort((a, b) => (order.get(b.key) ?? -1) - (order.get(a.key) ?? -1));
  return cells;
}

/** Returns cells matching both the selected preset types and floor. A multi-floor entity is
 * visible for every floor touched by one of its endpoint bubbles. */
export function filterPresetListCells(cells: PresetListCell[], filters: PresetListFilters): PresetListCell[] {
  return cells.filter((cell) => {
    if (!filters.types.has(cell.type)) return false;
    if (filters.floor === "all") return true;
    return cell.bubbles.some(({ endpoint }) => (endpoint.level ?? 0) === filters.floor);
  });
}

function endpointFromKey(key: string): PresetEndpoint | null {
  const [pointPart, levelPart] = key.split("@");
  const [pointOnly, slotPart] = pointPart.split(":");
  const [x, y] = pointOnly.split(",").map(Number);
  const slotId = slotPart === undefined ? undefined : Number(slotPart);
  const level = levelPart === undefined ? undefined : Number(levelPart);
  if (![x, y, slotId, level].every((value) => value === undefined || Number.isInteger(value))) return null;
  return { point: [x, y], ...(slotId === undefined ? {} : { slotId }), ...(level === undefined ? {} : { level }) };
}

export function PresetList({ onClose }: { onClose: () => void }) {
  const { locale } = useLocale();
  const presetConnections = useMazeStore((s) => s.presetConnections);
  const presetStart = useMazeStore((s) => s.presetStart);
  const presetFinish = useMazeStore((s) => s.presetFinish);
  const presetGenSource = useMazeStore((s) => s.presetGenSource);
  const presetTeleports = useMazeStore((s) => s.presetTeleports);
  const presetVerticalPassages = useMazeStore((s) => s.presetVerticalPassages);
  const presetElevators = useMazeStore((s) => s.presetElevators);
  const lockedNodes = useMazeStore((s) => s.lockedNodes);
  const presetSplitPoints = useMazeStore((s) => s.presetSplitPoints);
  const presetSplitPointIds = useMazeStore((s) => s.presetSplitPointIds);
  const presetEntityOrder = useMazeStore((s) => s.presetEntityOrder);
  const activeSplitNode = useMazeStore((s) => s.presetActiveSplitNode);
  const floorFields = useMazeStore((s) => s.floorFields);
  const floors = useMazeStore((s) => s.floors);
  const cyclePresetConnectionDirection = useMazeStore((s) => s.cyclePresetConnectionDirection);
  const cyclePresetTeleportDirection = useMazeStore((s) => s.cyclePresetTeleportDirection);
  const cyclePresetVerticalPassageDirection = useMazeStore((s) => s.cyclePresetVerticalPassageDirection);
  const editPresetElevator = useMazeStore((s) => s.editPresetElevator);
  const removePresetPointEntity = useMazeStore((s) => s.removePresetPointEntity);
  const setPresetHoveredLink = useMazeStore((s) => s.setPresetHoveredLink);
  const setPresetHoveredEntity = useMazeStore((s) => s.setPresetHoveredEntity);
  const setPresetFocusedPoint = useMazeStore((s) => s.setPresetFocusedPoint);
  const [filtersExpanded, setFiltersExpanded] = useState(true);
  const filterDefinitions = useMemo(() => presetListFilterDefinitions(), [locale]);
  const [selectedTypes, setSelectedTypes] = useState<Set<PresetListType>>(
    () => new Set(PRESET_LIST_TYPES.filter((type) => !PRESET_LIST_TYPES_OFF_BY_DEFAULT_SET.has(type))),
  );
  const [floorFilter, setFloorFilter] = useState<PresetListFloor>("all");
  const splitLabelContext = useMemo<PresetSplitLabelContext | null>(() => {
    const fallbackField = floors[0] ? floorFields[floors[0].id] : undefined;
    if (!fallbackField) return null;
    return {
      splitPoints: presetSplitPoints,
      presetConnections,
      activeSplitNode,
      cfgAt: (level) => floorFields[floors[level]?.id]?.fieldConfig ?? fallbackField.fieldConfig,
      inFieldCellsAt: (level) => {
        const field = floorFields[floors[level]?.id] ?? fallbackField;
        return buildCellSet(buildActiveCells(field.fieldPoints, field.fieldEditMode, field.fieldConfig));
      },
    };
  }, [presetSplitPoints, presetConnections, activeSplitNode, floorFields, floors]);
  const presetSplitShapeLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    if (!splitLabelContext) return labels;
    for (const key of Object.keys(presetSplitPoints)) {
      const endpoint = endpointFromKey(key);
      if (!endpoint) continue;
      const label = resolvePresetSplitShapeLabel(splitLabelContext, endpoint.point, endpoint.level ?? 0);
      if (label && label !== m["preset.split_tile"]()) labels[key] = label;
    }
    return labels;
  }, [presetSplitPoints, splitLabelContext, locale]);
  const cells = useMemo(() => buildPresetListCells({
    presetConnections, presetStart, presetFinish, presetGenSource, presetTeleports,
    presetVerticalPassages, presetElevators, lockedNodes, presetSplitPoints,
    presetSplitPointIds,
    presetSplitShapeLabels,
    presetEntityOrder,
    splitCtx: splitLabelContext,
    multiFloor: floors.length > 1,
  }), [presetConnections, presetStart, presetFinish, presetGenSource, presetTeleports, presetVerticalPassages, presetElevators, lockedNodes, presetSplitPoints, presetSplitPointIds, presetSplitShapeLabels, presetEntityOrder, splitLabelContext, floors.length]);
  const visibleCells = useMemo(
    () => filterPresetListCells(cells, { types: selectedTypes, floor: floorFilter }),
    [cells, selectedTypes, floorFilter],
  );
  const visibleFilterDefinitions = floors.length > 1
    ? filterDefinitions
    : filterDefinitions.filter((definition) => !definition.multiFloorOnly);
  const activeFilterCount = visibleFilterDefinitions.filter((definition) => selectedTypes.has(definition.type)).length;
  const toggleType = (type: PresetListType) => {
    setSelectedTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };
  const enableAllTypes = () => setSelectedTypes(new Set(PRESET_LIST_TYPES));
  const disableAllTypes = () => setSelectedTypes(new Set());

  const cycleDirection = (cell: PresetListCell) => {
    if (!cell.control || cell.control.kind !== "direction") return;
    if (cell.key.startsWith("edge:")) cyclePresetConnectionDirection(cell.control.id);
    else if (cell.key.startsWith("teleport:")) cyclePresetTeleportDirection(Number(cell.control.id));
    else cyclePresetVerticalPassageDirection(Number(cell.control.id));
  };

  return (
    <SidePanel title={m["preset.list"]()} stackKey="preset-list" onClose={onClose}>
      <div style={styles.filterSection}>
        <SectionHeader
          label={m["preset.list_filters"]({ active: activeFilterCount, total: visibleFilterDefinitions.length })}
          expanded={filtersExpanded}
          onToggle={() => setFiltersExpanded((expanded) => !expanded)}
        />
        {filtersExpanded && (
          <div style={styles.filterContent}>
            <div style={styles.filterIcons}>
              {visibleFilterDefinitions.map((definition) => (
                <ToolIconButton
                  key={definition.type}
                  selected={selectedTypes.has(definition.type)}
                  title={definition.label}
                  onClick={() => toggleType(definition.type)}
                >
                  <ToolGlyph tool={definition.glyph} />
                </ToolIconButton>
              ))}
            </div>
            <div style={styles.filterActions}>
              <Button variant="secondary" layoutStyle={{ flex: 1 }} onClick={enableAllTypes}>
                {m["preset.list_filter_enable_all"]()}
              </Button>
              <Button variant="secondary" layoutStyle={{ flex: 1 }} onClick={disableAllTypes}>
                {m["preset.list_filter_disable_all"]()}
              </Button>
            </div>
            {floors.length > 1 && (
              <SelectRow
                label={m["preset.list_filter_floor"]()}
                value={floorFilter === "all" ? "all" : String(floorFilter)}
                options={[
                  { value: "all", label: m["preset.list_all_floors"]() },
                  ...floors.map((floor, level) => ({ value: String(level), label: floor.title })),
                ]}
                onChange={(value) => setFloorFilter(value === "all" ? "all" : Number(value))}
                selectStyle={{ minWidth: 0 }}
              />
            )}
          </div>
        )}
      </div>
      <div style={styles.filterDivider} />
      <div style={styles.listSection}>
        {visibleCells.length === 0 ? (
          <div style={styles.empty}>{cells.length === 0 ? m["preset.list_empty"]() : m["preset.list_filter_empty"]()}</div>
        ) : (
          <div style={styles.list}>
            {visibleCells.map((cell) => <PresetCell
              key={cell.key}
              cell={cell}
              onCycleDirection={() => cycleDirection(cell)}
              onEditElevator={() => cell.control?.kind === "elevator" && editPresetElevator(cell.control.id, cell.control.endpoint)}
              onEditSplit={() => {
                if (cell.control?.kind !== "split") return;
                navigateToFloor(cell.control.endpoint.level ?? 0);
                setPresetFocusedPoint(cell.control.endpoint.point);
              }}
              onDelete={() => removePresetPointEntity(cell.descriptor)}
              onHoverCell={() => {
                if (cell.link) {
                  setPresetHoveredLink({ ...cell.link, highlightStyle: cell.linkHighlightStyle });
                  setPresetHoveredEntity(null);
                } else {
                  setPresetHoveredLink(null);
                  setPresetHoveredEntity(cell.bubbles.map((item) => item.endpoint), cell.entityHighlightMode);
                }
              }}
              onHoverBubble={(bubble) => {
                setPresetHoveredLink(null);
                setPresetHoveredEntity([bubble.endpoint], cell.entityHighlightMode);
              }}
              onLeave={() => { setPresetHoveredLink(null); setPresetHoveredEntity(null); }}
            />)}
          </div>
        )}
      </div>
    </SidePanel>
  );
}

function PresetCell({
  cell, onCycleDirection, onEditElevator, onEditSplit, onDelete, onHoverCell, onHoverBubble, onLeave,
}: {
  cell: PresetListCell;
  onCycleDirection: () => void;
  onEditElevator: () => void;
  onEditSplit: () => void;
  onDelete: () => void;
  onHoverCell: () => void;
  onHoverBubble: (bubble: PresetListBubble) => void;
  onLeave: () => void;
}) {
  type ActionKind = "direction" | "settings" | "delete";

  const actionButton = (kind: ActionKind, title: string, onAction: () => void, child: React.ReactNode, danger = false) => (
    <Tooltip content={title}><button
      type="button"
      data-testid={`preset-action-${kind}`}
      data-preset-key={cell.key}
      className="hoverable"
      style={{ ...styles.iconButton, ...(danger ? { color: ui.text.error } : {}) }}
      aria-label={title}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        // Mouse/touch activation happens here so it cannot depend on a later click event after a
        // list re-render. Keyboard activation still comes through click below.
        onAction();
      }}
      onClick={(event) => {
        if (event.detail === 0) onAction();
      }}
    >
      {child}
    </button></Tooltip>
  );

  return (
    <div
      data-testid="preset-cell"
      data-preset-id={cell.id}
      style={styles.cell}
      onMouseEnter={onHoverCell}
      onMouseLeave={onLeave}
    >
      <div style={styles.titleRow}>
        <span style={styles.title}>{cell.title}</span>
        {cell.id !== undefined && <span style={styles.idBubble}>id: {cell.id}</span>}
      </div>
      <div style={styles.detailsRow}>
        <div style={styles.bubbles}>
          {cell.bubbles.map((item, index) => (
            <span key={`${item.text}:${index}`} style={styles.bubbleGroup}>
              {index > 0 && cell.arrow && <span style={styles.arrow}>{cell.arrow}</span>}
              <span
                className="hoverable"
                style={styles.bubble}
                onMouseEnter={() => onHoverBubble(item)}
                onMouseLeave={onHoverCell}
                onClick={() => navigateToFloor(item.endpoint.level ?? 0)}
              >
                {item.text}
              </span>
            </span>
          ))}
        </div>
        <div style={styles.actions}>
          {cell.control?.kind === "direction" && (
            actionButton("direction", m["preset.list_toggle_direction"](), onCycleDirection, <ArrowLeftRight size={16} style={styles.iconGlyph} />)
          )}
          {cell.control?.kind === "elevator" && (
            actionButton("settings", m["preset.list_edit_elevator"](), onEditElevator, <Settings size={16} style={styles.iconGlyph} />)
          )}
          {cell.control?.kind === "split" && (
            actionButton("settings", m["preset.list_edit_split"](), onEditSplit, <Settings size={16} style={styles.iconGlyph} />)
          )}
          {actionButton("delete", m["preset.list_delete"](), onDelete, <Trash2 size={16} style={styles.iconGlyph} />, true)}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // Keep the first interactive area away from the SidePanel header/body boundary. SectionHeader
  // has a small negative vertical margin for use inside ordinary sections; this extra inset keeps
  // its hit box and the first icon row fully inside the panel body.
  filterSection: { position: "relative", zIndex: 1, flexShrink: 0, padding: `${spacing.groupGap}px ${spacing.groupGap}px ${spacing.groupGap}px` },
  filterContent: { display: "flex", flexDirection: "column", gap: spacing.groupGap, paddingTop: spacing.groupGap, paddingLeft: indent.tree },
  filterIcons: { display: "flex", flexWrap: "wrap", gap: spacing.itemGap },
  filterActions: { display: "flex", gap: spacing.itemGap },
  filterDivider: { borderTop: `1px solid ${ui.border.default}`, flexShrink: 0 },
  // Keep the first interactive row clear of the SidePanel header/body boundary. The top row was
  // hit-tested unreliably while rows below it worked; the inset also keeps the list's action layer
  // away from that boundary without changing the action button's own hit box.
  listSection: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingTop: spacing.itemGap },
  sectionLabel: { ...typography.body },
  list: { display: "flex", flexDirection: "column" },
  cell: {
    display: "flex", flexDirection: "column", gap: spacing.itemGap / 2,
    padding: `${spacing.itemGap}px ${spacing.groupGap}px`,
    borderBottom: `1px solid ${ui.border.default}`,
  },
  titleRow: { display: "flex", alignItems: "center", gap: spacing.itemGap, minWidth: 0 },
  title: { ...typography.body, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  idBubble: {
    ...typography.caption,
    marginLeft: "auto",
    fontFamily: "Consolas, Menlo, Monaco, monospace",
    display: "inline-flex",
    alignItems: "center",
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: `0 ${spacing.itemGap}px`,
    background: ui.bg.success,
    borderColor: ui.text.success,
    color: ui.text.success,
    whiteSpace: "nowrap",
  },
  detailsRow: { display: "flex", alignItems: "center", gap: spacing.itemGap, minWidth: 0 },
  bubbles: { flex: "1 1 auto", display: "flex", flexWrap: "wrap", alignItems: "center", gap: spacing.itemGap / 2, minWidth: 0, pointerEvents: "none" },
  bubbleGroup: { display: "inline-flex", alignItems: "center", gap: spacing.itemGap / 2 },
  bubble: {
    ...typography.caption, fontFamily: "Consolas, Menlo, Monaco, monospace", display: "inline-flex",
    alignItems: "center", borderStyle: "solid", borderWidth: 1, borderRadius: radius.lg,
    padding: `0 ${spacing.itemGap}px`, background: ui.debug.refHighlight.bg,
    borderColor: ui.debug.refHighlight.text, color: ui.debug.refHighlight.text, pointerEvents: "auto",
    whiteSpace: "nowrap", cursor: "pointer",
  },
  arrow: muted(typography.caption),
  actions: { position: "relative", zIndex: 1, display: "flex", alignItems: "center", gap: spacing.itemGap, marginLeft: "auto", flexShrink: 0 },
  iconButton: {
    ...typography.icon,
    width: 22,
    height: 22,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: "none",
    background: "none",
    color: ui.text.tertiary,
    lineHeight: 1,
    cursor: "default",
    flexShrink: 0,
  },
  iconGlyph: { pointerEvents: "none" },
  empty: { ...muted(typography.body), padding: `${spacing.itemGap}px ${spacing.groupGap}px` },
};
