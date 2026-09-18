import { Application, Graphics } from "pixi.js";
import type { PresetConnectionTool } from "../../pixi/fieldEditUtils";
import type { PostEditTool } from "../../store/postEditTypes";
import type { MarkerShape } from "../../pixi/renderers/types";
import { drawMarkerShape, drawMarkerUnderlay } from "../../pixi/renderers/markerShapes";
import { GEN_SOURCE_COLOR } from "../../pixi/renderers/GenSourceRenderer";
import { CROSS_ARM, CROSS_WIDTH } from "../../pixi/renderers/crossMarker";
import { drawOneWayTriangle, drawOneWayChevron, drawOneWayArrow } from "../../pixi/renderers/wallUtils";
import { DEFAULT_MAZE_RENDER_STYLE } from "../../pixi/defaultMazeRenderStyle";
import { TILE_SIZE } from "../../pixi/constants";
import { canvas } from "../../pixi/colorTokens";
import { base, hexToNumber } from "../../styles/palette";

/** Live-rendered pictograms for the preset-connection AND post-edit tool buttons (GitHub issue #456).
 *
 *  These are NOT hand-drawn SVGs. Each glyph is drawn with the exact same Pixi primitives and the
 *  exact same `DEFAULT_MAZE_RENDER_STYLE` values the canvas uses for that element — same marker
 *  shape/size/corner-rounding, same gap-ring formula (`radius + borderWidth + gapWidth`), same
 *  one-way indicator pattern, same wall stroke width/cap. So a wall icon is the wall as it will be
 *  drawn, a teleport icon is the teleport marker as it will be drawn, etc. If the render style
 *  changes, the icons change with it.
 *
 *  Rendered once into offscreen `<canvas>` bitmaps through a single shared, throwaway Pixi
 *  `Application` (no shared ticker, one `render()` call, graphics destroyed immediately), then
 *  cached module-wide keyed by tool. `ToolGlyph` blits the cached bitmap into its own 2D canvas.
 *
 *  Key space: every `PresetConnectionTool`, plus post-edit-only `"delete"` (trash can — remove any
 *  object in a cell) and `"post_edit_reset"` (counter-clockwise circular arrow — revert post-edit
 *  changes back to the generated state). Preset's own `"reset"` (undecided-edge grey stub) and
 *  post-edit's `reset` tool have different meanings, so post-edit maps its `reset` tool to the
 *  synthetic `"post_edit_reset"` key, not to `"reset"`. */

const BOX = TILE_SIZE; // 40 — one tessellation cell; every element sizes off TILE_SIZE already
const C = BOX / 2;
// Pixi renders the offscreen canvas at this device-pixel ratio, exactly like the live canvas does
// (Pixi's own default `resolution`). Clamped so a low-DPR screen still gets a crisp button-sized
// glyph and a high-DPR screen doesn't allocate an oversized texture.
const RESOLUTION = Math.min(3, Math.max(2, Math.round(typeof window !== "undefined" ? window.devicePixelRatio || 2 : 2)));

const S = DEFAULT_MAZE_RENDER_STYLE;

// Button face is the canvas floor fill (`.btn-tool-icon` in global.css matches
// `canvas.floor.default`), so every gap ring / one-way gap / lock knockout uses the floor color
// exactly as it does on the field — the gap then reads as a true hole in the marker.
const GAP = canvas.floor.default;

type GlyphFn = (g: Graphics) => void;

// ─── Wall-family ───────────────────────────────────────────────────────────

// A vertical wall segment centered in the box, drawn with the exact wall stroke style
// (`WALL_THICKNESS`, round cap/join) the field uses. Reaches close to the top/bottom edges so it
// reads as a real wall, but is NOT edge-to-edge.
const WALL_LEN = BOX * 0.82;

function wallStroke(g: Graphics, color: number, halfLen: number): void {
  g.moveTo(C, C - halfLen).lineTo(C, C + halfLen).stroke({
    color,
    width: S.wall.width,
    cap: S.wall.cap,
    join: S.wall.join,
  });
}

