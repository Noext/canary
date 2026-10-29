# Décision d'architecture `canary-pr-qa` — cause racine, implémentation, campagne, conclusion

Ce document est le livrable final : il donne la cause racine retenue et ses preuves, l'architecture
livrée, les mécanismes supprimés ou remplacés, les changements et tests ajoutés, les résultats
comparatifs complets et leurs coûts, les limites résiduelles, et une conclusion sans ambiguïté.

Documents liés : [`pr-qa-root-cause.md`](pr-qa-root-cause.md) (preuves de la cause),
[`pr-qa-architecture-target.md`](pr-qa-architecture-target.md) (décision écrite avant le code),
[`pr-qa-campaign-criteria.md`](pr-qa-campaign-criteria.md) (critères figés avant le premier run).

## 1. Cause racine retenue

**Un seul défaut d'architecture : le plan est un contrat figé, écrit sur un instantané unique,
joué sans consulter l'observation.** Le code le dit lui-même — « Le plan est un contrat figé :
l'hôte joue chaque étape dans l'ordre, sans consulter le modèle » (`src/executor.ts`), un seul
appel de planification (`src/runner.ts`), une découverte relevée une fois (`src/canary.ts`), et
une réécriture qui n'intervient qu'après qu'une exécution a contredit le plan (`src/runner.ts`,
`replanObservedInvariants`).

