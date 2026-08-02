import React, { type ButtonHTMLAttributes } from "react";
import "./button.css";

export type ButtonVariant = "primary" | "secondary";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = "secondary", className = "", ...props }: ButtonProps) {
  return <button {...props} className={`v2-button v2-button-${variant} ${className}`} />;
}

export function PrimaryButton(props: Omit<ButtonProps, "variant">) { return <Button {...props} variant="primary" />; }
export function SecondaryButton(props: Omit<ButtonProps, "variant">) { return <Button {...props} variant="secondary" />; }
