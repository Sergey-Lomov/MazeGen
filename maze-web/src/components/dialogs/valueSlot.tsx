import React from "react";
import { ui } from "../../styles/theme";

/** Stands in for a number that is not calculated yet. */
export const PLACEHOLDER = "—";

/** Stands in for a value while it is being recalculated: a pulsing bar of about the width of a value. */
export function ValueSkeleton({ width = "4.5em" }: { width?: string }) {
  return <span className="value-skeleton" data-testid="value-skeleton" aria-hidden="true" style={{ ...skeleton, width }} />;
}

/** Stands in a message's parameter where a value is not text, see `withValueNode`. */
export const VALUE_SLOT = "\u0000";

/** A message formatted with `VALUE_SLOT` as the parameter, with `node` in its place: the label and the
 * unit of a value stay on screen while the value is a placeholder or an indicator (GitHub issue #961). */
export function withValueNode(message: string, node: React.ReactNode): React.ReactNode {
  const parts = message.split(VALUE_SLOT);
  return <>{parts.map((part, index) => <React.Fragment key={index}>{index > 0 && node}{part}</React.Fragment>)}</>;
}

const skeleton: React.CSSProperties = {
  display: "inline-block", height: "0.9em", verticalAlign: "middle", borderRadius: 3, background: ui.bg.input,
};
