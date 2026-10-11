# Agent Orientation

This file is the entry point for AI agents (and humans new to the repo).

## What canary is

Canary is an AI-agent QA toolkit for driving real browsers. The pieces:

1. **`canary` (orchestrator CLI, `@usecanary/cli`)** — records capture-enabled QA sessions (trace/video/HAR/console) as a series of script steps and renders a self-contained report. The primary, user-facing CLI.
2. **`canary-browser` (engine CLI, `@usecanary/browser`)** — one-off browser automation: persistent named pages, sandboxed JavaScript, headless or headed. Embeds and supervises the daemon.
3. **`canary-daemon`** — a long-running Node process owning Playwright + a QuickJS sandbox. Embedded into the CLIs at build time. Speaks line-delimited JSON over a named pipe / Unix socket.
4. **`canary-ui` (`@usecanary/ui`)** — the local session viewer; ships standalone. Run it with `canary-viewer` (after `npm i -g @usecanary/ui`), or `canary ui` from a repo checkout, or one-off via `npx @usecanary/ui`.

Both CLIs reach the browser the same way:

```
canary run … --session …   /   canary-browser run …   →   daemon RPC   →   Playwright
```

## Apps + packages

| Workspace                | Role                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `apps/canary`            | Session orchestrator CLI (`canary`) — records QA sessions, renders reports. The primary CLI.    |
| `apps/canary-browser`    | Browser-automation engine CLI (`canary-browser`) — owns the daemon lifecycle, embeds the daemon |
| `apps/canary-daemon`     | Internal Playwright host + QuickJS sandbox. Built standalone, embedded into the CLIs            |
| `apps/canary-ui`         | Local web viewer (Astro + React islands). Reads `results.json`; run via `canary ui` or `npx @usecanary/ui` |
| `apps/canary-pr-qa`      | Autonomous PR planner/executor, authenticated run API, GitHub publication and per-run evidence |
| `apps/create-canary`     | `npm create canary` setup wizard (Ink)                                                          |
| `packages/protocol`      | Zod IPC schemas. Single source of truth — daemon validates, CLIs infer types                    |
| `packages/config`        | Shared tsconfig bases (`base`, `node-app`)                                                       |
| `packages/logger`        | Shared pino-backed structured logger (source-distributed)                                       |
| `packages/cli-kit`       | Shared CLI helpers (request ids, formatting, logger factory)                                    |
| `packages/daemon-client` | Daemon transport + lifecycle + paths; embeds the daemon bundle for the CLIs                     |

## Build flow

`turbo run build` topo-sorts via `^build`:

1. `@usecanary/protocol` + `@usecanary/config` + `@usecanary/logger` (no build, source-distributed)
2. `@usecanary/daemon` builds → emits `dist/daemon.bundle.mjs` + `dist/sandbox-client.js`
3. `@usecanary/browser` + `@usecanary/cli` embed their assets (the daemon bundle via `@usecanary/daemon-client`), then bundle with esbuild; `@usecanary/ui` builds an Astro node standalone — a self-contained `dist/server/entry.mjs` + `dist/client/` (`vite.ssr.noExternal` bundles every server dep, so the published package ships no runtime `node_modules`)

## Shared docs (skills + CLI help + README)

LLM-facing doc content that appears on more than one surface — the sandbox/scripting API and the
workflow rules — is single-sourced in `docs/snippets/` and stitched by `scripts/stitch-docs.mjs`:

- Edit the snippet, then run `make docs` (`--write`). CI fails on drift via `pnpm check` (`--check`).
- Never hand-edit `packages/cli-kit/src/snippets.generated.ts` or the content between
  `<!-- canary:snippet … -->` markers in `skills/`, `agents/`, or `README.md`.
- `skills/` is the skill pack consumed verbatim by Claude Code (`.claude-plugin/`), Cursor
  (`.cursor-plugin/`), and Codex (`plugins/canary/`, whose `skills` is a symlink here) — keep
  SKILL.md frontmatter (`name`, `description`) intact and marker-free.

## Code style & logging

