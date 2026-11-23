import type React from "react";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { ZoneTargetPicker } from "../features/ZoneTargetPanel";
import { useMazeStore } from "../../store/mazeStore";
import { dialogSpacing, ui } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  ruleId: string;
  onClose: () => void;
}

/** Picks the one zone or group a QC rule is bound to (GitHub issue #1039), or deletes the binding. A pick binds
 *  and closes; a group also carries the mode chosen on the picker. */
export function RuleZoneScopeDialog({ ruleId, onClose }: Props) {
  const bound = useMazeStore((s) => s.rules.find((r) => r.id === ruleId)?.zoneScope !== undefined);
  const setScope = useMazeStore((s) => s.setRuleZoneScope);
  const finish = (target: Parameters<typeof setScope>[1]) => { setScope(ruleId, target); onClose(); };
  return (
    <Modal
      title={m["quality.zone_scope_pick_title"]()}
      size="compact"
      layoutStyle={{ height: 520 }}
      onClose={onClose}
      rawBody={(
        <>
          <div style={styles.list}>
            <ZoneTargetPicker
              embedded
              groupModes
              showAutoByDefault
              onPick={(target, mode) => finish(target.kind === "zone" ? { kind: "zone", id: target.id } : { kind: "group", id: target.id, mode })}
            />
          </div>
          <div style={styles.footer}>
            <Button variant="destructive" layoutStyle={{ flex: 1 }} disabled={!bound} title={bound ? undefined : m["quality.zone_scope_not_set"]()} onClick={() => finish(null)}>
              {m["quality.zone_scope_delete"]()}
            </Button>
          </div>
        </>
      )}
    />
  );
}

const styles: Record<string, React.CSSProperties> = {
  list: { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: dialogSpacing.gap, padding: `${dialogSpacing.bodyPadding}px ${dialogSpacing.paddingX}px` },
  footer: { display: "flex", justifyContent: "flex-end", padding: `${dialogSpacing.paddingY}px ${dialogSpacing.paddingX}px`, borderTop: `1px solid ${ui.border.default}` },
};

