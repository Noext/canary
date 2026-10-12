/**
 * Every user-visible string of the dashboard.
 *
 * The interface is French only: this module is a single, typed source of truth
 * for the copy, not an i18n framework. Keep keys flat enough that a missing
 * string is a type error at the call site.
 */

export type ViewName = "home" | "new" | "runs" | "settings";

/** Server error codes the interface explains in French. */
export const errorMessages: Record<string, string | undefined> = {
  PREVIEW_SHA_MISMATCH:
    "L’application de test ne présente pas le commit de cette PR. Déployez cette version puis vérifiez à nouveau.",
  PREVIEW_NOT_FOUND:
    "Aucune application de test trouvée pour cette PR. Renseignez son URL dans le formulaire.",
  PREVIEW_HOST_NOT_ALLOWED:
    "Cette adresse de test n’est pas autorisée sur le serveur. Consultez les hôtes dans Réglages.",
  GITHUB_REPOSITORY_DENIED:
    "Ce dépôt n’est pas connecté à votre espace. Sélectionnez-le dans Réglages → GitHub.",
  MODEL_NOT_AVAILABLE:
    "Ce modèle n’est plus disponible chez votre fournisseur. Actualisez la liste et choisissez explicitement un modèle.",
  MODEL_CATALOG_INVALID:
    "Le fournisseur n’a pas renvoyé un catalogue de modèles valide. Vérifiez son endpoint et l’accès Cloudflare.",
  HTTP_403:
    "L’accès a été refusé. Vérifiez les permissions GitHub ou l’autorisation Cloudflare de l’IP du VPS.",
  HTTP_401:
    "La connexion à ce service a été refusée. Vérifiez ses credentials sur le serveur.",
};

export const roles = {
  admin: "Administrateur",
  operator: "Opérateur",
  viewer: "Lecture",
} as const;

export const runStates: Record<string, string> = {
  queued: "En attente",
  running: "En cours",
  completed: "Terminé",
  cancelled: "Annulé",
  interrupted: "Interrompu",
  failed: "Erreur",
};

export const outcomes: Record<string, string> = {
  passed: "Réussi",
  failed: "Échec",
  blocked: "Bloqué",
  stale: "Version obsolète",
  skipped: "Non testé",
};

export const phases: Record<string, string> = {
  context: "Lecture des changements de la pull request",
  preview: "Vérification de la version de votre application",
  discovery: "Découverte de l’application dans Chromium",
  planning: "Préparation des scénarios par l’IA",
  execution: "Exécution des scénarios dans Chromium",
  evidence: "Finalisation des vidéos et captures",
  verification: "Vérification des assertions et de la couverture",
  publication: "Publication du rapport sur GitHub",
  done: "Test terminé",
};

export const phaseSteps = [
  "Lecture de la PR",
  "Préparation",
  "Exécution Chromium",
  "Vérification",
  "Publication",
] as const;

export const resultSummaries: Record<string, string> = {
  passed: "Les assertions ont réussi sur la version testée.",
  failed: "Au moins une assertion a échoué.",
  blocked:
    "Le test n’a pas pu terminer : l’application ou le scénario a bloqué.",
  stale: "La version testée ne correspond plus au dernier commit de la PR.",
  skipped:
    "Aucun scénario n’a été exécuté : le planificateur n’a rien retenu de sûr.",
};

export const views: Record<
  ViewName,
  { breadcrumb: string; intro: string; title: string }
> = {
  home: {
    breadcrumb: "Vue d’ensemble",
    intro: "Connectez vos outils, puis lancez votre premier test.",
    title: "Bienvenue dans Canary",
  },
  new: {
    breadcrumb: "Nouveau test",
    intro: "Vérifiez une pull request dans un vrai navigateur.",
    title: "Nouveau test",
  },
  runs: {
    breadcrumb: "Historique",
    intro: "Suivez leur progression et inspectez les preuves.",
    title: "Vos tests",
  },
  settings: {
    breadcrumb: "Réglages",
    intro: "Vos connexions et les dépôts que Canary peut tester.",
    title: "Réglages de votre espace",
  },
};

