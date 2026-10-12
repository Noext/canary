import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunDetailStore } from "./run-detail-store";

const apiMock = vi.fn();

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/client")>()),
  api: (...args: unknown[]) => apiMock(...args),
}));

const RUN_ID = "11111111-1111-1111-1111-111111111111";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = 0;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.readyState = 2;
  }
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    cancel_requested: false,
    created_at: "2026-01-01T00:00:00.000Z",
    id: RUN_ID,
    input: { model: "model-x" },
    owner: "admin",
    pr: 1,
    repo: "fixture/app",
    sha: "1".repeat(40),
    status: "running",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function onlySource(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (!source) {
    throw new Error("No EventSource was created");
  }
  return source;
}

/** A promise the test settles by hand, to land an answer after a teardown. */
function deferred<T>() {
  let fail: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((_resolve, reject) => {
    fail = reject;
  });
  return { fail: (reason: unknown) => fail(reason), promise };
}

/** Drains every microtask queued so far, rejection chains included. */
function settle() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  apiMock.mockReset();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRunDetailStore subscription", () => {
  it("follows the run while a listener remains and closes with the last one", async () => {
    apiMock.mockResolvedValue(job());
    const store = createRunDetailStore({ report: vi.fn(), runId: RUN_ID });

    const releaseFirst = store.subscribe(() => undefined);
    const releaseSecond = store.subscribe(() => undefined);
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = onlySource();
    expect(source.url).toBe(`/runs/${RUN_ID}/events`);

    source.onopen?.();
    expect(store.getSnapshot().live).toBe("Suivi en direct connecté");

    // One listener left: the follow is still needed by the screen.
    releaseFirst();
    expect(source.readyState).toBe(0);

    releaseSecond();
    expect(source.readyState).toBe(2);
  });

  it("reopens the stream for the subscription StrictMode replays", async () => {
    apiMock.mockResolvedValue(job());
    const store = createRunDetailStore({ report: vi.fn(), runId: RUN_ID });

    const release = store.subscribe(() => undefined);
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    release();
    expect(onlySource().readyState).toBe(2);

    store.subscribe(() => undefined);
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(onlySource().readyState).toBe(0);
    // The stream is the resource that is re-acquired; the snapshot survives,
    // so a remount never flashes the previous, empty state.
    expect(store.getSnapshot().job?.id).toBe(RUN_ID);
  });

  it("never reports a failure that lands after the last listener left", async () => {
    const pending = deferred<never>();
    apiMock.mockImplementation(() => pending.promise);
    const report = vi.fn();
    const store = createRunDetailStore({ report, runId: RUN_ID });

    const release = store.subscribe(() => undefined);
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalled());
    release();

    pending.fail(new Error("Run not found"));
    await settle();

    expect(report).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
