import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/feedback";
import { automatic, common } from "@/i18n";

/**
 * The delete of one failed attempt, asked once and in place before it fires:
 * the trigger only reveals the question, and the question owns the two buttons
 * that answer it.
 *
 * A failure stays listed for a day so an operator can act on it, which is why
 * clearing one is a deliberate second click rather than the first. The ids are
 * derived from `id` (`<id>`, `<id>-question`, `<id>-confirm`, `<id>-cancel`) so
 * the list row and the detail screen each address their own element.
 *
 * `pending` disables the trigger while the write is in flight: the row is about
 * to leave the list, and a second click would only race its own reload.
 */
export function AutomaticDelete({
  id,
  onConfirm,
  pending,
}: {
  id: string;
  onConfirm: () => void;
  pending: boolean;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Button
        disabled={pending}
        id={id}
        onClick={() => setConfirming(true)}
        variant="danger"
      >
        {pending ? automatic.deleting : automatic.delete}
      </Button>
      <Notice
        className="w-full"
        hidden={!confirming}
        id={`${id}-question`}
        tone="warning"
      >
        <p id={`${id}-question-text`}>{automatic.deleteQuestion}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            id={`${id}-confirm`}
            onClick={() => {
              setConfirming(false);
              onConfirm();
            }}
            variant="danger"
          >
            {common.confirm}
          </Button>
          <Button id={`${id}-cancel`} onClick={() => setConfirming(false)}>
            {common.cancel}
          </Button>
        </div>
      </Notice>
    </>
  );
}
