import React, { useState, useEffect, useMemo, useRef } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { CheckDescriptor, ParamDescriptor } from "../../wasm/types";
import { Modal } from "../Modal";
import { sharedStyles } from "../../styles/shared";
import { colors, font, radius, dialogSpacing } from "../../styles/theme";

interface Props {
  mode: "add" | "edit";
  initialCheckId: string;
  onClose: () => void;
}

function getDefaultValue(p: ParamDescriptor): string {
  const k = p.kind;
  if (k.type === "bool") return k.default ? "true" : "false";
  return String(k.default);
}

function clampValue(raw: string, p: ParamDescriptor): string {
  const k = p.kind;
  if (k.type === "float" || k.type === "integer") {
    const n = Number(raw);
    if (isNaN(n)) return String(k.default);
    return String(Math.min(k.max, Math.max(k.min, n)));
  }
  return raw;
}

export function CheckDetailsDialog({ mode, initialCheckId, onClose }: Props) {
  const availableChecks = useMazeStore((s) => s.availableChecks);
  const selectedChecks = useMazeStore((s) => s.selectedChecks);
  const checkParams = useMazeStore((s) => s.checkParams);
  const addCheck = useMazeStore((s) => s.addCheck);
  const removeCheck = useMazeStore((s) => s.removeCheck);
  const setCheckParam = useMazeStore((s) => s.setCheckParam);

  const initialId = useMemo((): string => {
    if (mode === "edit" && initialCheckId) return initialCheckId;
    return availableChecks.find((c) => !selectedChecks.includes(c.id))?.id ?? availableChecks[0]?.id ?? "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [selectedId, setSelectedId] = useState<string>(initialId);

  const selectedDescriptor: CheckDescriptor | undefined = availableChecks.find((c) => c.id === selectedId);

  const checkParamsRef = useRef(checkParams);
  checkParamsRef.current = checkParams;

  const buildLocalParams = (id: string): Record<string, string> => {
    const descriptor = availableChecks.find((c) => c.id === id);
    if (!descriptor) return {};
    const stored = checkParamsRef.current[id] ?? {};
    return Object.fromEntries(
      descriptor.params.map((p) => {
        const raw = stored[p.id] ?? getDefaultValue(p);
        return [p.id, clampValue(raw, p)];
      })
    );
  };

  const [localParams, setLocalParams] = useState<Record<string, string>>(() => buildLocalParams(initialId));

  useEffect(() => {
    setLocalParams(buildLocalParams(selectedId));
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  function commitLocalParams(id: string) {
    for (const [paramId, value] of Object.entries(localParams)) {
      setCheckParam(id, paramId, value);
    }
  }

  function handleAdd() {
    commitLocalParams(selectedId);
    addCheck(selectedId);
    onClose();
  }

  function handleAddAndContinue() {
    commitLocalParams(selectedId);
    addCheck(selectedId);
    const updatedSelected = useMazeStore.getState().selectedChecks;
    const next = availableChecks.find((c) => !updatedSelected.includes(c.id));
    if (!next) {
      onClose();
    } else {
      setSelectedId(next.id);
    }
  }

  function handleApply() {
    commitLocalParams(selectedId);
    onClose();
  }

  function handleDelete() {
    removeCheck(selectedId);
    onClose();
  }

  const hasParams = (selectedDescriptor?.params.length ?? 0) > 0;
  const title = mode === "add" ? "Add check" : "Check details";
  const size = mode === "add" ? "complex" : "info";

  const isDisabled = !selectedId || selectedChecks.includes(selectedId);

  const body = (
    <div style={styles.content}>
      {mode === "add" && (
        <div style={styles.leftCol}>
          {availableChecks.map((check) => {
            const isActive = selectedChecks.includes(check.id);
            const isSelected = check.id === selectedId;
            return (
              <button
                key={check.id}
                style={{
                  ...styles.checkItem,
                  ...(isSelected ? styles.checkItemSelected : {}),
                  ...(isActive ? styles.checkItemGreyed : {}),
                }}
                disabled={isActive}
                onClick={() => setSelectedId(check.id)}
              >
                {check.label}
              </button>
            );
          })}
        </div>
      )}
      <div style={styles.rightCol}>
        <div style={styles.checkInfo}>
          {selectedDescriptor ? (
            <>
              <div style={styles.checkLabel}>{selectedDescriptor.label}</div>
              <div style={styles.checkDescription}>{selectedDescriptor.description}</div>
              {hasParams && (
                <>
                  <div style={styles.paramsSeparator} />
                  {selectedDescriptor.params.map((p) => (
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
                          onChange={(e) => setLocalParams((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        />
                      )}
                      {p.kind.type === "bool" && (
                        <input
                          type="checkbox"
                          checked={(localParams[p.id] ?? getDefaultValue(p)) === "true"}
                          onChange={(e) => setLocalParams((prev) => ({ ...prev, [p.id]: e.target.checked ? "true" : "false" }))}
                        />
                      )}
                      {p.kind.type === "enum" && (
                        <select
                          style={styles.paramSelect}
                          value={localParams[p.id] ?? getDefaultValue(p)}
                          onChange={(e) => setLocalParams((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        >
                          {p.kind.options.map((opt) => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  ))}
                </>
              )}
            </>
          ) : (
            <div style={styles.checkDescription}>No check selected.</div>
          )}
        </div>
        <div style={styles.footer}>
          {mode === "add" ? (
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
          ) : (
            <>
              <button style={styles.btnSecondary} onClick={onClose}>Cancel</button>
              <button style={styles.btnDestructive} onClick={handleDelete}>Delete</button>
              {hasParams ? (
                <button style={styles.btnPrimary} onClick={handleApply}>Apply</button>
              ) : (
                <button style={styles.btnSecondary} onClick={onClose}>Close</button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );

  return <Modal title={title} size={size} rawBody={body} onClose={onClose} />;
}

const styles: Record<string, React.CSSProperties> = {
  content: {
    display: "flex",
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  leftCol: {
    width: 180,
    flexShrink: 0,
    borderRight: `1px solid ${colors.borderMid}`,
    overflowY: "auto" as const,
    padding: "8px 0",
    display: "flex",
    flexDirection: "column",
    gap: 1,
  },
  checkItem: {
    background: "none",
    border: "none",
    textAlign: "left" as const,
    padding: `6px ${dialogSpacing.paddingX}px`,
    fontSize: font.lg,
    color: colors.textMuted,
    cursor: "pointer",
    width: "100%",
  },
  checkItemSelected: {
    background: colors.bgBtnPrimary,
    color: colors.textWhite,
  },
  checkItemGreyed: {
    opacity: 0.4,
    cursor: "default",
  },
  rightCol: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
  },
  checkInfo: {
    flex: 1,
    overflowY: "auto" as const,
    padding: `${dialogSpacing.bodyPadding}px ${dialogSpacing.paddingX}px`,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
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
    padding: `${dialogSpacing.paddingY}px ${dialogSpacing.paddingX}px`,
    borderTop: `1px solid ${colors.borderMid}`,
    flexShrink: 0,
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
