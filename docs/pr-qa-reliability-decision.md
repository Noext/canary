# Décision finale — fiabilité de `canary-pr-qa`

Document **écrit à la main** à partir des artefacts : `test/historical/campaign-runs.json`
(200 runs identifiés) et `test/historical/plans.json.gz` (79 plans). Les agrégats
cités sont recalculés par `test/campaign-runs.test.ts` depuis ces runs ; en revanche
les phrases de ce document ne sont pas générées, et une valeur qui divergerait des
artefacts ne ferait échouer la CI que si elle apparaît aussi dans
`pr-qa-measurements.md` (qui, lui, est comparé). Deux limites connues : le corpus de
200 runs n'inclut pas les 19 artefacts de `plans.json.gz` absents de la liste du
service (10 lot BA, 9 lot CC), et les citations ci-dessous sont des extraits
d'artefacts, pas des messages regénérés.

Références : baseline `8143ac9`, lignée figée `4b92c9a`.

## 1. Les trois causes les plus fréquentes (corpus complet, 200 runs)

Classement **par nombre de runs concernés** sur les artefacts stockés (un run peut
porter plusieurs codes ; le classement précédent, limité aux 79 plans BA→II, est
remplacé) :

| Rang | Famille | Runs | Scénarios (79 plans) | Catégorie | Préventable avant exécution ? | Risque de faux refus |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `TARGET_NOT_FOUND` | 27 | 6 | découverte de l'interface | partielle : un libellé écrit par le diff est vérifiable, une cible rendue après interaction non | moyen → d'où la réparation plutôt que le refus |
| 2 | `MARKER_ORDER_UNREACHABLE` | 23 | 9 | planification | partielle : contradiction de longueur démontrable (#102), ordre des gardes non | faible : la mesure est arithmétique |
| 3 | `TRANSITION_NOT_OBSERVED` | 9 | 3 | dépendance d'état | non avant exécution : il faut constater l'invariance | nul |

Les scénarios ne sont comptés que là où les 79 plans stockés les enregistrent (lot
BA→II) ; les lots JJ→UU n'ont que des comptes de scénarios verts par run, donc la
fréquence scénario est un plancher, pas un total.

Familles suivantes, toutes publiées : `REQUIREMENT_UNGROUNDED` **7** runs
(CC, DD, GG, II, KK, OO, QQ ; visible au niveau du run quand aucun scénario n'est
exécuté), `QA_ERROR` **7** (CC, KK, LL, MM, NN, OO — **infrastructure**, jamais
imputée au produit), `TRANSITION_ON_INVARIANT` **5** (BA, DD, QQ, RR),
`RUN_BUDGET_EXCEEDED` **4** (FF, NN, TT — infrastructure), `PLAN_CHANGED_FILE_UNCOVERED`
**2** (OO, PP), et les familles à occurrence unique : `PLAN_STATE_TARGET_READ_AS_TEXT`
(KK), `PLAN_SELECTOR_UNSTABLE` (UU), `PLAN_SCHEMA_INVALID` (TT),
`COVERAGE_WITNESS_MISSING` (QQ), `HTTP_502` (OO).

Répartition par catégorie, **chaque run non vert compté une seule fois**
(80 runs non verts sur 200, règle de priorité dans `pr-qa-failure-taxonomy.md`) :
planification **27**, découverte de l'interface **26**, infrastructure **12**,
dépendance d'état **11**, **sans diagnostic 4** (aucun code enregistré — bucket
séparé, non fondu dans la planification).

Exemples tirés des artefacts (messages de diagnostic, non retapés à la main) : un
`MARKER_ORDER_UNREACHABLE` nomme la mesure et la borne — extrait du run `56ae5df7`
(lot CC) : « the last write in "justification.comment" holds 261 characters and the
limit that decides this value is 280 » ; un `TARGET_NOT_FOUND` nomme le libellé
attendu et l'échec de résolution — extrait du run `e56bb5ce` : attente sur
« Quantité · Pièce de 20 € » alors que le plan stocké écrit « Quantité · Billet de
20 € » ; un `REQUIREMENT_UNGROUNDED` nomme l'exigence et la citation
refusée — « No source witness for … » avec la citation rejetée entre guillemets.

