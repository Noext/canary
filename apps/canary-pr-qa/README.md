# Canary autonomous PR QA

Application du monorepo Canary : une URL de PR devient un contrat de test, exécuté
par le moteur Canary existant dans Chromium. Chaque scénario conserve ses étapes,
assertions, captures et vidéo. Les résultats sont publiés sur le commit GitHub
**effectivement testé**. Le fork conserve la relation avec `0xnyn/canary`.

## Première installation Docker sur VPS

Docker Engine et Compose >= 2.20 sont les seuls outils requis sur l'hôte. Prévoir
8 Go de RAM, 4 vCPU et 30 Go libres pour commencer ; mesurer ensuite la charge
réelle avant d'augmenter le nombre de workers. Lire aussi [AGENTS.md](../../AGENTS.md)
et le [guide d'exploitation](../../docs/pr-qa-operations.md).

```bash
git clone --branch main https://github.com/Noext/canary.git
cd canary
git remote add upstream https://github.com/0xnyn/canary.git
git remote set-url --push upstream DISABLED
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Générer **trois secrets différents** pour `QA_API_TOKEN`, `QA_DB_PASSWORD` et
`QA_BROWSER_SERVICE_TOKEN`. Utiliser du hexadécimal pour le mot de passe PostgreSQL
 afin qu'il soit compatible avec son URL. Renseigner :

- GitHub se connecte depuis le dashboard administrateur après démarrage.
  `GITHUB_ALLOWED_REPOS` est une restriction serveur facultative, vide par défaut.
- Aucun `GITHUB_TOKEN` ou credential App n'est requis pour le parcours UI Compose.
- `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` : votre vrai endpoint `/v1`.
- `PREVIEW_ALLOWED_HOSTS` : tous les hôtes nécessaires à la preview, API, images,
  polices et WebSockets inclus, avec leurs ports lorsqu'ils ne sont pas standards.
  Un joker `*.domaine` (ou `*.domaine:port`) couvre les sous-domaines de ce
  domaine, jamais le domaine nu : pour tester `preview.example.com` et ses
  sous-domaines, listez les deux.
  C'est la **liste initiale** : elle remplit le champ du dashboard et sert de
  repli tant qu'aucune liste n'a été enregistrée. L'administrateur ajoute ou
  retire ensuite des hôtes dans Réglages → « Hôtes autorisés par
  l'administrateur » (audit `preview.hosts.updated` / `preview.hosts.reset`), sans
  redémarrage : la liste est publiée aux services `browser` et `egress` via le
  volume `qa-policy`. Ces deux services **n'élargissent jamais** la liste : tant
  que la politique publiée est absente ou illisible, toutes les destinations sont
  refusées (`PREVIEW_POLICY_MISSING` / `PREVIEW_POLICY_INVALID`) jusqu'à la
  republication par l'API ; `doctor` compare le fichier publié et la liste en
  vigueur (`preview-policy-current`).
- La preview doit exposer le SHA Git complet dans `x-commit-sha`, ou dans le JSON
  `{"sha":"..."}` du chemin `PREVIEW_SHA_PATH`. Cela s'applique également aux
  previews trouvées via les déploiements GitHub. Un header peut être injecté au
  build par l'application ou son reverse proxy ; ne pas inventer sa valeur.

```bash
./scripts/pr-qa up
./scripts/pr-qa status
./scripts/pr-qa doctor --pr https://github.com/OWNER/REPO/pull/123 --preview https://preview.example.com
```

Le wrapper construit l'image, vérifie la configuration, attend les services puis
lance les probes réelles du doctor depuis le worker. Ouvrir le dashboard sur
`http://127.0.0.1:8787/` sur le VPS, via un tunnel SSH ou un reverse proxy HTTPS.
Le port public n'est pas ouvert par Compose. `ARTIFACT_BASE_URL` configure les
liens GitHub. Pour créer le premier compte administrateur, générer un lien privé à usage unique :

```bash
docker compose exec -T pr-qa canary-pr-qa setup-admin --origin https://votre-domaine-qa
```

Ouvrir le lien dans les 15 minutes, choisir un identifiant et un mot de passe
(12 caractères minimum), puis utiliser la connexion locale habituelle. Le SSO
n'est pas nécessaire. Le lien est réservé à l'opérateur ayant accès au VPS :
aucun visiteur ne peut s'attribuer le premier compte. La configuration existante,
les runs et leurs preuves sont conservés par la migration automatique.

Les tokens individuels/JWT restent disponibles sous « Accès technique (API / SSO) ».
`QA_API_TOKEN` reste un secret serveur/API ; il n'est plus le login principal.
Les sessions locales HttpOnly durent une heure et sont révoquées au logout.

```bash
ssh -N -L 8787:127.0.0.1:8787 deploy@VPS
```

La version livrée doit être vérifiée dans le [journal de validation](../../docs/pr-qa-validation.md).
Un YAML analysé n'est pas un déploiement testé. Le doctor ne prouve pas la qualité
fonctionnelle du modèle ni le succès d'une PR particulière.

## Architecture et isolation

| Service | Responsabilité | Secrets / persistance |
| --- | --- | --- |
| `pr-qa` | API, dashboard, sessions utilisateurs, webhooks, SSE | Identités et GitHub ; volumes `qa-data`, `qa-policy` |
| `worker` | Planification, contrat, exécution et publication | IA/GitHub, fixtures ; `qa-data`, sessions en lecture, `qa-policy` pour le doctor |
| `browser` | Moteur Canary, Playwright, QuickJS, Chromium | Token de service ; aucune clé IA/GitHub ; `canary-sessions`, `qa-policy` en lecture |
| `egress` | Proxy DNS vérifié, connexions vers IP épinglées | Aucun secret de contrôle ; `qa-policy` en lecture |
| `db` | File durable, leases, livraisons webhook, journal d'accès | Mot de passe DB ; volume `qa-db` |

Le navigateur est sur un réseau Docker `internal`. Son trafic externe passe par
le proxy, qui valide les entrées de l'allowlist (hôtes exacts ou joker
`*.domaine`) et les IP résolues avant la connexion : les
endpoints de métadonnées sont toujours refusés ; les IP privées sont refusées par
défaut. La politique Playwright couvre également sous-ressources, redirections et
WebSockets, et bloque les service workers. Pour des previews réellement privées,
activer `QA_ALLOW_PRIVATE_PREVIEWS=true` en conservant une liste d'hôtes précise.
Ne jamais autoriser les services de contrôle comme destinations de preview.

