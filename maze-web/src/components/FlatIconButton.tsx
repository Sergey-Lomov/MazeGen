import type React from "react";
import { Tooltip } from "./Tooltip";

type Props = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className" | "style" | "title"> & {
  title: string;
  children: React.ReactNode;
  /** Layout-only overrides for a genuinely exceptional placement. */
  layoutStyle?: React.CSSProperties;
  /** Accessible control name. Defaults to the tooltip text. */
  ariaLabel?: string;
  /** Destructive actions use the shared red hover treatment. */
  variant?: "default" | "danger" | "contextual";
  /** Keeps the shared active surface visible, optionally using caller-provided CSS variables. */
  active?: boolean;
  /** Suppresses the shared hover highlight for a deliberately static icon. */
  suppressHover?: boolean;
  /** Additional semantic class without replacing the shared surface class. */
  extraClassName?: string;
  /** Allows a surrounding component to own the tooltip while retaining the shared surface. */
  withTooltip?: boolean;
  /** Makes the tooltip anchor fill its parent cross-axis. */
  tooltipStretch?: boolean;
  /** Layout-only override for the tooltip anchor. */
  tooltipLayoutStyle?: React.CSSProperties;
};

/** Shared square surface for compact icon-only actions. */
export function FlatIconButton({ title, children, layoutStyle, type = "button", ariaLabel, variant = "default", active = false, suppressHover = false, extraClassName, withTooltip = true, tooltipStretch = false, tooltipLayoutStyle, ...props }: Props) {
  const button = (
    <button {...props} type={type} className={`btn-flat-icon${variant === "danger" ? " btn-flat-icon-danger" : ""}${variant === "contextual" ? " btn-flat-icon-contextual" : ""}${active ? " btn-flat-icon-active" : ""}${suppressHover ? " btn-flat-icon-no-hover" : ""}${extraClassName ? ` ${extraClassName}` : ""}`} style={layoutStyle} aria-label={ariaLabel ?? title}>
      {children}
    </button>
  );
  return withTooltip ? <Tooltip content={title} stretch={tooltipStretch} layoutStyle={tooltipLayoutStyle}>{button}</Tooltip> : button;
}
