import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { SplitGenerationSettingsBody } from "./SplitGenerationSettingsBody";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

export function SplitSettingsDialog({ onClose }: Props) {
  const splitPatternMode = useMazeStore((s) => s.splitPatternMode);
  const splitMaxNodes = useMazeStore((s) => s.splitMaxNodes);
  const splitPatterns = useMazeStore((s) => s.splitPatterns);
  const setSplitPatternMode = useMazeStore((s) => s.setSplitPatternMode);
  const setSplitMaxNodes = useMazeStore((s) => s.setSplitMaxNodes);
  const setSplitPatterns = useMazeStore((s) => s.setSplitPatterns);

  return (
    <Modal title={m["generation.split_settings_title"]()} onClose={onClose}>
      <SplitGenerationSettingsBody
        value={{ pattern_mode: splitPatternMode, max_split_nodes: splitMaxNodes, patterns: splitPatterns }}
        onChange={(next) => {
          if (next.pattern_mode !== splitPatternMode) setSplitPatternMode(next.pattern_mode);
          if (next.max_split_nodes !== splitMaxNodes) setSplitMaxNodes(next.max_split_nodes);
          if (next.patterns !== splitPatterns) setSplitPatterns(next.patterns);
        }}
      />
    </Modal>
  );
}
