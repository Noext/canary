# Taxonomie des familles d'échec — corpus complet

Construite sur les **200 runs identifiés** de `test/historical/campaign-runs.json`
(tous lots, y compris BA et CC apportés par `plans.json.gz`) et sur les 79 plans
stockés pour les comptes de scénarios. Recalculée par `test/campaign-runs.test.ts`.

## Familles, par nombre de runs concernés

| Famille | Runs | Lots | Scénarios (79 plans) |
| --- | --- | --- | --- |
| `TARGET_NOT_FOUND` | 27 | BA, DD, EE, FF, GG, JJ, KK, LL, NN, PP, QQ, RR | 6 |
| `MARKER_ORDER_UNREACHABLE` | 23 | CC, DD, EE, FF, GG, II, KK, LL, MM, OO, PP, QQ, RR, SS | 9 |
| `TRANSITION_NOT_OBSERVED` | 9 | BA, DD, GG, JJ, NN, RR, TT | 3 |
| `REQUIREMENT_UNGROUNDED` | 7 | CC, DD, GG, II, KK, OO, QQ | 0 |
| `QA_ERROR` | 7 | CC, KK, LL, MM, NN, OO | 0 |
| `TRANSITION_ON_INVARIANT` | 5 | BA, DD, QQ, RR | 3 |
| `RUN_BUDGET_EXCEEDED` | 4 | FF, NN, TT | 0 |
| `sans-diagnostic` | 4 | JJ, MM, TT | 0 |
| `PLAN_CHANGED_FILE_UNCOVERED` | 2 | OO, PP | 0 |
| `PLAN_STATE_TARGET_READ_AS_TEXT` | 1 | KK | 0 |
| `HTTP_502` | 1 | OO | 0 |
| `COVERAGE_WITNESS_MISSING` | 1 | QQ | 0 |
| `PLAN_SCHEMA_INVALID` | 1 | TT | 0 |
| `PLAN_SELECTOR_UNSTABLE` | 1 | UU | 0 |

## Lots connus dont les identifiants ne sont plus disponibles

Le lot **`BB`** (build `7a6050b`) a bien été mesuré — 10 runs, 7 verts, 92 scénarios
verts, 5 378 250 tokens, chiffres conservés dans
[`pr-qa-architecture.md`](pr-qa-architecture.md) — mais ses identifiants de run ne
figurent dans aucun artefact versionné, et le service ne les liste plus (rétention).
Il est donc **compté dans les taux agrégés** de l'architecture et **absent de la
taxonomie par famille**, faute de code par run : ce n'est pas une exclusion, c'est une
limite de traçabilité, écrite ici plutôt que comblée par une estimation.

70 des 200 runs du corpus portent le build `0000000` : leur lignée de code n'est pas
traçable non plus, et aucune conclusion par build ne les utilise — les agrégats par
famille ne dépendent que du verdict et du diagnostic, jamais du hash.

## Répartition par catégorie (un run non vert compté une fois)

Règle appliquée, dans cet ordre : infrastructure (`QA_ERROR`, `RUN_BUDGET_EXCEEDED`,
`HTTP_502`) → découverte (`TARGET_NOT_FOUND`, `PLAN_SELECTOR_UNSTABLE`) → état
(`TRANSITION_*`) → planification (tout autre code) → **sans diagnostic** quand aucun
code n'est enregistré, bucket séparé et non fondu dans la planification.

| Catégorie | Runs |
| --- | --- |
| planification | 27 |
| découverte de l'interface | 26 |
| infrastructure | 12 |
| dépendance d'état | 11 |
| sans diagnostic (4 runs JJ/MM/TT, un échec produit chacun, aucun code) | 4 |

Total des runs non verts : 80 sur 200.

## Code de plan ajouté après le corpus : `OBJECTIVE_UNWITNESSED`

`OBJECTIVE_UNWITNESSED` est un **défaut de plan** (catégorie planification) :
l'objectif d'un scénario — ou, sans objectif déclaré, chacune de ses assertions —
ne lit rien de ce que le diff ajoute ou retire dans les `sourceFiles` du scénario,
ni de la citation qu'elle cite : une lecture positive dont la cible ne partage aucune
suite de mots ni aucun littéral avec ces lignes, une absence (`hidden`, `count` à 0)
d'une cible qu'aucune ligne retirée n'écrit, une lecture de texte ou de valeur non
citée sans mot commun. Une telle lecture passe identiquement avant le changement :
le titre d'une vue quittée, un contrôle de navigation, l'absence d'un élément qui
n'a jamais existé. Le refus est rendu au planificateur dans sa correction, puis rejoué
avant exécution (`src/objective-witness.ts`) : le scénario non corrigé est bloqué,
classé `test-defect`, jamais publié vert. Il ne figure dans aucun des 200 runs du
corpus ci-dessus, qui le précède ; sur les 79 plans stockés, la règle ne refuse
aucun scénario (voir [`pr-qa-measurements.md`](pr-qa-measurements.md)).
