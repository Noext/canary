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

## Frontend PR QA : règles de contribution

- Le dashboard est une application React 19 + Vite dans `apps/canary-pr-qa-ui`
  (`@usecanary/pr-qa-ui`) : composants, hooks, TypeScript strict, Tailwind v4,
  tests Vitest + Testing Library. Aucune écriture DOM impérative
  (`getElementById`, `textContent =`, `innerHTML`) et aucun bloc HTML/CSS
  applicatif dans des chaînes TS.
- `apps/canary-pr-qa` embarque le build Vite à la compilation
  (`scripts/ui-assets.mjs`, chargeur esbuild `?ui`) : `dist/cli.js` reste
  auto-contenu et les assets sont servis sous `/dashboard/assets/*`. Ne pas
  ajouter d'étape Docker ni de fichier statique à copier ; lancer
  `pnpm --filter @usecanary/pr-qa-ui build` avant de reconstruire `pr-qa` seul.
- Toute réponse serveur passe par `src/api/client.ts` (schémas Zod dans
  `src/api/schemas.ts`) et tout texte visible vient de `src/i18n.ts`. Un
  changement de contrat HTTP se répercute des deux côtés
  (`apps/canary-pr-qa/src/dashboard/contracts.ts` et
  `apps/canary-pr-qa-ui/src/api/contracts.ts`).
- Conserver les `id` et les libellés français assertés par l'e2e Chromium
  (`apps/canary-pr-qa/test/e2e.test.ts`) et `test/sql.test.ts`.
- Garder la CSP sans `unsafe-inline` : pas de `<style>` ni d'attribut `style=`
  en ligne, pas de script inline, et pas de dépendance ajoutée pour contourner
  un défaut de structure.
- Exécuter `pnpm check`, le build PR QA et les E2E avant livraison ; vérifier la
  CI Compose pour les changements au pipeline de ressources. Lire la section
  Frontend du README pour les source maps et diagnostics.

## Instructions aux agents : installation PR QA en production sur VPS

Cette section est la procédure de première installation du fork `Noext/canary`.
Les détails des fonctionnalités se trouvent dans
[`apps/canary-pr-qa/README.md`](apps/canary-pr-qa/README.md), et les procédures
opérationnelles dans [`docs/pr-qa-operations.md`](docs/pr-qa-operations.md).
Lire aussi `.env.example`, `docker-compose.yml` et `Dockerfile.pr-qa`.

### 1. Vérifier l'hôte et le périmètre

- Utiliser le VPS et le compte SSH fournis par l'utilisateur. Sans cet accès,
  préparer les fichiers et signaler ce qui manque ; ne pas annoncer un déploiement.
- Prévoir pour démarrer 8 Go de RAM, 4 vCPU et 30 Go libres ; mesurer la charge
  réelle avant d'ajouter des workers. L'installation Compose a été testée en CI,
  pas sur le VPS de l'utilisateur. Consulter le
  [journal de validation](docs/pr-qa-validation.md).
- Vérifier `git`, `curl`, `openssl`, Docker Engine et le plugin Compose >= 2.20 :

```bash
uname -m
df -h
free -h
git --version
curl --version
openssl version
docker version
docker compose version
```

Sur Ubuntu/Debian, si les outils de base manquent :

```bash
sudo apt-get update
sudo apt-get install -y git curl openssl procps
```

