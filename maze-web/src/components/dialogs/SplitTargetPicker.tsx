import type React from "react";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { ui, radius, dialogSpacing, typography, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";

export interface SplitTargetOption {
  key: string;
  color: string;
  label: string;
  state?: string;
}

interface Props {
  title: string;
  hint: string;
  options: SplitTargetOption[];
  preview?: React.ReactNode;
  onSelect: (option: SplitTargetOption) => void;
  onClose: () => void;
}

/** The split-tile nodes a picker offers, each with its index on the tile's full node list — colors
 *  and names follow that index, so leaving a node out (`excluded`, GitHub issue #748) keeps every
 *  other node's own color and name. */
export function shownSplitTargets<T>(nodes: readonly T[], excluded: (node: T) => boolean): { node: T; index: number }[] {
  return nodes.map((node, index) => ({ node, index })).filter(({ node }) => !excluded(node));
}

export function numberToCssColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/** Shared split-target layout; feature adapters own prompt models and preview construction. */
export function SplitTargetPicker({ title, hint, options, preview, onSelect, onClose }: Props) {
  return (
    <Modal title={title} size="approve" onClose={onClose}>
      <p style={styles.hint}>{hint}</p>
      <div style={styles.body}>
        <div style={styles.list}>
          {options.map((option) => (
            <Button key={option.key} variant="secondary" layoutStyle={styles.item} onClick={() => onSelect(option)}>
              <span style={{ ...styles.dot, background: option.color }} />
              {option.label}
              {option.state && <span style={styles.state}>{option.state}</span>}
            </Button>
          ))}
        </div>
        {preview}
      </div>
      <div style={styles.footer}>
        <Button variant="secondary" layoutStyle={styles.button} onClick={onClose}>{m["common.cancel"]()}</Button>
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  hint: { ...typography.control, color: ui.text.secondary, margin: 0 },
  body: { display: "flex", gap: dialogSpacing.paddingX, alignItems: "center" },
  list: { display: "flex", flexDirection: "column", gap: dialogSpacing.gap, flex: 1, minWidth: 0 },
  item: { ...typography.control, display: "flex", alignItems: "center", gap: 8, width: "100%", justifyContent: "flex-start", padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, borderRadius: radius.sm },
  dot: { width: 10, height: 10, borderRadius: "50%", flex: "0 0 auto" },
  state: { marginLeft: "auto", color: ui.text.secondary, fontSize: 11 },
  footer: { display: "flex", justifyContent: "flex-end", gap: dialogSpacing.gap, paddingTop: dialogSpacing.paddingY, borderTop: `1px solid ${ui.border.default}` },
  button: { ...typography.control, padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, cursor: "default", borderRadius: radius.sm },
};
