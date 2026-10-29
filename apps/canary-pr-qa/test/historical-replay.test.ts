import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runReplay } from "../src/replay.js";

/**
 * Rejeu **offline** (mode `gate`, sans modèle ni navigateur) des runs
 * réellement échoués dont le plan a été conservé : 18 des 79 plans stockés dans
 * `test/historical/plans.json.gz` ont au moins un scénario non vert.
 *
 * Ce que le rejeu prouve, et ce qu'il ne prouve pas :
 *
 * - il prouve ce que la porte déterministe fait AUJOURD'HUI de ces plans réels ;
 * - il ne prouve pas le verdict d'exécution : aucun instantané ARIA n'a été
 *   conservé avec les plans, donc `evidence.aria` est vide et la porte rend
 *   `unproven` (jamais `accepted`) — c'est exactement le contrat rendu explicite
 *   par le correctif du verdict de rejeu, et il est vérifié ici sur des données
 *   réelles, pas sur une fixture inventée.
 *
 * Les trois familles ci-dessous sont mesurées, pas supposées :
 *
 * 1. `MARKER_ORDER` : le scénario qui a échoué est refusé avant exécution par la
 *    règle de borne de commentaire (« holds N characters and the limit that
 *    decides this value is … », « the last write in … »). L'échec est prévenu.
 * 2. `BROWSER` : aucune preuve statique possible (cible absente après
 *    navigation, transition à constater) : la porte ne refuse RIEN. Inventer un
 *    refus ici serait un faux refus.
 * 3. `OTHER_RULE` : le run est refusé, mais pour un autre motif que l'échec
 *    observé ; le scénario fautif n'est pas nommé. On fige ce fait au lieu de le
 *    présenter comme une correction.
 */

const here = dirname(fileURLToPath(import.meta.url));
const historical = join(here, "historical");

interface StoredPlan {
  plan: unknown;
  run: string;
  scenarios?: { id: string; outcome: string }[];
}

interface Snapshot {
  baseSha: string;
  files: unknown[];
  headSha: string;
  number: number;
  title: string;
}

const snapshot = JSON.parse(
  gunzipSync(readFileSync(join(historical, "pr20.json.gz"))).toString()
) as Snapshot;
const plans = JSON.parse(
  gunzipSync(readFileSync(join(historical, "plans.json.gz"))).toString()
) as StoredPlan[];

const PR_URL = "https://github.com/pharmania/arpilabe-pilotage/pull/20";

/** Le scénario historiquement fautif est refusé par la règle de borne. */
const MARKER_ORDER: [string, string][] = [
  ["f83f0762-a58e-4839-9699-a7656c93341c", "cash-commentaire-borne-280"],
  ["24db19b8-fc22-4cfb-9b6c-44caaedcc3fb", "caisse-commentaire-borne-281-280"],
  ["b5711fb7-dc32-4307-8eac-c607f4778208", "cash-comment-boundary-281-280"],
  ["8a16f402-7316-446d-9387-08974707e9d2", "borne-commentaire-280-281"],
  ["d07c4ed4-8c34-4f0e-94c1-fb7d04f30c94", "borne-commentaire-281-280"],
  [
    "7900e46d-cd65-4034-a4b4-486c5a52507b",
    "justification-comment-length-boundary-281-280",
  ],
  ["6832a9e4-ad59-4963-ac9e-edb194179912", "cash-justification-boundary"],
  ["5afc804a-5d22-4867-a593-66a3d4df3da3", "cash-comment-length-boundary"],
  ["437ec805-86fe-4e4f-b563-8995edb823ad", "caisse-justification-borne"],
  [
    "6e3f63fa-9c76-487e-bd7d-331c3422296c",
    "cash-justification-comment-boundary",
  ],
];

/** L'échec ne se constate qu'à l'exécution : la porte ne doit rien inventer. */
const BROWSER: [string, string][] = [
  ["afcc9846-ec93-4cde-8ecf-77c01d433c82", "cash-history-and-reopen"],
  [
    "b8818582-62e3-4064-a5d7-bbefa9d2a7ca",
    "cash-comptage-invalide-indisponible",
  ],
  [
    "bed1253d-78c9-412c-b58b-b8fa56ca43e2",
    "cash-reblocage-apres-retrait-justification",
  ],
  [
    "28525781-e499-4ca7-a9f9-19152e973ed0",
    "cash-comptage-invalide-sans-ecart-fabrique",
  ],
  [
    "160792a9-c627-4e3d-a511-822d06ded918",
    "caisse-excedent-50-justifie-cloture",
  ],
];

