import { afterEach, describe, expect, it, vi } from "vitest";
import { Canary } from "../src/canary.js";
import { QaError } from "../src/diagnostics.js";
import { executeScenario } from "../src/executor.js";
import type { Model } from "../src/model.js";
import {
  ariaRoleNameNodes,
  observedTargetsNote,
  validatePlanEvidence,
} from "../src/plan-evidence.js";
import { runQa } from "../src/runner.js";
import {
  type Plan,
  PlanSchema,
  type SourceLineMaterial,
} from "../src/schema.js";
import { fixture, PR_URL } from "./fixture.js";
import { LOT_AL_SCENARIOS } from "./lot-al-plan.js";

/**
 * Les deux scénarios RÉELS du run b7da97f1 (22 oct. 2026, PR 17 de
 * `pharmania/arpilabe-pilotage`, SHA testé 814b671305b005ab516db66bc3da1d8239bcef16),
 * copiés de l'artefact du run sans retouche. Les deux visent
 * `role=textbox name="Quantité · Pièce de 20 €"` à l'étape `fill-20` : la
 * preview n'expose à cette ligne qu'un « Billet de 20 € », et ce scénario est le
 * seul du corpus de 200 runs à inventer une cible.
 *
 * Le plan est conservé tel quel, exigences comprises : un rejeu qui
 * l'allègerait ne prouverait plus ce que le run a réellement produit.
 */
