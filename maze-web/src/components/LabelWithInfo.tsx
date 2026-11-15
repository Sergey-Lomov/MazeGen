import type React from "react";
import { spacing } from "../styles/theme";
import { InfoIconButton } from "./InfoIconButton";

/** Shared inline label and its contextual information action. */
export function LabelWithInfo({ children, onInfo, trailing, style, labelStyle, infoPosition = "after", as = "span" }: {
  children: React.ReactNode;
  onInfo: () => void;
  /** Optional actions aligned to the far end of the same row. */
  trailing?: React.ReactNode;
  style?: React.CSSProperties;
  labelStyle?: React.CSSProperties;
  /** Keeps the action at the far end when a row's layout requires it. */
  infoPosition?: "after" | "end";
  as?: "span" | "div";
}) {
  const content = (
    <>
      <span style={labelStyle}>{children}</span>
      <span style={infoPosition === "end" ? { marginLeft: "auto", display: "inline-flex" } : undefined}>
        <InfoIconButton onClick={onInfo} />
      </span>
      {trailing && <span style={styles.trailing}>{trailing}</span>}
    </>
  );
  const sharedStyle = { display: "inline-flex", alignItems: "center", gap: spacing.itemGap, ...style };
  return as === "div" ? <div style={sharedStyle}>{content}</div> : <span style={sharedStyle}>{content}</span>;
}

const styles: Record<string, React.CSSProperties> = {
  trailing: { marginLeft: "auto", display: "inline-flex" },
};
