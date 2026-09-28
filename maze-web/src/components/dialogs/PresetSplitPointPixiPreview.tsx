import { useEffect, useRef } from "react";
import { Application, Container, Graphics } from "pixi.js";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { PresetConnectionEntry } from "../../pixi/fieldEditUtils";
import { getCellVertices, getCellCenter } from "../../pixi/tessellationGeometry";
import { buildPresetSplitPassages, buildPresetNodePositions, presetEndpointScreenPos } from "../../pixi/selectors/presetSelectors";
import { SplitJunctionRenderer, collectSplitWallPaths } from "../../pixi/renderers/SplitJunctionRenderer";
import { WallRenderer } from "../../pixi/renderers/WallRenderer";
import { fitTileToWorld, clipToTile } from "../../pixi/tilePreviewFit";
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
      const scale = fitTileToWorld(world, verts, center, size);

      if (verts.length > 0) {
        const bg = new Graphics();
        bg.poly(verts.flatMap((v) => [v.x, v.y])).fill({ color: hexToNum(ui.bg.panelAlt) });
        world.addChild(bg);
      }

      // `content` clipped to this tile's own polygon (GitHub issue #609) — `buildPresetSplitPassages`
      // resolves every declared split point on the floor, not just this one, so a neighbouring
      // split point's geometry would otherwise bleed into the preview whenever it happens to fall
      // within this canvas's pixel bounds. See `fitTileToWorld`/`clipToTile` (`pixi/tilePreviewFit.ts`).
      const content = new Container();
      world.addChild(content);
      clipToTile(content, verts);

      const wallsLayer = new Container();
      const splitLayer = new Container();
      const markerLayer = new Container();
      content.addChild(wallsLayer, splitLayer, markerLayer);

      const wallRenderer = new WallRenderer(wallsLayer);
      const splitRenderer = new SplitJunctionRenderer(splitLayer);

      // Only THIS point's own split renders — a split neighbor's own geometry must not appear at
      // all, even the small sliver `clipToTile`'s margin lets through (GitHub issue #632 follow-up).
      // `buildPresetSplitPassages` resolves every declared split point's geometry off the *full*
      // `presetSplitPoints`/`presetConnections` (a neighbor's real connecting slot must stay
      // resolvable, or a real connection to a non-original slot would silently misread as
      // undecided), so filtering happens on the *output* instead: `passages`/`specialShapes` both
      // carry their own `pointKey`, keep only this point's. `wallFaces` has no such tag, but a
      // neighbor's own all-wall face sits exactly on the shared boundary with ours — the same
      // segment our own point already draws for that face — so leaving it unfiltered just redraws
      // an identical line, not a visible leak.
      const ownPointKey = `${point[0]},${point[1]}`;
      const built = buildPresetSplitPassages(presetSplitPoints, presetConnections, cfg, {}, cells);
      const passages = built.passages.filter((p) => p.pointKey === ownPointKey);
      const { wallFaces } = built;
      const specialShapes = built.specialShapes.filter((s) => s.pointKey === ownPointKey);
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
        // Radius/stroke are in grid units, then scaled by `world.scale` — a hex cell spans more
        // grid units than a square one, so a fixed grid-unit radius renders far smaller on hex.
        // Divide by `scale` so the dot is a constant on-screen size across every tessellation.
        const dotR = 7 / scale;
        const dotStroke = 2 / scale;
        pointEndpoints.forEach((ep, i) => {
          const [px, py] = presetEndpointScreenPos(ep, cfg, nodePositions);
          // Same colour formula the picker rows use (`splitSlotColor`) so a dot matches its row.
          const color = splitSlotColor(i, canvas.node.splitSlots);
          g.circle(px, py, dotR).fill({ color }).stroke({ color: hexToNum(ui.bg.panelAlt), width: dotStroke });
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
