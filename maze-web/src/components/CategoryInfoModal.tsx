import React from "react";
import { Modal } from "./Modal";
import { typography, spacing } from "../styles/theme";

interface ParamInfo {
  label: string;
  description: string;
}

interface Props {
  title: string;
  params: ParamInfo[];
  onClose: () => void;
}

/** Lists every parameter of one settings category (label + full description) in a single modal —
 *  the info entry point for a category header's info icon (GitHub issue #351), one dialog per
 *  category rather than one per parameter, since categories are small enough to read in one pass. */
export function CategoryInfoModal({ title, params, onClose }: Props) {
  return (
    <Modal title={title} onClose={onClose}>
      <div style={styles.list}>
        {params.map((p, i) => (
          <div key={i} style={styles.item}>
            <div style={styles.label}>{p.label}</div>
            <div style={styles.desc}>{p.description}</div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  list: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.sectionGap,
  },
  item: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.elementsGap,
  },
  label: {
    ...typography.body,
  },
  desc: {
    ...typography.caption,
    lineHeight: 1.4,
  },
};
