import type { HTMLAttributes, ReactNode, ThHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function TableWrap({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): ReactNode {
  return (
    <div
      className={cn(
        "w-full overflow-x-auto rounded-lg border border-border",
        className
      )}
      {...props}
    />
  );
}

export function Table({
  className,
  ...props
}: HTMLAttributes<HTMLTableElement>): ReactNode {
  return (
    <table
      className={cn("w-full border-collapse text-left text-sm", className)}
      {...props}
    />
  );
}

export function Th({
  className,
  scope = "col",
  ...props
}: ThHTMLAttributes<HTMLTableCellElement>): ReactNode {
  return (
    <th
      className={cn(
        "border-border border-b bg-well px-3 py-2 font-semibold text-muted-foreground text-xs uppercase tracking-wide",
        className
      )}
      scope={scope}
      {...props}
    />
  );
}
