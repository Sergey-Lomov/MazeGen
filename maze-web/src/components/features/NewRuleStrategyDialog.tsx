import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "../dialogs/ItemSelectDialog";
import { WarningBubble } from "../WarningBubble";
import { ParamFields } from "./ParamFields";
import { resolveStrategyLabel, resolveStrategyDescription, resolveParamLabel, resolveParamDescription, resolveNestedSlotDescription, NO_FIX_STRATEGY_ID } from "./qualityI18n";
import { ui, radius, typography } from "../../styles/theme";
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

// "min,max" for interval params -- mirrors maze-core's `parse_param` Interval encoding
// (repair/params.rs).
function defaultValue(p: ParamDescriptor): string {
  const k = p.kind;
  if (k.type === "bool") return k.default ? "true" : "false";
  if (k.type === "interval") return `${k.default_min},${k.default_max}`;
  return String(k.default);
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
  // Same reasoning as `StrategySelectDialog`: a mandatory nested slot gets a default strategy
  // assigned automatically once the rule is created (see `createRule`/`setStrategy` in
  // generationSlice.ts), but there's no rule yet at this step to preview which one — just name
  // the slot and note that a default will be used. Shown in the same params section as regular
  // params, after them, same order as the rule's own card.
  const requiredNestedSlots = selectedStrategy?.nested_slots.filter((s) => s.min >= 1) ?? [];

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
    ...candidates.map((s) => ({ id: s.id, label: resolveStrategyLabel(s.id), warning: s.experimental })),
  ];

  const rightPanel = (
    <>
      {description && <div style={styles.description}>{description}</div>}
      {selectedStrategy?.experimental && <WarningBubble />}
      {selectedStrategy && (selectedStrategy.params.length > 0 || requiredNestedSlots.length > 0) && (
        <div style={styles.paramsSection}>
          <div style={styles.paramsSeparator} />
          {selectedStrategy.params.length > 0 && (
            <ParamFields
              params={selectedStrategy.params.map((p) => ({ ...p, label: resolveParamLabel(p.id, p.label) }))}
              getValue={(p) => paramOverrides[selectedId]?.[p.id] ?? defaultValue(p)}
              onChange={handleParamChange}
              getDescription={(p) => resolveParamDescription(p.id)}
            />
          )}
          {requiredNestedSlots.map((slot) => (
            <div key={slot.slot_id} style={styles.field}>
              <div style={styles.row}>
                <label style={styles.label}>{m["quality.nested_strategy.label"]()}</label>
              </div>
              {resolveNestedSlotDescription(slot.slot_id) && (
                <div style={styles.fieldDescription}>{resolveNestedSlotDescription(slot.slot_id)}</div>
              )}
              <div style={styles.nestedWarning}>
                <WarningBubble message={m["quality.nested_strategy.unconfigured_warning"]()} severity="info" />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );

  const footer = (
    <>
      <button className="hoverable" style={styles.btnSecondary} onClick={onBack}>{m["common.back"]()}</button>
      <button className="hoverable" style={styles.btnSecondary} onClick={onClose}>{m["common.cancel"]()}</button>
      <button className="hoverable-accent" style={styles.btnPrimary} onClick={handleConfirm}>{m["check.add"]()}</button>
    </>
  );

  return (
    <ItemSelectDialog
      title={m["quality.select_strategy"]()}
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
    ...typography.body,
    lineHeight: 1.6,
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  // `typography.message` — the theme's own "label"-weight token (body size, secondary color).
  label: {
    ...typography.message,
    flex: 1,
  },
  // Mirrors `ParamFields`'s own `field`/`description` styles, so the nested-slot row reads
  // like just another param row in the same list.
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  fieldDescription: {
    ...typography.caption,
    lineHeight: 1.4,
  },
  nestedWarning: {
    marginTop: 4,
  },
  // `gap: 16` matches `ParamFields`'s own inter-param gap (when descriptions are shown) — the
  // nested-slot row below renders as a sibling of `ParamFields`, not inside it, so this
  // section's own gap is what separates the last param from that row.
  paramsSection: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  paramsSeparator: {
    borderTop: `1px solid ${ui.border.default}`,
    marginBottom: 4,
  },
  btnPrimary: {
    ...typography.control,
    background: ui.accent.base,
    border: "none",
    color: ui.text.inverse,
    padding: "5px 12px",
    cursor: "default",
    borderRadius: radius.sm,
  },
  btnSecondary: {
    ...typography.control,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.secondary,
    padding: "5px 12px",
    cursor: "default",
    borderRadius: radius.sm,
  },
};
