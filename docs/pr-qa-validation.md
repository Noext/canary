# Refonte des sources du dashboard (PR dédiée après #5)

La branche `refactor/typed-dashboard` remplace les blocs HTML/CSS/JavaScript
stockés dans des chaînes par des sources séparées et du TypeScript contrôlé.
Validation locale : `pnpm check` (26 tâches, 328 tests réussis, trois PostgreSQL
natif ignorés), build de production, commande `dev -- --help` et 14 E2E Chromium.
Les E2E vérifient les parcours login/App/catalogue/préflight/lancement/SSE,
les assertions et les vraies vidéos, ainsi que les vues 1440/390 px. GitHub
et IA sont des fixtures pour cette suite. Les tests contrôlent les ressources
servies, la CSP sans inline et les IDs du template. CI/Docker de cette révision :
consulter la PR ; aucun déploiement sur le VPS utilisateur revendiqué.

# Journal de validation PR QA

Implementation in the official `Noext/canary` fork, upstream `0xnyn/canary`, development branch `feat/autonomous-pr-qa`.

## Dashboard guidé — 12 octobre 2026

Branche `feat/guided-qa-dashboard`, basée sur le main du fork après fusion de la
PR #3. L'accueil, les réglages, le formulaire et la lecture des résultats sont
refondus ; le moteur Canary et les données existantes restent réutilisés.

- Vérifications locales : lint, TypeScript, **325 tests** et **14 E2E Chromium**.
- Parcours UI réellement exercés : accueil et prochaine action, App GitHub,
  connexion locale/technique, modèle explicite, préflight avant lancement,
  SSE/annulation, restrictions viewer et lecture d'un rapport avec assertions
  et vidéo servie par l'API. Layouts à 1440 px et 390 px inspectés.
- SQL : préflight sans enqueue, génération IA ni publication ; provenance de
  preview manquante et compte viewer refusés ; statut sans credentials exposés.
- Les captures dans `docs/images` viennent des E2E avec des données fictives.
  GitHub/IA sont des fixtures ; Chromium et les vidéos sont réels.
- Les validations CI/Docker de cette révision sont documentées dans sa PR.
  Aucune mise à jour du VPS utilisateur n'est revendiquée.

## GitHub App depuis l’UI — 12 octobre 2026

