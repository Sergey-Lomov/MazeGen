import React, { useEffect } from "react";
import { useMazeStore } from "../store/mazeStore";
import { colors, font, radius } from "../styles/theme";
import { Switch } from "./Switch";
import { StepSlider } from "./StepSlider";
import * as m from "~/paraglide/messages";

export function GenerationDebugBar() {
  const debugSnapshot        = useMazeStore((s) => s.debugSnapshot);
  const debugStep            = useMazeStore((s) => s.debugStep);
  const debugStale           = useMazeStore((s) => s.debugStale);
  const showDebugFrontier    = useMazeStore((s) => s.showDebugFrontier);
  const delayMs              = useMazeStore((s) => s.debugAutoPlayDelay);
  const setDebugStep         = useMazeStore((s) => s.setDebugStep);
  const setDebugMode         = useMazeStore((s) => s.setDebugMode);
  const setShowDebugFrontier = useMazeStore((s) => s.setShowDebugFrontier);
  const setDelayMs           = useMazeStore((s) => s.setDebugAutoPlayDelay);

  const [playing, setPlaying] = React.useState(false);
  const [delayDraft, setDelayDraft] = React.useState(String(delayMs));
  const total = debugSnapshot?.steps.length ?? 0;
  const currentEdges = debugSnapshot?.steps[debugStep]?.edges.length ?? 0;

  useEffect(() => {
    if (!playing) return;
    const ms = Math.max(50, delayMs);
    const id = setInterval(() => {
      const step = useMazeStore.getState().debugStep;
      const snap = useMazeStore.getState().debugSnapshot;
      const last = (snap?.steps.length ?? 1) - 1;
      if (step >= last) {
        setPlaying(false);
      } else {
        useMazeStore.getState().setDebugStep(step + 1);
      }
    }, ms);
    return () => clearInterval(id);
  }, [playing, delayMs]);

  useEffect(() => { setDelayDraft(String(delayMs)); }, [delayMs]);

  // Stop autoplay when snapshot changes
  useEffect(() => { setPlaying(false); }, [debugSnapshot]);

  if (!debugSnapshot) return null;

  function handleClose() {
    setPlaying(false);
    setDebugMode(false);
  }

  const atStart = debugStep <= 0;
  const atEnd   = debugStep >= total - 1;

  return (
    <>
      {debugStale && (
        <div style={styles.staleAlert}>{m["debug.outdated_warning"]()}</div>
      )}
      <div style={styles.bar}>
        {/* Step buttons */}
        <button style={styles.iconBtn} disabled={atStart} onClick={() => { setPlaying(false); setDebugStep(debugStep - 1); }} title={m["debug.prev_step"]()}>◀</button>
        <button style={styles.iconBtn} disabled={atEnd}   onClick={() => { setPlaying(false); setDebugStep(debugStep + 1); }} title={m["debug.next_step"]()}>▶</button>

        {/* Autoplay */}
        <button
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

        <div style={styles.divider} />

        {/* Frontier toggle */}
        <span style={styles.label}>{m["debug.frontier"]()}</span>
        <Switch checked={showDebugFrontier} onChange={setShowDebugFrontier} />

        <div style={styles.divider} />

        {/* Step counter */}
        <span style={styles.stepLabel}>
          {debugStep + 1} / {total} <span style={styles.edgeCount}>({currentEdges} edges)</span>
        </span>

        {/* Slider */}
        <StepSlider
          value={debugStep}
          max={total - 1}
          style={styles.slider}
          onChange={(v) => { setPlaying(false); setDebugStep(v); }}
        />

        {/* Close */}
        <button style={styles.closeBtn} onClick={handleClose} title={m["debug.exit"]()}>×</button>
      </div>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "7px 16px",
    background: colors.bgPanelAlt,
    borderBottom: `1px solid ${colors.borderMid}`,
    flexShrink: 0,
  },
  iconBtn: {
    background: colors.bgInput,
    border: `1px solid ${colors.borderStrong}`,
    color: colors.textMuted,
    cursor: "pointer",
    padding: "0 10px",
    fontSize: font.lg,
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
    background: colors.bgInput,
    border: `1px solid ${colors.borderStrong}`,
    color: colors.textMuted,
    cursor: "pointer",
    padding: "0 12px",
    fontSize: font.lg,
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
    background: colors.bgInput,
    border: `1px solid ${colors.borderStrong}`,
    color: colors.textMuted,
    fontSize: font.md,
    padding: "0 6px",
    width: 60,
    height: 28,
    boxSizing: "border-box" as const,
    borderRadius: radius.sm,
    flexShrink: 0,
    textAlign: "right" as const,
  },
  divider: {
    width: 1,
    height: 20,
    background: colors.borderStrong,
    flexShrink: 0,
    margin: "0 4px",
  },
  label: {
    fontSize: font.md,
    color: colors.textMuted,
    flexShrink: 0,
    whiteSpace: "nowrap" as const,
  },
  stepLabel: {
    fontSize: font.md,
    color: colors.textMuted,
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
    width: 150,
    overflow: "hidden" as const,
  },
  edgeCount: {
    color: colors.textVeryDim,
  },
  slider: {
    flex: 1,
    minWidth: 60,
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: colors.textDim,
    cursor: "pointer",
    fontSize: font.xl,
    padding: "0 2px",
    flexShrink: 0,
    lineHeight: 1,
  },
  staleAlert: {
    background: "#3a1010",
    color: "#ff6b6b",
    fontSize: font.sm,
    padding: "4px 12px",
    flexShrink: 0,
  },
};
