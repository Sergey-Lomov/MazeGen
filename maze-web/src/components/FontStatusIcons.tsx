import { CircleDot } from "lucide-react";

/** Size of every font status icon: the indicators of a font row, the icons of the filter chips and the "in project"
 *  mark of the delete dialog. One value, so the indicators line up with the format bubbles beside them. */
export const FONT_STATUS_ICON_SIZE = 14;

/** The "the project uses this font" mark, one icon for the list row, its filter chip and the delete dialog. */
export function FontUsedIcon() {
  return <CircleDot size={FONT_STATUS_ICON_SIZE} />;
}
