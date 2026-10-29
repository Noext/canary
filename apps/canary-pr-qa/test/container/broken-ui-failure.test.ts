import { afterEach, describe, expect, it } from "vitest";
import { containerHarness, execute, image } from "./helpers.js";

const { cleanup, container } = containerHarness();
// Compose teardown runs concurrently with the two sibling spec files, so the
// default 10 s hook budget aborts it mid-flight and leaks volumes.
afterEach(cleanup, 120_000);

describe.skipIf(!image)(
  "first installation of the production Compose image",
  () => {
    it("detects a real broken UI inside the production image and posts failure with video evidence", async () => {
      const s = await container(true);
      const { result } = await execute(s);
      expect(result.outcome, JSON.stringify(result)).toBe("failed");
      expect(result.scenarios[0]?.assertions[0]).toMatchObject({
        passed: false,
        actual: "Wrong output",
      });
      expect(
        result.scenarios[0]?.artifacts.some((file) => file.endsWith(".webm"))
      ).toBe(true);
      expect(
        s.outgoing.filter((request) => request.payload.state).at(-1)?.payload
          .state
      ).toBe("failure");
    }, 180_000);
  }
);
