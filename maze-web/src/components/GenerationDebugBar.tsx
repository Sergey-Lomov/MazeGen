import React, { useEffect } from "react";
import { useMazeStore } from "../store/mazeStore";
import { colors, font } from "../styles/theme";
import * as m from "~/paraglide/messages";

const DEFAULT_DELAY_MS = 500;

export function GenerationDebugBar() {
  const debugSnapshot     = useMazeStore((s) => s.debugSnapshot);
  const debugStep         = useMazeStore((s) => s.debugStep);
  const debugStale        = useMazeStore((s) => s.debugStale);
  const showDebugFrontier = useMazeStore((s) => s.showDebugFrontier);
  const setDebugStep      = useMazeStore((s) => s.setDebugStep);
  const setDebugMode      = useMazeStore((s) => s.setDebugMode);
  const setShowDebugFrontier = useMazeStore((s) => s.setShowDebugFrontier);

  const [playing, setPlaying] = React.useState(false);
  const [delayMs, setDelayMs] = React.useState(DEFAULT_DELAY_MS);
  const [delayDraft, setDelayDraft] = React.useState(String(DEFAULT_DELAY_MS));
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
            const v = Math.max(50, Math.min(9999, parseInt(delayDraft, 10) || DEFAULT_DELAY_MS));
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
        <MiniSwitch checked={showDebugFrontier} onChange={setShowDebugFrontier} />

        <div style={styles.divider} />

        {/* Step counter */}
        <span style={styles.stepLabel}>
          {debugStep + 1} / {total} <span style={styles.edgeCount}>({currentEdges} edges)</span>
        </span>

        {/* Slider */}
        <input
          type="range"
          className="maze-slider"
          style={styles.slider}
          min={0}
          max={Math.max(0, total - 1)}
          value={debugStep}
          onChange={(e) => { setPlaying(false); setDebugStep(Number(e.target.value)); }}
        />

        {/* Close */}
        <button style={styles.closeBtn} onClick={handleClose} title={m["debug.exit"]()}>×</button>
      </div>
    </>
  );
}

function MiniSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={sw.wrap}>
      <input type="checkbox" style={sw.input} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span style={{ ...sw.track, ...(checked ? sw.trackOn : {}) }}>
        <span style={{ ...sw.thumb, ...(checked ? sw.thumbOn : {}) }} />
      </span>
    </label>
  );
}

const sw: Record<string, React.CSSProperties> = {
  wrap:  { position: "relative", display: "inline-flex", alignItems: "center", cursor: "pointer", flexShrink: 0 },
  input: { position: "absolute", opacity: 0, width: 0, height: 0 },
  track: { display: "inline-block", width: 26, height: 14, background: colors.borderStrong, borderRadius: 7, position: "relative", transition: "background 0.15s" },
  trackOn:  { background: colors.bgBtnPrimary },
  thumb:    { position: "absolute", top: 2, left: 2, width: 10, height: 10, background: colors.textWhite, borderRadius: "50%", transition: "left 0.15s" },
  thumbOn:  { left: 14 },
};

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px",
    background: colors.bgPanelAlt,
    borderBottom: `1px solid ${colors.borderMid}`,
    flexShrink: 0,
  },
  iconBtn: {
    background: colors.bgInput,
    border: `1px solid ${colors.borderStrong}`,
    color: colors.textMuted,
    cursor: "pointer",
    padding: "2px 7px",
    fontSize: font.md,
    flexShrink: 0,
    lineHeight: 1.2,
  },
  playBtn: {
    background: colors.bgInput,
    border: `1px solid ${colors.borderStrong}`,
    color: colors.textMuted,
    cursor: "pointer",
    padding: "2px 9px",
    fontSize: font.md,
    flexShrink: 0,
    lineHeight: 1.2,
  },
  delayInput: {
    background: colors.bgInput,
    border: `1px solid ${colors.borderStrong}`,
    color: colors.textMuted,
    fontSize: font.sm,
    padding: "2px 4px",
    width: 52,
    flexShrink: 0,
    textAlign: "right" as const,
  },
  divider: {
    width: 1,
    height: 16,
    background: colors.borderStrong,
    flexShrink: 0,
    margin: "0 2px",
  },
  label: {
    fontSize: font.sm,
    color: colors.textMuted,
    flexShrink: 0,
    whiteSpace: "nowrap" as const,
  },
  stepLabel: {
    fontSize: font.sm,
    color: colors.textMuted,
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
    minWidth: 90,
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
