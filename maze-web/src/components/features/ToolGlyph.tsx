import { useEffect, useRef, useState } from "react";
import { TILE_SIZE } from "../../pixi/constants";
import { getToolGlyphs, TOOL_GLYPH_BOX, type ToolGlyphKey } from "./toolGlyphs";

/** Blits the offscreen-rendered pictogram for `tool` (see `toolGlyphs.ts`) into a square 2D
 *  canvas. The bitmap is Pixi-rendered once module-wide from the real render style, so this
 *  component only ever copies it. Default size is one tessellation cell. */
export function ToolGlyph({ tool, size = TILE_SIZE }: { tool: ToolGlyphKey; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [bitmap, setBitmap] = useState<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getToolGlyphs().then((glyphs) => {
      if (!cancelled) setBitmap(glyphs.get(tool) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [tool]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !bitmap) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = size * dpr;
    cv.height = size * dpr;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, cv.width, cv.height);
  }, [bitmap, size]);

  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      style={{ width: size, height: size, display: "block" }}
      aria-hidden
      data-glyph-box={TOOL_GLYPH_BOX}
    />
  );
}
