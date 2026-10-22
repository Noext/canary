import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { type PrContext, parsePrUrl } from "../src/github.js";
import {
  PolicySchema,
  requirementHasWitness,
  sourceLineMaterial,
  ungroundedRequirement,
  ungroundedRequirements,
  validateCoverage,
} from "../src/policy.js";
import { quotePickCorrection } from "../src/runner.js";
import {
  PlanSchema,
  plannerPlanSchema,
  resolveLineReference,
} from "../src/schema.js";
import { lineAt } from "./fixture.js";

const PAGE = "apps/web/app/page.tsx";
const INDEX = "packages/domain/src/index.ts";
const WEB_AGENTS = "apps/web/AGENTS.md";
const DOMAIN_AGENTS = "packages/domain/AGENTS.md";
const SHA = "814b671305b005ab516db66bc3da1d8239bcef16";
const config = loadConfig({});
const policy = PolicySchema.parse({ approvedSkips: [], version: 1 });

/**
 * Les lignes réelles du run d6679230, copiées du diff de la PR au SHA testé
 * (`814b6713`) : la ligne 15 de `apps/web/AGENTS.md` porte l'identifiant refusé
 * `caisse-comptage-ecart`, la ligne 6 de `packages/domain/AGENTS.md` porte le
 * chemin refusé `src/cash.ts`. Les deux lignes de `page.tsx` et celle de
 * `index.ts` sont les citations déjà acceptées du même scénario : le rejeu
 * n'isole donc pas le refus de son voisinage, il reprend le plan mesuré.
 */
const MEASURED_LINES: { file: string; line: number; text: string }[] = [
  {
    file: WEB_AGENTS,
    line: 15,
    text: "| `app/page.tsx` | UI prototype, référentiel/profils synthétiques et route `/api/demo` ; calculs/scopes non production ; vue Caisse et Coffre : comptage par dénomination via `@arpilabe/domain` (centimes entiers), écart compté − attendu, justification obligatoire si l'écart n'est pas nul, clôture qui verrouille puis réouverture, comptage conservé par pharmacie entre les vues ; See change: pipeline-developpement-ia, caisse-comptage-ecart. |",
  },
  {
    file: DOMAIN_AGENTS,
    line: 6,
    text: "| `src/cash.ts` | Comptage des espèces en centimes entiers : quantités par dénomination, sous-total, total, unités, écart signé, décision de clôture, conversions euros ⇄ centimes ; le montant attendu est une donnée, aucune ventilation, tolérance ni règle de rapprochement n'est inventée ; exporté par `src/index.ts` ; See change: caisse-comptage-ecart. |",
  },
  {
    file: PAGE,
    line: 75,
    text: "const cashSession=cashByPharmacy[pharmacyCode]??emptyCashSession;",
  },
  {
    file: PAGE,
    line: 342,
    text: "const counted=countCash(session.quantities);",
  },
  { file: INDEX, line: 5, text: 'export * from "./cash";' },
];

/**
 * Le scénario mesuré du plan refusé, tel que `result.json` le porte : c'est la
 * forme persistée, donc `PlanSchema` le relit sans transformation.
 */
