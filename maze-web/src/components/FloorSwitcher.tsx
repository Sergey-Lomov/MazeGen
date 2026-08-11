import React, { useMemo } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { useMazeStore } from "../store/mazeStore";
import type { FloorState } from "../store/mazeStore";
import { ui, radius, typography, spacing, inset, shadow, font } from "../styles/theme";
import * as m from "~/paraglide/messages";

/** Widest a floor title is allowed to push the panel to — beyond this the title itself truncates
 *  with an ellipsis instead of growing the panel further. */
const MAX_PANEL_WIDTH = 300;

let measureCtx: CanvasRenderingContext2D | null = null;

/** Widest rendered width, in px, of any floor's title under the switcher's own title style —
 *  the panel is sized to fit the longest title without reflowing every time the active floor
 *  changes (GitHub issue #336 follow-up). Falls back to a rough ch-based estimate when
 *  `CanvasRenderingContext2D` isn't available (e.g. jsdom in tests). */
function measureMaxTitleWidth(floors: FloorState[]): number {
  if (!measureCtx) {
    const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
    measureCtx = canvas?.getContext("2d") ?? null;
  }
  if (!measureCtx) {
    const longest = floors.reduce((max, f) => Math.max(max, f.title.length), 0);
    return longest * (font.lg * 0.6);
  }
  measureCtx.font = `600 ${font.lg}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  return floors.reduce((max, f) => Math.max(max, measureCtx!.measureText(f.title).width), 0);
}

/** Shared floor-scoping panel (GitHub issue #336), docked top-center over the canvas. Shown by
 *  `App.tsx` for every feature except "Basic configuration"/"Floors"/"Quality control" — see
 *  `FLOOR_SWITCHER_HIDDEN_CARDS`. `floors` is stored bottom-to-top (`floors[0]` = "Floor 1" =
 *  bottom), so the up arrow (visually "go to the floor above") moves `activeFloorId` toward the
 *  end of the array, mirroring `FloorsFeature`'s own up/down inversion. */
export function FloorSwitcher() {
  const floors = useMazeStore((s) => s.floors);
  const activeFloorId = useMazeStore((s) => s.activeFloorId);
  const setActiveFloorId = useMazeStore((s) => s.setActiveFloorId);

  const index = floors.findIndex((f) => f.id === activeFloorId);
  const activeFloor = floors[index] ?? floors[0];
  const canGoUp = index >= 0 && index < floors.length - 1;
  const canGoDown = index > 0;

  // Sized once per `floors` change (not per active-floor switch) to the widest title among all
  // floors, so the panel never reflows/jumps as the user steps between floors of different name
  // lengths — capped at MAX_PANEL_WIDTH, beyond which the title itself truncates.
  const titleWidth = useMemo(() => {
    const widest = measureMaxTitleWidth(floors);
    const arrowsAndGaps = 2 * 16 + 2 * spacing.itemGap + 2 * inset.panelInsetX;
    return Math.min(Math.ceil(widest), MAX_PANEL_WIDTH - arrowsAndGaps);
  }, [floors]);

  function goUp() {
    if (canGoUp) setActiveFloorId(floors[index + 1].id);
  }

  function goDown() {
    if (canGoDown) setActiveFloorId(floors[index - 1].id);
  }

  return (
    <div style={styles.panel}>
      <button
        className={canGoDown ? "hoverable" : undefined}
        style={{ ...styles.arrowBtn, ...(canGoDown ? {} : styles.arrowBtnDisabled) }}
        title={m["floors.switcher_prev_floor"]()}
        disabled={!canGoDown}
        onClick={goDown}
      >
        <ChevronDown size={16} color={ui.text.tertiary} />
      </button>
      <span style={{ ...styles.title, width: titleWidth, textAlign: "center" }}>{activeFloor.title}</span>
      <button
        className={canGoUp ? "hoverable" : undefined}
        style={{ ...styles.arrowBtn, ...(canGoUp ? {} : styles.arrowBtnDisabled) }}
        title={m["floors.switcher_next_floor"]()}
        disabled={!canGoUp}
        onClick={goUp}
      >
        <ChevronUp size={16} color={ui.text.tertiary} />
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: "absolute",
    top: inset.panelInsetY,
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    gap: spacing.itemGap,
    padding: `${inset.toolButtonInset}px ${inset.panelInsetX}px`,
    background: ui.bg.panelAlt,
    border: `1px solid ${ui.border.default}`,
    borderRadius: radius.lg,
    boxShadow: shadow.modal,
    zIndex: 10,
  },
  title: {
    ...typography.field,
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    userSelect: "none",
    flexShrink: 0,
  },
  arrowBtn: {
    background: "none",
    border: "none",
    padding: 0,
    cursor: "default",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
  },
  arrowBtnDisabled: {
    opacity: 0.25,
    cursor: "default",
  },
};
