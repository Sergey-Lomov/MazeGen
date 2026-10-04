import type React from "react";
import { useState } from "react";
import { indent, spacing } from "../../styles/theme";
import { Button } from "../Button";
import { SelectRow } from "../SelectRow";
import { LinkedSelectRow, LinkedSliderRow } from "./LinkedRows";
import { ParameterLinksDialog } from "./ParameterLinksDialog";
import { useMazeStore } from "../../store/mazeStore";
import type { CornerStyle } from "../../pixi/renderers/types";
import type { LinkIconVisibility } from "../../store/imageExportTypes";
import type { ParamDescriptor, ParamLink, ParamModifier, ColorModifier } from "../../store/parameterLinks";
import * as m from "~/paraglide/messages";

/** The "Shared style" section (GitHub issue #322) — one collapsible section, always first, shared
 *  by `VectorByWallsSettingsPanel`/`VectorByCorridorsSettingsPanel` (only the underlying store
 *  setters differ, same per-mode-setters-only-differ reuse convention as `MarkerSettingsGroup`/
 *  `TeleportSettingsSection`). Four rows (corner style, marker size, marker border, gap) each set
 *  a shared value that every non-overridden dependent field across the panel follows; "Reset all
 *  settings" restores the whole render mode's settings object. Per-field reset buttons live on the
 *  *dependent* field's own row elsewhere in the panel (e.g. the "Waypoints" section's marker size
 *  slider), not here — this section only owns the four shared values themselves. */
export function SharedStyleSection<P extends string>({
  cornerStyle,
  markerSize,
  markerBorderWidth,
  gapWidth,
  onCornerStyleChange,
  onMarkerSizeChange,
  onMarkerBorderWidthChange,
  onGapWidthChange,
  onResetAll,
  settings,
  links,
  registry,
  onSetLinkEnabled,
  onAddLink,
  onRemoveLink,
  activePaths,
}: {
  cornerStyle: CornerStyle;
  markerSize: number;
  markerBorderWidth: number;
  gapWidth: number;
  onCornerStyleChange: (v: CornerStyle) => void;
  onMarkerSizeChange: (v: number) => void;
  onMarkerBorderWidthChange: (v: number) => void;
  onGapWidthChange: (v: number) => void;
  onResetAll: () => void;
  /** Backs the "Manage links..." dialog (GitHub issue #644) — the active render mode's own link
   *  graph/registry and mutators, generic over that mode's `ParamPath` union. */
  settings: object;
  links: ParamLink<P>[];
  registry: Record<P, ParamDescriptor>;
  onSetLinkEnabled: (target: P, enabled: boolean) => void;
  onAddLink: (source: P, target: P, modifiers?: ParamModifier[], colorModifiers?: ColorModifier[]) => void;
  onRemoveLink: (target: P) => void;
  /** Paths currently shown in the settings panel (GitHub issue #670) — passed through to the
   *  parameter-links dialog so inactive parameters can be told apart from active ones. */
  activePaths: Set<P>;
}) {
  const [linksDialogOpen, setLinksDialogOpen] = useState(false);
  const linkIconVisibility = useMazeStore((s) => s.linkIconVisibility);
  const setLinkIconVisibility = useMazeStore((s) => s.setLinkIconVisibility);

  return (
    <div style={styles.block}>
      <SelectRow
        label={m["image_export.param_links.link_icon_visibility_label"]()}
        value={linkIconVisibility}
        options={[
          { value: "always" as LinkIconVisibility, label: m["image_export.param_links.link_icon_visibility_always"]() },
          { value: "linked" as LinkIconVisibility, label: m["image_export.param_links.link_icon_visibility_linked"]() },
          { value: "never" as LinkIconVisibility, label: m["image_export.param_links.link_icon_visibility_never"]() },
        ]}
        onChange={setLinkIconVisibility}
      />
      <LinkedSelectRow
        label={m["image_export.vector_by_walls.shared_style_corner_style"]()}
        value={cornerStyle}
        options={[
          { value: "miter" as CornerStyle, label: m["image_export.vector_by_walls.corner_style_sharp"]() },
          { value: "round" as CornerStyle, label: m["image_export.vector_by_walls.corner_style_round"]() },
        ]}
        onChange={onCornerStyleChange}
        linkTarget={"cornerStyle" as P}
      />
      <LinkedSliderRow
        label={m["image_export.vector_by_walls.shared_style_marker_size"]()}
        value={markerSize}
        onChange={onMarkerSizeChange}
        min={0}
        max={1}
        step={0.01}
        format={(v) => v.toFixed(2)}
        linkTarget={"markerSize" as P}
      />
      <LinkedSliderRow
        label={m["image_export.vector_by_walls.shared_style_marker_border_width"]()}
        value={markerBorderWidth}
        onChange={onMarkerBorderWidthChange}
        min={0}
        max={10}
        step={1}
        format={(v) => String(v)}
        linkTarget={"markerBorderWidth" as P}
      />
      <LinkedSliderRow
        label={m["image_export.vector_by_walls.shared_style_gap_width"]()}
        value={gapWidth}
        onChange={onGapWidthChange}
        min={0}
        max={10}
        step={1}
        format={(v) => String(v)}
        linkTarget={"gapWidth" as P}
      />
      <Button variant="secondary" onClick={() => setLinksDialogOpen(true)}>
        {m["image_export.param_links.manage_links"]()}
      </Button>
      <Button variant="destructive" onClick={onResetAll}>
        {m["image_export.vector_by_walls.shared_style_reset_all"]()}
      </Button>
      {linksDialogOpen && (
        <ParameterLinksDialog
          registry={registry}
          settings={settings}
          links={links}
          onSetLinkEnabled={onSetLinkEnabled}
          onAddLink={onAddLink}
          onRemoveLink={onRemoveLink}
          onClose={() => setLinksDialogOpen(false)}
          activePaths={activePaths}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
};
