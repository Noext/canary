import { afterEach, describe, expect, it, vi } from "vitest";
import { apiErrors } from "@/i18n";
import { api, DashboardError, errorText } from "./client";

function respondWith(
  body: unknown,
  init: { ok?: boolean; status?: number } = {}
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          headers: { "Content-Type": "application/json" },
          status: init.status ?? 200,
        })
    )
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client", () => {
  it("explains an unreachable server with the shared copy", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("failed")));
    await expect(api("/models")).rejects.toThrow(apiErrors.unreachable);
  });

  it("reports a body that does not match the contract", async () => {
    respondWith({ unexpected: true });
    await expect(api("/models")).rejects.toThrow(apiErrors.contract);
  });

  it("keeps the server message and code, and adds the request reference", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: "PREVIEW_SHA_MISMATCH", error: "mismatch" }),
            {
              headers: { "X-Request-ID": "req-42" },
              status: 400,
            }
          )
      )
    );
    const failure = await api("/runs/preflight", {
      body: { model: "m", prUrl: "https://github.com/o/r/pull/1" },
      method: "POST",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DashboardError);
    const text = errorText(failure);
    expect(text).toContain("commit de cette PR");
    expect(text).toContain("Référence : req-42");
  });

  it("reports a non-JSON failure without inventing a code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>oops</html>", { status: 502 }))
    );
    await expect(api("/models")).rejects.toThrow(
      apiErrors.invalidResponse(502)
    );
  });

  it("shows the session to have expired on a 401 outside /auth", async () => {
    const expired = vi.fn();
    document.addEventListener("qa:session-expired", expired);
    respondWith({ error: "nope" }, { ok: false, status: 401 });
    await expect(api("/models")).rejects.toBeInstanceOf(DashboardError);
    expect(expired).toHaveBeenCalledTimes(1);
    document.removeEventListener("qa:session-expired", expired);
  });
});
