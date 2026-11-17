import type React from "react";
import { muted, radius, spacing, typography, ui } from "../styles/theme";

/** Coordinate and id labels read better with fixed-width digits than in the app's `system-ui` stack. */
const BUBBLE_FONT_FAMILY = "Consolas, Menlo, Monaco, monospace";

export type BubbleVariant = "neutral" | "success" | "danger";

export interface BubbleColors {
  bg: string;
  text: string;
}

const VARIANT_COLORS: Record<BubbleVariant, BubbleColors> = {
  neutral: ui.debug.refHighlight,
  success: { bg: ui.bg.success, text: ui.text.success },
  danger: { bg: ui.bg.error, text: ui.text.error },
};

/** Border, text and background of a variant, for places that colour something other than a
 *  `Bubble` (e.g. a floor badge sitting inside one). */
export const bubbleColors = (variant: BubbleVariant): BubbleColors => VARIANT_COLORS[variant];

export interface BubbleProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "color"> {
  /** `neutral` references an entity (coordinates), `success` tags an id, `danger` marks a problem. */
  variant?: BubbleVariant;
  /** Colours outside the three variants (the glue runs' own hues). Wins over `variant`. */
  colors?: BubbleColors;
  /** `body` for a bubble embedded in a line of body text. */
  size?: "caption" | "body";
  /** The bubble reacts to a click: shows the pointer cursor. */
  interactive?: boolean;
}

/** The `id: N` tag of an entity row: a `success` bubble. Hover and click stay with the caller. */
export function IdBubble({ id, ...rest }: Omit<BubbleProps, "variant" | "colors" | "children"> & { id: string | number }) {
  return <Bubble {...rest} variant="success">id: {id}</Bubble>;
}

/** The shared "bubble" chip: monospace caption text in a bordered pill. Interaction (hover, click,
 *  tooltip) stays with the caller through the usual `<span>` props; `style` is merged last. */
export function Bubble({ variant = "neutral", colors, size = "caption", interactive = false, style, children, ...rest }: BubbleProps) {
  const palette = colors ?? VARIANT_COLORS[variant];
  return (
    <span
      {...rest}
      style={{
        ...typography[size],
        fontFamily: BUBBLE_FONT_FAMILY,
        display: "inline-flex",
        alignItems: "center",
        borderStyle: "solid",
        borderWidth: 1,
        borderRadius: radius.lg,
        padding: `0 ${spacing.itemGap}px`,
        background: palette.bg,
        borderColor: palette.text,
        color: palette.text,
        whiteSpace: "nowrap",
        cursor: interactive ? "pointer" : "default",
        userSelect: "none",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** Wraps one bubble of a group whose hover highlights something on the canvas. The padding keeps the
 *  visual spacing while the zones themselves touch (no gap), so moving between bubbles never passes
 *  a spot that hovers the whole group. */
export function BubbleHoverZone({ style, ...rest }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span {...rest} style={{ display: "inline-flex", padding: spacing.itemGap / 4, cursor: "default", ...style }} />;
}

/** A wrapping row of `BubbleHoverZone`s. */
export function BubbleHoverZones({ style, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} style={{ display: "flex", flexWrap: "wrap", ...style }} />;
}

/** The `->`, `<-` or `<->` glyph between two bubbles; `style` is merged last and the hover handlers
 *  come through the usual `<span>` props. */
export function BubbleArrow({ style, ...rest }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span {...rest} style={{ ...muted(typography.caption), whiteSpace: "nowrap", ...style }} />;
}
