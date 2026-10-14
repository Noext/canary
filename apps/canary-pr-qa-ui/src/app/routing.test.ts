import { beforeEach, describe, expect, it } from "vitest";
import {
  initialViewFor,
  pushRoute,
  type Route,
  readInitialRoute,
  readRoute,
} from "./routing";

const RUN_ID = "74422b90-c70a-11f1-8b8c-69d5033ed7fd";
const DELIVERY_ID = "delivery:01J8Z";

/** Puts the document at `url` the way a browser would, hash included. */
function open(url: string) {
  window.history.replaceState(null, "", url);
}

/** The path and hash of the current document, without its origin. */
function address(): string {
  return `${window.location.pathname}${window.location.hash}`;
}

beforeEach(() => {
  open("/");
});

describe("readInitialRoute", () => {
  it("reads an automatic attempt link and leaves it in the URL", () => {
    open(`/#automatic=${DELIVERY_ID}`);

    expect(readInitialRoute()).toEqual({
      route: { id: DELIVERY_ID, kind: "automatic" },
    });
    // The link survives, so a reload reopens the same screen instead of
    // falling back to the home panel on the second refresh.
    expect(window.location.hash).toBe(`#automatic=${DELIVERY_ID}`);
  });

  it("reads a run screen link and leaves it in the URL", () => {
    open(`/#run=${RUN_ID}`);

    expect(readInitialRoute()).toEqual({
      route: { id: RUN_ID, kind: "run" },
    });
    expect(window.location.hash).toBe(`#run=${RUN_ID}`);
  });

  it("keeps the legacy bare uuid link for the runs history", () => {
    open(`/#${RUN_ID}`);

    expect(readInitialRoute()).toEqual({
      route: { kind: "runs", runId: RUN_ID },
    });
    expect(window.location.hash).toBe(`#${RUN_ID}`);
  });

  it("reads a settings link and leaves it in the URL", () => {
    open("/#settings=accounts");

    expect(readInitialRoute()).toEqual({
      route: { kind: "settings", section: "accounts" },
    });
    // A shared settings link reopens the same page, section included.
    expect(window.location.hash).toBe("#settings=accounts");
  });

  it("discards a settings link to a page this build does not have", () => {
    open("/#settings=nope");

    expect(readInitialRoute()).toEqual({ route: { kind: "home" } });
    expect(window.location.hash).toBe("");
  });

  it("erases a temporary setup code after reading it", () => {
    open("/#setup=secret-code");

    expect(readInitialRoute()).toEqual({
      route: { kind: "home" },
      setupCode: "secret-code",
    });
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/");
  });

  it("drops the GitHub callback query without dropping the screen link", () => {
    open(`/?github=connected#automatic=${DELIVERY_ID}`);

    expect(readInitialRoute()).toEqual({
      github: "connected",
      route: { id: DELIVERY_ID, kind: "automatic" },
    });
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe(`#automatic=${DELIVERY_ID}`);
  });

  it("discards a hash this dashboard never wrote", () => {
    open("/#whatever");

    expect(readInitialRoute()).toEqual({ route: { kind: "home" } });
    expect(window.location.hash).toBe("");
  });

  it("reads the history from its path", () => {
    open("/history");

    expect(readInitialRoute()).toEqual({ route: { kind: "runs" } });
    expect(address()).toBe("/history");
  });

  it("reads the test page from its path", () => {
    open("/new-test");

    expect(readInitialRoute()).toEqual({ route: { kind: "new" } });
    expect(address()).toBe("/new-test");
  });

  it("falls back home on a path the server never served this dashboard for", () => {
    open("/ancien-chemin");

    expect(readInitialRoute()).toEqual({ route: { kind: "home" } });
  });

  it("shows the screen a hash names when the path names another one", () => {
    // The hash is the only part that can cite an identifier: it wins.
    open(`/history#run=${RUN_ID}`);

    expect(readInitialRoute()).toEqual({ route: { id: RUN_ID, kind: "run" } });
  });
});

describe("pushRoute", () => {
  const routes: { route: Route; url: string }[] = [
    { route: { kind: "home" }, url: "/" },
    { route: { kind: "new" }, url: "/new-test" },
    { route: { kind: "runs" }, url: "/history" },
    { route: { kind: "runs", runId: RUN_ID }, url: `/#${RUN_ID}` },
    {
      route: { kind: "settings", section: "accounts" },
      url: "/#settings=accounts",
    },
    { route: { id: RUN_ID, kind: "run" }, url: `/#run=${RUN_ID}` },
    {
      route: { id: DELIVERY_ID, kind: "automatic" },
      url: `/#automatic=${DELIVERY_ID}`,
    },
  ];

  it("round-trips every address it writes", () => {
    for (const { route, url } of routes) {
      pushRoute(route);

      expect(address()).toBe(url);
      expect(readRoute()).toEqual(route);
      expect(readInitialRoute()).toEqual({ route });
    }
  });
});

describe("initialViewFor", () => {
  it("opens the GitHub connection the callback came back for", () => {
    expect(initialViewFor({ kind: "home" }, "installed")).toBe("settings");
  });

  it("lets an explicit link win over the callback destination", () => {
    // The callback appends its own query, and an address that names a screen
    // still names it: the retained `#automatic=` link is the screen to open.
    expect(
      initialViewFor({ id: DELIVERY_ID, kind: "automatic" }, "installed")
    ).toBe("automatic");
    expect(initialViewFor({ id: RUN_ID, kind: "run" }, "installed")).toBe(
      "run"
    );
    expect(initialViewFor({ kind: "runs", runId: RUN_ID }, "installed")).toBe(
      "runs"
    );
    expect(
      initialViewFor({ kind: "settings", section: "accounts" }, "installed")
    ).toBe("settings");
  });

  it("opens the screen the address names without a callback", () => {
    expect(initialViewFor({ kind: "home" })).toBe("home");
    expect(initialViewFor({ kind: "new" })).toBe("new");
  });
});
