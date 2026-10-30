import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { type PrContext, parsePrUrl } from "../src/github.js";
import { PolicySchema } from "../src/policy.js";
import { quotePickCorrection } from "../src/runner.js";
import { type Plan, PlanSchema } from "../src/schema.js";
import { lineAt } from "./fixture.js";

/**
 * Journal capturé : `runner.ts` crée son logger à l'import, donc seul un
 * `createLogger` factice rend la sortie de production observable. Chaque appel
 * conserve son message et ses métadonnées, ce qu'un test peut relire pour
 * vérifier ce qui a réellement été écrit.
 */
const logged = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@usecanary/logger", () => {
  function createLogger(): Record<string, unknown> {
    const record =
      (level: string) =>
      (bindings: Record<string, unknown>, message: string): void => {
        logged.push({ ...bindings, level, message });
      };
    return {
      debug: record("debug"),
      error: record("error"),
      fatal: record("fatal"),
      info: record("info"),
      trace: record("trace"),
      warn: record("warn"),
      child: createLogger,
    };
  }
  return { createLogger };
});

/**
 * Le cas du finding : la ligne recopiée depuis le dépôt testé porte une valeur
 * qui ressemble à un jeton. La correction par indice écrit la citation résolue
 * dans le plan — c'est voulu — mais ne doit jamais en recopier le texte dans le
 * journal de production, où `redact` ne connaît pas les secrets de ce dépôt.
 */
const TOKEN = "tok_live_9f3c1b7a2d4e";
const TOKEN_LINE = `const apiToken = "${TOKEN}";`;
const WITNESS_LINE = "export function submit(value) {";
/** Copie refusée : la citation réelle, refermée trop tôt — pas un témoin. */
const REFUSED_COPY = `const apiToken = "${TOKEN}:";`;

const context: PrContext = {
  baseSha: "2".repeat(40),
  body: "",
  context: [],
  contextWarnings: [],
  files: [
    {
      filename: "src/api.ts",
      patch: `${lineAt("src/api.ts", 12, TOKEN_LINE).patch}\n${lineAt("src/api.ts", 20, WITNESS_LINE).patch}`,
      status: "modified",
    },
  ],
  headRepo: "fixture/app",
  ref: parsePrUrl("https://github.com/fixture/app/pull/1"),
  sha: "1".repeat(40),
  title: "",
};
const config = loadConfig({});
const policy = PolicySchema.parse({ approvedSkips: [], version: 1 });

function planWithRefusedCopy(): Plan {
  return PlanSchema.parse({
    summary: "Resolve a refused copy that points at a token line",
    scenarios: [
      {
        assertions: [
          {
            afterStep: "observe",
            description: "The changed output is visible",
            id: "seen",
            kind: "visible",
            // `submit` est écrit par la ligne témoin du diff : la présence lit
            // ce que le diff produit (sinon OBJECTIVE_UNWITNESSED écarterait la
            // correction par indice que ce test journalise).
            target: { by: "css", value: "#submit" },
            verification: "state",
          },
        ],
        id: "token-flow",
        kind: "happy_path",
        preconditions: [],
        rationale: "Exercise the quote witness gate",
        requirements: [
          { behavior: "b", quote: WITNESS_LINE, sourceFile: "src/api.ts" },
          { behavior: "b", quote: REFUSED_COPY, sourceFile: "src/api.ts" },
        ],
        sourceFiles: ["src/api.ts"],
        steps: [
          {
            action: { type: "observe" },
            description: "Observe the page",
            id: "observe",
          },
          {
            action: { type: "assert", assertionId: "seen" },
            description: "Check the changed output",
            id: "check",
          },
        ],
        title: "Token flow",
      },
    ],
    skipped: [],
  });
}

it("never writes a resolved quote's text to the log", () => {
  const correction = quotePickCorrection(
    planWithRefusedCopy(),
    policy,
    context,
    config,
    "3f6f6f5f-0000-4000-8000-000000000000"
  );
  expect(correction).toBeDefined();
  logged.length = 0;
  const resolved = correction?.resolve({
    picks: [{ candidate: 1, requirement: 2, scenario: "token-flow" }],
  }) as Plan | undefined;
  // Le plan reçoit bien le texte réel de la ligne : c'est la correction
  // attendue, donc le texte a traversé ce chemin de code avant tout journal.
  expect(resolved?.scenarios[0]?.requirements[1]?.quote).toBe(TOKEN_LINE);
  const entries = logged.filter(
    (entry) => entry.message === "Requirement quote resolved by pick"
  );
  expect(entries).toHaveLength(1);
  const [entry] = entries;
  // Aucun fragment du texte résolu n'est journalisé, ni le jeton qu'il porte.
  const serialized = JSON.stringify(entry);
  expect(serialized).not.toContain(TOKEN);
  expect(serialized).not.toContain("apiToken");
  expect(serialized).not.toContain(TOKEN_LINE);
  // Les métadonnées sûres, elles, sont là : de quoi recouper deux runs.
  expect(entry).toMatchObject({
    line: 12,
    quoteChars: TOKEN_LINE.length,
    quoteFingerprint: createHash("sha256")
      .update(TOKEN_LINE)
      .digest("hex")
      .slice(0, 16),
    quoteLines: 1,
    requirement: 2,
    runId: "3f6f6f5f-0000-4000-8000-000000000000",
    scenario: "token-flow",
    sourceFile: "src/api.ts",
  });
});
