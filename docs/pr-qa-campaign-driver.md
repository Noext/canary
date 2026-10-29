# Campagne reproductible : driver, instrumentation, métriques

Ce document décrit l'outillage ajouté pour rendre la fiabilité QA **mesurable** et une campagne
avant/après **reproductible**. Le protocole lui-même n'est pas redéfini ici : il est figé dans
[`pr-qa-campaign-criteria.md`](pr-qa-campaign-criteria.md) (deux bras, lots de dix runs alternés,
cinq lots par bras) et ce driver l'applique tel quel, en constantes nommées
(`CAMPAIGN_BLOCKS`, `CAMPAIGN_RUNS_PER_BLOCK`).

## 1. Instrumentation des artefacts

Chaque assertion d'un `result.json` porte désormais, en plus de `passed`, `actual`, `baseline`,
`persisted` et `preMatched` :

| Champ | Sens |
| --- | --- |
| `verification` | `state`, `transition` ou `persisted`, tel que le plan l'a demandé |
| `changed` | la preuve produite **pendant** l'exécution : la valeur après l'étape diffère de celle mesurée avant. Absent quand aucune valeur d'avant n'a pu être mesurée — inconnu, jamais « rien n'a changé » |

`verification` est ce qui manquait pour ventiler les assertions pré-satisfaites : les artefacts de
campagne antérieurs ne stockaient qu'un compteur global (`preMatchedAssertions`), donc aucune
mesure ne pouvait distinguer une pré-satisfaction sur `state` d'une pré-satisfaction sur
`transition`. `changed` sépare l'état initial de la preuve d'exécution, ce que `preMatched` seul ne
dit pas.

`result.json` est déjà passé par `redact()` (jetons, clés, URL à identifiants) avant écriture. Les
valeurs de page y restent telles quelles, comme avant ; l'artefact de campagne, lui, n'en recopie
**aucune** (voir §3).

## 2. Lancement : toujours manuel

```bash
# 1) Préflight seul : aucun run, aucune dépense.
canary-pr-qa campaign \
  --pr https://github.com/OWNER/REPO/pull/N \
  --preview https://preview.example.com/ \
  --head <sha-complet-du-head> \
  --reference-sha <40 hex> --reference-worktree /abs/path/baseline \
  --candidate-sha  <40 hex> --candidate-worktree /abs/path/candidate \
  --data /abs/path/hors-du-depot

# 2) Campagne réelle : consomme l'API du modèle de l'opérateur.
canary-pr-qa campaign … --confirm-paid-runs
```

Sans `--confirm-paid-runs`, la commande s'arrête après le préflight : elle imprime le plan, les
blocages et `"ready"`. Aucun hook, aucun script npm, aucun démarrage de service ne l'appelle. Un
run réel est payant et n'est jamais déclenché par accident.

Le préflight nomme **tous** les blocages à la fois, chacun avec sa correction :

| Code | Cause |
| --- | --- |
| `CONFIG_INVALID` | la validation de configuration du service échoue (endpoint, modèle, hôtes) |
| `MODEL_CREDENTIALS_MISSING` | `OPENAI_API_KEY` / `OPENAI_MODEL` absents |
| `GITHUB_CREDENTIALS_MISSING` | ni jeton ni App GitHub : la PR est illisible |
| `PREVIEW_UNVERIFIED` / `PREVIEW_SHA_MISMATCH` | la preview ne prouve pas le SHA complet du head |
| `ARM_COMMIT_INVALID` / `ARM_SHA_MISMATCH` / `ARM_WORKTREE_MISSING` | le dépôt de travail d'un bras n'est pas sur le commit attendu |
| `ARM_CLI_MISSING` | le bras n'a pas de `dist/cli.js` construit |
| `DATA_DIR_INSIDE_REPO` | les runs seraient versionnables |

Les deux bras ne diffèrent **que** par leur commit. Aucun drapeau n'est injecté par le driver :
une variable d'environnement qui changerait le comportement doit être posée identiquement pour les
deux bras, sinon la comparaison mesurerait deux changements. Le fichier `campaign-plan.json` écrit
dans le dossier de données conserve le protocole, les SHAs et les chemins de travail pour rejouer.

