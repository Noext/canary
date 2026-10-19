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
  sous-domaines, listez les deux. Le domaine doit vous appartenir — un suffixe
  public (`*.com`, `*.co.uk`, `*.github.io`) est refusé par le serveur et par
  `doctor` — et `*.domaine:443` couvre `https://sous.domaine`, puisque le schéma
  implique déjà ce port.
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
La documentation n'est jamais critique, même sous un préfixe de `criticalPaths` :
un fichier ignoré est autorisé sans entrée quand c'est un fichier Markdown (`*.md`,
`*.mdx`, donc `AGENTS.md` et `apps/web/AGENTS.md`), un fichier sous un arbre
`docs/` ou `openspec/`, ou un texte de licence (`LICENSE*`, `LICENCE*`).
`.github/**` en est volontairement exclu : un workflow est une configuration
exécutable, pas de la prose ; un dépôt qui veut la contrôler l'ajoute lui-même à
`criticalPaths`. Le code applicatif sous un préfixe critique reste refusé, le
diagnostic nomme les fichiers refusés et rappelle le remède `.canary/qa.json`.

`approvedSkips[].path` accepte un chemin exact ou un motif : `*` remplace une
partie d'un segment et `**` couvre zéro ou plusieurs segments, par exemple
`apps/*/generated.ts` ou `apps/**/generated.ts`. Un motif composé uniquement de
jokers (`*`, `**`, `*/*`) ou terminé par `/` approuverait tout : il n'approuve
rien et la run est refusée comme pour un skip non approuvé, sans exception.
Un chemin exact continue de fonctionner ; la politique reste lue sur le SHA de
base, donc une PR ne peut pas approuver son propre skip.

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
Un `click` porte `ifPresent: true` quand il sert uniquement à ÉTABLIR un état
dont le scénario dépend : si le contrôle est absent, l'état visé est déjà en
place, l'étape est sautée et le rapport la nomme comme sautée. Absent signifie
qu'aucun élément ne correspond au locator : un contrôle présent mais jamais
visible, un nom accessible ambigu ou deux éléments correspondants restent des
échecs visibles, jamais un saut silencieux. Cette option ne
s'applique jamais à une action métier qui doit avoir lieu — une cible absente y
reste un échec — et aucune autre action ne l'accepte. Une étape sautée ne peut
pas démontrer de transition : sa baseline est relevée avant un clic qui n'a pas
eu lieu, donc les deux valeurs sont identiques. C'est pourquoi l'assertion qui
suit une étape d'établissement se vérifie en `state`.
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
`auto_disabled`, `deleted`) sont purgées après 30 jours.

Après la deadline, la tentative passe en `expired`, avec l'audit
`automatic.preview_expired` et un log d'avertissement du worker. **Une tentative
expirée n'est jamais rejouée automatiquement** : le dashboard peut la réarmer
explicitement, ou pousser un nouveau commit.

`POST /dashboard/automatic/:id/retry` réarme une tentative en échec sur le même
commit : la livraison redevient due avec une nouvelle fenêtre complète et le
worker revérifie la même preview, jusqu'à la promotion en run réel. Seuls
`expired` et `rate_limited` peuvent l'être — un run existe déjà pour `processed`,
`discarded` se reproduirait sur les mêmes faits, et `auto_disabled` est un
interrupteur serveur. L'écriture est refusée à un viewer (403) et sur un dépôt
dont l'automatisation est désactivée (`AUTOMATIC_DISABLED`, la livraison reste
intacte). Une tentative qui n'est plus réarmable — déjà relancée, promue en run ou
écartée entre-temps — n'est pas une erreur : la réponse est son état courant, run
compris, ce que le second clic d'un opérateur doit voir. Chaque relance est
auditée `automatic.retried` avec le nombre de vérifications déjà dépensé, et les
compteurs de probes repartent de zéro.

`DELETE /dashboard/automatic/:id` supprime une tentative en échec, pour vider une
liste qui la conserve sinon 24 heures. Les deux mêmes états sont concernés : une
tentative en attente appartient encore au worker de probe, et une tentative promue
est la trace du run qu'elle a lancé. L'écriture est refusée à un viewer (403). Une
tentative qui a changé d'état entre-temps est refusée (`AUTOMATIC_NOT_DELETABLE`)
au lieu d'être supprimée, et une tentative déjà purgée ou déjà supprimée répond
`AUTOMATIC_UNKNOWN`.

