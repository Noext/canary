# Exploitation et dépannage PR QA

La procédure complète de première installation est dans [AGENTS.md](../AGENTS.md).
Le [README de l'application](../apps/canary-pr-qa/README.md) détaille les variables,
GitHub App, les identités, les fixtures et les modèles. La topologie de production
utilise cinq services : `pr-qa`, `worker`, `browser`, `egress`, `db`. Docker Engine
et Compose >= 2.20 suffisent sur l'hôte ; Node/Chromium sont fournis dans l'image.

## Démarrer et suivre

Depuis le checkout de la branche de déploiement, préserver une configuration
existante ; les exemples ne contiennent pas vos secrets :

```bash
test -f .env || cp .env.example .env
chmod 600 .env
# Remplir les secrets, les dépôts autorisés et les hôtes de preview avant up.
./scripts/pr-qa up
./scripts/pr-qa doctor --pr https://github.com/OWNER/REPO/pull/123 --preview https://preview.example.com
./scripts/pr-qa status
./scripts/pr-qa logs
```

Remplacer les URLs par les cibles réelles. `up` construit l'image, vérifie la
configuration, attend la santé des services puis lance le doctor depuis le
worker. Une erreur renvoie un code non nul. `doctor` contrôle stockage, SQL,
Chromium et ses preuves, GitHub et une réponse JSON du modèle ; il ne publie pas
sur GitHub et ne joue pas les scénarios fonctionnels de cette PR. Sans `--pr`,
la provenance de sa preview n'est pas vérifiée. `--offline` / `--skip-browser`
signalent explicitement les contrôles sautés.

Ouvrir `/` via tunnel SSH ou reverse proxy HTTPS. Le dashboard montre les phases
et actions par SSE à `/runs/:id/events`, les diagnostics et les preuves. Le modèle
est sélectionné via le catalogue `/models` authentifié, alimenté par le
`/v1/models` du fournisseur. Le défaut est `opencode-go/deepseek-v4.1-flash` ;
aucun modèle de remplacement n'est choisi automatiquement. Chaque job conserve
son modèle. Les vidéos sont consultables après finalisation, pas en streaming live.

Prometheus est disponible à `/metrics` avec les droits admin. L'export OTLP
nécessite un collecteur externe configuré. Le résultat contient tokens et coût
estimé ; configurer les tarifs pour la réserve de coût avant les appels IA.
Les limites de temps/tokens restent actives sans tarifs. Un autre modèle choisi
explicitement n'hérite pas des tarifs du défaut.

## Diagnostiquer un run

```bash
./scripts/pr-qa diagnose UUID_DU_RUN
./scripts/pr-qa doctor --json
./scripts/pr-qa status
docker compose logs --tail=100 db worker browser egress pr-qa
```

Utiliser le UUID reçu au lancement. Le résumé de support donne phase, erreur,
assertions et compteurs de preuves sans DOM, valeurs saisies ou cookies, et
masque les secrets configurés. Partager ce résumé avant les captures brutes.
Les logs portent run ID, request ID, phase/action, durée et diagnostics.

| Emplacement | Utilité |
| --- | --- |
| PostgreSQL `qa_jobs` | File et statut durable ; `completed` ne signifie pas assertions réussies |
| `GET /runs/:id` | Statut SQL, outcome, modèle du job et progression |
| `/data/<run-id>/progress.json` | Dernière phase/action, séquence et diagnostic |
| `/data/<run-id>/events.jsonl` | Historique ordonné des événements |
| `/data/<run-id>/result.json` | Résultat agrégé, contrat, assertions, usage et publication |
| `/data/<run-id>/report.html`, `report.md` | Rapport principal et liens vers les preuves |
| Sous-dossiers de scénario | Vidéo WebM, trace ZIP, HAR, console, screenshots et rapport Canary natif |
| PostgreSQL `qa_audit` | Accès, suppressions et refus de quota automatique |
| PostgreSQL `qa_deliveries` | Inbox webhook, déduplication et attente de preview |

`job.json` concerne les jobs legacy sur disque : la file de production est en SQL.
Les fichiers natifs `results.json` de chaque session ne sont pas le `result.json`
agrégé. Les profils/sessions natives sont purgés après export réussi. Les captures
provisoires du doctor sont supprimées après vérification, même en cas d'erreur.

Les artefacts HTTP nécessitent un utilisateur autorisé ou un lien signé valable
5 minutes. `ARTIFACT_PUBLIC` n'active pas la lecture anonyme dans le serveur SQL.
Les traces/HAR/logs et rapports natifs imbriqués sont refusés par défaut ; le
rapport principal et ses vidéos/images sont accessibles selon les droits du projet.
N'activer `QA_RAW_EVIDENCE=true` qu'après contrôle des données de test. Les chemins
encodés sont normalisés avant la politique ; les encodages ambigus sont refusés.

## Erreurs et vérifications ciblées

| Code / symptôme | Vérification |
| --- | --- |
| `CONFIG_INVALID` | Secrets distincts, GitHub/App, allowlists exactes, endpoint et modèle, placeholders remplacés |
| Catalogue indisponible / `MODEL_CATALOG_INVALID` | Base `/v1`, réponse JSON `data:[{id}]`, accès serveur au fournisseur/Cloudflare |
| `MODEL_NOT_AVAILABLE`, `MODEL_NOT_ALLOWED` | Actualiser le catalogue (cache 30 s), vérifier `QA_ALLOWED_MODELS` ; attendre un choix explicite |
| `HTTP_401`, `HTTP_403` | Token actif, permissions/App/dépôts ; pour l'IA Cloudflare, autoriser l'IP de sortie du VPS/worker |
| `HTTP_404` | Route fournisseur `/v1/chat/completions`, PR/dépôt accessibles au token, preview disponible |
| `HTTP_429` | Quota fournisseur ; ne pas multiplier les soumissions ou rejouer les publications aveuglément |
| `WEBHOOK_RATE_LIMIT` | `qa_audit` / inbox `rate_limited`, compteurs horaires globaux/par dépôt ; un rerun manuel nécessite une décision explicite |
| `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `TIMEOUT` | Adresse/port/DNS Docker et disponibilité de la dépendance concernée |
| SQL/migration en erreur | Logs `db` puis `pr-qa`, mot de passe et volume conservé ; le doctor vérifie la version supportée du schéma |
| `PREVIEW_SHA_MISMATCH` | SHA complet de la PR, header `x-commit-sha` ou JSON au chemin configuré ; aucun contournement |
| `PREVIEW_NOT_FOUND`, `PREVIEW_HOST_NOT_ALLOWED` | Déploiement réussi au bon SHA/environnement ou URL explicite, hôtes exacts avec ports |
| `EGRESS_POLICY_DENIED` | Logs `egress`, hôtes des API/assets/WebSockets et IP résolues ; métadonnées toujours interdites |
| `CONTEXT_INCOMPLETE` | Diff/versions source manquants : rendre le contexte disponible ou réduire la PR |
| `CONTRACT_VIOLATION`, `CRITICAL_COVERAGE_MISSING` | Étapes/omissions/citations du plan, politique de confiance au SHA de base ; ne pas assouplir les assertions |
| `PRECONDITION_UNVERIFIED` | Rôle authentifié / fixture seed-cleanup de confiance disponible pour ce dépôt |
| `MODEL_OUTPUT_INCOMPLETE`, `MODEL_JSON_INVALID` | Détail de validation, troncature/budgets de sortie, support JSON et paramètre de tokens ; conserver le modèle imposé |
| `RUN_BUDGET_EXCEEDED` | Usage/tarifs et réserves avant appel ; modifier les limites uniquement après inspection |
| `RUN_OWNERSHIP_LOST`, run `interrupted` | Annulation, heartbeat/lease et disponibilité SQL ; pas de replay automatique des écritures |
| `CANARY_START_FAILED`, `ENOENT` | Logs `browser`, installation runtime/Chromium dans l'image, versions et transport |
| `EACCES`, `EPERM` | Fichiers montés et volumes lisibles/inscriptibles par UID 1000, sans exposer les clés à tous |
| `ENOSPC` / refus de stockage | Disque, trois volumes et rétention ; préserver les preuves avant suppression |
| `EVIDENCE_VIDEO_MISSING` | Logs session/Chromium et finalisation ; aucune réussite sans preuve |
| `EADDRINUSE` | Conflit de port local ; modifier `QA_PORT`, redémarrer et adapter tunnel/proxy |
| HTTP `/health` 503 | SQL indisponible ; distinguer santé de l'API et santé de ses dépendances externes avec doctor |

L'ordre utile est : configuration → DB/migration → worker/lease → IA/GitHub →
SHA preview → browser → proxy egress. Le réseau du browser ne résout pas les
hôtes externes ; le proxy egress résout/vérifie/épingle les destinations.
Pour une IA locale, `host.docker.internal` est fourni, mais un serveur lié
uniquement à `127.0.0.1` sur l'hôte ne sera pas joignable depuis le conteneur.

Pour les logs du moteur, cibler son conteneur, pas l'API :

```bash
docker compose logs --tail=100 browser
docker compose exec -T browser sh -c 'tail -n 100 /home/node/.canary/daemon.log'
```

Le chemin effectif est indiqué au démarrage. Une panne de publication produit un
résultat bloqué ; le service tente de remplacer un succès public par une erreur,
y compris en cas d'annulation/perte de lease à la completion. Vérifier le champ
`publication`, les diagnostics et l'état réel de GitHub si la dépendance reste en panne.

## Mise à jour et arrêt

Suspendre les soumissions dashboard/API et les webhooks, puis attendre la fin des
runs actifs et une file vide. Le wrapper refuse une mise à jour avec des travaux
actifs/en attente. Sur un checkout propre, préserver `.env` / `config/` :

```bash
git fetch origin feat/autonomous-pr-qa
git merge --ff-only origin/feat/autonomous-pr-qa
./scripts/pr-qa up
```

`./scripts/pr-qa stop` arrête les cinq services en conservant les trois volumes.
Les jobs queued survivent ; une lease expirée est interrompue sans replay.
Ne pas utiliser `down -v`, des purges Docker globales ou un reset de la DB pour
réparer un incident. Une rotation de `QA_DB_PASSWORD` dans `.env` seule ne change
pas le mot de passe d'une DB déjà initialisée : préparer une rotation SQL et la
configuration coordonnée, plutôt que recréer le volume.

## Sauvegarde et restauration

Utiliser le même projet Compose et la même configuration que pour `up` ; adapter
les commandes si `QA_ENV_FILE` ou un nom de projet spécifique est utilisé. Arrêter
les nouvelles soumissions, vider la file, puis stopper les consommateurs pendant
la sauvegarde. Le dossier ci-dessous doit être stocké sur un support persistant
protégé ; `config/` et `.env` contiennent des secrets.

```bash
umask 077
mkdir -p backups
QA_BACKUP_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker compose stop worker pr-qa browser egress
docker compose exec -T db pg_dump -U canary -d canary > "backups/qa-db-$QA_BACKUP_STAMP.sql"
docker compose run --rm --no-deps -T --entrypoint tar pr-qa -C /data -czf - . > "backups/qa-data-$QA_BACKUP_STAMP.tar.gz"
docker compose run --rm --no-deps -T --entrypoint tar browser -C /home/node/.canary/sessions -czf - . > "backups/canary-sessions-$QA_BACKUP_STAMP.tar.gz"
tar -czf "backups/config-$QA_BACKUP_STAMP.tar.gz" .env config
./scripts/pr-qa up
```

Contrôler les codes de sortie, la taille et l'intégrité des archives ; une erreur
intermédiaire laisse les services stoppés jusqu'à diagnostic/reprise. Conserver
le SHA de déploiement avec chaque sauvegarde. La DB et `qa-data` doivent être
restaurés ensemble ; sauvegarder aussi les sessions pour préserver les captures
non encore exportées. Tester périodiquement une restauration avec un **nouveau
nom de projet Compose**, de nouveaux volumes et un port local distinct.

Dans ce projet de restauration isolé, démarrer d'abord sa DB, charger le dump
avec `psql -v ON_ERROR_STOP=1 -U canary -d canary`, restaurer les archives de données
et de sessions aux mêmes chemins avec les droits UID 1000, puis démarrer les
services et contrôler doctor, consultation des runs et preuves. N'importer aucun
dump dans la DB de production ni écraser ses volumes sans autorisation explicite.
Les commandes de sauvegarde/restauration décrivent la procédure ; elles n'ont pas
été exécutées sur un VPS utilisateur pendant cette livraison.
