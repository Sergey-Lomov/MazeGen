import { sharedStyles } from "../styles/shared";
import { ui, font } from "../styles/theme";

interface Props {
  label: string;
  value: number;
  onChange: (v: number) => void;
  description?: string;
}

export function SliderRow({ label, value, onChange, description }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={sharedStyles.sliderRow}>
        <span style={sharedStyles.sliderRowLabel}>{label}</span>
        <input
          type="range"
          className="maze-slider"
          style={{ flex: 1 }}
          min={0}
          max={1}
          step={0.01}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span style={sharedStyles.sliderRowValue}>{value.toFixed(2)}</span>
      </div>
      {description && <div style={{ fontSize: font.sm, color: ui.text.tertiary, lineHeight: 1.4 }}>{description}</div>}
    </div>
  );
}
