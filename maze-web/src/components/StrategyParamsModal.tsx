import { createPortal } from "react-dom";
import { useMazeStore } from "../store/mazeStore";
import type { ParamDescriptor } from "../wasm/types";

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
    if (k.type === "float") return String(k.default);
    if (k.type === "bool") return k.default ? "true" : "false";
    return k.default;
  };

  return createPortal(
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>{strategyId}</span>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div style={styles.body}>
          {params.map((p) => (
            <div key={p.id} style={styles.row}>
              <label style={styles.label}>{p.label}</label>
              {p.kind.type === "float" && (
                <input
                  type="number"
                  style={styles.input}
                  value={getValue(p)}
                  min={p.kind.min}
                  max={p.kind.max}
                  step={0.1}
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
        </div>
      </div>
    </div>,
    document.body
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modal: {
    background: "#1e1e1e",
    border: "1px solid #444",
    borderRadius: 6,
    minWidth: 280,
    maxWidth: 400,
    boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 14px",
    borderBottom: "1px solid #333",
  },
  title: {
    fontSize: 12,
    fontWeight: "bold",
    color: "#e0e0e0",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "#888",
    cursor: "pointer",
    fontSize: 14,
    padding: "0 2px",
  },
  body: {
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  label: {
    fontSize: 11,
    color: "#ccc",
    flex: 1,
  },
  input: {
    background: "#2a2a2a",
    border: "1px solid #444",
    color: "#e0e0e0",
    fontSize: 11,
    borderRadius: 3,
    padding: "2px 6px",
    width: 80,
  },
  select: {
    background: "#2a2a2a",
    border: "1px solid #444",
    color: "#e0e0e0",
    fontSize: 11,
    borderRadius: 3,
    padding: "1px 4px",
    width: 120,
  },
};
