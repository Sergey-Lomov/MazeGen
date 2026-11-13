/** Stable, non-translated identities of the project-color fields (GitHub issue #717). Lives apart
 *  from `projectColorsSelector.ts` (which owns the localized labels) so the renderer/i18n-agnostic
 *  `exportWarnings.ts` can name the fields a warning concerns without pulling in paraglide. */
export const STATIC_COLOR_FIELD_KEYS = [
  "bgFill", "bgGrid", "innerGrid", "cutLines", "glueTabFill", "glueTabLine", "edgeMarker",
  "corridorFill",
  "tilesFloor", "tilesWall",
  "oneWaysMarker",
  "startFill", "startBorder", "startText",
  "finishFill", "finishBorder", "finishText",
  "startOpeningArrow", "finishOpeningArrow",
  "teleportEdge", "teleportEdgeBorder", "teleportConnector",
  "teleportBadgeFill", "teleportBadgeBorder", "teleportBadgeText",
  "decorLineTwoWay", "decorLineOneWay", "decorLineElevator",
  "decorArrowTwoWay", "decorArrowOneWay",
  "sharedMarkerFill", "sharedMarkerBorder",
  "verticalFill", "verticalBorder", "verticalArrow", "verticalDecorLine",
  "twoWayFill", "twoWayBorder", "twoWayArrow",
  "oneWayFill", "oneWayBorder", "oneWayArrow",
  "elevatorFill", "elevatorBorder", "elevatorArrow",
  "elevatorBadgeFill", "elevatorBadgeBorder", "elevatorBadgeText",
  "markerIndexFill", "markerIndexText", "markerIndexBorder",
  "floorLabelFill", "floorLabelBorder", "floorLabelText",
] as const;

export type StaticColorFieldKey = (typeof STATIC_COLOR_FIELD_KEYS)[number];
export type TeleportGroupColorRole = "fill" | "border";
export type SplitNodeColorFieldKey = `splitNode:${number}`;
export type TeleportGroupColorFieldKey = `teleportGroup:${number}:${TeleportGroupColorRole}`;
export type EdgeMarkerColorFieldKey = `edgeMarker:${string}|${string}`;
export type ColorFieldKey = StaticColorFieldKey | SplitNodeColorFieldKey | TeleportGroupColorFieldKey | EdgeMarkerColorFieldKey;

export const splitNodeKey = (index: number): SplitNodeColorFieldKey => `splitNode:${index}`;
/** An edge marker's own colour (GitHub issue #902): the floor it lies on and the marker's key there. */
export const edgeMarkerKey = (floorId: string, markerKey: string): EdgeMarkerColorFieldKey => `edgeMarker:${floorId}|${markerKey}`;
export const teleportGroupKey = (index: number, role: TeleportGroupColorRole): TeleportGroupColorFieldKey =>
  `teleportGroup:${index}:${role}`;

/** A parsed {@link ColorFieldKey}: the dynamic families carry their index (and role), or the floor and marker key; anything
 *  else is a static key. The single place the key syntax is decoded. */
export type ParsedColorFieldKey =
  | { kind: "split"; index: number }
  | { kind: "teleportGroup"; index: number; role: TeleportGroupColorRole }
  | { kind: "edgeMarker"; floorId: string; markerKey: string }
  | { kind: "static"; key: StaticColorFieldKey };

export function parseColorFieldKey(key: string): ParsedColorFieldKey {
  const split = /^splitNode:(\d+)$/.exec(key);
  if (split) return { kind: "split", index: Number(split[1]) };
  const group = /^teleportGroup:(\d+):(fill|border)$/.exec(key);
  if (group) return { kind: "teleportGroup", index: Number(group[1]), role: group[2] as TeleportGroupColorRole };
  const marker = /^edgeMarker:([^|]+)\|(.+)$/.exec(key);
  if (marker) return { kind: "edgeMarker", floorId: marker[1], markerKey: marker[2] };
  return { kind: "static", key: key as StaticColorFieldKey };
}
