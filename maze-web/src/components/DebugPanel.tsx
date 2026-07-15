import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useMazeStore } from "../store/mazeStore";
import { ui, radius, typography, muted } from "../styles/theme";
import { StepSlider } from "./StepSlider";
import { DebugEventTree } from "./DebugEventTree";
import { ToggleRow } from "./ToggleRow";
import * as m from "~/paraglide/messages";

const MIN_PANEL_WIDTH = 320;

/** Maps a debug-value name (GitHub issue #131, e.g. `"recursion_stack"`) to its i18n label. Not
 *  auto-derived from the name — a runtime string can't be turned into a paraglide message key —
 *  so each known name gets an explicit entry here. A name without one (a future algorithm's debug
 *  value the message catalog hasn't caught up with yet) falls back to the raw name, so an
 *  untranslated toggle still renders instead of crashing. */
const DEBUG_VALUE_LABELS: Record<string, () => string> = {
  recursion_stack: () => m["debug.value.recursion_stack"](),
  visited: () => m["debug.value.visited"](),
  current_walk: () => m["debug.value.current_walk"](),
  walk_start: () => m["debug.value.walk_start"](),
  walk_head: () => m["debug.value.walk_head"](),
};

function debugValueLabel(name: string): string {
  return DEBUG_VALUE_LABELS[name]?.() ?? name;
}