const SCENARIOS: Plan["scenarios"] = [
  {
    id: "balanced-cash-closes-and-reopens",
    title:
      "Un comptage juste clôture la session, verrouille les saisies et se réouvre",
    rationale:
      "La vue Caisse et Coffre remplace le Work in Progress : countCash additionne 2×500 + 2×100 + 2×20 = 1 240,00 €, assessCashClosure rend compte-juste, la clôture écrit closedAt et verrouille les champs, puis reopen remet closedAt à null.",
    kind: "happy_path",
    sourceFiles: ["apps/web/app/page.tsx", "apps/web/AGENTS.md"],
    preconditions: [],
    steps: [
      {
        id: "goto",
        description: "Ouvrir l'application",
        action: {
          type: "goto",
          path: "/",
        },
      },
      {
        id: "open-cash",
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
        id: "fill-500",
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
        id: "fill-100",
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
        id: "fill-20",
        description: "Compter 2 pièces de 20 €",
        action: {
          type: "fill",
          locator: {
            by: "role",
            value: "textbox",
            name: "Quantité · Pièce de 20 €",
          },
          value: "2",
        },
      },
      {
        id: "assert-total",
        description: "Vérifier le total compté",
        action: {
          type: "assert",
          assertionId: "s1-total-1240",
        },
      },
      {
        id: "assert-status",
        description: "Vérifier le statut de comptage juste",
        action: {
          type: "assert",
          assertionId: "s1-status-juste",
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
        id: "assert-closed-msg",
        description: "Vérifier le message de clôture",
        action: {
          type: "assert",
          assertionId: "s1-closed-message",
        },
      },
      {
        id: "assert-closed-state",
        description: "Vérifier l'état clôturé",
        action: {
          type: "assert",
          assertionId: "s1-state-cloture",
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
        id: "assert-reopen-msg",
        description: "Vérifier le message de réouverture",
        action: {
          type: "assert",
          assertionId: "s1-reopen-message",
        },
      },
      {
        id: "assert-open-state",
        description: "Vérifier l'état réouvert",
        action: {
          type: "assert",
          assertionId: "s1-state-ouvert",
        },
      },
      {
        id: "assert-qty-preserved",
        description: "Vérifier que la quantité est conservée après réouverture",
        action: {
          type: "assert",
          assertionId: "s1-qty-500-two",
        },
      },
    ],
    requirements: [
      {
        sourceFile: "apps/web/app/page.tsx",
        quote: "  const counted=countCash(session.quantities);",
        behavior:
          "Le comptage de la session est recalculé par countCash à partir des quantités saisies.",
      },
      {
        sourceFile: "apps/web/app/page.tsx",
        quote:
          '        <div className="mt-6 flex flex-wrap items-center justify-between gap-3"><span role="status" className="text-sm font-semibold text-[#16865b]">{message}</span><Button onClick={close} disabled={closed||!counted.ok} className="h-11 rounded-xl bg-[#08086f] px-5 hover:bg-[#24249a]">Clôturer la session</Button></div>',
        behavior:
          "Le bouton « Clôturer la session » appelle close et le message de résultat est rendu dans role=status.",
      },
      {
        sourceFile: "apps/web/app/page.tsx",
        quote:
          '        <div className="relative overflow-hidden rounded-2xl bg-[#08086f] p-5 text-white"><div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-[#912cff]/45"/><p className="relative text-sm text-white/60">Total compté</p><p className="relative mt-2 text-2xl font-bold">{counted.ok?formatAmountFr(centsToEuros(counted.totalCents)):"—"}</p><div className="relative my-4 border-t border-white/10"/><p className="relative text-sm text-white/60">Écart, compté − attendu</p><p className="relative mt-2 text-2xl font-bold">{variance===null?"—":formatAmountFr(centsToEuros(variance))}</p></div>',
        behavior:
          "Le total compté et l'écart sont affichés dans le panneau latéral.",
      },
      {
        sourceFile: "apps/web/app/page.tsx",
        quote:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: citation recopiée du run, garde son `${` non évalué.
          '  const close=()=>{if(!counted.ok){setMessage("Quantité illisible : corrigez la ligne signalée avant de clôturer.");return}if(expectedCents===null){setMessage("Montant d’espèces attendu manquant ou illisible.");return}if(closure?.blocking){setMessage(`Écart de ${formatAmountFr(centsToEuros(closure.varianceCents))} : une justification écrite est obligatoire avant clôture.`);return}onChange({closedAt:new Date().toISOString()});setMessage("Session clôturée : le comptage est verrouillé.")};',
        behavior:
          "Une clôture sans blocage écrit closedAt et affiche « Session clôturée : le comptage est verrouillé. ».",
      },
      {
        sourceFile: "apps/web/AGENTS.md",
        quote:
          "| `app/page.tsx` | UI prototype, référentiel/profils synthétiques et route `/api/demo` ; calculs/scopes non production ; vue Caisse et Coffre : comptage par dénomination via `@arpilabe/domain` (centimes entiers), écart compté − attendu, justification obligatoire si l'écart n'est pas nul, clôture qui verrouille puis réouverture, comptage conservé par pharmacie entre les vues ; See change: pipeline-developpement-ia, caisse-comptage-ecart. |",
        behavior:
          "La documentation du répertoire web décrit la vue Caisse et Coffre, le comptage par dénomination, l'écart, la justification obligatoire et le verrouillage.",
      },
    ],
    assertions: [
      {
        id: "s1-total-1240",
        description:
          "Total compté : 2 × 500,00 € + 2 × 100,00 € + 2 × 20,00 € = 1 240,00 €",
        target: {
          by: "css",
          value: "[data-cash-state]",
        },
        afterStep: "fill-20",
        verification: "transition",
        kind: "text",
        expected: "1 240,00 €",
      },
      {
        id: "s1-status-juste",
        description:
          "Le statut affiché est « Comptage juste » car l'écart compté − attendu vaut 0",
        target: {
          by: "css",
          value: "[data-cash-state]",
        },
        afterStep: "fill-20",
        verification: "state",
        kind: "text",
        expected: "Comptage juste",
      },
      {
        id: "s1-closed-message",
        description: "Le message de clôture est rendu dans role=status",
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
        id: "s1-state-cloture",
        description: "Le conteneur porte l'état data-cash-state=cloture",
        target: {
          by: "css",
          value: '[data-cash-state="cloture"]',
        },
        afterStep: "close",
        verification: "state",
        kind: "visible",
      },
      {
        id: "s1-reopen-message",
        description: "Le message de réouverture est rendu dans role=status",
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
        id: "s1-state-ouvert",
        description: "Le conteneur porte l'état data-cash-state=ouvert",
        target: {
          by: "css",
          value: '[data-cash-state="ouvert"]',
        },
        afterStep: "reopen",
        verification: "state",
        kind: "visible",
      },
      {
        id: "s1-qty-500-two",
        description:
          "La quantité de billets de 500 € reste 2 après réouverture",
        target: {
          by: "role",
          value: "textbox",
          name: "Quantité · Billet de 500 €",
        },
        afterStep: "reopen",
        verification: "state",
        kind: "value",
        expected: "2",
      },
    ],
  },
  {
    id: "cash-count-survives-view-switch",
    title: "Le comptage survit à un aller-retour Pilotage ↔ Caisse",
    rationale:
      "cashByPharmacy est hissé dans Home : quitter la vue Caisse et y revenir retrouve les quantités et le total compté.",
    kind: "regression",
    sourceFiles: ["apps/web/app/page.tsx"],
    preconditions: [],
    steps: [
      {
        id: "goto",
        description: "Ouvrir l'application",
        action: {
          type: "goto",
          path: "/",
        },
      },
      {
        id: "open-cash",
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
        id: "fill-500",
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
        id: "fill-100",
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
        id: "fill-20",
        description: "Compter 2 pièces de 20 €",
        action: {
          type: "fill",
          locator: {
            by: "role",
            value: "textbox",
            name: "Quantité · Pièce de 20 €",
          },
          value: "2",
        },
      },
      {
        id: "assert-total",
        description: "Vérifier le total compté",
        action: {
          type: "assert",
          assertionId: "s5-total-1240",
        },
      },
      {
        id: "go-pilotage",
        description: "Revenir à Pilotage",
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
        id: "back-cash",
        description: "Revenir à Caisse et Coffre",
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
        id: "assert-qty",
        description: "Vérifier la quantité conservée",
        action: {
          type: "assert",
          assertionId: "s5-qty-500-two",
        },
      },
      {
        id: "assert-total-back",
        description: "Vérifier le total conservé",
        action: {
          type: "assert",
          assertionId: "s5-total-1240-back",
        },
      },
    ],
    requirements: [
      {
        sourceFile: "apps/web/app/page.tsx",
        quote:
          "  const [cashByPharmacy,setCashByPharmacy]=useState<Record<string,CashSession>>({});",
        behavior:
          "L'état de caisse est conservé dans Home, pas dans la vue Caisse et Coffre.",
      },
      {
        sourceFile: "apps/web/app/page.tsx",
        quote:
          "  const updateCash=(patch:Partial<CashSession>)=>setCashByPharmacy(sessions=>({...sessions,[pharmacyCode]:{...(sessions[pharmacyCode]??emptyCashSession),...patch}}));",
        behavior:
          "Les mises à jour de caisse sont fusionnées dans l'entrée de la pharmacie active.",
      },
      {
        sourceFile: "apps/web/app/page.tsx",
        quote:
          '        {view==="caisse"&&<CashAndSafe session={cashSession} onChange={updateCash} pharmacyCode={pharmacyCode}/>}',
        behavior:
          "La vue Caisse et Coffre reçoit la session et le callback de mise à jour depuis Home.",
      },
    ],
    assertions: [
      {
        id: "s5-total-1240",
        description:
          "Total compté : 2 × 500,00 € + 2 × 100,00 € + 2 × 20,00 € = 1 240,00 €",
        target: {
          by: "css",
          value: "[data-cash-state]",
        },
        afterStep: "fill-20",
        verification: "transition",
        kind: "text",
        expected: "1 240,00 €",
      },
      {
        id: "s5-qty-500-two",
        description:
          "La quantité de billets de 500 € est toujours 2 après l'aller-retour",
        target: {
          by: "role",
          value: "textbox",
          name: "Quantité · Billet de 500 €",
        },
        afterStep: "back-cash",
        verification: "state",
        kind: "value",
        expected: "2",
      },
      {
        id: "s5-total-1240-back",
        description:
          "Le total compté est toujours 1 240,00 € après l'aller-retour",
        target: {
          by: "css",
          value: "[data-cash-state]",
        },
        afterStep: "back-cash",
        verification: "state",
        kind: "text",
        expected: "1 240,00 €",
      },
    ],
  },
] as unknown as Plan["scenarios"];

/**
 * Le matériel source réel du diff de la PR 17 au SHA 814b6713 : les
 * dénominations que `packages/domain/src/cash.ts` déclare et les lignes de
 * `apps/web/app/page.tsx` qui composent le nom accessible des champs de
 * comptage. Ce sont des lignes du patch, avec leur numéro dans le nouveau
 * fichier — rien n'est réécrit ici. La source énumère « Billet de 20 € » et
 * « Pièce de 20 c », jamais « Pièce de 20 € » : c'est la mesure qui rend
 * l'invention du run b7da97f1 lisible sans navigateur.
 */
const MATERIAL: SourceLineMaterial[] = [
  {
    path: "packages/domain/src/cash.ts",
    lines: [
      {
        line: 18,
        text: '  { cents: 50_000, label: "Billet de 500 €", kind: "billet" },',
      },
      {
        line: 19,
        text: '  { cents: 20_000, label: "Billet de 200 €", kind: "billet" },',
      },
      {
        line: 20,
        text: '  { cents: 10_000, label: "Billet de 100 €", kind: "billet" },',
      },
      {
        line: 21,
        text: '  { cents: 5_000, label: "Billet de 50 €", kind: "billet" },',
      },
      {
        line: 22,
        text: '  { cents: 2_000, label: "Billet de 20 €", kind: "billet" },',
      },
      {
        line: 23,
        text: '  { cents: 1_000, label: "Billet de 10 €", kind: "billet" },',
      },
      {
        line: 24,
        text: '  { cents: 500, label: "Billet de 5 €", kind: "billet" },',
      },
      {
        line: 25,
        text: '  { cents: 200, label: "Pièce de 2 €", kind: "piece" },',
      },
      {
        line: 26,
        text: '  { cents: 100, label: "Pièce de 1 €", kind: "piece" },',
      },
      {
        line: 27,
        text: '  { cents: 50, label: "Pièce de 50 c", kind: "piece" },',
      },
      {
        line: 28,
        text: '  { cents: 20, label: "Pièce de 20 c", kind: "piece" },',
      },
      {
        line: 29,
        text: '  { cents: 10, label: "Pièce de 10 c", kind: "piece" },',
      },
      {
        line: 30,
        text: '  { cents: 5, label: "Pièce de 5 c", kind: "piece" },',
      },
      {
        line: 31,
        text: '  { cents: 2, label: "Pièce de 2 c", kind: "piece" },',
      },
      {
        line: 32,
        text: '  { cents: 1, label: "Pièce de 1 c", kind: "piece" },',
      },
      { line: 47, text: "  readonly label: string;" },
      { line: 102, text: "      label: denomination.label," },
    ],
  },
  {
    path: "apps/web/app/page.tsx",
    lines: [
      {
        line: 350,
        text: '  const status=closed?"Session clôturée":!counted.ok?"Quantité à corriger":variance===null?"Comptage en cours":balanced?"Comptage juste":closure?.status==="ecart-justifie"?"Écart justifié":"Écart à justifier";',
      },
      {
        line: 354,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: citation recopiée du run, garde son `${` non évalué.
        text: '  const close=()=>{if(!counted.ok){setMessage("Quantité illisible : corrigez la ligne signalée avant de clôturer.");return}if(expectedCents===null){setMessage("Montant d’espèces attendu manquant ou illisible.");return}if(closure?.blocking){setMessage(`Écart de ${formatAmountFr(centsToEuros(closure.varianceCents))} : une justification écrite est obligatoire avant clôture.`);return}onChange({closedAt:new Date().toISOString()});setMessage("Session clôturée : le comptage est verrouillé.")};',
      },
      {
        line: 358,
        text: '      <div><p className="text-sm text-[#74758d]">Caisse et Coffre · {pharmacyCode}</p><h2 className="mt-1 text-2xl font-bold capitalize">{formatDate(iso(TODAY))}</h2></div>',
      },
      {
        line: 367,
        text: '          <div><h3 className="font-bold">Coupures et pièces</h3><p className="mt-1 text-sm text-[#74758d]">Quantités comptées dans le tiroir et le coffre. Un champ vide compte pour zéro.</p></div>',
      },
      {
        line: 372,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: citation recopiée du run, garde son `${` non évalué.
        text: '          <Input value={session.quantities[String(d.cents)]??""} onChange={e=>setQuantity(d.cents,e.target.value)} disabled={closed} inputMode="numeric" aria-label={`Quantité · ${d.label}`} aria-invalid={invalid||undefined} className="h-10 rounded-lg bg-[#fbfcff] text-right font-semibold"/>',
      },
      {
        line: 377,
        text: '          <label className="text-sm font-semibold">Montant d’espèces attendu',
      },
      {
        line: 378,
        text: '            <Input value={session.expected} onChange={e=>onChange({expected:e.target.value})} disabled={closed} inputMode="decimal" aria-label="Montant d’espèces attendu" aria-invalid={expected.ok?undefined:true} className="mt-2 h-11 rounded-xl bg-[#fbfcff] font-semibold"/>',
      },
      {
        line: 382,
        text: '          <label className="text-sm font-semibold">Justification de l’écart (obligatoire si l’écart n’est pas nul)',
      },
      {
        line: 383,
        text: '            <textarea value={session.justification} onChange={e=>onChange({justification:e.target.value})} disabled={closed} aria-label="Justification de l’écart" className="mt-2 min-h-[108px] w-full rounded-xl border border-[#d6d8e8] bg-[#fbfcff] p-3 font-normal outline-none focus:ring-2 focus:ring-[#912cff]/30 disabled:opacity-50" placeholder="Erreur de rendu de monnaie, fond de caisse non retiré…"/>',
      },
      {
        line: 386,
        text: '        <div className="mt-6 flex flex-wrap items-center justify-between gap-3"><span role="status" className="text-sm font-semibold text-[#16865b]">{message}</span><Button onClick={close} disabled={closed||!counted.ok} className="h-11 rounded-xl bg-[#08086f] px-5 hover:bg-[#24249a]">Clôturer la session</Button></div>',
      },
      {
        line: 391,
        text: '        <Card>{closed?<><p className="font-bold">Comptage verrouillé</p><p className="mt-2 text-sm text-[#74758d]">Session de {pharmacyCode} clôturée à {closedAt}. Les quantités ne sont plus modifiables.</p><Button onClick={reopen} variant="outline" className="mt-4 h-10 rounded-xl">Réouvrir le comptage</Button></>:<><p className="font-bold">Session en cours</p><p className="mt-2 text-sm text-[#74758d]">Le comptage est conservé quand vous quittez cette vue, et il est distinct pour chaque pharmacie : revenez sur Caisse et Coffre pour le retrouver.</p></>}</Card>',
      },
    ],
  },
];

/**
 * L'instantané d'accessibilité de la page de découverte du même run, tel que le
 * relevé de la première étape l'a enregistré (les 14 000 premiers caractères,
 * plafond de l'instantané du modèle) : la vue Caisse et Coffre n'y est pas
 * encore, elle s'ouvre par le clic de l'étape 2 — c'est pourquoi les cibles qui
 * la visent restent « non concluantes » pour le contrôle d'évidence.
 */
const DISCOVERY_ARIA = `- generic [active] [ref=e1]:
  - main [ref=e2]:
    - complementary [ref=e3]:
      - img "Arpilabe — le catalyseur de projets officinaux" [ref=e5]
      - paragraph [ref=e6]: Espace de travail
      - navigation [ref=e7]:
        - button "Pilotage" [ref=e9]:
          - img [ref=e10]
          - generic [ref=e15]: Pilotage
          - img [ref=e16]
        - button "P&L" [ref=e19]:
          - img [ref=e20]
          - generic [ref=e22]: P&L
        - button "Saisie" [ref=e24]:
          - img [ref=e25]
          - generic [ref=e27]: Saisie
          - img [ref=e28]
        - button "Caisse et Coffre" [ref=e31]:
          - img [ref=e32]
          - generic [ref=e34]: Caisse et Coffre
        - button "Pièces comptables" [ref=e36]:
          - img [ref=e37]
          - generic [ref=e41]: Pièces comptables
        - button "Contrôle Arpilabe 12" [ref=e43]:
          - img [ref=e44]
          - generic [ref=e48]: Contrôle Arpilabe
          - generic [ref=e49]: "12"
        - button "Synthèse Arpilabe" [ref=e51]:
          - img [ref=e52]
          - generic [ref=e54]: Synthèse Arpilabe
        - button "Mes Contrats" [ref=e56]:
          - img [ref=e57]
          - generic [ref=e60]: Mes Contrats
        - button "Mes échéanciers" [ref=e62]:
          - img [ref=e63]
          - generic [ref=e65]: Mes échéanciers
        - button "Paramétrage Contrôle" [ref=e67]:
          - img [ref=e68]
          - generic [ref=e71]: Paramétrage Contrôle
        - button "Gestion des utilisateurs" [ref=e73]:
          - img [ref=e74]
          - generic [ref=e79]: Gestion des utilisateurs
      - generic [ref=e80]:
        - paragraph [ref=e81]: Administrateur
        - paragraph [ref=e82]: Toutes les pharmacies
    - generic [ref=e83]:
      - generic [ref=e84]:
        - generic [ref=e85]:
          - paragraph [ref=e86]: jeudi 22 octobre 2026
          - heading "Pilotage" [level=1] [ref=e87]
        - generic [ref=e88]:
          - generic [ref=e89]: Pharmacie active
          - combobox "Pharmacie active" [ref=e90]:
            - option "DEMO01 · Pharmacie de démonstration 1"
            - option "DEMO02 · Pharmacie de démonstration 2"
            - option "DEMO03 · Pharmacie de démonstration 3"
            - option "DEMO04 · Pharmacie de démonstration 4"
            - option "DEMO05 · Pharmacie de démonstration 5"
            - option "DEMO06 · Pharmacie de démonstration 6"
            - option "DEMO07 · Pharmacie de démonstration 7"
            - option "DEMO08 · Pharmacie de démonstration 8"
            - option "DEMO09 · Pharmacie de démonstration 9"
            - option "DEMO10 · Pharmacie de démonstration 10"
            - option "DEMO11 · Pharmacie de démonstration 11"
            - option "DEMO12 · Pharmacie de démonstration 12"
            - option "DEMO13 · Pharmacie de démonstration 13"
            - option "DEMO14 · Pharmacie de démonstration 14"
            - option "DEMO15 · Pharmacie de démonstration 15"
            - option "DEMO16 · Pharmacie de démonstration 16"
            - option "DEMO17 · Pharmacie de démonstration 17" [selected]
            - option "DEMO18 · Pharmacie de démonstration 18"
            - option "DEMO19 · Pharmacie de démonstration 19"
            - option "DEMO20 · Pharmacie de démonstration 20"
            - option "DEMO21 · Pharmacie de démonstration 21"
            - option "DEMO22 · Pharmacie de démonstration 22"
            - option "DEMO23 · Pharmacie de démonstration 23"
            - option "DEMO24 · Pharmacie de démonstration 24"
            - option "DEMO25 · Pharmacie de démonstration 25"
            - option "DEMO26 · Pharmacie de démonstration 26"
            - option "DEMO27 · Pharmacie de démonstration 27"
            - option "DEMO28 · Pharmacie de démonstration 28"
            - option "DEMO29 · Pharmacie de démonstration 29"
            - option "DEMO30 · Pharmacie de démonstration 30"
        - button "Notifications" [ref=e91]:
          - img [ref=e92]
        - generic [ref=e95]:
          - generic [ref=e96]: Profil de démonstration
          - combobox "Profil de démonstration" [ref=e97]:
            - option "Administrateur démo 1" [selected]
            - option "Administrateur démo 2"
            - option "Équipe Arpilabe démo 1"
            - option "Équipe Arpilabe démo 2"
            - option "Pharmacien titulaire démo 1"
            - option "Pharmacien titulaire démo 2"
            - option "Secrétaire démo 1"
            - option "Secrétaire démo 2"
      - generic [ref=e99]:
        - generic [ref=e100]:
          - generic [ref=e101]:
            - paragraph [ref=e102]: Pharmacie DEMO17 · données importées
            - heading "Pilotage de l’activité" [level=2] [ref=e103]
          - generic [ref=e104]:
            - generic [ref=e105]:
              - text: Année
              - combobox "Année" [ref=e106]:
                - option "2026" [selected]
            - generic [ref=e107]:
              - text: Mois
              - combobox "Mois" [ref=e108]:
                - option "juin 2026" [selected]
            - generic [ref=e109]:
              - text: Jour
              - combobox "Jour" [ref=e110]:
                - option "18/08/2026" [selected]
            - button "Saisir" [ref=e111]:
              - img
              - text: Saisir
        - generic [ref=e112]:
          - strong [ref=e113]: mardi 18 août 2026 comparé au même jour de N-1
          - text: ·
          - generic [ref=e114]: Chargement des données DEMO17. Les comparaisons mensuelles et annuelles sont proratisées au nombre de jours saisis.
        - generic [ref=e115]:
          - article [ref=e116]:
            - paragraph [ref=e117]: CA TTC hors exceptionnel
            - paragraph [ref=e118]: —
            - paragraph [ref=e119]: Chargement
          - article [ref=e120]:
            - paragraph [ref=e121]: Marge logiciel
            - paragraph [ref=e122]: —
            - paragraph [ref=e123]: Chargement
          - article [ref=e124]:
            - paragraph [ref=e125]: Clients
            - paragraph [ref=e126]: —
            - paragraph [ref=e127]: Chargement
          - article [ref=e128]:
            - paragraph [ref=e129]: Panier moyen
            - paragraph [ref=e130]: —
            - paragraph [ref=e131]: Calculé sur le CA hors exceptionnel
        - generic [ref=e132]:
          - article [ref=e133]:
            - heading "Chiffre d’affaires TTC" [level=3] [ref=e134]
            - paragraph [ref=e135]: Suivi mensuel sur 12 mois
            - generic [ref=e137]: Chargement des données…
          - article [ref=e138]:
            - heading "Marge commerciale" [level=3] [ref=e139]
            - paragraph [ref=e140]: Suivi mensuel sur 12 mois
            - generic [ref=e142]: Chargement des données…
          - article [ref=e143]:
            - heading "Masse salariale" [level=3] [ref=e144]
            - paragraph [ref=e145]: Suivi mensuel sur 12 mois
            - generic [ref=e147]: Chargement des données…
          - article [ref=e148]:
            - heading "Ventes de produits chers" [level=3] [ref=e149]
            - paragraph [ref=e150]: Suivi mensuel sur 12 mois
            - generic [ref=e152]: Chargement des données…
        - generic [ref=e153]:
          - generic [ref=e154]:
            - generic [ref=e155]:
              - paragraph [ref=e156]: Référentiel REPORTING · colonnes DH et DI
              - heading "Tous les indicateurs" [level=3] [ref=e157]
            - generic [ref=e158]: Alimentés par le P&L DEMO17
          - generic [ref=e159]:
            - article [ref=e161]:
              - generic [ref=e162]:
                - heading "Chiffre d’affaires et CA hors exceptionnel" [level=4] [ref=e163]
                - generic [ref=e164]: "11"
              - generic [ref=e165]:
                - generic [ref=e166]:
                  - generic [ref=e167]:
                    - paragraph [ref=e168]: CA TTC total
                    - paragraph [ref=e169]: Évolution N / N-1
                  - generic [ref=e170]: —
                - generic [ref=e171]:
                  - generic [ref=e172]:
                    - paragraph [ref=e173]: CA TTC hors exceptionnel
                    - paragraph [ref=e174]: Évolution N / N-1
                  - generic [ref=e175]: —
                - generic [ref=e176]:
                  - generic [ref=e177]:
                    - paragraph [ref=e178]: CA HT total
                    - paragraph [ref=e179]: Évolution N / N-1
                  - generic [ref=e180]: —
                - generic [ref=e181]:
                  - generic [ref=e182]:
                    - paragraph [ref=e183]: CA HT à TVA 20 %
                    - paragraph [ref=e184]: Évolution N / N-1
                  - generic [ref=e185]: —
                - generic [ref=e186]:
                  - generic [ref=e187]:
                    - paragraph [ref=e188]: CA HT à TVA 10 %
                    - paragraph [ref=e189]: Évolution N / N-1
                  - generic [ref=e190]: —
                - generic [ref=e191]:
                  - generic [ref=e192]:
                    - paragraph [ref=e193]: CA HT à TVA 5,5 %
                    - paragraph [ref=e194]: Évolution N / N-1
                  - generic [ref=e195]: —
                - generic [ref=e196]:
                  - generic [ref=e197]:
                    - paragraph [ref=e198]: CA HT à TVA 2,1 %
                    - paragraph [ref=e199]: Évolution N / N-1
                  - generic [ref=e200]: —
                - generic [ref=e201]:
                  - generic [ref=e202]:
                    - paragraph [ref=e203]: CA HT à TVA 0 %
                    - paragraph [ref=e204]: Évolution N / N-1
                  - generic [ref=e205]: —
                - generic [ref=e206]:
                  - generic [ref=e207]:
                    - paragraph [ref=e208]: CA exceptionnel
                    - paragraph [ref=e209]: Variation issue des ventes exceptionnelles
                  - generic [ref=e210]: —
                - generic [ref=e211]:
                  - generic [ref=e212]:
                    - paragraph [ref=e213]: CA TTC par jour
                    - paragraph [ref=e214]: Évolution N / N-1
                  - generic [ref=e215]: —
                - generic [ref=e216]:
                  - generic [ref=e217]:
                    - paragraph [ref=e218]: CA HT hors exceptionnel
                    - paragraph [ref=e219]: Évolution N / N-1
                  - generic [ref=e220]: —
            - article [ref=e222]:
              - generic [ref=e223]:
                - heading "Produits chers" [level=4] [ref=e224]
                - generic [ref=e225]: "8"
              - generic [ref=e226]:
                - generic [ref=e227]:
                  - generic [ref=e228]:
                    - paragraph [ref=e229]: Produits supérieurs à 150 €
                    - paragraph [ref=e230]: Part du CA HT à 2,1 %
                  - generic [ref=e231]: —
                - generic [ref=e232]:
                  - generic [ref=e233]:
                    - paragraph [ref=e234]: Produits supérieurs à 150 €
                    - paragraph [ref=e235]: Écart en euros N / N-1
                  - generic [ref=e236]: —
                - generic [ref=e237]:
                  - generic [ref=e238]:
                    - paragraph [ref=e239]: Produits supérieurs à 450 €
                    - paragraph [ref=e240]: Part du CA HT à 2,1 %
                  - generic [ref=e241]: —
                - generic [ref=e242]:
                  - generic [ref=e243]:
                    - paragraph [ref=e244]: Produits supérieurs à 450 €
                    - paragraph [ref=e245]: Écart en euros N / N-1
                  - generic [ref=e246]: —
                - generic [ref=e247]:
                  - generic [ref=e248]:
                    - paragraph [ref=e249]: Produits supérieurs à 1 930 €
                    - paragraph [ref=e250]: Part du CA HT à 2,1 %
                  - generic [ref=e251]: —
                - generic [ref=e252]:
                  - generic [ref=e253]:
                    - paragraph [ref=e254]: Produits supérieurs à 1 930 €
                    - paragraph [ref=e255]: Écart en euros N / N-1
                  - generic [ref=e256]: —
                - generic [ref=e257]:
                  - generic [ref=e258]:
                    - paragraph [ref=e259]: CA HT total hors produits chers
                    - paragraph [ref=e260]: Évolution N / N-1
                  - generic [ref=e261]: —
                - generic [ref=e262]:
                  - generic [ref=e263]:
                    - paragraph [ref=e264]: CA HT à TVA 2,1 % hors produits chers
                    - paragraph [ref=e265]: Évolution N / N-1
                  - generic [ref=e266]: —
            - article [ref=e268]:
              - generic [ref=e269]:
                - heading "Marge par taux de TVA" [level=4] [ref=e270]
                - generic [ref=e271]: "6"
              - generic [ref=e272]:
                - generic [ref=e273]:
                  - generic [ref=e274]:
                    - paragraph [ref=e275]: Marge commerciale hors prestations
                    - paragraph [ref=e276]: Taux de marge
                  - generic [ref=e277]: —
                - generic [ref=e278]:
                  - generic [ref=e279]:
                    - paragraph [ref=e280]: Marge globale
                    - paragraph [ref=e281]: Taux et écart avec la référence
                  - generic [ref=e282]: —
                - generic [ref=e283]:
                  - generic [ref=e284]:
                    - paragraph [ref=e285]: Marge TVA 20 %
                    - paragraph [ref=e286]: Taux et écart avec la référence
                  - generic [ref=e287]: —
                - generic [ref=e288]:
                  - generic [ref=e289]:
                    - paragraph [ref=e290]: Marge TVA 10 %
                    - paragraph [ref=e291]: Taux et écart avec la référence
                  - gen`;

const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(close.splice(0).map((fn) => fn()));
});