const MEASURED_SCENARIO = {
  id: "comptage-par-pharmacie-conserve",
  title:
    "Comptage conservé quand on quitte la vue et distinct par pharmacie (DEMO17 / DEMO18)",
  rationale:
    "L'état vit dans Home, indexé par pharmacyCode : un aller-retour Pilotage ↔ Caisse le conserve, et changer de pharmacie active ouvre un comptage distinct avec le montant attendu par défaut 1 240,00.",
  kind: "regression",
  sourceFiles: [
    "apps/web/app/page.tsx",
    "packages/domain/src/index.ts",
    "apps/web/AGENTS.md",
    "packages/domain/AGENTS.md",
  ],
  preconditions: [],
  steps: [
    {
      id: "goto",
      description: "ouvrir l'application",
      action: {
        type: "goto",
        path: "/",
      },
    },
    {
      id: "open-caisse",
      description: "ouvrir la vue Caisse et Coffre sur DEMO17",
      action: {
        type: "click",
        locator: {
          by: "role",
          value: "button",
          name: "Caisse et Coffre",
        },
      },
    },
    {
      id: "fill-500",
      description: "deux billets de 500 €",
      action: {
        type: "fill",
        locator: {
          by: "role",
          value: "textbox",
          name: "Quantité · Billet de 500 €",
        },
        value: "2",
      },
    },
    {
      id: "fill-100",
      description: "deux billets de 100 €",
      action: {
        type: "fill",
        locator: {
          by: "role",
          value: "textbox",
          name: "Quantité · Billet de 100 €",
        },
        value: "2",
      },
    },
    {
      id: "fill-20",
      description: "deux billets de 20 € : 1 000 + 200 + 40 = 1 240,00 €",
      action: {
        type: "fill",
        locator: {
          by: "role",
          value: "textbox",
          name: "Quantité · Billet de 20 €",
        },
        value: "2",
      },
    },
    {
      id: "verify-juste",
      description: "le comptage devient juste (écart 0,00 €)",
      action: {
        type: "assert",
        assertionId: "juste-17",
      },
    },
    {
      id: "go-pilotage",
      description: "quitter la vue vers Pilotage",
      action: {
        type: "click",
        locator: {
          by: "role",
          value: "button",
          name: "Pilotage",
        },
      },
    },
    {
      id: "back-caisse",
      description: "revenir sur Caisse et Coffre",
      action: {
        type: "click",
        locator: {
          by: "role",
          value: "button",
          name: "Caisse et Coffre",
        },
      },
    },
    {
      id: "verify-retained",
      description: "le comptage de DEMO17 est retrouvé tel quel",
      action: {
        type: "assert",
        assertionId: "retained-17",
      },
    },
    {
      id: "switch-18",
      description: "changer de pharmacie active pour DEMO18",
      action: {
        type: "select",
        locator: {
          by: "role",
          value: "combobox",
          name: "Pharmacie active",
        },
        value: "DEMO18",
      },
    },
    {
      id: "verify-18",
      description: "DEMO18 ouvre un comptage vide et distinct",
      action: {
        type: "assert",
        assertionId: "empty-18",
      },
    },
    {
      id: "switch-17",
      description: "revenir à DEMO17",
      action: {
        type: "select",
        locator: {
          by: "role",
          value: "combobox",
          name: "Pharmacie active",
        },
        value: "DEMO17",
      },
    },
    {
      id: "verify-back-17",
      description: "le comptage de DEMO17 est toujours juste",
      action: {
        type: "assert",
        assertionId: "back-17",
      },
    },
  ],
  requirements: [
    {
      sourceFile: "apps/web/app/page.tsx",
      quote:
        "const cashSession=cashByPharmacy[pharmacyCode]??emptyCashSession;",
      behavior:
        "Le comptage est lu par pharmacie : conservé entre les vues et distinct d'une pharmacie à l'autre.",
    },
    {
      sourceFile: "apps/web/app/page.tsx",
      quote: "const counted=countCash(session.quantities);",
      behavior:
        "Le total compté et les unités sont recalculés depuis les quantités conservées de la pharmacie active.",
    },
    {
      sourceFile: "packages/domain/src/index.ts",
      quote: 'export * from "./cash";',
      behavior:
        "Les fonctions de comptage sont exportées par le domaine et consommées par la vue.",
    },
    {
      sourceFile: "apps/web/AGENTS.md",
      quote: "caisse-comptage-ecart",
      behavior:
        "La ligne AGENTS.md de apps/web documente la vue Caisse et Coffre ajoutée à app/page.tsx.",
    },
    {
      sourceFile: "packages/domain/AGENTS.md",
      quote: "src/cash.ts",
      behavior:
        "AGENTS.md du domaine référence le nouveau module de comptage et sa suite.",
    },
  ],
  assertions: [
    {
      id: "juste-17",
      description:
        "témoin de changement : 2×500 + 2×100 + 2×20 = 1 240,00 € comptés = 1 240,00 € attendus → statut « Comptage juste » (avant la dernière saisie : 1 200,00 €, écart −40,00 €)",
      target: {
        by: "css",
        value: "[data-cash-state]",
      },
      afterStep: "fill-20",
      verification: "transition",
      kind: "text",
      expected: "Comptage juste",
    },
    {
      id: "retained-17",
      description: "le comptage survit à l'aller-retour de vue",
      target: {
        by: "css",
        value: "[data-cash-state]",
      },
      afterStep: "back-caisse",
      verification: "state",
      kind: "text",
      expected: "Comptage juste",
    },
    {
      id: "empty-18",
      description:
        "DEMO18 n'hérite pas du comptage de DEMO17 : aucune unité saisie (0 unité comptée)",
      target: {
        by: "css",
        value: "[data-cash-state]",
      },
      afterStep: "switch-18",
      verification: "state",
      kind: "text",
      expected: "0 unité comptée",
    },
    {
      id: "back-17",
      description: "le comptage propre à DEMO17 est retrouvé après le retour",
      target: {
        by: "css",
        value: "[data-cash-state]",
      },
      afterStep: "switch-17",
      verification: "state",
      kind: "text",
      expected: "Comptage juste",
    },
  ],
};

