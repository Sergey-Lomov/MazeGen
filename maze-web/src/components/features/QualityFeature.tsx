import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { buttonStyle } from "../../styles/shared";
import { colors, font } from "../../styles/theme";
import { CheckSelectDialog } from "./CheckSelectDialog";
import { CheckDetailsDialog } from "./CheckDetailsDialog";

export function QualityFeature() {
  const availableChecks = useMazeStore((s) => s.availableChecks);
  const selectedChecks = useMazeStore((s) => s.selectedChecks);
  const removeCheck = useMazeStore((s) => s.removeCheck);

  const [addOpen, setAddOpen] = useState(false);
  const [editCheckId, setEditCheckId] = useState<string | null>(null);

  const activeDescriptors = selectedChecks
    .map((id) => availableChecks.find((c) => c.id === id))
    .filter(Boolean) as (typeof availableChecks)[number][];

  const canAdd = availableChecks.some((c) => !selectedChecks.includes(c.id));

  return (
    <div style={styles.root}>
      {activeDescriptors.length > 0 && (
        <div style={styles.list}>
          {activeDescriptors.map((check) => (
            <div key={check.id} style={styles.row}>
              <span style={styles.label}>{check.label}</span>
              <div style={styles.actions}>
                <button style={styles.iconBtn} onClick={() => setEditCheckId(check.id)} title="Details">ℹ</button>
                <button style={styles.iconBtn} onClick={() => removeCheck(check.id)} title="Remove">✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={activeDescriptors.length > 0 ? styles.addWrap : undefined}>
        <button
          style={{ ...buttonStyle("toggle"), width: "100%" }}
          onClick={() => setAddOpen(true)}
          disabled={!canAdd}
        >
          + Add check
        </button>
      </div>
      {addOpen && <CheckSelectDialog onClose={() => setAddOpen(false)} />}
      {editCheckId !== null && (
        <CheckDetailsDialog checkId={editCheckId} onClose={() => setEditCheckId(null)} />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
    padding: "2px 0",
  },
  label: {
    fontSize: font.xl,
    color: colors.textMuted,
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  actions: {
    display: "flex",
    gap: 2,
    flexShrink: 0,
  },
  iconBtn: {
    background: "none",
    border: "none",
    color: colors.textDim,
    cursor: "pointer",
    fontSize: font.xl,
    padding: "0 3px",
    lineHeight: 1,
  },
  addWrap: {
    borderTop: `1px solid ${colors.borderDim}`,
    paddingTop: 8,
  },
};
