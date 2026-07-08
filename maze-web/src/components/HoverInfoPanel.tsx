import React, { useEffect, useState } from "react";
import type { MazeScene } from "../pixi/MazeScene";
import type { HoverInfo } from "../pixi/hoverTypes";
import { ui, typography, muted } from "../styles/theme";

interface HoverInfoPanelProps {
  scene: MazeScene | null;
}

export function HoverInfoPanel({ scene }: HoverInfoPanelProps) {
  const [hover, setHover] = useState<HoverInfo | null>(null);

  useEffect(() => {
    if (!scene) { setHover(null); return; }
    scene.setHoverListener(setHover);
    return () => scene.setHoverListener(null);
  }, [scene]);

  return (
    <div style={styles.bar}>
      <span style={styles.label}>{hover ? `x: ${hover.x}, y: ${hover.y}` : ""}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    padding: "0 12px",
    background: ui.bg.panelAlt,
    borderTop: `1px solid ${ui.border.default}`,
    flexShrink: 0,
    height: 24,
    boxSizing: "border-box",
  },
  label: {
    ...muted(typography.body),
    whiteSpace: "nowrap",
  },
};
