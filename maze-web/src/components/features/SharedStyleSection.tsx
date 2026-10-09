import type React from "react";
import { useState } from "react";
import { indent, spacing, typography, muted } from "../../styles/theme";
import { Button } from "../Button";
import { SelectRow } from "../SelectRow";
import { Inline } from "../Layout";
import { Modal } from "../Modal";
import { MarkerAppearanceRows } from "./MarkerFieldRows";
import { LinkedSelectRow, LinkedSliderRow } from "./LinkedRows";
import { AutoFitButton } from "./TextFitContext";
import { TEXT_SIZE_RANGE } from "../../pixi/renderConstants";
import type { ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import { PC } from "../../pixi/selectors/projectColorsSelector";
import { ParameterLinksDialog } from "./ParameterLinksDialog";
import { useMazeStore } from "../../store/mazeStore";
import type { LinkIconVisibility, SharedStyleSourceFields } from "../../store/imageExportTypes";
import type { ParamDescriptor, ParamLink, ParamModifier, ColorModifier } from "../../store/parameterLinks";
import * as m from "~/paraglide/messages";

/** Explains the parameter-link system to end users (GitHub issue #669) — plain-language only, no
 *  internal terminology (driving/dependent link, `ParamModifier`, etc.) and no mention of
 *  already-expected behavior (e.g. that links/modifiers persist with the project). */
function ParamLinksInfoModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={m["image_export.param_links.info_title"]()} onClose={onClose}>
      <div style={styles.infoText}>{m["image_export.param_links.info_what"]()}</div>
      <div style={styles.infoText}>{m["image_export.param_links.info_how"]()}</div>
      <div style={styles.infoText}>{m["image_export.param_links.info_modifiers"]()}</div>
      <div style={styles.infoText}>{m["image_export.param_links.info_icon"]()}</div>
      <div style={styles.infoText}>{m["image_export.param_links.info_visibility"]()}</div>
    </Modal>
  );
}

/** The "Settings" section (GitHub issue #668) — one collapsible section, placed before "Shared
 *  style", holding every link-editing/management control that isn't itself a style value: link
 *  icon visibility, "Manage links...", and the destructive "Reset all settings". Split out of what
 *  used to be one combined "Shared style" section (GitHub issue #322/#643) so style configuration
 *  and management actions don't clutter each other, per the issue's own rationale. Shared by
 *  `VectorByWallsSettingsPanel`/`VectorByCorridorsSettingsPanel`, same per-mode-setters-only-differ
 *  reuse convention as `SharedStyleSection` itself. */
