import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "../dialogs/ItemSelectDialog";
import { Button } from "../Button";
import { WarningBubble } from "../WarningBubble";
import { ParamFields, isEntityVisible } from "./ParamFields";
import { useParamEditor } from "./useParamEditor";
import { resolveStrategyLabel, resolveStrategyDescription, resolveParamLabel, resolveParamDescription, resolveNestedSlotDescription, resolveNestedStrategyLabel, NO_FIX_STRATEGY_ID } from "./qualityI18n";
import { ui, radius, typography, spacing, inset } from "../../styles/theme";
import { Inline } from "../Layout";
import * as m from "~/paraglide/messages";
import type { ParamDescriptor, SplitPattern } from "../../wasm/types";
import { splitPatternsToWeb } from "../../pixi/tessellationGeometry";
import { activeFloorTessellationOf } from "../../store/storeHelpers";

// Mirrors `parseRuleSplitPatterns` in `RuleStrategyPanel.tsx` -- a malformed or missing
// `split_patterns` rule param reads as "no patterns" (empty topology), same "invalid falls back
// to empty" contract `parse_split_patterns_param` follows on the Rust side (GitHub issue #389).
function parseRuleSplitPatterns(raw: string | undefined, tessellationConfig: ReturnType<typeof activeFloorTessellationOf>): SplitPattern[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? splitPatternsToWeb(parsed, tessellationConfig) : [];
  } catch {
    return [];
  }
}

interface Props {
  ruleId: string;
  kind: string;
  onClose: () => void;
}

export function StrategySelectDialog({ ruleId, kind, onClose }: Props) {
  const availableStrategies = useMazeStore((s) => s.availableStrategies);
  const rules = useMazeStore((s) => s.rules);
  const setStrategy = useMazeStore((s) => s.setStrategy);
  const clearStrategy = useMazeStore((s) => s.clearStrategy);

  const rule = rules.find((r) => r.id === ruleId);
  const currentId = rule?.strategyId ?? NO_FIX_STRATEGY_ID;
  const [selectedId, setSelectedId] = useState<string>(currentId);
  const tessellationConfig = useMazeStore((s) => activeFloorTessellationOf(s));
  const floorCount = useMazeStore((s) => s.floors.length);
  const addSplitPatternsOverride = selectedId === "add_split"
    ? parseRuleSplitPatterns(rule?.params.split_patterns, tessellationConfig)
    : undefined;

  const candidates = availableStrategies
    .filter((s) => s.handles === kind)
    .filter((s) => isEntityVisible(s.visibility, floorCount));

  function handleSelect() {
    if (selectedId === NO_FIX_STRATEGY_ID) {
      clearStrategy(ruleId);
    } else {
      setStrategy(ruleId, selectedId);
    }
    onClose();
  }

  const items = [
    { id: NO_FIX_STRATEGY_ID, label: resolveStrategyLabel(NO_FIX_STRATEGY_ID) },
    ...candidates.map((s) => ({ id: s.id, label: resolveStrategyLabel(s.id), warning: s.experimental })),
  ];

  const selectedStrategy = candidates.find((s) => s.id === selectedId);
  const description = resolveStrategyDescription(selectedId);
  // A candidate with a mandatory nested slot (`min >= 1`) gets a default nested strategy assigned
  // automatically once selected (see `setStrategy` in generationSlice.ts — it fills every
  // mandatory slot with the first compatible candidate, recursively). This dialog can't show
  // which strategy that will be here (no rule assignment exists yet for the preview to read),
  // so it just names the slot and notes that a default will be used, changeable afterwards on
  // the rule's own card. Shown in the same params section as regular params, after them — same
  // order the rule's own card uses (`RuleStrategyPanel`: `ParamFields` then nested slots).
  const requiredNestedSlots = selectedStrategy?.nested_slots.filter((s) => s.min >= 1) ?? [];

  const rightPanel = (
    <>
      {description && <div style={styles.description}>{description}</div>}
      {selectedStrategy?.experimental && <WarningBubble />}
      {selectedStrategy && (selectedStrategy.params.length > 0 || requiredNestedSlots.length > 0) && (
        <div style={styles.paramsSection}>
          <div style={styles.paramsSeparator} />
          {selectedStrategy.params.length > 0 && (
            <StrategyParamPanel strategyId={selectedStrategy.id} params={selectedStrategy.params} addSplitPatternsOverride={addSplitPatternsOverride} />
          )}
          {requiredNestedSlots.map((slot) => (
            <div key={slot.slot_id} style={styles.field}>
              <Inline gap="rowGap" justify="space-between">
                <label style={styles.label}>{resolveNestedStrategyLabel(slot.kind, slot.slot_id)}</label>
              </Inline>
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
      <Button variant="secondary" layoutStyle={styles.btnSecondary} onClick={onClose}>{m["common.cancel"]()}</Button>
      <Button variant="primary" layoutStyle={styles.btnPrimary} onClick={handleSelect}>{m["common.select"]()}</Button>
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

function StrategyParamPanel({ strategyId, params, addSplitPatternsOverride }: { strategyId: string; params: ParamDescriptor[]; addSplitPatternsOverride?: SplitPattern[] }) {
  const strategyParams = useMazeStore((s) => s.strategyParams);
  const setStrategyParam = useMazeStore((s) => s.setStrategyParam);

  const localizedParams = params.map((p) => ({ ...p, label: resolveParamLabel(p.id, p.label, strategyId) }));
  const storeValues = strategyParams[strategyId] ?? {};
  const { values, onChange } = useParamEditor({
    entityId: strategyId,
    params: localizedParams,
    storeValues,
    onCommit: (paramId, value) => setStrategyParam(strategyId, paramId, value),
  });

  return (
    <ParamFields
      params={localizedParams}
      values={values}
      onChange={onChange}
      getDescription={(p) => resolveParamDescription(p.id, strategyId)}
      addSplitPatternsOverride={addSplitPatternsOverride}
    />
  );
}

const styles: Record<string, React.CSSProperties> = {
  description: {
    ...typography.body,
    lineHeight: 1.6,
    whiteSpace: "pre-line",
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
    gap: spacing.elementsGap,
  },
  fieldDescription: {
    ...typography.caption,
    lineHeight: 1.4,
  },
  nestedWarning: {
    marginTop: spacing.itemGap,
  },
  // `sectionGap` matches `ParamFields`'s own inter-param gap (when descriptions are shown) — the
  // nested-slot row below renders as a sibling of `StrategyParamPanel`'s `ParamFields`, not
  // inside it, so this section's own gap is what separates the last param from that row.
  paramsSection: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.sectionGap,
  },
  paramsSeparator: {
    borderTop: `1px solid ${ui.border.default}`,
    marginBottom: spacing.itemGap,
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
};