La ligne ne disparaît pas : elle devient un tombeau (`status='deleted'`), invisible
pour la liste, pour l'écran de détail et pour `list_automatic_attempts`. C'est ce
tombeau qui garde la livraison déduplicée (`acceptDelivery` refuse un `(dépôt, PR,
SHA)` déjà vu, et la même livraison GitHub ne peut pas être réintroduite) : sans
lui, une redelivery GitHub ou un événement ultérieur sur le même commit serait
accepté comme neuf et reprobé — exactement le rejeu automatique qu'une tentative
expirée ne doit jamais avoir. Les tombeaux sont purgés avec les autres lignes
terminales (30 jours). La suppression et son audit `automatic.deleted` (dépôt, PR,
SHA, nombre de vérifications dépensé) sont écrits dans la même transaction : une
ligne effacée sans trace ne serait attribuable à personne.

| État | Audit | Cause |
| --- | --- | --- |
| en attente | `automatic.preview_wait` | preview sans preuve du SHA complet |
| `processed` | `automatic.promoted` | preview vérifiée, run réel créé |
| `expired` | `automatic.preview_expired` | deadline `QA_AUTO_PREVIEW_WAIT_SECONDS` dépassée |
| `rate_limited` | `automatic.rate_limited` | budgets horaires globaux/par dépôt |
| `auto_disabled` | `automatic.disabled` | `QA_AUTO_RUNS=false` |
| `auto_disabled` | `automatic.repo_disabled` | dépôt non opt-in |
| en attente | `automatic.retried` | relance manuelle depuis le dashboard |

Une tentative n'est pas un job `qa_jobs` : aucun statut de run n'est inventé, le
run réel n'est créé qu'une fois la preview vérifiée.

`GET /dashboard/automatic` expose aux administrateurs, opérateurs et viewers
ayant accès au dépôt les tentatives les plus récentes d'abord (50 au maximum),
avec un résumé des tentatives en attente, expirées et rate-limitées. Les lignes
`expired` et `rate_limited` restent visibles 24 heures ; les tentatives en attente
sont comptées dans le résumé. Un opérateur ou administrateur peut réarmer une
ligne en échec depuis la liste ou son écran de détail.

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

Après la première installation, un administrateur crée et gère les autres comptes
dans le dashboard (section « Comptes utilisateurs ») : identifiant, mot de passe, rôle
(viewer/operator/admin) et dépôts visibles. Cette gestion est une autorité d'instance :
elle demande un administrateur dont l'accès couvre tous les dépôts activés. Une identité
`users.json` ou OIDC limitée à un projet peut lire et lancer sur ce projet, mais nommer
un compte local administrateur lui donnerait un accès plus large que le sien : l'API
répond `403 ACCOUNT_SCOPE_REQUIRED`. Changer un mot de passe révoque
immédiatement toutes les sessions de ce compte. Un dépôt hors de la sélection
effective est refusé, tout comme un identifiant déjà utilisé. Le dernier
administrateur ne peut être ni supprimé ni rétrogradé, et personne ne supprime
son propre compte.

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

Chaque écran a son propre chemin : `/`, `/new-test`, `/history`,
`/history/<run-id>` pour le détail d'un test, `/history/<run-id>/report` pour
son rapport plein écran, `/automatic/<delivery-id>` et `/settings/<section>`.
Un rechargement, un lien partagé et le bouton Retour retombent donc sur la même
page. Les liens plus anciens écrits en fragment (`#run=…`, `#automatic=…`,
`#settings=…`, `#<run-id>`) restent acceptés et la barre d'adresse est réécrite
sur le chemin de l'écran au chargement.

1. **Réglages** : le menu latéral ouvre une page par section — GitHub, fournisseur
   IA, application à tester, clés API, comptes utilisateurs — et chaque page a son
   chemin (`/settings/<section>`). La page GitHub crée/installe l'App et choisit les
   dépôts ; la page « Application à tester » vérifie les contraintes des previews. Sa
   carte « Hôtes autorisés par l'administrateur » ajoute ou retire les hôtes de
   preview (ajout, retrait, enregistrement, retour à la liste du serveur) ; la liste
   est appliquée au navigateur et au proxy de sortie en quelques secondes, sans
   redémarrage, et chaque changement est audité.
2. **Nouveau test** : coller l'URL de PR, l'URL de son application de test si elle
   n'est pas fournie par GitHub, puis choisir votre modèle. La page a son propre
   chemin (`/new-test`), comme l'historique (`/history`) : un rechargement ou un
   lien partagé rouvre la même page.
