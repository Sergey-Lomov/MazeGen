import { useEffect, useRef } from "react";
import { Application, Container, Graphics } from "pixi.js";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { PresetConnectionEntry } from "../../pixi/fieldEditUtils";
import { getCellVertices, getCellCenter } from "../../pixi/tessellationGeometry";
import { buildPresetSplitPassages, buildPresetNodePositions, presetEndpointScreenPos } from "../../pixi/selectors/presetSelectors";
import { SplitJunctionRenderer, collectSplitWallPaths } from "../../pixi/renderers/SplitJunctionRenderer";
import { WallRenderer } from "../../pixi/renderers/WallRenderer";
import { presetEndpoint } from "../../pixi/presetEndpoint";
import { canvas } from "../../pixi/colorTokens";
import { splitSlotColor } from "../../pixi/colorUtils";
import { ui } from "../../styles/theme";

interface Props {
  point: [number, number];
  cfg: TessellationConfig;
  /** The point's declared slot ids on the active floor, ascending — index 0 of the rendered
   *  marker dots is always the original node, then one per slot. */
  slotIds: number[];
  /** Every declared split point on the active floor (`presetSplitPoints`, level-scoped map keyed
   *  `"x,y"` — `buildPresetSplitPassages` needs the whole set: a split point's faces resolve
   *  against its neighbours' nodes). */
  presetSplitPoints: Record<string, number[]>;
  /** Every preset connection on the active floor, level-scoped. */
  presetConnections: Map<string, PresetConnectionEntry>;
  /** All in-field cells on the active floor. */
  cells: [number, number][];
  /** When set (only on a recognised special shape), each node gets a marker dot in its colour at
   *  its real anchor position. On a plain split the line colours already disambiguate. */
  showMarkers?: boolean;
  size?: number;
}

function hexToNum(color: string): number {
  return parseInt(color.replace("#", ""), 16);
}

/** Preset-stage counterpart of `SplitPointPixiPreview` (GitHub issue #474) — a tiny
 * non-interactive Pixi render of one declared split point, built from `presetSplitPoints` /
 * `presetConnections` (no generated nodes exist yet) via `buildPresetSplitPassages` +
 * `SplitJunctionRenderer`, plus the special-shape bridge/diagonal paths. Oriented the same way as
 * on the field, no neighbouring cells / shared walls drawn. Used by `PresetSplitTargetDialog`. */
export function PresetSplitPointPixiPreview({
  point, cfg, slotIds, presetSplitPoints, presetConnections, cells, showMarkers = false, size = 110,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let app: Application | null = null;

    const host = hostRef.current;
    if (!host) return;

    const run = async () => {
      const instance = new Application();
      // `autoStart: false` + `sharedTicker: false`: this mini-canvas must not join the main
      // app's shared render ticker (see `SplitPointPixiPreview` for the pixi-v8 crash it avoids).
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

      const { passages, wallFaces, specialShapes } = buildPresetSplitPassages(presetSplitPoints, presetConnections, cfg, {}, cells);
      // Only the split's own geometry — no neighbouring cells' shared walls.
      const { paths: extraWalls, noCapPoints } = collectSplitWallPaths(wallFaces, specialShapes);
      wallRenderer.render({ edges: [] }, cfg, undefined, undefined, extraWalls, noCapPoints);
      splitRenderer.render({ passages, wallFaces, specialShapes });

      if (showMarkers) {
        // Same node-anchor resolution the canvas uses (`buildPresetNodePositions` +
        // `presetEndpointScreenPos`), so a dot sits exactly where that node's passages are drawn.
        const nodePositions = buildPresetNodePositions(cfg, presetSplitPoints, presetConnections);
        // Original node first, then each slot ascending — index drives the dot colour.
        const pointEndpoints = [presetEndpoint(point), ...slotIds.map((s) => presetEndpoint(point, s))];
        const g = new Graphics();
        pointEndpoints.forEach((ep, i) => {
          const [px, py] = presetEndpointScreenPos(ep, cfg, nodePositions);
          // Same colour formula the picker rows use (`splitSlotColor`) so a dot matches its row.
          const color = splitSlotColor(i, canvas.node.splitSlots);
          g.circle(px, py, 3).fill({ color }).stroke({ color: hexToNum(ui.bg.panelAlt), width: 1 });
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
  }, [point, cfg, slotIds, presetSplitPoints, presetConnections, cells, showMarkers, size]);

  return <div ref={hostRef} style={{ width: size, height: size, flex: "0 0 auto" }} />;
}
