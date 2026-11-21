import React, { useEffect } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { editedZoneOf } from "../../store/fieldEditTarget";
import { previewZoneCombine, ZONE_COMBINE_OPS, type ZoneCombineOp } from "../../domain/selectors/zoneCombine";
import { overridesWithDraft, zoneColors, zoneDisplayName, zoneFloors, zonesWithDraft } from "../../domain/selectors/zoneSelectors";
import { FIELD_EDITOR_PREVIEW_COLORS } from "../../domain/colorTokens";
import { Button } from "../Button";
import { EntityColorSwatch, cssColor } from "../EntityColorSwatch";
import { FloorBadgeRow } from "../FloorBadgeRow";
import { Inline, Stack } from "../Layout";
import { ListCell } from "../ListCell";
import { SidePanel } from "../SidePanel";
import { WarningBubble } from "../WarningBubble";
import { typography, disabled, muted, spacing, indent, ui } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import * as m from "~/paraglide/messages";

const OP_LABEL: Record<ZoneCombineOp, () => string> = {
  union: () => m["zones.combine_union"](),
  intersection: () => m["zones.combine_intersection"](),
  subtraction: () => m["zones.combine_subtraction"](),
};

/** Zone combination side panel (GitHub issue #1032): a mode switch (union, intersection, subtraction), a report of
 *  what the operation would change per floor, the list of the other zones to pick from, and "Apply". The canvas
 *  previews the change meanwhile (`ZonesRenderer`). The result goes into the edited zone's draft. */
