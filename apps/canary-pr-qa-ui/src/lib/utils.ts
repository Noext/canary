import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Joins conditional class names and resolves Tailwind conflicts, the same way
 * the rest of the Canary UI does.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
