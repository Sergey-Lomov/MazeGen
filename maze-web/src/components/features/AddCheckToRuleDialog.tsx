import { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "../dialogs/ItemSelectDialog";
import { ParamFields } from "./ParamFields";
import { resolveCheckLabel, resolveCheckDescription, resolveIssueLabel, resolveParamLabel, resolveParamDescription } from "./qualityI18n";
import { colors, font, radius } from "../../styles/theme";
import * as m from "~/paraglide/messages";
import type { CheckVM } from "./useQualityViewModel";
import type { ParamDescriptor } from "../../wasm/types";

function defaultValue(p: ParamDescriptor): string {
  const k = p.kind;
  return k.type === "bool" ? (k.default ? "true" : "false") : String(k.default);
}

interface Props {
  ruleId: string;
  /** Issue kind shared by `candidates` and the target rule — shown in the dialog title. */
  kind: string;
  /** Not-yet-active checks sharing the rule's kind — candidates to activate into this rule. */
  candidates: CheckVM[];
  onClose: () => void;
}

/** Picker for the rule's own `+` (RulesColumn) — activates a not-yet-active check of this
 * rule's kind directly into this rule (not as a new singleton rule), merging its issues for
 * the rule's shared strategy. Unlike CheckSelectDialog (top-level "+", always creates a new
 * rule), this targets an existing rule. */
export function AddCheckToRuleDialog({ ruleId, kind, candidates, onClose }: Props) {
  const addCheck = useMazeStore((s) => s.addCheck);
  const [selectedId, setSelectedId] = useState<string>(candidates[0]?.id ?? "");
  // Param edits made in this dialog before the check is actually added — keyed by check id so
  // switching the selection and coming back preserves what was typed (mirrors CheckSelectDialog).
  const [paramOverrides, setParamOverrides] = useState<Record<string, Record<string, string>>>({});

  const selected = candidates.find((c) => c.id === selectedId);

  function handleParamChange(paramId: string, value: string) {
    setParamOverrides((prev) => ({
      ...prev,
      [selectedId]: { ...(prev[selectedId] ?? {}), [paramId]: value },
    }));
  }

  function handleAdd() {
    if (selectedId) {
      addCheck(selectedId, ruleId, paramOverrides[selectedId]);
      onClose();
    }
  }

  const items = candidates.map((c) => ({
    id: c.id,
    label: resolveCheckLabel(c.id, c.label),
  }));

  const rightPanel = selected ? (
    <>
      <div style={styles.description}>{resolveCheckDescription(selected.id, selected.description)}</div>
      {selected.params.length > 0 && (
        <div style={styles.paramsSection}>
          <div style={styles.paramsSeparator} />
          <ParamFields
            params={selected.params.map((p) => ({ ...p, label: resolveParamLabel(p.id, p.label) }))}
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

  const footer = (
    <>
      <button style={styles.btnSecondary} onClick={onClose}>{m["common.cancel"]()}</button>
      <button
        style={{ ...styles.btnPrimary, ...(!selectedId ? styles.btnDisabled : {}) }}
        disabled={!selectedId}
        onClick={handleAdd}
      >
        {m["check.add"]()}
      </button>
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
    />
  );
}

const styles: Record<string, React.CSSProperties> = {
  description: {
    fontSize: font.lg,
    color: colors.textFaint,
    lineHeight: 1.6,
  },
  empty: {
    fontSize: font.lg,
    color: colors.textVeryDim,
  },
  paramsSection: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  paramsSeparator: {
    borderTop: `1px solid ${colors.borderDim}`,
    marginBottom: 4,
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
