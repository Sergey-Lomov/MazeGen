import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "../dialogs/ItemSelectDialog";
import { resolveCheckLabel, resolveCheckDescription } from "./qualityI18n";
import { colors, font, radius } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

export function CheckSelectDialog({ onClose }: Props) {
  const availableChecks = useMazeStore((s) => s.availableChecks);
  const selectedChecks = useMazeStore((s) => s.selectedChecks);
  const addCheck = useMazeStore((s) => s.addCheck);

  const [selectedId, setSelectedId] = useState<string>(availableChecks[0]?.id ?? "");

  const selectedCheck = availableChecks.find((c) => c.id === selectedId);
  const isAlreadyActive = selectedId ? selectedChecks.includes(selectedId) : false;

  function handleAdd() {
    if (selectedId && !isAlreadyActive) {
      addCheck(selectedId);
      onClose();
    }
  }

  const items = availableChecks.map((c) => ({
    id: c.id,
    label: resolveCheckLabel(c.id, c.label),
  }));

  const rightPanel = selectedCheck ? (
    <>
      <div style={styles.description}>
        {resolveCheckDescription(selectedCheck.id, selectedCheck.description)}
      </div>
      {isAlreadyActive && (
        <div style={styles.alreadyActive}>{m["check.already_active"]()}</div>
      )}
    </>
  ) : (
    <div style={styles.empty}>{m["check.not_selected"]()}</div>
  );

  const canAdd = !!selectedId && !isAlreadyActive;

  const footer = (
    <>
      <button style={styles.btnSecondary} onClick={onClose}>{m["common.cancel"]()}</button>
      <button
        style={{ ...styles.btnPrimary, ...(!canAdd ? styles.btnDisabled : {}) }}
        disabled={!canAdd}
        onClick={handleAdd}
      >
        {m["check.add"]()}
      </button>
    </>
  );

  return (
    <ItemSelectDialog
      title={m["check.add_title"]()}
      items={items}
      selectedId={selectedId}
      onSelectId={setSelectedId}
      rightPanel={rightPanel}
      footer={footer}
      onClose={onClose}
    />
  );
}

const styles: Record<string, React.CSSProperties> = {
  description: {
    fontSize: font.lg,
    color: colors.textFaint,
    lineHeight: 1.6,
  },
  alreadyActive: {
    fontSize: font.md,
    color: colors.textError,
    marginTop: 4,
  },
  empty: {
    fontSize: font.lg,
    color: colors.textVeryDim,
  },
  btnPrimary: {
    background: colors.bgBtnPrimary,
    border: "none",
    color: colors.textWhite,
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.lg,
  },
  btnSecondary: {
    background: colors.bgInput,
    border: `1px solid ${colors.borderStrong}`,
    color: colors.textMuted,
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.lg,
  },
  btnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
};
