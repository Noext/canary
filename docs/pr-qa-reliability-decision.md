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
extrait nomme son run, ce run est dans un artefact versionné, il porte le code cité, la
citation publiée est un fragment littéral du message stocké, et l'empreinte `messageSha256`
permet de recalculer ce message à partir du JSON committé.

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

| Rang | Famille | Runs | Scénarios | Preuve (run) | Prévenir avant exécution ? | Coût / risque de faux refus |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `TARGET_NOT_FOUND` | **27** | 6 | `e90c9e75` (RR) : `getByLabel('Quantité · Pièce de 20 €', { exact: true })` | non, mesuré : une porte statique sur les cibles du diff a été essayée et donnait 0 vrai positif pour 14 faux positifs (#76), retirée | la réparation à l'exécution (#111, #115) a été préférée au refus, qui aurait bloqué des plans viables |
| 2 | `MARKER_ORDER_UNREACHABLE` | **23** | 9 | `277dee09` (SS) : `the last write in "justification.comment" holds` … `the limit that decides this value is 280` | **oui** : le défaut est lisible dans le diff et dicible au planificateur pendant qu'il écrit le plan | un tour de correction par plan fautif ; et un refus de lecture reste fatal au run quand la correction échoue (`c98274a3`, dix scénarios verts, run bloqué) |
| 3 | `TRANSITION_NOT_OBSERVED` | **9** | 3 | `f6a6a890` (TT) : `no change observed — the value after step` … `is identical to the baseline probed before it` | non : il faut constater l'invariance à l'exécution | réécriture après observation (#101), sous budget ; la sonde qui l'aurait fournie coûtait +91 % de tokens sans gain (#94) |

La colonne « Scénarios » compte les **plans stockés** (lots BA→II, où le diagnostic par
scénario est enregistré). Comme criterion 1 demande tous les artefacts, une seconde mesure est
publiée à partir des **rapports encore joignables** — 104 des 200 runs, 863 scénarios dont 60
non verts (`test/historical/report-scenarios.json`, compté par code) : `TARGET_NOT_FOUND` **28**,
`MARKER_ORDER_UNREACHABLE` **13**, `TRANSITION_NOT_OBSERVED` **4**, `sans-diagnostic` 7,
`QA_ERROR` 2, `TRANSITION_ON_INVARIANT` 2, `REQUIREMENT_UNGROUNDED` 2, puis
`PLAN_STATE_TARGET_READ_AS_TEXT` et `PLAN_SELECTOR_UNSTABLE` 1 chacun. Les deux mesures
concordent sur le classement des deux premières familles ; elles ne couvrent pas le même
sous-ensemble (79 plans d'un côté, 104 rapports de l'autre), et c'est dit plutôt que fusionné.

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

**Verdict mesuré : hypothèse non soutenue, et l'échantillon ne permet pas de la réfuter.** Les deux bras du même build
`e698deb` (drapeau coupé puis posé, déploiements `qqvncqlid2stp8hzcjjaor5u` et
`dqovvc2yui0zorxey7d54rxz`, consignés dans `test/historical/prevention-trial.json`) donnent
**5/5** verts sans prévention contre **4/5** avec. Le mécanisme du coût est dans l'artefact :
le run `c98274a3` a ses **dix scénarios verts** et il est malgré tout **bloqué**, parce que la
correction du plan n'a pas suffi et que le refus de lecture a transformé un run qui aurait été
vert en run bloqué. À cinq runs par bras, cet écart n'est pas significatif et ne réfute rien : il constate
seulement qu'aucun gain n'apparaît. Ce qui est en revanche mesuré et reproductible, c'est le
mécanisme de coût : quand la correction échoue, le refus de lecture bloque un run dont tous
les scénarios passent. Le drapeau reste donc **posé par défaut** — le build mesuré dans la
campagne est celui qui le porte, et le couper serait un changement non mesuré — mais il est
signalé ici comme non démontré.

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

Suite : **878 tests verts, 5 ignorés** ; arcovia **90,10** ; conformité « aucune connaissance
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

Lots **alternés** courant/référence sur le même service, la même PR, le même modèle et le même
oracle : **R1** (courant) → **S1** (référence) → **R2** (courant) → **S2** (référence), cinq
runs par lot, **dix runs par bras**, tous comptés (artefact
`test/historical/controlled-campaign.json`, recalculé par `test/controlled-campaign.test.ts`).
Chaque bloc porte le **déploiement Coolify** et le **commit** qu'il a réellement servis, et la
somme `preMatchedKeyed` atteste du bras : le build courant écrit ce champ, la référence
`8143ac9` ne le connaît pas.

| Bras | Commit / déploiements | Runs verts | Scénarios verts/run | Échecs produit/run | Faux refus | Faux verts (assertions) | Tokens/run (± erreur-type) | Durée/run (± erreur-type) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Courant | `6c5a746` · `iy50rnncpjv9ubs6ctcm38ex`, `4gft7uaxnryit4vwjttwwobv` | **10/10** | 8.80 | 0.00 | **0** | **73/465** (15,7 %) | **245 966 ± 35 066** | **492,6 s ± 43** |
| Référence | `8143ac9` · `huw33mbfxh4606d0nvzwinvg`, `o6fkx53hslpx0ezqyhak0hn3` | **8/10** | 8.10 | 0.30 | **0** | non instrumentée (0 clé `preMatched`) | **265 128 ± 21 525** | **427,9 s ± 25** |

Lecture honnête, avec l'incertitude de chaque indicateur : **deux runs d'écart sur dix par
bras**, ce qui ne départage pas les deux builds ; l'écart de tokens est de **−19 162 ± 41 140**
(erreur-type de la différence), donc indistinguable de zéro ; l'écart de durée est de
**+64,7 s ± 50** (+15,1 %), indistinguable de zéro lui aussi, et publié parce qu'il est
défavorable. Aucun de ces trois écarts n'est présenté comme une amélioration.

Faux refus, définition et examen : un **refus de lecture** est un scénario arrêté avant la
première étape (`steps` vide) avec un code. Sur les 20 runs de la campagne, il y en a **zéro**
dans les deux bras. Les deux runs non verts de la référence sont des **échecs d'exécution**, pas
des refus : `a5c8eb3f` échoue sur `TARGET_NOT_FOUND` (attente de
`span[aria-live="polite"]` expirée) et `32d79c30` sur `TRANSITION_NOT_OBSERVED`
(`no change observed — the value after step s6-fill280 is identical to the baseline probed
before it`). Le seul refus de lecture mesuré dans un artefact de ce tour est `c98274a3` (essai
de prévention), et il est **faux au sens de la tâche 7** : le run est bloqué alors que ses dix
scénarios exécutés passent tous.

**Tentative précédente, retirée et conservée** (`campaign-attempt-1-invalid.json`) : ses deux
déploiements « courant » ont échoué (`w6rceollsm27vvswqr6lsbhb`, `lzmfsrieb0f6r2knwqa7yidh`,
statut `failed`, commit `HEAD`), donc les lots Q1 et Q2 ont servi la référence. La preuve est
dans les runs : aucune de leurs assertions ne porte de clé `preMatched`, alors que le build
courant en écrit 73 sur dix runs. Les 9/10 contre 5/10 publiés un moment opposaient le même
build à lui-même : ils mesuraient la variance, pas un effet, et ils sont retirés comme preuve.

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

**Conclure sur ce que la mesure démontre : aucune modification testée n'améliore le critère
principal dans ce périmètre.** C'est le constat que l'objectif autorise explicitement, et il
n'est pas une dérobade : il est chiffré.

| Comparaison | Effet mesuré sur les runs verts | Erreur-type de la différence | Verdict |
| --- | --- | --- | --- |
| Campagne entrelacée, courant `6c5a746` contre référence `8143ac9` (10 runs/bras) | +2 runs (+20 pts) | ±1,3 run (12,6 pts) | 1,6 σ — indistinguable de zéro |
| Essai du candidat, drapeau posé contre coupé, même build (5 runs/bras) | −1 run (−20 pts) | ±0,9 run (17,9 pts) | 1,1 σ — indistinguable de zéro |
| Corpus historique, build courant `SS+UU` (18/20) contre référence (17/30) | +33,3 pts | ±11,3 pts | 3,0 σ — **significatif hors contrôle** |

L'écart historique est donc réel **en tant qu'observation**, et il ne se réplique pas dans la
campagne alternée : 3,0 σ hors contrôle, 1,6 σ sous contrôle. Un effet qui ne se réplique pas
quand les lots alternent n'est pas une amélioration démontrée — c'est le constat à écrire, et
c'est précisément pour cela que l'objectif exigeait la campagne contrôlée.

Ce que la campagne permet donc d'affirmer, sans emphase : le build courant **n'est pas pire**
que la référence sur ce lot — il n'a ni échec produit (0 contre 3) ni refus de lecture (0 de
chaque côté), il écrit 15,7 % d'assertions pré-satisfaites que la référence ne mesure pas, et
il coûte −7 % de tokens pour +15 % de durée, deux écarts non séparables. Rien de cela ne
constitue une amélioration démontrée.

Trois faits restent établis, chacun avec sa preuve :

1. la **candidate de prévention** ne montre aucun gain à cinq runs par bras, et son **coût** est
   démontré : un refus de lecture bloque un run dont les dix scénarios passent (`c98274a3`) ;
2. la **première campagne** (9/10 contre 5/10) était invalide — deux déploiements échoués
   laissaient la référence des deux côtés, et l'absence de clé `preMatched` dans ces runs le
   prouve ; elle est conservée à part, retirée comme preuve ;
3. la famille dominante du corpus, `TRANSITION_NOT_OBSERVED`, apparaît dans les deux bras de la
   campagne : elle ne se prévient pas à la lecture, et la sonde d'observation coûtait +91 % de
   tokens sans gain (#94).

Recommandation finale : **changer d'approche** — ne plus chercher un gain par une porte
supplémentaire (les deux portes essayées ont été réfutées ou non démontrées), et attaquer
`TRANSITION_NOT_OBSERVED` par l'observation ciblée en traitant le coût en tokens comme un
résultat de premier rang. Si cette approche ne départage pas non plus les bras, la conclusion à
écrire reste, sans redéfinition du critère, la **limite du modèle imposé** sur ce dépôt.

## Annexe — preuve par cause sur le corpus de 200 runs

| Cause | Runs | Lots | Identifiants | Mécanisme | Préventable | Risque de faux refus |
| --- | --- | --- | --- | --- | --- | --- |
| `TARGET_NOT_FOUND` | 27 | BA, DD, EE, FF, GG, JJ, KK, LL, NN, PP, QQ, RR | `e90c9e75`, `b8818582`, `28525781` | le plan vise un libellé absent de la vue observée ; l'échec se découvre à l'exécution | non (porte statique refutée, #76) | refuser à la lecture coûterait des plans qui auraient réussi : la réparation à l'exécution a été préférée |
| `MARKER_ORDER_UNREACHABLE` | 23 | CC, DD, EE, FF, GG, II, KK, LL, MM, OO, PP, QQ, RR, SS | `277dee09`, `56ae5df7`, `d07c4ed4` | le plan écrit un marqueur dont l'état antérieur n'est pas établi par une étape jouée avant lui | oui — mesure, borne et contrôle amont sont dans le diff | **mesuré négatif** : un plan non corrigé est bloqué par le refus de lecture alors que ses dix scénarios passent (run `c98274a3`) — le refus est donc fatal au niveau du run ; c'est ce coût qui explique qu'aucun gain n'apparaisse (5/5 contre 4/5, non concluant à n = 5) |
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
  exactement les 13 runs verts que les deux lots repliés ajoutent (85 − 72).
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

- faux verts, trois mesures distinctes : **campagne entrelacée** — 73/465 assertions (15.7 %)
  pré-satisfaites sur le bras courant, et **aucune clé `preMatched`** sur le bras référence,
  dont le zéro est une absence d'instrumentation et jamais une mesure — la référence
  `8143ac9` est antérieure au commit `641e6df` qui a introduit le champ, ce que `git merge-base
  --is-ancestor 641e6df 8143ac9` tranche sans ambiguïté, et le fichier ne compte que les clés
  présentes ; **corpus historique** —
  173/996 (17.4 %) sur le build courant, 325 conditions non tranchables ; **paire séquentielle**
  — 0/976, ce qui s'explique par des plans sans assertion ancrée sur une interaction, pas par
  un zéro « mesuré » ;
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
