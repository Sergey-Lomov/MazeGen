import type React from "react";
import { IconActionButton } from "./IconActionButton";

/** Shared edit action for row and panel controls. */
export function EditIconButton({ onClick, title, fontSize, disabled, active = false, style }: {
  onClick: (e: React.MouseEvent) => void;
  title: string;
  fontSize?: number;
  disabled?: boolean;
  active?: boolean;
  /** Extra layout or state styling for a genuinely exceptional edit control. */
  style?: React.CSSProperties;
}) {
  return (
    <IconActionButton action="edit" title={title} disabled={disabled} active={active} onClick={onClick} layoutStyle={{ ...(fontSize === undefined ? {} : { fontSize }), ...style }} />
  );
}
