# Décision finale — fiabilité de `canary-pr-qa`

Document **généré depuis les artefacts** : `test/historical/campaign-runs.json`
(181 runs identifiés) et `test/historical/plans.json.gz` (79 plans). Aucun
chiffre de ce document n'est saisi à la main ; les agrégats sont recalculés par
`test/campaign-runs.test.ts`, qui échoue si un run, un compte, un scénario, un échec
ou un token diverge.

Références : baseline `8143ac9`, lignée figée `4b92c9a`.

## 1. Les trois causes les plus fréquentes (corpus complet, 181 runs)

Classement **par nombre de runs concernés** sur les artefacts stockés (un run peut
porter plusieurs codes ; le classement précédent, limité aux 79 plans BA→II, est
remplacé) :

| Rang | Famille | Runs | Catégorie | Préventable avant exécution ? | Risque de faux refus |
| --- | --- | --- | --- | --- | --- |
| 1 | `TARGET_NOT_FOUND` | 26 | découverte de l'interface | partielle : un libellé écrit par le diff est vérifiable, une cible rendue après interaction non | moyen → d'où la réparation plutôt que le refus |
| 2 | `MARKER_ORDER_UNREACHABLE` | 22 | planification | partielle : contradiction de longueur démontrable (#102), ordre des gardes non | faible : la mesure est arithmétique |
| 3 | `TRANSITION_NOT_OBSERVED` | 8 | dépendance d'état | non avant exécution : il faut constater l'invariance | nul |

Familles suivantes, toutes publiées : `REQUIREMENT_UNGROUNDED` 6 runs
(visible au niveau du run quand aucun scénario n'est exécuté), `QA_ERROR`
6 (**infrastructure**, jamais imputée au produit),
`TRANSITION_ON_INVARIANT` 4, `RUN_BUDGET_EXCEEDED`
4 (infrastructure), `PLAN_CHANGED_FILE_UNCOVERED`
2, et les familles à occurrence unique
(`PLAN_SCHEMA_INVALID`, `COVERAGE_WITNESS_MISSING`, `PLAN_SELECTOR_UNSTABLE`,
`HTTP_502`).

Répartition par catégorie, **chaque run non vert compté une seule fois**
(74 runs non verts sur 181) : planification **29**,
découverte de l'interface **25**, dépendance d'état **9**,
infrastructure **11**.

Exemples tirés des artefacts (messages de diagnostic, non retapés à la main) : un
`MARKER_ORDER_UNREACHABLE` nomme la mesure et la borne — « the last write in
"justification.comment" holds 251 characters and the limit that decides this value
is 280 » ; un `TARGET_NOT_FOUND` nomme le libellé attendu et l'échec de résolution —
« waiting for getByLabel('Quantité · Pièce de 20 €') » — alors que la page expose
« Billet de 20 € » ; un `REQUIREMENT_UNGROUNDED` nomme l'exigence et la citation
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
| Autres builds de la lignée (dont KK 1/10, LL 1/10, OO 4/10, QQ 5/10) | 131 | 72 (55.0 %) | 7.6 | 0.05 | 329285 |
| Toute la lignée non-référence | 151 | 90 (59.6 %) | — | — | — |
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
étape ; la référence ne porte pas ce champ (il n'existait pas), absence et non zéro.
Conditions non tranchables publiées sur le build courant : **325**.

Durées : les runs portent `createdAt` (181/181) et les artefacts portent
`startedAt`/`endedAt`, mais la durée par run **n'est pas stockée** dans
`campaign-runs.json` ; l'agrégat de durée n'est donc pas publié, plutôt que estimé.

## 5. Recommandation

**Poursuivre**, avec ces réserves chiffrées : la référence est à 56.7 % sur 30 runs
et le build courant à 90.0 % sur 20 runs, à coût identique (288238 contre 288456
tokens par run) et avec 0.05 échec produit par run contre 0.27 ; mais la paire
réellement appariée est unique (TT/UU, 10 runs de chaque côté), `SS` est isolé, et la
variance observée plus tôt sur d'autres builds (OO 4/10) interdit de parler de
stabilisation. Si une campagne ultérieure repasse sous la référence, la conclusion
redeviendra « limite du modèle imposé » et devra être écrite de la même façon.
