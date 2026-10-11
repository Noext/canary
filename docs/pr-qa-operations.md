# Exploitation et dépannage PR QA

Le guide de déploiement pour les agents est [AGENTS.md](../AGENTS.md). Utiliser Docker Engine et Compose 2.20+, un checkout du fork et une configuration réelle. Le wrapper ne demande aucune installation Node sur le VPS.

```bash
test -f .env || cp .env.example .env
chmod 600 .env
# Renseigner les secrets, le modèle, les dépôts et les hôtes de preview.
./scripts/pr-qa up
./scripts/pr-qa doctor --pr https://github.com/OWNER/REPO/pull/123 --preview https://preview.example.com
./scripts/pr-qa status
./scripts/pr-qa logs
```

`up` construit l'image, vérifie la configuration avant démarrage, attend la santé du service puis lance les vérifications réelles. `doctor` contrôle le stockage, Chromium, la création des preuves, GitHub et une réponse JSON du modèle. Sans `--pr`, la provenance d'une preview réelle reste explicitement non vérifiée. Le doctor lit GitHub mais ne publie aucun commentaire/statut. Une erreur renvoie un code non nul ; `--offline` et `--skip-browser` signalent les vérifications sautées.

Le mapping `host.docker.internal` est fourni. Une IA liée uniquement à `127.0.0.1` sur l'hôte demeure inaccessible au conteneur. Configurer une interface accessible depuis Docker. Le service QA reste publié sur l'interface locale du VPS ; un accès distant nécessite un tunnel SSH ou un proxy TLS adapté.

## Diagnostiquer un run

```bash
./scripts/pr-qa diagnose UUID_DU_RUN
./scripts/pr-qa logs
```

Le résumé contient la phase, les erreurs, les assertions et les compteurs de preuves ; il exclut les valeurs saisies, le DOM, les cookies et les secrets configurés. Partager ce résumé en premier. Les traces/HAR/captures complètes peuvent contenir des données de l'application. Les logs portent les identifiants de run et de requête HTTP, la phase/action, la durée et le diagnostic.

| Fichier sous `/data/<run-id>/` | Utilité |
| --- | --- |
| `job.json` | État de file et exécution ; `completed` ne signifie pas assertions réussies |
| `progress.json` | Dernière phase/action, séquence et diagnostic |
| `events.jsonl` | Historique ordonné, une ligne JSON par événement |
| `result.json` | Résultat agrégé, scénarios, assertions et publication GitHub |
| `report.html`, `report.md` | Rapport consultable et liens vers les preuves |
| Dossiers de preuves | Vidéo WebM, trace Playwright, HAR, console et captures Canary |

`GET /runs/:id` fournit aussi `progress`. Les artefacts sont téléchargeables sous `/artifacts/:id/...` avec le bearer, sauf activation explicite de `ARTIFACT_PUBLIC`. Le fichier natif Canary reste `results.json` dans chaque session : ne pas le confondre avec le `result.json` agrégé.

## Erreurs et actions correctives

