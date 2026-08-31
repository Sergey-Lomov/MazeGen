import React, { useEffect, useRef, useState } from "react";
import { Application } from "pixi.js";
import { MazeScene } from "./pixi/MazeScene";
import { loadMsdfFont } from "./pixi/renderers/msdfFont";
import { FeaturesPanel } from "./components/FeaturesPanel";
import { QualityCanvas } from "./components/features/QualityCanvas";
import { DebugPanel } from "./components/DebugPanel";
import { HoverInfoPanel } from "./components/HoverInfoPanel";
import { FloorSwitcher } from "./components/FloorSwitcher";
import { SIDE_PANEL_SLOT_ID } from "./components/SidePanel";
import { useMazeStore } from "./store/mazeStore";
import type { FeatureId } from "./store/mazeStore";
import { ui, typography, disabled, inset } from "./styles/theme";
import { canvas } from "./pixi/colorTokens";
import { useLocale } from "./i18n/useLocale";
import { setViewportScaleGetter, setPhysicalZoomApplier } from "./pixi/viewportScaleBridge";
import * as m from "~/paraglide/messages";

const PANEL_WIDTH = 260;

/** Feature cards the floor switcher stays hidden for (GitHub issue #336): "Basic configuration"
 *  (tessellation is floor-independent), "Floors" (configures the floor set itself), and "Quality
 *  control" (spans the whole maze, not scoped to one floor). */
const FLOOR_SWITCHER_HIDDEN_CARDS: ReadonlySet<FeatureId> = new Set(["basic_config", "floors", "quality"]);

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
  const floorCount = useMazeStore((s) => s.floors.length);
  const showFloorSwitcher = floorCount > 1 && !FLOOR_SWITCHER_HIDDEN_CARDS.has(openCard);

  useEffect(() => {
    loadRegistry();
  }, [loadRegistry]);

  // Pixi's own `resizeTo` keeps `app.screen` in sync with the canvas div's real size, but nothing
  // re-notifies screen-space overlays (ExportFrameOverlay's print/digital export frame) when that
  // happens without an accompanying pan/zoom/store change — e.g. a side panel opening/closing or
  // DevTools toggling shrinks the canvas div, and the frame keeps drawing against the stale size
  // until some unrelated store update happens to trigger a redraw. This observer catches every
  // real size change directly and pushes it through immediately.
  useEffect(() => {
    if (!canvasRef.current) return;
    const observer = new ResizeObserver(() => {
      sceneRef.current?.notifyScreenResized();
    });
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!canvasRef.current || sceneRef.current) return;

    let cancelled = false;
    const app = new Application();

    app
      .init({ resizeTo: canvasRef.current, background: canvas.stage.background, antialias: true })
      // The MSDF label fonts (GitHub issue #352, ~150 KB for both weights) are a one-time load,
      // fetched in parallel with the WebGL context init above; browser HTTP caching makes every
      // later page load free. Blocking `setReady` on it avoids a flash of missing labels.
      .then(() => loadMsdfFont())
      .then(() => {
        if (cancelled) { app.destroy(); return; }
        canvasRef.current!.appendChild(app.canvas);
        sceneRef.current = new MazeScene(app);
        setViewportScaleGetter(() => sceneRef.current?.getViewportScale() ?? 1);
        setPhysicalZoomApplier((scale) => sceneRef.current?.applyPrintPhysicalZoom(scale));
        setReady(true);
      })
      .catch((err) => {
        // A failed WebGL init or MSDF-font fetch would otherwise leave the app stuck on the
        // loading screen with a silent unhandled rejection — surface it to the console at least.
        if (!cancelled) console.error("Canvas init failed", err);
      });

    return () => {
      cancelled = true;
      setViewportScaleGetter(null);
      setPhysicalZoomApplier(null);
      sceneRef.current?.destroy();
      sceneRef.current = null;
    };
  }, []);

  return (
    <div style={styles.root}>
      <div style={styles.panel}>
        <FeaturesPanel
          onRefit={() => sceneRef.current?.refit()}
          onExportPng={(settings) => sceneRef.current?.exportPng(settings) ?? Promise.resolve(null)}
        />
      </div>
      <div style={styles.canvasColumn}>
        <div ref={canvasRef} style={{ ...styles.canvas, display: qualityOpen ? "none" : undefined }} />
        {qualityOpen && <QualityCanvas />}
        {!qualityOpen && <HoverInfoPanel scene={ready ? sceneRef.current : null} />}
        {showFloorSwitcher && <FloorSwitcher />}
      </div>
      {generationOpen && debugMode && debugArena && <DebugPanel />}
      {/* Portal target for `SidePanel` (GitHub issue #237) — split-node management panels
       * (post-edit, preset, pattern editor) render here regardless of where in the component tree
       * they're triggered from, so they always dock beside the canvas, never inside the left
       * features panel. */}
      <div id={SIDE_PANEL_SLOT_ID} />
      {!ready && <div style={styles.loading}>{m["common.loading"]()}</div>}
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
  canvasColumn: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" },
  canvas: { flex: 1, overflow: "hidden" },
  loading: {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: ui.bg.app,
    padding: inset.panelInsetX,
    ...disabled(typography.body),
  },
};
