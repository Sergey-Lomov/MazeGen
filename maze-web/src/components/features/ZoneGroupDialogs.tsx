import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Button } from "../Button";
import { Modal } from "../Modal";
import { sharedStyles } from "../../styles/shared";
import { dialogSpacing, disabled, spacing, typography, ui } from "../../styles/theme";
import { GroupCell } from "./ZoneGroupsPanel";
import * as m from "~/paraglide/messages";

/** Dialog of the zone editor's Groups section: the groups list as on the side panel (`GroupCell`), where a click
 *  hands the group to `onPick` and closes the dialog. Groups in `excludeIds` (the zone already is in them) are left
 *  out. "New group" closes it and hands over to the name dialog. */
export function ZoneGroupPickerDialog({ excludeIds, onPick, onClose, onNew }: { excludeIds: number[]; onPick: (groupId: number) => void; onClose: () => void; onNew: () => void }) {
  const groups = useMazeStore((s) => s.zoneGroups);
  const available = groups.filter((g) => !excludeIds.includes(g.id));

  return (
    <Modal title={m["zone_groups.pick_title"]()} size="approve" onClose={onClose}>
      <div style={styles.list}>
        {available.length === 0 && (
          <div style={styles.empty}>{m[groups.length === 0 ? "zone_groups.none" : "zone_groups.zone_in_all"]()}</div>
        )}
        {available.map((group) => (
          <GroupCell key={group.id} group={group} onPick={() => { onPick(group.id); onClose(); }} />
        ))}
      </div>
      <Button variant="primary" dialogAction layoutStyle={{ width: "100%" }} onClick={onNew}>{m["zone_groups.new"]()}</Button>
    </Modal>
  );
}

/** Mini dialog that names a new group; confirming hands the name to `onConfirm`. */
export function ZoneGroupNameDialog({ onConfirm, onClose }: { onConfirm: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const canConfirm = name.trim().length > 0;
  const confirm = () => {
    if (!canConfirm) return;
    onConfirm(name.trim());
    onClose();
  };

  return (
    <Modal title={m["zone_groups.new_title"]()} size="approve" onClose={onClose} onConfirm={canConfirm ? confirm : undefined}>
      <label style={sharedStyles.fieldLabel}>
        {m["zones.name"]()}
        <input
          autoFocus
          type="text"
          name="zone-group-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          style={{ ...sharedStyles.input, boxSizing: "border-box", width: "100%" }}
        />
      </label>
      <div style={styles.footer}>
        <Button variant="secondary" dialogAction onClick={onClose}>{m["common.cancel"]()}</Button>
        <Button variant="primary" dialogAction disabled={!canConfirm} onClick={confirm}>{m["common.ok"]()}</Button>
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  list: { display: "flex", flexDirection: "column" },
  empty: { ...disabled(typography.body), textAlign: "center", padding: `${spacing.itemGap}px ${spacing.groupGap}px` },
  footer: { display: "flex", justifyContent: "flex-end", gap: dialogSpacing.gap, paddingTop: dialogSpacing.paddingY, borderTop: `1px solid ${ui.border.default}` },
};