const wall: GlyphFn = (g) => wallStroke(g, S.wall.color, WALL_LEN / 2);

const reset: GlyphFn = (g) => wallStroke(g, canvas.wall.undecided, WALL_LEN / 2);

// Passage — a wide break between two very short wall stubs (the exposed ends of the neighbouring
// cells' walls), plus a grey double-headed arrow running horizontally through the gap so the icon
// reads unmistakably as "a way through".
const passage: GlyphFn = (g) => {
  const outer = WALL_LEN / 2; // stub outer ends align with the wall glyph's ends
  const gapHalf = BOX * 0.33; // wide break — only short wall stubs left top and bottom
  g.moveTo(C, C - outer).lineTo(C, C - gapHalf).stroke({ color: S.wall.color, width: S.wall.width, cap: S.wall.cap, join: S.wall.join });
  g.moveTo(C, C + gapHalf).lineTo(C, C + outer).stroke({ color: S.wall.color, width: S.wall.width, cap: S.wall.cap, join: S.wall.join });

  const arrowColor = canvas.wall.undecided; // muted grey
  const half = BOX * 0.28; // arrow reaches from -half to +half through the center
  const head = BOX * 0.09;
  g.moveTo(C - half, C).lineTo(C + half, C).stroke({ color: arrowColor, width: S.wall.width, cap: "round", join: "round" });
  g.moveTo(C - half + head, C - head).lineTo(C - half, C).lineTo(C - half + head, C + head)
    .stroke({ color: arrowColor, width: S.wall.width, cap: "round", join: "round" });
  g.moveTo(C + half - head, C - head).lineTo(C + half, C).lineTo(C + half - head, C + head)
    .stroke({ color: arrowColor, width: S.wall.width, cap: "round", join: "round" });
};

// One-way — the wall segment with the one-way indicator on top, gap and all, drawn by the same
// primitive `WallRenderer.drawOneWayIndicator` dispatches to.
const one_way: GlyphFn = (g) => {
  wallStroke(g, S.wall.color, WALL_LEN / 2);
  const ow = S.oneWay;
  const style = {
    color: ow.color,
    gapColor: GAP,
    gapWidth: ow.gapWidth,
    size: ow.size,
    thickness: ow.thickness,
    join: ow.join,
    cap: ow.cap,
  };
  if (ow.pattern === "chevron") drawOneWayChevron(g, C, C, 1, 0, style);
  else if (ow.pattern === "arrow") drawOneWayArrow(g, C, C, 1, 0, style);
  else drawOneWayTriangle(g, C, C, 1, 0, style);
};

// ─── Marker-family (a single canvas marker, centered) ───────────────────────

type MarkerLike = {
  shape: MarkerShape;
  cornerStyle: "round" | "miter" | "sharp";
  fillColor: number;
  borderColor?: number;
  borderWidth: number;
  gapWidth: number;
  gapColor: number;
  size: number; // fraction of TILE_SIZE
};

/** The exact gap-ring → fill → outer-aligned-border sequence `WaypointsRenderer` /
 *  `VerticalConnectionRenderer` / `TeleportRenderer` all use. */
function drawMarker(g: Graphics, m: MarkerLike, opts?: { fillOverride?: number; borderOverride?: number }): void {
  const rounded = m.cornerStyle === "round";
  const r = m.size * TILE_SIZE;
  const fill = opts?.fillOverride ?? m.fillColor;
  const border = opts?.borderOverride ?? m.borderColor ?? m.fillColor;
  // Single true outward offset of the fill path (`r`) by `borderWidth + gapWidth` (GitHub issue
  // #552 ninth follow-up) — see `WaypointsRenderer`'s own gap ring for the full rationale.
  if (m.gapWidth > 0) {
    drawMarkerUnderlay(g, m.shape, C, C, r, rounded, m.borderWidth + m.gapWidth, GAP);
  }
  drawMarkerShape(g, m.shape, C, C, r, rounded);
  g.fill(fill);
  if (m.borderWidth > 0) {
    drawMarkerShape(g, m.shape, C, C, r, rounded);
    g.stroke({ color: border, width: m.borderWidth, alignment: 0 });
  }
}

