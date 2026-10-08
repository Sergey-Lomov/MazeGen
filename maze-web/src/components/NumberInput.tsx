import React, { useEffect, useRef, useState } from "react";

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
  /** Integer field — blocks the decimal separator on keystroke and paste, and rounds + clamps
   * the value on blur. A float field only clamps. */
  integer?: boolean;
  disabled?: boolean;
  name?: string;
  id?: string;
  style?: React.CSSProperties;
  /** Forwarded to the underlying input (callers stop row-level click propagation with this). */
  onClick?: (e: React.MouseEvent<HTMLInputElement>) => void;
  /** Called on blur with the fully normalized value (after empty-restore / round / clamp), for
   * callers that need a further cross-field adjustment — e.g. an interval's min/max inversion
   * clamp, which this component can't know about on its own. */
  onBlurCommit?: (normalized: string) => void;
}

function isParseable(raw: string): boolean {
  return raw.trim() !== "" && Number.isFinite(Number(raw));
}

// A numeric `<input>` that never lets a transiently-empty field escape as a committed value.
// While the user is mid-edit (field focused, or emptied) it renders its own local string and
// reports the last valid value upward; on blur an empty/unparseable field is restored to that
// last valid value. Integer fields additionally block the decimal separator and round+clamp on
// blur; float fields only clamp.
export function NumberInput({ value, onChange, min, max, integer, disabled, name = "number-input", id, style, onClick, onBlurCommit }: Props) {
  // Local display string — decoupled from `value` while the field is focused so the user can
  // clear it and type a new number without the prop snapping it back mid-edit.
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  // Last value that actually parsed as a finite number — seeded from the initial prop, updated
  // on every valid keystroke and whenever a new valid `value` arrives from outside.
  const lastValidRef = useRef(isParseable(value) ? value : "");

  useEffect(() => {
    if (isParseable(value)) lastValidRef.current = value;
    // Only mirror an incoming prop change into the field when the user isn't editing it.
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  function clampAndNormalize(raw: string): string {
    let n = Number(raw);
    if (integer) n = Math.round(n);
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    return String(n);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    setDraft(raw);
    if (!isParseable(raw)) {
      // Empty, or a transient non-number the field allows mid-edit ("-", "1e", "."): keep
      // showing it, but commit the last valid value so downstream never sees an unparseable
      // string that would bounce to the param's (often large) default and fire a false
      // analytics error (GitHub issue #452).
      onChange(lastValidRef.current);
      return;
    }
    lastValidRef.current = raw;
    onChange(raw);
  }

  function handleBlur() {
    focusedRef.current = false;
    if (!isParseable(draft)) {
      // Left empty or unparseable — restore the last valid value into the field, re-committing
      // it only if the field is actually still showing something else (`handleChange` already
      // committed the last valid value on the keystroke that emptied it).
      if (draft !== lastValidRef.current) {
        setDraft(lastValidRef.current);
        onChange(lastValidRef.current);
      }
      onBlurCommit?.(lastValidRef.current);
      return;
    }
    const normalized = clampAndNormalize(draft);
    if (normalized !== draft) setDraft(normalized);
    lastValidRef.current = normalized;
    onChange(normalized);
    onBlurCommit?.(normalized);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (integer && (e.key === "." || e.key === ",")) e.preventDefault();
    if (e.key === "Enter") e.currentTarget.blur();
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    if (integer && /[.,]/.test(e.clipboardData.getData("text"))) e.preventDefault();
  }

  return (
    <input
      type="number"
      name={name}
      id={id}
      style={style}
      value={draft}
      min={min}
      max={max}
      step={integer ? 1 : 0.1}
      disabled={disabled}
      onFocus={() => { focusedRef.current = true; }}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onClick={onClick}
    />
  );
}