Les CLIs et sessions Canary sont étendus, conservés et testés. Le navigateur
reçoit seulement les commandes compilées depuis les actions typées : le modèle
ne dispose pas d'une commande JavaScript ou shell arbitraire. Les profils contenant
les cookies sont supprimés après copie des preuves. Le Compose fixe des limites
CPU/mémoire, supprime les capabilities du navigateur et du proxy et interdit
l'élévation de privilèges. Cela ne remplace pas une isolation par VM lorsque votre
modèle de menace exige de résister à une évasion de Chromium.

## Workflow et règles de réussite

1. Lire la PR et ses fichiers à des SHA immuables, puis récupérer le contexte des
   imports et tests voisins dans les budgets configurés.
2. Vérifier le déploiement et la provenance HTTP réelle de la preview.
3. Découvrir l'interface et faire planifier des exigences accompagnées de citations
   exactes du diff/source. Chaque fichier doit être couvert ou explicitement ignoré.
4. Valider le contrat : étapes ordonnées, cibles et valeurs figées, assertions
   exécutées exactement une fois. Les omissions critiques ne sont pas approuvables
   par le contenu de la PR elle-même.
5. Préparer les fixtures/rôles de confiance ; exécuter le contrat dans Chromium.
   `transition` vérifie un changement réel de valeur ; `persisted` refait une lecture
   après reload. Une assertion fausse est terminale. Une action en erreur n'est
   pas rejouée automatiquement : ses effets peuvent avoir déjà eu lieu.
6. Finaliser vidéo, trace, captures, HAR et rapports, puis nettoyer les fixtures.
7. Recontrôler head/base, état de PR et provenance live ; publier un statut et,
   avec GitHub App, un Check et un commentaire mis à jour.

`passed` nécessite la totalité du contrat et des preuves ; `failed` signale une
assertion fausse ; `blocked` une précondition/limite/probe non satisfaite ; `stale`
un commit devenu obsolète ; `skipped` ne signifie jamais réussite. Le résultat
n'est pas une certification des changements hors du périmètre des scénarios.

Une politique `.canary/qa.json` est lue **sur le commit de base** :

```json
{
  "version": 1,
  "criticalPaths": ["src/", "app/", "apps/", "packages/"],
  "approvedSkips": [{"path":"src/generated.ts","reason":"Generated code is covered by the required unit-test check"}],
  "providerHosts": ["api.openai.com"]
}
```

Sans politique, les chemins applicatifs critiques ne peuvent pas être ignorés.
Configurer les autres checks GitHub obligatoires pour couvrir les tests unitaires,
backend, sécurité et builds. Les citations lexicales rendent le contrat vérifiable ;
elles ne garantissent pas que le modèle a identifié tous les bugs.

## Fixtures, authentification et capacités navigateur

Copier `config/fixtures.example.json` vers `config/fixtures.json` et définir
`QA_FIXTURES_FILE=/app/config/fixtures.json`. Ces fichiers sont montés en lecture
seule et ignorés par Git. Une fixture est un service de données de test contrôlé :
`POST seedUrl` puis `POST cleanupUrl`, body `{namespace,scenario}` et header
`Idempotency-Key`. Il doit créer/supprimer exclusivement les données du namespace.
Le token vient de `tokenEnv`, jamais du modèle. Préconditions acceptées :
`fixture:checkout`, `role:member`. Toute précondition en prose reste bloquante.

