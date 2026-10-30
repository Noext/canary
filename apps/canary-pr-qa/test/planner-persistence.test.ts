import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Canary } from "../src/canary.js";
import { rejudge } from "../src/rejudge.js";
import { runQa } from "../src/runner.js";
import type { Plan } from "../src/schema.js";
import { serveArtifact } from "../src/server.js";
import { fixture, PR_URL, plan } from "./fixture.js";

/**
 * Au niveau du run : un plan hors schéma, dont la correction ne tient plus dans
 * l'enveloppe, laisse sur disque ce qu'il faut pour le rejuger gratuitement —
 * les entrées du planificateur et la réponse payée —, et `rejudge` reproduit
 * hors ligne exactement les violations que le run a opposées.
 */

const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(close.splice(0).map((fn) => fn()));
});

function fakeBrowser() {
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("fixture-session");
  vi.spyOn(Canary.prototype, "act").mockImplementation(async () => ({
    url: "http://fixture/",
    snapshot: "textbox Name, button Save",
  }));
  vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
}

/**
 * Un plan lisible qui viole le schéma du planificateur, assez lourd (~300 Ko)
 * pour que la réservation de sa correction dépasse l'enveloppe par défaut.
 */
function oversizedInvalidPlan(): Plan {
  const invalid = structuredClone(plan);
  invalid.summary = "x".repeat(300_000);
  invalid.scenarios[0]!.id = "not a safe id!";
  return invalid;
}

const mode = async (path: string) => (await stat(path)).mode % 0o1000;

