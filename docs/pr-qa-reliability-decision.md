# Décision finale — fiabilité de `canary-pr-qa`

Document **écrit à la main** à partir des artefacts, puis **vérifié** par la suite :
`test/historical/campaign-runs.json` (200 runs identifiés), `test/historical/plans.json.gz`
(79 plans), `test/historical/excerpts.json` (extraits de diagnostic tirés des rapports de
run). `test/campaign-runs.test.ts` recalcule chaque agrégat depuis les runs et refuse un
document dont une famille, une catégorie ou un taux cité diverge ; `test/historical-excerpts.test.ts`
refuse une citation qui n'est pas un fragment littéral du message du run qu'elle nomme.
Ce qui n'est **pas** vérifié mécaniquement est dit à l'endroit où cela compte. En
particulier, les extraits de `excerpts.json` ont été tirés des rapports de run le
2026-10-27 avec le jeton du service ; le point d'artefacts répond **401** sans jeton, donc un
relecteur ne peut pas les re-tirer lui-même. Ce qui est vérifiable depuis le dépôt : chaque
extrait nomme son run, ce run est dans un artefact versionné, il porte le code cité, et la
citation publiée est un fragment littéral du message stocké.

Le corpus couvre **les 200 runs identifiés** des lots BA→UU, y compris les 19 artefacts que
seul `plans.json.gz` portait (10 lot BA, 9 lot CC) : ils étaient absents du corpus de la
version précédente, et deux versions du document ont été refusées pour cette raison.

Deux limites de traçabilité sont écrites, pas comblées : le lot **`BB`** (build `7a6050b`,
10 runs, 7 verts, 92 scénarios, 5 378 250 tokens, mesuré et conservé dans
`pr-qa-architecture.md`) n'a **aucun identifiant de run** dans les artefacts versionnés et le
service ne le liste plus — il est donc absent de la taxonomie par famille, et non retiré ; et
70 des 200 runs portent le build `0000000`, donc aucune conclusion par build ne s'appuie sur
eux.

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
| `preventionMessages` dans `src/plan-evidence.ts`, `QA_PREVENT_MARKER_ORDER` (défaut posé) | le défaut d'ordre entre dans la correction du plan candidat | `marker-order` : défaut remonté, plan conforme silencieux, drapeau coupé silencieux et refus de lecture intact |
| #76, retiré | porte statique sur les cibles : mesurée 0 VP / 14 FP | — (décision de retrait conservée) |
| #102 | le refus de longueur nomme la valeur exacte à écrire | `marker-order` |
| #106, #110 | libellés et cibles concrètes du diff dans le message | `policy` |
| #111 | une sonde de valeur d'avant qui échoue ne casse plus le scénario | `baseline-probe` |
| #115 | réparation déterministe d'un quasi-homonyme, jamais sur un nombre | `target-nearest` |
| #117 | la réécriture couvre tous les défauts de plan nommés | `replan` |

Suite : **872 tests verts, 5 ignorés** ; arcovia **90,10** ; conformité « aucune connaissance
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

### Campagne contrôlée entrelacée (protocole de l'objectif)

Lots **alternés** baseline/courant sur le même service, la même PR, le même modèle et le même
oracle : **P1** (baseline) → **Q1** (courant) → **P2** (baseline) → **Q2** (courant), cinq runs
par lot, **dix runs par bras**, tous comptés (artefact
`test/historical/controlled-campaign.json`, recalculé par `test/controlled-campaign.test.ts`) :

| Bras | Build | Runs verts | Scénarios verts/run | Échecs produit/run | Faux refus | Faux verts (assertions) | Tokens/run | Durée |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline | `8143ac9` | **9/10 (90 %)** | 8.20 | 0.10 | 0 | 0/471 | 256746 | collectée |
| Courant | `e698deb` | **5/10 (50 %)** | 8.80 | 0.30 | 0 | 0/505 | 246981 | collectée |

