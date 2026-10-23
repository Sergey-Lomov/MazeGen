import React, { useState, useEffect } from "react";
import { sharedStyles } from "../../styles/shared";
import { useFieldHint } from "../FieldHint";
import { inputHintReason, type NormalizerResult } from "../inputNormalization";

interface SizeParamProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
  /** Step of the number input (default: the browser's, 1). */
  step?: number;
  /** Only whole numbers are accepted. */
  integer?: boolean;
  disabled?: boolean;
}

export function SizeParam({ label, value, min, max, onCommit, step, integer = false, disabled = false }: SizeParamProps) {
  const hint = useFieldHint();
  const [local, setLocal] = useState(String(value));

  useEffect(() => { setLocal(String(value)); }, [value]);

  function commit() {
    const n = Number(local);
    const valid = local.trim() !== "" && Number.isFinite(n) && (!integer || Number.isInteger(n));
    const result: NormalizerResult<number> = valid && n >= min && n <= max
      ? { raw: local, value: n, reason: null }
      : {
          raw: local,
          value,
          reason: valid
            ? { kind: "range_reverted", min: String(min), max: String(max), value: String(value) }
            : { kind: "restored", value: String(value) },
        };
    if (result.reason) {
      setLocal(String(result.value));
      hint.show(inputHintReason(result.reason));
    } else {
      onCommit(result.value);
    }
  }

  return (
    <label ref={hint.labelRef as React.Ref<HTMLLabelElement>} style={sharedStyles.fieldLabel}>
      {label}
      <input
        ref={hint.anchorRef as React.Ref<HTMLInputElement>}
        style={{ ...sharedStyles.input, ...hint.fieldStyle }}
        type="number"
        name={label}
        min={min}
        max={max}
        step={step}
        value={local}
        disabled={disabled}
        aria-describedby={hint.describedBy}
        onChange={(e) => {
          const raw = e.target.value;
          setLocal(raw);
          const n = Number(raw);
          if (raw.trim() !== "" && Number.isFinite(n) && n >= min && n <= max) hint.dismiss();
        }}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); } }}
      />
      {hint.hint}
    </label>
  );
}
