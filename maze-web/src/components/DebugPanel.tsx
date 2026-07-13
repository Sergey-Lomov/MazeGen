import React, { useEffect } from "react";
import { X } from "lucide-react";
import { useMazeStore } from "../store/mazeStore";
import { selectDebugMazeView } from "../store/debugSelectors";
import { ui, radius, typography, muted } from "../styles/theme";
import { StepSlider } from "./StepSlider";
import { DebugEventTree } from "./DebugEventTree";
import * as m from "~/paraglide/messages";

export function DebugPanel() {
  const debugArena  = useMazeStore((s) => s.debugArena);
  const debugStep   = useMazeStore((s) => s.debugStep);
  const debugStale  = useMazeStore((s) => s.debugStale);
  const delayMs     = useMazeStore((s) => s.debugAutoPlayDelay);
  const setDebugStep = useMazeStore((s) => s.setDebugStep);
  const setDebugMode = useMazeStore((s) => s.setDebugMode);
  const setDelayMs   = useMazeStore((s) => s.setDebugAutoPlayDelay);

  const [playing, setPlaying] = React.useState(false);
  const [delayDraft, setDelayDraft] = React.useState(String(delayMs));
  const total = debugArena?.totalSteps ?? 0;
  const currentEdges = debugArena ? selectDebugMazeView(debugArena, debugStep)?.edges.length ?? 0 : 0;

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
    <div style={styles.panel}>
      {debugStale && (
        <div style={styles.staleAlert}>{m["debug.outdated_warning"]()}</div>
      )}
      <div style={styles.controls}>
        {/* Step buttons */}
        <button className="hoverable" style={styles.iconBtn} disabled={atStart} onClick={() => { setPlaying(false); setDebugStep(debugStep - 1); }} title={m["debug.prev_step"]()}>◀</button>
        <button className="hoverable" style={styles.iconBtn} disabled={atEnd}   onClick={() => { setPlaying(false); setDebugStep(debugStep + 1); }} title={m["debug.next_step"]()}>▶</button>

        {/* Autoplay */}
        <button
          className="hoverable"
          style={styles.playBtn}
          onClick={() => setPlaying(p => !p)}
          title={playing ? m["debug.pause"]() : m["debug.play"]()}
        >
          {playing ? "⏸" : "▷"}
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
          {debugStep + 1} / {total} <span style={styles.edgeCount}>({currentEdges} edges)</span>
        </span>
        <StepSlider
          value={debugStep}
          max={total - 1}
          style={styles.slider}
          onChange={(v) => { setPlaying(false); setDebugStep(v); }}
        />
      </div>

      <DebugEventTree />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 320,
    minWidth: 320,
    background: ui.bg.panel,
    borderLeft: `1px solid ${ui.border.default}`,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    flexShrink: 0,
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
    width: 150,
    overflow: "hidden" as const,
  },
  edgeCount: {
    color: ui.text.disabled,
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
