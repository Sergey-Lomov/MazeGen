import type React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { presetEndpointKey } from "../../pixi/presetEndpoint";
import type { NodeLockKind } from "../../wasm/types";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { radius, dialogSpacing, typography, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

/** Settings-tool dialog switching an existing preset lock between in/out/full (GitHub issue #748).
 *  The current kind is highlighted; picking one applies it and closes the dialog. */
export function PresetLockSettingsDialog({ onClose }: Props) {
  const prompt = useMazeStore((s) => s.presetLockSettingsPrompt);
  const lockedNodes = useMazeStore((s) => s.lockedNodes);
  const setLockKind = useMazeStore((s) => s.setPresetLockKind);

  if (!prompt) return null;
  const current = lockedNodes.get(presetEndpointKey(prompt.endpoint));
  if (!current) return null;
  const options: [NodeLockKind, string][] = [
    ["in", m["preset.lock_in"]()],
    ["out", m["preset.lock_out"]()],
    ["both", m["preset.full_lock"]()],
  ];
  return (
    <Modal title={m["tools.lock_settings_title"]()} size="approve" onClose={onClose}>
      <div style={styles.list}>
        {options.map(([kind, label]) => (
          <Button
            key={kind}
            variant={kind === current ? "primary" : "secondary"}
            layoutStyle={styles.button}
            onClick={() => { setLockKind(prompt.endpoint, kind); onClose(); }}
          >
            {label}
          </Button>
        ))}
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  list: { display: "flex", flexDirection: "column", gap: dialogSpacing.gap },
  button: { ...typography.control, width: "100%", padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, cursor: "default", borderRadius: radius.sm, textAlign: "center" },
};
