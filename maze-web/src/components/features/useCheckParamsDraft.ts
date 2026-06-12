import { useState, useEffect, useRef } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { CheckDescriptor, ParamDescriptor } from "../../wasm/types";

export function getDefaultValue(p: ParamDescriptor): string {
  const k = p.kind;
  if (k.type === "bool") return k.default ? "true" : "false";
  return String(k.default);
}

function clampValue(raw: string, p: ParamDescriptor): string {
  const k = p.kind;
  if (k.type === "float" || k.type === "integer") {
    const n = Number(raw);
    if (isNaN(n)) return String(k.default);
    return String(Math.min(k.max, Math.max(k.min, n)));
  }
  return raw;
}

function buildLocalParams(
  checkId: string,
  availableChecks: CheckDescriptor[],
  checkParams: Record<string, Record<string, string>>,
): Record<string, string> {
  const descriptor = availableChecks.find((c) => c.id === checkId);
  if (!descriptor) return {};
  const stored = checkParams[checkId] ?? {};
  return Object.fromEntries(
    descriptor.params.map((p) => {
      const raw = stored[p.id] ?? getDefaultValue(p);
      return [p.id, clampValue(raw, p)];
    })
  );
}

export interface CheckParamsDraft {
  localParams: Record<string, string>;
  setParam: (paramId: string, value: string) => void;
  commit: (id: string) => void;
  reset: (id: string) => void;
}

export function useCheckParamsDraft(checkId: string): CheckParamsDraft {
  const availableChecks = useMazeStore((s) => s.availableChecks);
  const checkParams = useMazeStore((s) => s.checkParams);
  const setCheckParam = useMazeStore((s) => s.setCheckParam);

  const checkParamsRef = useRef(checkParams);
  checkParamsRef.current = checkParams;
  const availableChecksRef = useRef(availableChecks);
  availableChecksRef.current = availableChecks;

  const [localParams, setLocalParams] = useState<Record<string, string>>(() =>
    buildLocalParams(checkId, availableChecks, checkParams)
  );

  useEffect(() => {
    setLocalParams(buildLocalParams(checkId, availableChecksRef.current, checkParamsRef.current));
  }, [checkId]);

  function setParam(paramId: string, value: string) {
    setLocalParams((prev) => ({ ...prev, [paramId]: value }));
  }

  function commit(id: string) {
    for (const [paramId, value] of Object.entries(localParams)) {
      setCheckParam(id, paramId, value);
    }
  }

  function reset(id: string) {
    setLocalParams(buildLocalParams(id, availableChecksRef.current, checkParamsRef.current));
  }

  return { localParams, setParam, commit, reset };
}
