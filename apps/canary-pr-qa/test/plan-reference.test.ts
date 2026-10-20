import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { type PrContext, parsePrUrl } from "../src/github.js";
import {
  PolicySchema,
  requirementHasWitness,
  ungroundedRequirements,
  validateCoverage,
} from "../src/policy.js";
import {
  type Plan,
  PlanSchema,
  plannerPlanSchema,
  resolveLineReference,
  type SourceLineMaterial,
} from "../src/schema.js";
import { lineAt, MEASURED_COPY_REFUSALS } from "./fixture.js";
import { CASH_TS_LINES, PAGE_TS_LINES } from "./lot-v-replay.js";

const PAGE = "apps/web/app/page.tsx";
const CASH = "packages/domain/src/cash.ts";
const SHA = "814b671305b005ab516db66bc3da1d8239bcef16";
const config = loadConfig({});
const policy = PolicySchema.parse({ approvedSkips: [], version: 1 });

function lineOf(
  file: string,
  line: number,
  lines: { line: number; text: string }[]
): string {
  const found = lines.find((item) => item.line === line);
  if (!found) {
    throw new Error(`No measured line ${line} of ${file}`);
  }
  return found.text;
}

function pageLine(line: number): string {
  return lineOf(PAGE, line, PAGE_TS_LINES);
}

function cashLine(line: number): string {
  return lineOf(CASH, line, CASH_TS_LINES);
}

/**
 * Le contexte d'un fichier du corpus : ses lignes réelles, comme contenu après
 * changement de la PR — c'est ce que la couverture et le gate de témoin lisent.
 */
function contextFor(
  file: string,
  lines: { line: number; text: string }[]
): PrContext {
  return {
    baseSha: "2".repeat(40),
    body: "",
    context: [],
    contextWarnings: [],
    files: [
      {
        filename: file,
        patch: lines
          .map((item) => lineAt(file, item.line, item.text).patch)
          .join("\n"),
        status: "modified",
      },
    ],
    headRepo: "pharmania/arpilabe-pilotage",
    ref: parsePrUrl("https://github.com/pharmania/arpilabe-pilotage/pull/17"),
    sha: SHA,
    title: "",
  };
}

function materialFor(
  file: string,
  lines: { line: number; text: string }[]
): SourceLineMaterial[] {
  return [{ lines, path: file }];
}

/**
 * La forme RÉFÉRENCE que le planificateur produit : `sourceFile` + `line`, sans
 * un caractère de citation — c'est elle qui ne peut plus être altérée, puisque
 * le gate lit la ligne dans le matériel.
 */
function referenceSubmission(file: string, line: number) {
  return {
    skipped: [],
    summary: "Le comportement changé est désigné par sa ligne",
    scenarios: [
      {
        assertions: [
          {
            afterStep: "observe",
            description: "La sortie changée est visible",
            id: "seen",
            kind: "visible",
            target: { by: "css", value: "#seen" },
            verification: "state",
          },
        ],
        id: "designated-line",
        kind: "happy_path",
        preconditions: [],
        rationale: "La ligne désignée porte le comportement changé",
        requirements: [
          {
            behavior: "Le comportement changé est prouvé par la ligne désignée",
            line,
            sourceFile: file,
          },
        ],
        sourceFiles: [file],
        steps: [
          {
            action: { type: "observe" },
            description: "Observer la page",
            id: "observe",
          },
          {
            action: { type: "assert", assertionId: "seen" },
            description: "Vérifier la sortie changée",
            id: "check",
          },
        ],
        title: "Ligne désignée",
      },
    ],
  };
}

/**
 * Le MÊME plan, en forme citation : c'est la forme persistée d'aujourd'hui, donc
 * celle que la couverture et le gate de témoin continuent de lire.
 */
function quotedSubmission(file: string, quote: string) {
  const submission = referenceSubmission(file, 1);
  return {
    ...submission,
    scenarios: submission.scenarios.map((scenario) => ({
      ...scenario,
      requirements: [
        {
          behavior: "Le comportement changé est prouvé par la ligne désignée",
          quote,
          sourceFile: file,
        },
      ],
    })),
  };
}

/**
 * Ce que le gate rend d'une réponse du planificateur : le plan persisté, ou le
 * refus nommé quand une référence ne désigne rien d'exploitable.
 */
