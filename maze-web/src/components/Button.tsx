import type React from "react";
import { buttonClass, buttonStyle } from "../styles/shared";

export type ButtonVariant = "primary" | "secondary" | "toggle" | "toggle-selected" | "destructive" | "toggle-danger" | "toggle-danger-selected";

type Props = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style"> & {
  variant: ButtonVariant;
  /** Layout-only overrides such as width, flex, margin, or height. Visual state belongs to the variant CSS. */
  layoutStyle?: React.CSSProperties;
};

/** Text button bound to the shared semantic visual system. */
export function Button({ variant, layoutStyle, type = "button", ...props }: Props) {
  return <button {...props} type={type} className={buttonClass(variant)} style={{ ...buttonStyle(variant), ...layoutStyle }} />;
}
