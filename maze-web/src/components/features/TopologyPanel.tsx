import React, { useState } from "react";
import { Trash2 } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import { floorTopologyInfo } from "../../store/topologyInfo";
import type { InactiveFoldReason } from "../../wasm/mazeService";
import type { WireFoldGroup, WireTopology } from "../../wasm/types";
import type { TopologyInfo } from "../../wasm/mazeService";
import type { TopologyHover } from "../../store/topologyTypes";
import type { FieldConfig } from "../../fieldConfig";
import { faceLabel } from "../../pixi/topologyLabels";
import { glueColor } from "../../pixi/renderers/SeamArrowRenderer";
import { seamArrowsFor } from "../../pixi/selectors/seamArrows";
import { Button } from "../Button";
import { ConfirmModal } from "../ConfirmModal";
import { EditIconButton } from "../EditIconButton";
import { SidePanel } from "../SidePanel";
import { Tooltip } from "../Tooltip";
import { GlueEditorPanel } from "./GlueEditorPanel";
import { REASON_LABELS, TopologyProblemBubble } from "./TopologyProblemBubble";
import { Stack } from "../Layout";
import { sharedStyles } from "../../styles/shared";
import { typography, muted, disabled, radius, spacing, indent, ui } from "../../styles/theme";
import * as m from "~/paraglide/messages";

/** Glue editor side panel of the field setup card (GitHub issue #839). A glue is a set of cell-face
 * pairs; the panel lists every glue with its pairs (hovering a glue highlights its faces on the
 * canvas) and glues two boundary runs picked on the canvas. All state lives in
 * the store; the canvas side is `TopologyBandRenderer` in `FieldEditorOverlay`. */
export function TopologyPanel({ onClose }: { onClose: () => void }) {
  const fieldConfig = useMazeStore((s) => s.floorFields[s.activeFloorId]?.fieldConfig);
  const topology = useMazeStore((s) => s.floorTopology[s.activeFloorId] ?? null);
  const result = useMazeStore((s) => floorTopologyInfo(s, s.activeFloorId));
  const locked = useMazeStore((s) => s.backgroundAutoFillPreview !== null);
  const clearRuns = useMazeStore((s) => s.clearTopologyRuns);
  const glueEditor = useMazeStore((s) => s.topologyGlueEditor);
  const openGlueEditor = useMazeStore((s) => s.openTopologyGlueEditor);
  const removeGroup = useMazeStore((s) => s.removeTopologyGroup);
  const setHover = useMazeStore((s) => s.setTopologyHover);
  const panelError = useMazeStore((s) => s.topologyPanelError);

  function close() {
    setHover(null);
    clearRuns();
    onClose();
  }

  if (!result.ok) {
    return (
      <SidePanel title={m["topology.title"]()} stackKey="topology" onClose={close}>
        <Stack gap="groupGap" style={styles.panelBody}>
          <TopologyProblemBubble problem={{ code: "internal", message: result.error }} cfg={fieldConfig} />
        </Stack>
      </SidePanel>
    );
  }
  const { info } = result;
  const glues = topology?.groups ?? [];
  const dotColors = glueDotColors(fieldConfig, topology);

  const iconButton = (title: string, onClick: () => void, icon: React.ReactNode, disabled: boolean, danger = false) => (
    <Tooltip content={title}>
      <button
        type="button"
        className="hoverable"
        disabled={disabled}
        aria-label={title}
        style={{ ...styles.iconButton, ...(danger ? { color: ui.text.error } : {}), ...(disabled ? { opacity: 0.4 } : {}) }}
        onClick={onClick}
      >
        {icon}
      </button>
    </Tooltip>
  );

  return (
    <>
    <SidePanel title={m["topology.title"]()} stackKey="topology" onClose={close}>
      {panelError !== null && (
        <Stack gap="groupGap" style={styles.panelBody}>
          <TopologyProblemBubble problem={panelError} cfg={fieldConfig} />
        </Stack>
      )}
      <div style={styles.list}>
        {glues.length === 0 && <div style={styles.empty}>{m["topology.no_glues"]()}</div>}
        {glues.map((glueItem) => (
          <GlueCell
            key={glueItem.id}
            glue={glueItem}
            topology={topology!}
            info={info}
            fieldConfig={fieldConfig}
            dotColor={dotColors.get(glueItem.id) ?? null}
            canDelete={!locked}
            setHover={setHover}
            onEdit={() => openGlueEditor(glueItem.id)}
            onDelete={() => removeGroup(glueItem.id)}
            iconButton={iconButton}
          />
        ))}
      </div>

      <Stack gap="groupGap" style={styles.panelBody}>
        <Button variant="primary" disabled={locked} onClick={() => openGlueEditor()}>
          {m["topology.add"]()}
        </Button>
      </Stack>
    </SidePanel>
    {glueEditor !== null && <GlueEditorPanel />}
    </>
  );
}

