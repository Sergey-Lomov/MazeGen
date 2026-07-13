import { useState } from "react";
import { X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useMazeStore } from "../../../store/mazeStore";
import { useParamEditor } from "../useParamEditor";
import { ParamFields } from "../ParamFields";
import { WarningIcon } from "../../WarningIcon";
import { NestedStrategySelectDialog } from "./NestedStrategySelectDialog";
import * as m from "~/paraglide/messages";
import { ui, typography } from "../../../styles/theme";
import { resolveStrategyLabel } from "../qualityI18n";
import type { NestedStrategyVM, NestedSlotVM } from "../useQualityViewModel";
import { MAX_NESTED_STRATEGY_DEPTH, entriesForSlot, type NestedStrategyState, type PathSegment, type QcRuleState } from "../../../store/storeTypes";
import { NESTED_STRATEGY_WEIGHT_PARAM_ID } from "../../../store/slices/generationSlice";
import type { QualitySelection } from "./types";

// Walks the raw store tree (not the resolved view-model) down `path` to find this row's own
// `NestedStrategyState` — `useParamEditor` needs the actual stored param overrides
// (`Record<string, string>`), which only exist on the raw state, not on `NestedStrategyVM`
// (whose `params: ParamDescriptor[]` is the resolved descriptor, mirroring
// `StrategySlotVM.strategy.params`'s same role for the top-level strategy). Exported for
// `QualityDetailPanel`'s `"nested_strategy"` selection case, which needs the same raw lookup to
// pass real `storeValues` into `ParamizedDetail`.
export function findRawNested(rule: QcRuleState | undefined, path: PathSegment[]): NestedStrategyState | undefined {
  let list = rule?.nestedStrategies;
  let found: NestedStrategyState | undefined;
  for (const { slotId, index } of path) {
    found = list ? entriesForSlot(list, slotId)[index] : undefined;
    list = found?.nested;
  }
  return found;
}

interface Props {
  ruleId: string;
  /** Chain of `(slotId, index)` steps leading to this panel's own slot — see
   * `setNestedStrategy`'s doc comment in storeTypes.ts. `path[path.length - 1].slotId` is this
   * panel's own `slotDesc.slotId`; that last segment's own `index` is not meaningful here (this
   * panel renders every entry of the slot, not one), only the segments before it matter for
   * addressing the parent. */
  path: PathSegment[];
  slotDesc: NestedSlotVM;
  /** Every entry currently filling this slot, in list order (that order doubles as `index`
   * addressing — see `PathSegment`). Empty when unconfigured. */
  entries: NestedStrategyVM[];
  /** Indentation level — 1 for the slot directly under a rule's top-level strategy, 2 for a
   * slot under that nested strategy, and so on. */
  depth: number;
  /** Current selection, compared against a row's own `(ruleId, path)` to compute whether it's
   * the selected row — passed down whole (not a pre-computed `selected` boolean) so each
   * recursive instance can independently check its own `path` against it. */
  selection: QualitySelection;
  onSelect: (s: QualitySelection) => void;
}

// Exported for direct unit testing — pure, no React/store involved.
export function pathsEqual(a: PathSegment[], b: PathSegment[]): boolean {
  return a.length === b.length && a.every((v, i) => v.slotId === b[i].slotId && v.index === b[i].index);
}

