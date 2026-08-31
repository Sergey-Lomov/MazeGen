import { useEffect, useRef } from "react";
import { Application, Container, Graphics } from "pixi.js";
import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { getCellVertices, getCellCenter, buildNodePositions } from "../../pixi/tessellationGeometry";
import { buildSplitPassages } from "../../pixi/selectors/mazeSelectors";
import { SplitJunctionRenderer, collectSplitWallPaths } from "../../pixi/renderers/SplitJunctionRenderer";
import { WallRenderer } from "../../pixi/renderers/WallRenderer";
import { canvas } from "../../pixi/colorTokens";
import { splitSlotColor } from "../../pixi/colorUtils";
import { ui } from "../../styles/theme";

interface Props {
  point: [number, number];
  cfg: TessellationConfig;
  /** The point's own nodes on the active floor, in snapshot order (index 0 = original) — drives
   *  the marker-dot colours/positions and nothing else. */
  pointNodes: NodeDto[];
  /** Every node on the active floor — `buildSplitPassages`/`buildMazeWalls` need the full set (a
   *  split point's edges run to neighbouring cells' nodes, which must be resolvable). */
  allNodes: NodeDto[];
  /** Every basic/one-way + teleport edge on the active floor (real ids). Teleport-kind entries
   *  are filtered out by `buildSplitPassages`/`buildMazeWalls` themselves. */
  allEdges: EdgeDto[];
  /** When set (the caller decides — only on a recognised special shape), each of `pointNodes`
   *  gets a marker dot in its colour at its real node-anchor position, so the user can tell the
   *  nodes apart by position. On a plain split the line colours already disambiguate. */
  showMarkers?: boolean;
  size?: number;
}

function hexToNum(color: string): number {
  return parseInt(color.replace("#", ""), 16);
}

/** Tiny non-interactive Pixi render of one split point — just the split geometry itself
 * (`buildSplitPassages` + `SplitJunctionRenderer`, plus the special-shape bridge/diagonal paths
 * via `collectSplitWallPaths` + a bare `WallRenderer`), oriented the same way as on the field but
 * with no neighbouring cells / shared walls drawn. Reuses the main canvas's own pipeline so a
 * recognised special shape draws with its real geometry, not the SVG hub-diagram approximation.
 * Used by `PostEditSplitTargetDialog` (GitHub issue #474). Everything is in grid-unit coordinates
 * (`getCellCenter`-based); a wrapper `Container` is scaled/translated so this one tile fills
 * `size` px. */
export function SplitPointPixiPreview({ point, cfg, pointNodes, allNodes, allEdges, showMarkers = false, size = 110 }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let app: Application | null = null;

    const host = hostRef.current;
    if (!host) return;

    const run = async () => {
      const instance = new Application();
      // `autoStart: false` + `sharedTicker: false`: this mini-canvas must not join the main
      // app's shared render ticker. Otherwise, after this component unmounts and its renderer
      // is destroyed, the shared ticker keeps calling `render()` on the dead stage — pixi v8's
      // `GlGraphicsAdaptor` then throws `Cannot read properties of null (reading 'count')`.
      // The scene is static, so a single manual `render()` at the end of `run()` is enough.
      await instance.init({
        width: size,
        height: size,
        backgroundAlpha: 0,
        antialias: true,
        autoStart: false,
        sharedTicker: false,
      });
      if (cancelled) { instance.destroy({ removeView: true }, { children: true }); return; }
      app = instance;
      host.appendChild(instance.canvas);

      const world = new Container();
      instance.stage.addChild(world);

      // Fit: this tile's own vertex bbox (plus a small margin) fills the canvas — every other
      // cell's geometry is drawn too, but sits outside the viewport.
      const verts = getCellVertices(point[0], point[1], cfg) ?? [];
      const center = getCellCenter(point[0], point[1], cfg);
      const pad = 6;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const v of [...verts, center]) {
        minX = Math.min(minX, v.x); minY = Math.min(minY, v.y);
        maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y);
      }
      const w = maxX - minX + pad * 2, h = maxY - minY + pad * 2;
      const scale = Math.min(size / w, size / h);
      world.scale.set(scale);
      world.position.set(
        (size - w * scale) / 2 - (minX - pad) * scale,
        (size - h * scale) / 2 - (minY - pad) * scale,
      );

      if (verts.length > 0) {
        const bg = new Graphics();
        bg.poly(verts.flatMap((v) => [v.x, v.y])).fill({ color: hexToNum(ui.bg.panelAlt) });
        world.addChild(bg);
      }

      const wallsLayer = new Container();
      const splitLayer = new Container();
      const markerLayer = new Container();
      world.addChild(wallsLayer, splitLayer, markerLayer);

      const wallRenderer = new WallRenderer(wallsLayer);
      const splitRenderer = new SplitJunctionRenderer(splitLayer);

      const { passages, wallFaces, specialShapes } = buildSplitPassages(allNodes, allEdges, cfg);
      // Only the split's own geometry — no `buildMazeWalls` (neighbouring cells' shared walls).
      // `WallRenderer` here draws nothing but the special-shape bridge/diagonal paths.
      const { paths: extraWalls, noCapPoints } = collectSplitWallPaths(wallFaces, specialShapes);
      wallRenderer.render({ edges: [] }, cfg, undefined, undefined, extraWalls, noCapPoints);
      splitRenderer.render({ passages, wallFaces, specialShapes });

      // Marker dots — the exact node-anchor positions the main canvas uses (`buildNodePositions`,
      // fed the full floor's edges so its own special-shape detection matches the drawing above).
      if (showMarkers) {
        const directedPairs = allEdges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
        const pos = buildNodePositions(allNodes, cfg, directedPairs);
        const g = new Graphics();
        // Radius/stroke are in grid units, then scaled by `world.scale` — a hex cell spans more
        // grid units than a square one, so a fixed grid-unit radius renders far smaller on hex.
        // Divide by `scale` so the dot is a constant on-screen size across every tessellation.
        const dotR = 7 / scale;
        const dotStroke = 2 / scale;
        pointNodes.forEach((n, i) => {
          const p = pos.get(n.id) ?? center;
          // Same colour formula the picker rows use (`splitSlotColor`) so a dot matches its row —
          // fixed palette for the first slots, generated overflow colours beyond that.
          const color = splitSlotColor(i, canvas.node.splitSlots);
          g.circle(p.x, p.y, dotR).fill({ color }).stroke({ color: hexToNum(ui.bg.panelAlt), width: dotStroke });
        });
        markerLayer.addChild(g);
      }

      if (!cancelled) instance.render();
    };

    void run();

    return () => {
      cancelled = true;
      app?.destroy({ removeView: true }, { children: true });
    };
  }, [point, cfg, pointNodes, allNodes, allEdges, showMarkers, size]);

  return <div ref={hostRef} style={{ width: size, height: size, flex: "0 0 auto" }} />;
}
