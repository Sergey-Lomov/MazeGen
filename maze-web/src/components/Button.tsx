import type React from "react";
import { buttonClass, buttonStyle } from "../styles/shared";
import { Tooltip } from "./Tooltip";

export type ButtonVariant = "primary" | "secondary" | "toggle" | "toggle-selected" | "destructive" | "toggle-danger" | "toggle-danger-selected";

type Props = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style"> & {
  variant: ButtonVariant;
  /** Layout-only overrides such as width, flex, margin, or height. Visual state belongs to the variant CSS. */
  layoutStyle?: React.CSSProperties;
  /** Gives paired dialog actions a shared usable minimum width. */
  dialogAction?: boolean;
};

/** Text button bound to the shared semantic visual system. */
export function Button({ variant, layoutStyle, dialogAction = false, type = "button", title, ...props }: Props) {
  const button = <button {...props} type={type} className={buttonClass(variant)} style={{ ...buttonStyle(variant), ...(dialogAction ? { minWidth: 80 } : {}), ...layoutStyle }} />;
  return title ? <Tooltip content={title}>{button}</Tooltip> : button;
}
