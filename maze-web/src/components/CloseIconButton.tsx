import { IconActionButton } from "./IconActionButton";

/** Shared close action for panels and dialogs. */
export function CloseIconButton({ title = "Close", onClick }: { title?: string; onClick: () => void }) {
  return <IconActionButton action="close" title={title} onClick={onClick} />;
}
