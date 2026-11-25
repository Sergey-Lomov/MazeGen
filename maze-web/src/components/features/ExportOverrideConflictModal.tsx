import React from "react";
import { Modal } from "../Modal";
import { useMazeStore } from "../../store/mazeStore";
import { exportOverrideConflicts, linkTargetOfFlag } from "../../store/exportZoneOverrides";
import { VECTOR_BY_CORRIDORS_PARAM_REGISTRY, VECTOR_BY_WALLS_PARAM_REGISTRY } from "../../store/parameterLinksRegistry";
import { useOverrideTargets } from "../ZoneOverridesSection";
import { typography, spacing, muted } from "../../styles/theme";
import * as m from "~/paraglide/messages";

type Registry = Record<string, { label: string; group: string[] }>;
const REGISTRIES: Record<string, Registry> = {
  walls: VECTOR_BY_WALLS_PARAM_REGISTRY as unknown as Registry,
  corridors: VECTOR_BY_CORRIDORS_PARAM_REGISTRY as unknown as Registry,
};

/** Full address of a parameter as the settings panel nests it ("Group / Subgroup / Label"); an unregistered path is shown as is. */
export function addressOf(mode: string, path: string): string {
  const linked = linkTargetOfFlag(path);
  if (linked !== null) return m["image_export.zone_overrides.link_state_of"]({ param: addressOf(mode, linked) });
  const descriptor = REGISTRIES[mode]?.[path];
  return descriptor ? [...descriptor.group, descriptor.label].join(" / ") : path;
}

/** Explains the "zones with different export values overlap" warning (GitHub issue #1040): which parameters collide, by
 *  their full address, and which zones or groups set them. */
export function ExportOverrideConflictModal({ onClose }: { onClose: () => void }) {
  const overrides = useMazeStore((s) => s.exportZoneOverrides);
  const zones = useMazeStore((s) => s.zones);
  const groups = useMazeStore((s) => s.zoneGroups);
  const { targets } = useOverrideTargets();
  const conflicts = exportOverrideConflicts(overrides, zones, groups);
  const rows = new Map<string, { address: string; holders: Set<string> }>();
  for (const [id, list] of conflicts) {
    const override = overrides.find((o) => o.id === id);
    if (!override) continue;
    const names = targets(override).map((t) => t.label);
    for (const path of new Set(list.flatMap((c) => c.params))) {
      const key = `${override.mode}:${path}`;
      const row = rows.get(key) ?? { address: addressOf(override.mode, path), holders: new Set<string>() };
      names.forEach((name) => row.holders.add(name));
      rows.set(key, row);
    }
  }
  return (
    <Modal title={m["image_export.zone_overrides.conflict_info_title"]()} onClose={onClose}>
      <div style={styles.body}>
        <div style={styles.text}>{m["image_export.zone_overrides.conflict_info_text"]()}</div>
        <div style={styles.text}>{m["image_export.zone_overrides.conflict_info_params"]()}</div>
        <ul style={styles.list}>
          {[...rows.entries()].map(([key, row]) => (
            <li key={key} style={styles.text}>
              {row.address}
              <div style={styles.holders}>{m["image_export.zone_overrides.conflict_info_zones"]()} {[...row.holders].join(", ")}</div>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: { display: "flex", flexDirection: "column", gap: spacing.sectionGap },
  text: { ...typography.body },
  holders: { ...muted(typography.body) },
  list: { margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: spacing.elementsGap },
};
