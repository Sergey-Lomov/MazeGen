import { useRef } from "react";
import type React from "react";
import { useFieldHint } from "./FieldHint";
import { inputHintReason, normalizeChannelInput, type NormalizerResult } from "./inputNormalization";

interface Props {
  name: string;
  value: string;
  max: number;
  step: number;
  ariaLabel: string;
  style?: React.CSSProperties;
  onInput: (result: NormalizerResult<number | null>) => void;
  onBlur: () => void;
}
/** Numeric color-channel field. Range correction still happens while typing to keep the preview
 * responsive, but its explanation waits for blur; slider and gamut corrections never use it. */
export function ColorChannelInput({ name, value, max, step, ariaLabel, style, onInput, onBlur }: Props) {
  const hint = useFieldHint();
  const pendingReason = useRef<NormalizerResult<number | null>["reason"]>(null);

  function handleChange(raw: string) {
    const result = normalizeChannelInput(raw, max);
    pendingReason.current = result.reason;
    if (!result.reason && result.value !== null) hint.dismiss();
    onInput(result);
  }

  function handleBlur() {
    onBlur();
    if (pendingReason.current) hint.show(inputHintReason(pendingReason.current));
    pendingReason.current = null;
  }

  return (
    <>
      <input
        ref={hint.anchorRef as React.Ref<HTMLInputElement>}
        type="number"
        name={name}
        min={0}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel}
        aria-describedby={hint.describedBy}
        style={{ ...style, ...hint.fieldStyle }}
        onChange={(event) => handleChange(event.target.value)}
        onBlur={handleBlur}
      />
      {hint.hint}
    </>
  );
}
