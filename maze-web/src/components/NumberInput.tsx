import React, { useEffect, useRef, useState } from "react";
import { useFieldHint } from "./FieldHint";
import { inputHintReason, isParseableNumber, normalizeNumberCommit, type NormalizerResult } from "./inputNormalization";

interface Props {
  /** Current committed value as a string (the same encoding the rest of the param pipeline uses). */
  value: string;
  /** Fired on every edit with the value to commit. While the field is transiently empty this is
   * still called, but with the last valid value rather than the empty string (GitHub issue #452) —
   * so a check's numeric param never briefly commits "" and gets bounced to its (often large)
   * default, which would fire a false analytics error. */
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  /** Integer field — keeps decimal-separator drafts visible but uncommitted, and rounds + clamps
   * the value on blur. A float field only clamps. */
  integer?: boolean;
  disabled?: boolean;
  name?: string;
  id?: string;
  ariaLabel?: string;
  style?: React.CSSProperties;
  /** Forwarded to the underlying input (callers stop row-level click propagation with this). */
  onClick?: (e: React.MouseEvent<HTMLInputElement>) => void;
  /** Called on blur with the fully normalized value (after empty-restore / round / clamp), for
   * callers that need a further cross-field adjustment — e.g. an interval's min/max inversion
   * clamp, which this component can't know about on its own. */
  onBlurCommit?: (normalized: string) => void;
}

// A numeric `<input>` that never lets a transiently-empty field escape as a committed value.
// While the user is mid-edit (field focused, or emptied) it renders its own local string and
// reports the last valid value upward; on blur an empty/unparseable field is restored to that
// last valid value. Integer fields additionally reject decimal separators and round+clamp on
// blur; float fields only clamp. Rejected drafts stay visible like TextInput drafts and are never
// committed, so the field hint explains why the typed character was not accepted.
export function NumberInput({ value, onChange, min, max, integer, disabled, name = "number-input", id, ariaLabel, style, onClick, onBlurCommit }: Props) {
  const hint = useFieldHint();
  // Local display string — decoupled from `value` while the field is focused so the user can
  // clear it and type a new number without the prop snapping it back mid-edit.
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  // Last value that actually parsed as a finite number — seeded from the initial prop, updated
  // on every valid keystroke and whenever a new valid `value` arrives from outside.
  const lastValidRef = useRef(isParseableNumber(value) ? value : "");

  useEffect(() => {
    if (isParseableNumber(value)) lastValidRef.current = value;
    // Only mirror an incoming prop change into the field when the user isn't editing it.
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    setDraft(raw);
    const separatorRejected = Boolean(integer && /[.,]/.test(raw));
    const transientDraft = raw === "" || raw === "-" || /^-?\d+[eE]?$/.test(raw) || (!integer && /^-?(?:\d+\.?\d*|\.\d*)$/.test(raw));
    const result: NormalizerResult<string> = {
      raw,
      value: isParseableNumber(raw) && !separatorRejected ? raw : lastValidRef.current,
      reason: separatorRejected
        ? { kind: "decimal_separator_rejected" }
        : !isParseableNumber(raw) && !transientDraft
          ? { kind: "character_rejected" }
          : null,
    };
    if (!isParseableNumber(result.raw) || separatorRejected) {
      // Empty, or a transient non-number the field allows mid-edit ("-", "1e", "."): keep
      // showing it, but commit the last valid value so downstream never sees an unparseable
      // string that would bounce to the param's (often large) default and fire a false
      // analytics error (GitHub issue #452).
      onChange(result.value);
      if (result.reason) hint.show(inputHintReason(result.reason));
      return;
    }
    hint.dismiss();
    lastValidRef.current = result.value;
    onChange(result.value);
  }

  function handleBlur() {
    focusedRef.current = false;
    const result = normalizeNumberCommit(draft, lastValidRef.current, { min, max, integer });
    if (result.value !== draft) setDraft(result.value);
    lastValidRef.current = result.value;
    onChange(result.value);
    onBlurCommit?.(result.value);
    if (result.reason) hint.show(inputHintReason(result.reason));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (integer && (e.key === "." || e.key === ",")) {
      const result: NormalizerResult<string> = {
        raw: e.key,
        value: draft,
        reason: { kind: "decimal_separator_rejected" },
      };
      hint.show(inputHintReason(result.reason!));
    }
    if (e.key === "Enter") e.currentTarget.blur();
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    if (integer && /[.,]/.test(e.clipboardData.getData("text"))) {
      const result: NormalizerResult<string> = {
        raw: e.clipboardData.getData("text"),
        value: draft,
        reason: { kind: "decimal_separator_rejected" },
      };
      hint.show(inputHintReason(result.reason!));
    }
  }

  return (
    <>
      <input
        ref={hint.anchorRef as React.Ref<HTMLInputElement>}
        type="text"
        inputMode="decimal"
        role="spinbutton"
        name={name}
        id={id}
        aria-label={ariaLabel}
        style={{ ...style, ...hint.fieldStyle }}
        value={draft}
        min={min}
        max={max}
        step={integer ? 1 : 0.1}
        disabled={disabled}
        aria-describedby={hint.describedBy}
        onFocus={() => { focusedRef.current = true; }}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onClick={onClick}
      />
      {hint.hint}
    </>
  );
}
