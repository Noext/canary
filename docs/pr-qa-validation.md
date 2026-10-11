# PR QA validation — 11 October 2026

Implementation in the official `Noext/canary` fork, upstream `0xnyn/canary`, development branch `feat/autonomous-pr-qa`.

## Executed successfully

- Frozen pnpm 9.15.0 dependency installation.
- Build of the daemon, sandbox bundle, native Canary CLI and PR QA app.
- Documentation stitching check and full Ultracite/Biome lint.
- Compilation and all workspace tests: **260 tests passed** across 26 Turbo tasks.
- New PR QA tests: 16 automated checks cover schemas, pinned context, live preview SHA, immutable assertions, stale PRs, skipped-only plans, missing evidence, service authentication, jobs, traversal and interrupted-job recovery.
- Three additional E2E tests passed: a successful form test in **real Chromium**, a deliberately broken UI detected by a failing assertion, and rejection of an unauthorized request on the **actual** authenticated loopback daemon.
- Each form scenario generated one non-empty WebM plus trace ZIP, HAR, console log, screenshots and a native Canary HTML report. Videos were also read with ffprobe (the successful sample has a 2.0-second duration).
- Docker Compose YAML parsed and service/build/volume/local bind settings inspected.

The fixtures use a local GitHub REST server and scripted OpenAI-compatible responses. Browser actions, DOM values, sessions and artifact generation are real. The request fixture confirms the outgoing `pending → success/failure` commit statuses and PR comment payload. These tests do **not** establish a real model's planning quality or the deployed application's live GitHub token permissions.

## Commands and environment adaptations

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @usecanary/pr-qa... build
node scripts/stitch-docs.mjs --check
corepack pnpm exec ultracite check
CANARY_TEST_TCP=1 corepack pnpm exec turbo run compile test --env-mode=loose
CANARY_DAEMON_PORT=18473 CANARY_DAEMON_TOKEN=<test-only-token-of-at-least-32-characters> \
  corepack pnpm --filter @usecanary/pr-qa test:e2e
```

The development environment disallows Unix socket listeners. The native transport remains the default; the optional authenticated loopback transport enabled the real sessions here. `CANARY_TEST_TCP` only selects the transport of the browser CLI's test fake daemon; Turbo's loose mode passes this test flag through. In a normal VPS or GitHub Actions runner use `pnpm check` without those adaptations.

The environment's Playwright CDN returned an invalid HTML response. Matching Chromium 145.0.7632.6 browser/headless-shell archives were obtained from the official `storage.googleapis.com/chrome-for-testing-public` location; the matching Playwright ffmpeg archive came from Microsoft's official Playwright distribution. No browser or model was substituted by a mock.

## Recorded samples

- [Passing video](pr-qa-evidence/passed.webm), [assertion screenshot](pr-qa-evidence/passed.png), [result metadata](pr-qa-evidence/passed.json).
- [Failing video](pr-qa-evidence/failed.webm), [assertion screenshot](pr-qa-evidence/failed.png), [result metadata](pr-qa-evidence/failed.json).

These synthetic test fixtures contain no user credentials. The metadata marks the fixture APIs explicitly.

## Not verified in this environment

- A real LLM endpoint and real application preview: no model credentials or target preview were provided. Configure `.env` and run a real PR to assess generated scenario quality.
- Docker image build/container execution: Docker is not installed here. The Dockerfile and Compose file are supplied, with the configuration inspected; a YAML parse is not a deployment test.
- Native Unix socket execution here: prohibited by this environment. CI on a standard runner is configured to use the native transport and run the E2E suite.

## Extension entreprise — 11 octobre 2026

Sur le checkout local de la branche du fork :

- Suite `pnpm check` exécutée avec Node 22.23.3 : **291 tests passent** ; une suite
  de concurrence PostgreSQL native est explicitement ignorée faute de
  `QA_TEST_DATABASE_URL`. Lint, TypeScript et synchronisation des snippets passent.
- **8 E2E Chromium** passent : doctor, scénario sain, régression réelle,
  authentification daemon, refus d'un état statique, persistance/reload sain et
  défectueux, sous-requête réseau refusée, cookies de rôle installés sans secret IA.
- Tests SQL : production SQL exécuté dans PostgreSQL WASM/PGlite, incluant
  idempotence, leases, annulation, interruption et routes dashboard/SSE/auth.
  Cela ne valide pas les locks multi-process de PostgreSQL natif.
- Proxy egress : HTTP réel autorisé, destination hors liste refusée. La topologie
  réseau Docker et l'installation Compose restent à exécuter par la CI Docker.
- Aucun VPS, serveur PostgreSQL natif, GitHub App réelle, modèle IA réel ou IdP
  n'est accessible dans cette session. Aucun résultat correspondant n'est annoncé.
- Les workflows CI/release sont implémentés ; leur exécution distante et les
  protections de branche ne sont pas attestées par leur présence dans Git.

Les valeurs `NODE_USE_ENV_PROXY=0`, `CANARY_TEST_TCP=1` et le transport daemon
loopback authentifié ont servi uniquement aux contraintes de l'environnement
local (sockets Unix interdits). Les probes E2E sont réelles, mais leurs services
GitHub/IA sont des fixtures REST.
