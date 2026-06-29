import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "../dialogs/ItemSelectDialog";
import { ParamFields } from "./ParamFields";
import { resolveStrategyLabel, resolveStrategyDescription, resolveParamLabel, resolveParamDescription, NO_FIX_STRATEGY_ID } from "./qualityI18n";
import { ui, font, radius } from "../../styles/theme";
import * as m from "~/paraglide/messages";
import type { ParamDescriptor } from "../../wasm/types";

interface Props {
  /** Issue kind chosen in step 1 — only strategies handling this kind are listed. */
  kind: string;
  onBack: () => void;
  /** Step 3 confirm — finishes the "Add new rule" flow (see `RulesColumn`'s `createRule`
   * call); `strategyId` is `null` for "no fix" (logging only). */
  onConfirm: (strategyId: string | null, params: Record<string, string> | undefined) => void;
  onClose: () => void;
}

function defaultValue(p: ParamDescriptor): string {
  const k = p.kind;
  return k.type === "bool" ? (k.default ? "true" : "false") : String(k.default);
}

export function NewRuleStrategyDialog({ kind, onBack, onConfirm, onClose }: Props) {
  const availableStrategies = useMazeStore((s) => s.availableStrategies);
  const candidates = availableStrategies.filter((s) => s.handles === kind);
  // `scored_endpoints` is the preferred default for the start/finish kind (better-scored
  // placements than the first-listed random/farthest strategies) — same preference as the
  // registry's default-rule seeding in generationSlice.
  const defaultCandidate = candidates.find((s) => s.id === "scored_endpoints") ?? candidates[0];

  const [selectedId, setSelectedId] = useState<string>(defaultCandidate?.id ?? NO_FIX_STRATEGY_ID);
  const [paramOverrides, setParamOverrides] = useState<Record<string, Record<string, string>>>({});

  const selectedStrategy = candidates.find((s) => s.id === selectedId);
  const description = resolveStrategyDescription(selectedId);

  function handleParamChange(paramId: string, value: string) {
    setParamOverrides((prev) => ({
      ...prev,
      [selectedId]: { ...(prev[selectedId] ?? {}), [paramId]: value },
    }));
  }

  function handleConfirm() {
    if (selectedId === NO_FIX_STRATEGY_ID) {
      onConfirm(null, undefined);
    } else {
      onConfirm(selectedId, paramOverrides[selectedId]);
    }
  }

  const items = [
    { id: NO_FIX_STRATEGY_ID, label: resolveStrategyLabel(NO_FIX_STRATEGY_ID) },
    ...candidates.map((s) => ({ id: s.id, label: resolveStrategyLabel(s.id) })),
  ];

  const rightPanel = (
    <>
      {description && <div style={styles.description}>{description}</div>}
      {selectedStrategy && selectedStrategy.params.length > 0 && (
        <div style={styles.paramsSection}>
          <div style={styles.paramsSeparator} />
          <ParamFields
            params={selectedStrategy.params.map((p) => ({ ...p, label: resolveParamLabel(p.id, p.label) }))}
            getValue={(p) => paramOverrides[selectedId]?.[p.id] ?? defaultValue(p)}
            onChange={handleParamChange}
            getDescription={(p) => resolveParamDescription(p.id)}
          />
        </div>
      )}
    </>
  );

  const footer = (
    <>
      <button style={styles.btnSecondary} onClick={onBack}>{m["common.back"]()}</button>
      <button style={styles.btnSecondary} onClick={onClose}>{m["common.cancel"]()}</button>
      <button style={styles.btnPrimary} onClick={handleConfirm}>{m["check.add"]()}</button>
    </>
  );

  return (
    <ItemSelectDialog
      title={m["quality.select_strategy"]()}
      items={items}
      selectedId={selectedId}
      onSelectId={setSelectedId}
      selectedVariant="neutral"
      rightPanel={rightPanel}
      footer={footer}
      onClose={onClose}
    />
  );
}

const styles: Record<string, React.CSSProperties> = {
  description: {
    fontSize: font.lg,
    color: ui.text.tertiary,
    lineHeight: 1.6,
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
  btnPrimary: {
    background: ui.accent.base,
    border: "none",
    color: ui.text.inverse,
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.lg,
  },
  btnSecondary: {
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.secondary,
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.lg,
  },
};