const set_start: GlyphFn = (g) => drawMarker(g, S.startMarker);
const set_finish: GlyphFn = (g) => drawMarker(g, S.finishMarker);

// Teleport — the diamond edge marker: filled for two-way, outline (floor-colored fill) for one-way,
// mirroring `TeleportRenderer`.
const teleportMarker: MarkerLike = {
  shape: S.teleport.shape,
  cornerStyle: S.teleport.cornerStyle,
  fillColor: S.teleport.edgeColor,
  borderColor: S.teleport.edgeBorderColor,
  borderWidth: S.teleport.borderWidth,
  gapWidth: S.teleport.edgeGapWidth,
  gapColor: S.teleport.floorColor,
  size: S.teleport.size,
};

const teleport_two_way: GlyphFn = (g) => drawMarker(g, teleportMarker);
const teleport_one_way: GlyphFn = (g) => drawMarker(g, teleportMarker, { fillOverride: GAP });

// Vertical passage / elevator — the marker + its direction arrow(s), same as
// `VerticalConnectionRenderer.render`. `"both"` = up+down arrow pair (elevator), `"up"` = single
// up arrow (two-way passage icon), `"down"` = single down arrow (one-way passage, the "to" end).

type ArrowDir = "both" | "up" | "down";

function drawVerticalArrows(
  g: Graphics,
  markerRadius: number,
  arrowColor: number,
  arrowSizeFraction: number,
  dir: ArrowDir,
): void {
  // Mirrors `VerticalConnectionRenderer`'s triangle-pattern branch (the default arrow style).
  const both = dir === "both";
  const dys = both ? [-1, 1] : [dir === "up" ? -1 : 1];
  const arrowSize = markerRadius * arrowSizeFraction;
  const originOffset = both ? markerRadius * 0.4 : 0;
  const pairFraction = both ? 0.75 : 1;
  const pairArrowSize = arrowSize * pairFraction;
  const midpointFraction = -1 / 39; // triangle, `patternMidpointOffset`
  const midpointOffset = midpointFraction * pairArrowSize;
  dys.forEach((dy, i) => {
    const side = i === 0 ? -1 : 1;
    const oy = C - dy * midpointOffset + (both ? side * originOffset : 0);
    drawOneWayTriangle(g, C, oy, 0, dy, {
      color: arrowColor,
      size: pairArrowSize / 0.65, // `drawArrowPattern` rescales by `patternTipFraction` (0.65 for triangle)
      join: "round",
      cap: "round",
    });
  });
}

const vpTwoWay: MarkerLike = { ...S.verticalConnections.twoWayPassageMarker, cornerStyle: S.verticalConnections.twoWayPassageMarker.cornerStyle };
const vpOneWay: MarkerLike = { ...S.verticalConnections.oneWayPassageMarker };
const elevatorMarker: MarkerLike = { ...S.verticalConnections.elevatorMarker };

const vertical_passage_two_way: GlyphFn = (g) => {
  drawMarker(g, vpTwoWay);
  drawVerticalArrows(g, vpTwoWay.size * TILE_SIZE, S.verticalConnections.twoWayArrowColor, S.verticalConnections.twoWayArrowSize, "up");
};

const vertical_passage_one_way: GlyphFn = (g) => {
  // The "to" / arrival end, exactly as `VerticalConnectionRenderer` draws it (`arrowFilled: false`):
  // the ENTIRE marker filled with `oneWayAccentColor` (not the ordinary fill + accent border — that
  // is the "from" end), border the same accent, arrow pointing down (into this floor).
  const accent = S.verticalConnections.oneWayAccentColor;
  drawMarker(g, vpOneWay, { fillOverride: accent, borderOverride: accent });
  drawVerticalArrows(g, vpOneWay.size * TILE_SIZE, S.verticalConnections.oneWayArrowColor, S.verticalConnections.oneWayArrowSize, "down");
};

