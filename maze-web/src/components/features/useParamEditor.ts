import { useState, useEffect, useRef, useCallback } from "react";
import type { ParamDescriptor } from "../../wasm/types";

interface UseParamEditorOptions {
  entityId: string;
  params: ParamDescriptor[];
  storeValues: Record<string, string>;
  onCommit: (paramId: string, value: string) => void;
}

interface UseParamEditorResult {
  values: Record<string, string>;
  onChange: (paramId: string, value: string) => void;
  flushRef: React.MutableRefObject<() => void>;
}

const DEBOUNCE_MS = 300;

export function useParamEditor({ entityId, params, storeValues, onCommit }: UseParamEditorOptions): UseParamEditorResult {
  const [values, setValues] = useState<Record<string, string>>(() => buildValues(params, storeValues));

  const pendingRef = useRef<Record<string, string>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = {};
    for (const [paramId, value] of Object.entries(pending)) {
      onCommitRef.current(paramId, value);
    }
  }, []);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    setValues(buildValues(params, storeValues));
    pendingRef.current = {};
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const onChange = useCallback((paramId: string, value: string) => {
    setValues((prev) => ({ ...prev, [paramId]: value }));
    pendingRef.current[paramId] = value;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = {};
      for (const [id, val] of Object.entries(pending)) {
        onCommitRef.current(id, val);
      }
    }, DEBOUNCE_MS);
  }, []);

  return { values, onChange, flushRef };
}

function buildValues(params: ParamDescriptor[], storeValues: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    params.map((p) => [p.id, storeValues[p.id] ?? getDefaultValue(p)])
  );
}

function getDefaultValue(p: ParamDescriptor): string {
  const k = p.kind;
  if (k.type === "bool") return k.default ? "true" : "false";
  // "min,max" -- mirrors maze-core's `parse_param` Interval encoding (repair/params.rs).
  if (k.type === "interval") return `${k.default_min},${k.default_max}`;
  // Empty pattern list -- "all"/"unconstrained" default (GitHub issue #247), same JSON encoding
  // `parse_split_patterns_param` round-trips.
  if (k.type === "pattern_list") return "[]";
  // Unconstrained mode, max_split_nodes=2, no patterns -- mirrors SplitGenerationConfig::default(),
  // same JSON encoding `parse_split_config_param` round-trips.
  if (k.type === "split_generation_config") return JSON.stringify({ pattern_mode: false, max_split_nodes: 2, patterns: [] });
  return String(k.default);
}