export function ZoneCombinePanel() {
  const draft = useMazeStore((s) => editedZoneOf(s));
  const combine = useMazeStore((s) => s.zoneCombine);
  const zones = useMazeStore((s) => s.zones);
  const storedOverrides = useMazeStore((s) => s.zoneColorOverrides);
  const draftColor = useMazeStore((s) => s.zoneEditDraftColor);
  const setOp = useMazeStore((s) => s.setZoneCombineOp);
  const setOther = useMazeStore((s) => s.setZoneCombineOther);
  const apply = useMazeStore((s) => s.applyZoneCombine);
  const close = useMazeStore((s) => s.cancelZoneCombine);
  const setHover = useMazeStore((s) => s.setHoveredZone);
  const multiFloor = useMazeStore((s) => s.floors.length > 1);

  // The hover belongs to the panel: it must not outlive it.
  useEffect(() => () => setHover(null), [setHover]);

  if (!draft || !combine) return null;
  const all = zonesWithDraft(zones, draft);
  const colors = zoneColors(all, overridesWithDraft(storedOverrides, draft, draftColor));
  const candidates = zones.filter((z) => z.id !== draft.id);
  const other = candidates.find((z) => z.id === combine.otherId);
  const preview = other ? previewZoneCombine(draft, other, combine.op) : null;
  const changes = preview?.floors ?? [];
  const becomesEmpty = preview !== null && changes.length > 0 && draft.cells.length + preview.added.length - preview.removed.length === 0;


  return (
    <SidePanel title={m["zones.combine_title"]()} stackKey="zone-combine" onClose={close}>
      <div style={styles.root}>
        <div style={styles.sections}>
          <Stack gap="itemGap">
            <div style={styles.sectionHeader}>{m["zones.combine_mode"]()}</div>
            <div style={styles.content}>
              <Inline gap="itemGap">
                {ZONE_COMBINE_OPS.map((op) => (
                  <Button key={op} variant={combine.op === op ? "toggle-selected" : "toggle"} layoutStyle={{ flex: 1 }} onClick={() => setOp(op)}>
                    {OP_LABEL[op]()}
                  </Button>
                ))}
              </Inline>
            </div>
          </Stack>

          <div style={styles.zoneSection}>
            <div style={styles.sectionHeader}>{m["zones.combine_zone"]()}</div>
            <div style={styles.zoneContent}>
              <div style={styles.list} role="listbox" data-testid="zone-combine-list">
                {candidates.length === 0 && <div style={styles.empty}>{m["zones.combine_no_zones"]()}</div>}
                {candidates.map((zone) => (
                  <ListCell
                    key={zone.id}
                    data-testid="zone-combine-cell"
                    role="option"
                    aria-selected={zone.id === combine.otherId}
                    current={zone.id === combine.otherId}
                    style={styles.cell}
                    onClick={() => setOther(zone.id)}
                    onMouseEnter={() => setHover(zone.id)}
                    onMouseLeave={() => setHover(null)}
                    title={zoneDisplayName(zone)}
                    truncateTitle
                    titleAddon={<EntityColorSwatch color={cssColor(colors[all.findIndex((z) => z.id === zone.id)])} />}
                    details={
                      <>
                        <span style={styles.hint}>{m["zones.cells_info"]({ count: zone.cells.length })}</span>
                        <FloorBadgeRow levels={zoneFloors(zone)} />
                      </>
                    }
                  />
                ))}
              </div>
            </div>
          </div>

          <Stack gap="itemGap">
            <div style={styles.sectionHeader}>{m["zones.combine_result"]()}</div>
            <div style={styles.resultContent} data-testid="zone-combine-report">
              {!preview && <span style={styles.placeholder}>{m["zones.combine_pick"]()}</span>}
              {preview && changes.length === 0 && <WarningBubble message={m["zones.combine_no_change"]()} />}
              {becomesEmpty && <WarningBubble message={m["zones.combine_empty"]()} />}
              {changes.map(({ floor, added, removed, total }) => {
                const delta = added - removed;
                const color = delta >= 0 ? FIELD_EDITOR_PREVIEW_COLORS.add : FIELD_EDITOR_PREVIEW_COLORS.remove;
                return (
                  <Inline key={floor} gap="itemGap">
                    {multiFloor && <FloorBadgeRow levels={[floor]} />}
                    {multiFloor && <span style={typography.body}>:</span>}
                    <span style={{ ...typography.body, color }}>
                      {m["zones.combine_line"]({ delta: `${delta >= 0 ? "+" : "-"}${Math.abs(delta)}`, total })}
                    </span>
                  </Inline>
                );
              })}
            </div>
          </Stack>
        </div>

        <div style={styles.footer}>
          <Button variant="primary" layoutStyle={{ width: "100%" }} disabled={!other} onClick={apply}>
            {m["zones.combine_apply"]()}
          </Button>
        </div>
      </div>
    </SidePanel>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // Hugs its content (the confirm button follows the last section), and shrinks the zone list once the panel is full.
  root: { flex: "0 1 auto", minHeight: 0, display: "flex", flexDirection: "column" },
  // Everything but the footer: the zone list takes the leftover height and scrolls once the rest leaves no room.
  sections: { flex: "0 1 auto", minHeight: 0, display: "flex", flexDirection: "column", gap: spacing.groupGap, padding: spacing.groupGap },
  sectionHeader: sharedStyles.sectionHeader,
  content: { paddingLeft: indent.tree, minWidth: 0, boxSizing: "border-box", width: "100%" },
  resultContent: { paddingLeft: indent.tree, minWidth: 0, boxSizing: "border-box", width: "100%", display: "flex", flexDirection: "column", gap: spacing.itemGap },
  zoneSection: { flex: "0 1 auto", minHeight: 0, display: "flex", flexDirection: "column", gap: spacing.itemGap },
  zoneContent: { flex: "0 1 auto", minHeight: 0, display: "flex", flexDirection: "column", paddingLeft: indent.tree, boxSizing: "border-box", width: "100%" },
  list: { flex: "0 1 auto", minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", border: `1px solid ${ui.border.default}`, borderBottom: "none" },
  footer: { flexShrink: 0, padding: spacing.groupGap },
  placeholder: { ...disabled(typography.body) },
  cell: { cursor: "pointer", flexShrink: 0 },
  empty: { ...disabled(typography.body), textAlign: "center", padding: `${spacing.itemGap}px ${spacing.groupGap}px` },
  hint: { ...muted(typography.body) },
};
