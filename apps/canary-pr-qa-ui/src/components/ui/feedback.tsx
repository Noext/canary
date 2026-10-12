import type { HTMLAttributes, ReactNode } from "react";
import type { Tone } from "@/lib/format";
import { cn } from "@/lib/utils";

export function Pill({
  className,
  tone = "neutral",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }): ReactNode {
  const tones: Record<Tone, string> = {
    failed: "border-destructive/30 bg-fail-bg text-on-fail",
    neutral: "border-border bg-well text-muted-foreground",
    pending: "border-primary-edge/60 bg-primary/20 text-ink-strong",
    success: "border-pass/30 bg-pass/10 text-pass",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-medium text-xs",
        tones[tone],
        className
      )}
      {...props}
    />
  );
}

export function Notice({
  className,
  tone = "neutral",
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  tone?: "error" | "neutral" | "success" | "warning";
}): ReactNode {
  const tones = {
    error: "border-destructive/40 bg-fail-bg text-on-fail",
    neutral: "border-border bg-well text-muted-foreground",
    success: "border-pass/30 bg-pass/10 text-pass",
    warning: "border-warn/30 bg-warn-bg text-warn",
  } as const;
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-sm",
        tones[tone],
        className
      )}
      {...props}
    />
  );
}
