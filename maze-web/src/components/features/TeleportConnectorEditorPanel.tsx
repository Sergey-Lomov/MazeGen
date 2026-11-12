import { useEffect, useMemo, useState } from "react";
import { Link2, Spline, Trash2, Waypoints } from "lucide-react";
import { manualPathMode, parseTeleportConnectorKey, straightCubicControls, type ManualTeleportConnectorMode } from "../../pixi/renderers/teleportConnectorManual";
import { useMazeStore } from "../../store/mazeStore";
import { SidePanel } from "../SidePanel";
import { ConfirmModal } from "../ConfirmModal";
import { Tooltip } from "../Tooltip";
import { EntityBubbleRow } from "./EntityBubbleRow";
import { usePostEditSplitLabelContext } from "./usePostEditSplitLabelContext";
import { endpointBubble, splitPointBubble, type PostEditEntityBubble } from "../../pixi/postEditCommandLabels";
import { nodeEndpoint } from "../../pixi/postEditEndpoint";
import { navigateToFloor } from "../../pixi/renderers/floorNavigation";
import { buildTeleportConnectorSegments, type TeleportConnectorSegment } from "../../pixi/selectors/teleportConnectorSegments";
import { ListCell, ListCellAction } from "../ListCell";
import { EmbeddedHotkeyHint } from "../EmbeddedHotkeyHint";
import type { ShortcutKey } from "../ToolIconButton";
import { indent, spacing, typography, ui } from "../../styles/theme";
import { SectionHeader } from "../SectionHeader";
import { ExportWarningBubble } from "./ExportWarningBubble";
import { resolveExportWarningsSectionTitle } from "./exportWarningsI18n";
import { useModeWarnings } from "./useExportPanelModel";
import { computeTeleportConnectorWarningsAcrossFloors } from "../../pixi/selectors/exportWarnings";
import * as m from "~/paraglide/messages";

const WARNINGS_SECTION_ID = "teleportConnectorEditorWarnings";

/** The manual-connector inventory deliberately reads the common walls copy: writes mirror it to
 * both export modes, so a path appears once regardless of the active renderer. */