function resolve(
  submission: unknown,
  material: SourceLineMaterial[]
): { plan?: Plan; refusal?: string } {
  const parsed = plannerPlanSchema(material).safeParse(submission);
  return parsed.success
    ? { plan: parsed.data }
    : { refusal: refusalOf(parsed.error) };
}

function refusalOf(error: unknown): string {
  const issues =
    (error as { issues?: { message: string; path: (string | number)[] }[] })
      .issues ?? [];
  return issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join(" | ");
}

describe("résolution d'une référence de ligne par le gate", () => {
  it("écrit la ligne réelle du matériel dans quote, sans un caractère recopié", () => {
    const material = materialFor(PAGE, PAGE_TS_LINES);
    const resolved = resolve(referenceSubmission(PAGE, 368), material);
    expect(resolved.refusal).toBeUndefined();
    const plan = resolved.plan as Plan;
    const requirement = plan.scenarios[0]!.requirements[0]!;
    // Le texte persisté est celui du matériel, octet pour octet : la ligne 368
    // que le planificateur retapait avec `:""` inséré.
    expect(requirement.quote).toBe(pageLine(368));
    // La référence ne survit pas dans le plan : la forme persistée reste une
    // citation texte, donc tout l'aval (couverture, rapport, UI) est inchangé.
    expect(Object.hasOwn(requirement, "line")).toBe(false);
    // Le plan résolu se revalide par le schéma persisté — c'est ce contrôle qui
    // tombe si la résolution du gate est retirée, puisque la citation manquerait.
    expect(() => PlanSchema.parse(plan)).not.toThrow();
    const context = contextFor(PAGE, PAGE_TS_LINES);
    expect(requirementHasWitness(requirement, context)).toBe(true);
    expect(ungroundedRequirements(plan, context)).toEqual([]);
    expect(validateCoverage(plan, context, policy, config).gate).toBe(
      "complete"
    );
  });

  it("résout la ligne désignée du fichier déclaré, jamais une autre", () => {
    const material = materialFor(CASH, CASH_TS_LINES);
    const resolved = resolve(referenceSubmission(CASH, 146), material);
    expect(resolved.plan?.scenarios[0]?.requirements[0]?.quote).toBe(
      cashLine(146)
    );
    expect(resolved.plan?.scenarios[0]?.requirements[0]?.quote).not.toBe(
      cashLine(116)
    );
  });

  it("refuse une exigence sans citation ni ligne", () => {
    const material = materialFor(PAGE, PAGE_TS_LINES);
    const submission = referenceSubmission(PAGE, 368);
    const resolved = resolve(
      {
        ...submission,
        scenarios: submission.scenarios.map((scenario) => ({
          ...scenario,
          requirements: [
            {
              behavior: "Le comportement changé est prouvé",
              sourceFile: PAGE,
            },
          ],
        })),
      },
      material
    );
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain("needs a source reference");
  });

  it("refuse une citation et une ligne envoyées ensemble", () => {
    const material = materialFor(PAGE, PAGE_TS_LINES);
    const submission = referenceSubmission(PAGE, 368);
    const resolved = resolve(
      {
        ...submission,
        scenarios: submission.scenarios.map((scenario) => ({
          ...scenario,
          requirements: [
            {
              behavior: "Le comportement changé est prouvé",
              line: 368,
              quote: pageLine(368),
              sourceFile: PAGE,
            },
          ],
        })),
      },
      material
    );
    // Accepter les deux laisserait une copie altérée accompagner une ligne juste
    // et passer pour un témoin : le couple est refusé, jamais arbitré.
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain("alternatives, never both");
  });
});

/**
 * Les quatre refus d'une référence, nommés et actionnables : la ligne demandée,
 * puis les lignes que le matériel porte réellement autour. Aucun refus ne rend
 * un texte à recopier, et aucun ne cite de texte de page.
 */
