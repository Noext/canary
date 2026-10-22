import type { Plan } from "../src/schema.js";

/**
 * Les deux scénarios RÉELS du run 20c3c29a (22 oct. 2026, PR 20 de
 * `pharmania/arpilabe-pilotage`, SHA testé 5a48a466049135eb4006a8a8912f093c97c29238),
 * copiés de l'artefact du run sans retouche : mêmes identifiants, mêmes étapes,
 * mêmes cibles, mêmes exigences. Ce sont les deux scénarios que la version
 * statique du gate a bloqués en `PLAN_TARGET_NOT_IN_SOURCE` pour
 * `Quantité · Billet de 20 €` et `Quantité · Billet de 100 €` — deux libellés
 * que l'application rend réellement, depuis `packages/domain/src/cash.ts`, un
 * fichier que le diff de la PR 20 ne touche pas.
 *
 * Le plan est conservé tel quel : un rejeu qui l'allègerait ne prouverait plus ce
 * que le run a réellement produit.
 */
export const LOT_AL_SCENARIOS: Plan["scenarios"] = [
  {
    id: "cash-empty-drawer-blocked",
    title:
      "Tiroir vide : écart -124000 affiché, clôture refusée, écart recalculé à la saisie",
    rationale:
      "page.tsx expose data-cash-state et data-cash-variance-cents depuis describeCashSession, et closeCashSession refuse tant que l'écart non nul n'est pas justifié : le tiroir vide doit produire -124000 et non une clôture.",
    kind: "edge_case",
    sourceFiles: [
      "apps/web/app/page.tsx",
      "apps/web/lib/cash-session.ts",
      "packages/domain/src/cash.ts",
    ],
    preconditions: [],
    steps: [
      {
        id: "goto-home",
        description: "ouvrir l'application",
        action: {
          type: "goto",
          path: "/",
        },
      },
      {
        id: "open-cash-view",
        description: "ouvrir la vue Caisse et Coffre",
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
        id: "assert-state-empty",
        description: "vérifier l'état écart à justifier",
        action: {
          type: "assert",
          assertionId: "state-empty",
        },
      },
      {
        id: "assert-variance-empty",
        description: "vérifier l'écart du tiroir vide",
        action: {
          type: "assert",
          assertionId: "variance-empty",
        },
      },
      {
        id: "assert-total-zero",
        description: "vérifier le total compté nul",
        action: {
          type: "assert",
          assertionId: "total-zero",
        },
      },
      {
        id: "try-close",
        description: "tenter de clôturer sans motif",
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
        id: "assert-still-open",
        description: "vérifier que la session reste ouverte",
        action: {
          type: "assert",
          assertionId: "still-open",
        },
      },
      {
        id: "count-20-note",
        description: "compter un billet de 20 €",
        action: {
          type: "fill",
          locator: {
            by: "role",
            value: "textbox",
            name: "Quantité · Billet de 20 €",
          },
          value: "1",
        },
      },
      {
        id: "assert-variance-recomputed",
        description: "vérifier le nouvel écart",
        action: {
          type: "assert",
          assertionId: "variance-recomputed",
        },
      },
    ],
    requirements: [
      {
        sourceFile: "apps/web/app/page.tsx",
        quote:
          '        <div className="relative overflow-hidden rounded-2xl bg-[#08086f] p-5 text-white"><div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-[#912cff]/45"/><p className="relative text-sm text-white/60">Total compté</p><p className="relative mt-2 text-2xl font-bold" data-cash-total-cents={view.totalCents===null?"indisponible":String(view.totalCents)}>{view.totalLabel}</p><div className="relative my-4 border-t border-white/10"/><p className="relative text-sm text-white/60">Écart, compté − attendu</p><p className="relative mt-2 text-2xl font-bold" data-cash-variance-cents={view.varianceCents===null?"indisponible":String(view.varianceCents)}>{view.varianceLabel}</p></div>',
        behavior:
          "Le total compté et l'écart sont exposés en centimes dans data-cash-total-cents et data-cash-variance-cents, ou « indisponible ».",
      },
      {
        sourceFile: "apps/web/lib/cash-session.ts",
        quote:
          "    counted.ok && expectedCents !== null ? cashVarianceCents(counted.totalCents, expectedCents) : null;",
        behavior:
          "L'écart n'est calculé que si le comptage est valide et le montant attendu lisible.",
      },
      {
        sourceFile: "apps/web/lib/cash-session.ts",
        quote:
          "  if (!state.canClose || state.totalCents === null || state.expectedCents === null || state.varianceCents === null) {",
        behavior: "La clôture est refusée (null) tant que l'écran bloque.",
      },
      {
        sourceFile: "packages/domain/src/cash.ts",
        quote:
          '  return { varianceCents, status: "ecart-a-justifier", blocking: true };',
        behavior: "Un écart non nul sans justification est bloquant.",
      },
    ],
    assertions: [
      {
        id: "state-empty",
        description: "le conteneur expose l'état ecart-a-justifier",
        target: {
          by: "css",
          value: '[data-cash-state="ecart-a-justifier"]',
        },
        afterStep: "open-cash-view",
        verification: "state",
        kind: "visible",
      },
      {
        id: "variance-empty",
        description: "tiroir vide : écart = 0 − 124 000 = -124000 centimes",
        target: {
          by: "css",
          value: '[data-cash-variance-cents="-124000"]',
        },
        afterStep: "open-cash-view",
        verification: "state",
        kind: "visible",
      },
      {
        id: "total-zero",
        description: "tiroir vide : total compté = 0 centime",
        target: {
          by: "css",
          value: '[data-cash-total-cents="0"]',
        },
        afterStep: "open-cash-view",
        verification: "state",
        kind: "visible",
      },
      {
        id: "still-open",
        description:
          "la clôture refusée laisse la session hors de l'état cloture",
        target: {
          by: "css",
          value: '[data-cash-state="cloture"]',
        },
        afterStep: "try-close",
        verification: "state",
        kind: "count",
        expected: 0,
      },
      {
        id: "variance-recomputed",
        description:
          "1 × 20 € = 2 000 centimes, écart 2 000 − 124 000 = -122000 centimes",
        target: {
          by: "css",
          value: '[data-cash-variance-cents="-122000"]',
        },
        afterStep: "count-20-note",
        verification: "transition",
        kind: "visible",
      },
    ],
  },
  {
    id: "cash-exact-count-closes",
    title:
      "Compte juste (1 240 €) : clôture acceptée, historique créé, « Rouvrir la session » apparaît",
    rationale:
      "describeCashSession rend compte-juste/0 quand le comptage égale le montant attendu ; closeCashSession archive la clôture et page.tsx n'affiche le contrôle de réouverture que dans l'état clôturé.",
    kind: "happy_path",
    sourceFiles: [
      "apps/web/app/page.tsx",
      "apps/web/lib/cash-session.ts",
      "packages/domain/src/cash.ts",
      "apps/web/AGENTS.md",
    ],
    preconditions: [],
    steps: [
      {
        id: "goto-home",
        description: "ouvrir l'application",
        action: {
          type: "goto",
          path: "/",
        },
      },
      {
        id: "open-cash-view",
        description: "ouvrir la vue Caisse et Coffre",
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
        id: "count-500",
        description: "compter 2 billets de 500 €",
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
        id: "count-100",
        description: "compter 2 billets de 100 €",
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
        id: "count-20",
        description: "compter 2 billets de 20 €",
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
        id: "assert-compte-juste",
        description: "vérifier l'état compte juste",
        action: {
          type: "assert",
          assertionId: "compte-juste",
        },
      },
      {
        id: "assert-label",
        description: "vérifier le libellé de statut",
        action: {
          type: "assert",
          assertionId: "status-label",
        },
      },
      {
        id: "assert-total",
        description: "vérifier le total compté",
        action: {
          type: "assert",
          assertionId: "total-124000",
        },
      },
      {
        id: "assert-variance-zero",
        description: "vérifier l'écart nul",
        action: {
          type: "assert",
          assertionId: "variance-zero",
        },
      },
      {
        id: "close-session",
        description: "clôturer la session",
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
        id: "assert-closed",
        description: "vérifier l'état clôturé",
        action: {
          type: "assert",
          assertionId: "closed-state",
        },
      },
      {
        id: "assert-close-message",
        description: "vérifier le message de clôture",
        action: {
          type: "assert",
          assertionId: "close-message",
        },
      },
      {
        id: "assert-reopen-visible",
        description: "vérifier la présence du contrôle de réouverture",
        action: {
          type: "assert",
          assertionId: "reopen-visible",
        },
      },
      {
        id: "assert-history-count",
        description: "vérifier l'archive d'une clôture",
        action: {
          type: "assert",
          assertionId: "history-count",
        },
      },
      {
        id: "assert-history-variance",
        description: "vérifier l'écart archivé",
        action: {
          type: "assert",
          assertionId: "history-variance",
        },
      },
      {
        id: "assert-history-reason",
        description: "vérifier le libellé archivé d'un compte juste",
        action: {
          type: "assert",
          assertionId: "history-reason",
        },
      },
    ],
    requirements: [
      {
        sourceFile: "apps/web/app/page.tsx",
        quote:
          '  return <div className="mx-auto max-w-6xl space-y-5" data-cash-state={view.status} data-cash-pharmacy={pharmacyCode}>',
        behavior:
          "Le conteneur de la vue expose le statut d'écran courant dans data-cash-state.",
      },
      {
        sourceFile: "apps/web/app/page.tsx",
        quote:
          '        <div className="mt-6 flex flex-wrap items-center justify-between gap-3"><span role="status" className="text-sm font-semibold text-[#16865b]">{message}</span><Button onClick={close} disabled={!canAttemptClose} aria-label="Clôturer la session" data-cash-action="cloturer" className="h-11 rounded-xl bg-[#08086f] px-5 hover:bg-[#24249a]">Clôturer la session</Button></div>',
        behavior:
          "Le bouton de clôture porte aria-label « Clôturer la session » et déclenche closeCashSession.",
      },
      {
        sourceFile: "apps/web/app/page.tsx",
        quote:
          '        <Card>{closed?<><p className="font-bold">Comptage verrouillé</p><p className="mt-2 text-sm text-[#74758d]">Session de {pharmacyCode} clôturée le {closedAt}. Les quantités et la justification ne sont plus modifiables.</p><Button onClick={reopen} variant="outline" aria-label="Rouvrir la session" data-cash-action="rouvrir" className="mt-4 h-10 rounded-xl">Rouvrir la session</Button></>:<><p className="font-bold">Session en cours</p><p className="mt-2 text-sm text-[#74758d]">Le comptage est conservé quand vous quittez cette vue, et il est distinct pour chaque pharmacie : revenez sur Caisse et Coffre pour le retrouver.</p></>}</Card>',
        behavior:
          "« Rouvrir la session » n'est rendu que lorsque la session est clôturée.",
      },
      {
        sourceFile: "apps/web/lib/cash-session.ts",
        quote:
          "  return { ...session, closedAt, history: [record, ...session.history] };",
        behavior:
          "La clôture horodate la session et archive l'écart en tête de l'historique.",
      },
      {
        sourceFile: "packages/domain/src/cash.ts",
        quote:
          '  return { varianceCents, status: "compte-juste", blocking: false };',
        behavior: "Un écart nul passe sans justification.",
      },
      {
        sourceFile: "apps/web/AGENTS.md",
        quote:
          "| `app/page.tsx` | UI prototype, référentiel/profils synthétiques et route `/api/demo` ; calculs/scopes non production ; vue Caisse et Coffre : comptage par dénomination via `@arpilabe/domain` (centimes entiers), écart compté − attendu, état `data-cash-state`, écart indisponible sur comptage invalide, justification motif + commentaire borné, clôture qui verrouille puis « Rouvrir la session », historique des clôtures, comptage conservé par pharmacie entre les vues ; logique d'écran testée dans `lib/cash-session.test.ts` ; See change: pipeline-developpement-ia, caisse-comptage-ecart. |",
        behavior:
          "La ligne de répertoire décrit la vue Caisse et Coffre (data-cash-state, justification, « Rouvrir la session », historique).",
      },
    ],
    assertions: [
      {
        id: "compte-juste",
        description:
          "2 × 500 € + 2 × 100 € + 2 × 20 € = 1 240 € : état compte-juste",
        target: {
          by: "css",
          value: '[data-cash-state="compte-juste"]',
        },
        afterStep: "count-20",
        verification: "transition",
        kind: "visible",
      },
      {
        id: "status-label",
        description: "le libellé de statut affiché est « Comptage juste »",
        target: {
          by: "css",
          value: '[aria-live="polite"]',
        },
        afterStep: "count-20",
        verification: "state",
        kind: "text",
        expected: "Comptage juste",
      },
      {
        id: "total-124000",
        description: "total compté = 1 240,00 € = 124000 centimes",
        target: {
          by: "css",
          value: '[data-cash-total-cents="124000"]',
        },
        afterStep: "count-20",
        verification: "state",
        kind: "visible",
      },
      {
        id: "variance-zero",
        description: "écart = 124 000 − 124 000 = 0 centime",
        target: {
          by: "css",
          value: '[data-cash-variance-cents="0"]',
        },
        afterStep: "count-20",
        verification: "state",
        kind: "visible",
      },
      {
        id: "closed-state",
        description: "la session passe à l'état cloture",
        target: {
          by: "css",
          value: '[data-cash-state="cloture"]',
        },
        afterStep: "close-session",
        verification: "transition",
        kind: "visible",
      },
      {
        id: "close-message",
        description: "le message de clôture est celui écrit par le code",
        target: {
          by: "css",
          value: 'span[role="status"]',
        },
        afterStep: "close-session",
        verification: "transition",
        kind: "text",
        expected:
          "Session clôturée : le comptage et la justification sont verrouillés.",
      },
      {
        id: "reopen-visible",
        description:
          "le bouton « Rouvrir la session » est présent dans l'état clôturé",
        target: {
          by: "role",
          value: "button",
          name: "Rouvrir la session",
        },
        afterStep: "close-session",
        verification: "state",
        kind: "visible",
      },
      {
        id: "history-count",
        description: "une clôture est archivée",
        target: {
          by: "css",
          value: "[data-cash-history-entry]",
        },
        afterStep: "close-session",
        verification: "state",
        kind: "count",
        expected: 1,
      },
      {
        id: "history-variance",
        description: "l'archive porte l'écart 0",
        target: {
          by: "css",
          value: '[data-cash-history-variance-cents="0"]',
        },
        afterStep: "close-session",
        verification: "state",
        kind: "visible",
      },
      {
        id: "history-reason",
        description:
          "un écart nul s'archive sans motif, sous le libellé « Compte juste »",
        target: {
          by: "css",
          value: "[data-cash-history-entry]",
        },
        afterStep: "close-session",
        verification: "state",
        kind: "text",
        expected: "Compte juste",
      },
    ],
  },
];