/** Le plan mesuré du run b7da97f1, tel que l'artefact le porte. */
const MEASURED_PLAN = PlanSchema.parse({
  summary: "Rejeu du run b7da97f1",
  scenarios: SCENARIOS,
  skipped: [],
});

/** La cible inventée du run, telle que les deux scénarios l'écrivent. */
const INVENTED = 'role=textbox name="Quantité · Pièce de 20 €"';

/**
 * Le message d'exécution du run b7da97f1, recopié de l'artefact : c'est ce que
 * l'opérateur lisait, et ce que le refus statique remplaçait autrefois.
 */
const MEASURED_FAILURE =
  "Canary action failed: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByRole('textbox', { name: 'Quantité · Pièce de 20 €', exact: true })";

/**
 * Les champs de comptage de l'instantané RÉEL du run b7da97f1, à l'instant du
 * remplissage (« Quantité · Billet de 20 € » y figure, « Pièce de 20 € »
 * n'existe pas) : les lignes sont recopiées de l'artefact, avec leurs refs.
 */
const OBSERVED_CASH_FIELDS = `- main [ref=e2]:
  - button "Caisse et Coffre" [ref=e31]
  - textbox "Quantité · Billet de 500 €" [active] [ref=e380]: "2"
  - textbox "Quantité · Billet de 200 €" [ref=e384]
  - textbox "Quantité · Billet de 100 €" [ref=e388]
  - textbox "Quantité · Billet de 50 €" [ref=e392]
  - textbox "Quantité · Billet de 20 €" [ref=e396]
  - textbox "Quantité · Billet de 10 €" [ref=e400]
  - textbox "Quantité · Billet de 5 €" [ref=e404]
  - textbox "Quantité · Pièce de 2 €" [ref=e408]
  - textbox "Quantité · Pièce de 1 €" [ref=e412]
  - textbox "Quantité · Pièce de 50 c" [ref=e416]
  - textbox "Quantité · Pièce de 20 c" [ref=e420]
  - textbox "Montant d’espèces attendu" [ref=e440]: 1 240,00
  - paragraph: Espace de travail`;

