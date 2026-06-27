import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "../dialogs/ItemSelectDialog";
import { ParamFields } from "./ParamFields";
import { useParamEditor } from "./useParamEditor";
import { resolveStrategyLabel, resolveStrategyDescription, resolveParamLabel, resolveParamDescription, NO_FIX_STRATEGY_ID } from "./qualityI18n";
import { colors, font, radius } from "../../styles/theme";
import * as m from "~/paraglide/messages";
import type { ParamDescriptor } from "../../wasm/types";

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

  const currentId = rules.find((r) => r.id === ruleId)?.strategyId ?? NO_FIX_STRATEGY_ID;
  const [selectedId, setSelectedId] = useState<string>(currentId);

  const candidates = availableStrategies.filter((s) => s.handles === kind);

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
    ...candidates.map((s) => ({ id: s.id, label: resolveStrategyLabel(s.id) })),
  ];

  const selectedStrategy = candidates.find((s) => s.id === selectedId);
  const description = resolveStrategyDescription(selectedId);

  const rightPanel = (
    <>
      {description && <div style={styles.description}>{description}</div>}
      {selectedStrategy && selectedStrategy.params.length > 0 && (
        <StrategyParamPanel strategyId={selectedStrategy.id} params={selectedStrategy.params} />
      )}
    </>
  );

  const footer = (
    <>
      <button style={styles.btnSecondary} onClick={onClose}>{m["common.cancel"]()}</button>
      <button style={styles.btnPrimary} onClick={handleSelect}>{m["common.select"]()}</button>
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

function StrategyParamPanel({ strategyId, params }: { strategyId: string; params: ParamDescriptor[] }) {
  const strategyParams = useMazeStore((s) => s.strategyParams);
  const setStrategyParam = useMazeStore((s) => s.setStrategyParam);

  const localizedParams = params.map((p) => ({ ...p, label: resolveParamLabel(p.id, p.label) }));
  const storeValues = strategyParams[strategyId] ?? {};
  const { values, onChange } = useParamEditor({
    entityId: strategyId,
    params: localizedParams,
    storeValues,
    onCommit: (paramId, value) => setStrategyParam(strategyId, paramId, value),
  });

  return (
    <div style={styles.paramsSection}>
      <div style={styles.paramsSeparator} />
      <ParamFields
        params={localizedParams}
        values={values}
        onChange={onChange}
        getDescription={(p) => resolveParamDescription(p.id)}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  description: {
    fontSize: font.lg,
    color: colors.textFaint,
    lineHeight: 1.6,
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
};