3. **Vérifier les accès** : lecture de la PR et contrôle de la preview au même SHA.
   Aucune génération IA, scénario, vidéo ou écriture GitHub à cette étape.
4. **Lancer le test** : le moteur prépare et exécute les scénarios. Les paramètres
   modifiés invalident la vérification ; le moteur contrôle à nouveau la version
   au lancement. Les tokens consommés dépendent de votre endpoint IA.
5. **Historique** : phases live, verdict, assertions et vidéos. Le rapport complet
   et le commentaire GitHub sont accessibles ; le JSON et le run ID sont dans
   « Diagnostic technique ». Un résultat bloqué/annulé ne devient pas un succès.
   Un test qui n'est pas allé au bout affiche d'abord « Pourquoi ce test n'est
   pas allé au bout » : le code du diagnostic serveur, son message et la suite à
   donner, la phase atteinte et les scénarios en erreur. Le détail d'un test est
   adressable (`/history/<run-id>`) et son rapport plein écran a sa propre page
   (`/history/<run-id>/report`) : un lien partagé rouvre le même écran, et les
   boutons Retour et Avant du navigateur suivent les pages visitées.
6. **Lancements automatiques** : chaque PR détectée mais sans test indique son
   motif (« délai dépassé », « quota horaire ») et renvoie vers un écran dédié
   (`/automatic/<delivery-id>`) qui montre ce que Canary a vérifié, la preuve de
   version exigée et le déroulé des vérifications. Une tentative expirée n'est
   jamais rejouée automatiquement : « Relancer la vérification » la réarme sur le
   même commit avec un nouveau délai, depuis la liste comme depuis l'écran de
   détail. Une tentative en échec que personne ne relancera se supprime depuis ces
   deux écrans, avec une confirmation en place.

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
| `GET /`, `/new-test`, `/history`, … | Shell du dashboard : chaque écran a son chemin, et le client affiche celui que l'adresse nomme |
| `GET /auth/status` | État de première installation, aucun credential exposé |
| `POST /auth/setup` | Premier admin, lien privé temporaire requis |
| `POST /auth/login` | Connexion identifiant/mot de passe, cookie HttpOnly |
| `POST /session`, `DELETE /session` | Accès technique / déconnexion et révocation locale |
| `GET /dashboard/status` | Connexions et informations non secrètes nécessaires au guide |
| `GET /dashboard/api-keys` | Clés API de l'instance, admin seulement : nom, préfixe, portée, dernière utilisation, jamais le jeton |
| `POST /dashboard/api-keys` | `{name,role?}` ; `role` vaut `viewer` (défaut) ou `operator`, jamais `admin` ; rend le jeton une seule fois |
| `POST /dashboard/api-keys/:id/secret` | Rend le jeton à recopier sans l'afficher ; 409 si la clé est révoquée, 403 si sa portée dépasse celle de l'appelant |
| `DELETE /dashboard/api-keys/:id` | Révocation immédiate ; la clé est refusée à la requête suivante ; 403 hors de la portée de l'appelant |
| `POST /mcp` | Serveur MCP des agents IA, clé API en `Authorization: Bearer` uniquement |
| `GET /dashboard/automatic` | Tentatives automatiques en attente/expirées/quota, limitées aux dépôts de l'utilisateur |
| `GET /dashboard/automatic/:id` | Détail d'une tentative : motif, preuve de version exigée (admin) et piste d'audit ; 403 hors de ses dépôts |
| `POST /dashboard/automatic/:id/retry` | Réarme une tentative expirée ou refusée par le quota avec une nouvelle fenêtre ; 403 pour un viewer, 400 si l'état ou le dépôt ne le permettent pas |
| `DELETE /dashboard/automatic/:id` | Retire une tentative expirée ou refusée par le quota de la liste en la laissant en base comme tombeau (`deleted`, déduplication conservée) ; rend l'état qu'elle avait ; 403 pour un viewer, 400 `AUTOMATIC_NOT_DELETABLE` si elle attend encore ou a produit un run, `AUTOMATIC_UNKNOWN` si elle a déjà été purgée ou retirée |
| `POST /runs/preflight` | `{prUrl,previewUrl?,model}` ; accès/provenance sans enqueue ni publication |
| `GET /me` | Identité et dépôts accessibles |
| `GET /accounts` | Comptes humains : `{accounts:[{id,username,role,repos,createdAt}]}`, administrateur d'instance uniquement (403 `ACCOUNT_SCOPE_REQUIRED` si son accès ne couvre pas tous les dépôts) |
| `POST /accounts` | `{username,password,role,repos}` ; 201 `{account}` |
| `PATCH /accounts/:id` | `{role?,repos?,password?}` ; 200 `{account}`, mot de passe changé = sessions du compte révoquées |
| `DELETE /accounts/:id` | 200 `{ok:true}` ; dernier admin et compte courant refusés |
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
du coût. Un appel est compté à l'usage rapporté par l'endpoint ; si `usage` est
absent, le runner chiffre la sortie qu'il a réellement livrée — jamais le plafond
`QA_CALL_MAX_TOKENS`, qui n'est qu'une autorisation — et marque le run comme
estimé (`usage.estimated`).
Les budgets globaux de temps/tokens sont appliqués indépendamment du tarif.
`OTEL_EXPORTER_OTLP_ENDPOINT` active les spans OTLP ; un collecteur externe est
nécessaire pour les consulter.

