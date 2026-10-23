import { LinkedSelectRow, LinkedSliderRow } from "./LinkedRows";
import type { MarkerLayoutMode } from "../../pixi/selectors/mazeSelectors/markerLayout";
import * as m from "~/paraglide/messages";

/** "Layout" + "Scale" rows of the marker positioning layer (GitHub issue #735), shared by both
 *  vector panels' "Shared style → Marker overlap" sub-section — the layer arranges every marker kind sharing one host
 *  (start/finish, teleport points, vertical-connection markers), not just waypoints. `layout` is a
 *  plain enum (no link registry entry, same as the other dropdowns).*/
export function MarkerLayoutRows({ layout, onLayoutChange, scale, onScaleChange }: {
  layout: MarkerLayoutMode;
  onLayoutChange: (mode: MarkerLayoutMode) => void;
  scale: number;
  onScaleChange: (v: number) => void;
}) {
  return (
    <>
      <LinkedSelectRow
        label={m["image_export.marker_layout.layout"]()}
        value={layout}
        options={[
          { value: "auto", label: m["image_export.marker_layout.auto"]() },
          { value: "row", label: m["image_export.marker_layout.row"]() },
          { value: "grid", label: m["image_export.marker_layout.grid"]() },
          { value: "radial", label: m["image_export.marker_layout.radial"]() },
          { value: "overlap", label: m["image_export.marker_layout.overlap"]() },
        ]}
        onChange={onLayoutChange}
        linkTarget={null}
      />
      <LinkedSliderRow
        label={m["image_export.marker_layout.scale"]()}
        value={scale}
        onChange={onScaleChange}
        min={0}
        max={1}
        step={0.05}
        format={(v) => v.toFixed(2)}
        linkTarget="markerScale"
      />
    </>
  );
}
