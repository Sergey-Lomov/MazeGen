import { Settings } from "lucide-react";
import { ui } from "../styles/theme";

export function SettingsIconButton({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button type="button" className="hoverable" style={styles.button} onClick={onClick} title={title} aria-label={title}>
      <Settings size={16} color={ui.text.tertiary} />
    </button>
  );
}

const styles = {
  button: {
    width: 22,
    height: 22,
    padding: 0,
    display: "flex" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    border: "none",
    background: "none",
    color: ui.text.tertiary,
    lineHeight: 1,
    opacity: 0.7,
    cursor: "default" as const,
  },
};