export function SettingsSection<P extends string>({
  onResetAll,
  settings,
  links,
  registry,
  onSetLinkEnabled,
  onAddLink,
  onRemoveLink,
  activePaths,
}: {
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
  const [infoOpen, setInfoOpen] = useState(false);
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
      <Inline gap="rowGap" align="stretch">
        <Button variant="secondary" layoutStyle={styles.manageLinksButton} onClick={() => setLinksDialogOpen(true)}>
          {m["image_export.param_links.manage_links"]()}
        </Button>
        <Button variant="secondary" layoutStyle={styles.infoButton} onClick={() => setInfoOpen(true)} title={m["image_export.param_links.info_title"]()}>
          &#8505;
        </Button>
      </Inline>
      <Button variant="destructive" onClick={onResetAll}>
        {m["image_export.vector_by_walls.shared_style_reset_all"]()}
      </Button>
      {infoOpen && <ParamLinksInfoModal onClose={() => setInfoOpen(false)} />}
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

/** The "Shared style" section (GitHub issue #322) — one collapsible section, shared by
 *  `VectorByWallsSettingsPanel`/`VectorByCorridorsSettingsPanel` (only the underlying store setter
 *  differs, same per-mode-setters-only-differ reuse convention as `MarkerSettingsGroup`/
 *  `TeleportSettingsSection`). GitHub issue #701: holds one "Markers" sub-section with every
 *  property all markers share (shape, corner style, size, fill/border color, border width, gap
 *  width — the same `MarkerAppearanceRows` every marker-like consumer renders), each a shared value
 *  that every linked dependent field across the panel follows. Per-field reset buttons live on the
 *  *dependent* field's own row elsewhere in the panel, not here. Link editing/icon-visibility/
 *  "Reset all settings" live in the separate "Settings" section (GitHub issue #668) — this section
 *  is style values only. */
export function SharedStyleSection<P extends string>({
  settings,
  onChange,
  priorityColors,
}: {
  settings: SharedStyleSourceFields;
  onChange: (patch: Partial<SharedStyleSourceFields>) => void;
  /** "Priority" project colors (GitHub issue #503) for the fill / border color rows. */
  priorityColors?: { fillColor?: ProjectColorEntry[]; borderColor?: ProjectColorEntry[] };
}) {
  return (
    <div style={styles.block}>
      <div style={typography.body}>{m["image_export.vector_by_walls.shared_style_subsection_markers"]()}</div>
      <div style={styles.group}>
        <MarkerAppearanceRows
          settings={{
            shape: settings.markerShape,
            cornerStyle: settings.cornerStyle,
            size: settings.markerSize,
            fillColor: settings.markerFillColor,
            borderColor: settings.markerBorderColor,
            borderWidth: settings.markerBorderWidth,
            gapWidth: settings.gapWidth,
          }}
          onChange={(patch) => {
            const mapped: Partial<SharedStyleSourceFields> = {};
            if (patch.shape !== undefined) mapped.markerShape = patch.shape;
            if (patch.cornerStyle !== undefined) mapped.cornerStyle = patch.cornerStyle;
            if (patch.size !== undefined) mapped.markerSize = patch.size;
            if (patch.fillColor !== undefined) mapped.markerFillColor = patch.fillColor;
            if (patch.borderColor !== undefined) mapped.markerBorderColor = patch.borderColor;
            if (patch.borderWidth !== undefined) mapped.markerBorderWidth = patch.borderWidth;
            if (patch.gapWidth !== undefined) mapped.gapWidth = patch.gapWidth;
            onChange(mapped);
          }}
          linkTargets={{
            shape: "markerShape" as P,
            cornerStyle: "cornerStyle" as P,
            size: "markerSize" as P,
            fillColor: "markerFillColor" as P,
            borderColor: "markerBorderColor" as P,
            borderWidth: "markerBorderWidth" as P,
            gapWidth: "gapWidth" as P,
          }}
          priorityColors={priorityColors}
          fieldNames={{ fillColor: PC.sharedMarkerFill.name(), borderColor: PC.sharedMarkerBorder.name() }}
        />
      </div>
      <div style={typography.body}>{m["image_export.vector_by_walls.shared_style_subsection_text"]()}</div>
      <div style={styles.group}>
        <LinkedSelectRow
          label={m["image_export.vector_by_walls.marker_text_font_weight"]()}
          value={settings.markerTextFontWeight}
          options={[
            { value: "regular", label: m["image_export.vector_by_walls.elevator_badges_font_weight_regular"]() },
            { value: "bold", label: m["image_export.vector_by_walls.elevator_badges_font_weight_bold"]() },
          ]}
          onChange={(markerTextFontWeight) => onChange({ markerTextFontWeight })}
          linkTarget={"markerTextFontWeight" as P}
        />
        <LinkedSliderRow
          label={m["image_export.vector_by_walls.marker_text_size"]()}
          value={settings.markerTextSize}
          onChange={(markerTextSize) => onChange({ markerTextSize })}
          min={TEXT_SIZE_RANGE.min}
          max={TEXT_SIZE_RANGE.max}
          step={TEXT_SIZE_RANGE.step}
          format={(v) => String(Math.round(v * 10) / 10)}
          linkTarget={"markerTextSize" as P}
          trailingAction={<AutoFitButton all resolve={(ctx) => ctx.fitAll()} onApply={(markerTextSize) => onChange({ markerTextSize })} />}
        />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  group: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  manageLinksButton: { flex: 1 },
  infoButton: {
    flex: "none",
    padding: "0 10px",
    fontSize: typography.icon.fontSize,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  infoText: { ...muted(typography.body) },
};