export const shell = {
  account: "Connexion requise",
  breadcrumbFallback: "Vue d’ensemble",
  footer: "Du code aux preuves.",
  footerDetail:
    "Un vrai Chromium, des assertions et une vidéo pour chaque scénario.",
  logout: "Déconnexion",
  nav: {
    home: "Accueil",
    new: "Nouveau test",
    runs: "Historique",
    settings: "Réglages",
  },
  tagline: "QA autonome pour vos PR",
};

export const auth = {
  accountEyebrow: "Votre espace de qualité",
  alreadyHaveAccount: "Compte local · aucun SSO requis.",
  confirmation: "Confirmer le mot de passe",
  createAccount: "Créer mon compte administrateur",
  creating: "Création de votre compte…",
  firstRun: {
    intro:
      "Choisissez votre identifiant et un mot de passe. Nous vous guiderons ensuite pour connecter GitHub et lancer votre premier test.",
    title: "Créez votre compte administrateur",
  },
  hidePassword: "Masquer",
  login: "Se connecter",
  loginIntro:
    "Retrouvez vos tests, leurs vidéos et les résultats de vos pull requests.",
  loginTitle: "Connectez-vous",
  loggingIn: "Connexion…",
  passwordLabel: "Mot de passe",
  passwordMismatch: "Les mots de passe ne correspondent pas.",
  passwordPlaceholder: "Votre mot de passe",
  passwordToggleAria: {
    hide: "Masquer le mot de passe",
    show: "Afficher le mot de passe",
  },
  setupCommandPrefix:
    "docker compose exec -T pr-qa canary-pr-qa setup-admin --origin ",
  setupInstructions:
    "Ouvrez le lien d’installation généré par l’opérateur du serveur pour créer le premier administrateur.",
  setupPrivacy: "Le lien est privé et valable 15 minutes.",
  showPassword: "Afficher",
  technicalLogin: "Connexion technique",
  technicalSummary: "Accès technique (API / SSO)",
  tokenLabel: "Token ou JWT",
  usernameLabel: "Identifiant",
  usernamePlaceholder: "Votre identifiant",
} as const;

export const home = {
  cardTitle: "Vos tests",
  emptyIntro:
    "Votre premier résultat apparaîtra ici, avec les scénarios exécutés et leurs vidéos.",
  emptyTitle: "Aucun test pour le moment",
  heroEyebrow: "Votre première vérification",
  heroNoteDefault: "Deux connexions à vérifier avant de commencer.",
  heroNoteFirstRun: "Deux connexions à vérifier avant de commencer.",
  introDefault:
    "Donnez une pull request à Canary. Il prépare des scénarios, teste votre application dans Chromium et vous montre ce qui fonctionne, avec une vidéo.",
  introReturning:
    "Lancez un nouveau test ou reprenez le suivi de vos derniers résultats.",
  introViewer:
    "Consultez les résultats, les assertions et les vidéos des dépôts auxquels vous avez accès.",
  onboarding: {
    githubBody:
      "Autorisez Canary à lire les PR et à publier leurs résultats sur les dépôts de votre choix.",
    githubTitle: "Connecter GitHub",
    modelBody:
      "Vérifiez l’accès à votre fournisseur. Le modèle configuré reste votre choix par défaut.",
    modelTitle: "Choisir votre IA",
    runBody:
      "Vérifiez la PR et son application de test, puis lancez les scénarios dans le navigateur.",
    runCta: "Voir le formulaire →",
    runTitle: "Tester une pull request",
    title: "Prêt pour votre premier test ?",
  },
  showHistory: "Voir l'historique →",
  stats: {
    active: "En cours / en attente",
    activeHint: "Suivi en direct",
    passed: "Tests réussis",
    passedHint: "Assertions validées",
    total: "Tests récents",
    totalHint: "Dans votre espace",
  },
  titleDefault: "Votre premier test commence ici.",
  titleReturning: "Vos pull requests, vérifiées dans le navigateur.",
  titleViewer: "Suivez les tests de votre équipe.",
  actionViewer: "Voir les tests",
  actionStart: "Configurer mon espace",
  actionRun: "Tester une pull request",
  actionChooseModel: "Choisir mon modèle IA",
  githubChooseRepos: "Choisir vos dépôts →",
  githubConnect: "Connecter GitHub →",
  githubTechnical: "Accès technique actif",
  modelStateBusy: "Chargement du catalogue…",
  modelStateReady: "Modèle disponible",
  modelStateRetry: "Vérifier la connexion →",
  modelStateUnavailable:
    "Modèle par défaut indisponible : choisissez explicitement un modèle.",
  noteProgress:
    "Votre progression est enregistrée. Commencez par l’étape indiquée.",
  noteReady: "PR + application de test → scénarios, vidéos et résultat.",
  noteViewer: "Votre compte dispose d’un accès en lecture.",
  onboardingIntro:
    "Suivez ces étapes dans l’ordre. Votre configuration est conservée.",
  runsLoading: "Chargement de vos tests…",
  setupCount: (ready: number) => `${ready}/2 connexions prêtes`,
} as const;