describe("rejeu du run b7da97f1 : cible inventée de la vue Caisse et Coffre", () => {
  it("montre le trou du contrôle d'évidence : la cible inventée reste non concluante", () => {
    // AVANT : l'instantané de découverte est celui du tableau de bord, la vue
    // Caisse s'ouvre au clic de l'étape 2, donc le contrôle d'évidence ne peut
    // plus rien affirmer sur les cibles qui suivent — 21 des 27 cibles du plan
    // mesuré tombent dans ce cas, dont celle-ci.
    const report = validatePlanEvidence(MEASURED_PLAN, {
      url: "https://17.arpilabe.pharmania.fr/",
      aria: DISCOVERY_ARIA,
    });
    expect(report.incomplete).toBeUndefined();
    expect(report.refusals).toEqual([]);
    const invented = report.inconclusive.filter(
      (item) => item.target === INVENTED
    );
    expect(invented).toHaveLength(2);
    expect(new Set(invented.map((item) => item.scenarioId))).toEqual(
      new Set([
        "balanced-cash-closes-and-reopens",
        "cash-count-survives-view-switch",
      ])
    );
    for (const gap of invented) {
      expect(gap.reason).toBe(
        "une étape antérieure a interagi avec la page ou en a changé la route"
      );
    }
    // Et le message que l'opérateur en recevait ne nommait aucune cible réelle :
    // c'est le diagnostic mesuré du run, recopié de l'artefact.
    expect(MEASURED_FAILURE).not.toContain("cibles observées");
  });

  it("laisse le plan s'exécuter, et bloque la cible inventée à l'exécution", async () => {
    // Le refus statique n'existe plus : une cible que le diff ne déclare pas
    // n'est pas une cible inventée (la PR 20 l'a mesuré, voir le rejeu du run
    // 20c3c29a). L'invention du run b7da97f1 reste attrapée — par l'exécution,
    // qui la refusait déjà toute seule dans ce run — et son diagnostic nomme
    // les cibles réellement observées dans le DOM, ce qu'aucun message ne
    // faisait avant le lot AL.
    const scenario = structuredClone(MEASURED_PLAN.scenarios[0]!);
    const invented = scenario.steps.findIndex((step) => step.id === "fill-20");
    expect(invented).toBeGreaterThan(0);
    scenario.steps = scenario.steps.slice(0, invented + 1);
    // Une seule assertion, celle du remplissage : le contrat exige une étape
    // ordonnée par assertion, et l'échec du remplissage l'interrompt de toute
    // façon.
    scenario.assertions = scenario.assertions.filter(
      (assertion) => assertion.id === "s1-total-1240"
    );
    scenario.steps.push({
      id: "assert-total",
      description: "Vérifier le total compté",
      action: { type: "assert", assertionId: "s1-total-1240" },
    });
    const f = await fixture();
    close.push(f.close);
    const actions: string[] = [];
    // Le run nomme ses appels par le rang de l'étape et son action : le
    // remplissage du run y est `${rang de fill-20 + 1}-fill`.
    const inventedCall = `${invented + 1}-fill`;
    vi.spyOn(Canary.prototype, "start").mockResolvedValue("invented-target");
    vi.spyOn(Canary.prototype, "act").mockImplementation(
      async (_session, label) => {
        actions.push(label);
        if (label === inventedCall) {
          throw new QaError(
            "TARGET_NOT_FOUND",
            MEASURED_FAILURE,
            "Check the target."
          );
        }
        return {
          url: "https://fixture/",
          snapshot: OBSERVED_CASH_FIELDS,
          evidence: OBSERVED_CASH_FIELDS,
          actual: true,
        };
      }
    );
    vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
    const blocked = await executeScenario(
      scenario,
      f.baseUrl,
      f.dataDir,
      f.config,
      new Canary(f.config),
      undefined,
      "",
      MATERIAL
    );
    // Aucun refus statique ne devance l'exécution : l'étape de remplissage a
    // bien coûté un appel navigateur, et c'est celui qui échoue.
    expect(actions).toContain(inventedCall);
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.diagnostic?.code).toBe("TARGET_NOT_FOUND");
    // Ce qui se publie est constant : le message dit qu'il y a des cibles
    // observées, jamais lesquelles.
    expect(String(blocked.diagnostic?.message)).toContain(
      "cibles observées dans le DOM à cet instant : voir le détail du run"
    );
    // Le détail, lui, vit dans l'artefact et nomme les champs réels — dont le
    // « Billet de 20 € » que la cible inventée cherchait.
    const failed = blocked.steps.find((step) => step.stepId === "fill-20");
    expect(failed?.observedTargets).toContain(
      'textbox "Quantité · Billet de 20 €"'
    );
    expect(failed?.observedTargets).not.toContain("Pièce de 20 €");
  });
});

