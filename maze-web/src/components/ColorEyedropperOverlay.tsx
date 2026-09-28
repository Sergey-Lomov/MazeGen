import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getColorSampler, type PixelRegion } from "../pixi/colorSampleBridge";
import { colorToHex } from "./colorFormat";
import { ui, radius, typography } from "../styles/theme";
import type React from "react";

const LOUPE_SIZE = 96;
const LOUPE_ZOOM = 12;
const LOUPE_OFFSET = 16;

interface Props {
  /** Called with the sampled color on click inside the canvas. Does not commit by itself — the
   *  caller (`ColorPickerPanel`) treats it the same as any other working-color pick. */
  onPick: (color: number) => void;
  /** Called on Escape or a click outside the canvas — cancels sampling with no change. */
  onCancel: () => void;
}

/** Full-viewport capture layer for the canvas eyedropper (GitHub issue #507). Rendered while
 *  `ColorPickerPanel` is in sampling mode: turns the cursor into a crosshair over the Pixi canvas,
 *  follows the pointer with a magnified loupe showing the pixel under the cursor and its hex, and
 *  reads the actual color via `MazeScene.sampleColorAt` (renderer `extract.pixels()`) on click.
 *  The loupe paints from `sampleRegion` (also `extract.pixels()`) rather than `drawImage`ing the
 *  live canvas element directly — the on-screen Pixi canvas isn't `preserveDrawingBuffer`, so its
 *  own buffer reads back blank outside the render tick. Escape or a click outside the canvas
 *  cancels with no change; the picker panel stays open throughout. Portals straight to
 *  `document.body` — it must sit above the whole app, not just the side-panel slot. */
/** Extracts the packed 24-bit RGB color of the actually-sampled pixel out of a `sampleRegion`
 *  result, using its `centerX`/`centerY` (accounts for edge clamping). */
export function colorAtCenter(region: PixelRegion): number {
  const i = (region.centerY * region.width + region.centerX) * 4;
  return (region.pixels[i] << 16) | (region.pixels[i + 1] << 8) | region.pixels[i + 2];
}

export function ColorEyedropperOverlay({ onPick, onCancel }: Props) {
  const [pointer, setPointer] = useState<{ x: number; y: number; over: boolean; color: number | null }>({
    x: 0, y: 0, over: false, color: null,
  });
  const loupeCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const radiusPx = Math.round(LOUPE_SIZE / LOUPE_ZOOM / 2);

    function handleMove(e: PointerEvent) {
      const sampler = getColorSampler();
      const rect = sampler?.canvas.getBoundingClientRect();
      const over = !!rect && e.clientX >= rect.left && e.clientX < rect.right && e.clientY >= rect.top && e.clientY < rect.bottom;
      // A single `sampleRegion` read covers both the loupe paint and the picked-color readout —
      // the sampled pixel sits at [radiusPx, radiusPx] in the region except when clamped near a
      // canvas edge, so a second `sampleAt` GPU readback per pointermove isn't needed.
      const region = over && sampler ? sampler.sampleRegion(e.clientX, e.clientY, radiusPx) : null;
      const color = region ? colorAtCenter(region) : null;
      setPointer({ x: e.clientX, y: e.clientY, over, color });

      const loupeCanvas = loupeCanvasRef.current;
      const ctx = loupeCanvas?.getContext("2d");
      if (loupeCanvas && ctx) {
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
        if (region && region.width > 0 && region.height > 0) {
          // Paint the raw sampled region at native size onto a scratch canvas, then
          // `drawImage`-scale that (nearest-neighbor via `imageSmoothingEnabled = false`) up to
          // the loupe's display size — `putImageData` itself can't scale.
          const scratch = document.createElement("canvas");
          scratch.width = region.width;
          scratch.height = region.height;
          const scratchCtx = scratch.getContext("2d")!;
          scratchCtx.putImageData(new ImageData(region.pixels, region.width, region.height), 0, 0);
          ctx.drawImage(scratch, 0, 0, region.width, region.height, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
        }
      }
    }

    function handleClick(e: MouseEvent) {
      const sampler = getColorSampler();
      const color = sampler?.sampleAt(e.clientX, e.clientY) ?? null;
      if (color !== null) onPick(color);
      else onCancel();
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("click", handleClick, true);
    // Capture phase so this fires (and sets `defaultPrevented`) before `SidePanel`'s own bubble-
    // phase Escape listener (GitHub issue #631), regardless of which mounted first — sampling mode
    // must cancel on its own without also closing the still-open `ColorPickerPanel` behind it.
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("click", handleClick, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onPick, onCancel]);

  return createPortal(
    <div style={{ ...styles.capture, cursor: pointer.over ? "crosshair" : "default" }}>
      {pointer.over && (
        <div style={{ ...styles.loupeWrap, left: pointer.x + LOUPE_OFFSET, top: pointer.y + LOUPE_OFFSET }}>
          <canvas ref={loupeCanvasRef} width={LOUPE_SIZE} height={LOUPE_SIZE} style={styles.loupeCanvas} />
          <div style={styles.loupeCrosshairH} />
          <div style={styles.loupeCrosshairV} />
          {pointer.color !== null && <div style={styles.loupeHex}>{colorToHex(pointer.color)}</div>}
        </div>
      )}
    </div>,
    document.body,
  );
}

const styles: Record<string, React.CSSProperties> = {
  capture: {
    position: "fixed",
    inset: 0,
    zIndex: 1000,
  },
  loupeWrap: {
    position: "fixed",
    pointerEvents: "none",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  loupeCanvas: {
    width: LOUPE_SIZE,
    height: LOUPE_SIZE,
    borderRadius: "50%",
    border: `2px solid ${ui.border.strong}`,
    boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
    background: ui.bg.panel,
  },
  loupeCrosshairH: {
    position: "absolute",
    top: LOUPE_SIZE / 2 - 1,
    left: LOUPE_SIZE / 2 - 8,
    width: 16,
    height: 2,
    background: ui.text.primary,
    mixBlendMode: "difference",
  },
  loupeCrosshairV: {
    position: "absolute",
    top: LOUPE_SIZE / 2 - 8,
    left: LOUPE_SIZE / 2 - 1,
    width: 2,
    height: 16,
    background: ui.text.primary,
    mixBlendMode: "difference",
  },
  loupeHex: {
    ...typography.caption,
    marginTop: 4,
    padding: "2px 6px",
    borderRadius: radius.sm,
    background: ui.bg.panel,
    border: `1px solid ${ui.border.default}`,
  },
};
