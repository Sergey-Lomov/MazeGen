import React, { useState } from "react";
import { Trash2 } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import type { InactiveFoldReason, TopologyInfo } from "../../wasm/mazeService";
import type { WireFoldGroup, WireTopology } from "../../wasm/types";
import type { TopologyHover } from "../../store/topologyTypes";
import type { FieldConfig } from "../../fieldConfig";
import { faceLabel } from "../../pixi/topologyLabels";
import { glueColorsByGroup } from "../../pixi/selectors/glueColors";
import { Bubble, BubbleHoverZone, BubbleHoverZones } from "../Bubble";
import { ConfirmModal } from "../ConfirmModal";
import { EditIconButton } from "../EditIconButton";
import { ListCell, ListCellAction } from "../ListCell";
import { REASON_LABELS } from "./TopologyProblemBubble";
import { sharedStyles } from "../../styles/shared";
import { typography, muted, spacing, indent, ui } from "../../styles/theme";
import * as m from "~/paraglide/messages";

/// The CSS colour of each glue's arrow on the canvas, by glue id: the same hue the arrow layer draws it in.
export function glueDotColors(cfg: FieldConfig | undefined, topology: WireTopology | null): Map<number, string> {
  const colors = new Map<number, string>();
  for (const [group, color] of glueColorsByGroup(cfg, topology)) colors.set(group, `#${color.toString(16).padStart(6, "0")}`);
  return colors;
}

export interface GlueCellProps {
  glue: WireFoldGroup;
  topology: WireTopology;
  info: TopologyInfo;
  fieldConfig: FieldConfig | undefined;
  /** The colour of the glue's arrow on the canvas; `null` when it has none (it glues nothing). */
  dotColor: string | null;
  setHover: (hover: TopologyHover | null) => void;
  /** The edit and delete buttons; left out where glues are not editable at all. */
  editing?: {
    canEdit: boolean;
    /** The tooltip of both buttons while `canEdit` is false (they keep their own titles without it). */
    disabledReason?: string;
    onEdit: () => void;
    onDelete: () => void;
  };
  /** Extra content under the glue's runs. */
  children?: React.ReactNode;
}

/** One glue of a floor: title, size, inactive reasons and its two runs; hovering it (or one of its
 * sides) highlights the glue on the canvas. */
export function GlueCell({ glue, topology, info, fieldConfig, dotColor, setHover, editing, children }: GlueCellProps) {
  const setFlagged = useMazeStore((s) => s.setTopologyFlagged);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const twisted = topology.folds[glue.folds[0]]?.twist === true;
  const reasons = new Set<InactiveFoldReason>();
  for (const index of glue.folds) {
    const activity = info.activity[index];
    if (activity?.state === "inactive") reasons.add(activity.reason);
  }

  const disabledTitle = editing && !editing.canEdit ? editing.disabledReason : undefined;

  // A side bubble hovers its pair: the side and its partner are highlighted on the canvas.
  const runSection = (title: string, side: "a" | "b") => (
    <div style={styles.run}>
      <div style={sharedStyles.sectionHeader}>{title}</div>
      <BubbleHoverZones style={styles.sides}>
        {glue.folds.map((index) => {
          const end = topology.folds[index][side];
          const inactive = info.activity[index]?.state === "inactive";
          const color = ui.topology[side === "a" ? "runA" : "runB"];
          return (
            <BubbleHoverZone
              key={index}
              onMouseEnter={() => inactive ? setFlagged([topology.folds[index].a, topology.folds[index].b]) : setHover({ glue: glue.id, fold: index })}
              onMouseLeave={() => inactive ? setFlagged([]) : setHover({ glue: glue.id, fold: null })}
            >
              <Bubble data-testid="topology-side" {...(inactive ? { variant: "danger" } : { colors: color })}>
                {fieldConfig ? faceLabel(end, fieldConfig) : ""}
              </Bubble>
            </BubbleHoverZone>
          );
        })}
      </BubbleHoverZones>
    </div>
  );

  return (
    <>
    <ListCell
      data-testid="topology-glue"
      onMouseEnter={() => setHover({ glue: glue.id, fold: null })}
      onMouseLeave={() => setHover(null)}
      title={m["topology.glue_title"]({ id: String(glue.id + 1) })}
      titleAddon={dotColor !== null && <span data-testid="topology-glue-dot" style={{ ...styles.colorDot, background: dotColor }} />}
      actionsPlacement="title"
      actions={editing && (
        <>
          <EditIconButton title={disabledTitle ?? m["topology.edit"]()} disabled={!editing.canEdit} onClick={editing.onEdit} />
          <ListCellAction
            title={disabledTitle ?? m["topology.remove"]()}
            danger
            disabled={!editing.canEdit}
            onAction={() => setConfirmingRemove(true)}
          >
            <Trash2 size={16} />
          </ListCellAction>
        </>
      )}
    >
      <div style={styles.cellBody}>
      <div style={styles.hint}>
        {m[twisted ? "topology.glue_meta_twisted" : "topology.glue_meta"]({ size: glue.folds.length })}
      </div>
      {[...reasons].map((reason) => (
        <div key={reason} style={styles.error}>{REASON_LABELS[reason]()}</div>
      ))}
      {runSection(m["topology.run_a_name"](), "a")}
      {runSection(m["topology.run_b_name"](), "b")}
      {children}
      </div>
    </ListCell>
    {editing && confirmingRemove && (
      <ConfirmModal
        message={m["topology.remove_confirm"]({ id: String(glue.id + 1) })}
        onConfirm={() => { setConfirmingRemove(false); editing.onDelete(); }}
        onCancel={() => setConfirmingRemove(false)}
      />
    )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  hint: { ...muted(typography.body) },
  error: { ...typography.body, color: ui.text.error, overflowWrap: "anywhere" },
  // Everything in a glue cell but its title is one level in; the side bubbles add their own level.
  cellBody: { display: "flex", flexDirection: "column", gap: spacing.itemGap / 2, paddingLeft: indent.tree },
  colorDot: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0 },
  run: { display: "flex", flexDirection: "column", gap: spacing.itemGap / 2 },
  sides: { paddingLeft: indent.tree },
};
