# Critères de la campagne finale, figés avant le premier run

Ce document fixe la taille, la puissance, les indicateurs, les seuils et la règle d'arrêt de la
campagne qui décide si l'architecture observe→act améliore réellement le taux de **runs
entièrement verts**. Il est écrit avant le premier run de la campagne et ne change plus ensuite.

## 1. Bras et protocole

| Bras | Build | Drapeau | Rôle |
| --- | --- | --- | --- |
| Référence | `8143ac9` (branche `baseline-8143ac9`) | — | le comparateur historique de l'objectif |
| Candidat | `22b415b` (branche `main`) | `QA_OBSERVE_ACT=true` | le chemin observe→act |

Même service, même PR (`pharmania/arpilabe-pilotage#20`), même preview, même modèle
(`opencode-go/deepseek-v4.1-flash`), même oracle. **Lots alternés de dix runs** (référence,
candidat, référence, candidat…), **cinq lots par bras = 50 runs par bras**. Chaque bloc consigne
le déploiement Coolify et le commit réellement servis ; l'identité du bras est attestée par
`preMatchedKeyed` (le build candidat écrit le champ, la référence ne le connaît pas) et, sur le
bras candidat, par la présence de `classification` dans les rapports.

Aucun run n'est retiré. Les pannes d'infrastructure (`HTTP_429`, `HTTP_502`, `QA_ERROR`,
`WORKER_STOPPING`, `RUN_BUDGET_EXCEEDED`) sont comptées, nommées, et exclues du seul calcul
« évaluable » — jamais supprimées de l'artefact.

## 2. Indicateur principal et seuils

**Indicateur principal : taux de runs entièrement verts** (un run dont tous les scénarios sont
`passed`), mesuré sur les runs évaluables.

| Seuil | Valeur | Conséquence |
| --- | --- | --- |
| Succès | **+20 points absolus** pour le candidat, IC 95 % excluant zéro | architecture validée |
| Non démontré | effet mesuré entre 0 et +20 points, ou IC incluant zéro | « amélioration non démontrée » |
| Régression | effet ≤ 0 avec IC excluant zéro en faveur de la référence | « limite du modèle imposé » ou retour au chemin figé |

Garde-fous de dégradation, évalués sur le bras candidat contre le bras référence :

| Indicateur | Plafond |
| --- | --- |
| Faux verts (assertions pré-satisfaites / assertions) | +3 points maximum |
| Faux refus (runs bloqués dont tous les scénarios exécutés passent) | aucun |
| Couverture des objectifs justifiés (scénarios exécutés × objectifs déclarés) | −5 % maximum |
| Tokens par run | +25 % maximum |
| Indéterminés | publiés, jamais comptés comme verts |

## 3. Puissance, calculée avant la campagne

La référence a mesuré entre **50 % et 70 %** de runs verts selon les campagnes
(`17/30 = 56,7 %`, `5/10`, `8/10`, `7/10`). Avec **50 runs par bras** et un taux de base de
60 %, l'erreur-type de la différence vaut
`√(0,6·0,4/50 + 0,4²/50) ≈ 9,8 points` :

| Écart réel | Détectable à 80 % de puissance ? |
| --- | --- |
| +10 points | non (≈ 1,0 σ) |
| +15 points | rarement (≈ 1,5 σ, puissance ≈ 30 %) |
| +20 points | souvent (≈ 2,0 σ, puissance ≈ 60 %) |
| +25 points | oui (≈ 2,6 σ, puissance ≈ 80 %) |

**Conséquence écrite d'avance** : si l'écart mesuré est de 10 à 15 points sans significativité,
la conclusion sera **« amélioration non démontrée »**, jamais « amélioration probable ». La
taille de 2 × 50 ne permet pas de trancher un effet de 15 points ; c'est une limite de la
campagne, pas une invitation à changer le seuil après lecture.

## 4. Règle d'arrêt

- **Arrêt pour panne** : si le service ou le worker tombe (deux blocs consécutifs sans run
  évaluable), la campagne est suspendue, la panne est documentée, et la campagne reprend après
  réparation — les blocs perdus sont rejoués, jamais retirés.
- **Arrêt anticipé pour succès** : après 25 runs par bras, si l'écart est ≥ +20 points avec
  IC 95 % excluant zéro **et** les plafonds de dégradation respectés, la campagne peut s'arrêter
  et conclure.
- **Arrêt anticipé pour échec** : après 25 runs par bras, si l'écart est ≤ −10 points avec
  IC 95 % excluant zéro en faveur de la référence, la campagne peut s'arrêter et conclure à la
  régression ou à la limite du modèle.
- **Sinon** : la campagne va au bout de ses 2 × 50 runs, quel que soit le résultat intermédiaire.

## 5. Décision en sortie

| Situation mesurée | Conclusion écrite |
| --- | --- |
| ≥ +20 points, plafonds respectés | **solution validée** — la bascule (PR 2) est justifiée |
| 0 à +20 points, ou IC incluant zéro | **amélioration non démontrée** — pas de bascule par défaut ; les invariants moteur restent livrés |
| ≤ 0 avec IC excluant zéro en faveur de la référence | **régression** — retour au chemin figé, cause écrite |
| Effet nul sur deux campagnes indépendantes | **limite du modèle imposé** — documentée avec les chiffres, sans redéfinition du critère |

## 6. Ce qui doit être publié, quoi qu'il arrive

Runs entièrement verts, scénarios verts par run, échecs produit par run, échecs imputables à
Canary, faux verts, faux refus, indéterminés, couverture des objectifs, tokens, appels au
modèle, latence et coût par run, et la ventilation par famille d'échec. Les blocs sont publiés
dans l'ordre, y compris ceux qui régressent, avec leurs identifiants de run et leurs agrégats
recalculés par test.