const elevator: GlyphFn = (g) => {
  drawMarker(g, elevatorMarker);
  drawVerticalArrows(g, elevatorMarker.size * TILE_SIZE, S.verticalConnections.elevatorArrowColor, S.verticalConnections.elevatorArrowSize, "both");
};

// ─── Lock-family — copied from `LockRenderer.drawLockIcon` ───────────────────

function drawLock(g: Graphics, type: "in" | "out" | "both"): void {
  const cx = C;
  const cy = C;
  const bw = TILE_SIZE * 0.46;
  const bh = TILE_SIZE * 0.36;
  const arcR = bw * 0.3;
  const totalH = arcR + bh;
  const bodyTop = cy - totalH / 2 + arcR;
  const bodyCy = bodyTop + bh / 2;

  g.roundRect(cx - bw / 2, bodyTop, bw, bh, bw * 0.12).fill(canvas.lock.default);
  g.setStrokeStyle({ width: bw * 0.14, color: canvas.lock.default, cap: "round" as const });
  g.moveTo(cx - arcR, bodyTop);
  g.arc(cx, bodyTop, arcR, Math.PI, 0);
  g.stroke();

  if (type !== "both") {
    const s = bw * 0.28;
    const h = (s * Math.sqrt(3)) / 2;
    const offset = bw * 0.11;
    if (type === "out") {
      g.poly([cx - offset, bodyCy - s / 2, cx - offset, bodyCy + s / 2, cx - offset - h, bodyCy]).fill(GAP);
      g.poly([cx + offset, bodyCy - s / 2, cx + offset, bodyCy + s / 2, cx + offset + h, bodyCy]).fill(GAP);
    } else {
      g.poly([cx - offset - h, bodyCy - s / 2, cx - offset - h, bodyCy + s / 2, cx - offset, bodyCy]).fill(GAP);
      g.poly([cx + offset + h, bodyCy - s / 2, cx + offset + h, bodyCy + s / 2, cx + offset, bodyCy]).fill(GAP);
    }
  }
}

const lock_in: GlyphFn = (g) => drawLock(g, "in");
const lock_out: GlyphFn = (g) => drawLock(g, "out");
const full_lock: GlyphFn = (g) => drawLock(g, "both");

// ─── Gen source — a plain blue cross, same shape `GenSourceRenderer` draws (and same as the
//     coordinate-origin cross, only a different color). Color imported so it can't drift.

const gen_source: GlyphFn = (g) => {
  g.moveTo(C - CROSS_ARM, C).lineTo(C + CROSS_ARM, C)
    .moveTo(C, C - CROSS_ARM).lineTo(C, C + CROSS_ARM)
    .stroke({ color: GEN_SOURCE_COLOR, width: CROSS_WIDTH, cap: "round" });
};

// ─── Manage split nodes — three strokes forming a triangle, each overshooting its vertices ──

const manage_split_nodes: GlyphFn = (g) => {
  const r = TILE_SIZE * 0.3;
  const over = r * 0.4;
  const raw = [0, 1, 2].map((i) => {
    const a = -Math.PI / 2 + (i / 3) * Math.PI * 2;
    return [Math.cos(a) * r, Math.sin(a) * r] as const;
  });
  // Center on the vertices' bounding box, not their centroid — an upward-pointing triangle sits
  // visually low otherwise (two vertices along the bottom edge).
  const ys = raw.map((p) => p[1]);
  const cyOffset = (Math.min(...ys) + Math.max(...ys)) / 2;
  const pts = raw.map(([x, y]) => [C + x, C + y - cyOffset] as const);
  const slotColors = canvas.node.splitSlots;
  for (let i = 0; i < 3; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 3];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    g.moveTo(a[0] - ux * over, a[1] - uy * over)
      .lineTo(b[0] + ux * over, b[1] + uy * over)
      .stroke({ color: slotColors[i % slotColors.length], width: 4, cap: "round" });
  }
};