export function TeleportConnectorEditorPanel({ onClose, onFocusPath }: { onClose: () => void; onFocusPath: (points: readonly [number, number][]) => void }) {
  const settings = useMazeStore((s) => s.vectorByWallsSettings);
  const paths = settings.manualTeleportConnectorPaths ?? {};
  const nodes = useMazeStore((s) => s.nodes);
  const floors = useMazeStore((s) => s.floors);
  const setPaths = useMazeStore((s) => s.setManualTeleportConnectorPaths);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const edges = useMazeStore((s) => s.edges);
  const cfg = useMazeStore((s) => s.activeFieldConfig);
  const setHovered = useMazeStore((s) => s.setHoveredTeleportNodeIds);
  const setHoveredCells = useMazeStore((s) => s.setHoveredTeleportCells);
  const { nodeById, multiFloor, splitCtx } = usePostEditSplitLabelContext();
  const { modeWarnings: warnings, rawEffectiveEndpoints } = useModeWarnings(settings, computeTeleportConnectorWarningsAcrossFloors);
  const segments = useMemo(() => buildTeleportConnectorSegments({
    nodes, edges, cfg, floors, avoidFieldExit: settings.teleportAvoidFieldExit, start: rawEffectiveEndpoints.start, finish: rawEffectiveEndpoints.finish,
  }), [nodes, edges, cfg, floors, settings.teleportAvoidFieldExit, rawEffectiveEndpoints]);
  // A cell that unmounts while hovered must not leave its canvas highlight on.
  useEffect(() => () => { setHovered(null); setHoveredCells(null); }, [setHovered, setHoveredCells]);
  const hover = (ids: number[], cells: { floorIndex: number; x: number; y: number }[] = []) => { setHovered(ids.length > 0 ? ids : null); setHoveredCells(cells.length > 0 ? cells : null); };
  const warningsExpanded = useMazeStore((s) => s.vectorByWallsSectionsExpanded[WARNINGS_SECTION_ID] ?? true);
  const setSectionExpanded = useMazeStore((s) => s.setVectorByWallsSectionExpanded);
  // Object insertion order is the authored order: overwriting an existing path keeps its place,
  // while materialising a newly manual connector appends it. Do not sort by pair key.
  // A cross-floor pair has one row per floor (GitHub issue #989): a piece joins the teleport on that
  // floor and the floor badge, so its bubbles name the connector's own two ends, not the teleport pair.
  const ends = (segment: TeleportConnectorSegment | undefined, fallback: [number, number]): TeleportConnectorSegment["from"][] =>
    (segment ? [segment.from, segment.to] : fallback.map((node) => ({ node })));
  const rowOf = (key: string) => {
    const segment = segments.get(key);
    const pair = ends(segment, parseTeleportConnectorKey(key).ids);
    const bubbles: PostEditEntityBubble[] = pair.map((end) => "node" in end
      ? endpointBubble(nodeEndpoint(end.node), nodeById, multiFloor, splitCtx)
      : splitPointBubble(end.badge, segment!.floorIndex, multiFloor));
    const ids = pair.flatMap((end) => ("node" in end ? [end.node] : []));
    const cells = pair.flatMap((end) => ("badge" in end ? [{ floorIndex: segment!.floorIndex, x: end.badge[0], y: end.badge[1] }] : []));
    const { ids: pairIds, ownNode } = parseTeleportConnectorKey(key);
    return { key, pairKey: `${pairIds[0]}:${pairIds[1]}`, crossFloor: ownNode !== undefined, pair, bubbles, ids, cells, floorIndex: segment?.floorIndex, arrow: segment?.oneWay ? "->" as const : "<->" as const, path: paths[key], points: paths[key].nodes };
  };
  // The pieces of one cross-floor teleport are separate paths, but one connector to the reader: they
  // are listed together, at the place of the first piece authored.
  const ordered: ReturnType<typeof rowOf>[] = [];
  for (const row of Object.keys(paths).map(rowOf)) {
    let lastSibling = -1;
    if (row.crossFloor) ordered.forEach((other, i) => { if (other.crossFloor && other.pairKey === row.pairKey) lastSibling = i; });
    ordered.splice(lastSibling >= 0 ? lastSibling + 1 : ordered.length, 0, row);
  }
  // The row whose bottom divider carries the "same connector" mark: a piece followed by its sibling.
  const rows = ordered.map((row, i) => ({ ...row, linkedBelow: row.crossFloor && ordered[i + 1]?.crossFloor === true && ordered[i + 1].pairKey === row.pairKey }));
  const remove = () => {
    if (pendingKey === null) return;
    const { [pendingKey]: _removed, ...rest } = paths;
    setPaths(rest);
    setPendingKey(null);
  };
  const setMode = (key: string, mode: ManualTeleportConnectorMode) => {
    const current = paths[key];
    if (!current || manualPathMode(current) === mode) return;
    setPaths({
      ...paths,
      [key]: {
        mode,
        nodes: current.nodes,
        controls: mode === "curve" ? current.controls ?? straightCubicControls(current.nodes) : current.controls,
      },
    });
  };
  return (
    <SidePanel title={m["image_export.teleport_connector_editor.title"]()} stackKey="image-export-teleport-connectors" onClose={() => { hover([]); onClose(); }}>
      <SectionHeader
        label={<span className={warnings.length > 0 ? "problem-section-attention" : undefined}>{resolveExportWarningsSectionTitle(warnings.length)}</span>}
        expanded={warningsExpanded}
        onToggle={() => setSectionExpanded(WARNINGS_SECTION_ID, !warningsExpanded)}
      />
      {warningsExpanded && warnings.length > 0 && (
        <div style={styles.warnings}>{warnings.map((warning) => <ExportWarningBubble key={warning.key} warning={warning} />)}</div>
      )}
      <div style={styles.divider} />
      {rows.length === 0 ? <div style={styles.empty}>{m["image_export.teleport_connector_editor.empty"]()}</div> : (
        <div style={styles.list}>{rows.map((row) => {
          const hoverRow = () => hover(row.ids, row.cells);
          return (
          <ListCell
            key={row.key}
            style={{
              ...styles.row,
              ...(row.linkedBelow ? { position: "relative" } : null),
              ...(hoveredKey === row.key ? { background: ui.bg.hover } : null),
            }}
            onMouseEnter={() => { setHoveredKey(row.key); hoverRow(); }}
            onMouseLeave={() => { setHoveredKey(null); hover([]); }}
            onClick={() => { if (row.floorIndex !== undefined) navigateToFloor(row.floorIndex); onFocusPath(row.points); }}
            details={(
              <EntityBubbleRow
                bubbles={row.bubbles}
                arrow={row.arrow}
                onBubbleEnter={(_, j) => {
                  const end = row.pair[j];
                  if ("node" in end) hover([end.node]); else hover([], row.cells);
                }}
                onBubbleLeave={hoverRow}
                onArrowEnter={hoverRow}
                onArrowLeave={hoverRow}
                onBubbleClick={(bubble) => { if (bubble.highlight?.kind === "point") navigateToFloor(bubble.highlight.level ?? 0); }}
              />
            )}
            actions={(
              <>
                <ListCellAction
                  title={m["image_export.teleport_connector_editor.mode_polyline"]()}
                  selected={manualPathMode(row.path) === "polyline"}
                  onAction={() => setMode(row.key, "polyline")}
                ><Waypoints size={16} /></ListCellAction>
                <ListCellAction
                  title={m["image_export.teleport_connector_editor.mode_curve"]()}
                  selected={manualPathMode(row.path) === "curve"}
                  onAction={() => setMode(row.key, "curve")}
                ><Spline size={16} /></ListCellAction>
                <ListCellAction
                  title={m["image_export.teleport_connector_editor.reset_title"]()}
                  danger
                  onAction={() => setPendingKey(row.key)}
                ><Trash2 size={16} /></ListCellAction>
              </>
            )}
          >
            {row.linkedBelow && (
              <Tooltip placement="top" content={m["image_export.teleport_connector_editor.linked_pieces"]()}>
                <span style={styles.linkMark} data-testid="teleport-connector-link-mark" onClick={(e) => e.stopPropagation()}><Link2 size={11} /></span>
              </Tooltip>
            )}
          </ListCell>
          );
        })}</div>
      )}
      <div style={styles.instructions}>
        <Instruction keys={["LMB"]} text={m["image_export.teleport_connector_editor.hint_left_click"]()} />
        <Instruction keys={["RMB"]} text={m["image_export.teleport_connector_editor.hint_right_click"]()} />
        <Instruction keys={["mod"]} text={m["image_export.teleport_connector_editor.hint_snap"]()} />
        <Instruction keys={["Alt"]} text={m["image_export.teleport_connector_editor.hint_independent_handles"]()} />
        <Instruction keys={["shift"]} text={m["image_export.teleport_connector_editor.hint_symmetric_handles"]()} />
      </div>
      {pendingKey !== null && <ConfirmModal
        message={m["image_export.teleport_connector_editor.reset_confirm"]()}
        onConfirm={remove}
        onCancel={() => setPendingKey(null)}
      />}
    </SidePanel>
  );
}

function Instruction({ keys, text }: { keys: readonly ShortcutKey[]; text: string }) {
  return <EmbeddedHotkeyHint keys={keys}>{text}</EmbeddedHotkeyHint>;
}

const styles: Record<string, React.CSSProperties> = {
  list: { display: "flex", flexDirection: "column" },
  row: { cursor: "pointer" },
  // Sits on the divider under a piece, marking it and the next row as the two halves of one connector.
  linkMark: {
    position: "absolute", left: "50%", bottom: 0, transform: "translate(-50%, 50%)", zIndex: 2,
    width: 18, height: 18, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
    background: ui.bg.panel, border: `1px solid ${ui.border.default}`, color: ui.text.tertiary, cursor: "default",
  },
  empty: { ...typography.body, color: ui.text.tertiary, padding: spacing.groupGap },
  warnings: { display: "flex", flexDirection: "column", gap: spacing.itemGap, marginTop: spacing.itemGap, paddingLeft: indent.tree },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.itemGap}px 0` },
  instructions: { marginTop: spacing.groupGap * 3, padding: `0 ${spacing.groupGap}px ${spacing.groupGap}px`, display: "flex", flexDirection: "column", gap: spacing.groupGap },
};
