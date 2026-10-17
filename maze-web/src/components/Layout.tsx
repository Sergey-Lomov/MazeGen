import React from "react";
import { spacing } from "../styles/theme";
import { Tooltip } from "./Tooltip";

type Gap = keyof typeof spacing;

// Excludes gap/padding/margin from the escape-hatch `style` prop — those must go through the
// `gap` prop (or a raw styled div outside these primitives), never bypass the spacing tokens.
type SafeStyle = Omit<React.CSSProperties, "gap" | "rowGap" | "columnGap" | "padding" | "margin"
  | "paddingTop" | "paddingBottom" | "paddingLeft" | "paddingRight"
  | "marginTop" | "marginBottom" | "marginLeft" | "marginRight">;

export function Stack({ gap, align, children, style }: {
  gap: Gap; align?: React.CSSProperties["alignItems"]; children: React.ReactNode; style?: SafeStyle;
}) {
  return <div style={{ display: "flex", flexDirection: "column", gap: spacing[gap], alignItems: align, ...style }}>{children}</div>;
}

export function Inline({ gap, align = "center", justify, children, style, title }: {
  gap: Gap; align?: React.CSSProperties["alignItems"]; justify?: React.CSSProperties["justifyContent"];
  children: React.ReactNode; style?: SafeStyle; title?: string;
}) {
  const row = <div style={{ display: "flex", alignItems: align, justifyContent: justify, gap: spacing[gap], ...style }}>{children}</div>;
  return title ? <Tooltip content={title} block>{row}</Tooltip> : row;
}

export function Grid({ templateColumns, gap, children, style }: {
  templateColumns: string; gap: Gap; children: React.ReactNode; style?: SafeStyle;
}) {
  return <div style={{ display: "grid", gridTemplateColumns: templateColumns, gap: spacing[gap], ...style }}>{children}</div>;
}
