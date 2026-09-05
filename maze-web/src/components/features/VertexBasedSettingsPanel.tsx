import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { SidePanel } from "../SidePanel";
import { CategoryInfoModal } from "../CategoryInfoModal";
import { InfoIconButton } from "../InfoIconButton";
import { SplitSettingsDialog } from "../dialogs/SplitSettingsDialog";
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

/** Full parameter set for `custom_vertex_based` (GitHub issue #351) — moved out of the
 *  `GenerationFeature` feature card into a `SidePanel` (same shape as post-edit/preset/image-export
 *  settings panels), opened via the gear icon next to the algorithm row. Grouped into five
 *  categories, each with its own info modal listing every parameter's full description. */
export function VertexBasedSettingsPanel({ onClose }: Props) {
  const initialConfig = useMazeStore((s) => s.initialConfig);
  const elementsConfig = useMazeStore((s) => s.elementsConfig);
  const multiFloor = useMazeStore((s) => s.floors.length > 1);

  const setGenerationParam = useMazeStore((s) => s.setGenerationParam);
  const setElementsParam = useMazeStore((s) => s.setElementsParam);
  const setElementsBoolParam = useMazeStore((s) => s.setElementsBoolParam);

  const [openInfoCategory, setOpenInfoCategory] = useState<Category | null>(null);
  const [splitSettingsDialogOpen, setSplitSettingsDialogOpen] = useState(false);

  const vertexParams = initialConfig as { method: string } & GenerationParams;

  return (
    <SidePanel title={m["generation.vertex_settings_title"]()} onClose={onClose}>
    <div style={styles.panelBody}>
      {/* Growth */}
      <div style={styles.category}>
        <div style={styles.categoryHeader}>
          <span style={styles.categoryLabel}>{m["generation.category.growth"]()}</span>
          <InfoIconButton onClick={() => setOpenInfoCategory("growth")} />
        </div>
        <div style={styles.categoryBody}>
          <SliderRow label={m["generation.depth_first"]()} value={vertexParams.depth_first ?? 0.9} onChange={(v) => setGenerationParam("depth_first", v)} />
          <SliderRow label={m["generation.corridor_chance"]()} value={vertexParams.corridor_chance ?? 0.7} onChange={(v) => setGenerationParam("corridor_chance", v)} />
          <SliderRow label={m["generation.branching"]()} value={vertexParams.branching ?? 0.5} onChange={(v) => setGenerationParam("branching", v)} />
          <SliderRow label={m["generation.directionality"]()} value={vertexParams.directionality ?? 0.0} onChange={(v) => setGenerationParam("directionality", v)} />
          <SliderRow label={m["generation.cyclicity"]()} value={vertexParams.cyclicity ?? 0.0} onChange={(v) => setGenerationParam("cyclicity", v)} />
        </div>
      </div>

      {/* One-way */}
      <div style={styles.category}>
        <div style={styles.categoryHeader}>
          <span style={styles.categoryLabel}>{m["generation.category.one_way"]()}</span>
          <InfoIconButton onClick={() => setOpenInfoCategory("one_way")} />
        </div>
        <div style={styles.categoryBody}>
          <SliderRow label={m["generation.one_way_chance_short"]()} value={elementsConfig.one_way_chance ?? 0.0} onChange={(v) => setElementsParam("one_way_chance", v)} />
        </div>
      </div>

      {/* Teleport */}
      <div style={styles.category}>
        <div style={styles.categoryHeader}>
          <span style={styles.categoryLabel}>{m["generation.category.teleport"]()}</span>
          <InfoIconButton onClick={() => setOpenInfoCategory("teleport")} />
        </div>
        <div style={styles.categoryBody}>
          <SliderRow label={m["generation.teleport_chance_short"]()} value={elementsConfig.teleport_chance ?? 0.0} onChange={(v) => setElementsParam("teleport_chance", v)} />
          <SliderRow label={m["generation.teleport_one_way_chance_short"]()} value={elementsConfig.teleport_one_way_chance ?? 0.0} onChange={(v) => setElementsParam("teleport_one_way_chance", v)} />
          {multiFloor && (
            <SliderRow label={m["generation.cross_floor_teleport_balance_short"]()} value={elementsConfig.cross_floor_teleport_balance ?? 0.0} onChange={(v) => setElementsParam("cross_floor_teleport_balance", v)} />
          )}
        </div>
      </div>

      {/* Split */}
      <div style={styles.category}>
        <div style={styles.categoryHeader}>
          <span style={styles.categoryLabel}>{m["generation.category.split"]()}</span>
          <InfoIconButton onClick={() => setOpenInfoCategory("split")} />
        </div>
        <div style={styles.categoryBody}>
          <SliderRow label={m["generation.split_chance_short"]()} value={elementsConfig.split_chance ?? 0.0} onChange={(v) => setElementsParam("split_chance", v)} />
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
          <div style={styles.categoryHeader}>
            <span style={styles.categoryLabel}>{m["generation.category.vertical"]()}</span>
            <InfoIconButton onClick={() => setOpenInfoCategory("vertical")} />
          </div>
          <div style={styles.categoryBody}>
            <SliderRow label={m["generation.vertical_chance_short"]()} value={elementsConfig.vertical_chance ?? 0.0} onChange={(v) => setElementsParam("vertical_chance", v)} />
            <SliderRow label={m["generation.vertical_passage_elevator_balance_short"]()} value={elementsConfig.vertical_passage_elevator_balance ?? 0.5} onChange={(v) => setElementsParam("vertical_passage_elevator_balance", v)} />
            <SliderRow label={m["generation.one_way_vertical_passage_chance_short"]()} value={elementsConfig.one_way_vertical_passage_chance ?? 0.0} onChange={(v) => setElementsParam("one_way_vertical_passage_chance", v)} />
            <SliderRow label={m["generation.vertical_up_down_balance_short"]()} value={elementsConfig.vertical_up_down_balance ?? 0.5} onChange={(v) => setElementsParam("vertical_up_down_balance", v)} />
            <ElevatorSpanRow min={elementsConfig.elevator_span_min ?? 2} max={elementsConfig.elevator_span_max ?? 2} onMinChange={(v) => setElementsParam("elevator_span_min", v)} onMaxChange={(v) => setElementsParam("elevator_span_max", v)} />
            <SliderRow label={m["generation.elevator_branching_short"]()} value={elementsConfig.elevator_branching ?? 0.5} onChange={(v) => setElementsParam("elevator_branching", v)} />
            <ToggleRow label={m["generation.allow_non_consecutive_elevator_floors_short"]()} checked={elementsConfig.allow_non_consecutive_elevator_floors ?? false} onChange={(v) => setElementsBoolParam("allow_non_consecutive_elevator_floors", v)} />
          </div>
        </div>
      )}

      {splitSettingsDialogOpen && (
        <SplitSettingsDialog onClose={() => setSplitSettingsDialogOpen(false)} />
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
