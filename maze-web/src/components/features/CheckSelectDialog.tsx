import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "../dialogs/ItemSelectDialog";
import { Button } from "../Button";
import { ParamFields, isEntityVisible } from "./ParamFields";
import { resolveCheckLabel, resolveCheckDescription, resolveIssueLabel, resolveParamLabel, resolveParamDescription } from "./qualityI18n";
import { ui, radius, typography, disabled, spacing, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";
import type { ParamDescriptor } from "../../wasm/types";

interface Props {
  /** Issue kind chosen in step 1 (IssueSelectDialog) — only checks of this kind are listed. */
  kind: string;
  /** Shows a Back button that returns to step 1 (IssueSelectDialog) instead of closing. */
  onBack: () => void;
  /** Step 2 confirm — hands the chosen check id (with any param overrides) to step 3
   * (strategy pick), not the store. Nothing commits until the whole "Add new rule" flow
   * finishes (see `RulesColumn`'s `createRule` call). */
  onNext: (id: string, paramOverrides: Record<string, Record<string, string>>) => void;
  onClose: () => void;
}

// "min,max" for interval params -- mirrors maze-core's `parse_param` Interval encoding
// (repair/params.rs).
function defaultValue(p: ParamDescriptor): string {
  const k = p.kind;
  if (k.type === "bool") return k.default ? "true" : "false";
  if (k.type === "interval") return `${k.default_min},${k.default_max}`;
  if (k.type === "pattern_list") return "[]";
  if (k.type === "split_generation_config") return JSON.stringify({ pattern_mode: false, max_split_nodes: 2, patterns: [] });
  if (k.type === "add_split_config") return String(k.max_split_nodes_default);
  return String(k.default);
}

export function CheckSelectDialog({ kind, onBack, onNext, onClose }: Props) {
  const allChecks = useMazeStore((s) => s.availableChecks);
  const floorCount = useMazeStore((s) => s.floors.length);

  const availableChecks = allChecks
    .filter((c) => c.issue_kinds[0] === kind)
    .filter((c) => isEntityVisible(c.visibility, floorCount));
  // A type without `multiple instances` (every check, currently — see GitHub issue #60,
  // retired) can't be picked here if it's already active in some existing rule — adding it
  // anyway would be silently rejected by `createRule`.

  const [selectedId, setSelectedId] = useState<string>(availableChecks[0]?.id ?? "");
  // Param edits made in this dialog before the check is actually added — keyed by check id so
  // switching the selection and coming back preserves what was typed (mirrors useParamEditor's
  // per-entity values, but nothing commits to the store until the flow finishes).
  const [paramOverrides, setParamOverrides] = useState<Record<string, Record<string, string>>>({});

  const selectedCheck = availableChecks.find((c) => c.id === selectedId);

  function handleParamChange(paramId: string, value: string) {
    setParamOverrides((prev) => ({
      ...prev,
      [selectedId]: { ...(prev[selectedId] ?? {}), [paramId]: value },
    }));
  }

  function handleNext() {
    if (selectedId) {
      onNext(selectedId, paramOverrides);
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
      {selectedCheck.params.length > 0 && (
        <div style={styles.paramsSection}>
          <div style={styles.paramsSeparator} />
          <ParamFields
            params={selectedCheck.params.map((p) => ({ ...p, label: resolveParamLabel(p.id, p.label) }))}
            getValue={(p) => paramOverrides[selectedId]?.[p.id] ?? defaultValue(p)}
            onChange={handleParamChange}
            getDescription={(p) => resolveParamDescription(p.id, selectedCheck.id)}
          />
        </div>
      )}
    </>
  ) : (
    <div style={styles.empty}>{m["check.not_selected"]()}</div>
  );

  const canProceed = !!selectedId;

  const footer = (
    <>
      <Button variant="secondary" layoutStyle={styles.btnSecondary} onClick={onBack}>{m["common.back"]()}</Button>
      <Button variant="secondary" dialogAction layoutStyle={styles.btnSecondary} onClick={onClose}>{m["common.cancel"]()}</Button>
      <Button
        variant="primary"
        dialogAction
        layoutStyle={styles.btnPrimary}
        disabled={!canProceed}
        onClick={handleNext}
      >
        {m["common.next"]()}
      </Button>
    </>
  );

  return (
    <ItemSelectDialog
      title={m["quality.add_check_dialog_title"]({ issue: resolveIssueLabel(kind) })}
      items={items}
      selectedId={selectedId}
      onSelectId={setSelectedId}
      rightPanel={rightPanel}
      footer={footer}
      onClose={onClose}
      onConfirm={canProceed ? handleNext : undefined}
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
    marginTop: spacing.itemGap,
  },
  paramsSection: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap,
  },
  paramsSeparator: {
    borderTop: `1px solid ${ui.border.default}`,
    marginBottom: spacing.itemGap,
  },
  empty: {
    ...disabled(typography.caption),
  },
  btnPrimary: {
    ...typography.control,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
  btnSecondary: {
    ...typography.control,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
  btnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
};