export function DebugPanel() {
  const debugArena  = useMazeStore((s) => s.debugArena);
  const debugStep   = useMazeStore((s) => s.debugStep);
  const debugStale  = useMazeStore((s) => s.debugStale);
  const delayMs     = useMazeStore((s) => s.debugAutoPlayDelay);
  const debugValueToggles = useMazeStore((s) => s.debugValueToggles);
  const showKruskalDsuGroups = useMazeStore((s) => s.showKruskalDsuGroups);
  const setDebugStep = useMazeStore((s) => s.setDebugStep);
  const setDebugMode = useMazeStore((s) => s.setDebugMode);
  const setDelayMs   = useMazeStore((s) => s.setDebugAutoPlayDelay);
  const toggleDebugValue = useMazeStore((s) => s.toggleDebugValue);
  const toggleKruskalDsuGroups = useMazeStore((s) => s.toggleKruskalDsuGroups);

  const [playing, setPlaying] = React.useState(false);
  const [delayDraft, setDelayDraft] = React.useState(String(delayMs));
  const [width, setWidth] = useState(MIN_PANEL_WIDTH);
  const resizing = useRef(false);
  const total = debugArena?.totalSteps ?? 0;
  // Each half is sized to `total`'s digit count (the max either side can reach), not the current
  // step's digit count, so the " / " separator stays pinned to the row's center instead of
  // drifting as the digit count changes during scrubbing/playback.
  const stepLabelHalfWidth = `${String(total).length}ch`;

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!resizing.current) return;
      setWidth((w) => Math.max(MIN_PANEL_WIDTH, w - e.movementX));
    }
    function handleMouseUp() {
      resizing.current = false;
    }
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  useEffect(() => {
    if (!playing) return;
    const ms = Math.max(50, delayMs);
    const id = setInterval(() => {
      const state = useMazeStore.getState();
      const step = state.debugStep;
      const last = (state.debugArena?.totalSteps ?? 1) - 1;
      if (step >= last) {
        setPlaying(false);
      } else {
        state.setDebugStep(step + 1);
      }
    }, ms);
    return () => clearInterval(id);
  }, [playing, delayMs]);

  useEffect(() => { setDelayDraft(String(delayMs)); }, [delayMs]);

  // Stop autoplay when the debug arena changes
  useEffect(() => { setPlaying(false); }, [debugArena]);

  if (!debugArena) return null;

  function handleClose() {
    setPlaying(false);
    setDebugMode(false);
  }

  const atStart = debugStep <= 0;
  const atEnd   = debugStep >= total - 1;

  return (
    <div style={{ ...styles.panel, width, minWidth: MIN_PANEL_WIDTH }}>
      <div
        style={styles.resizeHandle}
        onMouseDown={(e) => { e.preventDefault(); resizing.current = true; }}
      />
      {debugStale && (
        <div style={styles.staleAlert}>{m["debug.outdated_warning"]()}</div>
      )}
      <div style={styles.controls}>
        {/* Step buttons */}
        <button className="hoverable" style={styles.iconBtn} disabled={atStart} onClick={() => { setPlaying(false); setDebugStep(debugStep - 1); }} title={m["debug.prev_step"]()}>❮</button>
        <button className="hoverable" style={styles.iconBtn} disabled={atEnd}   onClick={() => { setPlaying(false); setDebugStep(debugStep + 1); }} title={m["debug.next_step"]()}>❯</button>

        {/* Autoplay */}
        <button
          className="hoverable"
          style={styles.playBtn}
          onClick={() => setPlaying(p => !p)}
          title={playing ? m["debug.stop"]() : m["debug.play"]()}
        >
          {playing ? "⏹" : "▶"}
        </button>

        {/* Delay */}
        <input
          type="text"
          style={styles.delayInput}
          value={delayDraft}
          title={m["debug.delay_ms"]()}
          onChange={(e) => setDelayDraft(e.target.value)}
          onBlur={() => {
            const v = Math.max(50, Math.min(9999, parseInt(delayDraft, 10) || delayMs));
            setDelayMs(v);
            setDelayDraft(String(v));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        <span style={styles.label}>ms</span>

        {/* Close */}
        <button className="hoverable" style={styles.closeBtn} onClick={handleClose} title={m["debug.exit"]()}><X size={16} /></button>
      </div>

      <div style={styles.stepRow}>
        <span style={styles.stepLabel}>
          <span style={{ ...styles.stepLabelHalf, width: stepLabelHalfWidth, textAlign: "right" as const }}>{debugStep + 1}</span>
          {" / "}
          <span style={{ ...styles.stepLabelHalf, width: stepLabelHalfWidth, textAlign: "left" as const }}>{total}</span>
        </span>
        <StepSlider
          value={debugStep}
          max={total - 1}
          style={styles.slider}
          onChange={(v) => { setPlaying(false); setDebugStep(v); }}
        />
      </div>

      {(debugArena.debugValueNames.length > 0 || debugArena.algorithmKind === "kruskal") && (
        <div style={styles.debugValuesRow}>
          {debugArena.debugValueNames.map(({ name }) => (
            <ToggleRow
              key={name}
              label={debugValueLabel(name)}
              checked={debugValueToggles.has(name)}
              onChange={() => toggleDebugValue(name)}
            />
          ))}
          {debugArena.algorithmKind === "kruskal" && (
            <ToggleRow
              label={m["debug.value.kruskal_dsu_groups"]()}
              checked={showKruskalDsuGroups}
              onChange={toggleKruskalDsuGroups}
            />
          )}
        </div>
      )}

      <DebugEventTree />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    background: ui.bg.panel,
    borderLeft: `1px solid ${ui.border.default}`,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    flexShrink: 0,
    position: "relative",
  },
  resizeHandle: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: -3,
    width: 6,
    cursor: "ew-resize",
    zIndex: 1,
  },
  controls: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "7px 16px",
    background: ui.bg.panelAlt,
    borderBottom: `1px solid ${ui.border.default}`,
    flexShrink: 0,
  },
  stepRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "7px 16px",
    borderBottom: `1px solid ${ui.border.default}`,
    flexShrink: 0,
  },
  debugValuesRow: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
    padding: "7px 16px",
    borderBottom: `1px solid ${ui.border.default}`,
    flexShrink: 0,
  },
  iconBtn: {
    ...typography.control,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.secondary,
    cursor: "default",
    padding: "0 10px",
    flexShrink: 0,
    height: 28,
    boxSizing: "border-box" as const,
    borderRadius: radius.sm,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
    appearance: "none" as const,
    paddingBottom: 2,
  },
  playBtn: {
    ...typography.control,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.secondary,
    cursor: "default",
    padding: "0 12px",
    flexShrink: 0,
    height: 28,
    boxSizing: "border-box" as const,
    borderRadius: radius.sm,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
    appearance: "none" as const,
    paddingBottom: 2,
  },
  delayInput: {
    ...typography.field,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.secondary,
    padding: "0 6px",
    width: 60,
    height: 28,
    boxSizing: "border-box" as const,
    borderRadius: radius.sm,
    flexShrink: 0,
    textAlign: "right" as const,
  },
  label: {
    ...muted(typography.body),
    flexShrink: 0,
    whiteSpace: "nowrap" as const,
  },
  stepLabel: {
    ...muted(typography.body),
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
  },
  stepLabelHalf: {
    display: "inline-block" as const,
    overflow: "hidden" as const,
    verticalAlign: "top" as const,
  },
  slider: {
    flex: 1,
    minWidth: 60,
  },
  closeBtn: {
    ...typography.icon,
    background: "none",
    border: "none",
    color: ui.text.tertiary,
    cursor: "default",
    padding: "0 2px",
    flexShrink: 0,
    lineHeight: 1,
    marginLeft: "auto",
  },
  staleAlert: {
    ...typography.body,
    background: ui.bg.error,
    color: ui.text.error,
    padding: "4px 12px",
    flexShrink: 0,
  },
};
