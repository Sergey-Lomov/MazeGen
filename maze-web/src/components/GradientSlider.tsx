import type React from "react";

interface Props {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  /** CSS background for the track — typically a `linear-gradient(...)`. */
  trackBackground: string;
  /** Fill of the thumb's coloured centre. */
  thumbColor: string;
  disabled?: boolean;
  "aria-label"?: string;
  style?: React.CSSProperties;
}

/** CSS custom property (`--thumb-color`) alongside standard properties — `React.CSSProperties` has
 *  no index signature for custom props, so the style object is widened here. */
type SliderStyle = React.CSSProperties & Record<`--${string}`, string>;

/** Range input with a custom-painted track and thumb: a gradient track (radius 4px) plus a disc
 *  thumb (coloured centre + white ring + panel-colored outer edge). Geometry and the thumb pseudo-
 *  elements live in `.gradient-slider` in global.css; per-instance the caller supplies the
 *  `trackBackground` gradient and the `thumbColor` centre fill. Introduced for the color picker's
 *  RGB channel sliders (GitHub issue #500); reusable for any gradient-along-an-axis control. */
export function GradientSlider({
  value,
  min,
  max,
  step = 1,
  onChange,
  trackBackground,
  thumbColor,
  disabled,
  style,
  "aria-label": ariaLabel,
}: Props) {
  const sliderStyle: SliderStyle = {
    ...style,
    background: trackBackground,
    "--thumb-color": thumbColor,
  };
  return (
    <input
      type="range"
      className="gradient-slider"
      name={ariaLabel ?? "gradient-slider"}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      style={sliderStyle}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}
