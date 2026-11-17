import React, { useEffect, useState } from "react";
import { useMazeStore } from "../store/mazeStore";
import { useDelayedIndicator } from "./useDelayedIndicator";
import { Button } from "./Button";
import { ui, radius, typography } from "../styles/theme";
import * as m from "~/paraglide/messages";

/** Full-app guard for an in-flight generation. Delaying it avoids a distracting flash for fast runs. */
export function GenerationProgressOverlay() {
  const progress = useMazeStore((s) => s.generationProgress);
  const cancelGeneration = useMazeStore((s) => s.cancelGeneration);
  const visible = useDelayedIndicator(progress !== null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [displayedProgress, setDisplayedProgress] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (progress === null) return;
    setStartedAt((current) => current ?? Date.now());
    setDisplayedProgress(progress);
  }, [progress]);

  useEffect(() => {
    if (!visible) {
      if (progress === null) {
        setStartedAt(null);
        setDisplayedProgress(null);
      }
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [visible, progress]);

  if (!visible || displayedProgress === null) return null;
  const status = displayedProgress < 70
    ? m["generation.progress_generating"]()
    : displayedProgress < 98
      ? m["generation.progress_quality_control"]()
      : m["generation.progress_analytics"]();
  const elapsedSeconds = Math.floor((now - (startedAt ?? now)) / 1_000);

  return (
    <div style={styles.backdrop} role="dialog" aria-modal="true" aria-label={m["generation.progress_title"]()}>
      <div style={styles.card}>
        <div style={styles.title}>{m["generation.progress_title"]()}</div>
        <div role="status" style={styles.status}>{status}</div>
        <div role="progressbar" aria-label={status} style={styles.track}>
          <div className="loading-progress-indeterminate" style={styles.bar} />
        </div>
        <div style={styles.elapsed}>{m["generation.progress_elapsed"]({ time: formatElapsed(elapsedSeconds) })}</div>
        <Button variant="secondary" layoutStyle={styles.cancel} onClick={cancelGeneration}>{m["common.cancel"]()}</Button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: { position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", background: "rgba(7, 9, 12, 0.72)" },
  card: { width: 320, padding: 24, border: `1px solid ${ui.border.default}`, borderRadius: radius.md, background: ui.bg.panel, boxShadow: "0 18px 60px rgba(0, 0, 0, 0.5)", display: "flex", flexDirection: "column", gap: 14 },
  title: { ...typography.body, fontWeight: 600, textAlign: "center" },
  status: { ...typography.body, textAlign: "center" },
  track: { height: 4, overflow: "hidden", borderRadius: 2, background: ui.bg.input },
  bar: { width: "100%", height: "100%", borderRadius: "inherit", background: ui.accent.base, transformOrigin: "left", transform: "scaleX(0.3)" },
  elapsed: { ...typography.caption, color: ui.text.tertiary, textAlign: "center" },
  cancel: { alignSelf: "center", minWidth: 100 },
};

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
