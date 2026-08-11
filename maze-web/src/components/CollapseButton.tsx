import { ChevronDown, ChevronRight } from "lucide-react";
import { ui } from "../styles/theme";
import type React from "react";

/** Chevron-only collapse/expand toggle — shared by any collapsible section that has no room for
 *  `SectionHeader`'s own label row (e.g. a card title bar that already carries its own label and
 *  toolbar). See GitHub issue #320 (QC panel stage/rule collapsing). */
export function CollapseButton({ collapsed, onToggle, collapseTitle, expandTitle, style }: {
  collapsed: boolean;
  onToggle: () => void;
  collapseTitle: string;
  expandTitle: string;
  style: React.CSSProperties;
}) {
  return (
    <button className="hoverable" style={style} title={collapsed ? expandTitle : collapseTitle} onClick={onToggle}>
      {collapsed ? <ChevronRight size={16} color={ui.text.tertiary} /> : <ChevronDown size={16} color={ui.text.tertiary} />}
    </button>
  );
}
