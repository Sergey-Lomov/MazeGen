import React, { useEffect, useState } from "react";
import { Search } from "lucide-react";
import type { MazeScene } from "../pixi/MazeScene";
import type { HoverInfo } from "../pixi/hoverTypes";
import { ui, typography, muted, inset, spacing } from "../styles/theme";

interface HoverInfoPanelProps {
  scene: MazeScene | null;
}

export function HoverInfoPanel({ scene }: HoverInfoPanelProps) {
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [scale, setScale] = useState<number>(1);

  useEffect(() => {
    if (!scene) { setHover(null); return; }
    scene.setHoverListener(setHover);
    return () => scene.setHoverListener(null);
  }, [scene]);

  useEffect(() => {
    if (!scene) return;
    scene.setViewportScaleListener(setScale);
    return () => scene.setViewportScaleListener(null);
  }, [scene]);

  const hoverText = hover ? `x: ${hover.x}, y: ${hover.y}` : "";

  return (
    <div style={styles.bar}>
      {scene && (
        <span style={styles.scale}>
          <Search size={13} />
          {Math.round(scale * 100)}%
        </span>
      )}
      {hoverText && <span style={styles.label}>{hoverText}</span>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    gap: spacing.groupGap,
    padding: `0 ${inset.panelInsetX}px`,
    background: ui.bg.panelAlt,
    borderTop: `1px solid ${ui.border.default}`,
    flexShrink: 0,
    height: 24,
    boxSizing: "border-box",
  },
  scale: {
    ...muted(typography.body),
    display: "flex",
    alignItems: "center",
    gap: 4,
    whiteSpace: "nowrap",
  },
  label: {
    ...muted(typography.body),
    whiteSpace: "nowrap",
  },
};
