# Architecture cible de `canary-pr-qa` — décision écrite avant le code

Ce document fixe l'architecture retenue, ce qu'elle empêche **par construction**, les invariants
que le moteur doit garantir, et l'hypothèse réfutable qui sera mesurée. Il est écrit avant toute
implémentation : la campagne finale (tâche 7) ne pourra pas redéfinir ces critères.

Cause racine établie (voir [`pr-qa-root-cause.md`](pr-qa-root-cause.md)) : le plan est un
**contrat figé** écrit sur un instantané unique, joué sans consulter l'observation. 64 des 80 runs
non verts (80 %) sont une hypothèse de plan contredite par l'observation.

## 1. Ce que l'architecture doit empêcher — et par quel mécanisme

Le brief impose six préventions. Une prévention tenue par une règle est une prévention qui peut
être contournée par un plan ; l'architecture retenue doit les tenir **par le moteur**.

| Ce qui doit être impossible | Mécanisme (pas une règle de plan) |
| --- | --- |
| Cible DOM inventée | l'exécuteur ne choisit une cible que **dans l'instantané courant** de la page ; une intention sans cible observée n'est pas jouable |
| Transition annoncée sans changement | une assertion de transition n'est validée que si la valeur observée **diffère** de la valeur capturée juste avant l'action, dans la même session |
| Précondition absente ou héritée d'un autre scénario | chaque scénario démarre sur une session neuve **et** doit établir ses préconditions par des étapes observées, consignées avant l'assertion |
| Valeur attendue incohérente avec l'observation | la valeur attendue vient du **diff** (seule source légitime), la valeur observée du navigateur ; l'écart est rapporté, jamais réécrit |
| Scénario vert sans avoir vérifié son objectif | un scénario ne peut être classé vert que si son **objectif déclaré** a une assertion passée qui le couvre explicitement |
| Réparation qui rend le test plus permissif | une réparation ne peut ré-ancrer qu'une **action** vers une cible observée ; elle ne touche jamais au verdict, à la valeur attendue ni au type d'assertion |

## 2. Trois options évaluées

### Option A — boucle observe→act complète (le modèle décide chaque étape)

À chaque tour : objectif → observation → le modèle choisit **une** action → exécution →
observation → mise à jour → classement.

- Empêche : les six items, par construction — la cible est choisie dans le snapshot, le changement
  est constaté avant d'être affirmé.
- Coût : **un appel modèle par étape** (les scénarios du corpus font 8 à 12 étapes), plus de latence,
  plus de variance, et un risque nouveau : le modèle peut improviser une séquence sans lien avec
  l'exigence du diff, donc **passer à côté** de ce qu'il fallait prouver.
