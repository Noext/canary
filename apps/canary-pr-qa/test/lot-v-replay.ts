import type { Plan } from "../src/schema.js";

/**
 * Le plan et les lignes que le run 58e47755 (déploiement de la PR #61) a
 * réellement produits, recopiés de son artefact `result.json` : mêmes
 * identifiants de scénario, mêmes rangs, mêmes citations, mêmes étapes et
 * assertions. Le run s'est arrêté sur `REQUIREMENT_UNGROUNDED`, « Weak source
 * witness » pour `ecart-a-justifier` (requirement 3), sans exécuter un seul
 * scénario.
 *
 * Deux scénarios du plan mesuré suffisent à rejouer ce refus : celui qui le
 * porte (`cash-variance-blocked-then-justified`) et celui qui témoigne de
 * `packages/domain/src/cash.ts` par une citation substantielle
 * (`cash-invalid-decimal-quantity`), sans lequel la couverture refuserait le
 * fichier pour une autre raison. Ce témoin passe en premier, comme dans le plan
 * mesuré où un scénario antérieur couvrait déjà `cash.ts` : la couverture est
 * cumulative dans l'ordre des scénarios. Les cinq autres scénarios du run ne
 * portent aucune citation fautive. `skipped` est vide : les entrées mesurées
 * nommaient les documents `openspec/` hors de ce rejeu.
 *
 * Les lignes ci-dessous sont celles des deux fichiers à la révision testée,
 * avec leur numéro réel : le gate les lit comme le contenu après changement de
 * la PR.
 */