const MEASURED_MESSAGE =
  'Weak source witness for comptage-par-pharmacie-conserve: apps/web/AGENTS.md (requirement 4). Rejected quote: "caisse-comptage-ecart"';

function measuredContext(
  extra: { path: string; content: string }[] = []
): PrContext {
  return {
    baseSha: "2".repeat(40),
    body: "",
    context: extra.map((item) => ({ ...item, ref: SHA })),
    contextWarnings: [],
    files: [...new Set(MEASURED_LINES.map((item) => item.file))].map(
      (file) => ({
        filename: file,
        patch: MEASURED_LINES.filter((item) => item.file === file)
          .map((item) => lineAt(file, item.line, item.text).patch)
          .join("\n"),
        status: "modified",
      })
    ),
    headRepo: "pharmania/arpilabe-pilotage",
    ref: parsePrUrl("https://github.com/pharmania/arpilabe-pilotage/pull/17"),
    sha: SHA,
    title: "",
  };
}

function measuredPlan(scenario: unknown = MEASURED_SCENARIO) {
  return PlanSchema.parse({
    scenarios: [scenario],
    skipped: [],
    summary: "Replay of the plan refused at run d6679230",
  });
}

/**
 * Le refus mesuré du run d6679230, mot pour mot, et la piste qui manquait : la
 * ligne 15 est le SEUL endroit du fichier cité qui porte l'identifiant, donc
 * une référence `{sourceFile, line}` existe et le refus doit la donner. Le
 * message, lui, ne bouge pas — aucune tolérance n'est ajoutée au témoin.
 */
it("replays the measured weak witness and designates its line", () => {
  const context = measuredContext();
  const plan = measuredPlan();
  const faults = ungroundedRequirements(plan, context);
  expect(faults.map((fault) => [fault.scenarioId, fault.rank])).toEqual([
    ["comptage-par-pharmacie-conserve", 4],
    ["comptage-par-pharmacie-conserve", 5],
  ]);
  const [webFault, domainFault] = faults;
  if (!(webFault && domainFault)) {
    throw new Error("Expected both measured weak witnesses");
  }
  const refusal = ungroundedRequirement(
    webFault.scenarioId,
    webFault.requirement,
    context,
    policy,
    webFault.rank
  );
  expect(refusal.message).toBe(MEASURED_MESSAGE);
  expect(() => validateCoverage(plan, context, policy, config)).toThrow(
    MEASURED_MESSAGE
  );
  // La ligne est DÉSIGNÉE, pas offerte à la recopie : la ligne de tableau de
  // 442 caractères n'apparaît nulle part dans le remède.
  expect(refusal.hint).toContain(`send "line": 15 for ${WEB_AGENTS},`);
  expect(refusal.hint).not.toContain(MEASURED_LINES[0]?.text ?? "");
  // Le second témoin faible du même scénario reçoit la même forme.
  expect(
    ungroundedRequirement(
      domainFault.scenarioId,
      domainFault.requirement,
      context,
      policy,
      domainFault.rank
    ).hint
  ).toContain(`send "line": 6 for ${DOMAIN_AGENTS},`);
  // La règle est intacte : l'identifiant nu reste refusé.
  expect(
    requirementHasWitness(
      { quote: "caisse-comptage-ecart", sourceFile: WEB_AGENTS },
      context
    )
  ).toBe(false);
});

/**
 * La convergence : les deux exigences du scénario envoyées sous la forme que le
 * remède nomme. Le gate écrit le texte des lignes lui-même, la couverture passe
 * et plus aucune exigence n'est sans témoin — le plan mesuré n'est plus bloqué
 * par cette famille.
 */
