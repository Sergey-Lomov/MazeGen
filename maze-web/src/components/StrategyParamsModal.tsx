import { Modal } from "./Modal";
import { useMazeStore } from "../store/mazeStore";
import type { ParamDescriptor } from "../wasm/types";
import { ParamFields } from "./features/ParamFields";

interface Props {
  strategyId: string;
  params: ParamDescriptor[];
  onClose: () => void;
}

export function StrategyParamsModal({ strategyId, params, onClose }: Props) {
  const paramOverrides = useMazeStore((s) => s.strategyParams[strategyId]) ?? {};
  const setStrategyParam = useMazeStore((s) => s.setStrategyParam);

  function getValue(p: ParamDescriptor): string {
    if (paramOverrides[p.id] !== undefined) return paramOverrides[p.id];
    const k = p.kind;
    if (k.type === "float" || k.type === "integer") return String(k.default);
    if (k.type === "bool") return k.default ? "true" : "false";
    // "min,max" -- mirrors maze-core's `parse_param` Interval encoding (repair/params.rs).
    if (k.type === "interval") return `${k.default_min},${k.default_max}`;
    if (k.type === "pattern_list") return "[]";
    if (k.type === "split_generation_config") return JSON.stringify({ pattern_mode: false, max_split_nodes: 2, patterns: [] });
    return k.default;
  }

  return (
    <Modal title={strategyId} size="info" onClose={onClose}>
      <ParamFields
        params={params}
        getValue={getValue}
        onChange={(paramId, value) => setStrategyParam(strategyId, paramId, value)}
      />
    </Modal>
  );
}