Un rôle référence une variable d'environnement contenant le storage state
Playwright `{cookies:[],origins:[]}`. Les domaines/origines sont vérifiés avant
l'ouverture de la session ; les secrets ne sont pas ajoutés au plan IA.
Pour des scénarios exigeant une authentification, fournir le rôle configuré ;
aucun compte de production n'est deviné ou créé automatiquement.

Les actions `download` et `popup` attendent réellement l'événement, vérifient
respectivement le nom du téléchargement sans erreur et l'URL de la popup.
Une assertion `visual` compare le screenshot de sa cible à une image PNG
**de confiance**, déclarée dans `visuals` du catalogue. La tolérance maximale est
0,1, réglable via `visualTolerance` ; la taille doit correspondre. Ces images ne
proviennent pas de la PR testée. Les assertions de ces trois types utilisent
`verification: state`.

`QA_BASELINE_URL_TEMPLATE`, lorsqu'il est renseigné, lance également le contrat
sur une preview du SHA **base**, dont la provenance est vérifiée. Le résultat
séparé figure dans `baseline` ; un nouveau comportement peut naturellement ne
pas exister sur la base. Le runner ne transforme pas un échec head en réussite
sous prétexte qu'il existe aussi sur la base.

## GitHub App et déclenchement automatique

Depuis le dashboard, connecté comme administrateur :

1. Dans **GitHub**, donner un nom à l'App. Laisser Organisation vide pour votre
   compte personnel, ou saisir votre organisation.
2. Cliquer **Créer mon App sur GitHub**. GitHub affiche le nom et les permissions
   préremplis. Confirmer la création sur GitHub ; l'App vous appartient.
3. Au retour dans Canary, cliquer **Installer / gérer les dépôts sur GitHub**.
   Choisir le compte et uniquement les dépôts nécessaires, puis valider sur GitHub.
4. Cliquer **Actualiser la connexion** si GitHub ne revient pas automatiquement,
   cocher les dépôts à utiliser et **Enregistrer les dépôts sélectionnés**.
5. Lancer un run. Les workers utilisent les tokens d'installation renouvelables,
   les Checks et les commentaires de votre App, sans PAT ni redémarrage.

`ARTIFACT_BASE_URL` doit être l'origine HTTPS publique de ce dashboard, par
exemple `https://canary.pharmania.fr`. Le reverse proxy doit transmettre le host
et le protocole. Les callbacks `/github/app/callback`, `/github/app/installed`
et le webhook `/github/webhook` doivent être joignables ; le WAF doit laisser
GitHub livrer les webhooks. La connexion locale doit rester valide pendant le
parcours. Les créations personnelles et d'organisation sont prises en charge
avec une App privée par instance et plusieurs installations de cette App.

Le manifest demande Contents/Metadata/Deployments en lecture,
Pull requests/Commit statuses/Checks en écriture, avec l'événement Pull request.
L'UI ne reçoit jamais le PEM, le secret webhook ni les tokens d'installation.
Les credentials sont chiffrés en AES-256-GCM en PostgreSQL, avec une clé dérivée
par HKDF du secret serveur `QA_API_TOKEN`. **Préserver ce secret avec la sauvegarde
DB** ; le changer sans migration du chiffrement rend les credentials illisibles.
Les sauvegardes restent des secrets. Le state de callback est lié à l'admin,
hashé en SQL, valable 30 minutes et consommé une fois. Les installation IDs
fournis par l'URL ne sont jamais utilisés comme preuve d'autorisation : les
installations sont énumérées avec le JWT de l'App de cette instance.

La sélection est explicite : aucune installation ne lance de QA avant d'avoir
sélectionné les dépôts dans Canary. Sélectionner un dépôt l'active par défaut
pour les runs automatiques (`qa_github_repositories.auto_run`, réglable par dépôt
dans la vue GitHub) ; si `GITHUB_ALLOWED_REPOS` est renseigné, l'accès effectif
est l'intersection entre sélection UI et restriction serveur.
L'accès admin suit cette sélection à chaque requête. Le worker synchronise les
installations toutes les 60 secondes ; Actualiser applique immédiatement les
retraits/suspensions. Une erreur réseau de synchronisation est journalisée et
ne remplace pas la sélection par une liste partielle. Les runs en attente sur
un dépôt retiré sont refusés ; la publication vérifie à nouveau la sélection.

Les anciens PAT et paramètres App restent disponibles pour des installations
techniques existantes, mais l'App gérée par l'UI a priorité une fois créée.
Le service Compose peut démarrer sans connexion GitHub ; doctor affiche cette
étape comme **skipped/onboarding pending**, jamais comme accès GitHub validé.

### Supprimer la connexion GitHub

Administrateur, section **GitHub**, bloc **Supprimer la connexion GitHub** :

