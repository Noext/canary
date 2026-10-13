import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

function withClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value,
  });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("copyText", () => {
  it("reports the copy the browser performed", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    withClipboard({ writeText });
    await expect(copyText('{"phase":"done"}')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('{"phase":"done"}');
  });

  it("reports a refused copy rather than a success", async () => {
    // A denied permission rejects the promise, and the dashboard must not claim
    // the text reached the clipboard.
    withClipboard({
      writeText: vi.fn().mockRejectedValue(new Error("denied")),
    });
    await expect(copyText("{}")).resolves.toBe(false);
  });

  it("has nothing to copy without the Clipboard API", async () => {
    // A plain HTTP origin on the LAN has no `navigator.clipboard`.
    Reflect.deleteProperty(navigator, "clipboard");
    await expect(copyText("{}")).resolves.toBe(false);
  });

  it("never claims to have copied an empty block", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    withClipboard({ writeText });
    await expect(copyText("")).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
