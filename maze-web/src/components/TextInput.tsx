import React, { useEffect, useRef, useState } from "react";

interface Props {
  /** Current committed value. */
  value: string;
  /** Fired with the normalized draft on every keystroke that's valid (see `isValid`) — an
   *  invalid draft is kept on screen but never committed. */
  onChange: (value: string) => void;
  /** Silently reshapes a raw draft before the invalid-check below, e.g. truncating paste/
   *  typeahead to one character and uppercasing it. Identity by default. */
  normalize?: (raw: string) => string;
  /** Classifies the (already `normalize`d) draft as acceptable or not. `true` by default (any
   *  text is valid). */
  isValid?: (raw: string) => boolean;
  disabled?: boolean;
  name?: string;
  id?: string;
  style?: React.CSSProperties;
  spellCheck?: boolean;
  autoComplete?: string;
  "aria-label"?: string;
}

const identity = (raw: string) => raw;
const alwaysValid = () => true;

// A text `<input>` that never lets an `isValid`-rejected draft escape as a committed value —
// mirrors `NumberInput`'s draft/last-valid split: the field freely shows whatever the user typed
// (after `normalize`), but only reports a change upward while that draft is valid, and restores
// the last valid value on blur if left invalid. No error styling of its own — the caller just
// never sees a rejected draft committed.
export function TextInput({ value, onChange, normalize = identity, isValid = alwaysValid, disabled, name = "text-input", id, style, spellCheck = false, autoComplete = "off", ...aria }: Props) {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  const lastValidRef = useRef(value);

  useEffect(() => {
    lastValidRef.current = value;
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const normalized = normalize(e.target.value);
    setDraft(normalized);
    if (isValid(normalized)) {
      lastValidRef.current = normalized;
      onChange(normalized);
    }
  }

  function handleBlur() {
    focusedRef.current = false;
    if (!isValid(draft)) setDraft(lastValidRef.current);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") e.currentTarget.blur();
  }

  return (
    <input
      type="text"
      name={name}
      id={id}
      style={style}
      value={draft}
      disabled={disabled}
      spellCheck={spellCheck}
      autoComplete={autoComplete}
      onFocus={() => { focusedRef.current = true; }}
      onBlur={handleBlur}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      aria-label={aria["aria-label"]}
    />
  );
}
