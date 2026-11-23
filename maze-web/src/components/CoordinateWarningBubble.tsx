import type React from "react";
import { useEffect, useRef } from "react";
import { coordinateWarningLevels, type CoordinateWarning } from "../domain/coordinateWarning";
import type { PresetEndpoint } from "../domain/presetEndpoint";
import { darken } from "../styles/palette";
import { Bubble, BubbleHoverZone, BubbleHoverZones, type BubbleVariant } from "./Bubble";
import { notificationPalette, type NotificationSeverity } from "./EmbeddedNotification";
import { FloorBadgeRow } from "./FloorBadgeRow";
import { useCoordinateWarningHover } from "./useCoordinateWarningHover";
import { WarningBubble } from "./WarningBubble";

const BUBBLE_VARIANT: Record<NotificationSeverity, BubbleVariant> = {
  info: "neutral",
  warning: "warning",
  critical: "danger",
};

/** The bubble variant a coordinate bubble of a warning of this severity takes. */
export const coordinateBubbleVariant = (severity: NotificationSeverity): BubbleVariant => BUBBLE_VARIANT[severity];

/** The floor badges of a coordinate warning: one `L{n}` per floor its targets lie on, colored like the warning's bubble. */
export function CoordinateWarningFloorBadges({ warning, className }: { warning: CoordinateWarning; className?: string }) {
  const palette = notificationPalette(warning.severity);
  return <FloorBadgeRow levels={coordinateWarningLevels([...warning.targets, ...(warning.floorTargets ?? [])])} bg={darken(palette.text, 0.2)} text={palette.bg} className={className} />;
}

/** A warning bubble for a warning that targets concrete coordinates. The caller gives the message and the warning
 *  (severity + targets); the bubble resolves and draws the floor badges, the coordinate bubbles (when `coordinates`
 *  gives their labels) and the canvas highlight of the whole warning or of one hovered coordinate. */
export function CoordinateWarningBubble({ warning, message, coordinates, onHoverChange, children }: {
  warning: CoordinateWarning;
  message: string;
  /** Labels of coordinate bubbles, one per target they name; omitted shows none. */
  coordinates?: { text: string; target: PresetEndpoint }[];
  /** Extra hover reaction of the warning bubble itself, for what is not a coordinate (a connection's frame). */
  onHoverChange?: (hovering: boolean) => void;
  children?: React.ReactNode;
}) {
  const hover = useCoordinateWarningHover(warning);
  // A bubble that unmounts while hovered gets no mouse-leave: its extra hover reaction is undone here.
  const hovering = useRef(false);
  const hoverChange = useRef(onHoverChange);
  hoverChange.current = onHoverChange;
  useEffect(() => () => {
    if (hovering.current) hoverChange.current?.(false);
  }, []);
  return (
    <WarningBubble severity={warning.severity} message={message} onMouseEnter={() => { hover.onMouseEnter(); hovering.current = true; onHoverChange?.(true); }} onMouseLeave={() => { hover.onMouseLeave(); hovering.current = false; onHoverChange?.(false); }}>
      {coordinates && coordinates.length > 0 && (
        <BubbleHoverZones>
          {coordinates.map(({ text, target }, i) => (
            <BubbleHoverZone key={i} onMouseEnter={() => hover.onTargetEnter(target)} onMouseLeave={hover.onTargetLeave}>
              <Bubble variant={coordinateBubbleVariant(warning.severity)}>{text}</Bubble>
            </BubbleHoverZone>
          ))}
        </BubbleHoverZones>
      )}
      <CoordinateWarningFloorBadges warning={warning} />
      {children}
    </WarningBubble>
  );
}