Les commandes supposent que le compte a accès à Docker. Utiliser `sudo docker`
si c'est le mode d'accès prévu sur le VPS. Si Docker manque, suivre le dépôt
Docker officiel pour [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
ou [Debian](https://docs.docker.com/engine/install/debian/), avec le plugin Compose.
Ne pas remplacer une installation utilisée par d'autres applications.
**Node, pnpm et Chromium ne sont pas à installer sur le VPS : l'image les fournit.**

Ne jamais pousser sur `0xnyn/canary`, ouvrir une PR upstream, forcer un push ou
modifier d'autres repositories. Garder les développements sur le fork et ses PR
vers son propre `main`. Les commandes suivantes doivent rester dans le même
répertoire et le même projet Compose ; ne pas arrêter les services d'autres projets.

### 2. Cloner la branche livrée

Dans un répertoire dédié appartenant au compte de déploiement :

```bash
git clone --branch main https://github.com/Noext/canary.git canary-pr-qa
cd canary-pr-qa
git remote add upstream https://github.com/0xnyn/canary.git
git remote set-url --push upstream DISABLED
git rev-parse HEAD
git status --short
```

Le dashboard guidé est disponible dans `main`. La refonte de ses sources est
proposée dans `refactor/typed-dashboard` avant fusion.
Après fusion, utiliser le `main` de votre fork pour la production. Pour un clone existant, inspecter
ses remotes et changements locaux ; préserver `.env` et `config/`. Ne pas employer
`reset --hard` ou écraser des changements locaux. Un nom de projet Compose
personnalisé peut être fixé avec `COMPOSE_PROJECT_NAME` dans `.env` ; le conserver
pour toutes les opérations afin de retrouver les mêmes volumes.

### 3. Préparer la configuration obligatoire

Créer `.env` uniquement si ce fichier n'existe pas déjà :

```bash
test -f .env || cp .env.example .env
chmod 600 .env
```

Générer **trois secrets distincts** avec `openssl rand -hex 32` pour
`QA_API_TOKEN`, `QA_DB_PASSWORD` et `QA_BROWSER_SERVICE_TOKEN`. Conserver le mot
de passe PostgreSQL en hexadécimal pour son URL. Ne jamais afficher les secrets
dans un rapport, les committer ou les placer dans un commentaire GitHub.

Renseigner au minimum :

| Variable | Valeur / action |
| --- | --- |
| `QA_API_TOKEN` | Secret fort pour l'amorçage administrateur du dashboard |
| `QA_DB_PASSWORD` | Secret hexadécimal PostgreSQL ; Compose assemble `DATABASE_URL` |
| `QA_BROWSER_SERVICE_TOKEN` | Secret distinct pour les commandes du navigateur isolé |
| `GITHUB_ALLOWED_REPOS` | Facultatif : restriction serveur ; vide pour sélectionner les dépôts installés depuis l’UI |
| `GITHUB_TOKEN` | Laisser vide pour le parcours GitHub App du dashboard |
| `OPENAI_BASE_URL` | `https://ai.noext.fr/v1` pour l'endpoint fourni par l'utilisateur |
| `OPENAI_API_KEY` | Clé active fournie par l'opérateur ; ne pas réutiliser une ancienne clé temporaire de test |
| `OPENAI_MODEL` | **`opencode-go/deepseek-v4.1-flash`** |
| `QA_ALLOWED_PROVIDER_HOSTS` | `ai.noext.fr` ; toute politique fournisseur du dépôt testé doit également autoriser ce host |
| `PREVIEW_ALLOWED_HOSTS` | Hôtes exacts nécessaires aux previews, API, images, polices et WebSockets, avec les ports non standards ; remplacer l'exemple |
| `ARTIFACT_BASE_URL` | Origine HTTPS du dashboard si les rapports doivent être accessibles depuis les liens GitHub ; pas de suffixe `/artifacts` |

Le modèle par défaut est un choix explicite de l'utilisateur. **Ne jamais le
remplacer ou choisir un autre modèle de sa propre initiative**, y compris pendant
un test ou une évaluation IA réelle. Les IDs fictifs des tests automatisés
servent à tester le protocole et ne sont pas des appels à un autre modèle réel. Le dashboard récupère le catalogue via `/v1/models`
côté serveur ; la clé ne part pas dans le navigateur. Si le défaut manque, le
lancement attend un choix explicite. Le modèle choisi est conservé dans le job.
`QA_ALLOWED_MODELS` peut restreindre le catalogue avec une liste d'IDs exacts.

L'endpoint IA est protégé par Cloudflare : vérifier l'accès depuis le VPS/worker
et autoriser son IP de sortie chez le fournisseur si nécessaire. L'IP utilisée
pendant les tests ChatGPT n'est pas celle de votre VPS. Un 403 doit être diagnostiqué,
pas contourné en changeant de fournisseur ou de modèle. Les tarifs
`QA_INPUT_COST_PER_MILLION` / `QA_OUTPUT_COST_PER_MILLION` doivent être renseignés
pour activer les estimations et réserves de coût ; les budgets de tokens et de
temps restent actifs même sans tarif.

#### GitHub App depuis le dashboard

Après démarrage et création du compte local admin, utiliser la section GitHub :
Créer mon App sur GitHub → confirmer sur GitHub → Installer/gérer les dépôts →
Actualiser → cocher les dépôts → Enregistrer. Compte personnel par défaut,
organisation facultative. GitHub crée une vraie App privée appartenant à
l'opérateur, avec permissions/webhook/callbacks préremplis. Aucun PAT, ID
installation ou PEM à configurer dans `.env` pour ce parcours.

Configurer l'origine publique HTTPS dans `ARTIFACT_BASE_URL` et rendre les
callbacks `/github/app/callback`, `/github/app/installed` et `/github/webhook`
joignables derrière le proxy/WAF. Le service peut démarrer avec GitHub non
connecté ; doctor indique alors un contrôle sauté. Ne pas l'annoncer validé.
Après connexion, relancer doctor et un run réellement publié.

Les clés sont chiffrées en PostgreSQL ; préserver `QA_API_TOKEN` avec la DB
(le HKDF en dérive la clé AES-GCM). Ne pas le régénérer lors d'une mise à jour
ou d'une restauration : ce n'est pas une rotation transparente. Les workers
relisent la sélection et synchronisent les installations chaque minute.
`GITHUB_ALLOWED_REPOS`, si renseigné, reste un plafond serveur. L'App gérée par
l'UI a priorité sur l'ancien PAT. Les modes techniques historiques restent
compatibles et documentés dans `.env.example` et le README.

Pour retirer la connexion, utiliser le bloc « Supprimer la connexion GitHub » :
« Désinstaller l'App de mes dépôts » révoque les installations sur GitHub
(l'App reste dans vos réglages et reste réinstallable), tandis que « Supprimer
l'App GitHub » supprime l'App et ses installations de façon irréversible
(`DELETE /github/app` avec `{"deleteApp":true}`). Les deux effacent les
credentials chiffrés, les installations, la sélection et les callbacks en
attente, avec audit `github.app.disconnected` ; un refus GitHub est renvoyé comme
avertissement sans bloquer le nettoyage local. Ne pas annoncer une App supprimée
sur GitHub si l'API a répondu par un avertissement : vérifier dans les réglages
GitHub et terminer à la main.

#### Préconditions des previews

Chaque preview doit correspondre au SHA complet de la PR et exposer soit
`x-commit-sha`, soit `{"sha":"<SHA complet>"}` à `PREVIEW_SHA_PATH`. Cette preuve
est vérifiée même avec un déploiement GitHub réussi. Ne jamais inventer le SHA.
Donner une URL explicite au run ou configurer `PREVIEW_URL_TEMPLATE` ; sinon le
service cherche un déploiement réussi de la PR au bon SHA/environnement.

Si la preview utilise des IP privées, `QA_ALLOW_PRIVATE_PREVIEWS=true` nécessite
une liste d'hôtes précise. Ne jamais y autoriser les services de contrôle ou des
endpoints de métadonnées. Pour une interface nécessitant un login, configurer les
rôles/storage states et les fixtures de test de confiance via
`config/fixtures.example.json` et `QA_FIXTURES_FILE=/app/config/fixtures.json`.
Ne pas deviner de comptes de production. Le README détaille ces préconditions.

### 4. Construire et démarrer les cinq services

Après avoir rempli `.env` :

```bash
docker compose config --quiet
./scripts/pr-qa up
./scripts/pr-qa status
./scripts/pr-qa doctor --pr https://github.com/OWNER/REPO/pull/123 --preview https://preview.example.com
```

Remplacer les deux URLs par la PR et la preview réelles fournies. Le wrapper
construit l'image, vérifie la configuration, attend les services puis lance le
doctor depuis le worker. **Le doctor valide les dépendances et un smoke test
Chromium ; il ne lance pas la QA fonctionnelle complète de cette PR.** Il peut
faire une petite requête IA facturable, exclusivement avec le modèle configuré.
Une vérification sautée avec `--offline` / `--skip-browser` reste non validée.

| Service | Rôle |
| --- | --- |
| `pr-qa` | API et dashboard privé sur le port local 8787 par défaut |
| `worker` | Planification, contrats, exécution et publication |
| `browser` | Moteur Canary, Chromium et sessions, sans clé IA/GitHub |
| `egress` | Proxy avec contrôles de destinations et DNS/IP épinglés |
| `db` | PostgreSQL, file durable, leases, inbox et audit |

Le navigateur est isolé sur un réseau Docker interne. Le déploiement garde trois
volumes : `qa-data`, `canary-sessions`, `qa-db`. `config/` est monté en lecture
seule. Vérifier que les fichiers de configuration nécessaires sont lisibles par
l'UID 1000 sans rendre les clés accessibles à tous.

### 5. Accéder au dashboard et vérifier un vrai run

Compose expose le dashboard uniquement sur `127.0.0.1` du VPS. Depuis votre poste :

```bash
ssh -N -L 8787:127.0.0.1:8787 deploy@VPS
```

Remplacer le compte/hôte, puis ouvrir `http://127.0.0.1:8787/`. Pour une URL publique,
configurer un reverse proxy HTTPS vers ce port, conserver le host et le protocole
transmis et désactiver le buffering SSE. Ne pas exposer PostgreSQL ou le navigateur.
Les webhooks GitHub nécessitent cette URL HTTPS joignable. Les rapports restent
privés ; `ARTIFACT_PUBLIC` n'active pas d'accès anonyme dans le serveur SQL.

Après la première installation ou une mise à jour de l'ancien écran token,
générer le lien privé de création d'administrateur (remplacer l'origine HTTPS) :

```bash
docker compose exec -T pr-qa canary-pr-qa setup-admin --origin https://votre-domaine-qa
```

Ouvrir ce lien sous 15 minutes et créer l'identifiant/mot de passe (minimum
12 caractères). Ensuite, utiliser la connexion locale ; aucun SSO n'est requis.
La commande doit être exécutée par l'opérateur du VPS, pas par un visiteur du
site. Après création, la première installation est fermée définitivement.
Le lien n'apparaît pas dans les paramètres de requête serveur et l'UI efface son
fragment ; ne pas partager ce lien dans les logs/rapports ou GitHub.

`QA_API_TOKEN` reste requis pour les fonctionnalités techniques/API existantes,
mais n'est plus le login principal. La migration ajoute les tables de comptes et
sessions sans supprimer les jobs ou les volumes. Pour un mot de passe oublié,
suivre `reset-password` via stdin dans le README ; les sessions sont révoquées.
Les anciens tokens/JWT se trouvent dans « Accès technique (API / SSO) ».
Pour les identités techniques individuelles,
copier `config/users.example.json` vers `config/users.json`, configurer les hashes
SHA-256 des tokens et les dépôts autorisés, puis
`QA_USERS_FILE=/app/config/users.json`. Le README documente aussi les JWT OIDC.

Dans le dashboard, l'Accueil indique la prochaine action selon les connexions
réelles. Utiliser Réglages pour GitHub et l'accès au catalogue IA, puis Nouveau
test. Renseigner la PR, l'application à tester et le modèle explicite ; cliquer
Vérifier les accès. Cette étape ne génère pas de contenu IA, ne lance pas de
scénario et ne publie rien. Elle vérifie seulement PR, catalogue et provenance
exacte de la preview. Une vérification réussie ne valide pas la fonctionnalité.

Lancer le test après la vérification. L'Historique présente phases, verdicts,
assertions et vidéos ; les données JSON/run ID sont dans le diagnostic replié.
Les vidéos sont finalisées après le scénario. Vérifier le rapport et la
publication sur le SHA effectivement testé. La configuration et les comptes
existants sont conservés ; aucune nouvelle première installation n'est requise.

Remettre à l'utilisateur la révision déployée, les services sains, la PR et son
SHA, le run ID, le modèle, l'outcome et les liens réellement vérifiés. Distinguer
`passed`, `failed`, `blocked`, `stale`, `skipped` et les travaux interrompus.

### 6. Diagnostiquer sans perdre les preuves

```bash
./scripts/pr-qa status
./scripts/pr-qa doctor --json
./scripts/pr-qa logs
./scripts/pr-qa diagnose RUN_ID
docker compose logs --tail=100 db worker browser egress pr-qa
```

Remplacer `RUN_ID` par le UUID reçu au lancement. Le résumé de support masque les
secrets et évite le DOM, les valeurs saisies et les cookies. Partager ce résumé
avant les captures brutes. Les traces/HAR/logs natifs sont refusés par défaut via
HTTP ; `QA_RAW_EVIDENCE=true` n'est à activer qu'après contrôle des données de test.

Vérifier dans l'ordre la configuration, SQL et sa migration, le worker/sa lease,
IA/GitHub, la provenance de la preview, Chromium puis le proxy egress. Une lease
expirée est interrompue, jamais rejouée automatiquement. Pour des captures du
moteur, consulter le service `browser` : les captures temporaires du doctor sont
supprimées après vérification. Les codes et procédures ciblées sont dans le
[guide de dépannage](docs/pr-qa-operations.md).

### 7. Mettre à jour, arrêter et sauvegarder

Suspendre les nouvelles soumissions et les webhooks avant une mise à jour.
Attendre que la file soit vide et qu'aucun run ne soit actif ; préserver `.env`,
`config/` et les trois volumes. Sur un clone propre de la branche de déploiement :

```bash
git fetch origin main
git merge --ff-only origin/main
./scripts/pr-qa up
```

Arrêt sans suppression : `./scripts/pr-qa stop`. Ne jamais utiliser `down -v`,
une purge Docker globale ou supprimer les volumes pour résoudre un incident.
Les données et la DB doivent être sauvegardées ensemble ; les sauvegardes et les
fichiers de configuration contiennent des secrets/données de test. Le
[guide d'exploitation](docs/pr-qa-operations.md) donne les commandes de sauvegarde
et les précautions de restauration dans un projet Compose isolé.

### 8. Limites de validation et règles des agents

Les validations Docker/Chromium/SQL en CI et le corpus IA réel sont décrits dans
[`docs/pr-qa-validation.md`](docs/pr-qa-validation.md). Elles ne constituent pas
un déploiement sur votre VPS ni une preuve des permissions de votre propre App.
Ne jamais annoncer comme validé un déploiement, un build, une CI, une publication
GitHub ou une évaluation IA qui n'a pas réellement été exécuté et inspecté.
Ne pas désactiver les contrôles de contrat/couverture/provenance pour obtenir
un résultat vert. Conserver le moteur Canary, sa relation de fork et ses sessions ;
toute correction du moteur nécessite des tests de non-régression.
