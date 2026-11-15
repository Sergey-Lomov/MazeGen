import type React from "react";
import { FlatIconButton } from "./FlatIconButton";
import { IconActionButton } from "./IconActionButton";

/** Shared information action with the common icon-button hover treatment. */
export function InfoIconButton({ onClick, label = "Info", inList = false, hoverable = true, disabled = false, testId }: {
  onClick: () => void;
  label?: string;
  /** A list action keeps its parent list's focus and does not become a tab stop. */
  inList?: boolean;
  /** Suppresses the hover highlight for a deliberately static inline badge. */
  hoverable?: boolean;
  /** Dimmed and inert: it keeps its place, so the row does not shift when an action becomes unavailable. */
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <IconActionButton
      action="info"
      title={label}
      withTooltip={false}
      suppressHover={!hoverable}
      tabIndex={inList ? -1 : undefined}
      disabled={disabled}
      data-testid={testId}
      onMouseDown={inList ? (event) => event.preventDefault() : undefined}
      onClick={(event) => {
        if (inList) event.stopPropagation();
        onClick();
      }}
    />
  );
}