describe("refus d'une référence : la ligne demandée, puis ce que le matériel porte", () => {
  it("nomme les lignes disponibles autour d'une ligne absente du matériel", () => {
    const material = materialFor(PAGE, PAGE_TS_LINES);
    const resolved = resolve(referenceSubmission(PAGE, 999), material);
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain(
      `requirements.0.line: Line 999 of ${PAGE} is not in the numbered material`
    );
    // Les numéros réellement listés autour, bornés : les trois derniers avant.
    expect(resolved.refusal).toContain("354, 368, 375 before it");
    // La cause nommée est la vraie : le matériel ne porte que les lignes des
    // hunks du patch (policy.ts, `numberedSourceLines`), pas le fichier entier ;
    // le budget de contexte ne fait que tronquer cette liste.
    expect(resolved.refusal).toContain(
      "it carries the lines of the patch hunks, not every line of the file"
    );
  });

  it("nomme les lignes qui portent du code quand la ligne désignée n'en porte pas", () => {
    const blank = "   ";
    const material = materialFor(PAGE, [
      { line: 366, text: pageLine(350) },
      { line: 367, text: blank },
    ]);
    const resolved = resolve(referenceSubmission(PAGE, 367), material);
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain(
      `Line 367 of ${PAGE} carries no usable code content`
    );
    expect(resolved.refusal).toContain("Lines that do carry code content: 366");
  });

  it("refuse une ligne que le matériel liste deux fois", () => {
    const material = materialFor(CASH, CASH_TS_LINES);
    const lines = material[0]?.lines ?? [];
    const ambiguous: SourceLineMaterial[] = [
      { lines: [...lines, { line: 116, text: cashLine(116) }], path: CASH },
    ];
    const resolved = resolve(referenceSubmission(CASH, 116), ambiguous);
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain(
      `Line 116 of ${CASH} is ambiguous: sourceLines lists it 2 times`
    );
  });

  it("refuse un fichier que le matériel ne liste pas, en nommant ceux qu'il liste", () => {
    const material = materialFor(PAGE, PAGE_TS_LINES);
    const resolved = resolve(
      referenceSubmission("src/absent.ts", 12),
      material
    );
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain(
      "No numbered line for src/absent.ts: sourceLines lists no such file"
    );
    expect(resolved.refusal).toContain(`(it lists ${PAGE})`);
  });

  it("refuse un fichier listé sans aucune ligne, plutôt que de deviner", () => {
    const material: SourceLineMaterial[] = [{ lines: [], path: PAGE }];
    const resolved = resolve(referenceSubmission(PAGE, 1), material);
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain(
      `No numbered line for ${PAGE}: sourceLines lists that file but no line of it`
    );
  });

  it("refuse une ligne au-delà du plafond de citation, sans la rogner", () => {
    const long = `const bundle="${"x".repeat(1200)}";`;
    const material = materialFor("src/min.js", [{ line: 1, text: long }]);
    const resolved = resolve(referenceSubmission("src/min.js", 1), material);
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain("beyond the 1000-character quote cap");
    // Rien n'est inventé : une ligne trop longue n'est ni coupée ni acceptée.
    expect(resolved.refusal).toContain("quote an exact fragment of it");
  });

  it("ne refuse pas une référence dont la ligne existe et porte du code", () => {
    const material = materialFor(PAGE, PAGE_TS_LINES);
    for (const item of PAGE_TS_LINES) {
      expect(resolveLineReference(PAGE, item.line, material)).toEqual({
        text: item.text,
      });
    }
  });
});

/**
 * REJEU des runs rouges mesurés de la famille : chacun est mort d'une preuve
 * que le planificateur avait recopiée au lieu de la désigner. En forme
 * RÉFÉRENCE, il n'y a plus rien à recopier, donc plus aucun refus de cette
 * famille ; en forme citation, la même copie mesurée reste refusée. Les deux
 * assertions vont ensemble : la première prouve le remède, la seconde prouve
 * qu'aucune citation inexacte n'est devenue acceptable.
 */
