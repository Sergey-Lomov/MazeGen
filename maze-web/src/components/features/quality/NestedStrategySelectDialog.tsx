import React, { useState } from "react";
import { useMazeStore } from "../../../store/mazeStore";
import { ItemSelectDialog } from "../../dialogs/ItemSelectDialog";
import { Button } from "../../Button";
import { WarningBubble } from "../../WarningBubble";
import { ParamFields, isEntityVisible } from "../ParamFields";
import { useParamEditor } from "../useParamEditor";
import { resolveStrategyLabel, resolveStrategyDescription, resolveParamLabel, resolveParamDescription } from "../qualityI18n";
import { ui, radius, typography, spacing, inset } from "../../../styles/theme";
import * as m from "~/paraglide/messages";
import type { ParamDescriptor } from "../../../wasm/types";
import { entriesForSlot, type NestedStrategyState, type PathSegment, type QcRuleState } from "../../../store/storeTypes";

interface Props {
  ruleId: string;
  path: PathSegment[];
  /** `IssueKind` this slot accepts — candidates are filtered to strategies handling it. */
  slotKind: string;
  currentStrategyId: string | null;
  onClose: () => void;
}

// Same shape as `StrategySelectDialog`, minus the "no fix" / logging-only entry — a nested slot
// always needs an actual strategy to delegate to, unlike a top-level rule (which may legitimately
// have no fix at all). Commit semantics also mirror `StrategySelectDialog`: `selectedId` is local
// state only, and `setNestedStrategy` fires once, on "Select" — not per-click in the list.
//
// Params work differently from the top-level dialog, though: `StrategySelectDialog` can write a
// not-yet-assigned candidate's params straight to the store because `strategyParams` is a global
// `strategyId`-keyed map, independent of whether any rule currently uses that strategy. Nested
// params are per-`(rule, path)` by design (two rules nesting the same strategy need independent
// values — the whole reason `nested` is stored per-node instead of reusing `strategyParams`), so
// there is no node to write into until `setNestedStrategy` creates one. Editing a not-yet-selected
// candidate's params is therefore held in local `drafts` state here (plain synchronous state, not
// `useParamEditor` — there is no store write to debounce yet), keyed by strategy id, and flushed
// into the store right after `setNestedStrategy` on "Select" — discarded on "Cancel" like the
// rest of the dialog's uncommitted state. The currently-assigned strategy's params still edit the
// real store value live (via `useParamEditor`), same as `StrategyParamPanel` for the top-level
// dialog.
export function NestedStrategySelectDialog({ ruleId, path, slotKind, currentStrategyId, onClose }: Props) {
  const availableStrategies = useMazeStore((s) => s.availableStrategies);
  const nestedParams = useMazeStore((s) => findRawNestedParams(s.rules.find((r) => r.id === ruleId), path));
  const setNestedStrategy = useMazeStore((s) => s.setNestedStrategy);
  const setNestedStrategyParam = useMazeStore((s) => s.setNestedStrategyParam);
  const floorCount = useMazeStore((s) => s.floors.length);

  const candidates = availableStrategies
    .filter((s) => s.handles === slotKind)
    .filter((s) => isEntityVisible(s.visibility, floorCount));
  const [selectedId, setSelectedId] = useState<string>(currentStrategyId ?? candidates[0]?.id ?? "");
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});

  function handleSelect() {
    if (selectedId !== currentStrategyId) {
      setNestedStrategy(ruleId, path, selectedId);
      for (const [paramId, value] of Object.entries(drafts[selectedId] ?? {})) {
        setNestedStrategyParam(ruleId, path, paramId, value);
      }
    }
    onClose();
  }

  const items = candidates.map((s) => ({ id: s.id, label: resolveStrategyLabel(s.id), warning: s.experimental }));

  const selectedStrategy = candidates.find((s) => s.id === selectedId);
  const description = resolveStrategyDescription(selectedId);

  const rightPanel = (
    <>
      {description && <div style={styles.description}>{description}</div>}
      {selectedStrategy?.experimental && <WarningBubble />}
      {selectedStrategy && selectedStrategy.params.length > 0 && (
        selectedId === currentStrategyId ? (
          <NestedStrategyParamPanel
            ruleId={ruleId}
            path={path}
            strategyId={selectedStrategy.id}
            params={selectedStrategy.params}
            storeValues={nestedParams}
            onCommit={(paramId, value) => setNestedStrategyParam(ruleId, path, paramId, value)}
          />
        ) : (
          <DraftStrategyParamPanel
            strategyId={selectedStrategy.id}
            params={selectedStrategy.params}
            draftValues={drafts[selectedStrategy.id] ?? EMPTY_PARAMS}
            onChange={(paramId, value) => setDrafts((prev) => ({
              ...prev,
              [selectedStrategy.id]: { ...prev[selectedStrategy.id], [paramId]: value },
            }))}
          />
        )
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

function NestedStrategyParamPanel({ ruleId, path, strategyId, params, storeValues, onCommit }: {
  ruleId: string;
  path: PathSegment[];
  strategyId: string;
  params: ParamDescriptor[];
  storeValues: Record<string, string>;
  onCommit: (paramId: string, value: string) => void;
}) {
  const localizedParams = params.map((p) => ({ ...p, label: resolveParamLabel(p.id, p.label, strategyId) }));
  const { values, onChange } = useParamEditor({
    entityId: `${ruleId}:${path.map((p) => `${p.slotId}.${p.index}`).join(".")}:${strategyId}`,
    params: localizedParams,
    storeValues,
    onCommit,
  });

  return (
    <div style={styles.paramsSection}>
      <div style={styles.paramsSeparator} />
      <ParamFields
        params={localizedParams}
        values={values}
        onChange={onChange}
        getDescription={(p) => resolveParamDescription(p.id, strategyId)}
      />
    </div>
  );
}

// Not-yet-committed candidate's params — plain controlled inputs over `draftValues`, no
// `useParamEditor`/debounce (nothing to protect the store from, since nothing writes to the
// store here; see this file's header comment). Falls back to each param's own default when the
// draft has no entry yet, so the panel shows real defaults immediately, not blank inputs.
function DraftStrategyParamPanel({ strategyId, params, draftValues, onChange }: {
  strategyId: string;
  params: ParamDescriptor[];
  draftValues: Record<string, string>;
  onChange: (paramId: string, value: string) => void;
}) {
  const localizedParams = params.map((p) => ({ ...p, label: resolveParamLabel(p.id, p.label, strategyId) }));

  function getValue(p: ParamDescriptor): string {
    if (draftValues[p.id] !== undefined) return draftValues[p.id];
    const k = p.kind;
    if (k.type === "bool") return k.default ? "true" : "false";
    // "min,max" -- mirrors maze-core's `parse_param` Interval encoding (repair/params.rs).
    if (k.type === "interval") return `${k.default_min},${k.default_max}`;
    if (k.type === "pattern_list") return "[]";
    if (k.type === "split_generation_config") return JSON.stringify({ pattern_mode: false, max_split_nodes: 2, patterns: [] });
    if (k.type === "add_split_config") return String(k.max_split_nodes_default);
    return String(k.default);
  }

  return (
    <div key={strategyId} style={styles.paramsSection}>
      <div style={styles.paramsSeparator} />
      <ParamFields
        params={localizedParams}
        getValue={getValue}
        onChange={onChange}
        getDescription={(p) => resolveParamDescription(p.id, strategyId)}
      />
    </div>
  );
}

// Stable empty-object reference — a fresh `{}` literal on every call would break
// zustand's `useSyncExternalStore` reference-equality check and cause an infinite render loop.
const EMPTY_PARAMS: Record<string, string> = {};

// Mirrors `NestedStrategyPanel.findRawNested`, but returns the raw param overrides directly
// (`{}` if the slot has no assignment yet) — this dialog only ever needs the values, not the
// whole node.
function findRawNestedParams(rule: QcRuleState | undefined, path: PathSegment[]): Record<string, string> {
  let list = rule?.nestedStrategies;
  let found: NestedStrategyState | undefined;
  for (const { slotId, index } of path) {
    found = list ? entriesForSlot(list, slotId)[index] : undefined;
    list = found?.nested;
  }
  return found?.params ?? EMPTY_PARAMS;
}

const styles: Record<string, React.CSSProperties> = {
  description: {
    ...typography.body,
    lineHeight: 1.6,
    whiteSpace: "pre-line",
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
