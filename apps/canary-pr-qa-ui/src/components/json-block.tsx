import { useState } from "react";
import { Button } from "@/components/ui/button";
import { runs as copy } from "@/i18n";
import { copyText } from "@/lib/clipboard";

/**
 * A JSON well of the dashboard with the button that copies it.
 *
 * The diagnostic of a run is read to be pasted somewhere else — a bug report, an
 * issue — so the paste has to be exactly the string the block shows, and the
 * button has to admit the two ways a copy can fail.
 */

type CopyState = "done" | "failed" | "idle";

/** The label of each state of a copy button, from the shared French copy. */
const copyFeedback: Record<CopyState, string> = {
  done: copy.copyDone,
  failed: copy.copyFailed,
  idle: copy.copyAction,
};

/**
 * What one button has to say about the text its block currently shows: a reply
 * belongs to the block it copied, so a block that moved on is back to "Copier".
 */
function copyState(
  copied: { ok: boolean; text: string } | undefined,
  text: string
): CopyState {
  if (!copied || copied.text !== text) {
    return "idle";
  }
  return copied.ok ? "done" : "failed";
}

/**
 * The button of one JSON block. It reports the three real outcomes of a copy —
 * done, refused by the browser, nothing to copy — because the Clipboard API is
 * absent outside a secure context, and a success label nobody can paste from is
 * worse than saying the copy did not happen.
 *
 * The feedback is derived from the text last copied, not from a timer: no effect
 * is needed for a label that resets itself when the block changes.
 *
 * The button keeps naming the action it performs, and the outcome is announced
 * by a polite status region next to it: `aria-label` overrides the visible text,
 * so a screen-reader user would otherwise hear "Copier" whatever happened, and a
 * name that changes under a focused button is not a reliable announcement.
 */
function CopyButton({
  id,
  label,
  text,
}: {
  id: string;
  label: string;
  text: string;
}) {
  const [copied, setCopied] = useState<{ ok: boolean; text: string }>();
  const state = copyState(copied, text);

  const handleCopy = async () => {
    setCopied({ ok: await copyText(text), text });
  };

  return (
    <>
      <Button
        aria-label={`${copy.copyAction} : ${label}`}
        disabled={!text}
        id={id}
        onClick={() => void handleCopy()}
        size="sm"
        variant="quiet"
      >
        {copyFeedback[state]}
      </Button>
      <span className="sr-only" id={`${id}Status`} role="status">
        {state === "idle" ? "" : `${copyFeedback[state]} : ${label}`}
      </span>
    </>
  );
}

/**
 * One JSON block with its heading and its copy button. `id` labels the block
 * itself, the one the end-to-end suite reads; `copyId` labels the button, which
 * carries the same text.
 */
export function JsonBlock({
  copyId,
  id,
  label,
  text,
}: {
  copyId: string;
  id: string;
  label: string;
  text: string;
}) {
  return (
    <>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">{label}</span>
        <CopyButton id={copyId} label={label} text={text} />
      </div>
      <pre
        className="mt-1 max-h-64 overflow-auto rounded-md border border-border bg-well p-2 text-xs"
        id={id}
      >
        {text}
      </pre>
    </>
  );
}
