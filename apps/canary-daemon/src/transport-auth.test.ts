import { daemonTcpConfig } from "@usecanary/protocol";
import { describe, expect, it } from "vitest";
import { authenticTransportRequest } from "./transport-auth.js";

describe("opt-in authenticated loopback transport", () => {
  const token = "test-only-token-with-at-least-32-characters";
  it("retains native transport without a port", () => {
    expect(daemonTcpConfig({})).toBeUndefined();
  });
  it("requires a valid non-privileged port and a token", () => {
    for (const port of ["-1", "0", "80", "65536", "1e4", "host:4000"]) {
      expect(() =>
        daemonTcpConfig({
          CANARY_DAEMON_PORT: port,
          CANARY_DAEMON_TOKEN: token,
        })
      ).toThrow();
    }
    expect(() => daemonTcpConfig({ CANARY_DAEMON_PORT: "18473" })).toThrow();
    expect(
      daemonTcpConfig({
        CANARY_DAEMON_PORT: "18473",
        CANARY_DAEMON_TOKEN: token,
      })?.host
    ).toBe("127.0.0.1");
  });
  it("rejects missing, malformed, wrong or Unicode tokens", () => {
    for (const line of [
      "broken",
      "null",
      "{}",
      JSON.stringify({ transportToken: "wrong" }),
      JSON.stringify({ transportToken: "é".repeat(token.length) }),
    ]) {
      expect(authenticTransportRequest(line, token)).toBe(false);
    }
    expect(
      authenticTransportRequest(
        JSON.stringify({ id: "x", type: "status", transportToken: token }),
        token
      )
    ).toBe(true);
  });
});
