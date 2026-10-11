# Mise en œuvre des dix chantiers

| Chantier | Implémentation | Vérification / limite |
| --- | --- | --- |
| Contrat exécutable | Étapes/valeurs/cibles figées, source witnesses, transition et reload | Tests unitaires adversariaux + vrai Chromium |
| Couverture | Politique base SHA, chemins critiques, skips approuvés, imports/tests voisins | Tests de plan et refus des omissions critiques |
| Provenance live | Header/JSON même avec GitHub deployments ; contrôle des URL observées | Tests sans SHA + probes Chromium |
| Isolation | Browser service, env réduit, réseau internal, proxy DNS épinglé, SW/WS policy | Proxy HTTP et refus sous-ressources testés ; réseau Docker à tester en CI |
| Évaluation IA | Corpus annoté, plusieurs modèles/répétitions, faux verts/blocages, gate | Endpoint IA réel non fourni : évaluation live non exécutée |
| File durable | PostgreSQL, idempotence, SKIP LOCKED, leases/heartbeat, annulation, budgets | SQL PostgreSQL WASM testé ; concurrence PostgreSQL native en CI |
| Préconditions | Rôles, seed/cleanup namespacés, visual/download/popup, comparaison base/head | Auth/persistence réellement testées ; autres probes dans la suite |
| GitHub App | JWT RS256, tokens renouvelés, signatures webhook, inbox, preview wait, Checks/upsert | Probes et fixtures ; installation App réelle à configurer |
| Observabilité/gouvernance | Dashboard, SSE, RBAC/projets, OIDC JWT, Prometheus/OTLP, usage, rétention, liens signés | Routes SQL/SSE/auth testées ; IdP et collecteur réels à configurer |
| Livraison | Runtime npm ci verrouillé, images digest, CI native PG + Compose, scan/SBOM/attestation | Docker/VPS non disponibles ici ; workflow et protections non déclarés activés |

Le script `scripts/configure-qa-protection` cible exclusivement `Noext/canary`.
Sans `--apply`, il ne change aucun paramètre. La protection exige un reviewer
supplémentaire et le check `check` ; s'assurer que ce workflow s'exécute et qu'un
reviewer est disponible avant de l'appliquer. Ne pas annoncer ces paramètres
comme activés sur GitHub sans les relire réellement.

Les callbacks de données de test sont des intégrations de confiance ; leur
implémentation dépend de votre application. Les vidéos/screenshots peuvent
contenir des données affichées par l'application. Les vérifications par modèle
ne remplacent pas toutes les suites de tests ou une revue de sécurité.