it("resolves the designated lines and passes the gate without retyping", () => {
  const context = measuredContext();
  const material = sourceLineMaterial(context);
  expect(resolveLineReference(WEB_AGENTS, 15, material)).toEqual({
    text: MEASURED_LINES[0]?.text,
  });
  expect(resolveLineReference(DOMAIN_AGENTS, 6, material)).toEqual({
    text: MEASURED_LINES[1]?.text,
  });
  const submitted = structuredClone(MEASURED_SCENARIO) as Record<
    string,
    unknown
  >;
  const requirements = submitted.requirements as {
    sourceFile: string;
    quote?: string;
    line?: number;
  }[];
  for (const requirement of requirements) {
    if (requirement.sourceFile === WEB_AGENTS) {
      requirement.quote = undefined;
      requirement.line = 15;
    }
    if (requirement.sourceFile === DOMAIN_AGENTS) {
      requirement.quote = undefined;
      requirement.line = 6;
    }
  }
  const parsed = plannerPlanSchema(material).parse({
    scenarios: [submitted],
    skipped: [],
    summary: "Replay of the plan refused at run d6679230",
  });
  const resolved = PlanSchema.parse(parsed);
  const quotes = resolved.scenarios[0]?.requirements ?? [];
  expect(quotes.find((item) => item.sourceFile === WEB_AGENTS)?.quote).toBe(
    MEASURED_LINES[0]?.text
  );
  expect(quotes.find((item) => item.sourceFile === DOMAIN_AGENTS)?.quote).toBe(
    MEASURED_LINES[1]?.text
  );
  expect(ungroundedRequirements(resolved, context)).toEqual([]);
  expect(validateCoverage(resolved, context, policy, config).gate).toBe(
    "complete"
  );
});

/**
 * La correction contrainte reste ouverte sur le même plan : le choix d'indice
 * écrit la même ligne réelle. Le remède texte n'a pas remplacé la voie la plus
 * sûre, il a rendu la seconde forme du remède aussi sûre qu'elle.
 */
it("keeps the constrained pick on the measured plan", () => {
  const context = measuredContext();
  const correction = quotePickCorrection(
    measuredPlan(),
    policy,
    context,
    config,
    "d6679230-replay"
  );
  expect(correction).toBeDefined();
  if (!correction) {
    throw new Error("Expected the constrained pick");
  }
  expect(correction.message).toContain(
    `- comptage-par-pharmacie-conserve: ${WEB_AGENTS} requirement 4`
  );
  expect(correction.message).toContain(
    `- comptage-par-pharmacie-conserve: ${DOMAIN_AGENTS} requirement 5`
  );
  const resolved = correction.resolve({
    picks: [
      {
        scenario: "comptage-par-pharmacie-conserve",
        requirement: 4,
        candidate: 1,
      },
      {
        scenario: "comptage-par-pharmacie-conserve",
        requirement: 5,
        candidate: 1,
      },
    ],
  });
  expect(resolved).toBeDefined();
  if (!resolved) {
    throw new Error("Expected the pick to resolve the refused quotes");
  }
  expect(ungroundedRequirements(resolved, context)).toEqual([]);
});

/**
 * Le cas où AUCUNE ligne n'est désignable : la citation faible ne vit que dans
 * le contenu de fichier récupéré pour le contexte, jamais dans un hunk du diff.
 * Le remède ne peut pas renvoyer une référence que le gate refuserait : il dit
 * pourquoi, et laisse le texte exact — la seule forme que ce cas accepte.
 */
it("says why no line is designable when the carrier is outside the diff", () => {
  const legacy = "src/legacy.ts";
  const carrier = "  const caisse-comptage = readLegacyCounter();";
  const context: PrContext = {
    ...measuredContext(),
    files: [],
    context: [
      { path: legacy, ref: SHA, content: `import x from "y";\n${carrier}\n` },
    ],
  };
  const requirement = {
    quote: "caisse-comptage",
    sourceFile: legacy,
  };
  expect(requirementHasWitness(requirement, context)).toBe(false);
  const refusal = ungroundedRequirement(
    "comptage-par-pharmacie-conserve",
    { ...requirement, behavior: "Comptage conservé par pharmacie" },
    context,
    policy,
    1
  );
  expect(refusal.hint).toContain(
    'No "line" reference designates the real line that carries it:'
  );
  expect(refusal.hint).toContain("the diff carries no such file");
  expect(refusal.hint).toContain(`2: ${JSON.stringify(carrier)}`);
});
