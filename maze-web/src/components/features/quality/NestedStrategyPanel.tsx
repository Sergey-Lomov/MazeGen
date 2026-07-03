import { useState } from "react";
import { useMazeStore } from "../../../store/mazeStore";
import { useParamEditor } from "../useParamEditor";
import { ParamFields } from "../ParamFields";
import { WarningIcon } from "../../WarningIcon";
import { NestedStrategySelectDialog } from "./NestedStrategySelectDialog";
import * as m from "~/paraglide/messages";
import { ui, typography } from "../../../styles/theme";
import { resolveStrategyLabel } from "../qualityI18n";
import type { NestedStrategyVM, NestedSlotVM } from "../useQualityViewModel";
import { MAX_NESTED_STRATEGY_DEPTH, type NestedStrategyState, type QcRuleState } from "../../../store/storeTypes";
import type { QualitySelection } from "./types";

// Walks the raw store tree (not the resolved view-model) down `path` to find this panel's own
// `NestedStrategyState` — `useParamEditor` needs the actual stored param overrides
// (`Record<string, string>`), which only exist on the raw state, not on `NestedStrategyVM`
// (whose `params: ParamDescriptor[]` is the resolved descriptor, mirroring
// `StrategySlotVM.strategy.params`'s same role for the top-level strategy). Exported for
// `QualityDetailPanel`'s `"nested_strategy"` selection case, which needs the same raw lookup to
// pass real `storeValues` into `ParamizedDetail`.
export function findRawNested(rule: QcRuleState | undefined, path: string[]): NestedStrategyState | undefined {
  let list = rule?.nestedStrategies;
  let found: NestedStrategyState | undefined;
  for (const slotId of path) {
    found = list?.find((n) => n.slotId === slotId);
    list = found?.nested;
  }
  return found;
}

interface Props {
  ruleId: string;
  /** Chain of slot ids leading to this panel's own slot — see `setNestedStrategy`'s doc
   * comment in storeTypes.ts. `path[path.length - 1]` is this panel's own `slotDesc.slotId`. */
  path: string[];
  slotDesc: NestedSlotVM;
  node: NestedStrategyVM | null;
  /** Indentation level — 1 for the slot directly under a rule's top-level strategy, 2 for a
   * slot under that nested strategy, and so on. Only the params/child-slot rows are indented
   * by this — the "which strategy fills this slot" row itself renders at the same level as any
   * other parameter of the strategy that owns this slot (see `styles.row` below, shared with
   * `ParamFields`'s own row style), so it reads as an equal-standing parameter, not a nested
   * sub-panel. */
  depth: number;
  /** Current selection, compared against this panel's own `(ruleId, path)` to compute whether
   * it's the selected row — passed down whole (not a pre-computed `selected` boolean) so each
   * recursive instance can independently check its own `path` against it. */
  selection: QualitySelection;
  onSelect: (s: QualitySelection) => void;
}

// Exported for direct unit testing — pure, no React/store involved.
export function pathsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Renders one nested-strategy slot: a param-row-styled line showing the assigned strategy's name
// plus an edit (✎) button — the same "name + edit icon" pattern `RuleStrategyPanel` uses for the
// top-level strategy, rather than a dropdown (a strategy name rarely fits a dropdown-sized box).
// The edit button opens `NestedStrategySelectDialog` (same modal shape as the top-level
// `StrategySelectDialog` but without a "no fix" entry — a nested slot always needs an actual
// strategy). Clicking the strategy name selects this slot (shows its description/params in the
// detail panel — see `QualityDetailPanel`'s `"nested_strategy"` case), same interaction as
// `RuleStrategyPanel`'s own clickable name. The selected strategy's own params render indented
// under it, and — if that strategy itself declares nested slots — one more `NestedStrategyPanel`
// per such slot, recursively.
export function NestedStrategyPanel({ ruleId, path, slotDesc, node, depth, selection, onSelect }: Props) {
  const setNestedStrategyParam = useMazeStore((s) => s.setNestedStrategyParam);
  const rawNested = useMazeStore((s) => findRawNested(s.rules.find((r) => r.id === ruleId), path));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const selected = selection?.type === "nested_strategy" && selection.ruleId === ruleId && pathsEqual(selection.path, path);

  const { values, onChange, flushRef } = useParamEditor({
    entityId: node ? `${ruleId}:${path.join(".")}` : "",
    params: node?.params ?? [],
    storeValues: rawNested?.params ?? {},
    onCommit: (paramId, value) => {
      setNestedStrategyParam(ruleId, path, paramId, value);
    },
  });

  return (
    <>
      <div
        style={{
          ...styles.row,
          ...(hovered ? styles.rowHover : {}),
          ...(selected ? styles.rowSelected : {}),
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <label style={styles.label}>{m["quality.nested_strategy.label"]()}</label>
        <span
          style={{ ...styles.strategyName, cursor: "pointer" }}
          onClick={() => {
            flushRef.current();
            onSelect({ type: "nested_strategy", ruleId, path });
          }}
        >
          {node ? resolveStrategyLabel(node.strategy.id) : m["quality.nested_strategy.placeholder"]()}
        </span>
        {node?.strategy.experimental && <WarningIcon />}
        <button style={styles.editBtn} title={m["quality.edit_strategy"]()} onClick={() => { flushRef.current(); setDialogOpen(true); }}>✎</button>
      </div>
      {node && node.params.length > 0 && (
        <div style={{ ...styles.indented, marginLeft: depth * 12 }}>
          <ParamFields params={node.params} values={values} onChange={onChange} />
        </div>
      )}
      {depth < MAX_NESTED_STRATEGY_DEPTH && node?.strategy.nestedSlots.map((childSlotDesc) => (
        <div key={childSlotDesc.slotId} style={{ ...styles.indented, marginLeft: depth * 12 }}>
          <NestedStrategyPanel
            ruleId={ruleId}
            path={[...path, childSlotDesc.slotId]}
            slotDesc={childSlotDesc}
            node={node.nested.find((n) => n.slotId === childSlotDesc.slotId) ?? null}
            depth={depth + 1}
            selection={selection}
            onSelect={onSelect}
          />
        </div>
      ))}
      {dialogOpen && (
        <NestedStrategySelectDialog
          ruleId={ruleId}
          path={path}
          slotKind={slotDesc.kind}
          currentStrategyId={node?.strategy.id ?? null}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </>
  );
}

const styles = {
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    borderRadius: 3,
  },
  // Mirrors `qualityCanvasStyles.ruleStrategyHeaderHover`/`ruleStrategyHeaderSelected`.
  rowHover: {
    background: ui.bg.hover,
  },
  rowSelected: {
    background: ui.bg.panelAlt,
  },
  // `typography.message` — the theme's own "label"-weight token (body size, secondary color).
  label: {
    ...typography.message,
    flex: 1,
  },
  indented: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
  },
  // Mirrors `qualityCanvasStyles.cardLabel` — the strategy name is free text, not a fixed-size
  // control, so it must be allowed to take the space a dropdown box couldn't.
  strategyName: {
    ...typography.body,
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    textAlign: "right" as const,
  },
  // Mirrors `qualityCanvasStyles.editBtn` — same "name + edit icon" affordance the top-level
  // strategy header uses.
  editBtn: {
    ...typography.icon,
    background: "none",
    border: "none",
    color: ui.text.tertiary,
    padding: "0 2px",
    cursor: "pointer",
    lineHeight: 1,
    flexShrink: 0,
  },
};
