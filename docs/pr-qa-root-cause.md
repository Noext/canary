# Cause racine structurelle de l'instabilité de `canary-pr-qa`

Document établi à partir du **code livré** (`main`, août 2026) et des **artefacts versionnés** :
`test/historical/campaign-runs.json` (200 runs identifiés), `test/historical/report-scenarios.json`
(104 rapports de run encore servis, 863 scénarios), `test/historical/plans.json.gz` (79 plans
stockés), `test/historical/excerpts.json` (extraits de diagnostic avec empreinte).

Aucun chiffre de ce document ne vient d'un résumé antérieur : chacun se recalcule depuis ces
fichiers, et `test/root-cause.test.ts` le vérifie.

## 1. Le défaut unique : le plan est un contrat figé écrit sur un seul instantané

Le planificateur reçoit **une fois** la découverte de la page et le diff, puis écrit un
**script complet** : chaque étape est fixée à l'avance, cible comprise. À l'exécution, l'hôte
joue ce script dans l'ordre **sans consulter le modèle** et sans choisir la suite à partir de ce
qu'il observe.

- `src/runner.ts:1490` — un appel `model.json(PLANNER_PROMPT, payload, …)` produit le plan entier ;
  le seul retour du modèle après cela est une **correction de validation**, avant exécution.
- `src/canary.ts:776` — `discoverPreview` collecte l'instantané **une fois**, à l'ouverture de la
  preview ; rien ne le rafraîchit ensuite (`PLAN_EVIDENCE_SNAPSHOT_CHARS`, `src/canary.ts:26`).
- `src/executor.ts:336-338` — le commentaire du code dit la décision architecturale :
  « Le plan est un contrat figé : l'hôte joue chaque étape dans l'ordre, sans consulter le
  modèle. » Chaque scénario ouvre bien sa propre session (`src/executor.ts:449`), donc
  l'isolation **navigateur** existe ; c'est l'isolation **logique** des hypothèses qui manque.
- `src/runner.ts:1314` et `src/runner.ts:1682` — `replanObservedInvariants` n'intervient qu'**après** qu'une
  exécution a contredit le plan : la boucle d'observation existe, mais en réparation, pas en
  décision.

Conséquence mécanique : **toute affirmation du plan sur l'état de la page après la première
étape est une hypothèse non testée**. Le moteur ne peut la confronter à la réalité qu'en la
jouant, et il ne la corrige qu'après l'échec — ou la refuse. C'est un seul défaut
d'architecture, pas une collection de règles manquantes.

## 2. Les familles sont des conséquences de ce défaut

Sur les **80 runs non verts** du corpus :

| Classe | Runs | Part |
| --- | --- | --- |
| Hypothèse de plan contredite par l'observation (`TARGET_NOT_FOUND`, `TRANSITION_*`, `MARKER_ORDER_*`, `PLAN_*`, `COVERAGE_*`) | **64** | 80 % |
| Infrastructure (`QA_ERROR`, `HTTP_429`, `HTTP_502`, `RUN_BUDGET_EXCEEDED`) | 12 | 15 % |
| Aucun diagnostic enregistré (échec produit sans code) | 4 | 5 % |

Sur les **60 scénarios non verts** des rapports encore servis : **17** sont refusés avant
exécution (donc évitables au plan) et **51** portent un code d'hypothèse contredite.

| Famille | Mécanisme unique | Preuve (code) | Preuve (artefact) |
| --- | --- | --- | --- |
| `TARGET_NOT_FOUND` (27 runs) | la cible du plan n'existe pas dans l'état observé au moment de l'étape | `src/executor.ts:336` (contrat figé) | `e90c9e75` : `getByLabel('Quantité · Pièce de 20 €', { exact: true })` |
| `TRANSITION_NOT_OBSERVED` (9) | le plan affirme un changement que la page n'effectue pas dans cette séquence | `src/runner.ts:1314` (réparation après coup) | `32d79c30`, `f6a6a890` : `no change observed — the value after step … is identical to the baseline probed before it` |
| `MARKER_ORDER_UNREACHABLE` (23) | le plan écrit un marqueur dont l'état antérieur n'a pas été établi par une étape jouée avant | `src/policy.ts` (`unwitnessedPlanRefusals` → correction) | `277dee09`, `c98274a3` |
| `TRANSITION_ON_INVARIANT` (5) | transition demandée sur une valeur invariante par construction | `src/policy.ts` (`transition` sur valeur statique) | `e90c9e75`, `24db19b8` |
| `PLAN_*` / `COVERAGE_*` | cible, sélecteur, exigence ou couverture supposés au lieu d'être constatés | `src/plan-selector.ts`, `src/policy.ts` | `01dc01ab`, `b5711fb7` |

