import { useState } from "react";
import { useMazeStore } from "../../../store/mazeStore";
import { useParamEditor } from "../useParamEditor";
import { ParamFields } from "../ParamFields";
import { Switch } from "../../Switch";
import { WarningIcon } from "../../WarningIcon";
import * as m from "~/paraglide/messages";
import { qualityCanvasStyles as styles } from "./qualityCanvasStyles";
import { NestedStrategyPanel } from "./NestedStrategyPanel";
import { entriesForSlot } from "../../../store/storeTypes";
import { addVerticalPassageOverrides } from "./addVerticalPassageOverrides";
import { splitPatternsToWeb } from "../../../pixi/tessellationGeometry";
import { activeFloorTessellationOf } from "../../../store/storeHelpers";
import type { StrategySlotVM } from "../useQualityViewModel";
import type { QualitySelection } from "./types";

// Mirrors `getPatterns` in `ParamFields.tsx` -- a malformed or missing `split_patterns` rule
// param reads as "no patterns" (empty topology), same "invalid falls back to empty" contract
// `parse_split_patterns_param` follows on the Rust side (GitHub issue #389).
function parseRuleSplitPatterns(raw: string | undefined, tessellationConfig: ReturnType<typeof activeFloorTessellationOf>) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? splitPatternsToWeb(parsed, tessellationConfig) : [];
  } catch {
    return [];
  }
}

interface Props {
  slot: StrategySlotVM;
  selected: boolean;
  /** Current whole-canvas selection — passed through to `NestedStrategyPanel` so it can
   * independently compute whether one of its own nested slots is selected. */
  selection: QualitySelection;
  onSelect: (s: QualitySelection) => void;
  onEdit: () => void;
}

// Right half of a rule card. Strategy identity/toggle/edit plus its params inline, the same
// way GenerationFeature shows the active method's params under it — kept separate from the
// checks list so disabling/configuring the fix is visually independent from the checks
// themselves (the checks still run; only the repair step is what gets toggled here).
export function RuleStrategyPanel({ slot, selected, selection, onSelect, onEdit }: Props) {
  const toggleStrategyDisabled = useMazeStore((s) => s.toggleStrategyDisabled);
  const strategyParams = useMazeStore((s) => s.strategyParams);
  const setStrategyParam = useMazeStore((s) => s.setStrategyParam);

  const strategy = slot.strategy;
  const { values, onChange, flushRef } = useParamEditor({
    entityId: strategy?.id ?? "",
    params: strategy?.params ?? [],
    storeValues: strategy ? (strategyParams[strategy.id] ?? {}) : {},
    onCommit: (paramId, value) => {
      if (strategy) setStrategyParam(strategy.id, paramId, value);
    },
  });

  const [headerHovered, setHeaderHovered] = useState(false);

  const passageOverrides = strategy?.id === "add_vertical_passage"
    ? addVerticalPassageOverrides(slot.params.passage_type)
    : null;
  const displayValues = passageOverrides ? { ...values, ...passageOverrides.values } : values;

  const tessellationConfig = useMazeStore((s) => activeFloorTessellationOf(s));
  const addSplitPatternsOverride = strategy?.id === "add_split"
    ? parseRuleSplitPatterns(slot.params.split_patterns, tessellationConfig)
    : undefined;

  return (
    <div style={{ ...styles.ruleStrategyPanel, ...(slot.disabled ? styles.strategyDisabled : {}) }}>
      <div
        style={{
          ...styles.ruleStrategyHeader,
          ...(headerHovered ? styles.ruleStrategyHeaderHover : {}),
          ...(selected ? styles.ruleStrategyHeaderSelected : {}),
        }}
        onMouseEnter={() => setHeaderHovered(true)}
        onMouseLeave={() => setHeaderHovered(false)}
      >
        <span
          style={{ ...styles.cardLabel, cursor: "default" }}
          onClick={() => {
            flushRef.current();
            if (strategy) onSelect({ type: "strategy", ruleId: slot.ruleId, strategyId: strategy.id });
            else onSelect({ type: "logging", ruleId: slot.ruleId });
          }}
        >
          {strategy ? strategy.label : m["strategy.no_fix.label"]()}
        </span>
        {strategy?.experimental && <WarningIcon />}
        {strategy && (
          <div
            style={styles.toggleWrap}
            title={slot.disabled ? m["quality.enable_strategy"]() : m["quality.disable_strategy"]()}
          >
            <Switch checked={!slot.disabled} onChange={() => { flushRef.current(); toggleStrategyDisabled(slot.ruleId); }} />
          </div>
        )}
        <button className="hoverable" style={styles.editBtn} title={m["quality.edit_strategy"]()} onClick={() => { flushRef.current(); onEdit(); }}>✎</button>
      </div>
      {strategy && (strategy.params.length > 0 || strategy.nestedSlots.length > 0) && (
        <div style={styles.ruleStrategyParams}>
          <ParamFields
            params={strategy.params}
            values={displayValues}
            onChange={onChange}
            disabledIds={passageOverrides?.disabledIds}
            addSplitPatternsOverride={addSplitPatternsOverride}
          />
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
    </div>
  );
}
