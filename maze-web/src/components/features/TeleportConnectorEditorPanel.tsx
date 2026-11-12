import { useState } from "react";
import { Spline, Trash2, Waypoints } from "lucide-react";
import { manualPathMode, straightCubicControls, type ManualTeleportConnectorMode } from "../../pixi/renderers/teleportConnectorManual";
import { formatTargetLabel } from "../../pixi/targetLabel";
import { useMazeStore } from "../../store/mazeStore";
import { SidePanel } from "../SidePanel";
import { ConfirmModal } from "../ConfirmModal";
import { Bubble, BubbleArrow } from "../Bubble";
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
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const setHovered = useMazeStore((s) => s.setHoveredTeleportNodeIds);
  const { modeWarnings: warnings } = useModeWarnings(settings, computeTeleportConnectorWarningsAcrossFloors);
  const warningsExpanded = useMazeStore((s) => s.vectorByWallsSectionsExpanded[WARNINGS_SECTION_ID] ?? true);
  const setSectionExpanded = useMazeStore((s) => s.setVectorByWallsSectionExpanded);
  // Object insertion order is the authored order: overwriting an existing path keeps its place,
  // while materialising a newly manual connector appends it. Do not sort by pair key.
  const rows = Object.keys(paths).map((key) => {
    const [a, b] = key.split(":").map(Number);
    return { key, ids: [a, b], path: paths[key], points: paths[key].nodes, a: nodeById.get(a), b: nodeById.get(b) };
  });
  const label = (node: typeof nodes[number] | undefined) => {
    if (!node) return m["image_export.teleport_connector_editor.missing_endpoint"]();
    return formatTargetLabel([node.x, node.y], node.level ?? 0, floors.length > 1, undefined);
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
        <div style={styles.list}>{rows.map((row) => (
          <ListCell
            key={row.key}
            style={hoveredKey === row.key ? { ...styles.row, background: ui.bg.hover } : styles.row}
            onMouseEnter={() => { setHoveredKey(row.key); setHovered(row.ids); }}
            onMouseLeave={() => { setHoveredKey(null); setHovered(null); }}
            onClick={() => onFocusPath(row.points)}
            details={(
              <div style={styles.bubbles}>
                <Bubble onMouseEnter={(e) => { e.stopPropagation(); setHovered([row.ids[0]]); }} onMouseLeave={() => setHovered(row.ids)}>{label(row.a)}</Bubble>
                <BubbleArrow onMouseEnter={(e) => { e.stopPropagation(); setHovered(row.ids); }}>↔</BubbleArrow>
                <Bubble onMouseEnter={(e) => { e.stopPropagation(); setHovered([row.ids[1]]); }} onMouseLeave={() => setHovered(row.ids)}>{label(row.b)}</Bubble>
              </div>
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
          />
        ))}</div>
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
  bubbles: { display: "flex", alignItems: "center", gap: spacing.itemGap, minWidth: 0, flex: 1 },
  empty: { ...typography.body, color: ui.text.tertiary, padding: spacing.groupGap },
  warnings: { display: "flex", flexDirection: "column", gap: spacing.itemGap, marginTop: spacing.itemGap, paddingLeft: indent.tree },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.itemGap}px 0` },
  instructions: { marginTop: spacing.groupGap * 3, padding: `0 ${spacing.groupGap}px ${spacing.groupGap}px`, display: "flex", flexDirection: "column", gap: spacing.groupGap },
};