## 2. La meilleure correction candidate et son hypothèse

**Candidate retenue** : donner au planificateur les preuves du diff (`controlLabels`,
`concreteTargets`, longueur exacte nommée dans le refus) et lui faire réécrire tout
défaut que le run sait nommer, avant acceptation du verdict.

**Hypothèse réfutable** : ce build atteint **≥ 80 %** de runs entièrement verts sur la
même PR, le même modèle et le même oracle ; réfutée par une paire entrelacée sous
80 %, ou par un taux inférieur à celui de la référence.

Hypothèses écartées après mesure : refus de contrat non fatal (5/10 contre 7/10 sur
le même build) ; réparation déterministe de cible proche seule (5/10 contre 7/10,
mais +19 scénarios verts).

## 3. Implémentation et tests

| PR | Apport | Tests |
| --- | --- | --- |
| #102 | le refus de longueur nomme la valeur exacte à écrire | `marker-order` |
| #106, #110 | libellés et cibles concrètes du diff dans le message | `policy` |
| #111 | une sonde de valeur d'avant qui échoue ne casse plus le scénario | `baseline-probe` |
| #115 | réparation déterministe d'un quasi-homonyme, jamais sur un nombre | `target-nearest` |
| #117 | la réécriture couvre tous les défauts de plan nommés | `replan` |

Suite : **850 tests verts, 5 ignorés** ; arcovia **90,10** ; conformité « aucune
connaissance de l'application testée » garantie par `no-application-knowledge`.

## 4. Résultats comparatifs, régressions comprises

| Périmètre | Runs | Verts | Scénarios verts/run | Échecs produit/run | Tokens/run |
| --- | --- | --- | --- | --- | --- |
| Référence `8143ac9` (JJ, NN, TT) | 30 | 17 (56.7 %) | 7.43 | 0.27 | 288456 |
| Autres builds de la lignée, hors BA/CC (dont KK 1/10, LL 1/10, OO 4/10, QQ 5/10) | 151 | 90 (59.6 %) | 7.79 | 0.05 | 323848 |
| Toute la lignée non-référence (BA→UU) | 170 | 103 (60.6 %) | 7.75 | 0.06 | 323154 |
| **Corpus entier** | 200 | 120 (60.0 %) | 7.70 | 0.09 | 317949 |
| **Build courant (SS + UU)** | 20 | 18 (90.0 %) | 9.05 | 0.05 | 288238 |

Le build courant couvre **deux commits** (`SS` = `c5b3634`, `UU` = `f8a6959`) dont la
source est identique ; ce ne sont pas les mêmes runs, et le document le dit au lieu de
parler d'un « même commit ». La paire fraîchement contrôlée est **TT 4/10 → UU 9/10**
(même jour, lots dos à dos) ; `SS` est un lot isolé et n'est pas présenté comme apparié.

Faux refus : mesurés sur les **79 plans historiques** rejoués à travers les deux
portes — 5 refus à la référence, 15 aujourd'hui, 10 nouvellement refusés dont **0**
visait un scénario vert, **0** plan refusé à la référence accepté depuis. Ils ne sont
pas mesurés sur la campagne : c'est une limite, pas un résultat.

Faux verts : comptés **par run** dans `campaign-runs.json` — build courant
**173/996** assertions (17.4 %) étaient déjà satisfaites avant leur
étape ; la référence porte ce champ **à 0**, indistinguable d'une absence de mesure : ses
996 assertions n'ont pas été instrumentées.
Conditions non tranchables publiées sur le build courant : **325**.

Durées : `campaign-runs.json` ne porte que `createdAt`, mais `pr-qa-measurements.md`
publie `startedAt`/`endedAt` pour les 79 runs du lot BA→II ; l'indicateur est donc
disponible pour ce sous-ensemble et absent pour les 121 autres — absence de collecte,
pas absence de mesure.

## 5. Recommandation

