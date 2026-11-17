import { IconActionButton } from "./IconActionButton";

/** Shared load/open action. */
export function LoadIconButton({ title, onClick }: { title: string; onClick: () => void }) {
  return <IconActionButton action="load" title={title} onClick={onClick} />;
}
