import { useEffect, useRef } from "react";
import { Container, Graphics } from "pixi.js";
import { renderOffscreen } from "../../pixi/sharedOffscreenRenderer";
import type { FieldConfig } from "../../fieldConfig";
import { getCellCenter, getCellVertices } from "../../domain/tessellationGeometry";
import { buildMazeWalls } from "../../domain/selectors/mazeSelectors";
import { WallRenderer } from "../../pixi/renderers/WallRenderer";
import { fitTileToWorld, clipToTile } from "../../pixi/tilePreviewFit";
import { originCellOf } from "../../domain/splitPatternTile";
import { shapeFaceIndices, shapeMiniMaze } from "../../pixi/nodeShapeTile";
import { ui } from "../../styles/theme";

interface Props {
  /** `NodeShape::key()`. */
  shape: string;
  cfg: FieldConfig;
  /** The cell the shape is drawn on; the origin cell when omitted. */
  cell?: readonly [number, number];
  /** Angular rank of every face of `cell` (`CellTypeShapes.faceRanks`); needed for junction shapes. */
  faceRanks?: readonly number[];
  size?: number;
}

function hexToNum(color: string): number {
  return parseInt(color.replace("#", ""), 16);
}

/** Tiny non-interactive Pixi render of one node shape as it looks in a maze: the tile with
 *  walls on every face except the shape's own, drawn by the maze's own wall pipeline
 *  (`buildMazeWalls` + `WallRenderer`) and clipped to the tile. Rendered on the one shared WebGL
 *  context (`renderOffscreen`) and shown as a plain canvas, so a long list costs no extra contexts. */
export function NodeShapeIcon({ shape, cfg, cell, faceRanks, size = 48 }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // The selector hands back a fresh config object per render; rebuild the Pixi app only when the
  // tile geometry can actually differ (a limit edit re-renders this row on every keystroke).
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const geometryKey = JSON.stringify([cfg.tessellation, cfg.orientation, cell, faceRanks]);

  useEffect(() => {
    const host = hostRef.current;
    const cfg = cfgRef.current;
    const tile = cell ?? originCellOf(cfg);
    const faces = shapeFaceIndices(shape, cfg, tile, faceRanks);
    if (!host || !faces) return;

    const abort = new AbortController();
    const draw = (scene: Container) => {
      const [x, y] = tile;
      const verts = getCellVertices(x, y, cfg) ?? [];
      const world = new Container();
      scene.addChild(world);
      fitTileToWorld(world, verts, getCellCenter(x, y, cfg), size);

      if (verts.length > 0) {
        const floor = new Graphics();
        floor.poly(verts.flatMap((v) => [v.x, v.y])).fill({ color: hexToNum(ui.bg.panelAlt) });
        world.addChild(floor);
      }

      // Neighbours across the open faces exist only so those faces read as passages; the clip
      // hides everything outside this tile.
      const content = new Container();
      world.addChild(content);
      clipToTile(content, verts);
      const { nodes, edges } = shapeMiniMaze(faces, cfg, tile);
      new WallRenderer(content).render({ edges: buildMazeWalls(nodes, edges, cfg) }, cfg);
    };

    renderOffscreen(size, draw, abort.signal)
      .then((canvas) => {
        if (canvas && !abort.signal.aborted) host.replaceChildren(canvas);
      })
      .catch((error) => console.error("Node shape icon not rendered", error));
    return () => {
      abort.abort();
      host.replaceChildren();
    };
  }, [shape, geometryKey, size]);

  return <div ref={hostRef} style={{ width: size, height: size, flex: "0 0 auto" }} />;
}
