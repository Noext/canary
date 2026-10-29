import { afterEach, describe, expect, it } from "vitest";
import { PREVIEW_POLICY_FILE } from "../../src/preview-hosts.js";
import {
  containerHarness,
  execute,
  image,
  localAccountFlow,
} from "./helpers.js";

const { cleanup, container } = containerHarness();
// Compose teardown runs concurrently with the two sibling spec files, so the
// default 10 s hook budget aborts it mid-flight and leaks volumes.
afterEach(cleanup, 120_000);

describe.skipIf(!image)(
  "first installation of the production Compose image",
  () => {
    it("boots without a PAT, connects the App and runs through the worker after API/worker restart", async () => {
      const s = await container(false, true);
      const cookie = await localAccountFlow(s);
      const auth = { ...s.headers, Cookie: cookie };
      const registration = (await (
        await fetch(`${s.url}/github/app/manifest`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ name: "Canary Compose fixture" }),
        })
      ).json()) as { action: string };
      const state = new URL(registration.action).searchParams.get("state")!;
      expect(
        (
          await fetch(
            `${s.url}/github/app/callback?state=${state}&code=fixture-manifest-code`,
            { headers: auth, redirect: "manual" }
          )
        ).status
      ).toBe(303);
      expect(
        (
          await fetch(`${s.url}/github/app/repositories`, {
            method: "PUT",
            headers: auth,
            body: JSON.stringify({ repositories: ["fixture/app"] }),
          })
        ).status
      ).toBe(200);
      // The administrator edits the preview host allowlist in the dashboard. The
      // saved list is published to the volume the browser and egress containers
      // mount read-only, and it must survive an API restart.
      const extraHost = "extra.preview.invalid";
      const saved = (await (
        await fetch(`${s.url}/dashboard/preview-hosts`, {
          method: "PUT",
          headers: auth,
          body: JSON.stringify({
            hosts: [new URL(s.inside).host, extraHost],
          }),
        })
      ).json()) as { hosts: string[] };
      expect(saved.hosts).toEqual([new URL(s.inside).host, extraHost]);
      const policy = async () =>
        (
          await s.compose(
            "exec",
            "-T",
            "egress",
            "cat",
            `/policy/${PREVIEW_POLICY_FILE}`
          )
        ).stdout;
      expect(JSON.parse(await policy())).toMatchObject({
        hosts: [new URL(s.inside).host, extraHost],
      });
      await s.compose("restart", "pr-qa", "worker");
      await s.waitHealthy();
      // A restart republishes the stored list instead of dropping back to the
      // environment default the containers were started with.
      expect(JSON.parse(await policy())).toMatchObject({
        hosts: [new URL(s.inside).host, extraHost],
      });
      const status = (await (
        await fetch(`${s.url}/github/app`, { headers: auth })
      ).json()) as { app: { id: string } };
      expect(status.app.id).toBe("95001");
      const result = await execute(s);
      expect(result.result.outcome, JSON.stringify(result.result)).toBe(
        "passed"
      );
      expect(
        s.outgoing.some((request) => request.payload.state === "success")
      ).toBe(true);
    }, 180_000);
  }
);
