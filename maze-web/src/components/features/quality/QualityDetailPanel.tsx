import React from "react";
import { useMazeStore } from "../../../store/mazeStore";
import { ParamizedDetail } from "./ParamizedDetail";
import { NestedStrategyPanel, findRawNested } from "./NestedStrategyPanel";
import { resolveStrategyDescription, resolveParamLabel, resolveParamDescription, resolveParamOptionLabel, resolveParamOptionExplanation, resolvePriorityOptionLabel } from "../qualityI18n";
import { PRIORITY_LEVELS } from "../ParamFields";
import * as m from "~/paraglide/messages";
import { qualityCanvasStyles as styles } from "./qualityCanvasStyles";
import { spacing } from "../../../styles/theme";
import { entriesForSlot, type PathSegment } from "../../../store/storeTypes";
import { addVerticalPassageOverrides } from "./addVerticalPassageOverrides";
import type { useQualityViewModel, NestedStrategyVM } from "../useQualityViewModel";
import type { QualitySelection } from "./types";
import type { ParamDescriptor } from "../../../wasm/types";

interface Props {
  selection: QualitySelection;
  vm: ReturnType<typeof useQualityViewModel>;
  flushRef: React.MutableRefObject<() => void>;
  onSelect: (s: QualitySelection) => void;
}

// Walks a `StrategySlotVM`'s `nestedStrategies` tree down `path`, the same `(slotId, index)`
// chain `NestedStrategyPanel.findRawNested` walks over the raw store state — this one resolves
// the view-model side instead, since the detail panel needs the fully-resolved
// `NestedStrategyVM` (label/description/params), not the raw store node. Exported for direct
// unit testing — pure, no React/store involved.
export function resolveNestedStrategyVM(topLevel: NestedStrategyVM[], path: PathSegment[]): NestedStrategyVM | undefined {
  let list = topLevel;
  let found: NestedStrategyVM | undefined;
  for (const { slotId, index } of path) {
    found = entriesForSlot(list, slotId)[index];
    if (!found) return undefined;
    list = found.nested;
  }
  return found;
}

