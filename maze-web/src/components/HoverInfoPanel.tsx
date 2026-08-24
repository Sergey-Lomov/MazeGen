import React, { useEffect, useState } from "react";
import { Search } from "lucide-react";
import type { MazeScene } from "../pixi/MazeScene";
import type { HoverInfo } from "../pixi/hoverTypes";
import { useMazeStore } from "../store/mazeStore";
import { resolveCellInspection } from "../pixi/cellInspectionResolver";
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

  // Cell inspector (GitHub issue #353) — one status-bar readout shared by every feature-renderer
  // with point-anchored markers (Generation, PostEdit, Analytics, image export, Preset Connections),
  // driven by the same hover cell HoverInfoPanel already tracks. Subscribed narrowly to just the fields
  // `resolveCellInspection` actually reads (not the whole store) purely as re-render triggers — the
  // subscribed values themselves are unused below, `resolveCellInspection` re-reads them fresh via
  // `getState()` — so the readout also updates while the cursor sits still and the maze underneath
  // changes (e.g. a post-edit tool click), without re-rendering this panel on every unrelated
  // store change.
  useMazeStore((s) => s.openCard);
  useMazeStore((s) => s.nodes);
  useMazeStore((s) => s.edges);
  useMazeStore((s) => s._generatedNodes);
  useMazeStore((s) => s._generatedEdges);
  useMazeStore((s) => s.start);
  useMazeStore((s) => s.finish);
  useMazeStore((s) => s.floors);
  useMazeStore((s) => s.activeFloorId);
  useMazeStore((s) => s.debugMode);
  useMazeStore((s) => s.debugArena);
  useMazeStore((s) => s.debugStep);
  useMazeStore((s) => s.presetSplitPoints);
  useMazeStore((s) => s.presetStart);
  useMazeStore((s) => s.presetFinish);
  useMazeStore((s) => s.presetGenSource);
  useMazeStore((s) => s.presetTeleports);
  useMazeStore((s) => s.presetVerticalPassages);
  useMazeStore((s) => s.presetElevators);
  useMazeStore((s) => s.lockedNodes);
  useMazeStore((s) => s.autoLockedNodes);
  const hoverText = hover ? resolveCellInspection(useMazeStore.getState(), hover.x, hover.y) : "";

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