- Rejetée comme cœur : elle déplace le problème (l'oracle devient la conversation) et multiplie le
  coût sans borne.

### Option B — plan figé + vérification de cible avant chaque action

Le plan reste écrit à l'avance ; avant chaque action, l'exécuteur vérifie que la cible existe dans
le snapshot courant, et sinon ré-ancre ou refuse.

- Empêche : les cibles inventées. Rien d'autre.
- Ne touche pas : transitions annoncées sans changement, préconditions héritées, vert sans preuve
  d'objectif.
- Rejetée : elle traite la famille n° 1 (27 runs) mais laisse la n° 2 (23 runs `MARKER_ORDER`) et
  la n° 3 (9 runs `TRANSITION_NOT_OBSERVED`) intactes, et c'est exactement la classe déjà couverte
  par les refus actuels.

### Option C — objectifs et preuves depuis le diff, actions résolues à l'exécution (**retenue**)

Le planificateur écrit **ce qui doit être prouvé** : l'objectif du scénario, les assertions avec
leur valeur attendue dérivée du code et du diff, et les préconditions à établir. L'exécuteur choisit
**comment** atteindre chaque objectif à partir du snapshot observé, parmi un ensemble borné et
déterministe de candidats (contrôles observés dont le libellé, le rôle ou l'attribut correspond à
l'intention), et n'appelle le modèle qu'en cas d'impasse, sous budget.

- Empêche, par construction : cible inventée (on ne choisit que dans le snapshot) ; transition sans
  changement (comparaison baseline→après, dans la session) ; précondition héritée (session neuve +
  ordre contraint par l'objectif) ; valeur attendue réécrite (elle vient du diff et n'est jamais
  modifiée par l'exécution) ; vert sans preuve d'objectif (classement adossé à l'assertion qui
  couvre l'objectif) ; réparation permissive (elle ne ré-ancre qu'une action).
- Coût : borné. Le modèle n'est sollicité qu'en impasse, et le nombre d'appels est plafonné par le
  budget existant.
- Risque : si l'intention du plan est trop vague, aucun candidat ne correspond et le scénario se
  classe **indéterminé** au lieu d'échouer ou de mentir — c'est un résultat honnête, et il est
  mesuré.

**Décision : option C.** Elle supprime la classe dominante sans déplacer l'oracle, elle borne le
coût, et elle est réversible derrière un drapeau, ce qui permet la comparaison A/B exigée par la
tâche 7.

## 3. Invariants que le moteur garantit (indépendamment de l'option)

- **I1 — Isolation logique.** Un scénario ne peut hériter d'aucun état d'un autre : session neuve,
  navigation initiale, et aucune précondition supposée établie sans étape observée qui l'établit.
  Le test échoue si un scénario passe en s'appuyant sur l'état laissé par le précédent.
- **I2 — Provenance.** Toute assertion porte la preuve qui la fonde : la ligne du diff (ou la
  citation) pour la valeur attendue, et l'observation datée pour la valeur constatée. Une assertion
  sans provenance est refusée à la lecture du plan, pas tolérée à l'exécution.
- **I3 — Preuve d'objectif.** Chaque scénario déclare l'objectif qu'il prouve ; le classement
  `passed` exige qu'au moins une assertion **couvrant cet objectif** ait passé. Un scénario dont
  l'objectif n'est couvert par aucune assertion est `indeterminate`, jamais vert.
- **I4 — Réparation non permissive.** Les réparations ne modifient que la **désignation** d'une
  action (cible ré-ancrée sur une cible observée). Elles ne changent ni le type, ni la valeur
  attendue, ni l'orientation d'une assertion ; un refus reste un refus, un échec reste un échec.

Ces quatre invariants sont implémentés dans la PR 1 (moteur), derrière aucune condition : ils
valent pour les deux chemins. Ils portent sur ce que le plan **déclare** : déclarer un objectif ou
un indice d'exigence engage le contrôle ; ne rien déclarer n'est pas bloqué, c'est publié comme
non prouvé — un plan qui n'affirme rien ne peut pas prétendre avoir démontré quelque chose.

## 4. Hypothèse réfutable et seuils, écrits avant la campagne

**Hypothèse H1.** Avec l'architecture C active (drapeau posé) contre le même build sans elle, sur
la même PR, le même modèle et le même oracle, le taux de **runs entièrement verts** progresse d'au
moins **20 points absolus** sur deux lots entrelacés de 50 runs chacun, sans dégradation :

- des **faux verts** (assertions pré-satisfaites / assertions totales) : pas d'augmentation de plus
  de 3 points ;
- des **faux refus** (runs bloqués dont tous les scénarios exécutés passent) : pas d'augmentation ;
- de la **couverture** des objectifs justifiés (scénarios exécutés × objectifs déclarés) : baisse
  de moins de 5 % ;
- du **coût** par run en tokens : pas de hausse de plus de 25 % ;
- des **indéterminés** : publiés séparément, jamais comptés comme verts.

**Réfutation.** H1 est réfutée si la progression est inférieure à 20 points, si l'un des plafonds de
dégradation est franchi, ou si l'effet n'est pas distinguable de zéro à la puissance annoncée.

**Puissance, calculée maintenant.** Avec une référence mesurée entre 57 % et 70 % de runs verts et
50 runs par bras, l'étude détecte un écart de **20 points** avec environ 60 % de puissance et un
écart de **25 points** avec environ 80 % ; un écart réel de **15 points serait souvent manqué**. La
conséquence est écrite d'avance : si l'écart mesuré est de 10 à 15 points sans significativité, la
conclusion sera **« amélioration non démontrée »**, jamais « amélioration probable ». La tâche 6
fixera le calcul exact et la règle d'arrêt avant le premier run.

**Réfutation de l'architecture elle-même.** Si H1 est réfutée sur deux campagnes indépendantes, la
conclusion par défaut choisie avec l'utilisateur s'applique : livrer les invariants moteur
(I1–I4), documenter la limite du modèle imposé, et **ne pas** activer le chemin C par défaut.

## 5. Ce qui sera supprimé ou remplacé

- Le chemin « plan figé joué à l'aveugle » reste en place tant que la campagne n'a pas tranché, mais
  n'est plus le seul : il devient le bras de comparaison.
- Les portes qui n'existent que pour rattraper une hypothèse non observée (vérification de cible
  statique, réparation de quasi-homonyme, réécriture après invariance) sont **remplacées** par la
  résolution à l'exécution ; celles qui gardent une garantie réelle (provenance du diff, refus d'une
  citation absente, couverture des fichiers changés) restent.
- Aucun contrôle n'est supprimé avant que la campagne n'ait montré que le nouveau chemin le rend
  inutile ; la PR 2 (bascule) liste précisément ce qui tombe, avec le test qui prouve la
  non-régression.

## 6. Ordre de livraison

1. **PR 1 — moteur** : I1–I4 dans le moteur, plus le chemin C derrière `QA_OBSERVE_ACT` (désactivé
   par défaut), avec ses tests hors ligne (modèle et navigateur simulés).
2. Rejeu historique des 79 plans sur les deux chemins, artefacts committés.
3. Calcul de puissance et gel des critères (tâche 6), puis campagne 2 × 50 entrelacée.
4. **PR 2 — bascule** (ou décision de ne pas basculer), avec la liste des mécanismes retirés.
