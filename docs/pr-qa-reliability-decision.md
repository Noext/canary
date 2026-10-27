# Décision finale — fiabilité de `canary-pr-qa`

Document **écrit à la main** à partir des artefacts, puis **vérifié** par la suite :
`test/historical/campaign-runs.json` (200 runs identifiés), `test/historical/plans.json.gz`
(79 plans), `test/historical/excerpts.json` (extraits de diagnostic tirés des rapports de
run). `test/campaign-runs.test.ts` recalcule chaque agrégat depuis les runs et refuse un
document dont une famille, une catégorie ou un taux cité diverge ; `test/historical-excerpts.test.ts`
refuse une citation qui n'est pas un fragment littéral du message du run qu'elle nomme.
Ce qui n'est **pas** vérifié mécaniquement est dit à l'endroit où cela compte.

Le corpus couvre **les 200 runs** des lots BA→UU, y compris les 19 artefacts que seul
`plans.json.gz` portait (10 lot BA, 9 lot CC) : ils étaient absents du corpus de la version
précédente, et deux versions du document ont été refusées pour cette raison.

Références figées par l'objectif : lignée `4b92c9a` à 55 %, baseline `8143ac9` à 60 %,
coût +20 %.

## 1. Les trois causes les plus fréquentes (200 runs, 79 plans)

