import React, { useEffect, useRef, useState } from "react";
import { Application } from "pixi.js";
import { MazeScene } from "./pixi/MazeScene";
import { FeaturesPanel } from "./components/FeaturesPanel";
import { useMazeStore } from "./store/mazeStore";
import { colors, font } from "./styles/theme";

const PANEL_WIDTH = 260;

export function App() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<MazeScene | null>(null);
  const [ready, setReady] = useState(false);
  const loadRegistry = useMazeStore((s) => s.loadRegistry);

  useEffect(() => {
    loadRegistry();
  }, [loadRegistry]);

  useEffect(() => {
    if (!canvasRef.current || sceneRef.current) return;

    let cancelled = false;
    const app = new Application();

    app
      .init({ resizeTo: canvasRef.current, background: 0x111111, antialias: true })
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
        {!ready && <div style={styles.loading}>Loading…</div>}
        <FeaturesPanel />
      </div>
      <div ref={canvasRef} style={styles.canvas} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", width: "100%", height: "100%" },
  panel: {
    width: PANEL_WIDTH,
    minWidth: PANEL_WIDTH,
    background: colors.bgPanel,
    borderRight: `1px solid ${colors.borderMid}`,
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
  },
  canvas: { flex: 1, overflow: "hidden" },
  loading: { padding: 12, fontSize: font.sm, color: colors.textVeryDim },
};
