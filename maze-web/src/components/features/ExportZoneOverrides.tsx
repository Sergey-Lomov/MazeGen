import React, { useMemo, useState } from "react";
import { Shapes, Trash2 } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import type { ExportOverrideMode, ExportOverrideValue, ZoneOverrideTarget } from "../../store/zonesTypes";
import type { ParamLink } from "../../store/parameterLinks";
import { Bubble } from "../Bubble";
import { Button } from "../Button";
import { ConfirmModal } from "../ConfirmModal";
import { FlatIconButton } from "../FlatIconButton";
import { useOverrideTargets } from "../ZoneOverridesSection";
import { InfoIconButton } from "../InfoIconButton";
import { Modal } from "../Modal";
import { ZoneTargetPanel } from "./ZoneTargetPanel";
import type { ZoneRowContext } from "./LinkContext";
import { activeExportContext, settingsInContext, zoneLinkToggleChanges } from "../../store/exportZoneContext";
import { exportModeSupportsZones, exportOverrideOf, isExportOverridable, linkEnabledPath } from "../../store/exportZoneOverrides";
import { overrideHasNoZones } from "../../domain/zoneOverrides";
import { getParamValue } from "../../store/slices/parameterLinksEngine";
import { GLOBAL_CONTEXT_COLORS, type OtherContextEntry, type OtherContextOverrides } from "./OtherContextOverrides";
import { typography, spacing, muted, ui, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";

/** The zone context of the export settings panel (GitHub issue #1040): while a zone or group is chosen, the panel shows
 *  that zone's settings and every edit sets the zone's own value instead of the global one. */

/** The walls settings the panel shows: the global ones, or the chosen zone's on top of them. */
export function useEffectiveWallsSettings() {
  const settings = useMazeStore((s) => s.vectorByWallsSettings);
  const target = useMazeStore((s) => activeExportContext(s));
  const overrides = useMazeStore((s) => s.exportZoneOverrides);
  return useMemo(() => (target === null ? settings : settingsInContext(settings, overrides, target, "walls")), [settings, target, overrides]);
}

/** The corridors settings the panel shows: the global ones, or the chosen zone's on top of them. */
export function useEffectiveCorridorsSettings() {
  const settings = useMazeStore((s) => s.vectorByCorridorsSettings);
  const target = useMazeStore((s) => activeExportContext(s));
  const overrides = useMazeStore((s) => s.exportZoneOverrides);
  return useMemo(() => (target === null ? settings : settingsInContext(settings, overrides, target, "corridors")), [settings, target, overrides]);
}

/** What the rows of `mode`'s panel need to work in the zone context, or `null` while the panel edits the global settings. */
export function useZoneRowContext(mode: ExportOverrideMode, links: readonly ParamLink[]): ZoneRowContext | null {
  const target = useMazeStore((s) => (exportModeSupportsZones(mode) ? activeExportContext(s) : null));
  const overrides = useMazeStore((s) => s.exportZoneOverrides);
  const setParams = useMazeStore((s) => s.setExportZoneParams);
  return useMemo(() => {
    if (target === null) return null;
    const override = exportOverrideOf(overrides, mode, target);
    return {
      overridden: new Set(Object.keys(override?.params ?? {})),
      canOverride: (path) => isExportOverridable(mode, path, links),
      reset: (path) => setParams(mode, target, { [path]: null }),
      toggleLink: (path, enabled) => setParams(mode, target, zoneLinkToggleChanges(useMazeStore.getState(), path, enabled, mode)),
    };
  }, [mode, target, overrides, links, setParams]);
}

/** What the rows of `mode`'s panel need to show the overrides of the other contexts under a parameter (GitHub issue #1040): while
 *  editing the whole maze, the zones that set the parameter; inside a zone, the other zones and the whole maze. `null` while the
 *  display is off or the panel has no zone contexts. */
export function useOtherContextOverrides(mode: ExportOverrideMode): OtherContextOverrides | null {
  const display = useMazeStore((s) => s.zoneOverrideDisplay);
  const supported = useMazeStore((s) => s.showZoneOverrideButtons) && exportModeSupportsZones(mode);
  const target = useMazeStore((s) => activeExportContext(s));
  const overrides = useMazeStore((s) => s.exportZoneOverrides);
  const settings = useMazeStore((s) => (mode === "walls" ? s.vectorByWallsSettings : s.vectorByCorridorsSettings));
  const zones = useMazeStore((s) => s.zones);
  const groups = useMazeStore((s) => s.zoneGroups);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  return useMemo(() => {
    if (!supported || display === "none") return null;
    const current = target === null ? undefined : exportOverrideOf(overrides, mode, target);
    const entriesOf = (path: string): OtherContextEntry[] => {
      const flag = linkEnabledPath(path);
      const holders = overrides.filter((o) => o.mode === mode && (o.params[path] !== undefined || o.params[flag] !== undefined) && !overrideHasNoZones(o, zones, groups));
      if (holders.length === 0) return [];
      const others = holders.filter((o) => o.id !== current?.id).map((o): OtherContextEntry => {
        const link = o.params[flag];
        return { key: `o${o.id}`, global: false, zoneIds: o.zoneIds, groupIds: o.groupIds, value: toValue(o.params[path]), linkEnabled: typeof link === "boolean" ? link : undefined };
      });
      if (target === null) return others;
      const value = getParamValue(settings, path);
      const globalLink = settings.links.find((link) => link.target === path);
      const global: OtherContextEntry = {
        key: "global", global: true, zoneIds: [], groupIds: [],
        value: toValue(value),
        linkEnabled: holders.some((o) => typeof o.params[flag] === "boolean") ? globalLink?.enabled : undefined,
      };
      return [global, ...others];
    };
    const toggle = (path: string) => setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
    return { mode: display, entriesOf, open, toggle };
  }, [supported, display, target, overrides, settings, zones, groups, mode, open]);
}

const toValue = (v: unknown): ExportOverrideValue | undefined => (typeof v === "number" || typeof v === "boolean" || typeof v === "string" ? v : undefined);

/** The bar on top of the panel that picks the zone context: the whole maze, or one zone or group. */
export function ExportZoneContextBar({ mode }: { mode: ExportOverrideMode }) {
  const show = useMazeStore((s) => s.showZoneOverrideButtons);
  const target = useMazeStore((s) => s.exportOverrideContext);
  const setContext = useMazeStore((s) => s.setExportOverrideContext);
  const overrides = useMazeStore((s) => s.exportZoneOverrides);
  const removeOverride = useMazeStore((s) => s.removeExportZoneOverride);
  const { targets, hover } = useOverrideTargets();
  const [picking, setPicking] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  if (!show || !exportModeSupportsZones(mode)) return null;

  const override = target === null ? undefined : exportOverrideOf(overrides, mode, target);
  const chosen = target === null ? [] : targets({ zoneIds: target.kind === "zone" ? [target.id] : [], groupIds: target.kind === "group" ? [target.id] : [] });
  const pick = (picked: ZoneOverrideTarget | null) => {
    setContext(picked);
    setPicking(false);
  };

  return (
    <div style={styles.bar}>
      <span style={styles.label}>{m["image_export.zone_context.label"]()}</span>
      <div style={styles.targets}>
        {chosen.length === 0 && (
          <Bubble data-testid="export-zone-context-target" colors={GLOBAL_CONTEXT_COLORS} interactive title={m["image_export.zone_context.choose"]()} onClick={() => setPicking(true)}>
            {m["image_export.zone_context.global_current"]()}
          </Bubble>
        )}
        {chosen.map((t) => (
          <Bubble
            key={t.key}
            data-testid="export-zone-context-target"
            colors={t.colors}
            interactive
            title={m["image_export.zone_context.choose"]()}
            onMouseEnter={() => hover(t.target)}
            onMouseLeave={() => hover(null)}
            onClick={() => setPicking(true)}
          >
            {t.label}
          </Bubble>
        ))}
      </div>
      <InfoIconButton onClick={() => setInfoOpen(true)} />
      {override && (
        <FlatIconButton title={m["image_export.zone_context.delete_all_params"]()} onClick={() => setConfirmingDelete(true)}>
          <Trash2 size={16} />
        </FlatIconButton>
      )}
      <FlatIconButton title={m["image_export.zone_context.choose"]()} onClick={() => setPicking(true)}>
        <Shapes size={16} />
      </FlatIconButton>
      {infoOpen && (
        <Modal title={m["image_export.zone_context.info_title"]()} onClose={() => setInfoOpen(false)}>
          <div style={styles.infoText}>{m["image_export.zone_context.info_what"]()}</div>
          <div style={styles.infoText}>{m["image_export.zone_context.info_how"]()}</div>
          <div style={styles.infoText}>{m["image_export.zone_context.info_rules"]()}</div>
        </Modal>
      )}
      {confirmingDelete && override && (
        <ConfirmModal
          message={m["image_export.zone_context.delete_all_confirm"]()}
          onConfirm={() => { removeOverride(override.id); setConfirmingDelete(false); }}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
      {picking && (
        <ZoneTargetPanel
          title={m["image_export.zone_context.choose"]()}
          stackKey="export-zone-context"
          onPick={pick}
          onClose={() => setPicking(false)}
          footer={
            <Button variant="secondary" layoutStyle={{ width: "100%" }} onClick={() => { hover(null); pick(null); }}>
              {m["image_export.zone_context.leave"]()}
            </Button>
          }
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // Pinned above the scrolling settings, so the context being edited is always in view. It spans the panel's full width and
  // carries the panel's own inset as padding (pulled back by the margin), so it looks the same pinned as at the top.
  bar: { position: "sticky", top: 0, zIndex: 5, background: ui.bg.panel, display: "flex", alignItems: "center", gap: spacing.itemGap, flexWrap: "wrap", margin: `${-inset.panelInsetY}px ${-inset.panelInsetX}px 0`, padding: `${inset.panelInsetY}px ${inset.panelInsetX}px ${spacing.itemGap}px`, borderBottom: `1px solid ${ui.border.default}` },
  // A line as tall as a bubble (14px text plus its border), so the label and the bubbles centre on one line.
  label: { ...muted(typography.body), lineHeight: "16px" },
  infoText: { ...typography.body, marginBottom: spacing.itemGap },
  targets: { flex: 1, minWidth: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: spacing.itemGap },
};
