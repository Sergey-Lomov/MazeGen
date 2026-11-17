import { Settings } from "lucide-react";
import { ListCellAction, type ListCellActionProps } from "./ListCell";

/** Shared settings action for a `ListCell`, preserving its pointer-safe activation behavior. */
export function SettingsListCellAction({ title, onAction, ...props }: Omit<ListCellActionProps, "children">) {
  return <ListCellAction {...props} title={title} onAction={onAction}><Settings size={16} /></ListCellAction>;
}