describe("persistance du planificateur et rejugement hors ligne", () => {
  it("garde inputs.json et response-1.json, et rejudge reproduit les violations", async () => {
    const f = await fixture({ plans: [oversizedInvalidPlan()] });
    close.push(f.close);
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl, publish: false },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe("PLAN_SCHEMA_INVALID");
    expect(result.diagnostic?.message).toContain("Next model call not sent");
    expect(f.modelRequests).toHaveLength(1);

    const root = join(f.dataDir, result.id);
    const dir = join(root, "_planner");
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(join(dir, "inputs.json"))).toBe(0o600);
    expect(await mode(join(dir, "response-1.json"))).toBe(0o600);
    const inputsText = await readFile(join(dir, "inputs.json"), "utf8");
    expect(inputsText).not.toContain("fixture-token");
    expect(inputsText).not.toContain("fixture-api-token-123456789012345");
    const inputs = JSON.parse(inputsText);
    expect(inputs.context.sha).toBe(result.sha);
    expect(inputs.evidence).toEqual({
      aria: expect.any(String),
      url: expect.any(String),
    });
    expect(inputs.payload).toBeTypeOf("object");
    expect(inputs.validationConfig.QA_MAX_SCENARIOS).toBe(
      f.config.QA_MAX_SCENARIOS
    );
    expect(inputs.model).toMatchObject({
      OPENAI_MODEL: "fixture-scripted-model",
      QA_PLAN_MAX_TOKENS: f.config.QA_PLAN_MAX_TOKENS,
    });
    expect(inputs.model.baseUrlHost).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(JSON.stringify(inputs.model)).not.toContain("/v1");

    const response = JSON.parse(
      await readFile(join(dir, "response-1.json"), "utf8")
    );
    expect(response.call).toBe(1);
    expect(response.content).toContain('"not a safe id!"');
    expect(response.contentChars).toBeGreaterThan(300_000);
    expect(response.verdict.kind).toBe("schema");
    expect(response.verdict.issues.length).toBeGreaterThanOrEqual(2);

    // L'événement nomme la réponse et son verdict, jamais son contenu.
    const events = await readFile(join(root, "events.jsonl"), "utf8");
    const recorded = events
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.modelResponse);
    expect(recorded.at(-1).modelResponse).toMatchObject({
      call: 1,
      file: "_planner/response-1.json",
      verdict: "schema",
    });
    expect(events).not.toContain("not a safe id!");

    // Rejugement gratuit : aucun envoi réseau n'est permis.
    const network = vi.fn(() => {
      throw new Error("rejudge must stay offline");
    });
    vi.stubGlobal("fetch", network);
    const rejudged = await rejudge(root, undefined, f.config);
    expect(network).not.toHaveBeenCalled();
    expect(rejudged.accepted).toBe(false);
    expect(rejudged.responses).toHaveLength(1);
    expect(rejudged.responses[0]).toMatchObject({
      call: 1,
      recordedVerdict: "schema",
      verdict: { kind: "schema", issues: response.verdict.issues },
    });
    const single = await rejudge(root, 1, f.config);
    expect(single.responses[0]?.verdict).toEqual(
      rejudged.responses[0]?.verdict
    );
    vi.unstubAllGlobals();

    // Ces fichiers ne sont jamais servis par la route des artefacts.
    await expect(
      serveArtifact(
        {} as ServerResponse,
        f.config,
        result.id,
        "_planner/inputs.json"
      )
    ).rejects.toThrow("Artifact path is not allowed");
  }, 60_000);

  it("rejuge un plan valide refusé par la porte, avec la correction du run", async () => {
    const refused = structuredClone(plan);
    refused.scenarios[0]!.requirements[0]!.quote = "show('Welcome '+nom)";
    const f = await fixture({ plans: [refused, plan] });
    close.push(f.close);
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl, publish: false },
      f.config
    );
    const root = join(f.dataDir, result.id);
    const first = JSON.parse(
      await readFile(join(root, "_planner", "response-1.json"), "utf8")
    );
    expect(first.verdict.kind).toBe("gate");
    const rejudged = await rejudge(root, 1, f.config);
    const verdict = rejudged.responses[0]?.verdict as {
      kind: string;
      refusal: string;
    };
    expect(verdict.kind).toBe("gate");
    expect(verdict.refusal).toBe(first.verdict.refusal);
    const second = await rejudge(root, 2, f.config);
    expect(second.responses[0]?.verdict.kind).toBe("accepted");
    expect(second.responses[0]?.reproducible).toBe(true);
    expect(second.accepted).toBe(true);

    // Rejugement d'un dossier dont aucune réponse n'est rejugeable : une réponse
    // contrainte et une capture coupée sont `skipped`, et rien n'est accepté.
    const copy = await mkdtemp(join(tmpdir(), "rejudge-skipped-"));
    await mkdir(join(copy, "_planner"));
    await copyFile(
      join(root, "_planner", "inputs.json"),
      join(copy, "_planner", "inputs.json")
    );
    const accepted = JSON.parse(
      await readFile(join(root, "_planner", "response-2.json"), "utf8")
    );
    await writeFile(
      join(copy, "_planner", "response-1.json"),
      JSON.stringify({ ...accepted, call: 1, constrained: true })
    );
    await writeFile(
      join(copy, "_planner", "response-2.json"),
      JSON.stringify({ ...accepted, contentTruncated: true })
    );
    const skipped = await rejudge(copy, undefined, f.config);
    expect(skipped.responses.map((item) => item.verdict.kind)).toEqual([
      "skipped",
      "skipped",
    ]);
    expect(
      (skipped.responses[1]?.verdict as { reason: string }).reason
    ).toContain("cut at capture");
    expect(skipped.accepted).toBe(false);
    await rm(copy, { recursive: true, force: true });
  }, 60_000);

  it("ne déclare jamais reproductible un verdict rendu sur des entrées masquées", async () => {
    // La ligne du diff porte un jeton : le run juge sur le contexte brut, le
    // modèle n'a vu que `Bearer [REDACTED]`, et c'est ce qu'il cite.
    const line = "show('Welcome '+name) // Bearer tok123 fixture-token";
    const quoted = structuredClone(plan);
    quoted.scenarios[0]!.requirements[0]!.quote =
      "show('Welcome '+name) // Bearer [REDACTED] [REDACTED]";
    const f = await fixture({
      formPatch: `- show('Hello')\n+ ${line}`,
      plans: [quoted, plan],
    });
    close.push(f.close);
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl, publish: false },
      f.config
    );
    const root = join(f.dataDir, result.id);
    const inputsText = await readFile(
      join(root, "_planner", "inputs.json"),
      "utf8"
    );
    expect(inputsText).not.toContain("fixture-token");
    expect(inputsText).not.toContain("tok123");
    expect(inputsText).toContain("Bearer [REDACTED]");
    const first = JSON.parse(
      await readFile(join(root, "_planner", "response-1.json"), "utf8")
    );
    expect(first.verdict.kind).toBe("gate");
    const rejudged = await rejudge(root, 1, f.config);
    expect(rejudged.responses[0]?.reproducible).toBe(false);
    expect(rejudged.responses[0]?.unreproducible).toMatch(/redact/i);
    expect(rejudged.accepted).toBe(false);
  }, 60_000);
});