/** Le run est refusé, mais pas pour l'échec observé. */
const OTHER_RULE: [string, string][] = [
  ["f5ecbaac-babb-451c-824e-f296bf0c0969", "cash-comment-boundary-281-280"],
  ["cd62137e-5d8f-4176-9061-1ff5ed23ab97", "caisse-commentaire-borne-281-280"],
  ["ca55513b-ec2c-4407-8def-9554378e02fe", "caisse-manque-justifie-histoire"],
];

const LIMIT_RULE =
  /holds \d+ characters and the limit that decides this value is|the last write in/;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** Le bundle réel du plan stocké ; l'enveloppe est reconstruite, pas les données. */
function bundleOf(run: string) {
  const stored = plans.find((entry) => entry.run === run);
  if (!stored) {
    throw new Error(`plan ${run} absent de plans.json`);
  }
  return {
    version: 1,
    createdAt: "2026-10-27T00:00:00.000Z",
    source: {
      prUrl: PR_URL,
      repo: "pharmania/arpilabe-pilotage",
      number: 20,
      headSha: snapshot.headSha,
      baseSha: snapshot.baseSha,
      model: "opencode-go/deepseek-v4.1-flash",
    },
    validationConfig: {
      QA_MAX_SCENARIOS: 20,
      QA_MAX_STEPS: 40,
      QA_PER_SCENARIO_COVERAGE: false,
    },
    context: {
      baseSha: snapshot.baseSha,
      body: "",
      context: [],
      contextWarnings: [],
      files: snapshot.files,
      headRepo: "pharmania/arpilabe-pilotage",
      ref: { repo: "pharmania/arpilabe-pilotage", number: 20, url: PR_URL },
      sha: snapshot.headSha,
      title: snapshot.title,
    },
    policy: { version: 1 },
    catalog: { fixtures: {}, roles: [], visuals: [] },
    payload: {},
    generatedPlan: stored.plan,
    plan: stored.plan,
    evidence: { url: "https://20.arpilabe.pharmania.fr/", aria: "" },
  };
}

async function replay(run: string) {
  const directory = await mkdtemp(join(tmpdir(), "canary-historical-replay-"));
  cleanups.push(() => rm(directory, { force: true, recursive: true }));
  const path = join(directory, `${run}.json`);
  await writeFile(path, JSON.stringify(bundleOf(run)), "utf8");
  return runReplay(path, "gate", loadConfig({ QA_DATA_DIR: directory }));
}

describe("rejeu offline des runs réellement échoués", () => {
  it("couvre les 18 plans stockés dont un scénario n'était pas vert", () => {
    const nonGreen = plans.filter((entry) =>
      (entry.scenarios ?? []).some((item) => item.outcome !== "passed")
    );
    expect(nonGreen).toHaveLength(18);
    expect(MARKER_ORDER.length + BROWSER.length + OTHER_RULE.length).toBe(18);
  });

  for (const [run, scenario] of MARKER_ORDER) {
    it(`${run.slice(0, 8)} : ${scenario} est refusé avant exécution`, async () => {
      const result = await replay(run);
      expect(result.verdict).toBe("refused");
      const mine = result.refusals.filter((refusal) =>
        refusal.includes(scenario)
      );
      expect(
        mine.length,
        result.refusals.join("\n").slice(0, 400)
      ).toBeGreaterThan(0);
      expect(mine.join("\n")).toMatch(LIMIT_RULE);
    });
  }

  for (const [run, scenario] of BROWSER) {
    it(`${run.slice(0, 8)} : ${scenario} n'est pas refusé par une preuve statique`, async () => {
      const result = await replay(run);
      // Aucune preuve statique possible : refuser ici serait un faux refus.
      expect(result.refusals).toEqual([]);
      // Et la porte ne prétend pas avoir conclu : aucun instantané de page.
      expect(result.verdict).toBe("unproven");
      expect(result.inconclusive.join(" ")).toMatch(/instantané de découverte/);
      expect(result.refusals.some((item) => item.includes(scenario))).toBe(
        false
      );
    });
  }

  for (const [run, scenario] of OTHER_RULE) {
    it(`${run.slice(0, 8)} : le run est refusé, ${scenario} n'est pas nommé`, async () => {
      const result = await replay(run);
      expect(result.verdict).toBe("refused");
      // Le refus vient d'une autre règle : ne pas le présenter comme la
      // correction de l'échec observé.
      expect(result.refusals.some((item) => item.includes(scenario))).toBe(
        false
      );
    });
  }

  it("ne prononce jamais `accepted` sans preuve de page", async () => {
    for (const [run] of [...MARKER_ORDER, ...BROWSER, ...OTHER_RULE]) {
      const result = await replay(run);
      expect(result.verdict, run).not.toBe("accepted");
    }
  }, 60_000);
});