- **Désinstaller l'App de mes dépôts** : GitHub révoque chaque installation
  (webhooks et accès retirés). L'App elle-même reste dans vos réglages GitHub et
  peut être réinstallée à tout moment.
- **Supprimer l'App GitHub** : GitHub supprime l'App et toutes ses installations.
  Action **irréversible** ; il faut recréer une App pour reconnecter l'instance.

Les deux actions effèrent la connexion locale (credentials chiffrés,
installations, sélection de dépôts) et les callbacks manifest/installation en
attente, avec une entrée d'audit `github.app.disconnected`. Si GitHub refuse la
suppression (App d'organisation, droits insuffisants, réseau), la connexion
locale est tout de même effacée et l'API renvoie un avertissement : terminez la
suppression depuis les réglages GitHub de l'App. Aucun secret n'est renvoyé dans
la réponse et les runs suivants repassent au mode technique ou à « non
connecté ». Déconnecter ne supprime aucun volume, run ou preuve.
La migration SQL version 6 conserve comptes, sessions, runs et preuves ; elle ajoute
l'état d'attente des tentatives automatiques et l'option `auto_run` par dépôt.

Les livraisons de webhooks validées sont stockées en inbox SQL et dédupliquées.
L'attente de la preview du chemin automatique suit `QA_AUTO_PREVIEW_WAIT_SECONDS`
et le backoff décrit plus bas ; `QA_PREVIEW_WAIT_SECONDS` garde son sens pour le
chemin manuel/legacy. Les runs d'anciens SHA sont annulés.
Les livraisons distinctes d'un même dépôt/PR/SHA partagent une seule entrée
d'inbox et un seul run automatique, y compris si un job historique utilise une
clé par delivery. Un reopen du même SHA ne relance pas ses écritures navigateur.
Pour relancer volontairement, utiliser le dashboard avec une nouvelle clé
d'idempotence.

`QA_WEBHOOK_MAX_RUNS_PER_HOUR=60` limite les nouveaux runs automatiques de tout
le déploiement ; `QA_WEBHOOK_REPO_MAX_RUNS_PER_HOUR=20` limite chaque dépôt.
Ces fenêtres glissantes sont comptées dans PostgreSQL sous verrou partagé par
les workers : les runs terminés, annulés ou échoués consomment aussi leur quota.
La déduplication précède le quota ; les reruns explicites authentifiés restent
possibles. Avec un budget de `QA_RUN_MAX_TOKENS` par run, la limite globale borne
également le volume horaire de tokens des runs nouvellement admis.

Un refus crée un audit `automatic.rate_limited` et une entrée d'inbox
`rate_limited`, sans exécuter le modèle ni rejouer automatiquement la demande.
Le diagnostic est consultable dans les logs worker et dans `qa_audit` ; un
opérateur peut ajuster les limites après inspection de l'usage ou lancer un
run explicite. Les quotas ne limitent pas les jobs manuels déjà autorisés.

Les drafts ne sont pas lancés automatiquement. Les erreurs de publication sont
visibles, sans simulation de succès.

### Cycle de vie d'une tentative automatique

Un dépôt sélectionné est opt-in par défaut : `qa_github_repositories.auto_run`
vaut `true` et se règle par dépôt dans la vue GitHub des réglages du dashboard.
Un `pull_request` non brouillon (`opened`, `reopened`, `synchronize`,
`ready_for_review`) sur un dépôt connecté et opt-in démarre donc le run sans
opérateur. `GITHUB_ALLOWED_REPOS`, lorsqu'il est renseigné, reste un plafond
serveur : un dépôt hors de cette liste n'est jamais automatique.

La provenance exacte du SHA reste obligatoire. Tant qu'aucune preview ne prouve
le SHA complet du head, la tentative reste en file et reprobe avec un backoff
exponentiel de 30, 60, 120 puis 300 secondes. Elle est matérialisée par une ligne
`qa_deliveries` par `(dépôt, PR, SHA)`, avec `status`, `attempts`, `reason`,
`deadline_at` et `last_error`. La deadline est `QA_AUTO_PREVIEW_WAIT_SECONDS`
(1800 s par défaut) après acceptation de la livraison. Chaque probe prend la
propriété de sa livraison (`claim_token`, bail de 90 s) : promotion, expiration et
replanification ne s'appliquent que si ce jeton est encore le sien, et une
promotion est refusée si la deadline s'est fermée pendant la vérification de la
preview. Les livraisons terminales (`processed`, `expired`, `rate_limited`,
`auto_disabled`) sont purgées après 30 jours.

Après la deadline, la tentative passe en `expired`, avec l'audit
`automatic.preview_expired` et un log d'avertissement du worker. **Une tentative
expirée n'est jamais rejouée automatiquement** : relancer explicitement depuis le
dashboard ou pousser un nouveau commit.

| État | Audit | Cause |
| --- | --- | --- |
| en attente | `automatic.preview_wait` | preview sans preuve du SHA complet |
| `processed` | `automatic.promoted` | preview vérifiée, run réel créé |
| `expired` | `automatic.preview_expired` | deadline `QA_AUTO_PREVIEW_WAIT_SECONDS` dépassée |
| `rate_limited` | `automatic.rate_limited` | budgets horaires globaux/par dépôt |
| `auto_disabled` | `automatic.disabled` | `QA_AUTO_RUNS=false` |
| `auto_disabled` | `automatic.repo_disabled` | dépôt non opt-in |

Une tentative n'est pas un job `qa_jobs` : aucun statut de run n'est inventé, le
run réel n'est créé qu'une fois la preview vérifiée.

`GET /dashboard/automatic` expose aux administrateurs, opérateurs et viewers
ayant accès au dépôt les tentatives les plus récentes d'abord (50 au maximum),
avec un résumé des tentatives en attente, expirées et rate-limitées. Les lignes
`expired` et `rate_limited` restent visibles 24 heures ; les tentatives en attente
sont comptées dans le résumé.

Interrupteurs : `QA_AUTO_RUNS=false` désactive les runs automatiques de tout le
déploiement (les tentatives sont enregistrées `auto_disabled`, audit
`automatic.disabled`) sans retirer la connexion GitHub ; désactiver le run
automatique de ce dépôt dans la vue GitHub des réglages le désactive pour ce seul
dépôt. Dans les deux cas, le
parcours manuel reste disponible : une URL de PR et une preview vérifiable
continuent de fonctionner pour tout ce que l'automatisation a sauté.

L'opérateur doit toujours fournir une preview joignable exposant le SHA complet
(en-tête ou JSON selon `PREVIEW_SHA_PATH`), autoriser ses hôtes dans la liste
initiale `PREVIEW_ALLOWED_HOSTS` ou depuis le dashboard, et laisser GitHub livrer
les webhooks sur une origine HTTPS publique. L'automatisation ne devine ni l'URL
ni le SHA.

Un PAT reste possible : lecture Contents/Deployments et écriture PR/statuses.
Les Checks et l'upsert de commentaire Bot sont réservés au mode GitHub App.
Le token connecté à ChatGPT n'est pas automatiquement disponible sur votre VPS.

## Comptes locaux et récupération d'accès

Les comptes et sessions locales sont conservés dans PostgreSQL. Les mots de passe
sont dérivés avec scrypt, sel aléatoire par compte ; seuls les hashes des tokens
de session et du lien d'installation sont stockés. La création du premier admin
est atomique ; le lien est consommé une seule fois et aucun nouvel admin initial
ne peut être créé ensuite. Les tentatives de connexion sont limitées en SQL.
Le cookie porte `Secure` lorsque l'origine configurée ou le proxy indique HTTPS ;
conserver `X-Forwarded-Proto` sur votre reverse proxy.

Pour votre installation existante, mettre à jour la branche et l'image sans
supprimer les volumes, puis lancer `setup-admin`. Aucun mot de passe par défaut
ou compte public n'est créé. Les comptes techniques existants restent utilisables.

En cas de mot de passe oublié, l'opérateur peut le remplacer via stdin, sans le
mettre dans les arguments de commande ni dans Git. Depuis Bash sur le VPS :

```bash
read -rs -p 'Nouveau mot de passe : ' QA_NEW_PASSWORD
printf '%s' "$QA_NEW_PASSWORD" | docker compose exec -T pr-qa canary-pr-qa reset-password IDENTIFIANT
unset QA_NEW_PASSWORD
```

Cette commande révoque toutes les sessions locales du compte. Une nouvelle
connexion avec le nouveau mot de passe est requise. La commande `setup-admin`
refuse de recréer un administrateur quand un compte local existe déjà.

## Frontend : structure et diagnostic

Le dashboard est une application **React 19 + Vite** dans le workspace
[`apps/canary-pr-qa-ui`](../../apps/canary-pr-qa-ui) (`@usecanary/pr-qa-ui`) :
composants, hooks, TypeScript strict, Tailwind v4, tests Vitest + Testing
Library. Aucun JavaScript applicatif n'est conservé dans une chaîne et aucune
écriture DOM impérative n'est admise.

| Fichier | Responsabilité |
| --- | --- |
| `src/api/client.ts` | HTTP, erreurs typées, événement d'expiration de session |
| `src/api/schemas.ts`, `src/api/contracts.ts` | Schémas Zod et types du contrat HTTP |
| `src/i18n.ts` | Textes français, libellés d'états, phases et messages d'erreur |
| `src/app/*` | Session, espace de travail (statuts, modèles), navigation, coquille |
| `src/views/*` | Connexion, accueil, nouveau test, historique et détail, réglages |
| `src/components/ui/*` | Boutons, champs, tableaux, pastilles et notices |

`apps/canary-pr-qa/scripts/ui-assets.mjs` lit le build Vite et l'embarque dans le
CLI Node via le chargeur esbuild `?ui` : `dist/cli.js` reste autonome, aucun
fichier statique à copier sur le VPS. `dashboard.ts` associe uniquement les URLs
et les types MIME. Les scripts et styles sont servis sur `/dashboard/assets/` et
la page applique une CSP sans `unsafe-inline` (donc pas d'attribut `style=` ni de
`<style>` en ligne dans les composants). Les ressources ne contiennent ni
credentials ni données de comptes/runs.

Pour contribuer depuis un clone installé :

```bash
pnpm --filter @usecanary/pr-qa-ui dev        # Vite + proxy API sur 127.0.0.1:8787
pnpm --filter @usecanary/pr-qa-ui test       # composants (Vitest + Testing Library)
pnpm --filter @usecanary/pr-qa-ui compile    # tsc --noEmit
pnpm --filter @usecanary/pr-qa-ui build      # dist/ consommé par pr-qa
pnpm --filter @usecanary/pr-qa test
pnpm --filter @usecanary/pr-qa test:e2e
pnpm --filter @usecanary/pr-qa build
```

`dev` du dashboard suppose le serveur PR QA démarré avec sa base (`pnpm --filter
@usecanary/pr-qa dev -- serve`) : Vite proxifie l'API sur la même origine, ce qui
préserve le cookie de session et le contrôle Origin/Host du serveur. `dev` du CLI
embarque le dernier build du dashboard : relancer
`pnpm --filter @usecanary/pr-qa-ui build` après une modification de l'interface.
Les source maps (inline dans `client.js`) permettent de poser un point d'arrêt
dans les fichiers TypeScript via les outils développeur. Inspecter Console et
Réseau : une erreur HTTP présente sa référence de requête, les connexions SSE
sont dans `/runs/<id>/events`. Les source maps du CLI existent aussi dans
`dist/`. Pour les incidents de worker, utiliser le run ID du diagnostic et les
commandes du guide d'exploitation. Les tests chargent réellement le CSS et
vérifient les ressources, la CSP et les parcours Chromium.

## Premier usage du dashboard

Après connexion, l'**Accueil** vous indique la prochaine action : connecter
GitHub, choisir un modèle disponible ou tester une PR. Les états sont dérivés
des accès et du catalogue réellement chargé, sans simuler une génération IA.

1. **Réglages** : créer/installer l'App, choisir les dépôts ; vérifier l'accès au
   fournisseur et consulter les contraintes des previews. La carte « Hôtes
   autorisés par l'administrateur » ajoute ou retire les hôtes de preview
   (ajout, retrait, enregistrement, retour à la liste du serveur) ; la liste est
   appliquée au navigateur et au proxy de sortie en quelques secondes, sans
   redémarrage, et chaque changement est audité.
2. **Nouveau test** : coller l'URL de PR, l'URL de son application de test si elle
   n'est pas fournie par GitHub, puis choisir votre modèle.
3. **Vérifier les accès** : lecture de la PR et contrôle de la preview au même SHA.
   Aucune génération IA, scénario, vidéo ou écriture GitHub à cette étape.
4. **Lancer le test** : le moteur prépare et exécute les scénarios. Les paramètres
   modifiés invalident la vérification ; le moteur contrôle à nouveau la version
   au lancement. Les tokens consommés dépendent de votre endpoint IA.
5. **Historique** : phases live, verdict, assertions et vidéos. Le rapport complet
   et le commentaire GitHub sont accessibles ; le JSON et le run ID sont dans
   « Diagnostic technique ». Un résultat bloqué/annulé ne devient pas un succès.

Le catalogue accessible ne prouve pas encore qu'une génération réussira. Une
preview vérifiée ne prouve pas que les assertions fonctionnelles réussiront.
Le modèle par défaut reste celui de l'opérateur ; aucun remplacement automatique.
Les filtres distinguent historique vide et recherche sans résultat. Les statistiques
portent sur les tests récents retournés par l'API, pas une agrégation illimitée.

Captures réelles des E2E, avec données fictives :

![Accueil guidé](../../docs/images/dashboard-welcome.png)

![Résultat mobile avec assertions et vidéo](../../docs/images/dashboard-result-mobile.png)

## Dashboard, API et observabilité

| Endpoint | Fonction |
| --- | --- |
| `GET /` | Dashboard, formulaire de lancement, recherche, filtres, détails |
| `GET /auth/status` | État de première installation, aucun credential exposé |
| `POST /auth/setup` | Premier admin, lien privé temporaire requis |
| `POST /auth/login` | Connexion identifiant/mot de passe, cookie HttpOnly |
| `POST /session`, `DELETE /session` | Accès technique / déconnexion et révocation locale |
| `GET /dashboard/status` | Connexions et informations non secrètes nécessaires au guide |
| `POST /runs/preflight` | `{prUrl,previewUrl?,model}` ; accès/provenance sans enqueue ni publication |
| `GET /me` | Identité et dépôts accessibles |
| `GET /models` | Catalogue IA authentifié et modèle par défaut ; accès operator/admin |
| `GET /github/app`, `POST /github/app/manifest`, `POST /github/app/install`, `POST /github/app/refresh`, `PUT /github/app/repositories` | Onboarding GitHub App réservé à l'admin |
| `DELETE /github/app` | Déconnecte l'App ; `{"deleteApp":true}` la supprime aussi sur GitHub |
| `POST /runs` | `{prUrl,previewUrl?,publish?,model?}`, header `Idempotency-Key` facultatif |
| `GET /runs` | Liste limitée aux projets de l'utilisateur ; `status`, `search` |
| `GET /runs/:id` | Statut durable et progression |
| `GET /runs/:id/events` | SSE, phases/actions live, reconnexion via EventSource |
| `POST /runs/:id/cancel` | Annulation coopérative, arrêt des requêtes/processus |
| `POST /runs/:id/links` | Lien signé pour un fichier, expiration 5 minutes |
| `DELETE /runs/:id` | Suppression administrative d'un run terminal |
| `GET /artifacts/:id/...` | Rapports, vidéos et preuves selon droits/politique |
| `GET /metrics` | Prometheus, accès administrateur |
| `GET /health` | Santé SQL et file, utilisé par Compose |

Le flux live montre les phases et actions ; les vidéos sont des enregistrements
finalisés, pas une diffusion vidéo en direct. Les métriques modèle indiquent
latence/appels/tokens ; le résultat inclut usage et coût estimé. Renseigner les
prix réels `QA_INPUT_COST_PER_MILLION` et `QA_OUTPUT_COST_PER_MILLION` pour le suivi
du coût. Si l'endpoint omet `usage`, le runner emploie une estimation conservative.
Les budgets globaux de temps/tokens sont appliqués indépendamment du tarif.
`OTEL_EXPORTER_OTLP_ENDPOINT` active les spans OTLP ; un collecteur externe est
nécessaire pour les consulter.

Copier `config/users.example.json` vers `config/users.json`, configurer les vrais
SHA-256 des tokens individuels et `QA_USERS_FILE=/app/config/users.json`.
Rôles : viewer (lecture), operator (lancement/annulation), admin (suppression,
métriques). Chaque identité doit avoir une liste explicite de dépôts. Pour SSO,
configurer issuer/audience/JWKS et mapper `oidcSubject` à l'identité locale ; les
JWT d'accès RS256/ES256 sont vérifiés, les claims ne peuvent pas choisir leurs
droits. L'émission du JWT et le login IdP restent gérés par votre IdP.

## Exploitation, panne et données

Les jobs queued survivent au redémarrage. Plusieurs workers réclament les jobs
avec `FOR UPDATE SKIP LOCKED`, lease de 45 s et heartbeat de 10 s. Une lease
expirée devient `interrupted` : aucun scénario potentiellement destructif n'est
rejoué. Relancer explicitement avec une nouvelle clé d'idempotence. Les jobs legacy
sur disque sont importés pour conserver leur consultation ; les jobs actifs
legacy sont marqués interrompus.

```bash
./scripts/pr-qa logs
./scripts/pr-qa diagnose RUN_ID
./scripts/pr-qa doctor --json
# Ajouter des workers uniquement après avoir mesuré la capacité de Chromium.
docker compose up -d --scale worker=2
```

Trois volumes de données plus le volume de politique : `qa-data`, `canary-sessions`,
`qa-db` et `qa-policy`. Sauvegarder `qa-data` et faire un
`pg_dump` cohérent de la DB ; tester une restauration dans un projet Compose
séparé. `qa-policy` ne contient que la liste d'hôtes publiée et se recrée au
démarrage de `pr-qa`. **Ne pas utiliser `down -v` sur l'installation de production.**
La rétention supprime les runs terminaux après `QA_RETENTION_DAYS` ou lorsque
`QA_STORAGE_MAX_GB` est dépassé ; les runs actifs sont préservés. Les accès et
suppressions sont audités en DB. Les sessions natives sont purgées après export
réussi afin de ne pas conserver leurs profils/cookies sans limite.

La publication anonyme `ARTIFACT_PUBLIC` n'est pas utilisée par le serveur SQL.
Les traces/HAR/console bruts sont refusés par défaut ; `QA_RAW_EVIDENCE=true`
permet leur accès selon les droits du projet. Restreindre les données de test,
utiliser `QA_ALLOWED_PROVIDER_HOSTS` et les identités par projet. La redaction
masque les secrets configurés ; elle ne garantit pas l'anonymisation de tout ce
qu'une application peut afficher dans une vidéo ou un screenshot.

## Développement et validations

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
node apps/canary/dist/cli.js install
pnpm --filter @usecanary/pr-qa test:e2e
# Base de test jetable uniquement :
QA_TEST_DATABASE_URL=postgresql://canary:password@127.0.0.1:5432/canary pnpm --filter @usecanary/pr-qa test
```

Les tests SQL locaux utilisent PostgreSQL WASM (PGlite) ; la concurrence native,
les leases et les pannes sont testées contre un service PostgreSQL distinct en CI.
Les tests Chromium utilisent des fixtures GitHub/IA : ils valident l'orchestration,
le moteur et les preuves, pas la qualité d'un modèle réel. Le corpus live est
expliqué dans [le guide d'évaluation](../../docs/pr-qa-evaluation.md).

Le runtime Canary est installé par `npm ci` avec un lock embarqué et Chromium
correspondant à Playwright 1.58.2. Les images de base Node/PostgreSQL sont épinglées
par digest. Le workflow de release QA construit l'image, scanne ses vulnérabilités,
produit SBOM/provenance et attestation. Son exécution et la protection de branche
GitHub doivent être constatées sur votre fork ; leur présence dans le code ne
prouve pas leur activation.

### Contrôles supplémentaires de livraison

Le navigateur du réseau `control` ne résout pas les domaines externes : le proxy
`egress` résout, vérifie et épingle les IP. Sa santé est vérifiée avant le démarrage
du browser. Les refus ont le code structuré `EGRESS_POLICY_DENIED` dans
`docker compose logs egress`. Les adresses de métadonnées restent interdites même
avec `QA_ALLOW_PRIVATE_PREVIEWS=true`.

Une expiration de lease est irréversible : le worker ne peut ni la renouveler ni
terminer le job expiré. Il revérifie la propriété avant publication ; une annulation
ferme le check du SHA épinglé avec `error`, jamais `success`. Une panne de publication
rend le run `blocked` et conserve les preuves locales.

Les rapports HTML natifs imbriqués, logs, HAR et ZIP sont des preuves brutes,
interdites par défaut via HTTP. Le rapport principal et ses vidéos/images restent
accessibles aux utilisateurs autorisés. N'activez `QA_RAW_EVIDENCE` qu'après avoir
vérifié les données de test. Les clés PEM, états d'authentification et configurations
montées sont exclus du contexte Docker.

Le check CI audite les dépendances de production. Les mises à jour OpenTelemetry
sont verrouillées et l'export réel `/v1/traces`, le nom de service et la corrélation
avec `progress.json` sont vérifiés par un collecteur HTTP de test.

La lecture du WebM depuis le rapport principal est testée dans un vrai navigateur
avec une session authentifiée : clic sur les contrôles et progression du temps de
lecture. Le rapport principal n'exécute aucun script ; les rapports natifs restent
isolés. Les tests vérifient également qu'un script injecté dans un artefact HTML
n'est pas exécuté.

La session utilise un cookie `HttpOnly`, `SameSite=Lax` et `Secure` en HTTPS :
un lien de rapport ouvert depuis GitHub conserve l'authentification. Les mutations
avec une origine étrangère sont refusées. L'E2E vérifie cette navigation entre
sites, la lecture réelle de la vidéo et le refus d'une mutation cross-site.

La publication du statut/check précède le commentaire de résultat. Si la réponse
d'un commentaire est perdue après son écriture, le runner tente de le mettre à
jour avec le résultat bloqué et de fermer le statut en erreur. Une panne GitHub
persistante reste signalée dans le résultat durable ; elle ne devient pas un succès.

Le proxy accepte les upgrades `ws://` et `wss://`, utilise respectivement les ports
80 et 443 par défaut, et vérifie le certificat TLS pour l'hôte d'origine en WSS.
Les contrôles de liste d'hôtes, DNS/IP et métadonnées restent appliqués.

## Modèle IA et catalogue dynamique

Le défaut est `opencode-go/deepseek-v4.1-flash`. Le dashboard récupère les IDs depuis le `/v1/models` de `OPENAI_BASE_URL` via son API authentifiée `/models`. La clé reste côté serveur. Le catalogue est mis en cache 30 secondes et peut être rechargé avec « Actualiser les modèles ». Aucun autre modèle n'est choisi automatiquement : si le défaut ou la sélection précédente manque, choisissez explicitement un ID avant de lancer.

Le modèle choisi est enregistré dans le job, utilisé pour le planificateur et l'exécuteur, et affiché dans la liste, le détail et le rapport. Une modification ultérieure de `OPENAI_MODEL` ne modifie pas les jobs déjà en attente. `QA_ALLOWED_MODELS` permet une liste autorisée d'IDs séparés par des virgules ; vide signifie tous les IDs retournés par le fournisseur. CLI : `--model ID` ; API : champ optionnel `model`. Les webhooks utilisent le défaut configuré.

Les tarifs globaux configurés concernent le modèle par défaut. Pour un autre modèle, le coût reste indisponible et le budget de tokens reste actif. Une erreur de catalogue bloque le lancement dans le dashboard et affiche un diagnostic. Pour Cloudflare, autorisez l'IP de sortie du serveur/VPS qui appelle le fournisseur. L'IP du navigateur de l'utilisateur n'est pas celle de cet appel.