describe("rejeu des runs rouges mesurés en forme référence", () => {
  /** Ce que le corpus conserve de chaque run : la copie mesurée et sa cause. */
  function measured(runPrefix: string) {
    const found = MEASURED_COPY_REFUSALS.find((item) =>
      item.runId.startsWith(runPrefix)
    );
    if (!found) {
      throw new Error(`No measured refusal for run ${runPrefix}`);
    }
    return found;
  }
  const cases = [
    {
      // Prose de l'application citée comme source : elle n'existe nulle part
      // dans le fichier, donc aucune ligne ne la porte. Le comportement décrit
      // — l'état de caisse et son écart — est porté par la ligne 350 du fichier
      // déclaré, que le planificateur aurait pu désigner.
      file: PAGE,
      label: "6fa3612a prose de page",
      line: 350,
      lines: PAGE_TS_LINES,
      prose: "comptage conservé par pharmacie entre les vues",
      runId: "6fa3612a",
    },
    {
      // `:""` inséré dans la première interpolation de la ligne 368.
      file: PAGE,
      label: '07429b97 :"" inséré',
      line: 368,
      lines: PAGE_TS_LINES,
      prose: `${"${"}counted.totalUnits} unité\${counted.totalUnits>1?"s":"":""}`,
      runId: "07429b97",
    },
    {
      // Témoin faible : `ecart-a-justifier` est un identifiant nu, et deux
      // lignes du fichier le portent (116 et 146). La référence en choisit une.
      file: CASH,
      label: "58e47755 témoin faible",
      line: 116,
      lines: CASH_TS_LINES,
      prose: "ecart-a-justifier",
      runId: "58e47755",
    },
    {
      // La copie alterée du lot T, rejouée telle quelle.
      file: PAGE,
      label: "9add286d copie altérée",
      line: 368,
      lines: PAGE_TS_LINES,
      prose: measured("9add286d").quote,
      runId: "9add286d",
    },
    {
      file: PAGE,
      label: "a6cd72ae copie altérée",
      line: 368,
      lines: PAGE_TS_LINES,
      prose: measured("a6cd72ae").quote,
      runId: "a6cd72ae",
    },
  ];
  it("ne produit plus aucun refus de la famille quand la ligne est désignée", () => {
    const accepted = cases.map((item) => {
      const context = contextFor(item.file, item.lines);
      const resolved = resolve(
        referenceSubmission(item.file, item.line),
        materialFor(item.file, item.lines)
      );
      expect(resolved.refusal, item.label).toBeUndefined();
      const plan = resolved.plan as Plan;
      const [requirement] = plan.scenarios[0]?.requirements ?? [];
      expect(requirement?.quote, item.label).toBe(
        lineOf(item.file, item.line, item.lines)
      );
      expect(ungroundedRequirements(plan, context), item.label).toEqual([]);
      expect(
        validateCoverage(plan, context, policy, config).gate,
        item.label
      ).toBe("complete");
      return item.label;
    });
    expect(accepted).toEqual([
      "6fa3612a prose de page",
      '07429b97 :"" inséré',
      "58e47755 témoin faible",
      "9add286d copie altérée",
      "a6cd72ae copie altérée",
    ]);
  });
  it("laisse chaque copie mesurée refusée quand elle est encore recopiée", () => {
    for (const item of cases) {
      const context = contextFor(item.file, item.lines);
      const resolved = resolve(
        quotedSubmission(item.file, item.prose),
        materialFor(item.file, item.lines)
      );
      // La forme citation n'est ni affaiblie ni réparée : le gate refuse la
      // copie exactement comme avant.
      expect(resolved.plan, item.label).toBeDefined();
      expect(
        ungroundedRequirements(resolved.plan as Plan, context).length,
        item.label
      ).toBeGreaterThan(0);
    }
  });
});

/**
 * La forme `quote` continue de fonctionner à l'identique : une citation exacte
 * traverse le schéma du planificateur telle quelle, sans être réécrite ni
 * comparée à un matériel dont elle n'a pas besoin.
 */
describe("compatibilité : la forme citation est inchangée", () => {
  it("conserve une citation exacte octet pour octet, sans matériel", () => {
    const quote = pageLine(368);
    const resolved = resolve(quotedSubmission(PAGE, quote), []);
    expect(resolved.refusal).toBeUndefined();
    expect(resolved.plan?.scenarios[0]?.requirements[0]?.quote).toBe(quote);
    // Le plan produit est celui du schéma persisté : mêmes exigences, même forme.
    expect(PlanSchema.parse(resolved.plan)).toEqual(resolved.plan);
  });
  it("garde le plancher de longueur de la citation", () => {
    const resolved = resolve(quotedSubmission(PAGE, "court"), []);
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain("requirements.0.quote");
  });
});
