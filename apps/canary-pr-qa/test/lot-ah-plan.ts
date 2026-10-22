import type { Plan } from "../src/schema.js";

/**
 * Les six scénarios que le run 91fb1e35 (22 oct. 2026, PR 17 de
 * `pharmania/arpilabe-pilotage`, SHA testé 814b671305b005ab516db66bc3da1d8239bcef16)
 * a bloqués d'un coup en `CONTRACT_INCOMPLETE`, recopiés de l'artefact du run
 * sans retouche : mêmes identifiants, mêmes étapes, mêmes assertions, mêmes
 * cibles, mêmes `skipped`. Le plan est conservé tel quel, exigences comprises :
 * un rejeu qui l'allègerait ne prouverait plus ce que le run a réellement
 * produit.
 *
 * Les six partagent la même forme : la première étape est `observe` (« partir de
 * la page déjà chargée »), les suivantes agissent et vérifient. Sur les 200 runs
 * et 1 098 scénarios disponibles le 22 oct. 2026, ces six scénarios sont les
 * seuls à planifier une étape `observe`, et ce sont exactement les six bloqués.
 */
export const LOT_AH_PLAN: Plan = {
  summary:
    "Le lot ajoute l'écran Caisse et Coffre (comptage des espèces par dénomination, total compté en centimes entiers, écart compté − attendu, justification obligatoire si l'écart n'est pas nul, clôture verrouillante, réouverture, état conservé par pharmacie) alimenté par le nouveau module de domaine `packages/domain/src/cash.ts` exporté par `src/index.ts`. Six scénarios navigateur couvrent : comptage exact → « Comptage juste » et clôture acceptée/verrouillée, écart non justifié → clôture refusée (3 × 500,00 € comptés contre 1 240,00 € attendus = écart de +260,00 €), écart justifié → clôture puis réouverture, quantité décimale refusée avec ligne signalée, régression de dérive flottante (7 × 0,20 € + 3 × 0,10 € = 1,70 €), conservation du comptage par pharmacie à travers les vues. Les fichiers de documentation (AGENTS.md, openspec proposal/tasks) sont explicitement écartés sauf les deux AGENTS.md de code, couverts par un témoin documentaire, faute de parcours exécutable propre. Aucune persistance n'existe (état en mémoire de la vue) : aucun scénario de rechargement n'est planifié.",
  scenarios: [
    {
      id: "caisse-comptage-juste-cloture",
      title:
        "Comptage 2 × 500 € + 2 × 100 € + 2 × 20 € = 1 240,00 € : statut « Comptage juste », clôture acceptée et comptage verrouillé",
      rationale:
        "La vue caisse remplace le Work in Progress (page.tsx:106, anciennement WorkInProgress) et branche countCash/assessCashClosure du domaine : un total égal au montant attendu 1 240,00 € produit variance 0, statut compte-juste (cash.ts:141) et une clôture non bloquante qui écrit closedAt et affiche « Session clôturée : le comptage est verrouillé. »",
      kind: "happy_path",
      sourceFiles: [
        "apps/web/app/page.tsx",
        "packages/domain/src/cash.ts",
        "packages/domain/src/index.ts",
        "apps/web/AGENTS.md",
      ],
      preconditions: [],
      steps: [
        {
          id: "open",
          description: "Partir de la page de pilotage déjà chargée",
          action: {
            type: "observe",
          },
        },
        {
          id: "nav-caisse",
          description: "Ouvrir la vue Caisse et Coffre depuis la navigation",
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
          id: "check-expected",
          description: "Vérifier le montant attendu par défaut",
          action: {
            type: "assert",
            assertionId: "expected-default",
          },
        },
        {
          id: "q500",
          description: "Compter 2 billets de 500 €",
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
          id: "q100",
          description: "Compter 2 billets de 100 €",
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
          id: "q20",
          description: "Compter 2 billets de 20 €",
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
          id: "check-units",
          description: "Vérifier le nombre d'unités comptées",
          action: {
            type: "assert",
            assertionId: "units",
          },
        },
        {
          id: "check-total",
          description: "Vérifier le total compté",
          action: {
            type: "assert",
            assertionId: "total",
          },
        },
        {
          id: "check-status",
          description: "Vérifier le statut affiché",
          action: {
            type: "assert",
            assertionId: "status-juste",
          },
        },
        {
          id: "close",
          description: "Clôturer la session",
          action: {
            type: "click",
            locator: {
              by: "role",
              value: "button",
              name: "Clôturer la session",
            },
          },
        },
        {
          id: "check-closed",
          description: "Vérifier le message de clôture",
          action: {
            type: "assert",
            assertionId: "closed-message",
          },
        },
        {
          id: "check-locked",
          description: "Vérifier que la vue est passée en état clôturé",
          action: {
            type: "assert",
            assertionId: "locked-state",
          },
        },
        {
          id: "check-reopen",
          description: "Vérifier l'apparition du contrôle de réouverture",
          action: {
            type: "assert",
            assertionId: "reopen-visible",
          },
        },
      ],
      requirements: [
        {
          sourceFile: "apps/web/app/page.tsx",
          quote: 'expected: "1 240,00"',
          behavior:
            "La session de caisse ouvre avec un montant d'espèces attendu de 1 240,00 €, ce qui rend l'écart calculable dès l'ouverture de la vue.",
        },
        {
          sourceFile: "packages/domain/src/cash.ts",
          quote:
            '    return { varianceCents, status: "compte-juste", blocking: false };',
          behavior:
            "Un écart nul donne le statut compte-juste et ne bloque pas la clôture.",
        },
        {
          sourceFile: "packages/domain/src/cash.ts",
          quote: "totalCents += subtotalCents;",
          behavior:
            "Le total compté est accumulé en centimes entiers à partir des sous-totaux de ligne, jamais en euros flottants.",
        },
        {
          sourceFile: "packages/domain/src/index.ts",
          quote: 'export * from "./cash";',
          behavior:
            "Le module de comptage caisse est réexporté par l'index du domaine, donc consommable par apps/web.",
        },
        {
          sourceFile: "apps/web/AGENTS.md",
          quote:
            "justification obligatoire si l'écart n'est pas nul, clôture qui verrouille puis réouverture, comptage conservé par pharmacie entre les vues",
          behavior:
            "L'index du répertoire web documente le parcours livré : écart, justification obligatoire, clôture verrouillante, réouverture et état par pharmacie.",
        },
      ],
      assertions: [
        {
          id: "expected-default",
          description:
            "Le champ « Montant d’espèces attendu » contient la valeur d'interface 1 240,00",
          target: {
            by: "role",
            value: "textbox",
            name: "Montant d’espèces attendu",
          },
          afterStep: "nav-caisse",
          verification: "state",
          kind: "value",
          expected: "1 240,00",
        },
        {
          id: "units",
          description:
            "Badge d'unités : 2 + 2 + 2 = 6 unités comptées (4 unités avant la dernière saisie)",
          target: {
            by: "css",
            value: "[data-cash-state]",
          },
          afterStep: "q20",
          verification: "transition",
          kind: "text",
          expected: "6 unités comptées",
        },
        {
          id: "total",
          description:
            "Total compté : 2 × 500,00 € + 2 × 100,00 € + 2 × 20,00 € = 1 240,00 €",
          target: {
            by: "css",
            value: "[data-cash-state]",
          },
          afterStep: "q20",
          verification: "state",
          kind: "text",
          expected: "1 240,00 €",
        },
        {
          id: "status-juste",
          description: "Écart nul : le statut affiché est « Comptage juste »",
          target: {
            by: "css",
            value: "[data-cash-state]",
          },
          afterStep: "q20",
          verification: "state",
          kind: "text",
          expected: "Comptage juste",
        },
        {
          id: "closed-message",
          description:
            "La clôture acceptée annonce le verrouillage du comptage",
          target: {
            by: "role",
            value: "status",
            name: "",
          },
          afterStep: "close",
          verification: "transition",
          kind: "text",
          expected: "Session clôturée : le comptage est verrouillé.",
        },
        {
          id: "locked-state",
          description:
            'La racine de la vue porte data-cash-state="cloture" après la clôture',
          target: {
            by: "css",
            value: '[data-cash-state="cloture"]',
          },
          afterStep: "close",
          verification: "state",
          kind: "visible",
        },
        {
          id: "reopen-visible",
          description:
            "Le bouton de réouverture du comptage est proposé une fois la session clôturée",
          target: {
            by: "role",
            value: "button",
            name: "Réouvrir le comptage",
          },
          afterStep: "close",
          verification: "state",
          kind: "visible",
        },
      ],
    },
    {
      id: "caisse-ecart-sans-justification",
      title:
        "3 × 500,00 € comptés contre 1 240,00 € attendus : écart de +260,00 € et clôture refusée faute de justification écrite",
      rationale:
        "cash.ts:146 rend ecart-a-justifier/blocking=true quand l'écart n'est pas nul sans justification écrite ; page.tsx refuse alors la clôture en affichant le message d'écart, et la vue reste en état ouvert (data-cash-state=\"ouvert\").",
      kind: "edge_case",
      sourceFiles: ["apps/web/app/page.tsx", "packages/domain/src/cash.ts"],
      preconditions: [],
      steps: [
        {
          id: "open",
          description: "Partir de la page de pilotage déjà chargée",
          action: {
            type: "observe",
          },
        },
        {
          id: "nav-caisse",
          description: "Ouvrir la vue Caisse et Coffre",
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
          id: "q500",
          description: "Compter 3 billets de 500 €",
          action: {
            type: "fill",
            locator: {
              by: "role",
              value: "textbox",
              name: "Quantité · Billet de 500 €",
            },
            value: "3",
          },
        },
        {
          id: "check-variance",
          description: "Vérifier l'écart affiché",
          action: {
            type: "assert",
            assertionId: "variance",
          },
        },
        {
          id: "close",
          description: "Tenter de clôturer sans justification",
          action: {
            type: "click",
            locator: {
              by: "role",
              value: "button",
              name: "Clôturer la session",
            },
          },
        },
        {
          id: "check-refusal",
          description: "Vérifier le refus motivé",
          action: {
            type: "assert",
            assertionId: "refusal",
          },
        },
        {
          id: "check-open",
          description:
            "Vérifier que la session n'est pas passée en état clôturé",
          action: {
            type: "assert",
            assertionId: "still-open",
          },
        },
      ],
      requirements: [
        {
          sourceFile: "packages/domain/src/cash.ts",
          quote:
            '  return { varianceCents, status: "ecart-a-justifier", blocking: true };',
          behavior:
            "Un écart non nul sans justification écrite donne le statut ecart-a-justifier et bloque la clôture.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote: "une justification écrite est obligatoire avant clôture.",
          behavior:
            "La clôture bloquée affiche l'écart montant et exige une justification écrite.",
        },
      ],
      assertions: [
        {
          id: "variance",
          description:
            "Écart signé compté − attendu : 3 × 500,00 € = 1 500,00 € comptés, attendu 1 240,00 €, donc +260,00 €",
          target: {
            by: "css",
            value: "[data-cash-state]",
          },
          afterStep: "q500",
          verification: "transition",
          kind: "text",
          expected: "260,00 €",
        },
        {
          id: "refusal",
          description:
            "Clôture refusée avec le montant de l'écart et l'exigence de justification",
          target: {
            by: "role",
            value: "status",
            name: "",
          },
          afterStep: "close",
          verification: "transition",
          kind: "text",
          expected:
            "Écart de 260,00 € : une justification écrite est obligatoire avant clôture.",
        },
        {
          id: "still-open",
          description:
            'La vue reste en état ouvert : aucun conteneur data-cash-state="cloture" n\'est rendu',
          target: {
            by: "css",
            value: '[data-cash-state="cloture"]',
          },
          afterStep: "close",
          verification: "state",
          kind: "hidden",
        },
      ],
    },
    {
      id: "caisse-ecart-justifie-puis-reouverture",
      title:
        "Écart de 260,00 € justifié par écrit : clôture acceptée, puis réouverture du comptage",
      rationale:
        "cash.ts:144 débloque la clôture dès qu'une justification non vide est écrite ; page.tsx expose le champ de justification (libellé « obligatoire si l'écart n'est pas nul ») et le bouton de réouverture qui remet closedAt à null.",
      kind: "happy_path",
      sourceFiles: ["apps/web/app/page.tsx", "packages/domain/src/cash.ts"],
      preconditions: [],
      steps: [
        {
          id: "open",
          description: "Partir de la page de pilotage déjà chargée",
          action: {
            type: "observe",
          },
        },
        {
          id: "nav-caisse",
          description: "Ouvrir la vue Caisse et Coffre",
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
          id: "q500",
          description: "Compter 3 billets de 500 € (écart de +260,00 €)",
          action: {
            type: "fill",
            locator: {
              by: "role",
              value: "textbox",
              name: "Quantité · Billet de 500 €",
            },
            value: "3",
          },
        },
        {
          id: "justification",
          description: "Écrire la justification de l'écart",
          action: {
            type: "fill",
            locator: {
              by: "role",
              value: "textbox",
              name: "Justification de l’écart",
            },
            value: "Erreur de rendu de monnaie",
          },
        },
        {
          id: "close",
          description: "Clôturer la session justifiée",
          action: {
            type: "click",
            locator: {
              by: "role",
              value: "button",
              name: "Clôturer la session",
            },
          },
        },
        {
          id: "check-closed",
          description: "Vérifier le message de clôture",
          action: {
            type: "assert",
            assertionId: "closed-message",
          },
        },
        {
          id: "check-locked",
          description: "Vérifier l'état clôturé de la vue",
          action: {
            type: "assert",
            assertionId: "locked-state",
          },
        },
        {
          id: "reopen",
          description: "Réouvrir le comptage",
          action: {
            type: "click",
            locator: {
              by: "role",
              value: "button",
              name: "Réouvrir le comptage",
            },
          },
        },
        {
          id: "check-reopened",
          description: "Vérifier le message de réouverture",
          action: {
            type: "assert",
            assertionId: "reopened-message",
          },
        },
        {
          id: "check-open",
          description: "Vérifier le retour à l'état ouvert",
          action: {
            type: "assert",
            assertionId: "open-state",
          },
        },
      ],
      requirements: [
        {
          sourceFile: "apps/web/app/page.tsx",
          quote:
            '          <label className="text-sm font-semibold">Justification de l’écart (obligatoire si l’écart n’est pas nul)',
          behavior:
            "Le champ de justification est présenté comme obligatoire lorsque l'écart n'est pas nul.",
        },
        {
          sourceFile: "packages/domain/src/cash.ts",
          quote:
            '    return { varianceCents, status: "ecart-justifie", blocking: false };',
          behavior:
            "Une justification écrite débloque la clôture avec le statut ecart-justifie.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote: "Comptage réouvert : corrigez puis clôturez à nouveau.",
          behavior:
            "La réouverture remet la session en état modifiable et l'annonce à l'utilisateur.",
        },
      ],
      assertions: [
        {
          id: "closed-message",
          description:
            "La justification écrite permet la clôture : message de session clôturée et verrouillée",
          target: {
            by: "role",
            value: "status",
            name: "",
          },
          afterStep: "close",
          verification: "transition",
          kind: "text",
          expected: "Session clôturée : le comptage est verrouillé.",
        },
        {
          id: "locked-state",
          description: "La vue porte l'état clôturé après la clôture justifiée",
          target: {
            by: "css",
            value: '[data-cash-state="cloture"]',
          },
          afterStep: "close",
          verification: "state",
          kind: "visible",
        },
        {
          id: "reopened-message",
          description:
            "La réouverture annonce que le comptage peut être corrigé puis clôturé à nouveau",
          target: {
            by: "role",
            value: "status",
            name: "",
          },
          afterStep: "reopen",
          verification: "transition",
          kind: "text",
          expected: "Comptage réouvert : corrigez puis clôturez à nouveau.",
        },
        {
          id: "open-state",
          description: "Après réouverture, la vue repasse en état ouvert",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "reopen",
          verification: "state",
          kind: "visible",
        },
      ],
    },
    {
      id: "caisse-quantite-decimale-refusee",
      title:
        "Quantité « 3,5 » refusée sur la ligne Billet de 500 € : ligne signalée et statut « Quantité à corriger »",
      rationale:
        "toUnits de cash.ts n'accepte qu'un entier en chiffres et renvoie QUANTITE_INVALIDE (cash.ts:92) ; page.tsx marque alors le champ en aria-invalid, affiche le message d'erreur et remplace le statut par « Quantité à corriger ».",
      kind: "edge_case",
      sourceFiles: ["apps/web/app/page.tsx", "packages/domain/src/cash.ts"],
      preconditions: [],
      steps: [
        {
          id: "open",
          description: "Partir de la page de pilotage déjà chargée",
          action: {
            type: "observe",
          },
        },
        {
          id: "nav-caisse",
          description: "Ouvrir la vue Caisse et Coffre",
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
          id: "q500",
          description:
            "Saisir une quantité décimale sur la ligne Billet de 500 €",
          action: {
            type: "fill",
            locator: {
              by: "role",
              value: "textbox",
              name: "Quantité · Billet de 500 €",
            },
            value: "3,5",
          },
        },
        {
          id: "check-invalid",
          description: "Vérifier que la ligne fautive est marquée invalide",
          action: {
            type: "assert",
            assertionId: "invalid-field",
          },
        },
        {
          id: "check-status",
          description: "Vérifier le statut de comptage illisible",
          action: {
            type: "assert",
            assertionId: "status-invalide",
          },
        },
        {
          id: "check-message",
          description: "Vérifier le message d'explication",
          action: {
            type: "assert",
            assertionId: "error-message",
          },
        },
      ],
      requirements: [
        {
          sourceFile: "packages/domain/src/cash.ts",
          quote: '        code: "QUANTITE_INVALIDE",',
          behavior:
            "Une quantité non entière produit le code QUANTITE_INVALIDE au lieu d'être arrondie.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote: "aria-invalid={invalid||undefined}",
          behavior:
            "Le champ de quantité de la dénomination fautive porte aria-invalid, donc la ligne est signalée.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote:
            "Quantité illisible sur une ligne : saisissez un nombre entier de coupures ou de pièces.",
          behavior:
            "Un message explique qu'une quantité doit être un nombre entier de coupures ou de pièces.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote: "Quantité à corriger",
          behavior:
            "Le statut affiché devient « Quantité à corriger » quand le comptage est illisible.",
        },
      ],
      assertions: [
        {
          id: "invalid-field",
          description:
            'Seul le champ Billet de 500 € porte aria-invalid="true"',
          target: {
            by: "css",
            value:
              '[aria-label="Quantité · Billet de 500 €"][aria-invalid="true"]',
          },
          afterStep: "q500",
          verification: "state",
          kind: "visible",
        },
        {
          id: "status-invalide",
          description:
            "Le statut passe de « Écart à justifier » à « Quantité à corriger »",
          target: {
            by: "css",
            value: "[data-cash-state]",
          },
          afterStep: "q500",
          verification: "transition",
          kind: "text",
          expected: "Quantité à corriger",
        },
        {
          id: "error-message",
          description:
            "Le message d'erreur de saisie est affiché sous les dénominations",
          target: {
            by: "css",
            value: "[data-cash-state]",
          },
          afterStep: "q500",
          verification: "state",
          kind: "text",
          expected:
            "Quantité illisible sur une ligne : saisissez un nombre entier de coupures ou de pièces.",
        },
      ],
    },
    {
      id: "caisse-derive-flottante",
      title:
        "Régression de dérive flottante : 7 × 0,20 € + 3 × 0,10 € affiche 1,70 € exactement",
      rationale:
        "Le test ajouté (cash.spec.ts) fige 170 centimes pour 7 × 0,20 € + 3 × 0,10 € ; cash.ts calcule chaque sous-total en centimes entiers et page.tsx affiche le total via formatAmountFr(centsToEuros(counted.totalCents)), donc l'écran doit montrer 1,70 € et non 1.7000000000000002.",
      kind: "regression",
      sourceFiles: [
        "packages/domain/src/__tests__/cash.spec.ts",
        "packages/domain/src/cash.ts",
        "apps/web/app/page.tsx",
        "packages/domain/AGENTS.md",
      ],
      preconditions: [],
      steps: [
        {
          id: "open",
          description: "Partir de la page de pilotage déjà chargée",
          action: {
            type: "observe",
          },
        },
        {
          id: "nav-caisse",
          description: "Ouvrir la vue Caisse et Coffre",
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
          id: "p20",
          description: "Compter 7 pièces de 20 c",
          action: {
            type: "fill",
            locator: {
              by: "role",
              value: "textbox",
              name: "Quantité · Pièce de 20 c",
            },
            value: "7",
          },
        },
        {
          id: "p10",
          description: "Compter 3 pièces de 10 c",
          action: {
            type: "fill",
            locator: {
              by: "role",
              value: "textbox",
              name: "Quantité · Pièce de 10 c",
            },
            value: "3",
          },
        },
        {
          id: "check-total",
          description: "Vérifier le total compté",
          action: {
            type: "assert",
            assertionId: "total-flottant",
          },
        },
      ],
      requirements: [
        {
          sourceFile: "packages/domain/src/__tests__/cash.spec.ts",
          quote: "expect(total(result)).toBe(170);",
          behavior:
            "La régression de dérive flottante exige 7 × 0,20 € + 3 × 0,10 € = 170 centimes exactement.",
        },
        {
          sourceFile: "packages/domain/src/cash.ts",
          quote: "const subtotalCents = units * denomination.cents;",
          behavior:
            "Chaque sous-total est le produit entier d'une quantité par une dénomination en centimes.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote: "formatAmountFr(centsToEuros(counted.totalCents))",
          behavior:
            "Le total compté affiché provient du total en centimes reconverti en euros.",
        },
        {
          sourceFile: "packages/domain/AGENTS.md",
          quote:
            "le montant attendu est une donnée, aucune ventilation, tolérance ni règle de rapprochement n'est inventée",
          behavior:
            "L'index du domaine documente le périmètre : montant attendu saisi, aucune règle de tolérance ou de rapprochement inventée.",
        },
      ],
      assertions: [
        {
          id: "total-flottant",
          description:
            "Total compté : 7 × 0,20 € = 1,40 € plus 3 × 0,10 € = 0,30 € donnent 1,70 € exactement (et non 1.7000000000000002)",
          target: {
            by: "css",
            value: "[data-cash-state]",
          },
          afterStep: "p10",
          verification: "transition",
          kind: "text",
          expected: "1,70 €",
        },
      ],
    },
    {
      id: "caisse-etat-par-pharmacie",
      title:
        "Comptage conservé après un aller-retour de vue, et distinct entre DEMO17 et DEMO18",
      rationale:
        "La session de caisse vit dans Home, indexée par pharmacyCode : un changement de vue ne la perd pas, et changer de pharmacie affiche un comptage distinct (page.tsx:106 rend CashAndSafe avec la session de la pharmacie active).",
      kind: "regression",
      sourceFiles: ["apps/web/app/page.tsx"],
      preconditions: [],
      steps: [
        {
          id: "open",
          description: "Partir de la page de pilotage déjà chargée",
          action: {
            type: "observe",
          },
        },
        {
          id: "nav-caisse",
          description: "Ouvrir la vue Caisse et Coffre sur DEMO17",
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
          id: "q500",
          description: "Compter 2 billets de 500 €",
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
          id: "check-units",
          description: "Vérifier le comptage saisi",
          action: {
            type: "assert",
            assertionId: "units",
          },
        },
        {
          id: "leave",
          description: "Quitter la vue vers Pilotage",
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
          id: "back",
          description: "Revenir sur Caisse et Coffre",
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
          id: "check-kept",
          description: "Vérifier que le comptage est conservé",
          action: {
            type: "assert",
            assertionId: "units-kept",
          },
        },
        {
          id: "switch-pharmacy",
          description: "Basculer sur la pharmacie DEMO18",
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
          id: "check-other",
          description: "Vérifier que le comptage de DEMO18 est vide",
          action: {
            type: "assert",
            assertionId: "units-other",
          },
        },
      ],
      requirements: [
        {
          sourceFile: "apps/web/app/page.tsx",
          quote:
            '        {view==="caisse"&&<CashAndSafe session={cashSession} onChange={updateCash} pharmacyCode={pharmacyCode}/>}',
          behavior:
            "La vue caisse rend le composant Caisse et Coffre relié à la session de caisse de la pharmacie active.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote: "...(sessions[pharmacyCode]??emptyCashSession)",
          behavior:
            "La mise à jour du comptage écrit dans l'entrée de la pharmacie active, donc deux pharmacies ne partagent pas le même tiroir.",
        },
      ],
      assertions: [
        {
          id: "units",
          description:
            "Badge d'unités après saisie : 2 billets de 500 € = 2 unités comptées",
          target: {
            by: "css",
            value: "[data-cash-state]",
          },
          afterStep: "q500",
          verification: "transition",
          kind: "text",
          expected: "2 unités comptées",
        },
        {
          id: "units-kept",
          description:
            "Après aller Pilotage → Caisse et Coffre, le comptage de DEMO17 est toujours là",
          target: {
            by: "css",
            value: "[data-cash-state]",
          },
          afterStep: "back",
          verification: "state",
          kind: "text",
          expected: "2 unités comptées",
        },
        {
          id: "units-other",
          description:
            "DEMO18 ouvre un comptage distinct : aucune unité comptée",
          target: {
            by: "css",
            value: "[data-cash-state]",
          },
          afterStep: "switch-pharmacy",
          verification: "state",
          kind: "text",
          expected: "0 unité comptée",
        },
      ],
    },
  ],
  skipped: [
    {
      sourceFile: "openspec/AGENTS.md",
      reason:
        "Documentation d'index du répertoire openspec (ligne ajoutée pour caisse-comptage-ecart) : aucun comportement exécutable en Chromium.",
    },
    {
      sourceFile: "openspec/changes/caisse-comptage-ecart/AGENTS.md",
      reason:
        "Documentation d'index du change openspec : aucun comportement exécutable en Chromium.",
    },
    {
      sourceFile: "openspec/changes/caisse-comptage-ecart/proposal.md",
      reason:
        "Proposition/limites/critères du change, y compris les limites « aucune persistance », « aucun droit ni rôle » : document non exécutable, les comportements qu'il décrit sont couverts par les scénarios sur apps/web/app/page.tsx et packages/domain/src/cash.ts.",
    },
    {
      sourceFile: "openspec/changes/caisse-comptage-ecart/tasks.md",
      reason:
        "Liste de tâches et d'écarts de rituel (RED non observé, CI/aperçu à constater) : document non exécutable.",
    },
  ],
};
