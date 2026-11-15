import { IconActionButton } from "./IconActionButton";

/** Shared settings action with the common flat icon-button surface. */
export function SettingsIconButton({ title, onClick }: { title: string; onClick: () => void }) {
  return <IconActionButton action="settings" title={title} onClick={onClick} />;
}