**Poursuivre**, avec ces réserves chiffrées : la référence est à 56.7 % sur 30 runs
et le build courant à 90.0 % sur 20 runs, à coût identique (288238 contre 288456
tokens par run) et avec 0.05 échec produit par run contre 0.27 ; mais la paire
réellement appariée est unique (TT/UU, 10 runs de chaque côté), `SS` est isolé, et la
variance observée plus tôt sur d'autres builds (OO 4/10) interdit de parler de
stabilisation. Si une campagne ultérieure repasse sous la référence, la conclusion
redeviendra « limite du modèle imposé » et devra être écrite de la même façon.

## Annexe — preuve par cause sur le corpus de 200 runs

Chaque cause retenue porte ses runs, les lots qui la produisent, trois identifiants de run
vérifiables, le mécanisme, la préventabilité avant exécution et le risque de faux refus.

| Cause | Runs | Lots | Identifiants (3 sur N) | Mécanisme | Préventable avant exécution | Risque de faux refus |
| --- | --- | --- | --- | --- | --- | --- |
| `TARGET_NOT_FOUND` | 27 | BA, DD, EE, FF, GG, JJ, KK, LL, NN, PP, QQ, RR | `b8818582`, `28525781`, `d07c4ed4` | le plan vise un libellé ou un sélecteur qui n'existe pas dans la vue observée ; l'échec est découvert à l'exécution, pas à la lecture du diff | oui — les libellés du diff et les libellés contrôles sont déjà dans la charge utile ; un plan qui n'en cite aucun est refusable à la lecture | un refus à la lecture remplacerait un échec d'exécution : le run ne serait plus « non vert » mais « refusé », donc ni mieux ni pire pour le critère ; le coût est un run non lancé sur un plan qui aurait peut-être réussi |
| `MARKER_ORDER_UNREACHABLE` | 23 | CC, DD, EE, FF, GG, II, KK, LL, MM, OO, PP, QQ, RR, SS | `b5711fb7`, `8a16f402`, `d07c4ed4` | le plan écrit un marqueur (longueur, valeur) dont l'état antérieur n'a pas été établi par une étape jouée avant lui | oui — la mesure et sa borne sont connues à la lecture ; l'ordre des étapes se vérifie sans navigateur | un refus à la lecture remplacerait un échec d'exécution : le run ne serait plus « non vert » mais « refusé », donc ni mieux ni pire pour le critère ; le coût est un run non lancé sur un plan qui aurait peut-être réussi |
| `TRANSITION_NOT_OBSERVED` | 9 | BA, DD, GG, JJ, NN, RR, TT | `f5ecbaac`, `160792a9`, `df72d1b7` | le plan attend un changement d'état que l'application n'effectue pas dans la séquence décrite ; l'attente est posée sans observation préalable | non, pas entièrement — dépend du comportement runtime de l'application | un refus à la lecture remplacerait un échec d'exécution : le run ne serait plus « non vert » mais « refusé », donc ni mieux ni pire pour le critère ; le coût est un run non lancé sur un plan qui aurait peut-être réussi |

### Chiffres figés de l'objectif

L'objectif fige 55 % (lignée `4b92c9a`), 60 % (baseline `8143ac9`) et +20 % de coût.
Les artefacts recalculés donnent 56,7 % (référence, 17/30), 60,6 % (lignée hors référence,
103/170) et une **parité** de coût (288 238 contre 288 456 tokens/run). Ces écarts ne sont pas
une renégociation : ce sont les mêmes runs, comptés depuis `campaign-runs.json` au lieu de la
synthèse antérieure. Le seul essai contrôlé nouveau est TT 4/10 (baseline) → UU 9/10 (courant).

### Limites des indicateurs

- faux verts : la référence porte le champ à **0** dans `campaign-runs.json` (l'absence de
  mesure est indistinguable d'un zéro) ; seuls les 996 assertions du build courant sont
  exploitables, dont 173 pré-satisfaites, et 325 conditions non tranchables ;
- durées : elles **existent** dans `pr-qa-measurements.md` (79 runs, `startedAt`/`endedAt`) et
  ne sont pas réexploitées ici ; la phrase antérieure « durées non stockées » était fausse ;
- `QA_ERROR` compte 7 runs sur 200 ici, et 6 dans la version précédente qui ignorait BA et CC.