Développements sur `feat/github-app-onboarding`, depuis le main du fork après
fusion de la PR #2. Le parcours reprend le mécanisme Manifest officiel utilisé
par [Proval](https://github.com/seoes/proval), avec credentials serveur et
sélection explicite des dépôts.

- `pnpm check` local : lint, TypeScript et **323 tests** passent ; les trois
  tests PostgreSQL natif sont ignorés faute de serveur local.
- **13 E2E Chromium locaux** passent. Le nouveau cas effectue le formulaire de
  création, la conversion/callback, l'installation, la sélection puis une QA
  navigateur avec vidéo, Check/statut/commentaire via une App, sans PAT.
- Le navigateur et les interactions sont réels ; GitHub et le modèle de ce test
  sont des API fixtures. Aucune App réelle n'a été créée par cet essai.
- Régressions SQL : callback lié à l’admin et usage unique/expiration, chiffrement
  et erreur après changement du secret, sélection/permissions/retrait du dépôt,
  rechargement des credentials et webhook signé avec le secret issu du manifest.
- Régressions de la revue/CI : le login technique renvoie les dépôts avant
  affichage du formulaire ; le worker conserve les credentials App jusqu'à la
  réparation après annulation ; les forks publics non installés sont lus sans
  token et leurs écritures restent interdites. Ces trois cas échouaient avant
  correctif, puis passent en local.
- La [première CI de la PR #3](https://github.com/Noext/canary/actions/runs/38246780573)
  a échoué dans l'E2E de login technique (formulaire masqué). Le correctif est
  poussé sur la même branche ; les validations Docker ci-dessous attendent sa CI.
- Un troisième test Compose démarre sans PAT, configure l’App, redémarre
  API/worker et exécute une QA publiée avec les credentials persistés.
  **Son résultat attend la CI : Docker n'est pas disponible localement.**
- L'installation de l’App sur GitHub réel et le déploiement de cette version
  sur le VPS utilisateur restent à vérifier après mise à jour.

Les preuves historiques de moteur/corpus IA ci-dessous restent attachées à
leurs révisions d’origine ; elles ne remplacent pas la validation de ce parcours.

## État actuel — 12 octobre 2026

Cette section remplace les limites historiques des premières versions consignées
plus bas. Révision du code vérifiée : `7dfd38cc8e56842f6bb7e5bd4bcbba0bd96473c2`.
Les mises à jour ultérieures de documentation ne constituent pas un nouveau
run sur un VPS utilisateur.

- Local : **317 tests**, lint et TypeScript passent ; deux tests PostgreSQL natif
  ignorés faute de serveur local. **11 E2E Chromium réels** passent.
- CI [push](https://github.com/Noext/canary/actions/runs/38226619325) et
  [PR](https://github.com/Noext/canary/actions/runs/38226625266) : success,
  **319 tests** avec PostgreSQL natif, **10 E2E Chromium + 1 test TCP ignoré**,
  build Docker et **2 tests Compose** avec volumes neufs, doctor, worker/browser
  réels, vidéos et persistance après redémarrage. Audit sans vulnérabilité connue.
- Endpoint réel `https://ai.noext.fr/v1`, uniquement
  `opencode-go/deepseek-v4.1-flash` : catalogue authentifié de 48 modèles avec
  défaut disponible, refus 401 sans authentification et clé non exposée.
- Corpus IA final : **4/4 résultats attendus**, 1 répétition et 1 scénario maximum
  par cas ; formulaire sain passé, formulaire cassé, texte leurre et sortie
  inchangée échoués. Quatre vidéos non vides, traces/HAR/screenshots produits,
  42 607 tokens déclarés ; coût indisponible faute de tarifs configurés.
  GitHub et previews sont des fixtures locales et `publish=false` pour ce corpus.
  Le petit corpus ne garantit pas la qualité sur toutes les applications.
- Les neuf findings Codex sont corrigés avec non-régression. Les cinq dernières
  régressions échouaient avant correctif : captures par URL encodée, annulation
  après publication, réserve de coût, captures doctor et pagination des commentaires.

Restent non validés : déploiement sur le VPS de l'utilisateur, installation et
permissions d'une App GitHub réelle, IdP d'entreprise, image de release publiée,
activation des protections de branche et restauration de sauvegardes sur VPS.
L'opérateur doit fournir des credentials actifs et des previews réelles au bon SHA.
Les premiers essais IA bloqués ont servi aux corrections ; seuls les résultats
finalement exécutés sont présentés comme réussis. Détails dans la
[PR du fork](https://github.com/Noext/canary/pull/1).

## Historique — premières validations du 11 octobre 2026

Les sections suivantes décrivent leur révision d'origine ; leurs limites ne
remplacent pas l'état actuel ci-dessus.

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

### Résultats effectivement exécutés

- Checkout local Node 22.23.3 : `pnpm check` passe avec **300 tests** ; le test
  PostgreSQL natif est ignoré localement faute de serveur natif. Lint, compilation
  TypeScript et snippets synchronisés passent.
- **11 E2E Chromium locaux passent** : doctor complet, formulaire sain, vraie
  régression UI, daemon authentifié, refus d'un état statique, persistence/reload,
  sous-requêtes interdites, rôle cookie, download/popup réels, comparaison visuelle
  et dashboard interactif avec login/list/SSE/annulation.
- JWT RSA et renouvellement des tokens App, HMAC et déduplication webhook, attente
  d'une preview au SHA, SQL PostgreSQL WASM/PGlite, leases et propriété avant
  publication sont testés. L'export réel OTLP HTTP `/v1/traces` est reçu par un
  collecteur local ; son nom de service et ses IDs sont corrélés à `progress.json`.
- Audits des dépendances de production et du lock npm du runtime embarqué :
  **aucune vulnérabilité connue signalée** après mise à jour OpenTelemetry.
- La [CI du commit 9b85849](https://github.com/Noext/canary/actions/runs/38175740357)
  a terminé avec **success** : installation pnpm frozen, audit, lint/compile/tests,
  PostgreSQL natif avec 50 claims concurrents et injection de panne, E2E Chromium,
  construction Docker et **deux tests Compose de première installation**.
  Les tests Compose créent de nouveaux volumes, contrôlent UID 1000, doctor,
  soumission via l'API et traitement par le worker/broker, preuves non vides,
  refus HTTP des HAR/ZIP bruts, scénario passant, régression détectée, publication
  aux fixtures GitHub et persistance du résultat après redémarrage de l'API.
- Les premiers runs CI ont réellement échoué : accès aux HAR/ZIP contraire à la
  politique par défaut, puis résolution DNS tentée depuis le navigateur isolé.
  Les tests et la délégation DNS au proxy ont été corrigés avant le run vert.

### Portée et limites

GitHub et IA sont des fixtures REST dans ces tests ; Chromium, formulaires,
artefacts, dashboard, PostgreSQL natif, build et containers Docker sont réels.
Les tests ne mesurent pas la qualité de planification d'un modèle réel.

Aucun endpoint IA réel, GitHub App installée, IdP d'entreprise ou VPS n'a été fourni.
Le corpus `scripts/evaluate.ts` est exécutable avec un endpoint réel ; aucune
évaluation live n'est revendiquée. Aucun déploiement VPS, image de release publiée
ou protection de branche activée n'est annoncé.

Les adaptations locales `NODE_USE_ENV_PROXY=0`, `CANARY_TEST_TCP=1` et le daemon
loopback authentifié répondent aux contraintes du poste local (sockets Unix
interdits). La CI utilise le transport natif et ignore le seul test négatif dédié
au transport TCP lorsque ce transport n'est pas configuré.

Le [commit 9b7b354](https://github.com/Noext/canary/actions/runs/38176472890)
a également passé la CI complète : **301 tests**, **10 E2E Chromium** et les
**2 tests Compose**. Le test de concurrence ne suppose plus l'ordre des claims.

Un contrôle supplémentaire a révélé que la sandbox HTML opaque empêchait
l'authentification des sous-requêtes vidéo. Le rapport principal statique conserve
maintenant son origine avec scripts interdits ; les rapports natifs gardent leur
sandbox opaque. L'E2E étendu contrôle le login, les droits viewer, la lecture réelle
du WebM après une navigation depuis un autre site et un clic sur les contrôles,
le refus d'un script injecté et le refus d'une mutation cross-site. Le test OTLP
force uniquement son sampler de fixture pour ignorer le taux de sampling du poste. Le résultat
de la CI du commit final est consigné dans la PR.

## Correctifs après revue Codex — 12 octobre 2026

Les quatre findings sur `3e12031` ont été reproduits avant correction : cinq
assertions de régression échouaient (publication, réponse de commentaire perdue,
filtre de dépôt, proxy WS et deliveries distinctes du même SHA).

Le statut GitHub précède désormais le commentaire ; une réponse de commentaire
perdue déclenche une réparation du commentaire Bot. Les filtres SQL normalisent
la casse. Les upgrades WS/WSS conservent les contrôles DNS/IP et utilisent TLS
avec l'hôte d'origine pour WSS. Inbox et queue dédupliquent par dépôt/PR/SHA.
Des limites horaires SQL partagées par les workers bornent les runs automatiques
(60 par déploiement, 20 par dépôt par défaut), avec audit des refus et reruns
explicites disponibles.

Les 28 tests ciblés passent localement, avec un échange réseau WS et une
connexion TLS WSS réelle utilisant uniquement une CA de fixture. La suite native
PostgreSQL vérifie 12 livraisons concurrentes, 12 tentatives du même run et
12 dépassements concurrents du quota ; son exécution distante et la CI du commit
correctif sont documentées dans la PR, après lecture des résultats.

Après installation des archives officielles Chromium/ffmpeg attendues par
Playwright, `pnpm check` passe localement : 306 tests, avec les deux tests
PostgreSQL natif ignorés faute de serveur local. TypeScript et lint passent.

Le premier run Compose du correctif `efbd4e7` a détecté une incohérence du doctor :
la migration inscrivait la version 3, mais la probe PostgreSQL attendait encore 2.
La version attendue est maintenant partagée avec la migration (`SCHEMA_VERSION`).
Un test SQL vérifie que le doctor accepte le schéma migré et refuse l'ancien.
Après correction, `pnpm check` passe localement avec 307 tests ; le résultat de la
CI finale, y compris Compose, est consigné dans la PR.
