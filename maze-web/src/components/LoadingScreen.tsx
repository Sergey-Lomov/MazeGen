import React from "react";
import { ui, typography } from "../styles/theme";

export function LoadingScreen({ status, progress, leaving = false }: {
  status: string;
  progress?: number;
  leaving?: boolean;
}) {
  return (
    <div aria-live="polite" aria-busy={!leaving} style={{ ...styles.screen, opacity: leaving ? 0 : 1, pointerEvents: leaving ? "none" : undefined }}>
      <div style={styles.content}>
        <div style={styles.mark} aria-hidden="true">M</div>
        <div style={styles.name}>Maze Studio</div>
        <div role="status" style={styles.status}>{status}</div>
        <div
          role="progressbar"
          aria-label={status}
          aria-valuemin={progress === undefined ? undefined : 0}
          aria-valuemax={progress === undefined ? undefined : 100}
          aria-valuenow={progress === undefined ? undefined : Math.round(progress * 100)}
          style={styles.track}
        >
          <div className={progress === undefined ? "loading-progress-indeterminate" : undefined} style={{ ...styles.bar, transform: `scaleX(${progress ?? 0.3})` }} />
        </div>
        <div style={styles.percent}>{progress === undefined ? "" : `${Math.round(progress * 100)}%`}</div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  screen: { position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", background: ui.bg.app, transition: "opacity 220ms ease" },
  content: { width: 280, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" },
  mark: { width: 48, height: 48, display: "grid", placeItems: "center", border: `1px solid ${ui.accent.base}`, borderRadius: 8, color: ui.accent.base, fontSize: 24, fontWeight: 700, marginBottom: 10 },
  name: { ...typography.title, fontSize: 20, marginBottom: 26 },
  status: { ...typography.message, minHeight: 17, marginBottom: 9 },
  track: { width: "100%", height: 4, overflow: "hidden", borderRadius: 2, background: ui.bg.input },
  bar: { width: "100%", height: "100%", borderRadius: "inherit", background: ui.accent.base, transformOrigin: "left", transition: "transform 120ms linear" },
  percent: { ...typography.caption, height: 14, marginTop: 6 },
};
