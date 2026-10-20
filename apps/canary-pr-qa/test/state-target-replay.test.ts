import { describe, expect, it } from "vitest";
import { stateTargetReadRefusals } from "../src/plan-evidence.js";
import { type Plan, PlanSchema } from "../src/schema.js";
import { LOT_U_PLAN } from "./lot-u-plan.js";

/**
 * Instantané de découverte de la vue « Caisse et Coffre » dans l'état où le run
 * 210357d8 l'a rencontrée : la barre de navigation, le titre de la pharmacie
 * courante, une région `status` unique qui porte le statut du comptage, et les
 * paragraphes de la vue. Le libellé du statut est donc rendu par un nœud
 * unique, ceux des lignes de comptage par des paragraphes nombreux — c'est la
 * différence que le refus doit savoir lire.
 */
const VIEW_ARIA = `- main [ref=e1]:
  - navigation [ref=e2]:
    - button "Pilotage" [ref=e3]
    - button "Caisse et Coffre" [ref=e4]
  - heading "Caisse et Coffre · DEMO17" [ref=e5]
  - status [ref=e6]: Comptage juste
  - paragraph: Coupures et pièces
  - paragraph: Quantités comptées dans le tiroir et le coffre. Un champ vide compte pour zéro.
  - paragraph: 6 unités comptées
  - paragraph: Total compté
  - paragraph: 1 240,00 €
  - paragraph: Session en cours`;

