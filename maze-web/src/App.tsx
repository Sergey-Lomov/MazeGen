import { useEffect, useRef, useState } from "react";
import { Application } from "pixi.js";
import { MazeScene } from "./pixi/MazeScene";
import { ControlPanel } from "./components/ControlPanel";
import { LayersPanel } from "./components/LayersPanel";
import { DebugPanel } from "./components/DebugPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { InfoPanel } from "./components/InfoPanel";
import { GenerationDebugPanel } from "./components/GenerationDebugPanel";
import { useMazeStore } from "./store/mazeStore";

const PANEL_WIDTH = 480;
const SLIDE_MS = 250;

export function App() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<MazeScene | null>(null);
  const [ready, setReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const loadRegistry = useMazeStore((s) => s.loadRegistry);

  function handleSettingsToggle() {
    if (settingsOpen) {
      setSettingsOpen(false);
    } else {
      setInfoOpen(false);
      setSettingsOpen(true);
    }
    sceneRef.current?.refit(SLIDE_MS + 40);
  }

  function handleInfoToggle() {
    if (infoOpen) {
      setInfoOpen(false);
    } else {
      setSettingsOpen(false);
      setInfoOpen(true);
    }
    sceneRef.current?.refit(SLIDE_MS + 40);
  }

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
      <div style={styles.sidebar}>
        <ControlPanel disabled={!ready}
          onSettingsToggle={handleSettingsToggle}
          settingsOpen={settingsOpen}
          onInfoToggle={handleInfoToggle}
          infoOpen={infoOpen}
          onDebugToggle={() => setDebugOpen((v) => !v)}
          debugOpen={debugOpen}
        />
        {debugOpen && <GenerationDebugPanel onClose={() => setDebugOpen(false)} />}
        <LayersPanel />
        <DebugPanel />
        {!ready && <div style={styles.loading}>Loading…</div>}
      </div>
      <div style={{ ...styles.panel, width: settingsOpen ? PANEL_WIDTH : 0 }}>
        <div style={styles.panelContent}>
          <SettingsPanel />
        </div>
      </div>
      <div style={{ ...styles.panel, width: infoOpen ? PANEL_WIDTH : 0 }}>
        <div style={styles.panelContent}>
          <InfoPanel />
        </div>
      </div>
      <div ref={canvasRef} style={styles.canvas} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", width: "100%", height: "100%" },
  sidebar: {
    width: 180,
    minWidth: 180,
    background: "#222",
    display: "flex",
    flexDirection: "column",
    borderRight: "1px solid #333",
    overflowY: "auto",
  },
  panel: {
    overflow: "hidden",
    transition: `width ${SLIDE_MS}ms ease`,
    flexShrink: 0,
    height: "100%",
    borderRight: "1px solid #333",
    background: "#1e1e1e",
    boxSizing: "border-box",
  },
  panelContent: {
    width: PANEL_WIDTH,
    height: "100%",
    overflowY: "auto",
  },
  canvas: { flex: 1, overflow: "hidden" },
  loading: { padding: 12, fontSize: 11, color: "#666" },
};