**Le build courant fait moins bien que la référence sur le critère principal**, dans une
campagne où les deux bras alternent : −40 points, avec davantage de scénarios verts par run
(8.80 contre 8.20) et plus d'échecs produit (0.30 contre 0.10), pour un coût légèrement
inférieur. Les cinq échecs du bras courant sont `TRANSITION_NOT_OBSERVED` (3),
`TRANSITION_ON_INVARIANT` (1) et `TARGET_NOT_FOUND` (1) ; celui de la référence est
`TRANSITION_NOT_OBSERVED`. La famille dominante de cette campagne est donc l'assertion de
transition sur une valeur qui ne bouge pas — exactement celle que la prévention ne peut pas
traiter avant exécution.

Faux verts : aucun des 976 assertions des deux bras n'était pré-satisfaite, et aucune
précondition non tranchable n'a été enregistrée — l'indicateur est mesuré à zéro sur cette
campagne, pas supposé.

### Essai séquentiel antérieur (plus faible, conservé pour la trace)

**Essai contrôlé du 2026-10-27** (`test/historical/reliability-pair.json`), même service,
même PR, même modèle, même oracle, deux lots dos à dos :

| Lot | Build | Verts | Scénarios verts | Échecs produit | Tokens/run |
| --- | --- | --- | --- | --- | --- |
| X1 | `8143ac9` (référence) | 5/10 (50 %) | 80 | 2 | 209381 |
| Y1 | `e698deb` (courant) | 8/10 (80 %) | 80 | 2 | 303470 |

Cet essai est **séquentiel** (dix runs baseline puis dix runs courants) : il est plus faible
que la campagne entrelacée ci-dessus, et c'est la campagne qui tranche. Sur cette paire, le
critère progresse de **+30 points**, sans gain de scénarios ni d'échecs produit, mais à
**+45 % de tokens par run** : c'est une **régression de coût**
publiée comme telle, au-delà des +20 % que l'objectif figeait. Les cinq runs non verts de la
référence (`029a0221` `TRANSITION_ON_INVARIANT`, `17f5a321` `TARGET_NOT_FOUND`, `641d7df9`
`QA_ERROR`, `cb84e96d` et `defe8850` échecs produit) et les deux du build courant
(`d205419d` échec produit, `25013899` `COVERAGE_REQUIREMENT_SOURCE_MISSING`) sont dans
l'agrégat.

Appariement historique : la première paire dos à dos est **TT 4/10 → UU 9/10** ; `SS` est un
lot isolé du même code. Le build courant couvre donc deux commits de **source identique**
(`c5b3634`, `f8a6959`), et ce n'est pas présenté comme un essai unique.

## 5. Recommandation

**Changer d'approche**, et le dire avec les chiffres qui l'imposent.

La campagne entrelacée ne montre **aucune amélioration** : 9/10 pour la référence contre
5/10 pour le build courant, dans une alternance de lots qui départage les deux bras sur la
même PR, le même modèle et le même oracle. Les deux essais séquentiels antérieurs (5/10 → 8/10
sur le build courant, et 5/5 contre 4/5 pour le drapeau de prévention) ne suffisent donc pas
à établir un gain : ils ne sont pas entrelacés avec la référence, et la campagne qui l'est les
contredit.

Ce que l'objectif permet de conclure, sans le maquiller :

1. **la candidate de prévention est réfutée** (4/5 contre 5/5 à drapeau posé/coupé) et son
   coût est identifié : le refus de lecture bloque des runs dont tous les scénarios passent ;
2. **aucune modification testée dans ce tour n'améliore le critère principal** ; le corpus
   entier reste à 60,0 % et la lignée n'est pas distinguable de la référence dans une
   campagne contrôlée ;