Ces familles ne méritent donc **pas** une règle chacune : elles partagent la même racine — une
décision prise sans observation au moment où elle est prise.

## 3. Ce que le corpus permet de classer (et ce qu'il ne permet pas)

Le brief demande de distinguer six natures d'information. Voici ce que les artefacts établissent.

**Information jamais collectée.** L'état de la page **après chaque étape** n'est jamais mis à la
disposition du planificateur : il n'existe qu'au moment de l'exécution, et seulement en cas
d'échec (sonde de valeur d'avant, `captureBaselines`, `src/executor.ts:357`). C'est la lacune
structurelle. Les **durées** ne sont collectées que pour une partie des runs (79 lots BA→II) —
absence de collecte, écrite telle quelle.

**Information collectée puis perdue.** La découverte produit un instantané riche
(`discoverPreview`), mais le plan est écrit une fois et n'y revient plus ; une cible observée
mais non retenue par le modèle est perdue pour toutes les étapes suivantes. Les **cibles proches
observées** ne sont même conservées qu'en cas d'échec (réparation `nearestObservedTarget`).

**Hypothèses inventées par le modèle.** 27 runs `TARGET_NOT_FOUND` : le libellé attendu n'existe
pas dans la vue. Ils ne se distinguent pas, à la lecture du plan, d'un libellé correct — c'est
précisément ce que l'architecture actuelle ne sait pas vérifier.

**Erreurs évitables avant exécution.** 17 scénarios refusés avant exécution sur 60 non verts
(28 %) sont déjà détectés à la lecture du plan : cette part est évitable sans navigateur. Les 43
autres ne le sont pas, faute d'observation au moment de la décision.

**Erreurs d'exécution et défauts produit réels.** Les échecs produit mesurés sont **0,09 par run**
sur le corpus (0,20 côté référence dans la campagne livrée) : ce n'est pas la source principale de
l'instabilité. Les 12 runs d'infrastructure sont nommés (`QA_ERROR`, `HTTP_429`, `RUN_BUDGET_EXCEEDED`).

**Erreurs de mesure qui empêchent de conclure.** Trois sont documentées et corrigées : la
référence `8143ac9` ne porte pas l'instrumentation `preMatched` (son zéro est un compte de clés,
pas une mesure) ; la première campagne entrelacée a servi la référence des deux côtés, faute de
déploiement abouti (artefact conservé : `campaign-attempt-1-invalid.json`) ; et un run peut être
« bloqué » par le refus d'un seul scénario alors que tous les scénarios exécutés passent
(`c98274a3`, `refusal-evidence.json`).

## 4. Ce que cette cause implique pour l'architecture

Deux conséquences, que la décision d'architecture (tâche suivante) doit trancher explicitement :

1. **Décider à partir de l'observation** : l'étape suivante ne peut pas être écrite à l'avance si
   elle dépend d'un état qui n'existe qu'après l'étape précédente. Une boucle
   objectif → observation → une action → exécution → observation → mise à jour → classement
   supprime la classe d'erreur dominante par construction, pas par règle.
2. **Garantir les invariants dans le moteur** : isolation logique des scénarios, provenance de
   chaque assertion (une preuve observée lui est attachée), et **preuve d'objectif** — un run ne
   peut pas être vert sans que l'objectif du scénario ait été vérifié. Ces garanties ne doivent
   pas dépendre de la discipline du modèle.

Ce que cette cause **n'implique pas** : ajouter une porte de plus au gate, ou un drapeau de plus
dans la planification. Les deux familles les plus fréquentes sont déjà couvertes par des refus à
la lecture, et le corpus montre qu'ils ne relèvent pas le taux de runs verts.

## 5. Limites de ce document

- Les rapports de run encore servis couvrent **104 des 200 runs** ; les autres ne sont plus
  joignables (401/404), donc les comptes de scénarios sont un plancher, pas un total.
- Le lot `BB` (10 runs, 7 verts) n'a plus d'identifiants nulle part ; il est hors taxonomie.
- 70 des 200 runs portent le build `0000000` : aucune conclusion par build ne s'appuie sur eux.
- Les causes sont classées par code de diagnostic ; un run peut porter plusieurs codes, et le
  classement « une classe par run » suit une priorité écrite (infrastructure > hypothèse de plan >
  autre), vérifiée par test.