// ─── Trash can — a FILLED silhouette in the danger hue ─────────────────────
//
// Simple solid silhouette, matching the other filled glyphs (lock, split-slot triangles): a
// handle tab on top, a lid slab overhanging the can only slightly, and a filled tapered can
// body with a rounded base. No rib slots. Used for the preset "clear" tool and the post-edit
// "delete" tool (both mean "remove whatever object is in this cell").

const trashCan: GlyphFn = (g) => {
  const color = hexToNumber(base.error);

  const topHalf = TILE_SIZE * 0.23;
  const botHalf = TILE_SIZE * 0.17;
  const lidHalf = topHalf + TILE_SIZE * 0.03; // small overhang past the can rim

  const handleHalf = TILE_SIZE * 0.1;
  const handleH = TILE_SIZE * 0.07;
  const handleTop = C - TILE_SIZE * 0.3;

  const lidY = handleTop + handleH;
  const lidH = TILE_SIZE * 0.09;

  const bodyTop = lidY + lidH + TILE_SIZE * 0.03;
  const bodyBot = C + TILE_SIZE * 0.3;
  const rBase = TILE_SIZE * 0.05;

  // Handle tab
  g.roundRect(C - handleHalf, handleTop, handleHalf * 2, handleH + lidH * 0.5, TILE_SIZE * 0.02).fill(color);
  // Lid slab
  g.roundRect(C - lidHalf, lidY, lidHalf * 2, lidH, TILE_SIZE * 0.03).fill(color);
  // Can body — filled tapered shape with a rounded base
  g.moveTo(C - topHalf, bodyTop)
    .lineTo(C - botHalf, bodyBot - rBase)
    .quadraticCurveTo(C - botHalf, bodyBot, C - botHalf + rBase, bodyBot)
    .lineTo(C + botHalf - rBase, bodyBot)
    .quadraticCurveTo(C + botHalf, bodyBot, C + botHalf, bodyBot - rBase)
    .lineTo(C + topHalf, bodyTop)
    .closePath()
    .fill(color);
};

const clear: GlyphFn = trashCan;
const del: GlyphFn = trashCan;

// ─── Post-edit "reset" — the same counter-clockwise circular arrow the split-node dialog uses
//     for its "rotate connections" control (lucide-react `RotateCcw`), meaning "rewind to the
//     generated state". Different from the preset "reset" tool (grey undecided-edge stub).
//
// Reproduces lucide's `RotateCcw` path in its native 24-unit viewBox, then scales into the box:
//   <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /> <path d="M3 3v5h5" />
// i.e. a ~330deg circle (r=9 about center 12,12) whose free end curves up-left to (3,8), plus an
// arrowhead bracket at (3,3)-(3,8)-(8,8).

const post_edit_reset: GlyphFn = (g) => {
  const color = hexToNumber(base.error);
  // lucide draws at strokeWidth 2 in a 24 unit box; keep that ratio after scaling to the glyph.
  const SCALE = (TILE_SIZE * 0.648) / 24;
  const w = 2 * SCALE * 1.15;
  // lucide's 24-box is centered on (12,12); map (lx,ly) -> glyph space around C.
  const P = (lx: number, ly: number): [number, number] => [C + (lx - 12) * SCALE, C + (ly - 12) * SCALE];

  const cx = 12, cy = 12, r = 9;
  // Circle arc: start at (3,12) (angle 180deg), sweep clockwise in lucide's y-down space almost
  // all the way round to where the "L3 8" tail begins near the top-left. Endpoint of the `a`
  // command is (3 + 3, 12 - 6.7) = (6, 5.3); then a straight line to (3, 8). Drawn as a polyline
  // of samples so it is one continuous stroked path with the tail (no native CCW-arc primitive
  // that also joins the tail seamlessly).
  const startA = Math.PI;                 // (3,12) relative to center
  const endA = Math.atan2(5.3 - cy, 6 - cx); // (6, 5.3) relative to center; already < 0
  const steps = 48;
  const [sx, sy] = P(cx + r * Math.cos(startA), cy + r * Math.sin(startA));
  g.moveTo(sx, sy);
  for (let i = 1; i <= steps; i++) {
    const a = startA + (endA - startA) * (i / steps);
    const [x, y] = P(cx + r * Math.cos(a), cy + r * Math.sin(a));
    g.lineTo(x, y);
  }
  // Tail: L3 8
  const [tx, ty] = P(3, 8);
  g.lineTo(tx, ty);
  g.stroke({ color, width: w, cap: "round", join: "round" });

  // Arrowhead bracket: M3 3 v5 h5  -> (3,3)-(3,8)-(8,8)
  const [h1x, h1y] = P(3, 3);
  const [h2x, h2y] = P(3, 8);
  const [h3x, h3y] = P(8, 8);
  g.moveTo(h1x, h1y).lineTo(h2x, h2y).lineTo(h3x, h3y).stroke({ color, width: w, cap: "round", join: "round" });
};

