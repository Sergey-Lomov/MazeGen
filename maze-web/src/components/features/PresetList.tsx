import { ArrowLeftRight, Settings, Trash2 } from "lucide-react";
import type React from "react";
import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import {
  canonicalizePresetPair,
  presetEdgeKey,
  presetSplitPointKey,
  type PresetConnectionEntry,
  type PresetElevatorEntry,
  type PresetTeleportEntry,
  type PresetVerticalPassageEntry,
} from "../../pixi/fieldEditUtils";
import type { PresetPointEntityDescriptor } from "../../pixi/pointEntities";
import { type PresetEndpoint } from "../../pixi/presetEndpoint";
import { resolvePresetSplitShapeLabel, type PresetSplitLabelContext } from "../../pixi/presetSplitLabels";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { formatTargetLabel } from "../../pixi/targetLabel";
import { navigateToFloor } from "../../pixi/renderers/floorNavigation";
import type { NodeLockKind } from "../../wasm/types";
import { muted, radius, spacing, typography, ui } from "../../styles/theme";
import { SidePanel } from "../SidePanel";
import * as m from "~/paraglide/messages";

export interface PresetListBubble {
  text: string;
  endpoint: PresetEndpoint;
}

export type PresetListControl =
  | { kind: "direction"; id: string }
  | { kind: "elevator"; endpoint: PresetEndpoint }
  | { kind: "split"; endpoint: PresetEndpoint };

export interface PresetListCell {
  key: string;
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
  multiFloor: boolean;
}

function endpointText(endpoint: PresetEndpoint, multiFloor: boolean): string {
  const splitLabel = endpoint.slotId === undefined ? undefined : `N${endpoint.slotId + 2}`;
  return formatTargetLabel(endpoint.point, endpoint.level ?? 0, multiFloor, splitLabel);
}

function bubble(endpoint: PresetEndpoint, multiFloor: boolean): PresetListBubble {
  return { text: endpointText(endpoint, multiFloor), endpoint };
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
      title,
      bubbles: [bubble(entry.from, multiFloor), bubble(entry.to, multiFloor)],
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
      title,
      id,
      bubbles: [bubble(endpoint, multiFloor)],
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
      title,
      id: `t${entry.id}`,
      bubbles: [bubble(entry.from, multiFloor), bubble(entry.to, multiFloor)],
      arrow: directedArrow(entry.direction),
      control: entry.direction === "two_way" ? undefined : { kind: "direction", id: String(entry.id) },
      descriptor: descriptor("teleport", String(entry.id), entry.from, title),
    });
  }

  for (const entry of input.presetVerticalPassages) {
    const title = entry.direction === "two_way" ? m["preset.vertical_passage_two_way"]() : m["preset.vertical_passage_one_way"]();
    add({
      key: `vertical_passage:${entry.id}`,
      title,
      id: `v${entry.id}`,
      bubbles: [bubble(entry.from, multiFloor), bubble(entry.to, multiFloor)],
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
      title,
      id: `e${entry.id}`,
      bubbles: entry.floors.map((endpoint) => bubble(endpoint, multiFloor)),
      control: { kind: "elevator", endpoint: entry.floors[0] },
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
      title,
      id: `l${++lockIndex}`,
      bubbles: [bubble(endpoint, multiFloor)],
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
      title,
      id: input.presetSplitPointIds?.[key] ?? `s${Object.keys(input.presetSplitPoints).indexOf(key) + 1}`,
      bubbles: [bubble(endpoint, multiFloor)],
      control: { kind: "split", endpoint },
      entityHighlightMode: "outset",
      descriptor: descriptor("split_node", `split:${key}`, endpoint, title),
    });
  }

  const order = new Map((input.presetEntityOrder ?? []).map((key, index) => [key, index]));
  cells.sort((a, b) => (order.get(b.key) ?? -1) - (order.get(a.key) ?? -1));
  return cells;
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
  const startPresetElevatorPlacement = useMazeStore((s) => s.startPresetElevatorPlacement);
  const removePresetPointEntity = useMazeStore((s) => s.removePresetPointEntity);
  const setPresetHoveredLink = useMazeStore((s) => s.setPresetHoveredLink);
  const setPresetHoveredEntity = useMazeStore((s) => s.setPresetHoveredEntity);
  const setPresetFocusedPoint = useMazeStore((s) => s.setPresetFocusedPoint);
  const presetSplitShapeLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    const fallbackField = floors[0] ? floorFields[floors[0].id] : undefined;
    if (!fallbackField) return labels;
    const splitLabelContext: PresetSplitLabelContext = {
      splitPoints: presetSplitPoints,
      presetConnections,
      activeSplitNode,
      cfgAt: (level) => floorFields[floors[level]?.id]?.tessellationConfig ?? fallbackField.tessellationConfig,
      inFieldCellsAt: (level) => {
        const field = floorFields[floors[level]?.id] ?? fallbackField;
        return buildCellSet(buildActiveCells(field.fieldPoints, field.fieldEditMode, field.tessellationConfig));
      },
    };
    for (const key of Object.keys(presetSplitPoints)) {
      const endpoint = endpointFromKey(key);
      if (!endpoint) continue;
      const label = resolvePresetSplitShapeLabel(splitLabelContext, endpoint.point, endpoint.level ?? 0);
      if (label && label !== m["preset.split_tile"]()) labels[key] = label;
    }
    return labels;
  }, [presetSplitPoints, presetConnections, activeSplitNode, floorFields, floors]);
  const cells = useMemo(() => buildPresetListCells({
    presetConnections, presetStart, presetFinish, presetGenSource, presetTeleports,
    presetVerticalPassages, presetElevators, lockedNodes, presetSplitPoints,
    presetSplitPointIds,
    presetSplitShapeLabels,
    presetEntityOrder,
    multiFloor: floors.length > 1,
  }), [presetConnections, presetStart, presetFinish, presetGenSource, presetTeleports, presetVerticalPassages, presetElevators, lockedNodes, presetSplitPoints, presetSplitPointIds, presetSplitShapeLabels, presetEntityOrder, floors.length]);

  const cycleDirection = (cell: PresetListCell) => {
    if (!cell.control || cell.control.kind !== "direction") return;
    if (cell.key.startsWith("edge:")) cyclePresetConnectionDirection(cell.control.id);
    else if (cell.key.startsWith("teleport:")) cyclePresetTeleportDirection(Number(cell.control.id));
    else cyclePresetVerticalPassageDirection(Number(cell.control.id));
  };

  return (
    <SidePanel title={m["preset.list"]()} onClose={onClose}>
      <div style={styles.listSection}>
        {cells.length === 0 ? (
          <div style={styles.empty}>{m["preset.list_empty"]()}</div>
        ) : (
          <div style={styles.list}>
            {cells.map((cell) => <PresetCell
              key={cell.key}
              cell={cell}
              onCycleDirection={() => cycleDirection(cell)}
              onEditElevator={() => cell.control?.kind === "elevator" && startPresetElevatorPlacement(cell.control.endpoint)}
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
    <button
      type="button"
      data-testid={`preset-action-${kind}`}
      data-preset-key={cell.key}
      className="hoverable"
      style={{ ...styles.iconButton, ...(danger ? { color: ui.text.error } : {}) }}
      title={title}
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
    </button>
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