Copier `config/users.example.json` vers `config/users.json`, configurer les vrais
SHA-256 des tokens individuels et `QA_USERS_FILE=/app/config/users.json`.
Ce fichier ne sert qu'aux identités techniques (token SHA-256 ou sujet OIDC) :
il n'est pas modifiable depuis le dashboard, et les comptes humains se créent
dans Réglages → Comptes utilisateurs, pas ici.
Rôles : viewer (lecture), operator (lancement/annulation), admin (suppression,
métriques). Chaque identité doit avoir une liste explicite de dépôts. Pour SSO,
configurer issuer/audience/JWKS et mapper `oidcSubject` à l'identité locale ; les
JWT d'accès RS256/ES256 sont vérifiés, les claims ne peuvent pas choisir leurs
droits. L'émission du JWT et le login IdP restent gérés par votre IdP.

## Clés API et serveur MCP

Un administrateur crée des clés API dans **Réglages → Clés API** (ou par l'API
ci-dessus). Une clé est un jeton `qa_live_…` affiché en entier une seule fois.
Le serveur en garde une empreinte et une copie chiffrée : le bouton Copier de la
liste rend le jeton sans jamais l'afficher à l'écran. Révoquer une clé la refuse
dès la requête suivante ; la ligne reste pour l'audit.

Une clé lit les dépôts en vigueur au moment de sa création — la sélection GitHub
des réglages, plafonnée par `GITHUB_ALLOWED_REPOS`, et bornée par ceux de son
émetteur. Sa **portée** décide de ce qu'elle peut faire de plus :

| Portée | Ce qu'elle peut faire |
| --- | --- |
| `viewer` (défaut) | Lire les tests, les rapports et les tentatives automatiques ; rien lancer. |
| `operator` | La lecture, plus lancer un test et payer son exécution. |

Une clé n'est jamais un opérateur du dashboard, quelle que soit sa portée : le
principal qu'elle présente reste un lecteur, plus la capacité de lancer. Annuler
un test, réarmer une tentative automatique, partager un artefact signé, toucher
aux réglages ou aux comptes lui sont donc refusés (`403`), et le resteront pour
toute route d'écriture ajoutée plus tard — `GET /me` répond `viewer` pour une clé
`operator`. Seul `POST /runs` et l'outil MCP `launch_run` honorent la capacité.

Aucune clé n'est `admin` : les réglages, les comptes, la politique de previews et
la suppression d'un test restent au dashboard. La portée est figée à la création —
une clé vit avec le droit qu'elle a reçu, sans élargissement silencieux — et la
liste des clés affiche celle de chacune. Un `POST /runs` avec une clé `viewer` est
refusé (`403`, `LAUNCH_DENIED`).

Les dépôts d'une clé sont l'intersection de la sélection en vigueur avec ceux de
l'identité qui l'émet : une clé ne dépasse jamais son émetteur. Un administrateur
`users.json`/OIDC limité à un projet ne peut donc pas déléguer un accès — lecture
ou lancement — sur les autres dépôts de l'instance, alors qu'un compte local
administrateur porte toujours la sélection entière. La liste et le journal
d'audit (`api_key.created`) enregistrent cette portée.

La gestion suit la même règle : `GET /dashboard/api-keys` ne montre à un
administrateur restreint que les clés dont la portée est comprise dans la sienne,
et copier le jeton ou révoquer une clé plus large répond `403`
(`API_KEY_SCOPE`). Sans cela, recopier le jeton d'une clé voisine rendrait la
capacité que la règle d'émission vient d'interdire — l'administrateur restreint
ne peut donc administrer que ce qu'il aurait pu émettre.

