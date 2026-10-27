# Décision finale — fiabilité de `canary-pr-qa`

Ce document répond aux cinq livrables du goal. Tous les chiffres viennent des
artefacts committés (`test/historical/plans.json.gz`, `interleaved.json`) et sont
recalculés par `test/measurements-report.test.ts` ; aucune valeur n'est saisie à la
main, et la CI échoue si `pr-qa-measurements.md` est périmé.

Références figées : baseline `8143ac9`, lignée courante `4b92c9a`, build livré
`915b987` (fonctionnellement identique à `f8a6959`).

## 1. Les trois causes les plus fréquentes

Sur les 79 plans réellement produits des lots BA→II (24 runs non verts) :

| Rang | Famille | Scénarios | Runs | Lots | Préventable avant exécution ? | Risque de faux refus |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `MARKER_ORDER_UNREACHABLE` | 9 | 9 | DD, EE, FF, GG, II | **partielle** : la contradiction de longueur est démontrable (message nommant la valeur exacte, #102) ; l'ordre des gardes ne l'est pas toujours | faible : la mesure est arithmétique, et le refus nomme la valeur à écrire |
| 2 | `TARGET_NOT_FOUND` | 6 | 6 | BA, DD, EE, FF, GG | **partielle** : un libellé que le diff écrit est vérifiable, une cible rendue après interaction ne l'est pas | moyen : un libellé légitime absent du diff serait refusé à tort — d'où le choix de réparer plutôt que de refuser |
| 3 | `TRANSITION_NOT_OBSERVED` + `TRANSITION_ON_INVARIANT` | 3 + 3 | 6 | BA, DD, GG | **non** avant exécution : il faut constater que la valeur ne bouge pas | nul : la constatation vient de l'exécution, pas d'une règle |

Familles inattendues, listées par fréquence : un run bloqué **sans diagnostic**
(`0da1a10e`, corrigé en classification depuis), et, sur le build courant,
`PLAN_SELECTOR_UNSTABLE` (1 scénario, UU) — famille absente de l'historique, ce qui
confirme que les fréquences passées ne décrivent plus le code d'aujourd'hui.

Répartition par catégorie demandée : **planification** = les trois rangs ci-dessus
(21 scénarios) ; **découverte de l'interface** = `TARGET_NOT_FOUND` (6) ;
**dépendance d'état** = les invariants (6) ; **infrastructure** = 2 `QA_ERROR` et
1 `RUN_BUDGET_EXCEEDED` observés dans les campagnes, jamais comptés comme défauts
produit.

## 2. La meilleure correction candidate et son hypothèse

**Candidate retenue — empêcher la production plutôt que le refus** : donner au
planificateur les preuves du diff lui-même (libellés `controlLabels`, cibles
concrètes `concreteTargets`, bornes numériques nommées dans les refus), et faire
réécrire par le planificateur tout défaut que l'exécution sait nommer, avant
acceptation du verdict.

**Hypothèse mesurable et réfutable** : *un build dont le planificateur reçoit ces
preuves et dont l'exécution réécrit tout défaut de plan nommé atteint au moins 80 %
de runs entièrement verts sur la même PR, le même modèle et le même oracle.*
Elle est réfutée si une paire entrelacée descend sous 80 %, ou si le taux reste
inférieur à celui de la baseline.

Hypothèses écartées, chacune réfutée par la mesure : rendre les refus de contrat non
fatals (5/10 contre 7/10 sur le même build) ; réparation déterministe de cible
proche seule (5/10 contre 7/10, mais +19 scénarios verts).

## 3. Implémentation et tests

| PR | Apport | Tests |
| --- | --- | --- |
| #102 | le refus de longueur nomme la valeur exacte à écrire | `marker-order` (valeur exacte) |
| #106, #110 | libellés et cibles concrètes du diff dans le message | `policy` (deux tests) |
| #111 | une sonde de valeur d'avant qui échoue ne casse plus le scénario | `baseline-probe` (2) |
| #115 | réparation déterministe d'une cible quasi-homonyme, jamais sur un nombre | `target-nearest` (4) |
| #117 | la réécriture couvre tous les défauts de plan nommés, pas seulement les invariants | `replan` (familles, exclusion `QA_ERROR`) |

Suite complète : **846 tests verts, 5 ignorés** ; arcovia **90,10** ; conformité
« aucune connaissance de l'application testée » garantie par
`test/no-application-knowledge.test.ts`.

## 4. Résultats comparatifs, régressions comprises

Paire fraîche du 27/10, lots dos à dos sur le même service :

| Lot | Build | Runs verts | Scénarios verts | Échecs produit | Tokens |
| --- | --- | --- | --- | --- | --- |
| TT | `8143ac9` (référence) | 4/10 | 72 | 4 | 3,06 M |
| UU | `f8a6959` (courant) | **9/10** | **88** | **0** | 2,84 M |

Agrégats, **tous** les lots conservés et étiquetés :

| Périmètre | Runs | Verts | Scénarios/run | Échecs produit/run | Tokens/run |
| --- | --- | --- | --- | --- | --- |
| Référence `8143ac9` (JJ, NN, TT) | 30 | **53 %** | 7,0 | 0,3 | 265 k |
| Lignée non-référence (toutes, régressions incluses) | 79 | 59 % | 7,9 | 0,1 | 293 k |
| **Build courant (SS, UU)** | 20 | **90 %** | 9,1 | 0,1 | 288 k (+9 %) |

Régressions conservées et nommées : KK `922159d` **1/10** (sonde de valeur pré-étape
qui tuait les scénarios, corrigée en #111), OO `a683f86` 4/9, QQ `345b972` 5/10
(politique permissive réfutée). Aucun lot n'est retiré d'un agrégat.

Faux refus : mesurés sur les 79 plans rejoués à travers les deux portes — 5 refus à
la référence, 15 aujourd'hui, **10 nouvellement refusés dont 0 visait un scénario
vert**, et **0 plan refusé à la référence accepté aujourd'hui**. Faux verts : aucune
voie de requalification (pas de conversion `transition`→`state`, jamais de
réparation sur une assertion) ; la pré-satisfaction est publiée (`preMatched` : 76
assertions sur UU) et les conditions non tranchables aussi (144).

Durées : collectées pour les lots BA→II, **non collectées** pour la campagne
entrelacée — l'absence est dite, pas comblée.

## 5. Recommandation

**Poursuivre**, avec les réserves écrites :

- la paire fraîche est favorable (4/10 → 9/10) et les deux derniers lots du même
  build sont à 90 %, contre 53 % pour la référence sur 30 runs ;
- mais n = 20 côté courant, et la variance observée plus tôt sur d'autres builds
  (4/9 pour OO) interdit de parler de stabilisation : le chiffre est un point de
  mesure, pas une garantie ;
- le coût augmente de 9 % par run, ce qui reste dans l'enveloppe (aucun budget
  relevé) ;
- la lignée complète reste à 59 %, parce qu'elle contient le build défectueux KK :
  c'est l'historique, pas le code livré.

La limite du modèle imposé n'est **pas** atteinte : les familles résiduelles du
build courant (1 scénario bloqué, 1 échec produit sur 20 runs) sont plus rares que
celles de l'historique, et la prévention par les preuves du diff fonctionne. Si une
campagne ultérieure repasse sous la baseline, la conclusion redeviendra « limite du
modèle » et devra être écrite de la même façon.