export function QualityDetailPanel({ selection, vm, flushRef, onSelect }: Props) {
  const rules = useMazeStore((s) => s.rules);
  const setCheckParam = useMazeStore((s) => s.setCheckParam);
  const strategyParams = useMazeStore((s) => s.strategyParams);
  const setStrategyParam = useMazeStore((s) => s.setStrategyParam);
  const setNestedStrategyParam = useMazeStore((s) => s.setNestedStrategyParam);
  const availableRuleParams = useMazeStore((s) => s.availableRuleParams);

  if (!selection) {
    return (
      <div style={styles.detailPanel}>
        <span style={styles.detailEmpty}>{m["quality.select_to_view"]()}</span>
      </div>
    );
  }

  if (selection.type === "check") {
    const check = vm.checks.find((c) => c.id === selection.id);
    if (!check) return <div style={styles.detailPanel} />;
    const storeValues = rules.find((r) => r.id === check.ruleId)?.checks.find((c) => c.localId === check.localId)?.params ?? {};
    return (
      <ParamizedDetail
        id={check.id}
        label={check.cardLabel}
        description={check.description}
        params={check.params}
        storeValues={storeValues}
        onCommit={(paramId, value) => setCheckParam(check.ruleId, check.localId, paramId, value)}
        flushRef={flushRef}
      />
    );
  }

  if (selection.type === "logging") {
    return (
      <div style={styles.detailPanel}>
        <span style={styles.detailTitle}>{m["strategy.no_fix.label"]()}</span>
        <p style={styles.detailDesc}>{m["strategy.no_fix.description"]()}</p>
      </div>
    );
  }

  if (selection.type === "strategy") {
    const slot = vm.strategySlots.find((s) => s.ruleId === selection.ruleId);
    const strategy = slot?.strategy;
    if (!strategy) return <div style={styles.detailPanel} />;
    const passageOverrides = strategy.id === "add_vertical_passage"
      ? addVerticalPassageOverrides(slot.params.passage_type)
      : null;
    return (
      <ParamizedDetail
        id={strategy.id}
        label={strategy.label}
        description={resolveStrategyDescription(strategy.id)}
        warning={strategy.experimental}
        params={strategy.params}
        storeValues={strategyParams[strategy.id] ?? {}}
        onCommit={(paramId, value) => setStrategyParam(strategy.id, paramId, value)}
        flushRef={flushRef}
        contextId={strategy.id}
        valueOverrides={passageOverrides?.values}
        disabledIds={passageOverrides?.disabledIds}
      >
        {strategy.nestedSlots.length > 0 && (
          // Same visual gap as between two params in `ParamFields` (`gap: 16` when descriptions
          // are shown) — `detailPanel`'s own `gap: 8` between direct children already accounts
          // for half of it, so only 8px more is added here, not a divider.
          <div style={{ display: "flex", flexDirection: "column", gap: spacing.sectionGap, marginTop: spacing.groupGap }}>
            {strategy.nestedSlots.map((slotDesc) => (
              <NestedStrategyPanel
                key={slotDesc.slotId}
                ruleId={slot.ruleId}
                path={[{ slotId: slotDesc.slotId, index: 0 }]}
                slotDesc={slotDesc}
                entries={entriesForSlot(slot.nestedStrategies, slotDesc.slotId)}
                depth={1}
                selection={selection}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </ParamizedDetail>
    );
  }

  if (selection.type === "nested_strategy") {
    const slot = vm.strategySlots.find((s) => s.ruleId === selection.ruleId);
    const node = slot ? resolveNestedStrategyVM(slot.nestedStrategies, selection.path) : undefined;
    if (!slot || !node) return <div style={styles.detailPanel} />;
    const { path } = selection;
    const rawNested = findRawNested(rules.find((r) => r.id === selection.ruleId), path);
    return (
      <ParamizedDetail
        // Includes `node.strategy.id` — see `NestedStrategyPanel`'s matching `entityId` comment:
        // without it, `useParamEditor`'s reset effect doesn't fire when this same path's
        // strategy is swapped via the edit dialog, leaving stale param values displayed.
        id={`${selection.ruleId}:${path.map((p) => `${p.slotId}.${p.index}`).join(".")}:${node.strategy.id}`}
        label={node.strategy.label}
        description={resolveStrategyDescription(node.strategy.id)}
        warning={node.strategy.experimental}
        params={node.params}
        storeValues={rawNested?.params ?? {}}
        onCommit={(paramId, value) => setNestedStrategyParam(selection.ruleId, path, paramId, value)}
        flushRef={flushRef}
        contextId={node.strategy.id}
      >
        {node.strategy.nestedSlots.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: spacing.sectionGap, marginTop: spacing.groupGap }}>
            {node.strategy.nestedSlots.map((childSlotDesc) => (
              <NestedStrategyPanel
                key={childSlotDesc.slotId}
                ruleId={selection.ruleId}
                path={[...path, { slotId: childSlotDesc.slotId, index: 0 }]}
                slotDesc={childSlotDesc}
                entries={entriesForSlot(node.nested, childSlotDesc.slotId)}
                depth={1}
                selection={selection}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </ParamizedDetail>
    );
  }

  if (selection.type === "param") {
    const { owner, paramId } = selection;
    let param: ParamDescriptor | undefined;
    let contextId: string | undefined;

    if (owner.kind === "check") {
      const check = vm.checks.find((c) => c.id === owner.checkId);
      param = check?.params.find((p) => p.id === paramId);
    } else if (owner.kind === "strategy") {
      const strategy = vm.strategySlots.find((s) => s.ruleId === owner.ruleId)?.strategy;
      param = strategy?.params.find((p) => p.id === paramId);
      contextId = strategy?.id;
    } else if (owner.kind === "nested_strategy") {
      const slot = vm.strategySlots.find((s) => s.ruleId === owner.ruleId);
      const node = slot ? resolveNestedStrategyVM(slot.nestedStrategies, owner.path) : undefined;
      param = node?.params.find((p) => p.id === paramId);
      contextId = node?.strategy.id;
    } else {
      const descriptor = availableRuleParams.find((p) => p.id === paramId);
      param = descriptor ? { id: descriptor.id, label: resolveParamLabel(descriptor.id, descriptor.label), kind: descriptor.kind } : undefined;
    }

    if (!param) return <div style={styles.detailPanel} />;
    return (
      <div style={styles.detailPanel}>
        <span style={styles.detailTitle}>{param.label}</span>
        <p style={styles.detailDesc}>{resolveParamDescription(param.id, contextId)}</p>
        {param.kind.type === "enum" && (
          <ul style={styles.optionList}>
            {param.kind.options.map((opt) => {
              const explanation = resolveParamOptionExplanation(param.id, opt, contextId);
              if (!explanation) return null;
              return (
                <li key={opt}>
                  <strong>{resolveParamOptionLabel(param.id, opt)}</strong> — {explanation}
                </li>
              );
            })}
          </ul>
        )}
        {param.kind.type === "priority" && (
          <ul style={styles.optionList}>
            {PRIORITY_LEVELS.map((opt) => {
              const explanation = resolveParamOptionExplanation(param.id, opt, contextId);
              if (!explanation) return null;
              return (
                <li key={opt}>
                  <strong>{resolvePriorityOptionLabel(opt)}</strong> — {explanation}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  return <div style={styles.detailPanel} />;
}