/**
 * Rejeu du run 20c3c29a, celui qui a décidé du retrait du refus statique.
 *
 * La version statique refusait une cible role+nom absente des fragments du diff
 * dès qu'un nom déclaré en différait d'un mot. Sur ce run elle a bloqué 9 des 10
 * scénarios en `PLAN_TARGET_NOT_IN_SOURCE` pour quatre libellés que
 * l'application rend réellement — `Quantité · Billet de 20 €`, `… de 100 €`,
 * `… de 50 €`, `… de 5 €` —, tous venus de `packages/domain/src/cash.ts`, un
 * fichier que le diff de la PR 20 ne touche pas. Le seul voisin que le message a
 * nommé est `Billet de 500 €` : c'est le matériel que ce rejeu sert, celui que
 * le refus de production a révélé.
 *
 * L'autre PR ne sauve pas la règle : le vrai positif du corpus (le run
 * b7da97f1, même matériel, même vue derrière un clic) n'a jamais été refusé en
 * production ; il a échoué en `TARGET_NOT_FOUND` et le relevé des cibles
 * observées l'explique. Et les deux façons de resserrer la règle mesurées sur
 * ces deux PR ne gardent pas ce positif : exiger que la cible voisine soit
 * observée rend le contrôle muet des deux côtés (les champs de comptage sont
 * hors de l'instantané de découverte, et dans les 9 313 instantanés du corpus
 * qui montrent un champ de comptage, « Billet de 20 € » et « Billet de 500 € »
 * apparaissent ensemble), exiger que le mot remplacé ne soit déclaré nulle part
 * le rend muet de même (chaque mot de l'invention est déclaré ailleurs dans le
 * matériel : « Pièce » par « Pièce de 1 € », « € » par « Billet de 20 € », « 20 »
 * par « Pièce de 20 c »). Les deux se réduisent donc au retrait, avec du code en
 * plus : c'est le retrait qui est gardé.
 */
