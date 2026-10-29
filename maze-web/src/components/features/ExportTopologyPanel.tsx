import React, { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { floorTopologyInfo } from "../../store/topologyInfo";
import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
import { SidePanel } from "../SidePanel";
import { Stack } from "../Layout";
import { GlueCell, glueDotColors } from "./GlueCell";
import { TopologyProblemBubble } from "./TopologyProblemBubble";
import { floorGroupCuts } from "../../pixi/imageExport/exportContent";
import { type CutMode, type CutUnavailableReason, type GroupCutAvailability } from "../../pixi/imageExport/cutLines";
import { typography, muted, disabled, spacing, ui } from "../../styles/theme";
import * as m from "~/paraglide/messages";

const MODE_OPTIONS: { value: CutMode; label: () => string }[] = [
  { value: "none", label: () => m["image_export.cuts.mode_none"]() },
  { value: "auto", label: () => m["image_export.cuts.mode_auto"]() },
  { value: "manual", label: () => m["image_export.cuts.mode_manual"]() },
];

const UNAVAILABLE_MESSAGE: Record<CutUnavailableReason, () => string> = {
  no_seams: () => m["image_export.cuts.unavailable.no_seams"](),
  topological_only: () => m["image_export.cuts.unavailable.topological_only"](),
  not_translation: () => m["image_export.cuts.unavailable.not_translation"](),
  inconsistent: () => m["image_export.cuts.unavailable.inconsistent"](),
  parallel: () => m["image_export.cuts.unavailable.parallel"](),
};

/** The cut line of one glue: none / auto / manual, the reason a glue cannot be cut, and the position
 * slider of a manual line (GitHub issue #859). */
export function CutLineEditor({ floorId, cut }: { floorId: string; cut: GroupCutAvailability }) {
  const setting = useMazeStore((s) => s.pngExportSettings.cuts.lines[floorId]?.[cut.group]);
  const setCutLine = useMazeStore((s) => s.setCutLine);
  const mode: CutMode = cut.ok ? (setting?.mode ?? "none") : "none";
  return (
    <Stack gap="elementsGap">
      <SelectRow<CutMode>
        label={m["image_export.cuts.line"]()}
        value={mode}
        options={MODE_OPTIONS.map((option) => ({ value: option.value, label: option.label() }))}
        disabled={!cut.ok}
        onChange={(next) => setCutLine(floorId, cut.group, next === "none" ? null : { mode: next, offset: setting?.offset ?? 0 })}
      />
      {!cut.ok && <span style={styles.reason}>{UNAVAILABLE_MESSAGE[cut.reason]()}</span>}
      {cut.ok && mode === "manual" && (
        <SliderRow
          label={m["image_export.cuts.position"]()}
          value={Math.min(Math.max(setting?.offset ?? 0, cut.minOffset), cut.maxOffset)}
          onChange={(offset) => setCutLine(floorId, cut.group, { mode: "manual", offset })}
          min={cut.minOffset}
          max={cut.maxOffset}
          step={(cut.maxOffset - cut.minOffset) / 200 || 0.01}
          format={(v) => `${Math.round(v * 100)}%`}
        />
      )}
    </Stack>
  );
}

/** Topology of the active floor for export (GitHub issue #859): the field editor's glue cards with
 * their editing disabled, each with its cut line. While it is open the canvas shows the glues and the
 * cut lines (`ImageExportRenderer`'s seam layer, `CutLinesOverlay`, `CutLineDragController`), and
 * hovering a card highlights its glue and cut line. */
export function ExportTopologyPanel() {
  const floorId = useMazeStore((s) => s.activeFloorId);
  const cfg = useMazeStore((s) => s.activeFieldConfig);
  const fieldConfig = useMazeStore((s) => s.floorFields[s.activeFloorId]?.fieldConfig);
  const topology = useMazeStore((s) => s.floorTopology[s.activeFloorId] ?? null);
  const result = useMazeStore((s) => floorTopologyInfo(s, s.activeFloorId));
  const setHover = useMazeStore((s) => s.setTopologyHover);
  const setOpen = useMazeStore((s) => s.setExportTopologyOpen);
  const availability = useMemo(() => floorGroupCuts({ cfg, topology }), [cfg, topology]);

  function close() {
    setHover(null);
    setOpen(false);
  }

  if (!result.ok) {
    return (
      <SidePanel title={m["topology.title"]()} stackKey="image-export-topology" onClose={close}>
        <Stack gap="groupGap" style={styles.panelBody}>
          <TopologyProblemBubble problem={{ code: "internal", message: result.error }} cfg={fieldConfig} />
        </Stack>
      </SidePanel>
    );
  }
  const glues = topology?.groups ?? [];
  const dotColors = glueDotColors(fieldConfig, topology);

  return (
    <SidePanel title={m["topology.title"]()} stackKey="image-export-topology" onClose={close}>
      <Stack gap="groupGap" style={styles.panelBody}>
        <span style={styles.hint}>{m["image_export.cuts.hint"]()}</span>
      </Stack>
      <div style={styles.list}>
        {glues.length === 0 && <div style={styles.empty}>{m["topology.no_glues"]()}</div>}
        {glues.map((glue) => {
          const cut = availability.find((entry) => entry.group === glue.id);
          return (
            <GlueCell
              key={glue.id}
              glue={glue}
              topology={topology!}
              info={result.info}
              fieldConfig={fieldConfig}
              dotColor={dotColors.get(glue.id) ?? null}
              setHover={setHover}
              editing={{ canEdit: false, disabledReason: m["image_export.cuts.edit_unavailable"](), onEdit: noop, onDelete: noop }}
            >
              {cut && <CutLineEditor floorId={floorId} cut={cut} />}
            </GlueCell>
          );
        })}
      </div>
    </SidePanel>
  );
}

const noop = (): void => {};

const styles: Record<string, React.CSSProperties> = {
  panelBody: { padding: spacing.groupGap },
  hint: { ...muted(typography.body) },
  reason: { ...typography.caption, opacity: 0.7 },
  list: { display: "flex", flexDirection: "column", borderTop: `1px solid ${ui.border.default}` },
  empty: { ...disabled(typography.body), textAlign: "center", padding: `${spacing.itemGap}px ${spacing.groupGap}px` },
};
