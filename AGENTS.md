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
`Dockerfile.pr-qa` et `docker-compose.yml` avant d'agir. Le déploiement utilise cinq services : API/dashboard, worker, moteur Canary/Chromium
isolé, proxy egress et PostgreSQL. Le README de l'application décrit le contrat
actuel ; suivre ce document lorsque les sections historiques ci-dessous divergent.

### Mise à jour des instructions de production

- Configurer trois secrets distincts : `QA_API_TOKEN`, `QA_DB_PASSWORD` (hex),
  `QA_BROWSER_SERVICE_TOKEN`. Le navigateur ne reçoit aucune clé IA/GitHub.
- Démarrer tout le Compose avec `./scripts/pr-qa up`, conserver ses trois volumes.
- Le dashboard est réellement servi à `/` par le serveur SQL ; SSE à
  `/runs/:id/events`. Les vidéos sont finalisées, pas diffusées en direct.
- Vérifier le SHA live de toutes les previews, y compris les déploiements GitHub.
- Placer clés App, identités et fixtures dans `config/`, monté read-only. Consulter
  les exemples et les variables du README ; ne jamais committer les secrets.
- API et worker utilisent la file PostgreSQL. Les leases expirées sont interrompues,
  jamais rejouées. Les fichiers legacy sont importés sans relancer leurs scénarios.
- Les tests locaux PGlite ne valident pas la concurrence native PostgreSQL ;
  exécuter la suite native avec `QA_TEST_DATABASE_URL` et la suite Compose avant
  d'affirmer qu'une installation Docker est validée.
- L'accès GitHub App, l'endpoint IA réel, les secrets, l'IdP et la disponibilité des
  previews restent à configurer par l'opérateur. Lire le journal de validation.
- Ne pas désactiver les contrôles de contrat/couverture/provenance pour obtenir un vert.

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

### 2. Installer et diagnostiquer

Suivre intégralement [`apps/canary-pr-qa/README.md`](apps/canary-pr-qa/README.md),
[`docs/pr-qa-operations.md`](docs/pr-qa-operations.md) et `.env.example`.
Les commandes de référence :

```bash
./scripts/pr-qa up
./scripts/pr-qa status
./scripts/pr-qa doctor --pr https://github.com/OWNER/REPO/pull/123 --preview https://preview.example.com
./scripts/pr-qa logs
./scripts/pr-qa diagnose RUN_ID
```

Le doctor teste l'accès aux dépendances et un navigateur réel ; il ne prouve pas
que toutes les fonctionnalités de la PR ont été testées. Inspecter le contrat,
les omissions, l'outcome, les preuves et la publication réelle sur GitHub.
Remettre la révision déployée, les services sains, la PR/son SHA, le run ID et les
liens vérifiés. En cas de panne, conserver les journaux et volumes, masquer les
secrets ; ne pas lancer de purge Docker globale ni `down -v`.

### 3. Garanties et limites à respecter

La mission nécessite des vérifications concrètes. Ne jamais déclarer comme réussis
un build Docker, un déploiement VPS, une évaluation IA réelle ou une CI distante
non exécutés. Lire [`docs/pr-qa-validation.md`](docs/pr-qa-validation.md).
Conserver la branche du fork et la PR vers son propre `main` ; ne jamais publier
sur upstream ni modifier un autre repository. Les mises à jour du moteur restent
compatibles avec l'architecture Canary et nécessitent des tests de non-régression.