export const LOT_V_PLAN: Plan = {
  summary:
    "QA fonctionnelle de la vue Caisse et Coffre : comptage en centimes entiers, total et écart, blocage sans justification, clôture verrouillante, réouverture, conservation par pharmacie et à travers les vues. Les fichiers de documentation OpenSpec sont explicitement hors parcours navigateur.",
  scenarios: [
    {
      id: "cash-invalid-decimal-quantity",
      title: "Quantité décimale refusée et signalée",
      rationale:
        "Le domaine refuse une quantité non entière au lieu de l'arrondir ; la vue doit signaler la ligne et ne pas produire de total trompeur.",
      kind: "edge_case",
      sourceFiles: ["apps/web/app/page.tsx", "packages/domain/src/cash.ts"],
      preconditions: [],
      steps: [
        {
          id: "s3-open",
          description: "Ouvrir l'application",
          action: {
            type: "goto",
            path: "/",
          },
        },
        {
          id: "s3-nav",
          description: "Aller sur Caisse et Coffre",
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
          id: "s3-fill-invalid",
          description: "Saisir une quantité décimale",
          action: {
            type: "fill",
            locator: {
              by: "label",
              value: "Quantité · Billet de 500 €",
            },
            value: "3,5",
          },
        },
        {
          id: "s3-assert-status",
          description: "Vérifier le statut invalide",
          action: {
            type: "assert",
            assertionId: "s3-status",
          },
        },
        {
          id: "s3-assert-error",
          description: "Vérifier le message d'erreur",
          action: {
            type: "assert",
            assertionId: "s3-error",
          },
        },
        {
          id: "s3-assert-value",
          description: "Vérifier que la saisie n'est pas arrondie",
          action: {
            type: "assert",
            assertionId: "s3-value",
          },
        },
      ],
      requirements: [
        {
          sourceFile: "packages/domain/src/cash.ts",
          quote: "if (!/^\\d{1,9}$/.test(text)) return null;",
          behavior:
            "Une quantité décimale comme 3,5 n'est pas un entier accepté : la conversion renvoie null.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote:
            "Quantité illisible sur une ligne : saisissez un nombre entier de coupures ou de pièces.",
          behavior:
            "La vue affiche ce message quand une quantité est illisible.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote: "Quantité à corriger",
          behavior:
            "Le statut de la vue devient « Quantité à corriger » quand le comptage est invalide.",
        },
      ],
      assertions: [
        {
          id: "s3-status",
          description: "La vue signale « Quantité à corriger » pour 3,5",
          target: {
            by: "css",
            value: "[data-cash-state]",
          },
          afterStep: "s3-fill-invalid",
          verification: "transition",
          kind: "text",
          expected: "Quantité à corriger",
        },
        {
          id: "s3-error",
          description:
            "Le message explique qu'un nombre entier de coupures ou de pièces est attendu",
          target: {
            by: "css",
            value: "[data-cash-state]",
          },
          afterStep: "s3-fill-invalid",
          verification: "state",
          kind: "text",
          expected:
            "Quantité illisible sur une ligne : saisissez un nombre entier de coupures ou de pièces.",
        },
        {
          id: "s3-value",
          description:
            "La valeur 3,5 reste visible dans le champ, sans arrondi silencieux",
          target: {
            by: "label",
            value: "Quantité · Billet de 500 €",
          },
          afterStep: "s3-fill-invalid",
          verification: "state",
          kind: "value",
          expected: "3,5",
        },
      ],
    },
    {
      id: "cash-variance-blocked-then-justified",
      title:
        "Écart non nul bloqué sans justification puis clôturé avec justification",
      rationale:
        "La règle ajoutée exige une justification écrite pour tout écart non nul ; le PR bloque la clôture et laisse le comptage modifiable tant que le texte manque.",
      kind: "edge_case",
      sourceFiles: ["apps/web/app/page.tsx", "packages/domain/src/cash.ts"],
      preconditions: [],
      steps: [
        {
          id: "s2-open",
          description: "Ouvrir l'application",
          action: {
            type: "goto",
            path: "/",
          },
        },
        {
          id: "s2-nav",
          description: "Aller sur Caisse et Coffre",
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
          id: "s2-fill-500",
          description: "Compter 3 billets de 500 €",
          action: {
            type: "fill",
            locator: {
              by: "label",
              value: "Quantité · Billet de 500 €",
            },
            value: "3",
          },
        },
        {
          id: "s2-assert-variance",
          description: "Vérifier l'écart calculé",
          action: {
            type: "assert",
            assertionId: "s2-variance",
          },
        },
        {
          id: "s2-assert-status",
          description: "Vérifier le statut à justifier",
          action: {
            type: "assert",
            assertionId: "s2-status",
          },
        },
        {
          id: "s2-close-blocked",
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
          id: "s2-assert-blockmsg",
          description: "Vérifier le refus de clôture",
          action: {
            type: "assert",
            assertionId: "s2-blockmsg",
          },
        },
        {
          id: "s2-assert-open",
          description: "Vérifier que le comptage reste ouvert",
          action: {
            type: "assert",
            assertionId: "s2-open-state",
          },
        },
        {
          id: "s2-fill-just",
          description: "Saisir la justification",
          action: {
            type: "fill",
            locator: {
              by: "label",
              value: "Justification de l’écart",
            },
            value: "Erreur de rendu de monnaie",
          },
        },
        {
          id: "s2-close-justified",
          description: "Clôturer avec justification",
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
          id: "s2-assert-closedmsg",
          description: "Vérifier le message de clôture",
          action: {
            type: "assert",
            assertionId: "s2-closedmsg",
          },
        },
        {
          id: "s2-assert-closed",
          description: "Vérifier l'état clôturé",
          action: {
            type: "assert",
            assertionId: "s2-closed-state",
          },
        },
      ],
      requirements: [
        {
          sourceFile: "apps/web/app/page.tsx",
          quote: "Écart à justifier",
          behavior:
            "La vue signale un écart non nul comme restant à justifier.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote: "une justification écrite est obligatoire avant clôture.",
          behavior:
            "Une clôture avec écart non nul et sans justification est refusée avec ce message.",
        },
        {
          sourceFile: "packages/domain/src/cash.ts",
          quote: "ecart-a-justifier",
          behavior:
            "La décision de clôture du domaine rend le statut ecart-a-justifier en l'absence de justification.",
        },
      ],
      assertions: [
        {
          id: "s2-variance",
          description:
            "3 × 500,00 € = 1 500,00 € ; écart = 1 500,00 − 1 240,00 = +260,00 €",
          target: {
            by: "css",
            value: "[data-cash-state]",
          },
          afterStep: "s2-fill-500",
          verification: "transition",
          kind: "text",
          expected: "260,00",
        },
        {
          id: "s2-status",
          description:
            "L'écart non nul est présenté comme « Écart à justifier »",
          target: {
            by: "css",
            value: "[data-cash-state]",
          },
          afterStep: "s2-fill-500",
          verification: "state",
          kind: "text",
          expected: "Écart à justifier",
        },
        {
          id: "s2-blockmsg",
          description:
            "La clôture est refusée tant que la justification écrite manque",
          target: {
            by: "role",
            value: "status",
            name: "",
          },
          afterStep: "s2-close-blocked",
          verification: "transition",
          kind: "text",
          expected: "une justification écrite est obligatoire avant clôture.",
        },
        {
          id: "s2-open-state",
          description: "Le comptage reste ouvert après le refus",
          target: {
            by: "css",
            value: "[data-cash-state=ouvert]",
          },
          afterStep: "s2-close-blocked",
          verification: "state",
          kind: "visible",
        },
        {
          id: "s2-closedmsg",
          description:
            "Après justification, la clôture est acceptée et verrouille le comptage",
          target: {
            by: "role",
            value: "status",
            name: "",
          },
          afterStep: "s2-close-justified",
          verification: "transition",
          kind: "text",
          expected: "Session clôturée : le comptage est verrouillé.",
        },
        {
          id: "s2-closed-state",
          description: "L'état de la vue passe à clôturé après justification",
          target: {
            by: "css",
            value: "[data-cash-state=cloture]",
          },
          afterStep: "s2-close-justified",
          verification: "state",
          kind: "visible",
        },
      ],
    },
  ],
  skipped: [],
};
/** `apps/web/app/page.tsx` à la révision testée : les lignes que le plan cite et celles qui portent les identifiants refusés. */
export const PAGE_TS_LINES = [
  {
    line: 350,
    text: '  const status=closed?"Session clôturée":!counted.ok?"Quantité à corriger":variance===null?"Comptage en cours":balanced?"Comptage juste":closure?.status==="ecart-justifie"?"Écart justifié":"Écart à justifier";',
  },
  {
    line: 354,
    text: `  const close=()=>{if(!counted.ok){setMessage("Quantité illisible : corrigez la ligne signalée avant de clôturer.");return}if(expectedCents===null){setMessage("Montant d’espèces attendu manquant ou illisible.");return}if(closure?.blocking){setMessage(\`Écart de \${formatAmountFr(centsToEuros(closure.varianceCents))} : une justification écrite est obligatoire avant clôture.\`);return}onChange({closedAt:new Date().toISOString()});setMessage("Session clôturée : le comptage est verrouillé.")};`,
  },
  {
    line: 368,
    text: `          <span className="rounded-full bg-[#f1f2f8] px-2.5 py-1 text-xs font-bold text-[#74758d]">{counted.ok?\`\${counted.totalUnits} unité\${counted.totalUnits>1?"s":""} comptée\${counted.totalUnits>1?"s":""}\`:"—"}</span>`,
  },
  {
    line: 375,
    text: '        {!counted.ok&&<p className="mt-4 text-sm font-semibold text-[#b42318]">Quantité illisible sur une ligne : saisissez un nombre entier de coupures ou de pièces.</p>}',
  },
];
/** `packages/domain/src/cash.ts` à la révision testée : les lignes que le plan cite et celles qui portent les identifiants refusés. */
export const CASH_TS_LINES = [
  { line: 77, text: "  if (!/^\\d{1,9}$/.test(text)) return null;" },
  {
    line: 116,
    text: 'export type CashClosureStatus = "compte-juste" | "ecart-justifie" | "ecart-a-justifier";',
  },
  {
    line: 144,
    text: '    return { varianceCents, status: "ecart-justifie", blocking: false };',
  },
  {
    line: 146,
    text: '  return { varianceCents, status: "ecart-a-justifier", blocking: true };',
  },
];
