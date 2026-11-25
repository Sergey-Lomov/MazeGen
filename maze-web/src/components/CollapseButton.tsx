import { ChevronDown, ChevronRight } from "lucide-react";
import { ui } from "../styles/theme";
import type React from "react";
import { Tooltip } from "./Tooltip";

/** Chevron-only collapse/expand toggle — shared by any collapsible section that has no room for
 *  `SectionHeader`'s own label row (e.g. a card title bar that already carries its own label and
 *  toolbar). See GitHub issue #320 (QC panel stage/rule collapsing). */
export function CollapseButton({ collapsed, onToggle, collapseTitle, expandTitle, style, disabled = false, disabledTitle, iconSize = 16 }: {
  collapsed: boolean;
  onToggle: () => void;
  collapseTitle: string;
  expandTitle: string;
  style: React.CSSProperties;
  disabled?: boolean;
  disabledTitle?: string;
  iconSize?: number;
}) {
  return (
    <Tooltip content={disabled ? (disabledTitle ?? collapseTitle) : (collapsed ? expandTitle : collapseTitle)}>
      <button className="hoverable" style={{ ...style, ...(disabled ? { opacity: 0.35 } : {}) }} onClick={onToggle} disabled={disabled}>
        {collapsed ? <ChevronRight size={iconSize} color={ui.text.tertiary} /> : <ChevronDown size={iconSize} color={ui.text.tertiary} />}
      </button>
    </Tooltip>
  );
}