/** Tool key -> pictogram draw function. `Partial` because a few union members are drawn from a
 *  synthetic key instead (post-edit `reset` -> `post_edit_reset`); `toolGlyphs.test.ts` asserts
 *  every real tool still resolves to an entry so a newly added tool can't ship a blank button. */
export const GLYPHS: Partial<Record<PresetConnectionTool | PostEditTool | "post_edit_reset", GlyphFn>> = {
  wall,
  passage,
  reset,
  one_way,
  teleport_two_way,
  teleport_one_way,
  vertical_passage_two_way,
  vertical_passage_one_way,
  elevator,
  set_start,
  set_finish,
  manage_split_nodes,
  lock_in,
  lock_out,
  full_lock,
  gen_source,
  clear,
  delete: del,
  post_edit_reset,
};

export type ToolGlyphKey = keyof typeof GLYPHS;

// ─── Offscreen render + module cache ───────────────────────────────────────

let cache: Map<ToolGlyphKey, HTMLCanvasElement> | null = null;
let inFlight: Promise<Map<ToolGlyphKey, HTMLCanvasElement>> | null = null;

export const TOOL_GLYPH_BOX = BOX;

async function build(): Promise<Map<ToolGlyphKey, HTMLCanvasElement>> {
  const app = new Application();
  // Same rendering path the live canvas uses: a real Pixi `Application` at device-pixel
  // `resolution`, one `render()` per glyph straight into `app.canvas` (a fixed BOX*BOX CSS-px
  // surface, physically BOX*RESOLUTION px). No `RenderTexture` + `extract` round-trip — that
  // double-rasterised the glyph and is what made the buttons look pixelated (GitHub issue #456).
  await app.init({
    width: BOX,
    height: BOX,
    resolution: RESOLUTION,
    autoDensity: false,
    backgroundAlpha: 0,
    antialias: true,
    autoStart: false,
    sharedTicker: false,
  });

  const out = new Map<ToolGlyphKey, HTMLCanvasElement>();
  const px = BOX * RESOLUTION;
  try {
    for (const [tool, fn] of Object.entries(GLYPHS) as [ToolGlyphKey, GlyphFn][]) {
      const g = new Graphics();
      app.stage.addChild(g);
      fn(g);

      app.render();

      const own = document.createElement("canvas");
      own.width = px;
      own.height = px;
      own.getContext("2d")!.drawImage(app.canvas, 0, 0, px, px);
      out.set(tool, own);

      app.stage.removeChild(g);
      g.destroy();
    }
  } finally {
    app.destroy({ removeView: true }, { children: true });
  }
  return out;
}

export function getToolGlyphs(): Promise<Map<ToolGlyphKey, HTMLCanvasElement>> {
  if (cache) return Promise.resolve(cache);
  if (!inFlight) {
    inFlight = build().then(
      (m) => {
        cache = m;
        inFlight = null;
        return m;
      },
      (err) => {
        // Drop the rejected promise so a later call can retry (e.g. transient WebGL context loss)
        // instead of every consumer getting the same permanently-failed promise forever.
        inFlight = null;
        throw err;
      },
    );
  }
  return inFlight;
}