## 3. Ce que le driver enregistre

Un fichier `campaign-runs.jsonl` (un run par ligne, ajouté au fil de l'eau, donc une campagne
interrompue garde ses runs), puis `campaign-summary.json` :

- par run : `arm`, `block`, `index`, `runId`, `sha`, `outcome`, `tokens`, et par scénario
  `outcome` / `code` / `refused`, et par assertion `verification` / `preMatched` / `changed` /
  `passed` ;
- **aucune valeur de page** n'est recopiée : les valeurs peuvent porter des données de test, et
  les métriques n'en ont pas besoin. `--with-values` n'existe pas : si un opérateur veut une
  valeur, il ouvre le `result.json` du run sous l'autorisation habituelle.

Un run qui n'a produit aucun `result.json` (CLI en échec, délai dépassé) est enregistré
`incomplete: true`. Il n'est **ni vert ni évaluable** : il est publié pour être rejoué, jamais
compté comme un succès.

Le dossier `--data` doit être hors du dépôt ; `qa-data/` est déjà ignoré par git. Les bundles de
replay restent désactivés par le driver (`QA_REPLAY_BUNDLE=false`) : un bundle porte du texte de
page et ne se committe pas.

## 4. Métriques

`src/campaign-metrics.ts` calcule, par bras :

- runs, runs évaluables (hors pannes d'infrastructure et runs incomplets), runs verts, **taux de
  runs entièrement verts** ;
- par type de vérification : assertions, pré-satisfaites, **pré-satisfaites et passées**, valeur
  inchangée ;
- faux refus (run bloqué dont tous les scénarios exécutés passent), runs à défaut de plan, runs à
  échec produit, tokens.

`compareArms` rend l'écart de taux de runs verts avec son IC 95 % (approximation normale, celle du
document), l'écart de faux verts par assertion, et un drapeau de significativité. `campaignDecision`
applique les seuils **figés** : +20 points avec IC excluant zéro pour valider, plafonds de
dégradation (faux refus : aucun ; faux verts : +3 points) qui interdisent de conclure à une
validation même avec un écart favorable.

### Ce que ces chiffres ne sont pas

Le taux de faux verts d'un corpus historique **n'est pas** ce que calcule ce module. Un faux vert
est une assertion pré-satisfaite qui a passé ; il n'est calculable que sur des runs dont l'artefact
porte, par assertion, `verification`, `preMatched` et `passed`. Les artefacts de campagne
antérieurs ne portent que des compteurs : la part des 15,7 % / 17,4 % publiée dans
[`pr-qa-reliability-decision.md`](pr-qa-reliability-decision.md) qui relève de `state` +
valeur inchangée **n'est pas reconstituable**, et aucun chiffre de ce document ne la présente comme
telle.

De même, aucune amélioration n'est mesurée tant que les deux bras n'ont pas réellement tourné :
`campaignDecision` rend `not-run` sans run évaluable, et c'est la seule réponse honnête hors ligne.

## 5. Ce qu'il reste à fournir pour lancer une campagne

Le dépôt ne contient ni service déployé, ni credentials, ni preview : une campagne réelle exige
les éléments suivants, absents d'un environnement de développement hors ligne.

1. Un dépôt de travail par bras, extrait sur le commit exact et **construit**
   (`git worktree add /abs/baseline <sha>`, `pnpm install && pnpm build`).
2. Une PR réelle lisible par un jeton ou une App installée.
3. Une preview déployée exposant le SHA **complet** du head (`x-commit-sha` ou
   `PREVIEW_SHA_PATH`) et un hôte listé dans `PREVIEW_ALLOWED_HOSTS`.
4. Un endpoint IA compatible `/chat/completions` avec une clé active, et le modèle choisi par
   l'opérateur dans `OPENAI_MODEL`.
5. Un dossier `--data` hors du dépôt.

Sans ces éléments, le préflight rend ses blocages et la campagne ne démarre pas — c'est le
comportement voulu, et il vaut mieux qu'un run partiel compté comme un succès.
