import React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { useCheckParamsDraft, getDefaultValue } from "./useCheckParamsDraft";
import type { ParamDescriptor } from "../../wasm/types";
import { sharedStyles } from "../../styles/shared";
import { colors, font, radius, dialogSpacing } from "../../styles/theme";

interface Props {
  checkId: string;
  onClose: () => void;
}

export function CheckDetailsDialog({ checkId, onClose }: Props) {
  const availableChecks = useMazeStore((s) => s.availableChecks);
  const removeCheck = useMazeStore((s) => s.removeCheck);
  const draft = useCheckParamsDraft(checkId);

  const descriptor = availableChecks.find((c) => c.id === checkId);
  const hasParams = (descriptor?.params.length ?? 0) > 0;

  function handleApply() {
    draft.commit(checkId);
    onClose();
  }

  function handleDelete() {
    removeCheck(checkId);
    onClose();
  }

  return (
    <Modal title="Check details" size="info" onClose={onClose}>
      {descriptor ? (
        <>
          <div style={styles.checkLabel}>{descriptor.label}</div>
          <div style={styles.checkDescription}>{descriptor.description}</div>
          {hasParams && (
            <>
              <div style={styles.paramsSeparator} />
              {descriptor.params.map((p) => (
                <ParamField key={p.id} p={p} localParams={draft.localParams} setParam={draft.setParam} />
              ))}
            </>
          )}
        </>
      ) : (
        <div style={styles.checkDescription}>Check not found.</div>
      )}
      <div style={styles.footer}>
        <button style={styles.btnSecondary} onClick={onClose}>Cancel</button>
        <button style={styles.btnDestructive} onClick={handleDelete}>Delete</button>
        {hasParams ? (
          <button style={styles.btnPrimary} onClick={handleApply}>Apply</button>
        ) : (
          <button style={styles.btnSecondary} onClick={onClose}>Close</button>
        )}
      </div>
    </Modal>
  );
}

function ParamField({ p, localParams, setParam }: {
  p: ParamDescriptor;
  localParams: Record<string, string>;
  setParam: (id: string, v: string) => void;
}) {
  const value = localParams[p.id] ?? getDefaultValue(p);
  return (
    <div style={styles.paramRow}>
      <label style={styles.paramLabel}>{p.label}</label>
      {(p.kind.type === "float" || p.kind.type === "integer") && (
        <input
          type="number"
          style={styles.paramInput}
          value={value}
          min={p.kind.min}
          max={p.kind.max}
          step={p.kind.type === "integer" ? 1 : 0.1}
          onChange={(e) => setParam(p.id, e.target.value)}
        />
      )}
      {p.kind.type === "bool" && (
        <input
          type="checkbox"
          checked={value === "true"}
          onChange={(e) => setParam(p.id, e.target.checked ? "true" : "false")}
        />
      )}
      {p.kind.type === "enum" && (
        <select
          style={styles.paramSelect}
          value={value}
          onChange={(e) => setParam(p.id, e.target.value)}
        >
          {p.kind.options.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      )}
    </div>
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
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 6,
    paddingTop: dialogSpacing.paddingY,
    marginTop: "auto",
    borderTop: `1px solid ${colors.borderMid}`,
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
  btnDestructive: {
    background: colors.bgInput,
    border: `1px solid ${colors.textError}`,
    color: colors.textError,
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.lg,
  },
};