// Mirrors maze-core's `resolve_weight` (weighted_region_merge.rs) — any missing/unparsable/
// non-finite/`<= 0` raw value falls back to the same default the Rust dispatcher uses, so the
// displayed percentage always matches what `dispatch_weighted` will actually do at generation
// time. Exported for direct unit testing — pure, no React/store involved.
export function resolveWeight(raw: string | undefined): number {
  const parsed = raw === undefined ? NaN : parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

// Renders one nested-strategy slot: every currently-assigned entry as its own row (name + edit +
// remove), plus an "add" row when the slot isn't at its `max` capacity yet (`max: null` = no
// cap — see `weighted_region_merge`'s `merge_target` slot, GitHub issue #90). A slot with exactly
// one entry (the overwhelming majority — `max: Some(1)` slots like `reduce_scc_count`'s own)
// simply renders one row with no visible "add" affordance once full.
export function NestedStrategyPanel({ ruleId, path, slotDesc, entries, depth, selection, onSelect }: Props) {
  const addNestedStrategy = useMazeStore((s) => s.addNestedStrategy);
  const atCapacity = slotDesc.max !== null && entries.length >= slotDesc.max;
  const showWeight = slotDesc.max === null || slotDesc.max > 1;

  // Every sibling's raw weight, read here (not per-row) so a change to any one entry's weight
  // re-renders every row's percentage in the same render pass — a per-row subscription would
  // only see its own weight change, leaving the other rows' displayed percentages stale.
  const parentPath = path.slice(0, -1);
  // Extracts raw weight strings (primitives, not the `NestedStrategyState[]` array itself) so
  // `useShallow` sees a stable snapshot when nothing in it actually changed — returning a fresh
  // array/object from the selector on every call (e.g. via `entriesForSlot(...)` directly) would
  // fail zustand's reference-equality check on every render and loop forever.
  const rawWeights = useMazeStore(useShallow((s) => {
    const rule = s.rules.find((r) => r.id === ruleId);
    const parentList = parentPath.length === 0 ? rule?.nestedStrategies : findRawNested(rule, parentPath)?.nested;
    return entriesForSlot(parentList ?? [], slotDesc.slotId).map((n) => n.params[NESTED_STRATEGY_WEIGHT_PARAM_ID]);
  }));
  const weights = rawWeights.map(resolveWeight);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  return (
    // `entriesGap` separates sibling entries by more than `indented`'s gap separates a single
    // entry's own params/weight rows from each other — makes each entry read as its own group
    // rather than blending into the next one.
    <div style={styles.entriesGap}>
      {entries.length === 0 && (
        <div style={styles.row}>
          <label style={styles.label}>{m["quality.nested_strategy.label"]()}</label>
          <span style={styles.placeholder}>{m["quality.nested_strategy.placeholder"]()}</span>
        </div>
      )}
      {entries.map((entry, index) => (
        <NestedStrategyEntryRow
          key={index}
          ruleId={ruleId}
          path={[...path.slice(0, -1), { slotId: slotDesc.slotId, index }]}
          slotDesc={slotDesc}
          node={entry}
          // The weight row only makes sense once more than one entry can coexist in this slot —
          // a single-entry slot's "weight" would have no other candidate to be weighed against,
          // so it stays hidden rather than showing a number/percentage nobody can act on.
          showWeight={showWeight}
          percent={showWeight && totalWeight > 0 ? Math.floor((weights[index] / totalWeight) * 100) : null}
          removable={entries.length > 1 || slotDesc.min === 0}
          depth={depth}
          selection={selection}
          onSelect={onSelect}
        />
      ))}
      {!atCapacity && (
        <div style={styles.row}>
          <button
            className="hoverable"
            style={styles.addBtn}
            onClick={() => addNestedStrategy(ruleId, [...path.slice(0, -1), { slotId: slotDesc.slotId, index: entries.length }], slotDesc.kind)}
          >
            + {m["quality.nested_strategy.add"]()}
          </button>
        </div>
      )}
    </div>
  );
}

interface EntryRowProps {
  ruleId: string;
  path: PathSegment[];
  slotDesc: NestedSlotVM;
  node: NestedStrategyVM;
  showWeight: boolean;
  /** Rounded-down percentage share of `node`'s weight among its slot siblings, or `null` when
   * `showWeight` is false (single-candidate slot — no percentage to show either). */
  percent: number | null;
  removable: boolean;
  depth: number;
  selection: QualitySelection;
  onSelect: (s: QualitySelection) => void;
}

// Three indentation levels per entry, `depth` being the first (weight row):
//   depth      — "Weight" label + input + "N%" + remove button
//   depth + 1  — "Merge strategy" label + name + edit (✎) button, hover/click-to-select target
//                spanning this row and everything below it in the same block
//   depth + 2  — the nested strategy's own params / further-nested slots
function NestedStrategyEntryRow({ ruleId, path, slotDesc, node, showWeight, percent, removable, depth, selection, onSelect }: EntryRowProps) {
  const setNestedStrategyParam = useMazeStore((s) => s.setNestedStrategyParam);
  const removeNestedStrategy = useMazeStore((s) => s.removeNestedStrategy);
  const rawNested = useMazeStore((s) => findRawNested(s.rules.find((r) => r.id === ruleId), path));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const selected = selection?.type === "nested_strategy" && selection.ruleId === ruleId && pathsEqual(selection.path, path);

  const { values, onChange, flushRef } = useParamEditor({
    // Includes `node.strategy.id` — this row's `path` stays the same across a strategy swap
    // (edit dialog replacing e.g. `expand_region_passage` with `teleport_region_merge` at the
    // same slot), but the params themselves are entirely different. Without the strategy id in
    // `entityId`, `useParamEditor`'s reset effect (keyed only on `entityId`) never fires on a
    // swap, so `values` keeps stale keys from the old strategy and the new strategy's own
    // defaults (e.g. `min_distance`) never populate the field.
    entityId: `${ruleId}:${path.map((p) => `${p.slotId}.${p.index}`).join(".")}:${node.strategy.id}`,
    params: node.params,
    storeValues: rawNested?.params ?? {},
    onCommit: (paramId, value) => {
      setNestedStrategyParam(ruleId, path, paramId, value);
    },
  });

  return (
    <div style={{ ...styles.entryStack, marginLeft: depth * 12 }}>
      {showWeight && (
        <div style={styles.weightRowInner}>
          <label style={styles.weightLabel}>{m["quality.nested_strategy.weight_label"]()}</label>
          <input
            type="text"
            inputMode="decimal"
            style={styles.weightInput}
            value={rawNested?.params[NESTED_STRATEGY_WEIGHT_PARAM_ID] ?? "1"}
            onChange={(e) => setNestedStrategyParam(ruleId, path, NESTED_STRATEGY_WEIGHT_PARAM_ID, e.target.value)}
          />
          {percent !== null && <span style={styles.weightPercent}>{percent}%</span>}
          {removable && (
            <button
              className="hoverable"
              style={styles.removeBtn}
              title={m["quality.nested_strategy.remove"]()}
              onClick={() => removeNestedStrategy(ruleId, path)}
            >
              <X size={18} color={ui.text.tertiary} />
            </button>
          )}
        </div>
      )}
      {/* A thin vertical line down the left, from just below the weight row to the bottom of
          this entry's whole block (name + params + further-nested slots), ties the weight
          visually to exactly what it's weighing — only drawn when the weight row itself is
          shown. Separate from the weight row itself so the line starts under it, not beside it. */}
      <div style={{ ...styles.entryStack, ...(showWeight ? styles.entryStackWithWeight : {}), marginLeft: showWeight ? 12 : 0 }}>
        {/* Hover/selected highlight and the click-to-select target span the whole strategy
            block — name row, its params, and any further-nested slots — not just the name row
            itself, so the highlighted area matches what clicking anywhere in it actually
            selects. */}
        <div
          style={{
            ...styles.strategyBlock,
            ...(hovered ? styles.rowHover : {}),
            ...(selected ? styles.rowSelected : {}),
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onClick={() => {
            flushRef.current();
            onSelect({ type: "nested_strategy", ruleId, path });
          }}
        >
          <div style={styles.row}>
            <label style={styles.label}>{m["quality.nested_strategy.label"]()}</label>
            <span style={styles.strategyName}>
              {resolveStrategyLabel(node.strategy.id)}
            </span>
            {node.strategy.experimental && <WarningIcon />}
            <button className="hoverable" style={styles.editBtn} title={m["quality.edit_strategy"]()} onClick={(e) => { e.stopPropagation(); flushRef.current(); setDialogOpen(true); }}>✎</button>
            {!showWeight && removable && (
              <button
                className="hoverable"
                style={styles.removeBtn}
                title={m["quality.nested_strategy.remove"]()}
                onClick={(e) => { e.stopPropagation(); flushRef.current(); removeNestedStrategy(ruleId, path); }}
              >
                <X size={18} color={ui.text.tertiary} />
              </button>
            )}
          </div>
          {node.params.length > 0 && (
            // No `stopPropagation` wrapper here — `ParamFields` itself stops propagation only on
            // its actual controls (input/select/switch), so empty space around them (labels,
            // gaps) still falls through to this block's own click-to-select handler above.
            <div style={{ ...styles.indented, marginLeft: 12 }}>
              <ParamFields params={node.params} values={values} onChange={onChange} />
            </div>
          )}
        </div>
        {depth < MAX_NESTED_STRATEGY_DEPTH && node.strategy.nestedSlots.map((childSlotDesc) => (
          <div key={childSlotDesc.slotId} style={{ ...styles.indented, marginLeft: 12 }}>
            <NestedStrategyPanel
              ruleId={ruleId}
              path={[...path, { slotId: childSlotDesc.slotId, index: 0 }]}
              slotDesc={childSlotDesc}
              entries={entriesForSlot(node.nested, childSlotDesc.slotId)}
              depth={depth + 1}
              selection={selection}
              onSelect={onSelect}
            />
          </div>
        ))}
      </div>
      {dialogOpen && (
        <NestedStrategySelectDialog
          ruleId={ruleId}
          path={path}
          slotKind={slotDesc.kind}
          currentStrategyId={node.strategy.id}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
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
  // Weight row's fields (input/%/remove) sit right after the "Weight" label, not pushed to the
  // far right by `row`'s `space-between` — there's nothing else to balance them against on this
  // row, unlike the strategy-name row where the name itself fills the remaining width.
  weightRowInner: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 10,
    borderRadius: 3,
  },
  // Wraps the strategy-name row + its params + further-nested slots as one hover/click/selected
  // target, so pointing anywhere in the block (not just the name) highlights and selects it.
  // `padding: 4px` + `margin: -4px` grows the visible hover/selected highlight 4px past the
  // content on every side without shifting surrounding layout (the negative margin cancels the
  // padding's own footprint).
  strategyBlock: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
    borderRadius: 3,
    cursor: "default",
    padding: 4,
    margin: -4,
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
  // Same token as `label`, but without `flex: 1` — the weight row has no "far right" content to
  // balance against (see `weightRow`), so the label must not claim the remaining width.
  weightLabel: {
    ...typography.message,
    flexShrink: 0,
  },
  placeholder: {
    ...typography.body,
    color: ui.text.tertiary,
  },
  // `gap: 8` mirrors `qualityCanvasStyles`'s standard param-to-param spacing — used for a
  // strategy's own params block and for further-nested-slot wrappers.
  indented: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  },
  // Same `gap: 8` as `indented` — kept as its own token since it separates one entry's weight
  // row from its strategy block specifically.
  entryStack: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  },
  // Thin vertical line down the left, from the weight row to the bottom of this entry's whole
  // block — visually ties the weight to exactly what it's weighing. Only applied when the
  // weight row itself is shown (`entryStack` alone otherwise).
  entryStackWithWeight: {
    borderLeft: `1px solid ${ui.border.default}`,
    paddingLeft: 8,
  },
  // Wraps a slot's sibling entries (weight row + strategy block + further-nested slots, each
  // itself using `indented`'s `gap: 8`) with a wider gap — each entry reads as its own group
  // rather than blending into the next one.
  entriesGap: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 16,
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
    cursor: "default",
    lineHeight: 1,
    flexShrink: 0,
  },
  // Mirrors `qualityCanvasStyles.removeBtn` exactly — same remove affordance as "Remove rule".
  removeBtn: {
    background: "none",
    border: "none",
    cursor: "default",
    padding: 0,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
  },
  weightInput: {
    ...typography.body,
    width: 44,
    flexShrink: 0,
    background: ui.bg.input,
    border: `1px solid ${ui.border.default}`,
    borderRadius: 3,
    padding: "2px 4px",
    textAlign: "right" as const,
  },
  weightPercent: {
    ...typography.body,
    color: ui.text.tertiary,
    flexShrink: 0,
    minWidth: 28,
    textAlign: "right" as const,
  },
  addBtn: {
    ...typography.body,
    background: "none",
    border: "none",
    color: ui.text.tertiary,
    cursor: "default",
    padding: "2px 0",
    textAlign: "left" as const,
  },
};
