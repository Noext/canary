# Passe de fiabilisation du fork — 11 octobre 2026

Cette passe couvre l'installation du monorepo, le runtime Canary, la configuration Docker, l'orchestration PR QA, les erreurs, la persistance et les instructions d'exploitation. Le moteur existant reste utilisé. Aucun déploiement VPS ou appel à un modèle réel n'est présenté comme validé.

## Corrections livrées

- Volumes neufs préparés pour l'utilisateur `node` (UID 1000), contexte ESM explicite dans l'image, CLI de diagnostic exécutable et mapping de l'hôte Docker fourni.
- Configuration refusée au démarrage lorsqu'elle est incomplète ; choix du paramètre de tokens OpenAI et température facultative pour les fournisseurs qui ne l'acceptent pas.
- Doctor avec création réelle de preuves Chromium, contrôles du stockage, GitHub, modèle et provenance du SHA ; résumé de support expurgé des secrets et des valeurs de test.
- Historique de phases/actions persistant, identifiants de requête, codes d'erreur et conseils correctifs dans les logs et rapports.
- File bornée même lors de soumissions concurrentes, arrêt contrôlé, absence de rejeu après interruption et santé dégradée en cas de panne de persistance.
- Refus des artefacts pointant hors du run par symlink, des corps HTTP trop grands et des contextes source incomplets utilisés pour justifier un scénario.
- Vérification des versions exactes du runtime Playwright ; message de démarrage indiquant le log à lire.
- Dépendance transitive `fast-copy` corrigée via un override ciblé et le lockfile. L'audit npm/pnpm de production après correction rapporte zéro vulnérabilité connue ; cela ne constitue pas un audit de sécurité exhaustif.
- Publication npm de l'upstream désactivée dans les forks, tests Docker/Compose ajoutés à la CI, wrapper VPS et guide de dépannage.

## Vérifications réellement exécutées

Une copie du source a été exportée sans `.git`, `node_modules`, `dist` ni cache Turbo initial. Node **22.23.3** a été téléchargé depuis nodejs.org et son archive vérifiée contre les sommes SHA-256 officielles. Le lockfile a été installé sans modification, puis les bundles, compilations et tests du monorepo ont été exécutés.

| Vérification | Résultat constaté |
| --- | --- |
| `pnpm install --frozen-lockfile` dans la copie propre | Réussite |
| `pnpm --filter @usecanary/pr-qa... build` | Réussite |
| Compilations/tests Turbo | 26 tâches réussies ; 284 tests automatisés réussis |
| E2E Canary/Chromium séparés | 4 tests réussis : doctor complet avec fixtures, scénario passant, vraie régression UI détectée, rejet d'un token daemon incorrect |
| Lint/format du monorepo | 268 fichiers contrôlés, réussite |
| Synchronisation des docs générées | Réussite |
| Syntaxe Bash/YAML | Wrapper et 11 blocs Bash AGENTS vérifiés ; Compose et les deux workflows parsés |
| Audit des dépendances de production après correction | Zéro vulnérabilité connue signalée |

Commandes de reproduction, après installation du runtime Canary et de Chromium :

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @usecanary/pr-qa... build
corepack pnpm check
corepack pnpm --filter @usecanary/pr-qa test:e2e
corepack pnpm audit --prod
```

L'environnement de validation interdit les sockets Unix ; les tests locaux ont utilisé `CANARY_TEST_TCP=1` et le transport daemon authentifié sur `127.0.0.1:18473`. Docker/VPS conserve le transport natif. Les tests locaux ont aussi désactivé `NODE_USE_ENV_PROXY` pour éviter qu'un avertissement expérimental Node 22 injecté par cet environnement n'altère le stderr d'un test CLI. Le premier passage avait échoué sur cet avertissement ; le passage suivant a réussi. Aucun avertissement produit par l'application n'a été filtré.

Le runtime Chromium **145.0.7632.6** correspondant au Playwright **1.58.2** était déjà installé. Le téléchargement Playwright CDN avait renvoyé une archive invalide dans cet environnement ; les binaires correspondants de Chrome for Testing ont été installés pour permettre les tests. La copie propre valide l'installation des dépendances et la construction du source, mais **ne valide pas un premier téléchargement de Chromium dans l'image Docker**.

Les E2E utilisent les vraies sessions Canary : formulaire rempli et soumis, comparaison indépendante de l'assertion, vidéo WebM, trace, HAR et captures non vides. GitHub REST et les réponses OpenAI sont des fixtures ; les requêtes sortantes de commentaire et de statut sont contrôlées. Ils ne mesurent pas la qualité de planification d'un vrai modèle et ne valident pas les permissions du token qui sera utilisé sur le VPS.

## Tests de panne

Les tests couvrent les réponses 401/403/404/429 avec identifiant fournisseur, les timeouts, les réponses trop grandes, la redaction des secrets, le port occupé, les soumissions concurrentes, le disque plein simulé, l'arrêt avec jobs en attente, la restauration après redémarrage, les chemins/symlinks hors du run, le JSON HTTP malformé et les fichiers source incomplets. Les tests du wrapper utilisent un stub Docker pour contrôler l'ordre des commandes ; ils ne prouvent pas un déploiement.

## Validation restant à exécuter

L'environnement de développement ne possède ni binaire Docker ni daemon Docker. Les deux tests Compose ont été ajoutés et compilés, mais **n'ont pas été exécutés ici**. Sur un runner Docker ou un VPS :

```bash
docker build -f Dockerfile.pr-qa -t canary-pr-qa:test .
CANARY_DOCKER_IMAGE=canary-pr-qa:test corepack pnpm --filter @usecanary/pr-qa test:container
```

Ces tests démarrent des projets Compose isolés avec de nouveaux volumes, vérifient UID 1000, doctor, authentification, un scénario réel Chromium, une régression, les preuves téléchargées, la publication aux fixtures et la persistance après redémarrage. Ils nettoient uniquement leurs volumes de test. Le workflow CI conserve leurs logs en artefact, y compris en cas d'échec. L'ajout d'un workflow ne constitue pas une exécution réussie : consulter les runs GitHub effectifs.

La recette de production exige ensuite `./scripts/pr-qa up`, un doctor sur les services réels et un run sur une PR/preview au SHA attendu, avec vidéo consultable et commentaire/statut réellement publiés. Il manque ici l'accès au VPS, l'endpoint/modèle réel et une preview déployée. Aucune garantie « première installation certifiée » ne doit être annoncée avant cette recette.

## État après l'extension entreprise

Les nombres et limites ci-dessus décrivent une validation antérieure. L'état courant
est suivi dans [pr-qa-validation.md](pr-qa-validation.md) et la [PR du fork](https://github.com/Noext/canary/pull/1).
Le système utilise maintenant PostgreSQL, des workers et un browser/proxy isolés,
un dashboard privé SSE et les contrôles détaillés dans
[pr-qa-enterprise.md](pr-qa-enterprise.md). Le doctor en ligne contrôle également
la connexion PostgreSQL, la version de migration et la lecture des jobs.
