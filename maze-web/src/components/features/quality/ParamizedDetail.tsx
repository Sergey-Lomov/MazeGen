import React from "react";
import { useParamEditor } from "../useParamEditor";
import { ParamFields } from "../ParamFields";
import { resolveParamDescription } from "../qualityI18n";
import { qualityCanvasStyles as styles } from "./qualityCanvasStyles";
import type { ParamDescriptor } from "../../../wasm/types";

interface Props {
  id: string;
  label: string;
  description?: string;
  params: ParamDescriptor[];
  storeValues: Record<string, string>;
  onCommit: (paramId: string, value: string) => void;
  flushRef: React.MutableRefObject<() => void>;
}

export function ParamizedDetail({ id, label, description, params, storeValues, onCommit, flushRef }: Props) {
  const { values, onChange, flushRef: localFlushRef } = useParamEditor({
    entityId: id,
    params,
    storeValues,
    onCommit,
  });

  flushRef.current = localFlushRef.current;

  return (
    <div style={styles.detailPanel}>
      <div style={styles.detailTitle}>{label}</div>
      {description && <div style={styles.detailDesc}>{description}</div>}
      {params.length > 0 && (
        <>
          <div style={styles.detailDivider} />
          <ParamFields
            params={params}
            values={values}
            onChange={onChange}
            getDescription={(p) => resolveParamDescription(p.id)}
          />
        </>
      )}
    </div>
  );
}