export const newTest = {
  blocker: "Connectez GitHub et vérifiez l’accès IA avant de lancer un test.",
  check: "Vérifier les accès",
  checkChanged: "Les paramètres ont changé. Vérifiez à nouveau.",
  checkReading: "Lecture de la PR et vérification de son application…",
  checkReady:
    "Vous pouvez lancer le test. Aucun scénario ni commentaire GitHub n’a encore été créé.",
  checkRequired: "Vérifiez d’abord les accès et la version de l’application.",
  guide: {
    eyebrow: "Comment ça fonctionne",
    fence:
      "La preview doit représenter le commit de la PR. La vérification vous indique ce qui manque avant de lancer l’IA.",
    items: [
      ["Canary lit les changements", "Il déduit les scénarios à vérifier."],
      ["Chromium joue les scénarios", "Sur la version exacte de votre PR."],
      ["Vous obtenez un verdict", "Assertions, vidéo et rapport GitHub."],
    ],
    title: "Une PR, des preuves concrètes.",
  },
  intro: "La vérification des accès précède le lancement des scénarios.",
  launch: "Lancer le test",
  launching: "Création du test…",
  modelAvailable: (count: number) =>
    `${count} modèles disponibles · aucun remplacement automatique.`,
  modelChoose: "Choisir un modèle",
  modelLabel: "Modèle IA pour ce test",
  modelLoading: "Chargement des modèles…",
  modelRefresh: "Actualiser les modèles",
  modelRequired:
    "Modèle précédent ou par défaut indisponible : choisissez explicitement un modèle.",
  modelUnavailable: "Catalogue indisponible",
  previewHelp:
    "C'est le site que Chromium visitera. Laissez vide si GitHub fournit déjà une preview pour cette PR.",
  previewLabel: "URL de l'application de test",
  prHelp: "Copiez le lien d'une PR ouverte sur un dépôt connecté à Canary.",
  prLabel: "URL de la pull request",
  publishedNotice:
    "Canary publiera le résultat sur cette PR. Le lancement utilise votre endpoint IA et peut consommer des tokens.",
  summary: (fields: {
    host: string;
    number: number;
    repo: string;
    sha: string;
    title: string;
  }) =>
    `${fields.title} · ${fields.repo} #${fields.number} · version ${fields.sha.slice(0, 12)} · ${fields.host}`,
  verified: "PR et application vérifiées",
  title: "Que souhaitez-vous tester ?",
} as const;