3. **la famille dominante de la campagne est `TRANSITION_NOT_OBSERVED`** (3 des 5 échecs du
   bras courant) : le plan affirme un changement que la page n'exécute pas dans la séquence
   décrite. C'est un défaut qui ne se prévient pas à la lecture — il faut l'observation — et
   la sonde de navigation qui l'aurait fournie a été mesurée à +91 % de tokens sans gain
   (#94). La limite est donc dans ce que le modèle impose sait déduire du diff, pas dans une
   porte manquante ;
4. si une nouvelle campagne ne renverse pas ce résultat, la conclusion à écrire est celle que
   l'objectif prévoit explicitement : **limite du modèle imposé** sur ce dépôt, sans
   redéfinition du critère.

Le coût reste un indicateur de premier plan : parité sur `SS+UU` (288 238), +45 % sur la
paire séquentielle du jour, −4 % dans la campagne entrelacée (246 981 contre 256 746). Aucune
de ces trois mesures ne soutient l'hypothèse d'un gain à coût constant.

## Annexe — preuve par cause sur le corpus de 200 runs

| Cause | Runs | Lots | Identifiants | Mécanisme | Préventable | Risque de faux refus |
| --- | --- | --- | --- | --- | --- | --- |
| `TARGET_NOT_FOUND` | 27 | BA, DD, EE, FF, GG, JJ, KK, LL, NN, PP, QQ, RR | `e90c9e75`, `b8818582`, `28525781` | le plan vise un libellé absent de la vue observée ; l'échec se découvre à l'exécution | non (porte statique refutée, #76) | refuser à la lecture coûterait des plans qui auraient réussi : la réparation à l'exécution a été préférée |
| `MARKER_ORDER_UNREACHABLE` | 23 | CC, DD, EE, FF, GG, II, KK, LL, MM, OO, PP, QQ, RR, SS | `277dee09`, `56ae5df7`, `d07c4ed4` | le plan écrit un marqueur dont l'état antérieur n'est pas établi par une étape jouée avant lui | oui — mesure, borne et contrôle amont sont dans le diff | **mesuré négatif** : un plan non corrigé est bloqué par le refus de lecture alors que ses dix scénarios passent (run `c98274a3`) — le refus est donc fatal au niveau du run, et c'est ce coût qui a fait réfuter la candidate |
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

- **55 % lignée `4b92c9a`** : deux dérivations, publiées ensemble pour qu'aucune ne passe
  pour « la » reproduction — **72/131 = 55.0 %** sur le sous-ensemble non-baseline et
  non-courant avant repli des lots BA et CC, et **85/150 = 56.7 %** sur la lignée complète
  (phase `lineage` d'`interleaved.json`, BA et CC compris). L'écart entre les deux est
  exactement les 14 runs verts que les deux lots repliés ajoutent.
- **60 % baseline `8143ac9`** : ne se reproduit sur aucun agrégat de la référence, qui donne
  17/30 = **56.7 %**. Le seul agrégat à 60.0 % est le corpus entier (120/200). L'écart est
  déclaré, pas absorbé : la valeur figée reste la référence de l'objectif, et seul un essai
  contrôlé pourrait la corriger.
- **+20 % de coût** : la lignée hors référence est à 323 154 tokens/run contre 288 456, soit
  **+12.0 %** ; le build mesuré `SS+UU` est à **parité** (288 238), mais l'essai frais du
  2026-10-27 est à **+45.0 %** (303 470 contre 209 381). Le +20 % provient d'une synthèse
  antérieure portant sur un corpus plus étroit (294 504 contre 244 860) ; il n'est pas
  reproduit par les 200 runs, et il est **dépassé** par la paire du jour — c'est la paire
  du jour qui doit guider la suite, pas la parité historique.

### Limites des indicateurs

- faux verts : comptés par run dans `campaign-runs.json` — build courant **173/996**
  assertions (17.4 %) déjà satisfaites avant leur étape ; conditions non tranchables **325**.
  La référence porte le champ **à 0** : ses assertions n'ont pas été instrumentées, donc son
  zéro est une absence de mesure et non une mesure ;
- faux refus, deux mesures distinctes : sur la **campagne entrelacée**, zéro run bloqué dont
  tous les scénarios passent (compté par run dans `controlled-campaign.json`) ; sur les
  **79 plans historiques** rejoués contre les deux portes, 5 refus à la référence, 15
  aujourd'hui, 10 nouvellement refusés, **0** visant un scénario qui était vert et **0** plan
  refusé à la référence puis accepté aujourd'hui. Le cas `c98274a3` (dix scénarios verts, run
  bloqué) reste le contre-exemple le plus net du coût d'un refus fatal au niveau du run ;
- durées : collectées pour les **20 runs de la campagne entrelacée** (`startedAt`/`endedAt`
  dans `controlled-campaign.json`) et pour les 79 runs BA→II dans `pr-qa-measurements.md` ;
  `campaign-runs.json`, lui, ne porte que `createdAt` — absence de collecte sur les 121 runs
  restants, pas absence de mesure.
