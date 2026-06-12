import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { buttonStyle } from "../../styles/shared";
import { colors, font } from "../../styles/theme";
import { CheckDetailsDialog } from "./CheckDetailsDialog";

export function QualityFeature() {
  const availableChecks = useMazeStore((s) => s.availableChecks);
  const selectedChecks = useMazeStore((s) => s.selectedChecks);
  const removeCheck = useMazeStore((s) => s.removeCheck);

  const [dialogMode, setDialogMode] = useState<"add" | "edit" | null>(null);
  const [dialogCheckId, setDialogCheckId] = useState<string>("");

  function openEdit(id: string) {
    setDialogCheckId(id);
    setDialogMode("edit");
  }

  function openAdd() {
    setDialogMode("add");
    setDialogCheckId("");
  }

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
                <button style={styles.iconBtn} onClick={() => openEdit(check.id)} title="Details">ℹ</button>
                <button style={styles.iconBtn} onClick={() => removeCheck(check.id)} title="Remove">✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={activeDescriptors.length > 0 ? styles.addWrap : undefined}>
        <button
          style={{ ...buttonStyle("toggle"), width: "100%" }}
          onClick={openAdd}
          disabled={!canAdd}
        >
          + Add check
        </button>
      </div>
      {dialogMode !== null && (
        <CheckDetailsDialog
          mode={dialogMode}
          initialCheckId={dialogCheckId}
          onClose={() => setDialogMode(null)}
        />
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
