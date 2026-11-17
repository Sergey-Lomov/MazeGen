import { IconActionButton } from "./IconActionButton";

/** Shared save action. */
export function SaveIconButton({ title, onClick }: { title: string; onClick: () => void }) {
  return <IconActionButton action="save" title={title} onClick={onClick} />;
}
