import { useEffect, useRef, useState } from "react";
import { Application } from "pixi.js";
import { MazeRenderer } from "./pixi/MazeRenderer";
import { ControlPanel } from "./components/ControlPanel";
import { DebugPanel } from "./components/DebugPanel";

export function App() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<MazeRenderer | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!canvasRef.current || rendererRef.current) return;

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
        rendererRef.current = new MazeRenderer(app);
        setReady(true);
      });

    return () => {
      cancelled = true;
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, []);

  return (
    <div style={styles.root}>
      <div style={styles.sidebar}>
        <ControlPanel disabled={!ready} />
        <DebugPanel />
        {!ready && <div style={styles.loading}>Loading…</div>}
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
