import { useEffect, useRef, useState } from "react";
import type React from "react";
import { X } from "lucide-react";
import { FlatIconButton } from "./FlatIconButton";
import { sharedStyles } from "../styles/shared";
import * as m from "~/paraglide/messages";

const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_FIELD_HEIGHT = 24;
const SEARCH_FIELD_LINE_HEIGHT = 16;
const COMPACT_ACTION_SIZE = 18;
const COMPACT_ACTION_INSET = (SEARCH_FIELD_HEIGHT - COMPACT_ACTION_SIZE) / 2;
const SEARCH_TEXT_ACTION_GAP = 6;
const SEARCH_TEXT_END_INSET = COMPACT_ACTION_SIZE + COMPACT_ACTION_INSET + SEARCH_TEXT_ACTION_GAP;

/**
 * The one search/filter text field for the web UI. It deliberately uses `type="text"`: native
 * search controls have browser-specific clear buttons, whereas this component owns one clear
 * action, focus behaviour, and debounce policy everywhere.
 */
export function SearchInput({
  value,
  onValueChange,
  layoutStyle,
  disabled,
  ...inputProps
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange" | "style" | "disabled"> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Layout only: the search field's visual treatment is fixed here for every consumer. */
  layoutStyle?: React.CSSProperties;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // A consumer may normalize a committed query (the post-edit id filter trims whitespace), so
    // its value is authoritative even when it differs from the draft we emitted.
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (draft === value) return;
    const timer = window.setTimeout(() => {
      onValueChange(draft);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, onValueChange, value]);

  const clear = () => {
    setDraft("");
    onValueChange("");
    inputRef.current?.focus();
  };

  return (
    <div style={{ position: "relative", minWidth: 0, ...layoutStyle }}>
      <input
        {...inputProps}
        ref={inputRef}
        type="text"
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        style={{
          ...sharedStyles.input,
          display: "block",
          boxSizing: "border-box",
          width: "100%",
          height: SEARCH_FIELD_HEIGHT,
          lineHeight: `${SEARCH_FIELD_LINE_HEIGHT}px`,
          paddingRight: SEARCH_TEXT_END_INSET,
        }}
      />
      {draft !== "" && !disabled ? (
        <FlatIconButton
          title={m["common.clear_search"]()}
          ariaLabel={m["common.clear_search"]()}
          size="compact"
          withTooltip={false}
          extraClassName="search-input-clear"
          onMouseDown={(event) => event.preventDefault()}
          onClick={clear}
          // Flat icon buttons normally use negative vertical margins when participating in a row.
          // This one is absolutely positioned, so it needs no layout height and centres against the
          // input box itself (the input is block-level to avoid an inline baseline gap below it).
          layoutStyle={{ position: "absolute", right: COMPACT_ACTION_INSET, top: "50%", transform: "translateY(-50%)", margin: 0 }}
        >
          <X size={16} />
        </FlatIconButton>
      ) : null}
    </div>
  );
}
