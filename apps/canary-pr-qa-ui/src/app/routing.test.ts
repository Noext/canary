import { beforeEach, describe, expect, it } from "vitest";
import {
  initialViewFor,
  pushRoute,
  type Route,
  readInitialRoute,
  readRoute,
  routeUrl,
} from "./routing";

const RUN_ID = "74422b90-c70a-11f1-8b8c-69d5033ed7fd";
const DELIVERY_ID = "delivery:01J8Z";

/** Puts the document at `url` the way a browser would, hash included. */
function open(url: string) {
  window.history.replaceState(null, "", url);
}

/** The path and hash of the current document, without its origin. */
function address(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

beforeEach(() => {
  open("/");
});

describe("readInitialRoute", () => {
  it("reads the history list from its path", () => {
    open("/history");

    expect(readInitialRoute()).toEqual({ route: { kind: "runs" } });
    expect(address()).toBe("/history");
  });

  it("reads the selected run from the history path", () => {
    open(`/history/${RUN_ID}`);

    expect(readInitialRoute()).toEqual({
      route: { kind: "runs", runId: RUN_ID },
    });
    // The selection lives in the path: a reload or a shared link reopens the
    // same detail, which a fragment could only do while the document stayed.
    expect(address()).toBe(`/history/${RUN_ID}`);
  });

  it("reads the full report from its own path", () => {
    open(`/history/${RUN_ID}/report`);

    expect(readInitialRoute()).toEqual({ route: { id: RUN_ID, kind: "run" } });
    expect(address()).toBe(`/history/${RUN_ID}/report`);
  });

  it("reads an automatic attempt from its path", () => {
    open(`/automatic/${DELIVERY_ID}`);

    expect(readInitialRoute()).toEqual({
      route: { id: DELIVERY_ID, kind: "automatic" },
    });
  });

  it("reads a settings page from its path", () => {
    open("/settings/accounts");

    expect(readInitialRoute()).toEqual({
      route: { kind: "settings", section: "accounts" },
    });
  });

  it("discards a settings path this build does not have", () => {
    open("/settings/nope");

    expect(readInitialRoute()).toEqual({ route: { kind: "home" } });
  });

  it("reads the test page from its path", () => {
    open("/new-test");

    expect(readInitialRoute()).toEqual({ route: { kind: "new" } });
    expect(address()).toBe("/new-test");
  });

  it("corrects a trailing slash onto the canonical path", () => {
    open("/history/");

    expect(readInitialRoute()).toEqual({ route: { kind: "runs" } });
  });

  it("falls back home on a path the server never served this dashboard for", () => {
    open("/ancien-chemin");

    expect(readInitialRoute()).toEqual({ route: { kind: "home" } });
  });

  it("falls back home on an identifier no screen can carry", () => {
    open("/history/tronque");

    expect(readInitialRoute()).toEqual({ route: { kind: "home" } });
  });
});

describe("legacy fragment links", () => {
  /**
   * Les liens écrits avant les chemins continuent d'ouvrir le même écran, et le
   * chargement les réécrit : la barre d'adresse ne garde que la page.
   */
  const legacy: { route: Route; url: string; legacyHash: string }[] = [
    {
      route: { kind: "runs", runId: RUN_ID },
      url: `/history/${RUN_ID}`,
      legacyHash: `#${RUN_ID}`,
    },
    {
      route: { id: RUN_ID, kind: "run" },
      url: `/history/${RUN_ID}/report`,
      legacyHash: `#run=${RUN_ID}`,
    },
    {
      route: { id: DELIVERY_ID, kind: "automatic" },
      url: `/automatic/${DELIVERY_ID}`,
      legacyHash: `#automatic=${DELIVERY_ID}`,
    },
    {
      route: { kind: "settings", section: "accounts" },
      url: "/settings/accounts",
      legacyHash: "#settings=accounts",
    },
  ];

  it("opens the same screen and rewrites the address onto its path", () => {
    for (const { route, url, legacyHash } of legacy) {
      open(`/${legacyHash}`);

      expect(readInitialRoute()).toEqual({ route });
      expect(address()).toBe(url);
    }
  });

  it("drops a fragment this dashboard never wrote", () => {
    open("/#whatever");

    expect(readInitialRoute()).toEqual({ route: { kind: "home" } });
    expect(address()).toBe("/");
  });

  it("discards a legacy settings fragment to a page this build does not have", () => {
    open("/#settings=nope");

    expect(readInitialRoute()).toEqual({ route: { kind: "home" } });
    expect(address()).toBe("/");
  });

  it("erases a temporary setup code after reading it", () => {
    open("/#setup=secret-code");

    expect(readInitialRoute()).toEqual({
      route: { kind: "home" },
      setupCode: "secret-code",
    });
    expect(address()).toBe("/");
  });

  it("drops the GitHub callback query without dropping the screen link", () => {
    open(`/?github=connected#automatic=${DELIVERY_ID}`);

    expect(readInitialRoute()).toEqual({
      github: "connected",
      route: { id: DELIVERY_ID, kind: "automatic" },
    });
    expect(address()).toBe(`/automatic/${DELIVERY_ID}`);
  });

  it("keeps the path when a fragment is the only thing to drop", () => {
    open("/history#whatever");

    expect(readInitialRoute()).toEqual({ route: { kind: "runs" } });
    expect(address()).toBe("/history");
  });
});

describe("routeUrl", () => {
  const routes: { route: Route; url: string }[] = [
    { route: { kind: "home" }, url: "/" },
    { route: { kind: "new" }, url: "/new-test" },
    { route: { kind: "runs" }, url: "/history" },
    { route: { kind: "runs", runId: RUN_ID }, url: `/history/${RUN_ID}` },
    {
      route: { kind: "settings", section: "accounts" },
      url: "/settings/accounts",
    },
    { route: { id: RUN_ID, kind: "run" }, url: `/history/${RUN_ID}/report` },
    {
      route: { id: DELIVERY_ID, kind: "automatic" },
      url: `/automatic/${DELIVERY_ID}`,
    },
  ];

  it("writes a path for every screen", () => {
    for (const { route, url } of routes) {
      expect(routeUrl(route)).toBe(url);
    }
  });

  it("round-trips every address it writes", () => {
    for (const { route, url } of routes) {
      open(url);
      expect(readRoute()).toEqual(route);

      open("/");
      pushRoute(route);
      expect(address()).toBe(url);
      expect(readInitialRoute()).toEqual({ route });
    }
  });

  it("does not push the address the bar already carries", () => {
    open("/history");
    const before = window.history.length;
    pushRoute({ kind: "runs" });

    expect(window.history.length).toBe(before);
  });
});

describe("initialViewFor", () => {
  it("opens the GitHub connection the callback came back for", () => {
    expect(initialViewFor({ kind: "home" }, "installed")).toBe("settings");
  });

  it("lets an explicit link win over the callback destination", () => {
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
