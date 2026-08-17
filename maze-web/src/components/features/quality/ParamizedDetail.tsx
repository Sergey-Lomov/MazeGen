import React from "react";
import { useParamEditor } from "../useParamEditor";
import { ParamFields } from "../ParamFields";
import { WarningBubble } from "../../WarningBubble";
import { resolveParamDescription } from "../qualityI18n";
import { qualityCanvasStyles as styles } from "./qualityCanvasStyles";
import type { ParamDescriptor } from "../../../wasm/types";

interface Props {
  id: string;
  label: string;
  description?: string;
  /** Shows a warning bubble under the description (e.g. an experimental strategy). */
  warning?: boolean;
  params: ParamDescriptor[];
  storeValues: Record<string, string>;
  onCommit: (paramId: string, value: string) => void;
  flushRef: React.MutableRefObject<() => void>;
  /** Extra content rendered after the params (e.g. nested-strategy slots) — only a strategy with
   * nested slots passes this; a plain check never has any. */
  children?: React.ReactNode;
  /** Owning strategy id — see `ParamFields`'s `contextId` doc comment. Absent for a plain check. */
  contextId?: string;
  /** Forced values merged on top of the live-edited values before rendering, and the matching
   * disabled param ids — e.g. `add_vertical_passage`'s sliders when the rule-level `passage_type`
   * already determines them. See `addVerticalPassageOverrides`. */
  valueOverrides?: Record<string, string>;
  disabledIds?: Set<string>;
}

export function ParamizedDetail({ id, label, description, warning, params, storeValues, onCommit, flushRef, children, contextId, valueOverrides, disabledIds }: Props) {
  const { values, onChange, flushRef: localFlushRef } = useParamEditor({
    entityId: id,
    params,
    storeValues,
    onCommit,
  });

  flushRef.current = localFlushRef.current;

  const displayValues = valueOverrides ? { ...values, ...valueOverrides } : values;

  return (
    <div style={styles.detailPanel}>
      <div style={styles.detailTitle}>{label}</div>
      {description && <div style={styles.detailDesc}>{description}</div>}
      {warning && <WarningBubble />}
      {params.length > 0 && (
        <>
          <div style={styles.detailDivider} />
          <ParamFields
            params={params}
            values={displayValues}
            onChange={onChange}
            getDescription={(p) => resolveParamDescription(p.id, contextId)}
            contextId={contextId}
            disabledIds={disabledIds}
          />
        </>
      )}
      {children}
    </div>
  );
}
