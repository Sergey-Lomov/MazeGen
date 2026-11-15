import type React from "react";
import { IconActionButton } from "./IconActionButton";

/** Shared add action for row and panel controls. */
export function AddIconButton({ onClick, title }: { onClick: (e: React.MouseEvent) => void; title: string }) {
  return <IconActionButton action="add" title={title} onClick={onClick} />;
}
