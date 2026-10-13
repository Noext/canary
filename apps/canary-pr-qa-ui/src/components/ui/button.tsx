import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

type Variant = "danger" | "primary" | "quiet" | "secondary";
type Size = "md" | "sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: Size;
  variant?: Variant;
}

const variants: Record<Variant, string> = {
  danger:
    "border border-destructive/40 bg-destructive/5 text-on-fail hover:bg-destructive/10",
  primary:
    "border border-primary-edge bg-primary text-on-primary hover:brightness-95",
  quiet:
    "border border-transparent bg-transparent text-muted-foreground underline-offset-4 hover:underline",
  secondary: "border border-border bg-card text-foreground hover:bg-well",
};

/** `sm` is for a control that sits inside a text-sized block, not a page action. */
const sizes: Record<Size, string> = {
  md: "px-3 py-2 text-sm",
  sm: "px-2 py-1 text-xs",
};

export function Button({
  className,
  size = "md",
  type = "button",
  variant = "secondary",
  ...props
}: ButtonProps): ReactNode {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-[filter,background-color]",
        "focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        variants[variant],
        sizes[size],
        className
      )}
      type={type}
      {...props}
    />
  );
}