| Code / symptôme | Vérification ciblée |
| --- | --- |
| `CONFIG_INVALID` | Variables manquantes, token API fort, allowlists exactes, URL du fournisseur et modèle réel |
| `HTTP_401`, `HTTP_403` | Validité du token, permissions, dépôts autorisés ; l'identifiant de requête aide le support fournisseur |
| `HTTP_404` | Dépôt/PR, route du fournisseur (`/v1/chat/completions`), ressource accessible au token |
| `HTTP_429` | Quota et fréquence ; ne pas multiplier les soumissions ni rejouer aveuglément les publications |
| `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `TIMEOUT` | Adresse, port, DNS Docker et disponibilité de la dépendance concernée |
| `PREVIEW_SHA_MISMATCH` | Déployer le SHA complet attendu et exposer `x-commit-sha` ou le JSON configuré ; aucun contournement du contrôle |
| `PREVIEW_NOT_FOUND`, `PREVIEW_HOST_NOT_ALLOWED` | Déploiement GitHub réussi au bon SHA/environnement ou URL explicite et hôte autorisé |
| `CONTEXT_INCOMPLETE` | Diff/fichiers source incomplets : réduire la PR ou rendre les versions disponibles ; un contexte partiel ne donne pas un pass |
| `MODEL_OUTPUT_INCOMPLETE`, `MODEL_JSON_INVALID` | Augmenter les budgets de sortie si tronqués, vérifier le support JSON et le modèle ; `OPENAI_TOKEN_PARAMETER=max_completion_tokens` si requis |
| `CANARY_START_FAILED`, `ENOENT` | Runtime/Chromium installé, versions compatibles, permissions des sockets et logs du daemon |
| `EACCES`, `EPERM` | Volumes accessibles à `node` (UID 1000), permissions et capacités de l'hôte |
| `ENOSPC` | `df -h` et volumes du projet ; préserver les preuves avant toute suppression |
| `EVIDENCE_VIDEO_MISSING` | Logs de session/Chromium et espace disque ; absence de preuve bloque la réussite |
| `EADDRINUSE` | Port déjà occupé ; modifier `QA_PORT` puis redémarrer avec le Compose fourni |
| Santé HTTP 503 | Erreur de persistance : corriger disque/permissions puis redémarrer ; le service refuse de nouveaux jobs |

Pour consulter les logs du moteur dans le conteneur :

```bash
docker compose exec -T pr-qa sh -c 'find /home/node/.canary -maxdepth 2 -name "*.log" -print'
docker compose exec -T pr-qa sh -c 'tail -n 100 /home/node/.canary/daemon.log'
```

Le message de démarrage précise le chemin effectif. Les sessions natives restent dans `/home/node/.canary/sessions`. `doctor` garde ses propres preuves sous `/data/_doctor/`.

## Arrêt et récupération

Suspendre les nouvelles soumissions avant une mise à jour. Attendre `busy=false` et `queued=0`, sauvegarder les deux volumes et `.env`, puis utiliser `./scripts/pr-qa up`. `./scripts/pr-qa stop` conserve les volumes. L'arrêt accorde 25 secondes au run actif ; un travail interrompu au redémarrage demande une nouvelle soumission explicite. Le service ne rejoue pas automatiquement les effets dans le navigateur ou sur GitHub. Ne pas utiliser `down -v` sur les volumes de production.

Il n'existe pas de dashboard central, de flux SSE/WebSocket, de streaming vidéo live, de métriques Prometheus ou de suivi des coûts IA. Les événements persistés et l'API permettent le suivi par polling ; le viewer Canary existant consulte les sessions enregistrées et n'est pas inclus dans l'image PR QA.

## Topologie entreprise actuelle

Le [README de l'application](../apps/canary-pr-qa/README.md) remplace les hypothèses
historiques de service unique de ce guide. L'installation actuelle utilise
`pr-qa`, `worker`, `browser`, `egress` et `db`. Le doctor/diagnose se lancent depuis
le worker ; `logs` affiche tous les services. Trois volumes sont à sauvegarder.

Pour un incident : identifier le run et son dernier événement SSE/progress ;
vérifier SQL (`db`), acquisition de lease (`worker`), accès IA/GitHub, démarrage
Chromium (`browser`) puis refus réseau (`egress`). Les codes
`CONTRACT_VIOLATION`, `CRITICAL_COVERAGE_MISSING`, `PREVIEW_SHA_MISMATCH`,
`PRECONDITION_UNVERIFIED` et `RUN_BUDGET_EXCEEDED` indiquent des blocages explicites,
pas des succès. Ne pas désactiver leurs contrôles pour débloquer artificiellement
une publication verte.

Le dashboard `/` permet de consulter les runs, phases et résultats ; un JWT SSO
ou un token individuel permet une session HttpOnly. Le SSE montre la progression,
pas une vidéo en direct. Une lease expirée est interrompue sans replay.
