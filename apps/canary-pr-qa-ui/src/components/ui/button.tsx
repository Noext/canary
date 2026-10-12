import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

type Variant = "danger" | "primary" | "quiet" | "secondary";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
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

export function Button({
  className,
  type = "button",
  variant = "secondary",
  ...props
}: ButtonProps): ReactNode {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 font-medium text-sm transition-[filter,background-color]",
        "focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        variants[variant],
        className
      )}
      type={type}
      {...props}
    />
  );
}
