import React, { useEffect, useRef, useState } from "react";
import { Application } from "pixi.js";
import { MazeScene } from "./pixi/MazeScene";
import { FeaturesPanel } from "./components/FeaturesPanel";
import { QualityCanvas } from "./components/features/QualityCanvas";
import { DebugPanel } from "./components/DebugPanel";
import { HoverInfoPanel } from "./components/HoverInfoPanel";
import { useMazeStore } from "./store/mazeStore";
import { ui, typography, disabled } from "./styles/theme";
import { canvas } from "./pixi/colorUtils";
import { useLocale } from "./i18n/useLocale";
import * as m from "~/paraglide/messages";

const PANEL_WIDTH = 260;

export function App() {
  useLocale(); // re-render entire tree on locale change
  const canvasRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<MazeScene | null>(null);
  const [ready, setReady] = useState(false);
  const loadRegistry = useMazeStore((s) => s.loadRegistry);
  const debugMode = useMazeStore((s) => s.debugMode);
  const debugArena = useMazeStore((s) => s.debugArena);
  const openCard = useMazeStore((s) => s.openCard);
  const generationOpen = openCard === "generation";
  const qualityOpen = openCard === "quality";

  useEffect(() => {
    loadRegistry();
  }, [loadRegistry]);

  useEffect(() => {
    if (!canvasRef.current || sceneRef.current) return;

    let cancelled = false;
    const app = new Application();

    app
      .init({ resizeTo: canvasRef.current, background: canvas.stage.background, antialias: true })
      .then(() => {
        if (cancelled) { app.destroy(); return; }
        canvasRef.current!.appendChild(app.canvas);
        sceneRef.current = new MazeScene(app);
        setReady(true);
      });

    return () => {
      cancelled = true;
      sceneRef.current?.destroy();
      sceneRef.current = null;
    };
  }, []);

  return (
    <div style={styles.root}>
      <div style={styles.panel}>
        {!ready && <div style={styles.loading}>{m["common.loading"]()}</div>}
        <FeaturesPanel onRefit={() => sceneRef.current?.refit()} />
      </div>
      <div style={styles.canvasColumn}>
        <div ref={canvasRef} style={{ ...styles.canvas, display: qualityOpen ? "none" : undefined }} />
        {qualityOpen && <QualityCanvas />}
        {!qualityOpen && <HoverInfoPanel scene={ready ? sceneRef.current : null} />}
      </div>
      {generationOpen && debugMode && debugArena && <DebugPanel />}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", width: "100%", height: "100%" },
  panel: {
    width: PANEL_WIDTH,
    minWidth: PANEL_WIDTH,
    background: ui.bg.panel,
    borderRight: `1px solid ${ui.border.default}`,
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
  },
  canvasColumn: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  canvas: { flex: 1, overflow: "hidden" },
  loading: { padding: 12, ...disabled(typography.body) },
};