/// The CSS colour of each glue's arrow on the canvas, by glue id: the same hue the arrow layer draws it in.
function glueDotColors(cfg: FieldConfig | undefined, topology: WireTopology | null): Map<number, string> {
  const colors = new Map<number, string>();
  if (!cfg) return colors;
  try {
    const arrows = seamArrowsFor(cfg, topology);
    arrows.forEach((arrow, index) => {
      if (arrow.group !== null) colors.set(arrow.group, `#${glueColor(index, arrows.length, false).toString(16).padStart(6, "0")}`);
    });
  } catch {
    // A field mid-reset has no geometry to read; the dots come back with the next render.
  }
  return colors;
}

interface GlueCellProps {
  glue: WireFoldGroup;
  topology: WireTopology;
  info: TopologyInfo;
  fieldConfig: FieldConfig | undefined;
  /** The colour of the glue's arrow on the canvas; `null` when it has none (it glues nothing). */
  dotColor: string | null;
  canDelete: boolean;
  setHover: (hover: TopologyHover | null) => void;
  onEdit: () => void;
  onDelete: () => void;
  iconButton: (title: string, onClick: () => void, icon: React.ReactNode, disabled: boolean, danger?: boolean) => React.ReactNode;
}

function GlueCell({ glue, topology, info, fieldConfig, dotColor, canDelete, setHover, onEdit, onDelete, iconButton }: GlueCellProps) {
  const setFlagged = useMazeStore((s) => s.setTopologyFlagged);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const twisted = topology.folds[glue.folds[0]]?.twist === true;
  const reasons = new Set<InactiveFoldReason>();
  for (const index of glue.folds) {
    const activity = info.activity[index];
    if (activity?.state === "inactive") reasons.add(activity.reason);
  }

  // A side bubble hovers its pair: the side and its partner are highlighted on the canvas.
  const runSection = (title: string, side: "a" | "b") => (
    <div style={styles.run}>
      <div style={sharedStyles.sectionHeader}>{title}</div>
      <div style={styles.sides}>
        {glue.folds.map((index) => {
          const end = topology.folds[index][side];
          const inactive = info.activity[index]?.state === "inactive";
          const color = ui.topology[side === "a" ? "runA" : "runB"];
          return (
            <span
              key={index}
              style={styles.hoverZone}
              onMouseEnter={() => inactive ? setFlagged([topology.folds[index].a, topology.folds[index].b]) : setHover({ glue: glue.id, fold: index })}
              onMouseLeave={() => inactive ? setFlagged([]) : setHover({ glue: glue.id, fold: null })}
            >
              <span data-testid="topology-side" style={inactive ? styles.bubbleInactive : { ...styles.bubble, ...runColors(color) }}>
                {fieldConfig ? faceLabel(end, fieldConfig) : ""}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );

  return (
    <>
    <div
      data-testid="topology-glue"
      style={styles.cell}
      onMouseEnter={() => setHover({ glue: glue.id, fold: null })}
      onMouseLeave={() => setHover(null)}
    >
      <div style={styles.titleRow}>
        <span style={typography.body}>
          {m["topology.glue_title"]({ id: String(glue.id + 1) })}
        </span>
        {dotColor !== null && <span data-testid="topology-glue-dot" style={{ ...styles.colorDot, background: dotColor }} />}
        <div style={styles.actions}>
          <EditIconButton title={m["topology.edit"]()} disabled={!canDelete} onClick={onEdit} />
          {iconButton(m["topology.remove"](), () => setConfirmingRemove(true), <Trash2 size={16} style={styles.iconGlyph} />, !canDelete, true)}
        </div>
      </div>
      <div style={styles.cellBody}>
      <div style={styles.hint}>
        {m[twisted ? "topology.glue_meta_twisted" : "topology.glue_meta"]({ size: glue.folds.length })}
      </div>
      {[...reasons].map((reason) => (
        <div key={reason} style={styles.error}>{REASON_LABELS[reason]()}</div>
      ))}
      {runSection(m["topology.run_a_name"](), "a")}
      {runSection(m["topology.run_b_name"](), "b")}
      </div>
    </div>
    {confirmingRemove && (
      <ConfirmModal
        message={m["topology.remove_confirm"]({ id: String(glue.id + 1) })}
        onConfirm={() => { setConfirmingRemove(false); onDelete(); }}
        onCancel={() => setConfirmingRemove(false)}
      />
    )}
    </>
  );
}

const runColors = (color: { bg: string; text: string }): React.CSSProperties => ({ background: color.bg, borderColor: color.text, color: color.text });

const bubbleBase: React.CSSProperties = {
  ...typography.caption,
  fontFamily: "Consolas, Menlo, Monaco, monospace",
  display: "inline-flex",
  alignItems: "center",
  borderStyle: "solid",
  borderWidth: 1,
  borderRadius: radius.lg,
  padding: `0 ${spacing.itemGap}px`,
  whiteSpace: "nowrap",
  cursor: "default",
  userSelect: "none",
};

const styles: Record<string, React.CSSProperties> = {
  panelBody: { padding: spacing.groupGap },
  hint: { ...muted(typography.body) },
  error: { ...typography.body, color: ui.text.error, overflowWrap: "anywhere" },
  list: { display: "flex", flexDirection: "column", borderTop: `1px solid ${ui.border.default}` },
  empty: { ...disabled(typography.body), textAlign: "center", padding: `${spacing.itemGap}px ${spacing.groupGap}px` },
  cell: {
    display: "flex", flexDirection: "column", gap: spacing.itemGap / 2,
    padding: `${spacing.itemGap}px ${spacing.groupGap}px`,
    borderBottom: `1px solid ${ui.border.default}`,
  },
  // Everything in a glue cell but its title is one level in; the side bubbles add their own level.
  cellBody: { display: "flex", flexDirection: "column", gap: spacing.itemGap / 2, paddingLeft: indent.tree },
  colorDot: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0 },
  titleRow: { display: "flex", alignItems: "center", gap: spacing.itemGap, minWidth: 0 },
  actions: { display: "flex", alignItems: "center", gap: spacing.itemGap, marginLeft: "auto", flexShrink: 0 },
  run: { display: "flex", flexDirection: "column", gap: spacing.itemGap / 2 },
  // Bubble hover zones touch (no gap), so moving between bubbles never passes a spot that
  // hovers the whole glue; the padding keeps the visual spacing.
  sides: { display: "flex", flexWrap: "wrap", paddingLeft: indent.tree },
  hoverZone: { display: "inline-flex", padding: spacing.itemGap / 4, cursor: "default" },
  bubble: { ...bubbleBase, background: ui.debug.refHighlight.bg, borderColor: ui.debug.refHighlight.text, color: ui.debug.refHighlight.text },
  bubbleInactive: { ...bubbleBase, background: ui.bg.error, borderColor: ui.text.error, color: ui.text.error },
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
};
