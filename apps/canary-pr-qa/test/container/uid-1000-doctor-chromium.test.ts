import { afterEach, describe, expect, it } from "vitest";
import { PR_URL } from "../fixture.js";
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
    it("starts under UID 1000 with new writable volumes, runs doctor and a real Chromium test, persists evidence across restart", async () => {
      const s = await container();
      expect(
        (
          await s.compose(
            "exec",
            "-T",
            "pr-qa",
            "node",
            "-e",
            "process.stdout.write(String(process.getuid()))"
          )
        ).stdout
      ).toBe("1000");
      const checked = JSON.parse(
        (
          await s.compose(
            "exec",
            "-T",
            "pr-qa",
            "canary-pr-qa",
            "doctor",
            "--json",
            "--pr",
            PR_URL,
            "--preview",
            s.inside
          )
        ).stdout
      );
      expect(checked.healthy, JSON.stringify(checked.checks)).toBe(true);
      expect(
        checked.checks.every((c: { status: string }) => c.status === "passed")
      ).toBe(true);
      // The documented `./scripts/pr-qa doctor` runs inside `worker`, so the policy
      // probe must test the shared volume there and not an environment-only
      // fallback: an unwritable qa-policy volume would leave browser/egress stale.
      const workerChecked = JSON.parse(
        (
          await s.compose(
            "exec",
            "-T",
            "worker",
            "canary-pr-qa",
            "doctor",
            "--json",
            "--skip-browser",
            "--pr",
            PR_URL,
            "--preview",
            s.inside
          )
        ).stdout
      );
      const policyCheck = workerChecked.checks.find(
        (check: { name: string }) => check.name === "preview-policy"
      );
      expect(policyCheck, JSON.stringify(workerChecked.checks)).toMatchObject({
        status: "passed",
      });
      expect(String(policyCheck.message)).toContain(
        "host(s) published and readable"
      );
      expect(
        (await fetch(`${s.url}/runs`, { method: "POST", body: "{}" })).status
      ).toBe(401);
      const { accepted, result } = await execute(s);
      expect(result.outcome, JSON.stringify(result)).toBe("passed");
      expect(result.scenarios[0]?.assertions[0]?.actual).toBe("Welcome Ada");
      for (const extension of [".webm", ".zip", ".har", ".png"]) {
        const file = result.scenarios[0]?.artifacts.find((path) =>
          path.endsWith(extension)
        );
        expect(file).toBeDefined();
        const artifact = await fetch(
          `${s.url}/artifacts/${accepted.id}/welcome/${file}`,
          { headers: s.headers }
        );
        if ([".zip", ".har"].includes(extension)) {
          expect(artifact.status).toBe(403);
          // Raw files must exist, while default project policy prevents HTTP disclosure.
          const size = await s.compose(
            "exec",
            "-T",
            "pr-qa",
            "node",
            "-e",
            `process.stdout.write(String(require('node:fs').statSync(${JSON.stringify(`/data/${accepted.id}/welcome/${file}`)}).size))`
          );
          expect(Number(size.stdout)).toBeGreaterThan(0);
        } else {
          expect(artifact.ok, `${extension}: HTTP ${artifact.status}`).toBe(
            true
          );
          expect((await artifact.arrayBuffer()).byteLength).toBeGreaterThan(0);
        }
      }
      expect(
        s.outgoing.map((request) => request.payload.state).filter(Boolean)
      ).toEqual(["pending", "success"]);
      const support = (
        await s.compose(
          "exec",
          "-T",
          "pr-qa",
          "canary-pr-qa",
          "diagnose",
          accepted.id
        )
      ).stdout;
      expect(JSON.parse(support).result.outcome).toBe("passed");
      expect(support).not.toContain("Welcome Ada");
      const localCookie = await localAccountFlow(s);
      const publications = s.outgoing.length;
      await s.compose("restart", "pr-qa");
      await s.waitHealthy();
      expect(
        await (
          await fetch(`${s.url}${accepted.statusUrl}`, { headers: s.headers })
        ).json()
      ).toMatchObject({ status: "completed", progress: { phase: "done" } });
      expect(s.outgoing.length).toBe(publications);
      expect(
        (await fetch(`${s.url}/me`, { headers: { Cookie: localCookie } }))
          .status
      ).toBe(200);
    }, 180_000);
  }
);
