import type {
  HTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

export function Card({
  className,
  ...props
}: HTMLAttributes<HTMLElement>): ReactNode {
  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-card p-5 shadow-[0_1px_2px_rgba(10,10,10,0.04)]",
        className
      )}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): ReactNode {
  return (
    <div
      className={cn(
        "mb-4 flex flex-wrap items-start justify-between gap-3",
        className
      )}
      {...props}
    />
  );
}

export function CardTitle({
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement>): ReactNode {
  return <h2 className={cn("font-semibold text-lg", className)} {...props} />;
}

export function CardDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>): ReactNode {
  return (
    <p className={cn("text-muted-foreground text-sm", className)} {...props} />
  );
}

export function Label({
  className,
  htmlFor,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement>): ReactNode {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the caller renders the control as a child with a matching htmlFor id
    <label
      className={cn("block font-medium text-foreground text-sm", className)}
      htmlFor={htmlFor}
      {...props}
    />
  );
}

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return (
    <input
      className={cn(
        "mt-1 w-full rounded-md border border-input bg-card px-3 py-2 text-sm",
        "placeholder:text-faint focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
        "disabled:cursor-not-allowed disabled:bg-well",
        className
      )}
      {...props}
    />
  );
}

export function Select({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return (
    <select
      className={cn(
        "mt-1 w-full rounded-md border border-input bg-card px-3 py-2 text-sm",
        "focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
        "disabled:cursor-not-allowed disabled:bg-well",
        className
      )}
      {...props}
    />
  );
}

export function Checkbox({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return (
    <input
      className={cn("size-4 shrink-0 accent-primary", className)}
      type="checkbox"
      {...props}
    />
  );
}

export function FieldHelp({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>): ReactNode {
  return (
    <p
      className={cn("mt-1 text-muted-foreground text-xs", className)}
      {...props}
    />
  );
}

export function Field({
  children,
  help,
  htmlFor,
  label,
}: {
  children: ReactNode;
  help?: ReactNode;
  htmlFor: string;
  label: string;
}): ReactNode {
  return (
    <div>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {help ? <FieldHelp>{help}</FieldHelp> : null}
    </div>
  );
}