describe("rejeu du run 20c3c29a : cibles réelles que le diff ne déclare pas", () => {
  it("ne refuse plus les quatre libellés rendus par l'application, et les exécute", async () => {
    // Le run rejoué ne change que la provenance des fichiers : le fixture ne
    // sert qu'un patch, et les exigences doivent citer une ligne du diff. Les
    // cibles, elles, sont celles du run, mot pour mot.
    const scenarios = structuredClone(LOT_AL_SCENARIOS).map((scenario) => {
      const fills = scenario.steps.filter(
        (step) =>
          step.action.type === "fill" &&
          step.action.locator.by === "role" &&
          /^Quantité · /.test(step.action.locator.name ?? "")
      );
      expect(fills.length).toBeGreaterThan(0);
      const lastFill = fills.at(-1)!;
      const last = scenario.steps.indexOf(lastFill);
      // Les étapes qui portent les cibles, dans l'ordre du run, jusqu'au dernier
      // remplissage refusé, puis l'assertion que ce remplissage sert : le
      // contrat exige une étape ordonnée par assertion, et les assertions
      // intermédiaires du run qui ne sont plus servies par aucune étape
      // laissée sont écartées avec leurs étapes `assert`.
      const steps = scenario.steps
        .slice(0, last + 1)
        .filter((step) => step.action.type !== "assert");
      const visible = scenario.assertions.find(
        (assertion) => assertion.afterStep === lastFill.id
      );
      expect(visible).toBeDefined();
      steps.push({
        id: "assert-after-count",
        description: "Vérifier l'état après le comptage",
        action: { type: "assert", assertionId: visible!.id },
      });
      return {
        ...scenario,
        sourceFiles: ["src/form.ts"],
        requirements: [
          {
            sourceFile: "src/form.ts",
            quote: 'label: "Billet de 500 €"',
            behavior: "La source énumère les dénominations comptées",
          },
        ],
        steps,
        assertions: [visible!],
      };
    });
    const f = await fixture({
      // Le matériel que le refus de production a révélé : un seul nom déclaré,
      // « Billet de 500 € ». La liste des dénominations vit hors du diff.
      formPatch:
        // biome-ignore lint/suspicious/noTemplateCurlyInString: la ligne du patch est le gabarit de la source, non évalué ici.
        '@@ -1,1 +1,2 @@\n+  { cents: 50_000, label: "Billet de 500 €", kind: "billet" },\n+aria-label={`Quantité · ${d.label}`}',
      plans: [
        {
          summary: "Rejeu des cibles réelles du run 20c3c29a",
          scenarios: scenarios as Plan["scenarios"],
          skipped: [],
        },
      ],
    });
    close.push(f.close);
    const actions: string[] = [];
    vi.spyOn(Canary.prototype, "start").mockResolvedValue("lot-al");
    vi.spyOn(Canary.prototype, "act").mockImplementation(
      async (_session, label) => {
        actions.push(label);
        return {
          url: "https://fixture/",
          snapshot: OBSERVED_CASH_FIELDS,
          evidence: OBSERVED_CASH_FIELDS,
          actual: true,
        };
      }
    );
    vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    // Aucun scénario n'est arrêté avant sa première étape navigateur : les deux
    // plans atteignent la vue Caisse, ce que le refus statique leur interdisait.
    // Un refus de plan se lit à son code (PLAN_*) et à un scénario sans aucune
    // étape ; le verdict d'exécution, lui, dépend de la page simulée, qui ne
    // bouge pas d'une lecture à l'autre et rend donc les transitions du plan
    // indémontrables.
    for (const scenario of result.scenarios) {
      expect(scenario.steps.length).toBeGreaterThan(0);
      expect(scenario.diagnostic?.code ?? "").not.toMatch(/^PLAN_/);
      // Les champs de comptage visés par le run ont bien été remplis : leurs
      // cibles existent, c'est l'application qui décide, pas le diff.
      expect(
        scenario.steps.filter((step) => step.action.type === "fill" && step.ok)
          .length
      ).toBeGreaterThan(0);
    }
    // Les libellés refusés en production sont ceux des étapes jouées.
    const played = JSON.stringify(
      result.scenarios.map((scenario) => scenario.steps)
    );
    expect(played).toContain("Quantité · Billet de 20 €");
    expect(played).toContain("Quantité · Billet de 100 €");
    expect(actions.length).toBeGreaterThan(0);
  });
});

