import { beforeEach, describe, expect, it } from "vitest";
import { readInitialRoute } from "./routing";

const RUN_ID = "74422b90-c70a-11f1-8b8c-69d5033ed7fd";
const DELIVERY_ID = "delivery:01J8Z";

/** Puts the document at `url` the way a browser would, hash included. */
function open(url: string) {
  window.history.replaceState(null, "", url);
}

beforeEach(() => {
  open("/");
});

describe("readInitialRoute", () => {
  it("reads an automatic attempt link and leaves it in the URL", () => {
    open(`/#automatic=${DELIVERY_ID}`);

    expect(readInitialRoute()).toEqual({
      screen: { id: DELIVERY_ID, kind: "automatic" },
    });
    // The link survives, so a reload reopens the same screen instead of
    // falling back to the home panel on the second refresh.
    expect(window.location.hash).toBe(`#automatic=${DELIVERY_ID}`);
  });

  it("reads a run screen link and leaves it in the URL", () => {
    open(`/#run=${RUN_ID}`);

    expect(readInitialRoute()).toEqual({
      screen: { id: RUN_ID, kind: "run" },
    });
    expect(window.location.hash).toBe(`#run=${RUN_ID}`);
  });

  it("keeps the legacy bare uuid link for the runs history", () => {
    open(`/#${RUN_ID}`);

    expect(readInitialRoute()).toEqual({ runId: RUN_ID });
    expect(window.location.hash).toBe(`#${RUN_ID}`);
  });

  it("erases a temporary setup code after reading it", () => {
    open("/#setup=secret-code");

    expect(readInitialRoute()).toEqual({ setupCode: "secret-code" });
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/");
  });

  it("drops the GitHub callback query without dropping the screen link", () => {
    open(`/?github=connected#automatic=${DELIVERY_ID}`);

    expect(readInitialRoute()).toEqual({
      github: "connected",
      screen: { id: DELIVERY_ID, kind: "automatic" },
    });
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe(`#automatic=${DELIVERY_ID}`);
  });

  it("discards a hash this dashboard never wrote", () => {
    open("/#whatever");

    expect(readInitialRoute()).toEqual({});
    expect(window.location.hash).toBe("");
  });
});
