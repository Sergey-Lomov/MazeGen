import React, { useState, useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "../dialogs/ItemSelectDialog";
import { useCheckParamsDraft, getDefaultValue } from "./useCheckParamsDraft";
import type { ParamDescriptor } from "../../wasm/types";
import { sharedStyles } from "../../styles/shared";
import { colors, font, radius } from "../../styles/theme";

interface Props {
  onClose: () => void;
}

export function CheckSelectDialog({ onClose }: Props) {
  const availableChecks = useMazeStore((s) => s.availableChecks);
  const selectedChecks = useMazeStore((s) => s.selectedChecks);
  const addCheck = useMazeStore((s) => s.addCheck);

  const initialId = useMemo(
    () => availableChecks.find((c) => !selectedChecks.includes(c.id))?.id ?? availableChecks[0]?.id ?? "",
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const [selectedId, setSelectedId] = useState<string>(initialId);
  const draft = useCheckParamsDraft(selectedId);

  const selectedDescriptor = availableChecks.find((c) => c.id === selectedId);
  const hasParams = (selectedDescriptor?.params.length ?? 0) > 0;
  const isDisabled = !selectedId || selectedChecks.includes(selectedId);

  function handleAdd() {
    draft.commit(selectedId);
    addCheck(selectedId);
    onClose();
  }

  function handleAddAndContinue() {
    draft.commit(selectedId);
    addCheck(selectedId);
    const updatedSelected = useMazeStore.getState().selectedChecks;
    const next = availableChecks.find((c) => !updatedSelected.includes(c.id));
    if (!next) {
      onClose();
    } else {
      setSelectedId(next.id);
    }
  }

  const items = availableChecks.map((c) => ({
    id: c.id,
    label: c.label,
    disabled: selectedChecks.includes(c.id),
  }));

  const rightPanel = (
    <>
      {selectedDescriptor ? (
        <>
          <div style={styles.checkLabel}>{selectedDescriptor.label}</div>
          <div style={styles.checkDescription}>{selectedDescriptor.description}</div>
          {hasParams && (
            <>
              <div style={styles.paramsSeparator} />
              <ParamFields params={selectedDescriptor.params} localParams={draft.localParams} setParam={draft.setParam} />
            </>
          )}
        </>
      ) : (
        <div style={styles.checkDescription}>No check selected.</div>
      )}
    </>
  );

  const footer = (
    <>
      <button style={styles.btnSecondary} onClick={onClose}>Cancel</button>
      <button
        style={isDisabled ? { ...styles.btnSecondary, ...sharedStyles.btnDisabled } : styles.btnSecondary}
        onClick={handleAddAndContinue}
        disabled={isDisabled}
      >
        Add and continue
      </button>
      <button
        style={isDisabled ? { ...styles.btnPrimary, ...sharedStyles.btnDisabled } : styles.btnPrimary}
        onClick={handleAdd}
        disabled={isDisabled}
      >
        Add
      </button>
    </>
  );

  return (
    <ItemSelectDialog
      title="Add check"
      items={items}
      selectedId={selectedId}
      onSelectId={setSelectedId}
      rightPanel={rightPanel}
      footer={footer}
      onClose={onClose}
    />
  );
}

function ParamFields({ params, localParams, setParam }: {
  params: ParamDescriptor[];
  localParams: Record<string, string>;
  setParam: (id: string, v: string) => void;
}) {
  return (
    <>
      {params.map((p) => (
        <div key={p.id} style={styles.paramRow}>
          <label style={styles.paramLabel}>{p.label}</label>
          {(p.kind.type === "float" || p.kind.type === "integer") && (
            <input
              type="number"
              style={styles.paramInput}
              value={localParams[p.id] ?? getDefaultValue(p)}
              min={p.kind.min}
              max={p.kind.max}
              step={p.kind.type === "integer" ? 1 : 0.1}
              onChange={(e) => setParam(p.id, e.target.value)}
            />
          )}
          {p.kind.type === "bool" && (
            <input
              type="checkbox"
              checked={(localParams[p.id] ?? getDefaultValue(p)) === "true"}
              onChange={(e) => setParam(p.id, e.target.checked ? "true" : "false")}
            />
          )}
          {p.kind.type === "enum" && (
            <select
              style={styles.paramSelect}
              value={localParams[p.id] ?? getDefaultValue(p)}
              onChange={(e) => setParam(p.id, e.target.value)}
            >
              {p.kind.options.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          )}
        </div>
      ))}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  checkLabel: {
    fontSize: font.xl,
    fontWeight: "bold" as const,
    color: colors.textSecondary,
  },
  checkDescription: {
    fontSize: font.lg,
    color: colors.textFaint,
    lineHeight: 1.5,
  },
  paramsSeparator: {
    borderTop: `1px solid ${colors.borderDim}`,
    marginTop: 4,
    marginBottom: 4,
  },
  paramRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  paramLabel: {
    fontSize: font.lg,
    color: colors.textMuted,
    flex: 1,
  },
  paramInput: {
    ...sharedStyles.inputSm,
    width: 80,
  },
  paramSelect: {
    ...sharedStyles.selectSm,
    width: 120,
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
};
