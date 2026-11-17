import type { DirectionIndicatorGeometry, DirectionIndicatorLeaf } from "../../store/imageExportTypes";
import type { WallsLinkPath } from "../../store/parameterLinkSchema";
import { TILE_SIZE } from "../../pixi/constants";
import { LinkedSliderRow } from "./LinkedRows";
import * as m from "~/paraglide/messages";

/** Where the geometry lives in the settings, as the dotted prefix of its link paths. */
type GeometryPrefix = "oneWayGeometry" | "startOpening.geometry" | "finishOpening.geometry";

const SIZE_RANGE = { min: 0.05 * TILE_SIZE, max: TILE_SIZE, step: 1, format: (v: number) => String(Math.round(v)) };
const THICKNESS_RANGE = { min: 1, max: 10, step: 1, format: (v: number) => String(v) };
const HEAD_WIDTH_RANGE = { min: 1, max: 0.5 * TILE_SIZE, step: 1, format: (v: number) => String(Math.round(v)) };

/** One row per `DirectionIndicatorGeometry` parameter, in display order. */
const ROWS: readonly { leaf: DirectionIndicatorLeaf; label: () => string; range: typeof SIZE_RANGE }[] = [
  { leaf: "triangle.size", label: () => m["image_export.vector_by_walls.one_way_size"](), range: SIZE_RANGE },
  { leaf: "chevron.size", label: () => m["image_export.vector_by_walls.one_way_size"](), range: SIZE_RANGE },
  { leaf: "chevron.thickness", label: () => m["image_export.vector_by_walls.one_way_thickness"](), range: THICKNESS_RANGE },
  { leaf: "arrow.length", label: () => m["image_export.vector_by_walls.one_way_length"](), range: SIZE_RANGE },
  { leaf: "arrow.headWidth", label: () => m["image_export.vector_by_walls.one_way_head_width"](), range: HEAD_WIDTH_RANGE },
  { leaf: "arrow.thickness", label: () => m["image_export.vector_by_walls.one_way_thickness"](), range: THICKNESS_RANGE },
];

function leafValue(geometry: DirectionIndicatorGeometry, leaf: DirectionIndicatorLeaf): number {
  const [pattern, param] = leaf.split(".") as [keyof DirectionIndicatorGeometry, string];
  return (geometry[pattern] as Record<string, number>)[param];
}

/** The size parameters of a direction indicator (GitHub issue #993): every pattern's own set, one linked
 *  row per parameter, linked at `${prefix}.${leaf}`. A row shows only while its link-schema rule reports
 *  it active, i.e. while its pattern is the selected one, so the panel carries no pattern branching of its own. */
export function IndicatorGeometryRows({ geometry, onChange, prefix }: {
  geometry: DirectionIndicatorGeometry;
  onChange: (leaf: DirectionIndicatorLeaf, value: number) => void;
  prefix: GeometryPrefix;
}) {
  return (
    <>
      {ROWS.map(({ leaf, label, range }) => {
        // Typed, not cast: compilation fails if a prefix/leaf pair is not a schema path.
        const linkTarget: WallsLinkPath = `${prefix}.${leaf}`;
        return (
          <LinkedSliderRow
            key={leaf}
            label={label()}
            value={leafValue(geometry, leaf)}
            onChange={(v) => onChange(leaf, v)}
            {...range}
            linkTarget={linkTarget}
          />
        );
      })}
    </>
  );
}
