import React from "react";
import { Modal } from "../Modal";
import { muted, typography } from "../../styles/theme";
import * as m from "~/paraglide/messages";

/** Explains what the "Auto-confirm" toggle does (GitHub issue #576) — same plain-text-paragraphs
 *  pattern as `AnalyticsModals.tsx`'s `SidesInfoModal`/`ScoreInfoModal`, reused here for the post-edit
 *  panel's own info entry points so the icon/dialog stays one shared convention across features. */
export function AutoConfirmInfoModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={m["post_edit.auto_confirm"]()} onClose={onClose}>
      <div style={styles.desc}>{m["post_edit.auto_confirm_info_p1"]()}</div>
      <div style={styles.desc}>{m["post_edit.auto_confirm_info_p2"]()}</div>
      <div style={styles.desc}>{m["post_edit.auto_confirm_info_p3"]()}</div>
    </Modal>
  );
}

/** Explains what the "Auto-compact" toggle does (GitHub issue #576). */
export function AutoCompactInfoModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={m["post_edit.auto_compact"]()} onClose={onClose}>
      <div style={styles.desc}>{m["post_edit.auto_compact_info_p1"]()}</div>
      <div style={styles.desc}>{m["post_edit.auto_compact_info_p2"]()}</div>
      <div style={styles.desc}>{m["post_edit.auto_compact_info_p3"]()}</div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  desc: { ...muted(typography.body) },
};