- **Linting/formatting:** [Ultracite](https://docs.ultracite.ai/) over Biome — config in `biome.jsonc` (extends `ultracite/biome/core`). `pnpm lint` checks; `pnpm format` autofixes; the pre-commit hook runs `ultracite fix` on staged files. Don't reintroduce ESLint/Prettier.
- **Logging:** use `@usecanary/logger` (`createLogger`, pino-backed, structured) for diagnostics — never `console.*` in app code (Biome's `noConsole` is an error). Reserve `process.stdout` for machine-readable CLI output. Level via `CANARY_LOG_LEVEL` (trace|debug|info|warn|error|silent); the daemon logs to `~/.canary/daemon.log`, the CLI to stderr (raise with `--verbose`).
- The vendored Playwright fork at `apps/canary-daemon/src/sandbox/forked-client/` is excluded from lint/format — keep it diffable against upstream.

## Validation

Before committing:

```bash
pnpm install
pnpm check     # ultracite lint + turbo compile + test
```

Per-workspace:

```bash
pnpm --filter @usecanary/daemon test
pnpm --filter @usecanary/browser test
```

## Viewing sessions

`canary ui` launches a local Astro web app (`apps/canary-ui`, `@usecanary/ui` — the Library and
SessionView screens are client-only React islands) that reads each
session's `results.json`, lists every recorded session, and renders it in the same tabbed,
"High-Contrast Precision" layout as the self-contained HTML report. You can organize sessions
into **virtual folders**, tag/note/search them, and delete-to-trash. It reads `~/.canary/sessions`
by default; `canary ui --dir <path>` (or adding roots in the UI) points it elsewhere.

- Organization lives in a per-root `.canary-ui.json` sidecar — **sessions stay flat on disk**;
  deletes move the dir to `<root>/.trash/` (restorable).
- The command resolves the built server (`dist/server/entry.mjs`) and spawns it in the foreground
  (Ctrl-C stops it); with no build present it falls back to `astro dev`. Build once for fast
  startup: `pnpm --filter @usecanary/ui build`. (The viewer stays a separate `node` server rather
  than folding into the esbuild/SEA CLI bundle — `CANARY_UI_SERVER` overrides its location. The
  server reads `HOST`/`PORT`/`CANARY_UI_ROOT` from the environment.)

## Provenance

Canary's daemon and TypeScript CLIs (`canary-daemon`, `canary-browser`, and the `canary` session orchestrator) are the core of the toolkit. Portions are derived from MIT-licensed upstream work by Sawyer Hood (see `LICENSE`).

## Instructions aux agents : déploiement PR QA en production sur VPS

Ces instructions concernent le système de QA des PR de **ce fork**. Lire également
[`apps/canary-pr-qa/README.md`](apps/canary-pr-qa/README.md), `.env.example`,
`Dockerfile.pr-qa` et `docker-compose.yml` avant d'agir. Le déploiement comporte un
seul service Docker : API PR QA, moteur Canary et Chromium dans le même conteneur.
L'application à tester et l'endpoint IA sont des services externes, déjà accessibles.

### 1. Identifier l'hôte et la révision

- Utiliser le VPS et le compte SSH indiqués par l'utilisateur. S'ils ne sont pas
  disponibles, préparer la configuration et signaler précisément l'accès manquant ;
  ne pas annoncer un déploiement effectué.
- Vérifier le système, l'architecture, l'espace disque, `git`, `curl`, Docker Engine
  et le plugin Compose : `uname -m`, `df -h`, `docker version`, `docker compose version`.
  Les commandes suivantes supposent que le compte dispose déjà de l'accès Docker ;
  utiliser `sudo docker` si c'est le mode d'accès du VPS.
- Si Docker manque, suivre le dépôt officiel adapté au système :
  [Ubuntu](https://docs.docker.com/engine/install/ubuntu/) ou
  [Debian](https://docs.docker.com/engine/install/debian/). Installer également le
  plugin Compose 2.20 ou plus récent. Ne pas remplacer une installation Docker existante utilisée par
  d'autres applications, ni utiliser le script de commodité destiné aux tests.
- Conserver les développements et PR dans `Noext/canary`. Ne jamais pousser vers
  `0xnyn/canary`, ouvrir une PR upstream, forcer un push ou modifier d'autres dépôts.

Pour une nouvelle installation, dans un répertoire dédié appartenant au compte de
déploiement :

```bash
git clone --branch feat/autonomous-pr-qa https://github.com/Noext/canary.git canary-pr-qa
cd canary-pr-qa
git remote add upstream https://github.com/0xnyn/canary.git
git remote set-url --push upstream DISABLED
git rev-parse HEAD
git status --short
```

La branche livrée est actuellement `feat/autonomous-pr-qa`. Après fusion dans le
fork, `main` peut devenir la branche de déploiement si l'utilisateur le demande.
Pour un clone existant, inspecter ses remotes et changements locaux ; conserver
ses fichiers `.env` et ne pas écraser ses modifications. Utiliser un projet Compose
distinct sur un VPS qui héberge déjà d'autres services. Lancer toutes les commandes
Compose depuis ce même répertoire, avec le même nom de projet si `-p` est utilisé.

### 2. Configurer les secrets et les services accessibles

Créer `.env` seulement s'il n'existe pas, puis restreindre ses permissions :

```bash
test -f .env || cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Utiliser la valeur aléatoire comme `QA_API_TOKEN`. Ne jamais committer `.env`,
afficher les secrets dans les logs/rapports, envoyer les tokens au modèle ou au
navigateur, ni supposer que la connexion GitHub de ChatGPT fournit un token au VPS.
La valeur `QA_API_TOKEN` vide de `.env.example` doit être renseignée. Modifier les valeurs à partir des secrets et paramètres fournis :

| Variable | Configuration de production |
| --- | --- |
| `GITHUB_TOKEN` | PAT finement limité ou token d'installation : Contents, Metadata et Deployments en lecture ; Pull requests et Commit statuses en écriture |
| `GITHUB_ALLOWED_REPOS` | Dépôts à tester, séparés par des virgules, au format `owner/repo` ; obligatoire pour le serveur |
| `OPENAI_BASE_URL` | Endpoint compatible OpenAI, avec `/v1` si nécessaire ; le client ajoute `/chat/completions` |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Clé du fournisseur et identifiant exact du modèle ; ne pas inventer ces valeurs |
| `OPENAI_TOKEN_PARAMETER` | `max_tokens` par défaut ; `max_completion_tokens` pour les fournisseurs qui l’exigent |
| `OPENAI_TEMPERATURE` | Vide par défaut : omise de la requête ; renseigner seulement si le modèle l’accepte |
| `QA_PLAN_MAX_TOKENS`, `QA_ACTION_MAX_TOKENS` | Budgets de sortie : 8000 et 4096 par défaut ; augmenter si le JSON est tronqué |
| `OPENAI_JSON_MODE` | `true` par défaut ; `false` seulement si l'endpoint ne prend pas en charge `response_format: json_object` |
| `PREVIEW_ALLOWED_HOSTS` | Hôtes exacts, ports inclus si nécessaires ; aucun joker |
| `PREVIEW_ENVIRONMENT` | Environnement des déploiements GitHub à résoudre, `preview` par défaut |
| `PREVIEW_URL_TEMPLATE` | Facultatif, avec `{sha}` et/ou `{pr}` ; laisser vide pour résoudre les déploiements GitHub |
| `PREVIEW_SHA_HEADER`, `PREVIEW_SHA_PATH` | Header `x-commit-sha` par défaut, ou chemin JSON renvoyant `{"sha":"<SHA complet>"}` |
| `QA_API_TOKEN` | Secret aléatoire d'au moins 24 caractères, utilisé comme bearer sur l'API |
| `QA_PORT` | `8787` par défaut ; Compose adapte automatiquement le port local et le healthcheck |
| `ARTIFACT_BASE_URL` | Origine publique HTTPS du service si les commentaires GitHub doivent contenir des liens de rapport |
| `ARTIFACT_PUBLIC` | `false` par défaut ; `true` rend les liens UUID de rapports/vidéos accessibles sans bearer |

Compose impose `QA_DATA_DIR=/data` et `QA_HOST=0.0.0.0` **dans le conteneur**,
mais publie uniquement `127.0.0.1:${QA_PORT:-8787}` sur le VPS. Garder le transport natif du
daemon ; `CANARY_DAEMON_PORT` et `CANARY_DAEMON_TOKEN` servent aux environnements de
développement sans sockets Unix et ne doivent pas ouvrir un port public.

`localhost` dans Docker désigne le conteneur. Si l'IA tourne sur le VPS, configurer
une adresse joignable depuis Docker. Le Compose fourni définit déjà
`host.docker.internal:host-gateway` sur Linux.

L'endpoint de l'hôte doit écouter sur une interface accessible au conteneur ; le
mapping DNS ne rend pas un service lié uniquement à `127.0.0.1` accessible.
Vérifier aussi la résolution DNS, le réseau et l'accès de Chromium aux previews.

### 3. Construire et démarrer

```bash
./scripts/pr-qa up
./scripts/pr-qa status
./scripts/pr-qa doctor --pr https://github.com/OWNER/REPO/pull/123 --preview https://preview.example.com
```

Le wrapper valide Compose et la configuration avant le démarrage, attend le
healthcheck, puis lance `doctor` : stockage, moteur Chromium réel et création des
preuves, accès GitHub et endpoint IA. Le test de preview reste optionnel tant
qu'aucune PR/URL réelle n'est fournie. Une erreur de diagnostic arrête la commande
avec un code non nul et une action corrective. Lire
[`docs/pr-qa-operations.md`](docs/pr-qa-operations.md) pour le dépannage.


`config --quiet` valide la configuration sans imprimer l'environnement contenant
les secrets. Le Dockerfile installe les dépendances du monorepo avec le lockfile,
construit le CLI Canary et l'app PR QA, puis installe le runtime Chromium ; ne pas
installer Node/pnpm sur l'hôte pour contourner ce workflow. Le service est exécuté
sous l'utilisateur `node`, avec `init`, redémarrage automatique et `shm_size: 1gb`.

Attendre un conteneur sain et une réponse `{ "ok": true, ... }`. Le healthcheck
vérifie que l'API répond ; il ne vérifie ni les identifiants IA/GitHub, ni une preview,
ni un scénario Chromium. Si le build ou le démarrage échoue, garder les erreurs
utiles en masquant les secrets et ne pas déclarer la production validée.

### 4. Valider un vrai run avant de conclure

Choisir une PR ouverte autorisée et une preview correspondant **exactement** à son
SHA head complet. Les tests interagissent réellement avec l'application ; utiliser
des données et comptes de test adaptés.

- Résolution automatique : le dernier statut d'un déploiement GitHub pour ce SHA et
  l'environnement configuré doit être `success`, avec `environment_url`.
- URL explicite ou template : la preview doit exposer le SHA dans le header configuré
  ou via `PREVIEW_SHA_PATH`. Une URL générique de staging sans provenance est refusée.
- La PR, son SHA/base et la preview sont recontrôlés en fin d'exécution. Ne pas
  désactiver ces contrôles pour obtenir un résultat vert.

Depuis un shell Bash sur le VPS, saisir le bearer sans l'inscrire dans l'historique
et envoyer la requête. Remplacer l'URL d'exemple ; `previewUrl` est facultatif si
GitHub fournit un déploiement correspondant :

```bash
read -r -s -p 'QA API token: ' QA_REQUEST_TOKEN
printf '\n'
curl --fail-with-body --silent --show-error \
  -X POST http://127.0.0.1:8787/runs \
  -H "Authorization: Bearer $QA_REQUEST_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"prUrl":"https://github.com/OWNER/REPO/pull/123","previewUrl":"https://preview.example.com","publish":true}'
```

Conserver l'`id`, le `statusUrl` et le `reportUrl` retournés. Puis :

```bash
QA_RUN_ID='UUID_RETOURNE'
curl --fail --silent --show-error \
  "http://127.0.0.1:8787/runs/$QA_RUN_ID" \
  -H "Authorization: Bearer $QA_REQUEST_TOKEN"
curl --fail --silent --show-error \
  "http://127.0.0.1:8787/artifacts/$QA_RUN_ID/result.json" \
  -H "Authorization: Bearer $QA_REQUEST_TOKEN"
unset QA_REQUEST_TOKEN
```

Répéter la lecture du statut jusqu'à un état terminal. `completed` signifie que le
runner a terminé, **pas que les assertions ont réussi** : inspecter `outcome`, les
scénarios, les fichiers ignorés, `error` et `publication` dans `result.json`.
Vérifier les vidéos WebM non vides, captures, traces, HAR et rapports, ainsi que le
commentaire et le statut du commit réellement publiés sur la PR. Les artefacts
peuvent ne pas encore exister pendant la découverte ; ce n'est pas une preuve de
réussite. Les fichiers ignorés et les résultats `blocked`, `stale`, `skipped` ou
`failed` doivent être explicitement rapportés.

Un agent doit remettre la révision déployée, l'état du conteneur, l'URL et le SHA de
la PR testée, le run ID, les résultats et liens GitHub constatés. Distinguer un vrai
endpoint IA/GitHub/preview d'une fixture et l'analyse YAML d'un déploiement exécuté.

### 5. Accès distant et suivi des runs : capacités actuelles

Pour un accès privé sans proxy, établir un tunnel depuis la machine cliente :

```bash
ssh -N -L 8787:127.0.0.1:8787 deploy@VPS
```

Pour des liens HTTPS distants, placer un reverse proxy TLS devant
`127.0.0.1:8787`, avec le domaine indiqué dans `ARTIFACT_BASE_URL`. Préserver le
header `Authorization`. Avec `ARTIFACT_PUBLIC=false`, ouvrir un lien GitHub dans
un navigateur ne fournit pas automatiquement le bearer : prévoir une
authentification au proxy qui le transmet, ou télécharger les artefacts avec curl.
Ne pas prétendre que les rapports privés sont accessibles depuis GitHub sans cette
configuration. Les artefacts peuvent contenir des données sensibles de test.

| Besoin | Disponible actuellement |
| --- | --- |
| État de service et taille de file | `GET /health` : `ok`, `busy`, `queued` |
| État d'un run connu | `GET /runs/:id` authentifié : queued/running/completed/failed/interrupted et outcome final |
| Diagnostic en cours | `./scripts/pr-qa logs` ; événements structurés avec run ID, phase, action et diagnostic |
| Progression par action | `GET /runs/:id` inclut `progress` ; `progress.json` et `events.jsonl` persistent les phases/actions ; consultation par polling |
| Résultats | `result.json` et `report.html` sauvegardés après planification et chaque scénario terminé |
| Résumé de support | `./scripts/pr-qa diagnose RUN_ID` : résumé sans secrets ni valeurs saisies |
| Preuves et consultation des sessions | Rapports HTML et viewer existant `apps/canary-ui` pour vidéos, console, réseau et étapes enregistrées |
| Dashboard PR QA centralisé | Non implémenté : pas de page de liste des runs, ni de `GET /runs` de listing |
| Flux poussé et métriques | Pas de SSE/WebSocket, streaming du navigateur, métriques Prometheus ou suivi des tokens/coûts IA |

Le viewer natif se lance avec `canary ui` dans un checkout où `@usecanary/ui` est
construit. Il n'est **pas construit/copié dans `Dockerfile.pr-qa`**, ni servi par le
Compose actuel. Ne pas annoncer de dashboard Docker accessible à une URL inventée.
Conserver cette limite tant qu'une intégration UI dédiée n'a pas été implémentée et
testée. Les vidéos sont des enregistrements, pas un streaming du navigateur.

### 6. Persistance, mises à jour et récupération

Deux volumes nommés doivent être conservés : `qa-data` contient les jobs/rapports et
`canary-sessions` les sessions originales. Ne pas lancer `docker compose down -v`
ni purger globalement Docker. Il n'existe pas encore de politique automatique de
rétention ; surveiller `df -h` et `docker system df`, puis appliquer une politique
de conservation explicite aux seuls artefacts de ce projet.

Avant une mise à jour, suspendre les nouvelles soumissions et vérifier
`busy=false`, `queued=0` sur `/health`. Sauvegarder les volumes sans exécution en
cours ; voici une sauvegarde avec l'image déjà construite :

```bash
umask 077
QA_PREVIOUS_REV=$(git rev-parse HEAD)
QA_BACKUP_DIR="$PWD/../canary-pr-qa-backups"
mkdir -p "$QA_BACKUP_DIR"
docker compose stop pr-qa
docker compose run --rm --no-deps -T --entrypoint sh pr-qa \
  -c 'tar -czf - -C / data home/node/.canary/sessions' \
  > "$QA_BACKUP_DIR/canary-pr-qa-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
```

Conserver la sauvegarde et une copie sécurisée de `.env` en dehors du dépôt ; ne
pas joindre les secrets à la PR. Contrôler le code retour de la sauvegarde avant
de poursuivre. Pour mettre à jour un checkout propre sur la branche de déploiement :

```bash
git pull --ff-only origin feat/autonomous-pr-qa
./scripts/pr-qa up
./scripts/pr-qa status
```

Si la nouvelle révision échoue, reconstruire l'ancienne révision sans réécrire
l'historique distant :

```bash
git switch --detach "$QA_PREVIOUS_REV"
./scripts/pr-qa up
```

Contrôler à nouveau la santé et un vrai run. Au redémarrage, les jobs précédemment
queued/running sont marqués `interrupted` ; ils ne sont pas rejoués automatiquement.
Après inspection de leurs effets, les soumettre explicitement de nouveau si
nécessaire. Si une restauration des volumes est requise, arrêter le service et
restaurer la sauvegarde dans les mêmes volumes, en conservant les droits de
l'utilisateur `node` ; ne pas restaurer sur un run actif.

### 7. État de validation à respecter

Les tests locaux et E2E Chromium sont décrits dans
[`docs/pr-qa-validation.md`](docs/pr-qa-validation.md) et
[`docs/pr-qa-hardening.md`](docs/pr-qa-hardening.md). À cette livraison, ils
utilisent des API GitHub/IA de fixture. Le build/exécution Docker sur VPS et un run
avec un vrai endpoint IA et une vraie preview n'ont pas encore été validés dans
l'environnement de développement. Ces étapes doivent être réellement exécutées
sur le VPS avant d'affirmer « installé et validé en production ».