Preuves, recalculées par `test/root-cause.test.ts` : sur les **80 runs non verts** du corpus,
**64 (80 %)** sont une hypothèse de plan contredite par l'observation, 12 sont de
l'infrastructure, 4 n'ont aucun diagnostic ; sur les **60 scénarios non verts** des rapports
conservés, **17** sont refusés avant exécution et **51** portent un code d'hypothèse contredite.
Les familles qui semblaient distinctes (cible inventée, transition jamais observée, marqueur dont
la garde n'est pas établie) sont les conséquences de ce même défaut : décider sans observer au
moment où l'on décide.

## 2. Architecture livrée

Quatre invariants, tenus **par le moteur** et pas par la discipline du modèle :

| Invariant | Mécanisme livré |
| --- | --- |
| **I1 — Isolation** | une session par scénario, navigation initiale avant la première action ; test qui vérifie les deux |
| **I2 — Provenance** | ce qui est déclaré est contrôlé : un indice d'exigence hors borne est refusé, et la valeur attendue doit partager un mot réel avec la ligne citée (`provenanceRefusals`), sur **tous** les chemins. Ce qui n'est pas déclaré est exécuté et **publié** comme non prouvé (`objectiveProven`, comptage des clés) au lieu d'être bloqué |
| **I3 — Preuve d'objectif** | si le scénario désigne l'assertion qui prouve son objectif (`objective`), `enforceObjectiveProof` bloque le scénario quand elle n'a pas passé — **sur tous** les chemins, le drapeau ne l'éteint plus ; s'il n'en désigne aucune, la mesure est publiée (`objectiveProven` faux) et la campagne compte ces scénarios |
| **I4 — Réparation non permissive** | la reprise ne reçoit qu'une étape et ne rend qu'une étape ; test qui prouve que les assertions et l'identité de l'étape sont intactes |

Chemin **observe→act** (`QA_OBSERVE_ACT`, désactivé par défaut) : la cible de chaque action est
résolue **dans l'observation courante**. Si le nom écrit par le plan n'y est pas, l'exécution
cherche le contrôle observé qui partage le plus de mots avec l'intention et le retient s'il est
unique et suffisamment proche ; l'action est rejouée sur cette cible observée. Si rien ne
correspond, le pas n'est **jamais joué**, il est consigné, et le scénario se classe
`indeterminate` avec `TARGET_NOT_FOUND`. Un seul relevé d'observation par pas joué, aucun appel
au modèle : la résolution est déterministe et bornée. L'assistance par modèle en impasse prévue
par la décision n'est pas implémentée (voir limites).

Classification explicite de chaque scénario : `proven`, `failed`, `test-defect`, `indeterminate`.

## 3. Mécanismes supprimés ou remplacés

**Aucun mécanisme n'a été supprimé, et c'est une décision, pas un oubli.** La bascule (PR 2)
était conditionnelle à la campagne ; celle-ci n'ayant pas démontré de gain, le chemin figé reste
le défaut et le chemin observe→act reste derrière son drapeau. Supprimer une porte avant d'avoir
mesuré son remplaçant aurait été exactement le geste que l'objectif interdit.

Ce qui aurait été retiré si la bascule avait été justifiée, et qui reste donc en place : la porte
de vérification statique des cibles (déjà mesurée à 0 vrai positif / 14 faux positifs en son
temps), la réparation de quasi-homonyme (`nearestObservedTarget`), la réécriture après invariants
(`replanObservedInvariants`), et le refus de lecture d'ordre de marqueur — tous remplacés
fonctionnellement par la résolution à l'exécution.

## 4. Changements et tests ajoutés

| Changement | Emplacement | Tests |
| --- | --- | --- |
| Champs `objective` (scénario) et `requirement` (assertion) | `src/schema.ts` | `engine-invariants` (I2, I3) |
| Refus de provenance nommés | `src/plan-evidence.ts` | `engine-invariants` (4 cas, deux directions) |
| Preuve d'objectif au verdict | `src/plan-evidence.ts`, `src/runner.ts` | `engine-invariants` (vert, objectif échoué, objectif non exécuté, drapeau coupé) |
| Résolution de cible dans l'observation, porte et classement explicite | `src/observe-act.ts`, `src/executor.ts` | `observe-act` (7 tests : résolution, ambiguïté, ré-ancrage, blocage, un relevé par pas) |
| Prompt : objectif et provenance demandés | `src/model.ts` | `engine-invariants` (présence dans le prompt) |
| Rejeu des plans historiques | `test/historical/replay-new-path.json` | `replay-new-path` |
| Campagne 2 × 50 entrelacée | `test/historical/architecture-campaign.json` | `architecture-campaign` |
| Critères figés | `docs/pr-qa-campaign-criteria.md` | `campaign-criteria` |

Rejeu (`test/replay-new-path.test.ts`) : sur les 79 plans stockés — 681 scénarios, 3 738
assertions —, le moteur **ne refuse rien** tant que rien n'est déclaré (0 refus) : l'absence de
provenance est instrumentée, pas bloquée. Dès qu'on déclare un indice, le contrôle mord : citer
l'exigence 0 laisse **393** refus, parce que la valeur attendue n'est pas justifiée par la ligne
citée. Et lorsqu'on cherche l'exigence qui porte réellement la valeur, **3 164 assertions** n'en
ont aucune — aucun scénario ne contient de ligne partageant un mot avec l'attendu —, ce qui laisse
encore **11** refus sur les quasi-ressemblances. C'est la cause racine, chiffrée sur des plans
réels : les attendus de ces plans ne sont pas dérivés de leurs propres exigences.

## 5. Résultats comparatifs complets

Campagne entrelacée, **5 blocs de 10 runs par bras**, même service, même PR
(`pharmania/arpilabe-pilotage#20`), même modèle (`opencode-go/deepseek-v4.1-flash`), même oracle.
Chaque bloc porte son déploiement Coolify et le commit servi ; `preMatchedKeyed` atteste du bras
(62/58/61/47/56 côté candidat, 0 côté référence).

| Indicateur | Candidat (`22b415b`/`b606e28` + `QA_OBSERVE_ACT`) | Référence (`8143ac9`) |
| --- | --- | --- |
| Runs lancés / évaluables | 50 / 44 | 50 / 44 |
| **Runs entièrement verts** | **29 (65,9 %)** | **30 (68,2 %)** |
| Scénarios verts (total) | 325 | 333 |
| **Échecs produit** | **1** | **15** |
| Faux verts (`preMatched` / assertions) | 252 / 1604 (15,7 %) | non instrumenté |
| Refus de lecture (scénarios) | 33 | 0 |
| Indéterminés (`TARGET_NOT_FOUND` par la porte) | 2 | 2 |
| Tokens par run | 289 102 | 267 280 (+8,2 % côté candidat) |
| Durée | collectée par run dans l'artefact | collectée par run dans l'artefact |
| Faux refus (run bloqué dont tous les scénarios exécutés passent) | **5** | 0 |
| Couverture des objectifs (`objectivesProven` / déclarés) | **319 / 343 (93,0 %)** | non instrumentée |
| Appels au modèle par run | 2,2 | 2,0 |
| Coût par run | non calculé (tarifs non configurés : `pricingConfigured=false`) | idem |
| Pannes d'infrastructure (nommées) | 6 | 6 |

**Effet mesuré : −2,3 points, erreur-type 10,0 points, 0,23 σ.** Aucune amélioration n'est
démontrée ; le résultat est un effet nul, compatible avec zéro dans les deux sens.

**Un garde-fou des critères est franchi, et il est publié comme tel** : les critères exigeaient
« aucun faux refus ». Le bras candidat en compte **5** — des runs bloqués par un refus de lecture
alors que tous leurs scénarios exécutés passent. Ce seul franchissement interdisait de toute
façon de déclarer un succès ; il est cohérent avec la conclusion et il est compté, pas tu.

Ventilation par famille (runs concernés) : côté candidat — `PLAN_SCHEMA_INVALID` 6 (provenance
absente du plan produit par le modèle), `CONTRACT_INCOMPLETE` 5 (objectif non prouvé),
`QA_ERROR` 5, `TARGET_NOT_FOUND` 2, `MARKER_ORDER_UNREACHABLE` 2, `COVERAGE_*` 3,
`RUN_BUDGET_EXCEEDED` 1, `PLAN_CHANGED_FILE_UNCOVERED` 1 ; côté référence —
`TRANSITION_NOT_OBSERVED` 8, `TARGET_NOT_FOUND` 2, `REQUIREMENT_UNGROUNDED` 2,
`COVERAGE_REQUIREMENT_SOURCE_MISSING` 1, `HTTP_429` 6.

Lecture : le chemin observe→act **ne déplace pas** les échecs, il les **déplace de camp**. Les
huit `TRANSITION_NOT_OBSERVED` de la référence deviennent, côté candidat, des refus de
provenance et des objectifs non prouvés : le moteur refuse désormais de courir un plan sans
preuve, au lieu de le courir et de le compter vert ou rouge. Les échecs produit chutent de 15 à 1
parce que les scénarios sans preuve ne sont plus exécutés — pas parce que le produit est corrigé.

Incidents d'infrastructure documentés, jamais comptés comme produit : (a) la publication des
statuts GitHub répond `HTTP_422` avec le jeton du service alors que le même appel réussit avec le
jeton de l'opérateur — 9 runs perdus avant toute exécution, campagne relancée avec
`publish=false` (la publication est orthogonale à la fiabilité mesurée) ; (b) 5 runs de la
référence bloqués par `HTTP_429` du fournisseur.

## 6. Limites résiduelles

1. **L'effet est nul à la puissance disponible.** 2 × 50 runs distingue ~20-25 points, pas 10-15
   (voir les critères) : un effet réel positif de 15 points serait souvent manqué. La conclusion
   est « non démontré », pas « inexistant ».
2. **Le modèle ne produit pas la provenance de façon fiable.** 6 runs candidats sont refusés
   parce que le plan n'a ni `objective` ni `requirement` : la garantie est juste, mais elle coûte
   des runs tant que le planificateur ne la respecte pas. C'est la première cause de non-vert du
   bras candidat.
3. **L'assistance modèle de la boucle n'est pas implémentée.** La résolution est déterministe
   (instantané courant, appariement par mots), ce qui évite tout coût caché ; la décision
   d'architecture prévoyait un appel borné en impasse, il reste à faire.
7. **Le défaut livré n'est pas exactement le bras mesuré.** I2 et I3 sont désormais des
   invariants moteur : ils s'appliquent aux champs déclarés, sur le chemin figé comme sur le
   chemin observe→act, alors que la campagne a mesuré le bras candidat avec la porte
   d'observation en plus (le modèle, lui, déclarait les deux champs : 343 objectifs sur 44 runs
   évaluables). Cette configuration par défaut (contrôle des champs déclarés, sans portillon
   d'observation) n'a pas été mesurée séparément ; son effet sur le taux de verts est inconnu à
   ce jour, et les plans qui n'y déclarent rien ne sont pas bloqués.
4. **La publication GitHub du service est cassée** (`HTTP_422`), sans lien avec la fiabilité
   mesurée ; elle doit être réparée côté credentials avant de réactiver `publish`.
5. **Les rapports de run ne couvrent que 104 des 200 runs** du corpus ; les comptes de scénarios
   sont un plancher, et 70 runs n'ont pas de build traçable.

## 7. Conclusion

**Amélioration non démontrée.** Le chemin observe→act, avec ses quatre invariants, ne relève pas
le taux de runs entièrement verts face à `8143ac9` : 65,9 % contre 68,2 %, soit 0,23 σ. Les
critères figés avant la campagne prévoient exactement ce cas : pas de bascule par défaut, les
invariants restent livrés, et le chemin figé reste le défaut.

Ce qui est démontré et livré :

- la cause racine est établie par le code et par 64 des 80 runs non verts ;
- les quatre invariants sont implémentés **dans le moteur** et testés dans les deux directions —
  isolation, provenance (indice *et* justification de la valeur), preuve d'objectif, réparation
  non permissive ; ils valent sur les deux chemins, le drapeau ne commande plus que la porte
  d'observation ;
- le moteur ne peut plus déclarer vert un scénario sans que l'assertion désignée comme son
  objectif ait passé ;
- la boucle observe→act existe, bornée, testée hors ligne, derrière un drapeau : elle **résout**
  la cible dans l'observation (ré-ancrage sur le contrôle observé le plus proche) et empêche
  structurellement de jouer une cible que la page n'expose pas ;

Ce qui reste, et qui appartient à une décision explicite : le modèle imposé ne produit pas
systématiquement la provenance, et c'est cette limite — et non une porte manquante — qui explique
aujourd'hui la majorité des runs non verts du bras candidat. Si une prochaine campagne doit
trancher la question, elle doit d'abord rendre la production de provenance fiable (ou accepter de
révoquer l'invariant I2), et elle devra être dimensionnée pour un effet de 10 à 15 points, ce que
2 × 50 runs ne permet pas.