describe("énumération des cibles observées quand une cible ne résout pas", () => {
  /**
   * L'instantané réel du run 5b888618 à l'instant de l'échec : le plan visait
   * `by:label "Pièce de 2 €"` quand les champs portent
   * « Quantité · Pièce de 2 € ». Les lignes sont celles de l'observation, dans
   * l'ordre du DOM — sept boutons de navigation avant les champs de comptage.
   */
  const OBSERVED = `- main [ref=e2]:
  - button "Pilotage" [ref=e9]
  - button "P&L" [ref=e19]
  - button "Saisie" [ref=e24]
  - button "Caisse et Coffre" [ref=e31]
  - button "Pièces comptables" [ref=e36]
  - button "Mes Contrats" [ref=e56]
  - combobox "Pharmacie active" [ref=e90]
  - textbox "Quantité · Billet de 100 €" [ref=e388]: "2"
  - textbox "Quantité · Pièce de 2 €" [ref=e420]
  - textbox "Quantité · Pièce de 1 €" [ref=e424]
  - paragraph: Espace de travail
  - status [ref=e430]`;

  it("énumère les cibles réelles observées, contrôles d'abord, sans en choisir une", () => {
    const note = observedTargetsNote(ariaRoleNameNodes(OBSERVED), MATERIAL);
    expect(note?.detail).toContain(
      "3 cibles observées dans le DOM à cet instant"
    );
    // Les champs de comptage sont nommés : le préfixe « Quantité · » que le
    // plan avait perdu se lit ici.
    expect(note?.detail).toContain('textbox "Quantité · Pièce de 2 €"');
    expect(note?.detail).toContain('textbox "Quantité · Billet de 100 €"');
    // Le nom vide, la prose et les libellés que le matériel ne déclare pas ne
    // sont pas énumérés : un run ne relève pas le contenu de la page.
    expect(note?.detail).not.toContain("Espace de travail");
    expect(note?.detail).not.toContain('status ""');
    expect(note?.detail).not.toContain("Pharmacie active");
    // Ce qui se PUBLIE est une phrase CONSTANTE : le message part dans le
    // commentaire de PR, et rien de la page n'y entre — ni un nom, ni un compte.
    expect(note?.published).toBe(
      "cibles observées dans le DOM à cet instant : voir le détail du run"
    );
  });

  it("plafonne l'énumération à huit cibles et dit ce qui reste", () => {
    const nodes = Array.from({ length: 11 }, (_unused, index) => ({
      name: `Champ ${index + 1} obligatoire`,
      role: "textbox",
    }));
    const note = observedTargetsNote(nodes, [
      {
        path: "src/form.ts",
        lines: Array.from({ length: 11 }, (_unused, index) => ({
          line: index + 1,
          text: `aria-label="Champ ${index + 1} obligatoire"`,
        })),
      },
    ]);
    expect(String(note?.detail).match(/textbox /g)).toHaveLength(8);
    expect(note?.detail).toContain("et 3 autres");
    // Le détail porte les onze, l'artefact les garde tous : la phrase publiée,
    // elle, ne les compte pas.
    expect(note?.detail).toContain("11 cibles observées");
    expect(note?.published).not.toMatch(/\d/);
  });

  it("publie la même phrase quel que soit le nombre de cibles observées", () => {
    // Le filtre est indexé sur des littéraux du diff, donc contrôlés par l'auteur
    // de la PR : un compte publié, ou même la seule présence de la phrase, lui
    // dirait si le libellé qu'il a deviné existe dans le DOM authentifié. Le
    // texte public ne dépend donc NI du nombre, NI de l'existence d'une
    // observation.
    const material = [
      {
        path: "src/form.ts",
        lines: Array.from({ length: 8 }, (_unused, index) => ({
          line: index + 1,
          text: `aria-label="Champ ${index + 1} obligatoire"`,
        })),
      },
    ];
    const node = (index: number) => ({
      name: `Champ ${index} obligatoire`,
      role: "textbox",
    });
    const one = observedTargetsNote([node(1)], material);
    const eight = observedTargetsNote(
      Array.from({ length: 8 }, (_unused, index) => node(index + 1)),
      material
    );
    const none = observedTargetsNote(
      [{ name: "Rien de déclaré", role: "textbox" }],
      material
    );
    expect(one?.published).toBe(eight?.published);
    expect(none?.published).toBe(eight?.published);
    expect(one?.published).toBe(
      "cibles observées dans le DOM à cet instant : voir le détail du run"
    );
    // L'artefact, lui, garde le compte et les noms.
    expect(one?.detail).toContain("1 cible observée");
    expect(eight?.detail).toContain("8 cibles observées");
    expect(none?.detail).toBeUndefined();
  });

  it("place le rôle visé en tête quand la cible est role+nom", () => {
    const note = observedTargetsNote(
      [
        { name: "Save now", role: "button" },
        { name: "Name field", role: "textbox" },
      ],
      [
        {
          path: "src/form.ts",
          lines: [
            { line: 1, text: 'aria-label="Save now"' },
            { line: 2, text: 'aria-label="Name field"' },
          ],
        },
      ],
      "textbox"
    );
    const detail = String(note?.detail);
    expect(detail.indexOf('textbox "Name field"')).toBeLessThan(
      detail.indexOf('button "Save now"')
    );
  });

  it("ne publie aucun nom, même un nom que le matériel source déclare", () => {
    // Le message d'un scénario part dans le commentaire de PR : un nom observé
    // n'y entre pas. Celui d'un fichier hors diff (un compte, un patient) n'est
    // pas non plus relevé, mais même un libellé déclaré est un libellé VIVANT
    // de la page, et un lecteur du dépôt n'a pas les identifiants de la preview.
    const note = observedTargetsNote(
      [
        { name: "Quantité · Billet de 20 €", role: "textbox" },
        { name: "Dossier de Mme Dupont", role: "heading" },
        { name: "Pharmacie active", role: "combobox" },
      ],
      MATERIAL
    );
    expect(note?.detail).toContain('textbox "Quantité · Billet de 20 €"');
    expect(note?.detail).not.toContain("Dupont");
    expect(note?.detail).not.toContain("Pharmacie active");
    expect(note?.published).not.toContain("Quantité");
    expect(note?.published).not.toContain("Dupont");
    expect(note?.published).not.toContain("Pharmacie active");
  });

  it("garde le message générique sans matériel déclaré", () => {
    expect(
      observedTargetsNote(
        [{ name: "Quantité · Billet de 20 €", role: "textbox" }],
        []
      )
    ).toBeUndefined();
  });

  it("ne mesure pas un nom plus long qu'un nom d'interface", () => {
    // L'instantané d'accessibilité est vivant et plafonné à 200 000 caractères :
    // un nom répété qui se recompose dans les fragments déclarés faisait tourner
    // le découpage quadratique 12,1 s sur 4 000 caractères (revue de sécurité du
    // 22 oct. 2026). Au-delà de 40 mots, rien n'est mesuré — et le nom qui, lui,
    // est un nom reste relevé.
    const overlong = Array.from({ length: 360 }, () => "alpha beta").join(" ");
    expect(overlong.length).toBeGreaterThan(3900);
    const note = observedTargetsNote(
      [
        { name: overlong, role: "textbox" },
        { name: "alpha beta", role: "button" },
      ],
      [
        {
          path: "src/form.ts",
          lines: [{ line: 1, text: 'aria-label="alpha beta"' }],
        },
      ]
    );
    expect(note?.detail).toContain('button "alpha beta"');
    expect(note?.detail).not.toContain("alpha beta alpha beta");
    expect(note?.detail).toContain("1 cible observée");
    expect(note?.published).not.toMatch(/\d/);
  });
});