/** Attribution d'état épinglé, la seule forme que la règle vise. */
const PINNED =
  /\[\s*(?:aria-(?:checked|current|disabled|expanded|hidden|invalid|pressed|selected)|data-(?:state|cash-state))\s*[*^$~|]?=\s*(?:"[^"]*"|'[^']*'|[^\]]*)\]/i;

function plan(): Plan {
  return PlanSchema.parse(LOT_U_PLAN);
}

interface Fault {
  assertion: string;
  expected: string;
  scenario: string;
  selector: string;
}

/** Les lectures fautives du run, relevées dans le plan mesuré lui-même. */
function faults(): Fault[] {
  const found: Fault[] = [];
  for (const scenario of plan().scenarios) {
    for (const assertion of scenario.assertions) {
      const target = assertion.target;
      if (assertion.kind !== "text" || !(target && target.by === "css")) {
        continue;
      }
      if (!PINNED.test(target.value)) {
        continue;
      }
      found.push({
        assertion: assertion.id,
        expected: String(assertion.expected),
        selector: target.value,
        scenario: scenario.id,
      });
    }
  }
  return found;
}

/**
 * L'instantané d'entrée de la vue de caisse, dans l'état que le scénario de
 * fermeture atteint : l'avis de clôture est rendu par l'unique région `status`
 * de la vue, donc le refus peut le nommer par son rôle — à condition que rien
 * n'ait changé la page depuis la découverte.
 */
const CLOSED_MESSAGE = "Session clôturée : le comptage est verrouillé.";
/** La page que la découverte a capturée : un `goto` vers elle ne la quitte pas. */
const PREVIEW_URL = "https://preview.example.com/";
const CLOSED_VIEW_ARIA = `- main [ref=e1]:
  - heading "Caisse et Coffre · DEMO17" [ref=e5]
  - status [ref=e6]: ${CLOSED_MESSAGE}
  - paragraph: Session clôturée`;

type Steps = Plan["scenarios"][number]["steps"];

function step(id: string, action: Steps[number]["action"]): Steps[number] {
  return { id, description: id, action };
}

const goto = (id: string): Steps[number] =>
  step(id, { type: "goto", path: "/" });

/**
 * Un plan dont la seule lecture fautive est l'avis de clôture lu sur la valeur
 * épinglée. `before` est le préfixe d'étapes choisi par le test et `anchor` la
 * dernière d'entre elles, celle que l'assertion suit : c'est exactement la
 * différence entre une lecture faite sur la page de découverte et une lecture
 * faite après qu'une action l'a changée.
 */
function closurePlan(
  before: Steps,
  anchor: string,
  expected: string = CLOSED_MESSAGE
): Plan {
  return PlanSchema.parse({
    summary: "The closure notice announces the locked count.",
    scenarios: [
      {
        id: "cash-closure-message",
        title: "The closure notice announces the locked count",
        rationale: "Reads the notice the view displays once the count closes.",
        kind: "happy_path",
        sourceFiles: ["apps/web/app/page.tsx"],
        preconditions: [],
        steps: [
          ...before,
          step("check-message", {
            type: "assert",
            assertionId: "closed-message",
          }),
        ],
        requirements: [
          {
            sourceFile: "apps/web/app/page.tsx",
            quote: CLOSED_MESSAGE,
            behavior: "The closure notice announces the locked count.",
          },
        ],
        assertions: [
          {
            id: "closed-message",
            description: "The closure notice announces the locked count",
            kind: "text",
            expected,
            target: { by: "css", value: '[data-cash-state="cloture"]' },
            afterStep: anchor,
            verification: "state",
          },
        ],
      },
    ],
    skipped: [],
  });
}

const hintOf = (plan: Plan): string =>
  stateTargetReadRefusals(plan, {
    url: PREVIEW_URL,
    aria: CLOSED_VIEW_ARIA,
  })[0]?.error.hint ?? "";

describe("rejeu du run 210357d8 (lot U), six scénarios bloqués", () => {
  it("compte les lectures fautives du run : six scénarios, dix-sept assertions", () => {
    // La mesure du lot U, refaite sur l'artefact : six scénarios bloqués, et
    // dix-sept assertions qui lisent un sélecteur d'état épinglé comme du
    // texte — `result.json` nomme 3, 2, 2, 3, 5 et 2 assertions par scénario.
    expect(plan().scenarios).toHaveLength(6);
    expect(faults()).toHaveLength(17);
    expect([...new Set(faults().map((fault) => fault.scenario))]).toHaveLength(
      6
    );
  });

  it.each(
    [
      "cash-balanced-close-reopen",
      "cash-variance-justification",
      "cash-invalid-quantity",
      "cash-view-state-retention",
      "cash-per-pharmacy-separation",
      "cash-invalid-expected-amount",
    ].map((id) => [id] as const)
  )("refuse le scénario %s et nomme sa lecture d'origine", (id) => {
    const refused = stateTargetReadRefusals(plan(), {
      url: PREVIEW_URL,
      aria: VIEW_ARIA,
    });
    const scenario = refused.find((item) => item.scenario.id === id);
    expect(scenario?.error.code).toBe("PLAN_STATE_TARGET_READ_AS_TEXT");
    for (const fault of faults().filter((item) => item.scenario === id)) {
      expect(scenario?.error.message).toContain(fault.assertion);
      expect(scenario?.error.message).toContain(fault.selector);
      expect(scenario?.error.message).toContain(JSON.stringify(fault.expected));
    }
  });

  it.each(
    faults().map(
      (fault) => [`${fault.scenario}/${fault.assertion}`, fault] as const
    )
  )("nomme la cible visible de %s", (_id, fault) => {
    const refused = stateTargetReadRefusals(plan(), {
      url: PREVIEW_URL,
      aria: VIEW_ARIA,
    });
    const scenario = refused.find(
      (item) => item.scenario.id === fault.scenario
    );
    const hint = scenario?.error.hint ?? "";
    // Le libellé attendu est l'indice : le refus nomme l'assertion, son
    // libellé, et la cible qui le rend sans dépendre de l'état.
    expect(hint).toContain(`assertion ${fault.assertion}`);
    expect(hint).toContain(JSON.stringify(fault.expected));
    expect(hint).toContain(
      `assertion ${fault.assertion} expecting ${JSON.stringify(fault.expected)} → read [data-cash-state]`
    );
  });

  it("ne propose aucun rôle quand une action a changé la page depuis la découverte", () => {
    // Les dix-sept lectures du run lisent toutes APRÈS une action (clic
    // d'ouverture, saisie, clôture) : l'instantané de découverte décrit la page
    // d'entrée, pas celle que l'assertion lit. Le refus nomme donc la règle et
    // le sélecteur fautif, et n'invente aucune cible : un rôle tiré de la
    // découverte enverrait le planificateur sur un nœud qui n'existe plus.
    const refused = stateTargetReadRefusals(plan(), {
      url: PREVIEW_URL,
      aria: VIEW_ARIA,
    });
    const interactions = new Set(["check", "click", "fill", "press", "select"]);
    for (const scenario of plan().scenarios) {
      const touched = scenario.steps.some((step) =>
        interactions.has(step.action.type)
      );
      expect(touched, scenario.id).toBe(true);
    }
    for (const fault of faults()) {
      const hint =
        refused.find((item) => item.scenario.id === fault.scenario)?.error
          .hint ?? "";
      // La présence reste proposée dans les deux cas : elle se déduit du
      // sélecteur et existe dans tous les états.
      expect(hint, fault.assertion).toContain(
        `assertion ${fault.assertion} expecting ${JSON.stringify(fault.expected)} → read [data-cash-state]`
      );
      expect(hint, fault.assertion).not.toContain("role=status name=");
    }
  });

  it("n'offre ni un nœud texte ni un nom accessible comme cible de lecture", () => {
    // Deux formes que l'instantané porte et qui ne sont PAS une cible `text` :
    // `- text:` n'est pas un rôle (`role=text` résout 0 élément sur la page de
    // référence), et un nom accessible peut différer du contenu rendu. Le refus
    // ne doit nommer que le nœud dont le contenu porte le libellé. Le scénario
    // n'a que son `goto` avant l'assertion : la découverte décrit bien la page
    // lue, donc la suggestion de rôle est ouverte.
    const snapshot = [
      "- main:",
      `  - text: ${CLOSED_MESSAGE}`,
      `  - button "${CLOSED_MESSAGE}": ⚙️`,
      `  - status: ${CLOSED_MESSAGE}`,
    ].join("\n");
    const refused = stateTargetReadRefusals(
      closurePlan([goto("open")], "open"),
      {
        url: PREVIEW_URL,
        aria: snapshot,
      }
    );
    const hint = refused[0]?.error.hint ?? "";
    expect(hint).toContain(
      `expecting ${JSON.stringify(CLOSED_MESSAGE)} → read [data-cash-state] or role=status name=""`
    );
    expect(hint).not.toContain("role=text");
    expect(hint).not.toContain("role=button");
  });

  it("refuse la cible épinglée avec ou sans matériel : la règle ne s'ouvre pas", () => {
    // Le gate n'accepte toujours AUCUNE lecture sur un sélecteur d'état
    // épinglé : le matériel enrichit le message, il ne relâche pas le refus.
    const withViews = stateTargetReadRefusals(plan(), {
      url: PREVIEW_URL,
      aria: VIEW_ARIA,
    });
    const withoutViews = stateTargetReadRefusals(plan());
    expect(withViews).toHaveLength(6);
    expect(withoutViews).toHaveLength(6);
    expect(withoutViews.map((item) => item.error.message)).toEqual(
      withViews.map((item) => item.error.message)
    );
    // Sans instantané, la cible de présence se déduit encore du sélecteur.
    for (const refused of withoutViews) {
      expect(refused.error.hint).toContain("→ read [data-cash-state]");
    }
  });

  it("accepte la cible corrigée qu'il propose, pour chacune des dix-sept lectures", () => {
    // La correction que le refus nomme est jouable : la même assertion, portée
    // sur le conteneur sans sa valeur épinglée, ne rencontre plus aucun refus.
    const corrected = plan();
    corrected.scenarios = corrected.scenarios.map((scenario) => ({
      ...scenario,
      assertions: scenario.assertions.map((assertion) => {
        const target = assertion.target;
        return assertion.kind === "text" &&
          target &&
          target.by === "css" &&
          PINNED.test(target.value)
          ? {
              ...assertion,
              target: { by: "css" as const, value: "[data-cash-state]" },
            }
          : assertion;
      }),
    }));
    expect(
      stateTargetReadRefusals(PlanSchema.parse(corrected), {
        url: PREVIEW_URL,
        aria: VIEW_ARIA,
      })
    ).toEqual([]);
    // Aucune assertion du plan corrigé ne lit plus un attribut d'état épinglé,
    // et la forme qui les remplace est celle que le corpus mesure : 924
    // assertions `text` y lisent [data-cash-state], 885 passent.
    expect(
      corrected.scenarios
        .flatMap((scenario) => scenario.assertions)
        .filter(
          (assertion) =>
            // Une assertion `visible` sur la valeur épinglée est la PREUVE de
            // l'état, pas une lecture : elle reste.
            assertion.kind === "text" &&
            assertion.target?.by === "css" &&
            PINNED.test(assertion.target.value)
        )
    ).toEqual([]);
  });
});

describe("suggestion de rôle et page changée depuis la découverte", () => {
  it("retire la suggestion quand la vérification relit la cible APRÈS l'action", () => {
    // `transition` et `persisted` relèvent leur référence à l'entrée de
    // `afterStep`, mais relisent la cible après cette étape — ou après le
    // rechargement. Indexer le conseil à l'entrée laissait donc nommer un rôle
    // de la découverte sur une page que l'action venait de changer.
    for (const verification of ["transition", "persisted"] as const) {
      const plan = closurePlan(
        [
          goto("go"),
          step("close", {
            type: "click",
            locator: { by: "role", value: "button", name: "Clôturer" },
          }),
        ],
        "close"
      );
      const assertion = plan.scenarios[0]?.assertions[0];
      if (assertion) {
        assertion.verification = verification;
      }
      const hint =
        stateTargetReadRefusals(plan, {
          url: PREVIEW_URL,
          aria: CLOSED_VIEW_ARIA,
        })[0]?.error.hint ?? "";
      expect(hint, verification).not.toContain("role=status");
      expect(hint, verification).toContain("→ read [data-cash-state]");
    }
  });

  it("retire la suggestion quand une action a changé la page avant l'assertion", () => {
    const hint = hintOf(
      closurePlan(
        [
          goto("go"),
          step("close", {
            type: "click",
            locator: { by: "role", value: "button", name: "Clôturer" },
          }),
        ],
        "close"
      )
    );
    // La lecture garde la présence (elle existe dans tous les états) et le
    // sélecteur fautif, mais aucune cible tirée de la découverte : le nœud que
    // l'instantané nomme peut avoir disparu après le clic.
    expect(hint).toContain(
      `assertion closed-message expecting ${JSON.stringify(CLOSED_MESSAGE)} → read [data-cash-state]`
    );
    expect(hint).not.toContain("role=status");
    expect(hint).not.toContain("the discovery snapshot renders this label");
    // Le refus reste prononcé : la règle ne s'ouvre pas, seul le conseil change.
    expect(
      stateTargetReadRefusals(closurePlan([goto("go")], "go"))
    ).toHaveLength(1);
  });

  it("garde la suggestion quand l'assertion n'a aucune interaction avant elle", () => {
    const hint = hintOf(
      closurePlan([goto("go"), step("look", { type: "observe" })], "look")
    );
    // Seules des étapes de lecture précèdent : la page que la découverte a
    // capturée est toujours celle que l'assertion lit.
    expect(hint).toContain(
      `assertion closed-message expecting ${JSON.stringify(CLOSED_MESSAGE)} → read [data-cash-state] or role=status name=""`
    );
    expect(hint).toContain("(the discovery snapshot renders this label there)");
  });

  it("garde la suggestion quand le scénario ne fait que naviguer avant l'assertion", () => {
    const hint = hintOf(closurePlan([goto("go")], "go"));
    // L'instantané est capturé par le seul `goto` d'entrée de la découverte
    // (`discover` dans `runner.ts`), donc un `goto` qui recharge cette page ne
    // la quitte pas (`staysOnDiscoveryPage`) et la suggestion reste valable.
    expect(hint).toContain('or role=status name=""');
    expect(hint).toContain("(the discovery snapshot renders this label there)");
  });

  it("retire la suggestion quand le goto quitte la page de découverte", () => {
    const hint = hintOf(
      closurePlan([step("go", { type: "goto", path: "/caisse" })], "go")
    );
    // Même gate que le contrôle d'évidence : un `goto` vers une autre route
    // rend la page inconnue, donc le rôle que l'instantané nomme n'est plus
    // prouvé — seule la présence, qui se déduit du sélecteur, reste proposée.
    expect(hint).toContain(
      `assertion closed-message expecting ${JSON.stringify(CLOSED_MESSAGE)} → read [data-cash-state]`
    );
    expect(hint).not.toContain("role=status name=");
  });

  it.each([
    [
      "fill",
      {
        type: "fill" as const,
        locator: { by: "css" as const, value: "#units" },
        value: "2",
      },
    ],
    [
      "select",
      {
        type: "select" as const,
        locator: { by: "css" as const, value: "#pharmacy" },
        value: "DEMO17",
      },
    ],
    [
      "press",
      {
        type: "press" as const,
        locator: { by: "css" as const, value: "#units" },
        key: "Enter",
      },
    ],
    [
      "check",
      {
        type: "check" as const,
        locator: { by: "css" as const, value: "#confirmed" },
        checked: true,
      },
    ],
  ])("retire aussi la suggestion après une action %s", (_type, action) => {
    // Chaque action qui peut changer la page est couverte, pas seulement le
    // clic : la borne est la nature de l'action, pas l'exemple mesuré.
    const hint = hintOf(closurePlan([goto("go"), step("act", action)], "act"));
    expect(hint).toContain("→ read [data-cash-state]");
    expect(hint).not.toContain("role=status name=");
  });
});

/**
 * Le conseil de cible est le seul endroit où le refus lit l'instantané de
 * découverte : son compte décide de l'unicité, son sélecteur décide du ciblage,
 * et son texte ne doit jamais ressortir. Les trois règles sont vérifiées ici,
 * chacune sur la forme qui les faisait échouer.
 */
describe("conseil de cible : compte, ciblage et contenu publié", () => {
  const hintOfSnapshot = (aria: string, expected?: string): string => {
    const plan = closurePlan([goto("open")], "open", expected);
    return (
      stateTargetReadRefusals(plan, { url: PREVIEW_URL, aria })[0]?.error
        .hint ?? ""
    );
  };

  it("compte TOUS les nœuds du rôle : un status vide rend la suggestion ambiguë", () => {
    // Un `- status` vide ne REND aucun texte, donc il était filtré avant le
    // compte : la suggestion appelait `role=status name=""` unique alors que
    // Playwright y résout deux éléments, et le plan corrigé échouait en strict
    // mode. L'ambiguïté est maintenant nommée par son compteur, sans choisir.
    const hint = hintOfSnapshot(
      ["- main:", `  - status: ${CLOSED_MESSAGE}`, "  - status:"].join("\n")
    );
    expect(hint).not.toContain('role=status name=""');
    expect(hint).toContain("role=status (2 nodes)");
    // Le reste du conseil ne bouge pas : la cible qui se déduit du sélecteur
    // reste proposée.
    expect(hint).toContain(
      `assertion closed-message expecting ${JSON.stringify(CLOSED_MESSAGE)} → read [data-cash-state]`
    );
  });

  it.each([
    ['[data-cash-state="cloture"] p', "[data-cash-state] p"],
    [
      "[data-state] button[aria-expanded=true]",
      "[data-state] button[aria-expanded]",
    ],
    [
      "[aria-hidden=false] [data-state] p[aria-selected=true]",
      "[aria-hidden] [data-state] p[aria-selected]",
    ],
  ])("garde l'élément sélectionné par %s : seule la valeur épinglée tombe", (selector, advice) => {
    // Remplacer tout le sélecteur par le conteneur perdait la partie de la vue
    // que le plan visait — et un conteneur plus large peut satisfaire un
    // `text` par un autre passage de la page.
    const plan = closurePlan([goto("go")], "go");
    const assertion = plan.scenarios[0]?.assertions[0];
    if (assertion) {
      assertion.target = { by: "css", value: selector };
    }
    const hint = stateTargetReadRefusals(plan)[0]?.error.hint ?? "";
    expect(hint).toContain(`→ read ${advice}`);
    expect(hint).not.toContain(selector);
  });

  it("exige la preuve qu'une forme de présence ne sélectionne qu'un élément", () => {
    // Retirer une valeur élargit le sélecteur : `[aria-expanded=true]` devient
    // `[aria-expanded]`, que tous les contrôles dépliés comme repliés portent.
    // Un texte se lit en strict mode, donc le conseil nomme la vérification qui
    // évite d'y consumer la seule correction disponible.
    const plan = closurePlan([goto("go")], "go");
    const assertion = plan.scenarios[0]?.assertions[0];
    if (assertion) {
      assertion.target = { by: "css", value: "[aria-expanded=true]" };
    }
    const hint = stateTargetReadRefusals(plan)[0]?.error.hint ?? "";
    expect(hint).toContain("→ read [aria-expanded]");
    expect(hint).toContain(
      'prove it selects one (kind "count" expecting 1) before reading a text'
    );
  });

  it("ne publie aucun texte de l'instantané dans le diagnostic sérialisé", () => {
    // Le nom accessible d'un nœud est du texte de la page : recopié dans
    // `diagnostic.hint`, il part dans le commentaire publié par
    // `reportMarkdown`. Le libellé attendu du plan est le seul texte autorisé,
    // et un nom plus long que lui n'est pas recopié du tout.
    const label = "Comptage juste";
    const pageOnly = `${label} · DEMO17`;
    // Le nom égale le texte rendu : c'est la forme que le relevé accepte, donc
    // celle qui portait le nom de la page jusqu'au diagnostic.
    const aria = ["- main:", `  - status "${pageOnly}": ${pageOnly}`].join(
      "\n"
    );
    const diagnostic = stateTargetReadRefusals(
      closurePlan([goto("open")], "open", label),
      { url: PREVIEW_URL, aria }
    )[0]?.error;
    expect(diagnostic?.code).toBe("PLAN_STATE_TARGET_READ_AS_TEXT");
    const published = JSON.stringify({
      code: diagnostic?.code,
      message: diagnostic?.message,
      hint: diagnostic?.hint,
    });
    expect(published).not.toContain("DEMO17");
    expect(published).not.toContain(pageOnly);
    // La cible reste donnée, sans son nom : le rôle ne résout qu'un élément de
    // la page de découverte.
    expect(diagnostic?.hint).toContain(
      "→ read [data-cash-state] or role=status"
    );
    expect(diagnostic?.hint).not.toContain("role=status name=");
  });

  it("recopie un nom qui EST le libellé du plan, borné comme lui", () => {
    // Borner ne veut pas dire renoncer : un nom identique au libellé attendu ne
    // dit rien que le refus ne dise déjà, donc il reste proposé.
    const label = "Comptage juste";
    const hint = hintOfSnapshot(
      ["- main:", `  - status "${label}": ${label}`].join("\n"),
      label
    );
    expect(hint).toContain(`or role=status name=${JSON.stringify(label)}`);
  });
});
