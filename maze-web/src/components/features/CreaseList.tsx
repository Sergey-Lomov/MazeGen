import React, { useState } from "react";
import { Trash2 } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import type { Crease } from "../../store/creases";
import type { FieldConfig } from "../../fieldConfig";
import { creaseLabelPoint } from "../../pixi/creaseGeometry";
import { ConfirmModal } from "../ConfirmModal";
import { EditIconButton } from "../EditIconButton";
import { Tooltip } from "../Tooltip";
import { Button } from "../Button";
import { WarningBubble } from "../WarningBubble";
import { Stack } from "../Layout";
import { typography, disabled, muted, spacing, indent, ui } from "../../styles/theme";
import * as m from "~/paraglide/messages";

const formatPoint = (point: readonly [number, number], cfg: FieldConfig | undefined) => {
  if (!cfg) return "";
  const [x, y] = creaseLabelPoint(point, cfg);
  // `+ 0` turns -0 into 0, so a point on an axis never reads "-0.00".
  return `${(x + 0).toFixed(2)}; ${(y + 0).toFixed(2)}`;
};

/** The "Creases" mode of the topology panel (GitHub issue #898): the active floor's crease lines with edit and
 * delete, and the buttons that start drawing one on the canvas (two clicks; Shift places an end freely). */
export function CreaseList() {
  const creases = useMazeStore((s) => s.floorCreases[s.activeFloorId]);
  const fieldConfig = useMazeStore((s) => s.floorFields[s.activeFloorId]?.fieldConfig);
  const draft = useMazeStore((s) => s.creaseDraft);
  const locked = useMazeStore((s) => s.backgroundAutoFillPreview !== null);
  const setHover = useMazeStore((s) => s.setCreaseHover);
  const startDraft = useMazeStore((s) => s.startCreaseDraft);
  const cancelDraft = useMazeStore((s) => s.cancelCreaseDraft);
  const remove = useMazeStore((s) => s.removeCrease);
  const clear = useMazeStore((s) => s.clearCreases);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const list = creases ?? [];

  return (
    <>
      <div style={styles.list}>
        {list.length === 0 && <div style={styles.empty}>{m["topology.no_creases"]()}</div>}
        {list.map((crease) => (
          <CreaseCell
            key={crease.id}
            crease={crease}
            cfg={fieldConfig}
            canEdit={!locked}
            onHover={setHover}
            onEdit={() => startDraft(crease.id)}
            onDelete={() => remove(crease.id)}
          />
        ))}
      </div>
      <Stack gap="groupGap" style={styles.body}>
        {draft === null ? (
          <Button variant="primary" disabled={locked} onClick={() => startDraft()}>
            {m["topology.crease_add"]()}
          </Button>
        ) : (
          <Button variant="secondary" onClick={cancelDraft}>
            {m["topology.crease_cancel"]()}
          </Button>
        )}
        <Button variant="destructive" disabled={locked || list.length === 0} onClick={() => setDeleteAllOpen(true)}>
          {m["topology.delete_all"]()}
        </Button>
        {draft !== null && (
          <WarningBubble severity="info" message={m[draft.a === null ? "topology.crease_set_a" : "topology.crease_set_b"]()} />
        )}
      </Stack>
      {deleteAllOpen && (
        <ConfirmModal
          message={m["topology.confirm_delete_all_creases"]()}
          onConfirm={() => {
            setDeleteAllOpen(false);
            clear();
          }}
          onCancel={() => setDeleteAllOpen(false)}
        />
      )}
    </>
  );
}

function CreaseCell({ crease, cfg, canEdit, onHover, onEdit, onDelete }: {
  crease: Crease;
  cfg: FieldConfig | undefined;
  canEdit: boolean;
  onHover: (id: number | null) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const title = m["topology.crease_title"]({ id: String(crease.id + 1) });
  return (
    <>
      <div data-testid="topology-crease" style={styles.cell} onMouseEnter={() => onHover(crease.id)} onMouseLeave={() => onHover(null)}>
        <div style={styles.titleRow}>
          <span style={typography.body}>{title}</span>
          <div style={styles.actions}>
            <EditIconButton title={m["topology.crease_edit"]()} disabled={!canEdit} onClick={onEdit} />
            <Tooltip content={m["topology.crease_remove"]()}>
              <button
                type="button"
                className="hoverable"
                disabled={!canEdit}
                aria-label={m["topology.crease_remove"]()}
                style={{ ...styles.iconButton, color: ui.text.error, ...(canEdit ? {} : { opacity: 0.4 }) }}
                onClick={() => setConfirmingRemove(true)}
              >
                <Trash2 size={16} style={styles.iconGlyph} />
              </button>
            </Tooltip>
          </div>
        </div>
        <div style={styles.cellBody}>
          <div style={styles.hint}>{m["topology.crease_end_a"]({ point: formatPoint(crease.a, cfg) })}</div>
          <div style={styles.hint}>{m["topology.crease_end_b"]({ point: formatPoint(crease.b, cfg) })}</div>
        </div>
      </div>
      {confirmingRemove && (
        <ConfirmModal
          message={m["topology.crease_remove_confirm"]({ id: String(crease.id + 1) })}
          onConfirm={() => { setConfirmingRemove(false); onDelete(); }}
          onCancel={() => setConfirmingRemove(false)}
        />
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: { padding: spacing.groupGap },
  list: { display: "flex", flexDirection: "column", borderTop: `1px solid ${ui.border.default}` },
  empty: { ...disabled(typography.body), textAlign: "center", padding: `${spacing.itemGap}px ${spacing.groupGap}px` },
  hint: { ...muted(typography.body) },
  cell: {
    display: "flex", flexDirection: "column", gap: spacing.itemGap / 2,
    padding: `${spacing.itemGap}px ${spacing.groupGap}px`,
    borderBottom: `1px solid ${ui.border.default}`,
  },
  cellBody: { display: "flex", flexDirection: "column", gap: spacing.itemGap / 2, paddingLeft: indent.tree },
  titleRow: { display: "flex", alignItems: "center", gap: spacing.itemGap, minWidth: 0 },
  actions: { display: "flex", alignItems: "center", gap: spacing.itemGap, marginLeft: "auto", flexShrink: 0 },
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
    lineHeight: 1,
    cursor: "default",
    flexShrink: 0,
  },
  iconGlyph: { pointerEvents: "none" },
};
