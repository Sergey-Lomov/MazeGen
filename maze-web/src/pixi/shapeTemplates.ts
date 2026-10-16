import type { FieldConfig, TessellationConfig } from "../fieldConfig";
import type { SplitPattern } from "../wasm/types";
import { getTessellationShapes } from "../wasm/mazeService";
import { patternAnchorPoint } from "./splitPatternTile";

/// Shape template keys per tessellation config (`{ kind, params }` fully identifies the built
/// instance, same key `cartesianCache.ts` uses). Asked from core once per config, since store
/// actions and selectors query this on every tessellation change/preview render.
const keysCache = new Map<string, string[]>();
const anchorShapeCache = new Map<string, string>();

function configKey(tessellation: TessellationConfig): string {
  return JSON.stringify(tessellation);
}

/** Shape template keys (core `ShapeDescriptor::key`) the tessellation `tessellation` builds
 *  provides — core's `Tessellation::shape_descriptors()` via wasm (GitHub issue #758). A split
 *  pattern belongs to one of these keys, not to a tessellation: it survives a tessellation change
 *  when the new tessellation provides its key. */
export function shapeKeysOf(tessellation: TessellationConfig): string[] {
  const key = configKey(tessellation);
  let keys = keysCache.get(key);
  if (keys === undefined) {
    keys = getTessellationShapes({ tessellation, points: [] }).keys;
    keysCache.set(key, keys);
  }
  return keys;
}

/** The patterns whose shape template `tessellation` provides — the ones that survive a switch to
 *  it (GitHub issue #758). */
export function splitPatternsFor(patterns: SplitPattern[], tessellation: TessellationConfig): SplitPattern[] {
  const shapes = shapeKeysOf(tessellation);
  return patterns.filter((pattern) => shapes.includes(pattern.shape));
}

/** Shape template key a pattern authored against `cfg` belongs to — the template of the cell the
 *  pattern editor draws (`patternAnchorPoint`), as core's `Tessellation::shape_of` binds it. */
export function patternShapeOf(cfg: FieldConfig): string {
  const anchor = patternAnchorPoint(cfg);
  const key = `${configKey(cfg.tessellation)}@${anchor[0]},${anchor[1]}`;
  let shape = anchorShapeCache.get(key);
  if (shape === undefined) {
    shape = getTessellationShapes({ tessellation: cfg.tessellation, points: [anchor] }).point_shapes[0];
    if (shape === undefined) throw new Error(`pattern anchor ${anchor.join(",")} has no shape template`);
    anchorShapeCache.set(key, shape);
  }
  return shape;
}
