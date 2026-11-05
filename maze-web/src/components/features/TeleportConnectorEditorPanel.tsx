import { useState } from "react";
import { Spline, Trash2, Waypoints } from "lucide-react";
import { manualPathMode, straightCubicControls, type ManualTeleportConnectorMode } from "../../pixi/renderers/teleportConnectorManual";
import { useMazeStore } from "../../store/mazeStore";
import { SidePanel } from "../SidePanel";
import { ConfirmModal } from "../ConfirmModal";
import { Tooltip } from "../Tooltip";
import { EmbeddedHotkeyHint } from "../EmbeddedHotkeyHint";
import { sharedStyles } from "../../styles/shared";
import { radius, spacing, typography, ui } from "../../styles/theme";
import * as m from "~/paraglide/messages";

/** The manual-connector inventory deliberately reads the common walls copy: writes mirror it to
 * both export modes, so a path appears once regardless of the active renderer. */
export function TeleportConnectorEditorPanel({ onClose, onFocusPath }: { onClose: () => void; onFocusPath: (points: readonly [number, number][]) => void }) {
  const paths = useMazeStore((s) => s.vectorByWallsSettings.manualTeleportConnectorPaths ?? {});
  const nodes = useMazeStore((s) => s.nodes);
  const floors = useMazeStore((s) => s.floors);
  const setPaths = useMazeStore((s) => s.setManualTeleportConnectorPaths);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const setHovered = useMazeStore((s) => s.setHoveredTeleportNodeIds);
  // Object insertion order is the authored order: overwriting an existing path keeps its place,
  // while materialising a newly manual connector appends it. Do not sort by pair key.
  const rows = Object.keys(paths).map((key) => {
    const [a, b] = key.split(":").map(Number);
    return { key, ids: [a, b], path: paths[key], points: paths[key].nodes, a: nodeById.get(a), b: nodeById.get(b) };
  });
  const label = (node: typeof nodes[number] | undefined) => {
    if (!node) return m["image_export.teleport_connector_editor.missing_endpoint"]();
    const floor = floors[node.level ?? 0];
    return `${floors.length > 1 ? `${floor?.title ?? node.level ?? 0} ` : ""}${node.x}:${node.y}`;
  };
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
    <SidePanel title={m["image_export.teleport_connector_editor.title"]()} stackKey="image-export-teleport-connectors" onClose={() => { setHovered(null); onClose(); }}>
      {rows.length === 0 ? <div style={styles.empty}>{m["image_export.teleport_connector_editor.empty"]()}</div> : (
        <div style={styles.list}>{rows.map((row) => (
          <div key={row.key} style={hoveredKey === row.key ? { ...styles.row, background: ui.bg.hover } : styles.row} onMouseEnter={() => { setHoveredKey(row.key); setHovered(row.ids); }} onMouseLeave={() => { setHoveredKey(null); setHovered(null); }} onClick={() => onFocusPath(row.points)}>
            <div style={styles.bubbles}>
              <span style={styles.bubble} onMouseEnter={(e) => { e.stopPropagation(); setHovered([row.ids[0]]); }} onMouseLeave={() => setHovered(row.ids)}>{label(row.a)}</span>
              <span style={styles.arrow} onMouseEnter={(e) => { e.stopPropagation(); setHovered(row.ids); }}>↔</span>
              <span style={styles.bubble} onMouseEnter={(e) => { e.stopPropagation(); setHovered([row.ids[1]]); }} onMouseLeave={() => setHovered(row.ids)}>{label(row.b)}</span>
            </div>
            <div style={styles.modeActions}>
              <Tooltip content={m["image_export.teleport_connector_editor.mode_polyline"]()}><button
                type="button" className="hoverable" style={manualPathMode(row.path) === "polyline" ? { ...sharedStyles.closeBtn, ...styles.modeButton, ...styles.modeSelected } : { ...sharedStyles.closeBtn, ...styles.modeButton }}
                aria-label={m["image_export.teleport_connector_editor.mode_polyline"]()} onClick={(e) => { e.stopPropagation(); setMode(row.key, "polyline"); }}
              ><Waypoints size={16} /></button></Tooltip>
              <Tooltip content={m["image_export.teleport_connector_editor.mode_curve"]()}><button
                type="button" className="hoverable" style={manualPathMode(row.path) === "curve" ? { ...sharedStyles.closeBtn, ...styles.modeButton, ...styles.modeSelected } : { ...sharedStyles.closeBtn, ...styles.modeButton }}
                aria-label={m["image_export.teleport_connector_editor.mode_curve"]()} onClick={(e) => { e.stopPropagation(); setMode(row.key, "curve"); }}
              ><Spline size={16} /></button></Tooltip>
              <Tooltip content={m["image_export.teleport_connector_editor.reset_title"]()}><button
                type="button" className="hoverable" style={{ ...sharedStyles.closeBtn, color: ui.text.error }}
                aria-label={m["image_export.teleport_connector_editor.reset_title"]()} onClick={(e) => { e.stopPropagation(); setPendingKey(row.key); }}
              ><Trash2 size={16} /></button></Tooltip>
            </div>
          </div>
        ))}</div>
      )}
      <div style={styles.instructions}>
        <Instruction keys={["LMB"]} text={m["image_export.teleport_connector_editor.hint_left_click"]()} />
        <Instruction keys={["RMB"]} text={m["image_export.teleport_connector_editor.hint_right_click"]()} />
        <Instruction keys={["mod"]} text={m["image_export.teleport_connector_editor.hint_snap"]()} />
      </div>
      {pendingKey !== null && <ConfirmModal
        message={m["image_export.teleport_connector_editor.reset_confirm"]()}
        onConfirm={remove}
        onCancel={() => setPendingKey(null)}
      />}
    </SidePanel>
  );
}

function Instruction({ keys, text }: { keys: readonly string[]; text: string }) {
  return <EmbeddedHotkeyHint keys={keys}>{text}</EmbeddedHotkeyHint>;
}

const styles: Record<string, React.CSSProperties> = {
  list: { display: "flex", flexDirection: "column" },
  row: { display: "flex", alignItems: "center", gap: spacing.itemGap, padding: `${spacing.itemGap}px ${spacing.groupGap}px`, borderBottom: `1px solid ${ui.border.default}`, cursor: "pointer" },
  modeActions: { display: "flex", alignItems: "center", gap: 2 },
  modeButton: { display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, boxSizing: "border-box" },
  modeSelected: { background: ui.bg.hover, color: ui.text.primary, borderRadius: radius.sm },
  bubbles: { display: "flex", alignItems: "center", gap: spacing.itemGap, minWidth: 0, flex: 1 },
  bubble: { ...typography.caption, fontFamily: "Consolas, Menlo, Monaco, monospace", border: `1px solid ${ui.debug.refHighlight.text}`, borderRadius: radius.lg, padding: `0 ${spacing.itemGap}px`, background: ui.debug.refHighlight.bg, color: ui.debug.refHighlight.text, whiteSpace: "nowrap" },
  arrow: { ...typography.caption, color: ui.text.secondary },
  empty: { ...typography.body, color: ui.text.tertiary, padding: spacing.groupGap },
  instructions: { marginTop: spacing.groupGap * 3, padding: `0 ${spacing.groupGap}px ${spacing.groupGap}px`, display: "flex", flexDirection: "column", alignItems: "center", gap: spacing.itemGap },
};
