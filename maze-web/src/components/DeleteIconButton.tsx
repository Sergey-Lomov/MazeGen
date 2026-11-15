import type React from "react";
import { IconActionButton } from "./IconActionButton";

/** Shared neutral delete action for controls that permanently remove an item. */
export function DeleteIconButton({ onClick, title, disabled, tone = "neutral", ...props }: Omit<React.ComponentProps<typeof IconActionButton>, "action" | "title" | "onClick" | "disabled" | "variant"> & {
  onClick: (event: React.MouseEvent) => void;
  title: string;
  disabled?: boolean;
  tone?: "neutral" | "danger";
}) {
  return <IconActionButton {...props} action="delete" title={title} variant={tone === "danger" ? "danger" : "default"} disabled={disabled} onClick={onClick} />;
}
