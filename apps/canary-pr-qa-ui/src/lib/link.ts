import type { MouseEvent } from "react";

/**
 * True for a click that should open the link in the current tab: the primary
 * button, with no modifier held. Every other click keeps the anchor's native
 * behaviour — new tab, new window, background tab, download — which is the whole
 * point of giving a screen a real page address.
 */
export function isPlainLeftClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
  );
}
