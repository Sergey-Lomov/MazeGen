import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "../dialogs/ItemSelectDialog";
import { ParamFields } from "./ParamFields";
import { resolveCheckLabel, resolveCheckDescription, resolveIssueLabel, resolveParamLabel, resolveParamDescription } from "./qualityI18n";
import { ui, radius, typography, disabled } from "../../styles/theme";
import * as m from "~/paraglide/messages";
import type { ParamDescriptor } from "../../wasm/types";
import { isTypeAlreadyActive } from "../../store/slices/generationSlice";

interface Props {
  /** Issue kind chosen in step 1 (IssueSelectDialog) — only checks of this kind are listed. */
  kind: string;
  /** Shows a Back button that returns to step 1 (IssueSelectDialog) instead of closing. */
  onBack: () => void;
  /** Step 2 confirm — hands the chosen check ids (with any param overrides) to step 3
   * (strategy pick), not the store. Nothing commits until the whole "Add new rule" flow
   * finishes (see `RulesColumn`'s `createRule` call). */
  onNext: (ids: string[], paramOverrides: Record<string, Record<string, string>>) => void;
  onClose: () => void;
}

function defaultValue(p: ParamDescriptor): string {
  const k = p.kind;
  return k.type === "bool" ? (k.default ? "true" : "false") : String(k.default);
}

export function CheckSelectDialog({ kind, onBack, onNext, onClose }: Props) {
  const allChecks = useMazeStore((s) => s.availableChecks);
  const rules = useMazeStore((s) => s.rules);

  const availableChecks = allChecks.filter((c) => c.issue_kinds[0] === kind);
  // A type without `allow_multiple_instances` (every check, currently — see GitHub issue #60,
  // retired) can't be picked here if it's already active in some existing rule — adding it
  // anyway would be silently rejected by `createRule`.
  const isAlreadyActive = (id: string) => isTypeAlreadyActive(rules, id);

  const [selectedId, setSelectedId] = useState<string>(availableChecks[0]?.id ?? "");
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  // Param edits made in this dialog before the check is actually added — keyed by check id so
  // switching the selection and coming back preserves what was typed (mirrors useParamEditor's
  // per-entity values, but nothing commits to the store until the flow finishes).
  const [paramOverrides, setParamOverrides] = useState<Record<string, Record<string, string>>>({});

  const selectedCheck = availableChecks.find((c) => c.id === selectedId);

  function toggleChecked(id: string) {
    const descriptor = availableChecks.find((c) => c.id === id);
    if (descriptor && !descriptor.allow_multiple_instances && isAlreadyActive(id)) return;
    setCheckedIds((prev) => prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]);
  }

  function handleParamChange(paramId: string, value: string) {
    setParamOverrides((prev) => ({
      ...prev,
      [selectedId]: { ...(prev[selectedId] ?? {}), [paramId]: value },
    }));
  }

  function handleNext() {
    if (checkedIds.length > 0) {
      onNext(checkedIds, paramOverrides);
    }
  }

  const items = availableChecks.map((c) => ({
    id: c.id,
    label: resolveCheckLabel(c.id, c.label),
    disabled: !c.allow_multiple_instances && isAlreadyActive(c.id),
    checked: checkedIds.includes(c.id),
  }));

  const rightPanel = selectedCheck ? (
    <>
      <div style={styles.description}>
        {resolveCheckDescription(selectedCheck.id, selectedCheck.description)}
      </div>
      {!selectedCheck.allow_multiple_instances && isAlreadyActive(selectedCheck.id) && (
        <div style={styles.alreadyActive}>{m["check.already_active"]()}</div>
      )}
      {selectedCheck.params.length > 0 && (
        <div style={styles.paramsSection}>
          <div style={styles.paramsSeparator} />
          <ParamFields
            params={selectedCheck.params.map((p) => ({ ...p, label: resolveParamLabel(p.id, p.label) }))}
            getValue={(p) => paramOverrides[selectedId]?.[p.id] ?? defaultValue(p)}
            onChange={handleParamChange}
            getDescription={(p) => resolveParamDescription(p.id)}
          />
        </div>
      )}
    </>
  ) : (
    <div style={styles.empty}>{m["check.not_selected"]()}</div>
  );

  const canProceed = checkedIds.length > 0;

  const footer = (
    <>
      <button style={styles.btnSecondary} onClick={onBack}>{m["common.back"]()}</button>
      <button style={styles.btnSecondary} onClick={onClose}>{m["common.cancel"]()}</button>
      <button
        style={{ ...styles.btnPrimary, ...(!canProceed ? styles.btnDisabled : {}) }}
        disabled={!canProceed}
        onClick={handleNext}
      >
        {m["common.next"]()}
      </button>
    </>
  );

  return (
    <ItemSelectDialog
      title={m["quality.add_check_dialog_title"]({ issue: resolveIssueLabel(kind) })}
      items={items}
      selectedId={selectedId}
      onSelectId={setSelectedId}
      onToggleChecked={toggleChecked}
      selectedVariant="neutral"
      rightPanel={rightPanel}
      footer={footer}
      onClose={onClose}
    />
  );
}

const styles: Record<string, React.CSSProperties> = {
  description: {
    ...typography.body,
    lineHeight: 1.6,
  },
  alreadyActive: {
    ...typography.body,
    color: ui.text.error,
    marginTop: 4,
  },
  paramsSection: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  paramsSeparator: {
    borderTop: `1px solid ${ui.border.default}`,
    marginBottom: 4,
  },
  empty: {
    ...disabled(typography.caption),
  },
  btnPrimary: {
    ...typography.control,
    background: ui.accent.base,
    border: "none",
    color: ui.text.inverse,
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
  },
  btnSecondary: {
    ...typography.control,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.secondary,
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
  },
  btnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
};
