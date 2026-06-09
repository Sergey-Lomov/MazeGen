import { useEffect, useRef, useState } from "react";
import { Application } from "pixi.js";
import { MazeScene } from "./pixi/MazeScene";
import { ControlPanel } from "./components/ControlPanel";
import { LayersPanel } from "./components/LayersPanel";
import { DebugPanel } from "./components/DebugPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { GenerationDebugPanel } from "./components/GenerationDebugPanel";
import { useMazeStore } from "./store/mazeStore";

export function App() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<MazeScene | null>(null);
  const [ready, setReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const SETTINGS_TRANSITION_MS = 270;
  const loadRegistry = useMazeStore((s) => s.loadRegistry);

  useEffect(() => {
    loadRegistry();
  }, [loadRegistry]);

  useEffect(() => {
    if (!canvasRef.current || sceneRef.current) return;

    let cancelled = false;
    const app = new Application();

    app
      .init({
        resizeTo: canvasRef.current,
        background: 0x111111,
        antialias: true,
      })
      .then(() => {
        if (cancelled) {
          app.destroy();
          return;
        }
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
      <div style={styles.sidebar}>
        <ControlPanel disabled={!ready} onSettingsToggle={() => {
          setSettingsOpen((v) => !v);
          sceneRef.current?.refit(SETTINGS_TRANSITION_MS);
        }} settingsOpen={settingsOpen} onDebugToggle={() => setDebugOpen((v) => !v)} debugOpen={debugOpen} />
        {debugOpen && <GenerationDebugPanel onClose={() => setDebugOpen(false)} />}
        <LayersPanel />
        <DebugPanel />
        {!ready && <div style={styles.loading}>Loading…</div>}
      </div>
      <div style={{ ...styles.settingsPanel, width: settingsOpen ? 480 : 0 }}>
        <SettingsPanel />
      </div>
      <div ref={canvasRef} style={styles.canvas} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    width: "100%",
    height: "100%",
  },
  sidebar: {
    width: 180,
    minWidth: 180,
    background: "#222",
    display: "flex",
    flexDirection: "column",
    borderRight: "1px solid #333",
    overflowY: "auto",
  },
  settingsPanel: {
    overflow: "hidden",
    transition: "width 0.25s ease",
    flexShrink: 0,
  },
  canvas: {
    flex: 1,
    overflow: "hidden",
  },
  loading: {
    padding: 12,
    fontSize: 11,
    color: "#666",
  },
};