/**
 * Reprise au runtime : quand une cible n'existe pas, la page vient de donner la
 * liste exacte de ce qu'elle expose. Le run la transmet au modèle, qui désigne
 * un élément de cette liste par son INDEX, puis l'étape est rejouée une seule
 * fois sur cette cible.
 *
 * Ce que la reprise ne fait pas, et que ces tests tiennent : elle ne réécrit
 * jamais une assertion (une promesse non tenue reste un échec), elle ne peut
 * choisir qu'un élément observé, et elle ne devine rien quand le modèle ne
 * désigne rien.
 */
describe("reprise au runtime d'une cible absente", () => {
  /** Le scénario mesuré, tronqué au remplissage de la cible inventée. */
  function measuredScenario() {
    const scenario = structuredClone(MEASURED_PLAN.scenarios[0]!);
    const invented = scenario.steps.findIndex((step) => step.id === "fill-20");
    expect(invented).toBeGreaterThan(0);
    scenario.steps = scenario.steps.slice(0, invented + 1);
    scenario.assertions = scenario.assertions.filter(
      (assertion) => assertion.id === "s1-total-1240"
    );
    return { scenario, invented };
  }

  it("rejoue l'étape sur la cible observée et consigne la reprise", async () => {
    const { scenario, invented } = measuredScenario();
    const f = await fixture();
    const close = [f.close];
    const labels: string[] = [];
    const fillCall = `${invented + 1}-fill`;
    let failures = 0;
    vi.spyOn(Canary.prototype, "start").mockResolvedValue("repair-target");
    vi.spyOn(Canary.prototype, "act").mockImplementation(
      async (_session, label) => {
        labels.push(label);
        if (label === fillCall && failures === 0) {
          failures += 1;
          throw new QaError(
            "TARGET_NOT_FOUND",
            MEASURED_FAILURE,
            "Check the target."
          );
        }
        return {
          url: "https://fixture/",
          snapshot: OBSERVED_CASH_FIELDS,
          evidence: OBSERVED_CASH_FIELDS,
          actual: true,
        };
      }
    );
    vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
    const asked: unknown[] = [];
    const model = {
      json: async (_system: string, payload: never) => {
        asked.push(payload);
        const observed = (payload as { observedTargets: { name: string }[] })
          .observedTargets;
        const index = observed.findIndex((target) =>
          target.name.includes("Billet de 20 €")
        );
        expect(index).toBeGreaterThanOrEqual(0);
        return { index };
      },
    } as unknown as Model;
    const result = await executeScenario(
      scenario,
      f.baseUrl,
      f.dataDir,
      f.config,
      new Canary(f.config),
      undefined,
      "",
      MATERIAL,
      model
    );
    await Promise.all(close.map((done) => done()));
    // L'étape a coûté deux appels navigateur : l'échec, puis la reprise.
    expect(labels.filter((label) => label === fillCall)).toHaveLength(2);
    expect(asked).toHaveLength(1);
    const played = result.steps.find(
      (step) => step.stepId === "fill-20" && step.ok
    );
    expect(played?.repairedTarget).toBe(
      'role=textbox name="Quantité · Billet de 20 €"'
    );
    expect(result.diagnostic?.code).not.toBe("TARGET_NOT_FOUND");
  });

  it("ne réécrit jamais une assertion : une cible absente reste un échec", async () => {
    const { scenario, invented } = measuredScenario();
    // Le remplacement devient une assertion sur la cible absente : le remplissage
    // disparaît, l'assertion reste seule à viser « Pièce de 20 € ».
    const assertionStep = {
      id: "assert-cible",
      description: "Lire la pièce de 20 €",
      action: { type: "assert" as const, assertionId: "s1-total-1240" },
    };
    scenario.steps = [...scenario.steps.slice(0, invented), assertionStep];
    scenario.assertions = scenario.assertions.map((assertion) => ({
      ...assertion,
      target: {
        by: "role" as const,
        value: "textbox",
        name: "Quantité · Pièce de 20 €",
      },
    }));
    const f = await fixture();
    const close = [f.close];
    vi.spyOn(Canary.prototype, "start").mockResolvedValue("assert-target");
    vi.spyOn(Canary.prototype, "act").mockImplementation(
      async (_session, label) => {
        if (label.endsWith("-assert")) {
          throw new QaError(
            "TARGET_NOT_FOUND",
            MEASURED_FAILURE,
            "Check the target."
          );
        }
        return {
          url: "https://fixture/",
          snapshot: OBSERVED_CASH_FIELDS,
          evidence: OBSERVED_CASH_FIELDS,
          actual: true,
        };
      }
    );
    vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
    let asked = 0;
    const model = {
      json: async () => {
        asked += 1;
        return { index: 0 };
      },
    } as unknown as Model;
    const result = await executeScenario(
      scenario,
      f.baseUrl,
      f.dataDir,
      f.config,
      new Canary(f.config),
      undefined,
      "",
      MATERIAL,
      model
    );
    await Promise.all(close.map((done) => done()));
    expect(asked).toBe(0);
    expect(result.outcome).toBe("failed");
    expect(result.diagnostic?.code).toBe("TARGET_NOT_FOUND");
  });
});
