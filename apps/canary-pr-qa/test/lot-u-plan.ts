import type { Plan } from "../src/schema.js";

/**
 * Les six scénarios que le run 210357d8 (déploiement de la PR #60) a bloqués
 * d'un coup, recopiés de l'artefact `result.json` du run : mêmes identifiants,
 * mêmes étapes, mêmes assertions, mêmes cibles. Ce sont les assertions
 * d'origine — `text` attendant le libellé visible sur le conteneur qui porte
 * l'état épinglé — que le rejeu confronte au gate et au message de refus.
 */
export const LOT_U_PLAN: Plan = {
  summary:
    "Functional QA plan for the new Caisse et Coffre view: balanced closure, non-zero variance blocked until justification, invalid quantity refusal, state retention across view changes, per-pharmacy separation, and invalid expected amount handling.",
  scenarios: [
    {
      id: "cash-balanced-close-reopen",
      title: "Balanced cash count closes, locks inputs, and reopens",
      rationale:
        "Exercises the new CashAndSafe view replacing Work in Progress: denomination entry, total units, computed status, closure, data-cash-state lock, and reopen.",
      kind: "happy_path",
      sourceFiles: [
        "apps/web/app/page.tsx",
        "apps/web/AGENTS.md",
        "packages/domain/src/cash.ts",
        "packages/domain/AGENTS.md",
        "packages/domain/src/__tests__/cash.spec.ts",
        "packages/domain/src/index.ts",
      ],
      preconditions: [],
      steps: [
        {
          id: "go",
          description: "Open the preview root",
          action: {
            type: "goto",
            path: "/",
          },
        },
        {
          id: "open-caisse",
          description: "Open Caisse et Coffre",
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
          id: "ensure-open",
          description:
            "Reopen the cash count if a previous session left it closed",
          action: {
            type: "click",
            locator: {
              by: "role",
              value: "button",
              name: "Réouvrir le comptage",
            },
            ifPresent: true,
          },
        },
        {
          id: "assert-open",
          description: "Verify the cash view is open",
          action: {
            type: "assert",
            assertionId: "open",
          },
        },
        {
          id: "fill-500",
          description: "Count 2 notes of 500 €",
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
          description: "Count 2 notes of 100 €",
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
          description: "Count 2 notes of 20 €",
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
          id: "assert-units",
          description: "Verify six units are counted",
          action: {
            type: "assert",
            assertionId: "units",
          },
        },
        {
          id: "assert-status",
          description: "Verify the count is balanced",
          action: {
            type: "assert",
            assertionId: "status",
          },
        },
        {
          id: "click-close",
          description: "Close the balanced session",
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
          id: "assert-close-message",
          description: "Verify the closure confirmation message",
          action: {
            type: "assert",
            assertionId: "close-message",
          },
        },
        {
          id: "assert-closed-visible",
          description: "Verify the closed state marker",
          action: {
            type: "assert",
            assertionId: "closed-visible",
          },
        },
        {
          id: "assert-closed-text",
          description: "Verify the locked-count message",
          action: {
            type: "assert",
            assertionId: "closed-text",
          },
        },
        {
          id: "click-reopen",
          description: "Reopen the closed count",
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
          id: "assert-reopen-message",
          description: "Verify the reopen confirmation message",
          action: {
            type: "assert",
            assertionId: "reopen-message",
          },
        },
        {
          id: "assert-reopened-visible",
          description: "Verify the view is open again",
          action: {
            type: "assert",
            assertionId: "reopened-visible",
          },
        },
      ],
      requirements: [
        {
          sourceFile: "apps/web/app/page.tsx",
          quote:
            'const emptyCashSession: CashSession = { expected: "1 240,00", quantities: {}, justification: "", closedAt: null };',
          behavior:
            "The cash session defaults to an expected amount of 1 240,00 and starts open.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote:
            'return <div className="mx-auto max-w-6xl space-y-5" data-cash-state={closed?"cloture":"ouvert"}>',
          behavior:
            "The view exposes data-cash-state ouvert while open and cloture after closing.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote:
            'const status=closed?"Session clôturée":!counted.ok?"Quantité à corriger":variance===null?"Comptage en cours":balanced?"Comptage juste":closure?.status==="ecart-justifie"?"Écart justifié":"Écart à justifier";',
          behavior:
            "The status badge displays Comptage juste for a balanced count, Session clôturée after closure, and Écart à justifier for a non-zero unjustified variance.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote: "Réouvrir le comptage",
          behavior: "A closed session offers a reopen control.",
        },
        {
          sourceFile: "apps/web/AGENTS.md",
          quote:
            "vue Caisse et Coffre : comptage par dénomination via `@arpilabe/domain` (centimes entiers), écart compté − attendu, justification obligatoire si l'écart n'est pas nul, clôture qui verrouille puis réouverture, comptage conservé par pharmacie entre les vues",
          behavior:
            "The documented Caisse view behavior is exactly the interactive counting, variance, justification, lock, reopen, and per-pharmacy retention implemented here.",
        },
        {
          sourceFile: "packages/domain/src/cash.ts",
          quote: '{ cents: 50_000, label: "Billet de 500 €", kind: "billet" },',
          behavior: "The 500 € note is a counted euro denomination.",
        },
        {
          sourceFile: "packages/domain/src/cash.ts",
          quote:
            'return { varianceCents, status: "compte-juste", blocking: false };',
          behavior:
            "A zero variance yields compte-juste and does not block closure.",
        },
        {
          sourceFile: "packages/domain/AGENTS.md",
          quote:
            "Comptage des espèces en centimes entiers : quantités par dénomination, sous-total, total, unités, écart signé, décision de clôture, conversions euros ⇄ centimes",
          behavior:
            "The domain module provides denomination counting, totals, units, signed variance, and closure decision.",
        },
        {
          sourceFile: "packages/domain/src/__tests__/cash.spec.ts",
          quote: 'expect(closure.status).toBe("compte-juste");',
          behavior:
            "The domain test fixes compte-juste as the status for a balanced closure.",
        },
        {
          sourceFile: "packages/domain/src/index.ts",
          quote: 'export * from "./cash";',
          behavior: "Cash domain helpers are exported for the web app import.",
        },
      ],
      assertions: [
        {
          id: "open",
          description: "The Caisse view starts open",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "ensure-open",
          verification: "state",
          kind: "visible",
        },
        {
          id: "units",
          description: "2 × 500 € + 2 × 100 € + 2 × 20 € gives 6 counted units",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "fill-20",
          verification: "transition",
          kind: "text",
          expected: "6 unités comptées",
        },
        {
          id: "status",
          description:
            "2 × 500 € + 2 × 100 € + 2 × 20 € = 1 240,00 €, equal to the default expected amount, so the status is Comptage juste",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "fill-20",
          verification: "transition",
          kind: "text",
          expected: "Comptage juste",
        },
        {
          id: "close-message",
          description:
            "Closing a balanced count produces the lock confirmation",
          target: {
            by: "css",
            value: '[role="status"]',
          },
          afterStep: "click-close",
          verification: "transition",
          kind: "text",
          expected: "Session clôturée : le comptage est verrouillé.",
        },
        {
          id: "closed-visible",
          description: "The view exposes the closed state after closure",
          target: {
            by: "css",
            value: '[data-cash-state="cloture"]',
          },
          afterStep: "click-close",
          verification: "state",
          kind: "visible",
        },
        {
          id: "closed-text",
          description: "The closed view says the count is locked",
          target: {
            by: "css",
            value: '[data-cash-state="cloture"]',
          },
          afterStep: "click-close",
          verification: "state",
          kind: "text",
          expected: "Comptage verrouillé",
        },
        {
          id: "reopen-message",
          description: "Reopening replaces the closure message",
          target: {
            by: "css",
            value: '[role="status"]',
          },
          afterStep: "click-reopen",
          verification: "transition",
          kind: "text",
          expected: "Comptage réouvert : corrigez puis clôturez à nouveau.",
        },
        {
          id: "reopened-visible",
          description: "The view is open after reopening",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "click-reopen",
          verification: "state",
          kind: "visible",
        },
      ],
    },
    {
      id: "cash-variance-justification",
      title: "Non-zero variance blocks closure until a written justification",
      rationale:
        "Counts 3 × 500 € against the 1 240,00 € expected amount, checks the computed +260,00 € variance refusal, then accepts closure after a justification.",
      kind: "edge_case",
      sourceFiles: ["apps/web/app/page.tsx", "packages/domain/src/cash.ts"],
      preconditions: [],
      steps: [
        {
          id: "go",
          description: "Open the preview root",
          action: {
            type: "goto",
            path: "/",
          },
        },
        {
          id: "open-caisse",
          description: "Open Caisse et Coffre",
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
          id: "ensure-open",
          description: "Reopen the cash count if needed",
          action: {
            type: "click",
            locator: {
              by: "role",
              value: "button",
              name: "Réouvrir le comptage",
            },
            ifPresent: true,
          },
        },
        {
          id: "assert-open",
          description: "Verify the cash view is open",
          action: {
            type: "assert",
            assertionId: "open",
          },
        },
        {
          id: "fill-500-3",
          description: "Count 3 notes of 500 €",
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
          id: "assert-units-3",
          description: "Verify three units are counted",
          action: {
            type: "assert",
            assertionId: "units-3",
          },
        },
        {
          id: "assert-status-variance",
          description: "Verify the variance status",
          action: {
            type: "assert",
            assertionId: "status-variance",
          },
        },
        {
          id: "click-close-blocked",
          description: "Try to close without justification",
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
          id: "assert-blocked-message",
          description:
            "Verify the refusal names the correct +260,00 € variance",
          action: {
            type: "assert",
            assertionId: "blocked-message",
          },
        },
        {
          id: "assert-still-open",
          description: "Verify the session remains open after refusal",
          action: {
            type: "assert",
            assertionId: "still-open",
          },
        },
        {
          id: "fill-justification",
          description: "Write the required justification",
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
          id: "assert-justification-value",
          description: "Verify the justification is recorded in the field",
          action: {
            type: "assert",
            assertionId: "justification-value",
          },
        },
        {
          id: "click-close-justified",
          description: "Close after writing the justification",
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
          id: "assert-closed-message",
          description: "Verify closure succeeds after justification",
          action: {
            type: "assert",
            assertionId: "closed-message",
          },
        },
        {
          id: "assert-closed-visible",
          description: "Verify the closed state marker",
          action: {
            type: "assert",
            assertionId: "closed-visible",
          },
        },
      ],
      requirements: [
        {
          sourceFile: "apps/web/app/page.tsx",
          quote:
            // biome-ignore lint/suspicious/noTemplateCurlyInString: citation recopiée du fichier, pas un gabarit à interpoler.
            "if(closure?.blocking){setMessage(`Écart de ${formatAmountFr(centsToEuros(closure.varianceCents))} : une justification écrite est obligatoire avant clôture.`);return}",
          behavior:
            "A blocking variance produces the exact refusal message including the formatted signed variance.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote: 'aria-label="Justification de l’écart"',
          behavior:
            "The variance justification textarea is labelled Justification de l’écart.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote: "Clôturer la session",
          behavior: "The session can be submitted for closure.",
        },
        {
          sourceFile: "packages/domain/src/cash.ts",
          quote: "return countedCents - expectedCents;",
          behavior:
            "Variance is signed counted minus expected, so 1 500,00 − 1 240,00 is +260,00.",
        },
        {
          sourceFile: "packages/domain/src/cash.ts",
          quote:
            'return { varianceCents, status: "ecart-a-justifier", blocking: true };',
          behavior:
            "A non-zero variance without a written justification is blocking.",
        },
      ],
      assertions: [
        {
          id: "open",
          description: "The Caisse view starts open",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "ensure-open",
          verification: "state",
          kind: "visible",
        },
        {
          id: "units-3",
          description: "3 × 500 € gives 3 counted units",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "fill-500-3",
          verification: "transition",
          kind: "text",
          expected: "3 unités comptées",
        },
        {
          id: "status-variance",
          description:
            "3 × 500 € = 1 500,00 € against 1 240,00 € expected is an unjustified variance",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "fill-500-3",
          verification: "state",
          kind: "text",
          expected: "Écart à justifier",
        },
        {
          id: "blocked-message",
          description:
            "Counted 3 × 500 = 1 500,00 €; expected 1 240,00 €; variance = 1 500,00 − 1 240,00 = +260,00 €, so the refusal must state 260,00 €",
          target: {
            by: "css",
            value: '[role="status"]',
          },
          afterStep: "click-close-blocked",
          verification: "transition",
          kind: "text",
          expected:
            "Écart de 260,00 € : une justification écrite est obligatoire avant clôture.",
        },
        {
          id: "still-open",
          description: "The session remains open after the refused closure",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "click-close-blocked",
          verification: "state",
          kind: "visible",
        },
        {
          id: "justification-value",
          description: "The justification text is present in the textarea",
          target: {
            by: "role",
            value: "textbox",
            name: "Justification de l’écart",
          },
          afterStep: "fill-justification",
          verification: "state",
          kind: "value",
          expected: "Erreur de rendu de monnaie",
        },
        {
          id: "closed-message",
          description: "Closure succeeds after the justification is written",
          target: {
            by: "css",
            value: '[role="status"]',
          },
          afterStep: "click-close-justified",
          verification: "transition",
          kind: "text",
          expected: "Session clôturée : le comptage est verrouillé.",
        },
        {
          id: "closed-visible",
          description:
            "The closed state marker appears after successful closure",
          target: {
            by: "css",
            value: '[data-cash-state="cloture"]',
          },
          afterStep: "click-close-justified",
          verification: "state",
          kind: "visible",
        },
      ],
    },
    {
      id: "cash-invalid-quantity",
      title: "Decimal quantity is refused and signals the line",
      rationale:
        "Fills 3,5 on the 500 € line and verifies the domain refusal is surfaced: corrected status, error text, invalid marker, and no silent rounding.",
      kind: "edge_case",
      sourceFiles: ["apps/web/app/page.tsx", "packages/domain/src/cash.ts"],
      preconditions: [],
      steps: [
        {
          id: "go",
          description: "Open the preview root",
          action: {
            type: "goto",
            path: "/",
          },
        },
        {
          id: "open-caisse",
          description: "Open Caisse et Coffre",
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
          id: "ensure-open",
          description: "Reopen the cash count if needed",
          action: {
            type: "click",
            locator: {
              by: "role",
              value: "button",
              name: "Réouvrir le comptage",
            },
            ifPresent: true,
          },
        },
        {
          id: "assert-open",
          description: "Verify the cash view is open",
          action: {
            type: "assert",
            assertionId: "open",
          },
        },
        {
          id: "fill-invalid-quantity",
          description: "Enter the decimal quantity 3,5 on the 500 € line",
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
          id: "assert-invalid-status",
          description: "Verify the invalid status appears",
          action: {
            type: "assert",
            assertionId: "invalid-status",
          },
        },
        {
          id: "assert-invalid-message",
          description: "Verify the invalid quantity message appears",
          action: {
            type: "assert",
            assertionId: "invalid-message",
          },
        },
        {
          id: "assert-invalid-marker",
          description: "Verify the line is marked invalid",
          action: {
            type: "assert",
            assertionId: "invalid-marker",
          },
        },
        {
          id: "assert-input-value",
          description: "Verify the raw decimal text is not silently rounded",
          action: {
            type: "assert",
            assertionId: "input-value",
          },
        },
      ],
      requirements: [
        {
          sourceFile: "apps/web/app/page.tsx",
          quote:
            '{!counted.ok&&<p className="mt-4 text-sm font-semibold text-[#b42318]">Quantité illisible sur une ligne : saisissez un nombre entier de coupures ou de pièces.</p>}',
          behavior:
            "The view displays an explicit invalid-quantity message when any denomination quantity is not an integer.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote: '!counted.ok?"Quantité à corriger"',
          behavior:
            "The status becomes Quantité à corriger for an invalid quantity.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: citation recopiée du fichier, pas un gabarit à interpoler.
          quote: "aria-label={`Quantité · ${d.label}`}",
          behavior:
            "Each quantity input is labelled Quantité · <denomination label>.",
        },
        {
          sourceFile: "packages/domain/src/cash.ts",
          quote: "if (!/^\\d{1,9}$/.test(text)) return null;",
          behavior:
            "A quantity must be digits only; 3,5 is refused instead of rounded.",
        },
      ],
      assertions: [
        {
          id: "open",
          description: "The Caisse view starts open",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "ensure-open",
          verification: "state",
          kind: "visible",
        },
        {
          id: "invalid-status",
          description: "3,5 on a denomination line makes the count invalid",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "fill-invalid-quantity",
          verification: "transition",
          kind: "text",
          expected: "Quantité à corriger",
        },
        {
          id: "invalid-message",
          description: "The invalid quantity message is displayed",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "fill-invalid-quantity",
          verification: "state",
          kind: "text",
          expected:
            "Quantité illisible sur une ligne : saisissez un nombre entier de coupures ou de pièces.",
        },
        {
          id: "invalid-marker",
          description: "The 500 € line is marked aria-invalid",
          target: {
            by: "css",
            value: '[aria-invalid="true"]',
          },
          afterStep: "fill-invalid-quantity",
          verification: "state",
          kind: "visible",
        },
        {
          id: "input-value",
          description:
            "The field still shows the raw 3,5 rather than an rounded integer",
          target: {
            by: "role",
            value: "textbox",
            name: "Quantité · Billet de 500 €",
          },
          afterStep: "fill-invalid-quantity",
          verification: "state",
          kind: "value",
          expected: "3,5",
        },
      ],
    },
    {
      id: "cash-view-state-retention",
      title: "Cash count survives a Pilotage round-trip",
      rationale:
        "Verifies the counting state lives in Home, so switching away from Caisse et Coffre and back preserves the entered quantities and computed status.",
      kind: "regression",
      sourceFiles: ["apps/web/app/page.tsx"],
      preconditions: [],
      steps: [
        {
          id: "go",
          description: "Open the preview root",
          action: {
            type: "goto",
            path: "/",
          },
        },
        {
          id: "open-caisse",
          description: "Open Caisse et Coffre",
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
          id: "ensure-open",
          description: "Reopen the cash count if needed",
          action: {
            type: "click",
            locator: {
              by: "role",
              value: "button",
              name: "Réouvrir le comptage",
            },
            ifPresent: true,
          },
        },
        {
          id: "assert-open",
          description: "Verify the cash view is open",
          action: {
            type: "assert",
            assertionId: "open",
          },
        },
        {
          id: "fill-500",
          description: "Count 2 notes of 500 €",
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
          description: "Count 2 notes of 100 €",
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
          description: "Count 2 notes of 20 €",
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
          id: "assert-units",
          description: "Verify six units are counted before leaving",
          action: {
            type: "assert",
            assertionId: "units",
          },
        },
        {
          id: "click-pilotage",
          description: "Go back to Pilotage",
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
          id: "click-caisse-return",
          description: "Return to Caisse et Coffre",
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
          id: "assert-input-persisted",
          description: "Verify the 500 € quantity is still 2 after returning",
          action: {
            type: "assert",
            assertionId: "input-persisted",
          },
        },
        {
          id: "assert-status-persisted",
          description: "Verify the balanced status is still shown",
          action: {
            type: "assert",
            assertionId: "status-persisted",
          },
        },
        {
          id: "assert-units-persisted",
          description: "Verify the unit count is still shown",
          action: {
            type: "assert",
            assertionId: "units-persisted",
          },
        },
      ],
      requirements: [
        {
          sourceFile: "apps/web/app/page.tsx",
          quote:
            "const [cashByPharmacy,setCashByPharmacy]=useState<Record<string,CashSession>>({});",
          behavior:
            "Cash sessions are held as Home-level React state, not inside the Caisse view component.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote:
            '{view==="caisse"&&<CashAndSafe session={cashSession} onChange={updateCash} pharmacyCode={pharmacyCode}/>}',
          behavior:
            "The Caisse view receives the stored session from Home, so a view change and return keeps it.",
        },
      ],
      assertions: [
        {
          id: "open",
          description: "The Caisse view starts open",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "ensure-open",
          verification: "state",
          kind: "visible",
        },
        {
          id: "units",
          description: "2 × 500 € + 2 × 100 € + 2 × 20 € gives 6 counted units",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "fill-20",
          verification: "transition",
          kind: "text",
          expected: "6 unités comptées",
        },
        {
          id: "input-persisted",
          description: "The 500 € quantity remains 2 after a view round-trip",
          target: {
            by: "role",
            value: "textbox",
            name: "Quantité · Billet de 500 €",
          },
          afterStep: "click-caisse-return",
          verification: "state",
          kind: "value",
          expected: "2",
        },
        {
          id: "status-persisted",
          description: "The balanced status remains after a view round-trip",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "click-caisse-return",
          verification: "state",
          kind: "text",
          expected: "Comptage juste",
        },
        {
          id: "units-persisted",
          description: "The counted units remain after a view round-trip",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "click-caisse-return",
          verification: "state",
          kind: "text",
          expected: "6 unités comptées",
        },
      ],
    },
    {
      id: "cash-per-pharmacy-separation",
      title: "Cash counts are distinct per pharmacy",
      rationale:
        "Verifies updateCash keys the session by active pharmacy: DEMO17 keeps its balanced count while DEMO18 opens a separate empty count.",
      kind: "edge_case",
      sourceFiles: ["apps/web/app/page.tsx"],
      preconditions: [],
      steps: [
        {
          id: "go",
          description: "Open the preview root",
          action: {
            type: "goto",
            path: "/",
          },
        },
        {
          id: "open-caisse",
          description: "Open Caisse et Coffre",
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
          id: "ensure-open",
          description: "Reopen the cash count if needed",
          action: {
            type: "click",
            locator: {
              by: "role",
              value: "button",
              name: "Réouvrir le comptage",
            },
            ifPresent: true,
          },
        },
        {
          id: "assert-open",
          description: "Verify the cash view is open",
          action: {
            type: "assert",
            assertionId: "open",
          },
        },
        {
          id: "fill-500",
          description: "Count 2 notes of 500 € for DEMO17",
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
          description: "Count 2 notes of 100 € for DEMO17",
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
          description: "Count 2 notes of 20 € for DEMO17",
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
          id: "assert-units",
          description: "Verify six units are counted for DEMO17",
          action: {
            type: "assert",
            assertionId: "units",
          },
        },
        {
          id: "select-demo18",
          description: "Switch to DEMO18",
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
          id: "assert-demo18-label",
          description: "Verify the view labels DEMO18",
          action: {
            type: "assert",
            assertionId: "demo18-label",
          },
        },
        {
          id: "assert-demo18-status",
          description: "Verify DEMO18 has its own empty, unbalanced count",
          action: {
            type: "assert",
            assertionId: "demo18-status",
          },
        },
        {
          id: "select-demo17",
          description: "Switch back to DEMO17",
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
          id: "assert-demo17-label",
          description: "Verify the view labels DEMO17 again",
          action: {
            type: "assert",
            assertionId: "demo17-label",
          },
        },
        {
          id: "assert-demo17-status",
          description: "Verify DEMO17 still shows its balanced status",
          action: {
            type: "assert",
            assertionId: "demo17-status",
          },
        },
        {
          id: "assert-demo17-input",
          description: "Verify DEMO17 still has its 500 € quantity",
          action: {
            type: "assert",
            assertionId: "demo17-input",
          },
        },
      ],
      requirements: [
        {
          sourceFile: "apps/web/app/page.tsx",
          quote:
            "const updateCash=(patch:Partial<CashSession>)=>setCashByPharmacy(sessions=>({...sessions,[pharmacyCode]:{...(sessions[pharmacyCode]??emptyCashSession),...patch}}));",
          behavior:
            "Every cash change is stored under the active pharmacy code, keeping pharmacies separate.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote:
            "const cashSession=cashByPharmacy[pharmacyCode]??emptyCashSession;",
          behavior:
            "The displayed session is the one stored for the active pharmacy, defaulting to the empty session.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote: "Caisse et Coffre · {pharmacyCode}",
          behavior: "The view labels which pharmacy's cash count is displayed.",
        },
      ],
      assertions: [
        {
          id: "open",
          description: "The Caisse view starts open",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "ensure-open",
          verification: "state",
          kind: "visible",
        },
        {
          id: "units",
          description: "2 × 500 € + 2 × 100 € + 2 × 20 € gives 6 counted units",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "fill-20",
          verification: "transition",
          kind: "text",
          expected: "6 unités comptées",
        },
        {
          id: "demo18-label",
          description: "The active pharmacy label changes to DEMO18",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "select-demo18",
          verification: "transition",
          kind: "text",
          expected: "Caisse et Coffre · DEMO18",
        },
        {
          id: "demo18-status",
          description:
            "DEMO18 has no counted notes, so 0,00 € against 1 240,00 € is an unjustified variance",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "select-demo18",
          verification: "transition",
          kind: "text",
          expected: "Écart à justifier",
        },
        {
          id: "demo17-label",
          description: "The active pharmacy label changes back to DEMO17",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "select-demo17",
          verification: "transition",
          kind: "text",
          expected: "Caisse et Coffre · DEMO17",
        },
        {
          id: "demo17-status",
          description:
            "DEMO17 still shows its balanced status after switching back",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "select-demo17",
          verification: "state",
          kind: "text",
          expected: "Comptage juste",
        },
        {
          id: "demo17-input",
          description: "DEMO17 still has 2 notes of 500 € after switching back",
          target: {
            by: "role",
            value: "textbox",
            name: "Quantité · Billet de 500 €",
          },
          afterStep: "select-demo17",
          verification: "state",
          kind: "value",
          expected: "2",
        },
      ],
    },
    {
      id: "cash-invalid-expected-amount",
      title: "Unreadable expected amount is refused and blocks closure",
      rationale:
        "Fills an invalid French amount in the expected field and verifies the view signals it and refuses closure with the expected-amount error.",
      kind: "edge_case",
      sourceFiles: ["apps/web/app/page.tsx"],
      preconditions: [],
      steps: [
        {
          id: "go",
          description: "Open the preview root",
          action: {
            type: "goto",
            path: "/",
          },
        },
        {
          id: "open-caisse",
          description: "Open Caisse et Coffre",
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
          id: "ensure-open",
          description: "Reopen the cash count if needed",
          action: {
            type: "click",
            locator: {
              by: "role",
              value: "button",
              name: "Réouvrir le comptage",
            },
            ifPresent: true,
          },
        },
        {
          id: "assert-open",
          description: "Verify the cash view is open",
          action: {
            type: "assert",
            assertionId: "open",
          },
        },
        {
          id: "fill-expected-invalid",
          description: "Enter an unreadable expected amount",
          action: {
            type: "fill",
            locator: {
              by: "role",
              value: "textbox",
              name: "Montant d’espèces attendu",
            },
            value: "abc",
          },
        },
        {
          id: "assert-expected-error",
          description: "Verify the expected-amount error hint appears",
          action: {
            type: "assert",
            assertionId: "expected-error",
          },
        },
        {
          id: "assert-comptage-en-cours",
          description: "Verify the view status becomes Comptage en cours",
          action: {
            type: "assert",
            assertionId: "comptage-en-cours",
          },
        },
        {
          id: "click-close",
          description: "Try to close with the invalid expected amount",
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
          id: "assert-close-message",
          description:
            "Verify closure is refused because the expected amount is unreadable",
          action: {
            type: "assert",
            assertionId: "close-message",
          },
        },
        {
          id: "assert-open-still",
          description: "Verify the session remains open",
          action: {
            type: "assert",
            assertionId: "open-still",
          },
        },
      ],
      requirements: [
        {
          sourceFile: "apps/web/app/page.tsx",
          quote: "Montant illisible : écrivez « 1 240,00 ».",
          behavior:
            "An unreadable expected amount displays an explicit correction hint.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote: 'aria-label="Montant d’espèces attendu"',
          behavior:
            "The expected cash amount input is labelled Montant d’espèces attendu.",
        },
        {
          sourceFile: "apps/web/app/page.tsx",
          quote:
            'if(expectedCents===null){setMessage("Montant d’espèces attendu manquant ou illisible.");return}',
          behavior:
            "Closure is refused when the expected amount is missing or unreadable.",
        },
      ],
      assertions: [
        {
          id: "open",
          description: "The Caisse view starts open",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "ensure-open",
          verification: "state",
          kind: "visible",
        },
        {
          id: "expected-error",
          description: "The invalid expected amount shows the correction hint",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "fill-expected-invalid",
          verification: "transition",
          kind: "text",
          expected: "Montant illisible : écrivez « 1 240,00 ».",
        },
        {
          id: "comptage-en-cours",
          description:
            "With no readable expected amount the status is Comptage en cours",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "fill-expected-invalid",
          verification: "transition",
          kind: "text",
          expected: "Comptage en cours",
        },
        {
          id: "close-message",
          description: "Closing with an unreadable expected amount is refused",
          target: {
            by: "css",
            value: '[role="status"]',
          },
          afterStep: "click-close",
          verification: "transition",
          kind: "text",
          expected: "Montant d’espèces attendu manquant ou illisible.",
        },
        {
          id: "open-still",
          description: "The session remains open after refusal",
          target: {
            by: "css",
            value: '[data-cash-state="ouvert"]',
          },
          afterStep: "click-close",
          verification: "state",
          kind: "visible",
        },
      ],
    },
  ],
  skipped: [
    {
      sourceFile: "openspec/AGENTS.md",
      reason:
        "Documentation index change only; no browser-observable product behavior.",
    },
    {
      sourceFile: "openspec/changes/caisse-comptage-ecart/AGENTS.md",
      reason: "OpenSpec documentation for the change; no runtime UI behavior.",
    },
    {
      sourceFile: "openspec/changes/caisse-comptage-ecart/proposal.md",
      reason:
        "Proposal document; execution evidence is covered by the Caisse scenarios.",
    },
    {
      sourceFile: "openspec/changes/caisse-comptage-ecart/tasks.md",
      reason:
        "Task checklist document; no browser-observable behavior to exercise.",
    },
  ],
};