export const runs = {
  cancel: "Annuler le test",
  cancelRequested: "Annulation demandée. Le worker finalise les preuves.",
  detailEyebrow: "Test en cours",
  emptyIntro: "Lancez votre premier test depuis « Nouveau test ».",
  emptyTitle: "Aucun test pour le moment",
  eventsLoading: "En attente du worker…",
  filteredEmptyIntro: "Modifiez votre recherche ou revenez à tous les états.",
  filteredEmptyTitle: "Aucun test ne correspond à ces filtres",
  filters: {
    all: "Tous les états",
    cancelled: "Annulés",
    completed: "Terminés",
    interrupted: "Interrompus",
    search: "Rechercher un dépôt ou un commit",
    searchLabel: "Rechercher un projet ou SHA",
    statusLabel: "Filtrer les tests",
    submit: "Filtrer",
  },
  // Two labels for the model of a run recorded before options were stored: the
  // history table shows the first, the detail provenance the second.
  historicalModel: "Historique",
  historicalModelDetail: "Modèle historique",
  historyTitle: "Historique des tests",
  historyIntro: "Vos tests récents, leur état et leurs résultats.",
  liveConnected: "Suivi en direct connecté",
  liveConnecting: "Connexion du suivi…",
  liveDone: "Suivi terminé",
  liveInterrupted: "Le test a été interrompu : ",
  liveInvalid: "Suivi interrompu : réponse invalide",
  liveReconnecting: "Reconnexion du suivi…",
  invalidFrame: "Le suivi du test a renvoyé une réponse invalide.",
  missingResult: "Aucun rapport de scénarios disponible pour ce test. ",
  phaseDetail: (scenario: string, action: string) => `${scenario} · ${action}`,
  report: "Ouvrir le rapport",
  resultFallback: "Résultat disponible.",
  runIdentifierPrefix: "Run ID : ",
  githubResult: "Résultat sur GitHub ↗",
  technicalSummary: "Diagnostic technique et données du run",
  technicalIntro:
    "Le run ID permet de retrouver ce test dans les logs du serveur.",
  publicationFailed: " La publication GitHub a échoué.",
  table: {
    commit: "Commit",
    created: "Création",
    model: "Modèle IA",
    pr: "Pull request",
    result: "Résultat",
    status: "État",
  },
  assertions: (passed: number, total: number) =>
    `${passed}/${total} assertions validées`,
  assertionsEmpty: "Aucune assertion exécutée",
  usage: (tokens: number, costUsd: number, configured: boolean) =>
    `${tokens} tokens · ${
      configured ? `coût estimé $${costUsd.toFixed(4)}` : "coût non configuré"
    }`,
  videoLabel: (title: string) => `Vidéo du scénario ${title}`,
} as const;

