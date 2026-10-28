import React, { useEffect, useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { floorTopologyInfo, glueDraftProblem, selectionRun } from "../../store/topologyInfo";
import type { TopologyProblem } from "../../store/topologyProblem";
import { TopologyProblemBubble } from "./TopologyProblemBubble";
import type { WireFoldEnd } from "../../wasm/types";
import { faceLabel } from "../../pixi/topologyLabels";
import { Button } from "../Button";
import { EditIconButton } from "../EditIconButton";
import { ConfirmModal } from "../ConfirmModal";
import { InfoIconButton } from "../InfoIconButton";
import { Modal } from "../Modal";
import { SidePanel } from "../SidePanel";
import { Stack } from "../Layout";
import { Switch } from "../Switch";
import { WarningBubble } from "../WarningBubble";
import { sharedStyles } from "../../styles/shared";
import { typography, muted, radius, spacing, indent, ui } from "../../styles/theme";
import * as m from "~/paraglide/messages";

/** Side panel stacked over the topology panel for adding a glue or editing an existing one
 * (GitHub issue #839): the two runs are dragged on the canvas (the edit button of a run starts its
 * editing), the twist is chosen, and the confirm button is enabled once both runs are set and
 * nothing blocks the glue. Editing loads the runs of the glue and the confirm button replaces that
 * glue instead of adding a new one. Below the button a bubble gives the next instruction, or the
 * problem that blocks the glue. Closing the panel asks to confirm discarding the changes. */
export function GlueEditorPanel() {
  const result = useMazeStore((s) => floorTopologyInfo(s, s.activeFloorId));
  const topology = useMazeStore((s) => s.floorTopology[s.activeFloorId]);
  const fieldConfig = useMazeStore((s) => s.floorFields[s.activeFloorId]?.fieldConfig);
  const runA = useMazeStore((s) => s.topologyRunA);
  const runB = useMazeStore((s) => s.topologyRunB);
  const pick = useMazeStore((s) => s.topologyPick);
  const twist = useMazeStore((s) => s.topologyTwist);
  const error = useMazeStore((s) => s.topologyGlueError);
  const locked = useMazeStore((s) => s.backgroundAutoFillPreview !== null);
  const startPick = useMazeStore((s) => s.startTopologyPick);
  const setTwist = useMazeStore((s) => s.setTopologyTwist);
  const editor = useMazeStore((s) => s.topologyGlueEditor);
  const confirm = useMazeStore((s) => s.confirmTopologyGlue);
  const close = useMazeStore((s) => s.closeTopologyGlueEditor);
  const setSideHover = useMazeStore((s) => s.setTopologySideHover);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [twistInfoOpen, setTwistInfoOpen] = useState(false);
  useEffect(() => () => setSideHover(null), [setSideHover]);

  const contours = result.ok ? result.info.contours : [];
  const facesA = selectionRun(runA, contours);
  const facesB = selectionRun(runB, contours);
  const editedId = editor?.mode === "edit" ? editor.glueId : null;
  const problem = glueDraftProblem(facesA, facesB, topology, editedId);
  const contoursError: TopologyProblem | null = result.ok ? result.info.contours_error ?? null : { code: "internal", message: result.error };

  // Hovering a side highlights it and, once both runs are set and equal, the side it would be glued to.
  const hoverSide = (target: "a" | "b", i: number) => {
    const own = target === "a" ? facesA : facesB;
    const other = target === "a" ? facesB : facesA;
    if (own === null) return;
    const partner = other !== null && other.length === own.length ? [other[twist ? i : own.length - 1 - i]] : [];
    setSideHover(target === "a" ? { a: [own[i]], b: partner } : { a: partner, b: [own[i]] });
  };

  const runBlock = (target: "a" | "b", title: string, faces: WireFoldEnd[] | null) => {
    const color = target === "a" ? ui.topology.runA : ui.topology.runB;
    const editing = pick === target;
    const label = m["topology.edit_run"]();
    return (
      <Stack gap="itemGap">
        <div style={styles.headerRow}>
          <div style={sharedStyles.sectionHeader}>{title}</div>
          <EditIconButton
            title={label}
            disabled={locked || contours.length === 0}
            style={{ ...styles.editZone, ...(editing ? { color: color.text, background: color.bg } : {}) }}
            onClick={() => startPick(editing ? null : target)}
          />
        </div>
        <div style={styles.sides} data-testid={`topology-run-${target}`}>
          {faces === null
            ? <span style={{ ...typography.body, color: ui.text.disabled }}>{m["topology.run.empty"]()}</span>
            : faces.map((end, i) => (
              <span key={i} style={styles.hoverZone} onMouseEnter={() => hoverSide(target, i)} onMouseLeave={() => setSideHover(null)}>
                <span style={{ ...styles.bubble, background: color.bg, borderColor: color.text, color: color.text }}>
                  {fieldConfig ? faceLabel(end, fieldConfig) : ""}
                </span>
              </span>
            ))}
        </div>
      </Stack>
    );
  };

  const blocking = contoursError ?? problem ?? error;
  const instruction = facesA === null ? m["topology.status.set_a"]() : facesB === null ? m["topology.status.set_b"]() : null;

  return (
    <>
      <SidePanel title={editedId === null ? m["topology.add_title"]() : m["topology.edit_title"]({ id: String(editedId + 1) })} stackKey="topology-glue" onClose={() => setConfirmingCancel(true)}>
        <Stack gap="groupGap" style={styles.body}>
          {runBlock("a", m["topology.run_a_title"]({ count: facesA?.length ?? 0 }), facesA)}
          {runBlock("b", m["topology.run_b_title"]({ count: facesB?.length ?? 0 }), facesB)}
          <div style={styles.row}>
            <span style={styles.labelGroup}>
              <span style={styles.hint}>{m["topology.twist"]()}</span>
              <InfoIconButton onClick={() => setTwistInfoOpen(true)} />
            </span>
            <Switch checked={twist} onChange={setTwist} disabled={locked} />
          </div>
          <Button variant="primary" disabled={locked || facesA === null || facesB === null || problem !== null || contoursError !== null} onClick={confirm}>
            {editedId === null ? m["topology.add_confirm"]() : m["topology.edit_confirm"]()}
          </Button>
          {blocking !== null
            ? <TopologyProblemBubble problem={blocking} cfg={fieldConfig} />
            : instruction !== null && <WarningBubble severity="info" message={instruction} />}
        </Stack>
      </SidePanel>
      {twistInfoOpen && (
        <Modal title={m["topology.twist_info_title"]()} onClose={() => setTwistInfoOpen(false)}>
          <div style={styles.infoText}>{m["topology.twist_info"]()}</div>
        </Modal>
      )}
      {confirmingCancel && (
        <ConfirmModal
          message={editedId === null ? m["topology.add_cancel_confirm"]() : m["topology.edit_cancel_confirm"]()}
          onConfirm={() => { setConfirmingCancel(false); close(); }}
          onCancel={() => setConfirmingCancel(false)}
        />
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: { padding: spacing.groupGap },
  hint: { ...muted(typography.body) },
  labelGroup: { display: "flex", alignItems: "center", gap: spacing.rowGap, minWidth: 0 },
  infoText: { ...typography.body, ...muted(typography.body) },
  row: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  headerRow: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  // Touching hover zones (padding instead of gaps) keep the highlight from flickering between bubbles.
  sides: { display: "flex", flexWrap: "wrap", paddingLeft: indent.tree },
  hoverZone: { display: "inline-flex", padding: spacing.itemGap / 4, cursor: "default" },
  // A square, roomy hit and highlight area for the edit glyph.
  editZone: { width: 28, height: 28, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: radius.lg },
  bubble: {
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
  },
};