| Rang | Famille | Runs | Scénarios | Preuve (run) | Prévenir avant exécution ? | Coût d'une correction |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `TARGET_NOT_FOUND` **27** | 6 | `e90c9e75` (RR) : `getByLabel('Quantité · Pièce de 20 €', { exact: true })` | non, mesuré : une porte statique sur les cibles du diff a été essayée et donnait 0 vrai positif pour 14 faux positifs (#76), retirée | réparation à l'exécution (#111, #115) plutôt que refus |
| 2 | `MARKER_ORDER_UNREACHABLE` **23** | 9 | `277dee09` (SS) : `the last write in "justification.comment" holds` … `the limit that decides this value is 280` | **oui** : le défaut est lisible dans le diff et dicible au planificateur pendant qu'il écrit le plan | un tour de correction supplémentaire par plan fautif, aucun refus supplémentaire |
| 3 | `TRANSITION_NOT_OBSERVED` **9** | 3 | `f6a6a890` (TT) : `no change observed — the value after step` … `is identical to the baseline probed before it` | non : il faut constater l'invariance à l'exécution | réécriture après observation (#101), sous budget |

Familles suivantes, toutes publiées, jamais écartées : `REQUIREMENT_UNGROUNDED` **7** runs
(`a2e88c67`, QQ : `Weak source witness for` … `Rejected quote`), `QA_ERROR` **7**
(infrastructure : CC, KK, LL, MM, NN, OO), `TRANSITION_ON_INVARIANT` **5** (`e90c9e75`, RR :
`the plan requires a change on a value that does not change`), `RUN_BUDGET_EXCEEDED` **4**
(FF, NN, TT — infrastructure), `PLAN_CHANGED_FILE_UNCOVERED` **2**, singletons
`PLAN_STATE_TARGET_READ_AS_TEXT`, `PLAN_SELECTOR_UNSTABLE`, `PLAN_SCHEMA_INVALID`,
`COVERAGE_WITNESS_MISSING`, `HTTP_502`, et **4 runs sans code de plan mais avec un échec
produit** (`be9084c6`, `9a7b18e7`, `c9c68ce9`, `2417c8b5`, chacun `productFailures: 1`) :
l'artefact enregistre la classe de l'échec (assertion produit rouge) sans que le plan porte
un code, donc la famille est nommée ici comme *échec d'assertion produit sans code de plan*
plutôt que fondue dans une autre.

Répartition par catégorie, **chaque run non vert compté une seule fois** (80 non verts) :

- planification **27** ;
- découverte de l'interface **26** ;
- infrastructure **12** ;
- dépendance d'état **11** ;
- sans diagnostic **4** — règle de priorité écrite dans `pr-qa-failure-taxonomy.md`.

La colonne scénarios est un **plancher** : seuls les lots BA→II stockent le diagnostic par
scénario ; JJ→UU ne portent que des comptes de scénarios verts par run.

## 2. La meilleure correction candidate et son hypothèse

**Candidate retenue : prévenir la production du plan fautif** — le défaut d'ordre de
marqueur (cause n° 2, 23 runs) entre dans la correction du plan candidat, au lieu de n'être
refusé qu'à l'exécution. Le planificateur reçoit la mesure exacte, la borne et le contrôle à
jouer d'abord ; le plan réécrit est celui qui s'exécute. Le refus de lecture reste le filet.

**Hypothèse réfutable** : à drapeau coupé contre drapeau posé, sur la même PR, le même
modèle et le même oracle, le taux de runs entièrement verts progresse d'au moins **10
points**, sans augmenter les faux refus (plans refusés à la lecture). Réfutée par une
progression inférieure à 10 points, par une baisse, ou par une hausse des faux refus.

**Verdict mesuré : hypothèse réfutée sur cet échantillon.** Les deux bras du même build
`e698deb` (drapeau coupé puis posé, déploiements `qqvncqlid2stp8hzcjjaor5u` et
`dqovvc2yui0zorxey7d54rxz`, consignés dans `test/historical/prevention-trial.json`) donnent
**5/5** verts sans prévention contre **4/5** avec. Le mécanisme du coût est dans l'artefact :
le run `c98274a3` a ses **dix scénarios verts** et il est malgré tout **bloqué**, parce que la
correction du plan n'a pas suffi et que le refus de lecture a transformé un run qui aurait été
vert en run bloqué. La prévention ne s'est donc pas payée ici, et le filet de sécurité coûte
plus qu'il ne rapporte quand le modèle rate la correction.

Candidates écartées par la mesure, pas par préférence : porte statique sur les cibles du diff
(0 vrai positif / 14 faux positifs, #76) ; politique de couverture par scénario (5/10 contre
7/10, 10 runs bloqués, #114) ; sonde de navigation (+91 % de tokens, aucun gain, #94) ;
fichiers entiers dans la charge utile (plus cher et moins bon, #107).

## 3. Implémentation et tests

| Changement | Apport | Tests |
| --- | --- | --- |
| `src/plan-prevention.ts`, `QA_PREVENT_MARKER_ORDER` (défaut posé) | le défaut d'ordre entre dans la correction du plan candidat | `marker-order` : défaut remonté, plan conforme silencieux, drapeau coupé silencieux et refus de lecture intact |
| #76, retiré | porte statique sur les cibles : mesurée 0 VP / 14 FP | — (décision de retrait conservée) |
| #102 | le refus de longueur nomme la valeur exacte à écrire | `marker-order` |
| #106, #110 | libellés et cibles concrètes du diff dans le message | `policy` |
| #111 | une sonde de valeur d'avant qui échoue ne casse plus le scénario | `baseline-probe` |
| #115 | réparation déterministe d'un quasi-homonyme, jamais sur un nombre | `target-nearest` |
| #117 | la réécriture couvre tous les défauts de plan nommés | `replan` |

Suite : **861 tests verts, 5 ignorés** ; arcovia **90,10** ; conformité « aucune connaissance
de l'application testée » garantie par `no-application-knowledge`.

## 4. Résultats comparatifs, régressions comprises

| Périmètre | Runs | Verts | Scénarios verts/run | Échecs produit/run | Tokens/run |
| --- | --- | --- | --- | --- | --- |
| Référence `8143ac9` (JJ, NN, TT) | 30 | 17 (56.7 %) | 7.43 | 0.27 | 288456 |
| Lignée historique hors référence (BA→UU moins JJ/NN/TT) | 170 | 103 (60.6 %) | 7.75 | 0.06 | 323154 |
| **Build courant mesuré (SS + UU)** | 20 | 18 (90.0 %) | 9.05 | 0.05 | 288238 |
| **Corpus entier** | 200 | 120 (60.0 %) | 7.70 | 0.09 | 317949 |

Protocole : service unique (`canary.pharmania.fr`), PR unique
(`pharmania/arpilabe-pilotage#20`), modèle unique (`opencode-go/deepseek-v4.1-flash`),
oracle inchangé, lots alternés entre la branche de référence `baseline-8143ac9` et la branche
courante par bascule de `git_branch` sur le même service. **Aucun lot n'est retiré** : les
lots défavorables (KK 1/10, LL 1/10, OO 4/10, QQ 5/10, RR 5/10) sont dans les agrégats.

Régression écrite : le build `922159d` (lot KK) tombe à 1/10 — le nettoyage des
connaissances applicatives a cassé la spécificité du prompt ; il est dans le corpus et dans
les 60,6 %.

**Essai contrôlé du 2026-10-27** (`test/historical/reliability-pair.json`), même service,
même PR, même modèle, même oracle, deux lots dos à dos :

| Lot | Build | Verts | Scénarios verts | Échecs produit | Tokens/run |
| --- | --- | --- | --- | --- | --- |
| X1 | `8143ac9` (référence) | 5/10 (50 %) | 80 | 2 | 209381 |
| Y1 | `e698deb` (courant) | 8/10 (80 %) | 80 | 2 | 303470 |

Le critère principal progresse de **+30 points** sur cette paire, sans gain de scénarios ni
d'échecs produit, mais à **+45 % de tokens par run** : c'est une **régression de coût**
publiée comme telle, au-delà des +20 % que l'objectif figeait. Les cinq runs non verts de la
référence (`029a0221` `TRANSITION_ON_INVARIANT`, `17f5a321` `TARGET_NOT_FOUND`, `641d7df9`
`QA_ERROR`, `cb84e96d` et `defe8850` échecs produit) et les deux du build courant
(`d205419d` échec produit, `25013899` `COVERAGE_REQUIREMENT_SOURCE_MISSING`) sont dans
l'agrégat.

Appariement historique : la première paire dos à dos est **TT 4/10 → UU 9/10** ; `SS` est un
lot isolé du même code. Le build courant couvre donc deux commits de **source identique**
(`c5b3634`, `f8a6959`), et ce n'est pas présenté comme un essai unique.

## 5. Recommandation

**Poursuivre**, avec les réserves qui suivent. La direction est mesurée : 56,7 % sur la
référence (17/30), 90 % sur le build courant (18/20), à coût par run identique (288 238
contre 288 456) et avec 0,05 échec produit par run contre 0,27. Aucune stabilisation n'est
annoncée : la variance mesurée (KK 1/10, LL 1/10, OO 4/10) l'interdit, et le corpus entier
reste à 60,0 % parce qu'il contient les régressions.

La campagne de prévention **ne démontre pas** les 10 points annoncés : sur deux bras du même
build, le drapeau posé donne 4/5 contre 5/5, et un run aux dix scénarios verts est bloqué par
le refus de lecture. La conclusion à écrire est donc double, et aucune des deux n'est une
redéfinition du critère :

1. **le critère principal progresse** sur l'essai contrôlé du jour (5/10 → 8/10), porté par les
   corrections antérieures (#102, #106, #110, #111, #115, #117), **pas** par la prévention ;
2. **aucune modification testée dans ce tour n'améliore le critère au-delà de l'existant** :
   la prévention du défaut d'ordre est réfutée à n = 5 par bras, et elle a un coût mesuré — le
   refus de lecture bloque des runs dont tous les scénarios passent. Le prochain changement
   justifiable n'est donc pas d'ajouter une correction, mais de rendre ce refus non fatal au
   niveau du run, ce qui reste à mesurer et n'est pas revendiqué ici.

Le coût par run doit être suivi : +45 % sur la paire du jour contre la référence, à gains de
scénarios nuls.

## Annexe — preuve par cause sur le corpus de 200 runs

| Cause | Runs | Lots | Identifiants | Mécanisme | Préventable | Risque de faux refus |
| --- | --- | --- | --- | --- | --- | --- |
| `TARGET_NOT_FOUND` | 27 | BA, DD, EE, FF, GG, JJ, KK, LL, NN, PP, QQ, RR | `e90c9e75`, `b8818582`, `28525781` | le plan vise un libellé absent de la vue observée ; l'échec se découvre à l'exécution | non (porte statique refutée, #76) | refuser à la lecture coûterait des plans qui auraient réussi : la réparation à l'exécution a été préférée |
| `MARKER_ORDER_UNREACHABLE` | 23 | CC, DD, EE, FF, GG, II, KK, LL, MM, OO, PP, QQ, RR, SS | `277dee09`, `56ae5df7`, `d07c4ed4` | le plan écrit un marqueur dont l'état antérieur n'est pas établi par une étape jouée avant lui | oui — mesure, borne et contrôle amont sont dans le diff | aucun refus ajouté : la correction remplace le refus, et le refus de lecture reste pour le plan non corrigé |
| `TRANSITION_NOT_OBSERVED` | 9 | BA, DD, GG, JJ, NN, RR, TT | `f6a6a890`, `160792a9`, `df72d1b7` | le plan attend un changement que l'application n'effectue pas dans la séquence décrite | non : il faut constater l'invariance | nul (réécriture après observation, budgétée) |

| `REQUIREMENT_UNGROUNDED` | 7 | CC, DD, GG, II, KK, OO, QQ | `bc0e083e`, `0da1a10e` | l'exigence citée ne se retrouve pas dans le fichier qu'elle déclare (citation faible ou recousue) | oui à la lecture, mesuré : la porte refuse le plan avant exécution | refus au niveau du scénario quand aucun scénario n'est exécuté ; c'est la porte la plus coûteuse en faux refus mesurés (10 plans nouvellement refusés sur 79, 0 visant un scénario vert) |
| `QA_ERROR` | 7 | CC, KK, LL, MM, NN, OO | `97ec3d9d`, `9fd1e99e` | infrastructure : worker arrêté, service indisponible, quota | non — hors du périmètre du plan | aucun : ce n'est pas un défaut produit, et le corpus ne le compte pas comme tel |
| `TRANSITION_ON_INVARIANT` | 5 | BA, DD, QQ, RR | `bed1253d`, `e29f3f7a` | le plan demande un changement sur une valeur invariante par construction | oui à la lecture (transition sur valeur statique), mais la mesure dépend de la page | reclassement en `blocked`, jamais en `passed` (#77) |
| `RUN_BUDGET_EXCEEDED` | 4 | FF, NN, TT | `d5151bca`, `a4387f43` | le budget de tokens ou de temps du run est épuisé par les tours de correction | non — c'est une borne, pas un défaut | nul ; la borne n'est jamais relevée pour masquer une inefficacité |
| `PLAN_CHANGED_FILE_UNCOVERED` | 2 | OO, PP | `01dc01ab` | un fichier changé n'est couvert par aucun scénario | oui à la lecture | refus au niveau du plan : c'est le cas où un refus remplace un run vide |

Les identifiants cités sont dans `campaign-runs.json` et portent le code qu'ils illustrent ;
`test/historical-excerpts.test.ts` le vérifie, et vérifie que la citation publiée est un
fragment littéral du message du run.

### Chiffres figés de l'objectif

- **55 % lignée `4b92c9a`** : reproduit à l'identique par 72/131 = **55.0 %** (non-baseline,
  non-courant, avant repli des lots BA et CC). Avec ces deux lots, la même lignée donne
  86/150 = 57.3 %.
- **60 % baseline `8143ac9`** : ne se reproduit sur aucun agrégat de la référence, qui donne
  17/30 = **56.7 %**. Le seul agrégat à 60.0 % est le corpus entier (120/200). L'écart est
  déclaré, pas absorbé : la valeur figée reste la référence de l'objectif, et seul un essai
  contrôlé pourrait la corriger.
- **+20 % de coût** : la lignée hors référence est à 323 154 tokens/run contre 288 456, soit
  **+12.0 %** ; le build courant est à parité (288 238). Le +20 % provient d'une synthèse
  antérieure portant sur un corpus plus étroit (294 504 contre 244 860) ; il n'est pas
  reproduit par les 200 runs.

### Limites des indicateurs

- faux verts : comptés par run dans `campaign-runs.json` — build courant **173/996**
  assertions (17.4 %) déjà satisfaites avant leur étape ; conditions non tranchables **325**.
  La référence porte le champ **à 0** : ses assertions n'ont pas été instrumentées, donc son
  zéro est une absence de mesure et non une mesure ;
- faux refus : mesurés sur les **79 plans historiques** rejoués contre les deux portes (5
  refus à la référence, 15 aujourd'hui, 10 nouvellement refusés, **0** visant un scénario qui
  était vert, **0** plan refusé à la référence et accepté aujourd'hui) — mesure reproductible,
  mais sur les plans, pas sur la campagne ;
- durées : `campaign-runs.json` ne porte que `createdAt` ; `pr-qa-measurements.md` publie
  `startedAt`/`endedAt` pour les 79 runs BA→II. L'indicateur est disponible pour ce
  sous-ensemble et absent pour les 121 autres — absence de collecte, pas absence de mesure.
