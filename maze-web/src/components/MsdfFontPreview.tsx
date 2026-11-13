import { useEffect, useRef, useState } from "react";
import type React from "react";
import { Application } from "pixi.js";
import { truncateToWidth } from "../pixi/ellipsisFit";
import { loadMsdfFont, makeCenteredLabel } from "../pixi/renderers/msdfFont";
import { isMsdfFamilyLoaded, type LabelFont } from "../pixi/renderers/fontChoice";
import { loadMsdfFamily } from "../pixi/renderers/msdfLoader";

/** Gap in px between the left edge of the preview and its text. */
const TEXT_PADDING = 8;

interface Props {
  text: string;
  /** The baked font to draw: its family and the weight whose atlas is used. */
  font: LabelFont;
  /** Text color as a 0xRRGGBB number. */
  textColor: number;
  /** Background color as a 0xRRGGBB number. */
  background: number;
  fontSize: number;
  /** Box style of the host element: height, border, radius. The canvas fills it. */
  style: React.CSSProperties;
  /** Called once when a WebGL canvas cannot be created, so the caller can show a DOM fallback. */
  onUnavailable?: () => void;
  testId?: string;
}

/** Single-line preview of the bundled MSDF font drawn the way the maze canvas draws it: a pixi
 *  `BitmapText` over the baked atlas. A DOM element cannot show an MSDF font, so this is the only
 *  faithful preview for it. The pixi application lives as long as the component and only its text and
 *  colors are rewritten. Like the other mini pixi canvases it stays off the shared ticker and renders
 *  on demand. */
export function MsdfFontPreview({ text, font, textColor, background, fontSize, style, onUnavailable, testId }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [app, setApp] = useState<Application | null>(null);
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let instance: Application | null = null;
    void (async () => {
      const created = new Application();
      try {
        await created.init({
          resizeTo: host,
          resolution: window.devicePixelRatio || 1,
          autoDensity: true,
          antialias: true,
          autoStart: false,
          sharedTicker: false,
        });
        await loadMsdfFont();
      } catch {
        try { created.destroy(true, { children: true }); } catch { /* never finished initializing */ }
        if (!cancelled) onUnavailableRef.current?.();
        return;
      }
      if (cancelled) { created.destroy({ removeView: true }, { children: true }); return; }
      instance = created;
      // A block canvas leaves no inline baseline gap below it inside the fixed-height host.
      created.canvas.style.display = "block";
      host.appendChild(created.canvas);
      setApp(created);
    })();
    return () => {
      cancelled = true;
      setApp(null);
      instance?.destroy({ removeView: true }, { children: true });
    };
  }, []);

  // `resizeTo` follows only window resizes, so a host resized by its container is tracked here. The
  // width in state re-runs the draw below, which recomputes the ellipsis for the new width.
  const [hostWidth, setHostWidth] = useState(0);
  useEffect(() => {
    const host = hostRef.current;
    if (!app || !host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      app.resize();
      setHostWidth(host.clientWidth);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [app]);

  // A font that is not loaded yet draws as the default one; once its atlases arrive the draw below reruns.
  const [loadedFamily, setLoadedFamily] = useState<string | null>(null);
  useEffect(() => {
    if (!app || isMsdfFamilyLoaded(font.family)) return;
    let cancelled = false;
    void loadMsdfFamily(font.family).then((loaded) => { if (loaded && !cancelled) setLoadedFamily(font.family); });
    return () => { cancelled = true; };
  }, [app, font.family]);

  useEffect(() => {
    if (!app) return;
    app.renderer.background.color = background;
    app.stage.removeChildren().forEach((child) => child.destroy());
    if (text) {
      // A phrase wider than the canvas is cut with an ellipsis, like the DOM preview, measured on the
      // real label.
      const measure = (candidate: string) => {
        const probe = makeCenteredLabel(candidate, font, fontSize, textColor);
        const width = probe.width;
        probe.destroy();
        return width;
      };
      const label = makeCenteredLabel(truncateToWidth(text, app.screen.width - TEXT_PADDING * 2, measure), font, fontSize, textColor);
      // `makeCenteredLabel` anchors at the centre, so offset by half its width to start at the padding.
      label.position.set(TEXT_PADDING + label.width / 2, app.screen.height / 2);
      app.stage.addChild(label);
    }
    app.render();
  }, [app, text, font, textColor, background, fontSize, hostWidth, loadedFamily]);

  return <div ref={hostRef} style={style} data-testid={testId} />;
}
