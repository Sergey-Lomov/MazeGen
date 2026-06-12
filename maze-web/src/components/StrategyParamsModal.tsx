import { Modal } from "./Modal";
import { useMazeStore } from "../store/mazeStore";
import type { ParamDescriptor } from "../wasm/types";
import { sharedStyles } from "../styles/shared";
import { colors, font } from "../styles/theme";

interface Props {
  strategyId: string;
  params: ParamDescriptor[];
  onClose: () => void;
}

export function StrategyParamsModal({ strategyId, params, onClose }: Props) {
  const paramOverrides = useMazeStore((s) => s.strategyParams[strategyId]) ?? {};
  const setStrategyParam = useMazeStore((s) => s.setStrategyParam);

  const getValue = (p: ParamDescriptor): string => {
    if (paramOverrides[p.id] !== undefined) return paramOverrides[p.id];
    const k = p.kind;
    if (k.type === "float" || k.type === "integer") return String(k.default);
    if (k.type === "bool") return k.default ? "true" : "false";
    return k.default;
  };

  return (
    <Modal title={strategyId} size="info" onClose={onClose}>
      {params.map((p) => (
        <div key={p.id} style={styles.row}>
          <label style={styles.label}>{p.label}</label>
          {(p.kind.type === "float" || p.kind.type === "integer") && (
            <input
              type="number"
              style={styles.input}
              value={getValue(p)}
              min={p.kind.min}
              max={p.kind.max}
              step={p.kind.type === "integer" ? 1 : 0.1}
              onChange={(e) => setStrategyParam(strategyId, p.id, e.target.value)}
            />
          )}
          {p.kind.type === "bool" && (
            <input
              type="checkbox"
              checked={getValue(p) === "true"}
              onChange={(e) => setStrategyParam(strategyId, p.id, e.target.checked ? "true" : "false")}
            />
          )}
          {p.kind.type === "enum" && (
            <select
              style={styles.select}
              value={getValue(p)}
              onChange={(e) => setStrategyParam(strategyId, p.id, e.target.value)}
            >
              {p.kind.options.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          )}
        </div>
      ))}
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  label: {
    fontSize: font.sm,
    color: colors.textMuted,
    flex: 1,
  },
  input: {
    ...sharedStyles.inputSm,
    width: 80,
  },
  select: {
    ...sharedStyles.selectSm,
    width: 120,
  },
};
