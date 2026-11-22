import React, { useMemo, useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { activeFloorTessellationOf } from "../../store/storeHelpers";
import { configAllCells } from "../../domain/tessellationCells";
import { getTessellationCellTypes } from "../../wasm/mazeService";
import { SidePanel } from "../SidePanel";
import { CategoryInfoModal } from "../CategoryInfoModal";
import { LabelWithInfo } from "../LabelWithInfo";
import { SplitSettingsDialog } from "../dialogs/SplitSettingsDialog";
import { ZoneOverrideControls, ZoneOverridesSection } from "../ZoneOverridesSection";
import type { ZoneOverridePickRequest } from "../ZoneOverridesSection";
import { ZoneOverrideTargetPanel } from "./ZoneOverrideTargetPanel";
import type { ZoneOverrideParamKey, ZoneOverrideTarget } from "../../store/zonesTypes";
import { ElementPlacementSettingsDialog } from "../dialogs/ElementPlacementSettingsDialog";
import { ToggleRow } from "../ToggleRow";
import { ElevatorSpanRow } from "../ElevatorSpanRow";
import { SliderRow } from "../SliderRow";
import { Inline } from "../Layout";
import { Button } from "../Button";
import { ui, radius, typography, muted, spacing, inset, indent, controlRowHeight } from "../../styles/theme";
import type { GenerationParams } from "../../wasm/types";
import * as m from "~/paraglide/messages";

type Category = "growth" | "one_way" | "teleport" | "split" | "vertical";

interface Props {
  onClose: () => void;
}

/** UI-only percentage adapter: custom vertex-based settings remain stored as 0..1 probabilities. */
function ChanceSliderRow(props: React.ComponentProps<typeof SliderRow>) {
  return <SliderRow {...props} percent />;
}

/** Full parameter set for `custom_vertex_based` (GitHub issue #351) — moved out of the
 *  `GenerationFeature` feature card into a `SidePanel` (same shape as post-edit/preset/image-export
 *  settings panels), opened via the gear icon next to the algorithm row. Grouped into five
 *  categories, each with its own info modal listing every parameter's full description. */
export function VertexBasedSettingsPanel({ onClose }: Props) {
  const initialConfig = useMazeStore((s) => s.initialConfig);
  const elementsConfig = useMazeStore((s) => s.elementsConfig);
  const multiFloor = useMazeStore((s) => s.floors.length > 1);
  const fieldConfig = useMazeStore((s) => activeFloorTessellationOf(s));
  const smoothPrimitives = useMazeStore((s) => s.smoothPrimitives);

  const setGenerationParam = useMazeStore((s) => s.setGenerationParam);
  const setElementsParam = useMazeStore((s) => s.setElementsParam);
  const setElementsBoolParam = useMazeStore((s) => s.setElementsBoolParam);

  const [openInfoCategory, setOpenInfoCategory] = useState<Category | null>(null);
  const [splitSettingsDialogOpen, setSplitSettingsDialogOpen] = useState(false);
  const [elementPlacementDialogOpen, setElementPlacementDialogOpen] = useState(false);
  const [pickRequest, setPickRequest] = useState<ZoneOverridePickRequest | null>(null);
  const addZoneOverride = useMazeStore((s) => s.addZoneOverride);
  const setZoneOverrideTarget = useMazeStore((s) => s.setZoneOverrideTarget);

  // Cell-type keys are supplied by the active core tessellation, not inferred from web geometry.
  // This also lets new tessellations expose placement controls without a UI-side key registry.
  const cellTypes = useMemo(() => {
    try {
      return getTessellationCellTypes({
        tessellation: fieldConfig.tessellation,
        points: configAllCells(fieldConfig, smoothPrimitives),
      }).keys;
    } catch {
      // The settings panel can mount while WASM is still loading; hide the optional menu until
      // its authoritative type list is available rather than showing an incomplete matrix.
      return [];
    }
  }, [fieldConfig, smoothPrimitives]);

  const vertexParams = initialConfig as { method: string } & GenerationParams;
  // Zone overrides (GitHub issue #1038): a "+" ends a parameter's row, its overrides are listed right under it.
  const [expandedOverrides, setExpandedOverrides] = useState<ReadonlySet<string>>(new Set());
  const toggleOverrides = (key: string) => setExpandedOverrides((prev) => { const next = new Set(prev); if (!next.delete(key)) next.add(key); return next; });
  const addButton = (key: ZoneOverrideParamKey, value: number) => <ZoneOverrideControls paramKeys={[key]} globalValues={[value]} expanded={expandedOverrides.has(key)} onToggle={() => toggleOverrides(key)} onRequest={setPickRequest} />;
  const overrides = (key: ZoneOverrideParamKey) => <ZoneOverridesSection paramKeys={[key]} expanded={expandedOverrides.has(key)} onRequest={setPickRequest} />;
  const pickTarget = (target: ZoneOverrideTarget) => {
    if (pickRequest?.overrideId !== undefined) setZoneOverrideTarget(pickRequest.overrideId, target);
    else if (pickRequest) addZoneOverride(pickRequest.params, target);
    setPickRequest(null);
  };

  return (
    <SidePanel title={m["generation.vertex_settings_title"]()} stackKey="vertex-based-settings" onClose={onClose}>
    <div style={styles.panelBody}>
      {cellTypes.length > 1 && (
        <Inline gap="groupGap" style={styles.placementRow}>
          <span style={styles.paramLabel}>{m["generation.element_placement"]()}</span>
          <Button variant="secondary" layoutStyle={styles.paramButton} onClick={() => setElementPlacementDialogOpen(true)}>
            {m["generation.element_placement_settings"]()}
          </Button>
        </Inline>
      )}
      {/* Growth */}
      <div style={styles.category}>
        <LabelWithInfo as="div" style={styles.categoryHeader} labelStyle={styles.categoryLabel} onInfo={() => setOpenInfoCategory("growth")}>
          {m["generation.category.growth"]()}
        </LabelWithInfo>
        <div style={styles.categoryBody}>
          <ChanceSliderRow label={m["generation.depth_first"]()} value={vertexParams.depth_first ?? 0.9} onChange={(v) => setGenerationParam("depth_first", v)} />
          <ChanceSliderRow label={m["generation.corridor_chance"]()} value={vertexParams.corridor_chance ?? 0.7} onChange={(v) => setGenerationParam("corridor_chance", v)} resetButton={addButton("corridor_chance", vertexParams.corridor_chance ?? 0.7)} />
          {overrides("corridor_chance")}
          <ChanceSliderRow label={m["generation.branching"]()} value={vertexParams.branching ?? 0.5} onChange={(v) => setGenerationParam("branching", v)} resetButton={addButton("branching", vertexParams.branching ?? 0.5)} />
          {overrides("branching")}
          <ChanceSliderRow label={m["generation.directionality"]()} value={vertexParams.directionality ?? 0.0} onChange={(v) => setGenerationParam("directionality", v)} resetButton={addButton("directionality", vertexParams.directionality ?? 0.0)} />
          {overrides("directionality")}
          <ChanceSliderRow label={m["generation.cyclicity"]()} value={vertexParams.cyclicity ?? 0.0} onChange={(v) => setGenerationParam("cyclicity", v)} resetButton={addButton("cyclicity", vertexParams.cyclicity ?? 0.0)} />
          {overrides("cyclicity")}
        </div>
      </div>

      {/* One-way */}
      <div style={styles.category}>
        <LabelWithInfo as="div" style={styles.categoryHeader} labelStyle={styles.categoryLabel} onInfo={() => setOpenInfoCategory("one_way")}>
          {m["generation.category.one_way"]()}
        </LabelWithInfo>
        <div style={styles.categoryBody}>
          <ChanceSliderRow preciseAriaLabel={`${m["generation.category.one_way"]()} ${m["generation.one_way_chance_short"]()}`} label={m["generation.one_way_chance_short"]()} value={elementsConfig.one_way_chance ?? 0.0} onChange={(v) => setElementsParam("one_way_chance", v)} resetButton={addButton("one_way_chance", elementsConfig.one_way_chance ?? 0.0)} />
          {overrides("one_way_chance")}
        </div>
      </div>

      {/* Teleport */}
      <div style={styles.category}>
        <LabelWithInfo as="div" style={styles.categoryHeader} labelStyle={styles.categoryLabel} onInfo={() => setOpenInfoCategory("teleport")}>
          {m["generation.category.teleport"]()}
        </LabelWithInfo>
        <div style={styles.categoryBody}>
          <ChanceSliderRow preciseAriaLabel={`${m["generation.category.teleport"]()} ${m["generation.teleport_chance_short"]()}`} label={m["generation.teleport_chance_short"]()} value={elementsConfig.teleport_chance ?? 0.0} onChange={(v) => setElementsParam("teleport_chance", v)} resetButton={addButton("teleport_chance", elementsConfig.teleport_chance ?? 0.0)} />
          {overrides("teleport_chance")}
          <ChanceSliderRow preciseAriaLabel={`${m["generation.category.teleport"]()} ${m["generation.teleport_one_way_chance_short"]()}`} label={m["generation.teleport_one_way_chance_short"]()} value={elementsConfig.teleport_one_way_chance ?? 0.0} onChange={(v) => setElementsParam("teleport_one_way_chance", v)} resetButton={addButton("teleport_one_way_chance", elementsConfig.teleport_one_way_chance ?? 0.0)} />
          {overrides("teleport_one_way_chance")}
          {multiFloor && (
            <>
              <ChanceSliderRow preciseAriaLabel={`${m["generation.category.teleport"]()} ${m["generation.cross_floor_teleport_balance_short"]()}`} label={m["generation.cross_floor_teleport_balance_short"]()} value={elementsConfig.cross_floor_teleport_balance ?? 0.0} onChange={(v) => setElementsParam("cross_floor_teleport_balance", v)} resetButton={addButton("cross_floor_teleport_balance", elementsConfig.cross_floor_teleport_balance ?? 0.0)} />
              {overrides("cross_floor_teleport_balance")}
            </>
          )}
        </div>
      </div>

      {/* Split */}
      <div style={styles.category}>
        <LabelWithInfo as="div" style={styles.categoryHeader} labelStyle={styles.categoryLabel} onInfo={() => setOpenInfoCategory("split")}>
          {m["generation.category.split"]()}
        </LabelWithInfo>
        <div style={styles.categoryBody}>
          <ChanceSliderRow preciseAriaLabel={`${m["generation.category.split"]()} ${m["generation.split_chance_short"]()}`} label={m["generation.split_chance_short"]()} value={elementsConfig.split_chance ?? 0.0} onChange={(v) => setElementsParam("split_chance", v)} resetButton={addButton("split_chance", elementsConfig.split_chance ?? 0.0)} />
          {overrides("split_chance")}
          <Inline gap="groupGap" style={styles.paramRow}>
            <span style={styles.paramLabel}>{m["generation.split_config"]()}</span>
            <Button variant="secondary" layoutStyle={styles.paramButton} onClick={() => setSplitSettingsDialogOpen(true)}>
              {m["generation.split_settings"]()}
            </Button>
          </Inline>
        </div>
      </div>

      {/* Vertical */}
      {multiFloor && (
        <div style={styles.category}>
          <LabelWithInfo as="div" style={styles.categoryHeader} labelStyle={styles.categoryLabel} onInfo={() => setOpenInfoCategory("vertical")}>
            {m["generation.category.vertical"]()}
          </LabelWithInfo>
          <div style={styles.categoryBody}>
            <ChanceSliderRow preciseAriaLabel={`${m["generation.category.vertical"]()} ${m["generation.vertical_chance_short"]()}`} label={m["generation.vertical_chance_short"]()} value={elementsConfig.vertical_chance ?? 0.0} onChange={(v) => setElementsParam("vertical_chance", v)} resetButton={addButton("vertical_chance", elementsConfig.vertical_chance ?? 0.0)} />
            {overrides("vertical_chance")}
            <ChanceSliderRow preciseAriaLabel={`${m["generation.category.vertical"]()} ${m["generation.vertical_passage_elevator_balance_short"]()}`} label={m["generation.vertical_passage_elevator_balance_short"]()} value={elementsConfig.vertical_passage_elevator_balance ?? 0.5} onChange={(v) => setElementsParam("vertical_passage_elevator_balance", v)} resetButton={addButton("vertical_passage_elevator_balance", elementsConfig.vertical_passage_elevator_balance ?? 0.5)} />
            {overrides("vertical_passage_elevator_balance")}
            <ChanceSliderRow preciseAriaLabel={`${m["generation.category.vertical"]()} ${m["generation.one_way_vertical_passage_chance_short"]()}`} label={m["generation.one_way_vertical_passage_chance_short"]()} value={elementsConfig.one_way_vertical_passage_chance ?? 0.0} onChange={(v) => setElementsParam("one_way_vertical_passage_chance", v)} resetButton={addButton("one_way_vertical_passage_chance", elementsConfig.one_way_vertical_passage_chance ?? 0.0)} />
            {overrides("one_way_vertical_passage_chance")}
            <ChanceSliderRow preciseAriaLabel={`${m["generation.category.vertical"]()} ${m["generation.vertical_up_down_balance_short"]()}`} label={m["generation.vertical_up_down_balance_short"]()} value={elementsConfig.vertical_up_down_balance ?? 0.5} onChange={(v) => setElementsParam("vertical_up_down_balance", v)} resetButton={addButton("vertical_up_down_balance", elementsConfig.vertical_up_down_balance ?? 0.5)} />
            {overrides("vertical_up_down_balance")}
            <ElevatorSpanRow min={elementsConfig.elevator_span_min ?? 2} max={elementsConfig.elevator_span_max ?? 2} onMinChange={(v) => setElementsParam("elevator_span_min", v)} onMaxChange={(v) => setElementsParam("elevator_span_max", v)} trailing={<ZoneOverrideControls paramKeys={["elevator_span_min", "elevator_span_max"]} globalValues={[elementsConfig.elevator_span_min ?? 2, elementsConfig.elevator_span_max ?? 2]} expanded={expandedOverrides.has("elevator_span_min")} onToggle={() => toggleOverrides("elevator_span_min")} onRequest={setPickRequest} />} />
            <ZoneOverridesSection paramKeys={["elevator_span_min", "elevator_span_max"]} integer expanded={expandedOverrides.has("elevator_span_min")} onRequest={setPickRequest} />
            <ChanceSliderRow preciseAriaLabel={`${m["generation.category.vertical"]()} ${m["generation.elevator_branching_short"]()}`} label={m["generation.elevator_branching_short"]()} value={elementsConfig.elevator_branching ?? 0.5} onChange={(v) => setElementsParam("elevator_branching", v)} resetButton={addButton("elevator_branching", elementsConfig.elevator_branching ?? 0.5)} />
            {overrides("elevator_branching")}
            <ToggleRow label={m["generation.allow_non_consecutive_elevator_floors_short"]()} checked={elementsConfig.allow_non_consecutive_elevator_floors ?? false} onChange={(v) => setElementsBoolParam("allow_non_consecutive_elevator_floors", v)} resetButton={addButton("allow_non_consecutive_elevator_floors", elementsConfig.allow_non_consecutive_elevator_floors ? 1 : 0)} />
            {overrides("allow_non_consecutive_elevator_floors")}
          </div>
        </div>
      )}

      {pickRequest && <ZoneOverrideTargetPanel onPick={pickTarget} onClose={() => setPickRequest(null)} />}
      {splitSettingsDialogOpen && (
        <SplitSettingsDialog onClose={() => setSplitSettingsDialogOpen(false)} />
      )}
      {elementPlacementDialogOpen && (
        <ElementPlacementSettingsDialog cellTypes={cellTypes} multiFloor={multiFloor} onClose={() => setElementPlacementDialogOpen(false)} />
      )}

      {openInfoCategory === "growth" && (
        <CategoryInfoModal
          title={m["generation.category.growth"]()}
          params={[
            { label: m["generation.depth_first"](), description: m["generation.desc.depth_first"]() },
            { label: m["generation.corridor_chance"](), description: m["generation.desc.corridor_chance"]() },
            { label: m["generation.branching"](), description: m["generation.desc.branching"]() },
            { label: m["generation.directionality"](), description: m["generation.desc.directionality"]() },
            { label: m["generation.cyclicity"](), description: m["generation.desc.cyclicity"]() },
          ]}
          onClose={() => setOpenInfoCategory(null)}
        />
      )}
      {openInfoCategory === "one_way" && (
        <CategoryInfoModal
          title={m["generation.category.one_way"]()}
          params={[{ label: m["generation.one_way_chance_short"](), description: m["generation.desc.one_way_chance"]() }]}
          onClose={() => setOpenInfoCategory(null)}
        />
      )}
      {openInfoCategory === "teleport" && (
        <CategoryInfoModal
          title={m["generation.category.teleport"]()}
          params={[
            { label: m["generation.teleport_chance_short"](), description: m["generation.desc.teleport_chance"]() },
            { label: m["generation.teleport_one_way_chance_short"](), description: m["generation.desc.teleport_one_way_chance"]() },
            ...(multiFloor ? [{ label: m["generation.cross_floor_teleport_balance_short"](), description: m["generation.desc.cross_floor_teleport_balance"]() }] : []),
          ]}
          onClose={() => setOpenInfoCategory(null)}
        />
      )}
      {openInfoCategory === "split" && (
        <CategoryInfoModal
          title={m["generation.category.split"]()}
          params={[{ label: m["generation.split_chance_short"](), description: m["generation.desc.split_chance"]() }]}
          onClose={() => setOpenInfoCategory(null)}
        />
      )}
      {openInfoCategory === "vertical" && (
        <CategoryInfoModal
          title={m["generation.category.vertical"]()}
          params={[
            { label: m["generation.vertical_chance_short"](), description: m["generation.desc.vertical_chance"]() },
            { label: m["generation.vertical_passage_elevator_balance_short"](), description: m["generation.desc.vertical_passage_elevator_balance"]() },
            { label: m["generation.one_way_vertical_passage_chance_short"](), description: m["generation.desc.one_way_vertical_passage_chance"]() },
            { label: m["generation.vertical_up_down_balance_short"](), description: m["generation.desc.vertical_up_down_balance"]() },
            { label: m["generation.elevator_span"](), description: m["generation.desc.elevator_span"]() },
            { label: m["generation.elevator_branching_short"](), description: m["generation.desc.elevator_branching"]() },
            { label: m["generation.allow_non_consecutive_elevator_floors_short"](), description: m["generation.desc.allow_non_consecutive_elevator_floors"]() },
          ]}
          onClose={() => setOpenInfoCategory(null)}
        />
      )}
    </div>
    </SidePanel>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panelBody: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.sectionGap,
    padding: `${inset.panelInsetY}px ${inset.panelInsetX}px`,
  },
  category: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap,
    paddingBottom: spacing.sectionGap,
    borderBottom: `1px solid ${ui.border.default}`,
  },
  categoryHeader: {
    display: "flex",
    alignItems: "center",
    gap: spacing.itemGap,
  },
  categoryBody: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap,
    paddingLeft: indent.tree,
  },
  categoryLabel: {
    ...muted(typography.body),
  },
  paramRow: {
    minHeight: controlRowHeight,
    boxSizing: "border-box",
  },
  placementRow: {
    minHeight: controlRowHeight,
    boxSizing: "border-box",
  },
  paramLabel: {
    flex: 1,
    ...typography.body,
  },
  paramButton: {
    boxSizing: "border-box",
    height: 22,
    padding: "0 8px",
    cursor: "default",
    borderRadius: radius.sm,
    flexShrink: 0,
  },
};