La même clé ouvre le serveur MCP du service :

```bash
claude mcp add --transport http canary-qa https://votre-domaine-qa/mcp \
  --header "Authorization: Bearer qa_live_…"
```

`POST /mcp` est sans état et n'accepte qu'une clé API : un cookie de session ne
l'ouvre pas, ce qui le met hors de portée d'une requête intersite. Huit outils en
lecture : `list_runs` (statut, résultat, modèle, coût), `get_run`,
`list_automatic_attempts` et `get_automatic_attempt` (état, cause, chronologie des
sondes), puis l'exploration des preuves. `list_run_sessions` énumère les sessions
Canary d'un test — une par scénario, plus la découverte — avec leur issue et
l'inventaire de leurs artefacts ; `get_session_results`, `get_session_console` et
`get_session_har` en rendent le contenu page par page (16 Kio par défaut, reprise
par `nextOffset`). `get_run` rend le `result.json` du run — scénarios, assertions,
vidéos, coût, publication. Tout cela reste soumis à la politique de preuves
brutes : traces, HAR, journaux natifs et `results.json` sont refusés tant que
`QA_RAW_EVIDENCE` n'est pas à `true`, et chaque lecture de preuve est auditée
(`artifact.read`). Au-delà de 256 Kio, le contenu n'est plus rendu du tout :
l'outil rend le chemin de l'artefact, à demander avec la même clé API, et dont la
lecture est auditée. Le chemin n'est pas signé : un porteur anonyme (lien signé
valable cinq minutes) reste réservé au partage depuis le dashboard, qui exige
l'autorité d'écrire sur le run et l'audite (`artifact.share`). C'est le seul
chemin vers la trace Playwright, que les rapports relient déjà. Un run purgé par
la rétention est annoncé comme tel, jamais inventé.

`launch_run` (`{prUrl,previewUrl?,publish?,model?,idempotencyKey?}`) est le seul
outil qui écrit, et il exige une clé `operator` : il passe par le même lanceur que
`POST /runs`, donc les mêmes contrôles s'appliquent — GitHub connecté, dépôt dans
le périmètre de la clé, modèle présent au catalogue, hôte de preview autorisé,
espace disque suffisant. Le SHA testé est celui que GitHub rend pour la PR au
moment de l'appel, jamais celui qu'un agent annonce ; le run créé appartient à la
clé (`owner: key:<id>`). `idempotencyKey` est le jeton de reprise de l'agent : le
même jeton sur le même SHA rend le test déjà créé au lieu d'en payer un second. Un
refus — portée insuffisante, modèle hors catalogue, URL qui n'est pas une PR,
dépôt hors périmètre — revient comme une réponse lisible de l'outil, pas comme une
erreur de protocole, pour que l'agent sache quoi corriger. Un test lancé reste
facturé : le budget horaire des lancements automatiques
(`QA_WEBHOOK_MAX_RUNS_PER_HOUR`) ne couvre pas ce chemin, qui suit les droits du
dashboard.

Le transport répond en JSON, sans connexion longue : aucun réglage de mise en
tampon SSE n'est nécessaire côté reverse proxy.

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
Les rapports (principal et par scénario), vidéos et images sont accessibles à tout
utilisateur autorisé sur le dépôt ; les dumps bruts (trace, HAR, console,
`results.json`) sont refusés par défaut et `QA_RAW_EVIDENCE=true` permet leur accès
selon les mêmes droits. Restreindre les données de test,
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

Les logs, HAR, ZIP et le manifeste `results.json` sont des preuves brutes,
interdites par défaut via HTTP comme par les outils MCP qui lisent une session.
Les rapports (principal et par scénario), leurs vidéos, images et captures
restent accessibles aux utilisateurs autorisés. N'activez `QA_RAW_EVIDENCE`
qu'après avoir
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

L'endpoint est appelé en streaming (`OPENAI_STREAM=true`) : une réponse non streamée n'envoie rien avant le dernier token et un proxy devant l'endpoint la coupe (Cloudflare répond 524 après environ 100 s), ce qui rend un long plan impossible à obtenir. Sur un modèle de raisonnement, `OPENAI_REASONING_EFFORT` borne le raisonnement : sans lui, le raisonnement peut consommer tout `QA_PLAN_MAX_TOKENS` et ne laisser aucun JSON.