export const settings = {
  ai: {
    catalog: (count: number) => `${count} modèles disponibles`,
    catalogAccessible: "Catalogue accessible",
    defaultModel: (model: string) => `Modèle par défaut : ${model}`,
    endpoint: (host: string) => `Endpoint : ${host}`,
    failureHelp:
      "Vérifiez l’endpoint, sa clé et l’autorisation Cloudflare de l’IP de sortie du VPS. Aucun autre modèle n’est choisi automatiquement.",
    failureSummary: "Si la connexion échoue",
    intro:
      "Canary utilise l’endpoint configuré sur votre serveur. Le modèle se choisit pour chaque test.",
    needsAttention: "Connexion à vérifier",
    retry: "Vérifier à nouveau l'accès IA",
    title: "Votre fournisseur IA",
  },
  eyebrow: "Connexion 2 / 2",
  eyebrowGithub: "Connexion 1 / 2",
  github: {
    appName: (slug: string, id: string) => `${slug} · App #${id}`,
    confirmDelete:
      "Supprimer définitivement l'App GitHub ? L'App, ses installations et ses webhooks disparaissent de GitHub : cette action est irréversible.",
    confirmUninstall:
      "Désinstaller l'App GitHub de tous vos dépôts ? Les webhooks et les accès sont révoqués, et la connexion locale est effacée. Vous pourrez réinstaller l'App.",
    connected: (count: number) => `Connecté · ${count} dépôt(s)`,
    createCta: "Créer mon App sur GitHub →",
    created:
      "App créée. Installez-la sur GitHub, actualisez la connexion puis choisissez vos dépôts.",
    dangerSummary: "Supprimer la connexion GitHub",
    dangerBody:
      "La désinstallation révoque les webhooks et les accès de l'App ; la suppression efface aussi l'App de GitHub et ne peut pas être annulée. Dans les deux cas la connexion locale est effacée.",
    deleteApp: "Supprimer l'App GitHub",
    uninstallCta: "Désinstaller l'App de mes dépôts",
    emptyRepos:
      "Aucun dépôt accessible. Installez votre App puis cliquez sur Actualiser.",
    installCta: "Installer / gérer les dépôts sur GitHub",
    intro:
      "L'App vous appartient. GitHub vous demande de confirmer sa création et les dépôts auxquels elle pourra accéder.",
    legacyConfigured:
      "Un accès technique est déjà configuré. Créez votre App pour gérer GitHub depuis cet assistant.",
    messageConnected:
      "Dépôts enregistrés. Votre App est prête pour les tests et les webhooks.",
    messageFirstRun:
      "Première étape : créez votre App. Vous reviendrez ici après confirmation sur GitHub.",
    messageSaved:
      "Dépôts enregistrés. Vous pouvez maintenant préparer votre premier test.",
    nameLabel: "Nom de votre App GitHub",
    namePlaceholder: "Canary QA de mon équipe",
    notConnected: "À connecter",
    toFinish: "À terminer",
    orgHelp: "Laissez vide pour créer l'App sur votre compte GitHub personnel.",
    orgLabel: "Organisation GitHub (facultatif)",
    orgPlaceholder: "Vide pour votre compte personnel",
    originHint:
      "Le serveur doit être joignable sur son domaine HTTPS public. Les callbacks et le webhook y sont configurés automatiquement.",
    permissionsSummary: "Permissions et configuration serveur",
    permissionsBody:
      "Lecture du code et des déploiements. Écriture des résultats de PR, des statuts et des Checks. Aucun token à copier dans ce formulaire.",
    refresh: "Actualiser la connexion",
    removalCancelled: "Suppression annulée.",
    removalDeleted: "App supprimée sur GitHub.",
    removalUninstalled: "App désinstallée sur GitHub.",
    removalWarning: (details: string) =>
      `Connexion locale effacée ; l'App GitHub est inchangée. ${details}`,
    restricted: " · restreint par le serveur",
    reposLegend: "Dépôts utilisés pour la QA",
    saveRepos: "Enregistrer les dépôts sélectionnés",
    title: "Votre connexion GitHub",
    trail: ["1. Créer l'App", "2. Installer", "3. Choisir les dépôts"],
    webhookLast: (date: string, status: string) =>
      ` Dernier webhook : ${date} · ${status}`,
    private: "Privé",
    public: "Public",
  },
  preview: {
    help: "Ces restrictions sont configurées par l’opérateur du serveur. Le bouton Vérifier les accès vous donne un diagnostic avant lancement.",
    hosts: (hosts: string) => `Hôtes autorisés : ${hosts}`,
    hostsFallback: "Les hôtes sont définis par l'opérateur du serveur.",
    intro:
      "Pour chaque PR, Canary a besoin d'une URL de test présentant exactement ses changements.",
    modeAutomatic:
      "Canary déduit l'URL de test à partir du déploiement de la PR.",
    modeManual: "Renseignez l'URL de test de chaque PR dans le formulaire.",
    proofFallback:
      "L'application doit exposer le commit dans un en-tête de version.",
    proofHeader: (header: string) => `En-tête de version : ${header}`,
    proofPath: (path: string) => `Chemin de version : ${path}`,
    title: "L'application à tester",
    versionSummary: "Hôtes autorisés et preuve de version",
  },
  title: "Vos connexions",
} as const;

export const common = {
  cancel: "Annuler",
  checking: "Vérification…",
  confirm: "Confirmer",
  loading: "Chargement…",
  retry: "Réessayer",
  unknownError: "Une erreur inattendue est survenue.",
} as const;
