/**
 * Every user-visible string of the dashboard.
 *
 * The interface is French only: this module is a single, typed source of truth
 * for the copy, not an i18n framework. Keep keys flat enough that a missing
 * string is a type error at the call site.
 */

export type ViewName =
  | "home"
  | "new"
  | "runs"
  | "settings"
  | "automatic"
  | "run";

/** Server error codes the interface explains in French. */
export const errorMessages: Record<string, string | undefined> = {
  CANARY_START_FAILED:
    "Canary n’a pas pu ouvrir sa session Chromium : le moteur ou son navigateur n’était pas disponible.",
  CONTEXT_INCOMPLETE:
    "Canary n’a pas reçu assez de contexte sur la pull request pour préparer des scénarios sûrs.",
  CONTRACT_BUDGET:
    "Le scénario a épuisé son budget d’actions sans terminer ce qui était prévu.",
  CONTRACT_INCOMPLETE:
    "Le scénario s’est arrêté avant d’avoir joué toutes les étapes prévues.",
  CONTRACT_VIOLATION:
    "Le scénario a été interrompu : une étape ne respectait plus le plan validé.",
  CRITICAL_COVERAGE_MISSING:
    "Une partie importante des changements de la pull request n’a pas été couverte par les scénarios.",
  EVIDENCE_VIDEO_MISSING:
    "La vidéo de preuve n’a pas pu être produite pour ce scénario.",
  GITHUB_NOT_CONNECTED: "Aucune App GitHub n’est connectée à cette instance.",
  MODEL_CATALOG_EMPTY:
    "Le fournisseur n’a renvoyé aucun modèle utilisable. Vérifiez son endpoint et sa clé.",
  MODEL_JSON_INVALID:
    "Le modèle a renvoyé une réponse que Canary n’a pas pu interpréter.",
  MODEL_NOT_ALLOWED:
    "Ce modèle n’est pas autorisé sur ce serveur. Choisissez-en un dans la liste.",
  MODEL_OUTPUT_INCOMPLETE:
    "La réponse du modèle était incomplète : le plan de test n’a pas pu être finalisé.",
  MODEL_PROVIDER_DENIED:
    "Le fournisseur IA a refusé la requête. Vérifiez la clé, le quota et l’autorisation Cloudflare de l’IP du VPS.",
  PR_CHANGED:
    "La pull request a changé pendant le test : ce résultat ne correspond plus au dernier commit.",
  PR_CLOSED: "Cette pull request est fermée.",
  PREVIEW_NOT_FOUND:
    "Canary ne connaît l’URL d’aucune application de test pour ce commit : aucun modèle d’URL n’est configuré et GitHub n’annonce aucun déploiement pour ce commit.",
  PREVIEW_SHA_MISMATCH:
    "L’application de test répond, mais elle n’annonce pas le commit de cette PR : Canary ne peut pas prouver que la version servie est bien celle-ci.",
  PREVIEW_HOST_NOT_ALLOWED:
    "Cette adresse de test n’est pas autorisée sur le serveur. Consultez les hôtes dans Réglages.",
  GITHUB_REPOSITORY_DENIED:
    "Ce dépôt n’est pas connecté à votre espace. Sélectionnez-le dans Réglages → GitHub.",
  MODEL_NOT_AVAILABLE:
    "Ce modèle n’est plus disponible chez votre fournisseur. Actualisez la liste et choisissez explicitement un modèle.",
  MODEL_CATALOG_INVALID:
    "Le fournisseur n’a pas renvoyé un catalogue de modèles valide. Vérifiez son endpoint et l’accès Cloudflare.",
  RUN_BUDGET_EXCEEDED:
    "Le test a dépassé le budget de tokens autorisé pour un run.",
  RUN_NOT_FOUND:
    "Ce test n’existe pas ou a été purgé. Vérifiez son identifiant dans l’historique.",
  RUN_DEADLINE: "Le test a dépassé le temps maximum autorisé pour un run.",
  STALE_HEAD: "Le commit testé n’est plus la tête de la pull request.",
  TRANSITION_NOT_OBSERVED:
    "Transition non observée : la valeur relevée après l’étape est identique à celle d’avant, donc le changement attendu n’a pas eu lieu. Ce n’est pas une régression prouvée de l’élément.",
  WEBHOOK_RATE_LIMIT:
    "Le budget horaire de lancements automatiques de Canary (global ou par dépôt) est atteint.",
  WRITE_EVIDENCE_MISSING:
    "Les preuves écrites attendues n’ont pas été trouvées pour ce scénario.",
  HTTP_403:
    "L’accès a été refusé. Vérifiez les permissions GitHub ou l’autorisation Cloudflare de l’IP du VPS.",
  HTTP_401:
    "La connexion à ce service a été refusée. Vérifiez ses credentials sur le serveur.",
};

/**
 * Network and contract failures raised by the API client. They reach the user
 * through the global alert, so they belong to the shared copy like the rest.
 */
export const apiErrors = {
  contract:
    "La réponse du serveur ne correspond pas au contrat attendu. Rechargez la page ; si le problème persiste, signalez la référence ci-dessous.",
  failed: (status: number) => `La requête a échoué (HTTP ${status}).`,
  invalidResponse: (status: number) =>
    `Le serveur n'a pas renvoyé une réponse valide (HTTP ${status}). Vérifiez sa disponibilité.`,
  requestFailed: "La requête a échoué.",
  unexpected: "Une erreur inattendue est survenue.",
  unreachable:
    "Le serveur est injoignable. Vérifiez qu'il est démarré et accessible.",
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

/**
 * Lifecycle of a pull-request delivery. The first three are what the home block
 * lists; the terminal ones are what the detail screen meets when it opens an
 * attempt by its id after the attempt left the list.
 */
export const automaticStates: Record<string, string> = {
  waiting: "En attente de la préversion",
  expired: "Délai dépassé",
  rate_limited: "Quota horaire atteint",
  promoted: "Test lancé",
  discarded: "Sans suite",
  disabled: "Lancements désactivés",
};

/**
 * Machine reason codes of an automatic attempt, explained in French. The two
 * preview codes are deliberately distinct: one says Canary has no URL to check,
 * the other says the URL it checked does not prove the commit. Telling them
 * apart is what stops "déployez le commit" being read as "votre déploiement a
 * échoué" when the deployment was simply never located, or never announced
 * which commit it serves.
 */
export const automaticReasons: Record<string, string> = {
  AUTO_REPO_DISABLED:
    "Les lancements automatiques sont désactivés pour ce dépôt : Canary n’a vérifié aucune application de test.",
  AUTO_RUNS_DISABLED:
    "Les lancements automatiques sont désactivés sur le serveur : Canary n’a rien vérifié.",
  PREVIEW_NOT_FOUND:
    "Canary n’a trouvé aucune application de test pour ce commit : il ne connaît aucune URL à vérifier (aucun modèle d’URL configuré, aucun déploiement GitHub pour ce commit).",
  PREVIEW_SHA_MISMATCH:
    "L’application de test répond, mais elle n’annonce pas ce commit : Canary ne peut pas prouver que la version servie est celle de la pull request.",
  PREVIEW_HOST_NOT_ALLOWED:
    "L’adresse de test n’est pas autorisée sur le serveur. Vérifiez les hôtes dans Réglages.",
  PREVIEW_UNAVAILABLE:
    "L’application de test n’a pas répondu ou n’a pas pu être vérifiée. Canary réessaie avec un délai croissant.",
  WEBHOOK_RATE_LIMIT:
    "Le budget horaire de lancements automatiques de Canary (global ou par dépôt) est atteint. Ce commit n'est pas rejoué automatiquement : attendez la prochaine fenêtre, poussez un nouveau commit ou lancez le test depuis « Nouveau test ».",
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
  automatic: {
    breadcrumb: "Lancements automatiques",
    intro:
      "Ce qui a été tenté, pourquoi le test n’a pas démarré et ce qu’il reste à faire.",
    title: "Pourquoi ce test n’a pas démarré",
  },
  run: {
    breadcrumb: "Détail du test",
    intro:
      "La phase atteinte, la cause de l’arrêt et les preuves enregistrées.",
    title: "Détail du test",
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
  prPlaceholder: "https://github.com/votre-equipe/projet/pull/123",
  previewPlaceholder: "https://preview-de-votre-pr.example.com",
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

export const automatic = {
  attempts: (count: number) =>
    count === 1 ? "1 tentative" : `${count} tentatives`,
  deadline: (date: string) => `Délai : ${date}`,
  detail: "Voir le détail",
  empty: "Aucune tentative automatique en attente.",
  emptyHint:
    "Canary lancera un test dès qu’une pull request changera sur un dépôt en lancement automatique.",
  enabledRepos: (count: number) => `${count} dépôt(s) en lancement automatique`,
  intro:
    "Canary a détecté ces pull requests et attend une application de test au bon commit.",
  manualHint: "Un lancement manuel reste possible depuis « Nouveau test ».",
  reasonUnknown: (code: string) => `Cause à vérifier : ${code}.`,
  retry: "Relancer la vérification",
  retryTitle:
    "Revérifier la même pull request au même commit, avec un nouveau délai d’attente.",
  retrying: "Relance…",
  summary: {
    expired: (count: number) => `${count} délai(s) dépassé(s)`,
    rateLimited: (count: number) => `${count} refusé(s) par le quota horaire`,
    waiting: (count: number) => `${count} en attente`,
  },
  title: "Lancements automatiques",
} as const;

/**
 * One line per audit action an automatic attempt records. An action this build
 * does not know still renders its raw name: the trail is never hidden.
 */
export const automaticSteps: Record<string, string> = {
  "automatic.disabled":
    "Lancements automatiques désactivés sur le serveur : aucune vérification n’a été faite.",
  "automatic.preview_expired":
    "Délai d’attente dépassé : la tentative s’arrête sans lancer de test.",
  "automatic.preview_wait":
    "Application de test absente ou sans la bonne version : nouvelle vérification programmée.",
  "automatic.promoted": "Application de test vérifiée : le test a démarré.",
  "automatic.rate_limited":
    "Budget horaire de lancements automatiques atteint : le test n’a pas démarré.",
  "automatic.retried":
    "Relancé depuis le tableau de bord : la même pull request est revérifiée au même commit.",
  "automatic.repo_disabled":
    "Lancements automatiques désactivés pour ce dépôt : aucune vérification n’a été faite.",
  "webhook.rate_limited": "Refusé par le quota horaire du serveur.",
};

/** The next step an operator must take, keyed by the reason code recorded. */
export const automaticAdvice: Record<string, string> = {
  AUTO_REPO_DISABLED:
    "Réactivez ce dépôt dans Réglages → GitHub, puis lancez le test depuis « Nouveau test » : une tentative expirée n’est jamais rejouée.",
  AUTO_RUNS_DISABLED:
    "Réactivez les lancements automatiques sur le serveur (QA_AUTO_RUNS), ou lancez ce test depuis « Nouveau test ».",
  PREVIEW_HOST_NOT_ALLOWED:
    "Ajoutez l’hôte de cette application de test dans Réglages → l’application à tester, puis relancez un test.",
  PREVIEW_NOT_FOUND:
    "Renseignez le modèle d’URL de votre application de test dans Réglages (l’application à tester), ou son URL exacte dans « Nouveau test », puis relancez le test : sans modèle, Canary ne devine pas les sous-domaines de vos previews.",
  PREVIEW_SHA_MISMATCH:
    "Faites publier le SHA complet du commit par l’application de test — un en-tête HTTP ou un chemin JSON — et vérifiez lequel des deux est configuré dans Réglages, puis relancez le test.",
  PREVIEW_UNAVAILABLE:
    "Vérifiez que l’adresse de test répond publiquement, puis lancez le test depuis « Nouveau test » pour voir le diagnostic complet.",
  WEBHOOK_RATE_LIMIT:
    "Attendez la prochaine fenêtre du quota horaire, ou lancez ce test depuis « Nouveau test ».",
};

/**
 * The dedicated screen of one automatic attempt: what Canary tried, why it
 * stopped, and what the operator has to do next.
 */
export const automaticDetail = {
  adviceFallback:
    "Lancez ce test depuis « Nouveau test » : une tentative en échec n’est jamais rejouée automatiquement.",
  adviceTitle: "Ce qu’il reste à faire",
  attempts: (count: number) =>
    count === 1
      ? "1 vérification effectuée"
      : `${count} vérifications effectuées`,
  back: "Retour à l’accueil",
  causeTitle: "Pourquoi Canary n’a pas démarré le test",
  deadline: (date: string) => `Délai d’attente atteint le ${date}`,
  discarded:
    "Canary a cessé de suivre cette pull request sans lancer de test : elle a été fermée, son commit a changé, ou le dépôt n’est plus sélectionné.",
  factsTitle: "Ce que Canary a tenté",
  githubPr: "Ouvrir la pull request",
  lastErrorTitle: "Dernière erreur enregistrée",
  lastProbe: (date: string) => `Dernière vérification : ${date}`,
  loading: "Chargement du détail de la tentative…",
  missing:
    "Cette tentative est introuvable : elle a peut-être été purgée. Rouvrez l’accueil pour voir les tentatives en cours.",
  pinned: (sha: string) => `Commit attendu : ${sha}`,
  previewHeader: (header: string) => `En-tête HTTP de version : ${header}`,
  previewNone:
    "Aucun modèle d’URL n’est configuré : Canary ne peut pas deviner l’adresse de vos previews ; il lit les déploiements GitHub de la pull request.",
  previewPath: (path: string) => `Chemin JSON de version : ${path}`,
  previewTitle: "Preuve de version exigée",
  previewTemplate: (template: string) => `Modèle d’URL : ${template}`,
  promoted:
    "Cette tentative a fini par trouver son application de test : le test a démarré.",
  promotedCta: "Voir le détail du test",
  runCta: "Lancer un test manuellement",
  runViewer:
    "Un opérateur ou un administrateur peut lancer ce test depuis « Nouveau test ».",
  timelineEmpty: "Aucune étape enregistrée pour cette tentative.",
  timelineTitle: "Déroulé des vérifications",
  waiting:
    "Cette tentative attend encore : Canary continue de vérifier l’application de test.",
} as const;

/**
 * The "why did it fail" block shared by the inline run panel and the dedicated
 * run screen: the server diagnostic, the phase it stopped in, and the failing
 * scenarios.
 */
export const runDiagnostic = {
  code: (code: string) => `Code : ${code}`,
  fallback:
    "Aucun code d’erreur n’a été enregistré pour ce test. Consultez le rapport et la vidéo ci-dessous.",
  hint: (hint: string) => `À faire : ${hint}`,
  hintMissing:
    "Relancez un test sur le même commit après avoir corrigé la cause, ou ouvrez le rapport pour le déroulé complet.",
  scenarios: (count: number) =>
    count === 1
      ? "1 scénario s’est arrêté sur une erreur"
      : `${count} scénarios se sont arrêtés sur une erreur`,
  stoppedAt: (phase: string) => `Phase atteinte : ${phase}`,
  title: "Pourquoi ce test n’est pas allé au bout",
} as const;

/**
 * The next step to take after a failed run, keyed by the server diagnostic code.
 * A code this build does not know falls back to the server's own hint, which is
 * English: the dashboard never hides the advice it was given.
 */
export const runAdvice: Record<string, string> = {
  CANARY_START_FAILED:
    "Vérifiez que le service browser tourne et dispose de Chromium (docker compose ps), puis relancez le test.",
  CONTEXT_INCOMPLETE:
    "Vérifiez que l’App GitHub voit bien les fichiers de cette PR (permissions, dépôt sélectionné), puis relancez.",
  CONTRACT_BUDGET:
    "Le plan était trop long pour le budget d’actions du scénario : réduisez le périmètre de la PR ou relancez pour obtenir un plan plus court.",
  CONTRACT_INCOMPLETE:
    "Relancez le test ; si l’arrêt se répète, ouvrez le rapport pour voir l’étape manquante et ajustez le scénario.",
  CONTRACT_VIOLATION:
    "Un scénario a voulu agir hors du plan validé : ouvrez le rapport, puis corrigez le plan ou les fichiers `.canary` du dépôt.",
  CRITICAL_COVERAGE_MISSING:
    "Élargissez le plan de test (fichiers `.canary`) pour couvrir ces changements, puis relancez.",
  EVIDENCE_VIDEO_MISSING:
    "Vérifiez l’espace disque et le volume `canary-sessions` du service browser, puis relancez le test.",
  GITHUB_NOT_CONNECTED:
    "Connectez votre App GitHub dans Réglages, puis relancez le test.",
  GITHUB_REPOSITORY_DENIED:
    "Sélectionnez ce dépôt dans Réglages → GitHub, puis relancez le test.",
  HTTP_401:
    "Vérifiez les credentials du service concerné sur le serveur (fournisseur IA ou GitHub), puis relancez.",
  HTTP_403:
    "Vérifiez les permissions GitHub et l’autorisation Cloudflare de l’IP de sortie du VPS, puis relancez.",
  MODEL_CATALOG_EMPTY:
    "Vérifiez `OPENAI_BASE_URL` et la clé du fournisseur, puis actualisez la liste des modèles dans Réglages.",
  MODEL_CATALOG_INVALID:
    "Vérifiez l’endpoint du fournisseur et son autorisation Cloudflare, puis actualisez la liste des modèles.",
  MODEL_JSON_INVALID:
    "Relancez le test ; si l’erreur revient, vérifiez que le modèle choisi gère le mode JSON.",
  MODEL_NOT_ALLOWED:
    "Choisissez un modèle autorisé par `QA_ALLOWED_MODELS` dans « Nouveau test ».",
  MODEL_NOT_AVAILABLE:
    "Actualisez la liste des modèles et choisissez-en un disponible dans « Nouveau test ».",
  MODEL_OUTPUT_INCOMPLETE:
    "Relancez le test ; si l’erreur revient, choisissez un modèle plus fiable ou augmentez `QA_RUN_MAX_TOKENS`.",
  MODEL_PROVIDER_DENIED:
    "Autorisez l’IP de sortie du VPS chez le fournisseur (Cloudflare), vérifiez la clé, puis relancez.",
  PR_CHANGED: "Relancez un test sur le dernier commit de la pull request.",
  PR_CLOSED: "Cette pull request est fermée : il n’y a rien à tester.",
  PREVIEW_HOST_NOT_ALLOWED:
    "Ajoutez l’hôte de cette application de test dans Réglages → l’application à tester, puis relancez un test.",
  PREVIEW_NOT_FOUND:
    "Renseignez le modèle d’URL de votre application de test dans Réglages (l’application à tester), ou son URL exacte dans « Nouveau test », puis relancez le test : sans modèle, Canary ne devine pas les sous-domaines de vos previews.",
  PREVIEW_SHA_MISMATCH:
    "L’application de test répond mais ne publie pas son commit : exposez le SHA complet dans l’en-tête ou le chemin JSON configuré dans Réglages, puis relancez un test.",
  PREVIEW_UNAVAILABLE:
    "Vérifiez que l’adresse de test répond publiquement (et que le service egress y accède), puis relancez un test.",
  RUN_BUDGET_EXCEEDED:
    "Augmentez `QA_RUN_MAX_TOKENS` après avoir vérifié les tarifs, ou réduisez le périmètre de la PR.",
  RUN_DEADLINE:
    "Vérifiez la phase atteinte dans le rapport, puis augmentez `QA_RUN_TIMEOUT_SECONDS` si le test mérite plus de temps.",
  STALE_HEAD:
    "Ce commit n’est plus la tête de la pull request : relancez un test sur le commit courant.",
  TRANSITION_NOT_OBSERVED:
    "Pour affirmer une invariance après une interaction (l’élément est toujours là après le clic X), utilisez `verification: state` avec `afterStep` = l’étape d’interaction ; réservez `transition` aux valeurs qui doivent changer.",
  WEBHOOK_RATE_LIMIT:
    "Attendez la prochaine fenêtre du quota horaire, ou lancez ce test depuis « Nouveau test ».",
  WRITE_EVIDENCE_MISSING:
    "Vérifiez que le scénario écrit bien ses artefacts (fichiers `.canary`), puis relancez le test.",
};

/** The dedicated full-screen run report. */
export const runScreen = {
  back: "Retour à l’historique",
  missing:
    "Ce test est introuvable : il a peut-être été purgé, ou il appartient à un dépôt auquel vous n’avez pas accès.",
  seenIn: "Ouvrir dans l’historique",
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
    autoRunHelp:
      "Canary démarre un test dès qu’une pull request s’ouvre ou change sur un dépôt coché. Il attend l’application de test au bon commit ; les dépôts non cochés restent testables depuis « Nouveau test ».",
    autoRunLabel: "Lancer automatiquement une QA à chaque pull request",
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
    noMatch: (query: string) =>
      `Aucun dépôt ne correspond à « ${query} ». Effacez la recherche pour tout voir.`,
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
    repoCount: (shown: number, total: number) =>
      `${shown} dépôt(s) affiché(s) sur ${total}`,
    restricted: " · restreint par le serveur",
    reposLegend: "Dépôts utilisés pour la QA",
    searchLabel: "Rechercher un dépôt",
    searchPlaceholder: "Nom du dépôt, ex. pharmacia/api",
    saveRepos: "Enregistrer les dépôts sélectionnés",
    title: "Votre connexion GitHub",
    trail: ["1. Créer l'App", "2. Installer", "3. Choisir les dépôts"],
    webhookLast: (date: string, status: string) =>
      ` Dernier webhook : ${date} · ${status}`,
    private: "Privé",
    public: "Public",
  },
  preview: {
    help: "Ces restrictions s'appliquent au navigateur QA et au proxy de sortie. Le bouton Vérifier les accès vous donne un diagnostic avant lancement.",
    hosts: (hosts: string) => `Hôtes autorisés : ${hosts}`,
    hostsFallback: "Les hôtes sont définis par l'opérateur du serveur.",
    hostsEditorTitle: "Hôtes autorisés par l'administrateur",
    hostsEditorIntro:
      "Seuls ces hôtes peuvent être atteints par le navigateur QA. Un hôte s'écrit sans schéma ni chemin ; le joker \"*.\" couvre les sous-domaines d'un domaine que vous contrôlez (par exemple *.preview.example.com), jamais un suffixe public comme *.co.uk. Les changements prennent effet en quelques secondes.",
    hostsDefault: (hosts: string) => `Liste initiale du serveur : ${hosts}`,
    hostsInput: "Nouvel hôte",
    hostsPlaceholder:
      "preview.example.com, preview.example.com:8443 ou *.preview.example.com",
    hostsAdd: "Ajouter",
    hostsRemove: (host: string) => `Retirer ${host}`,
    hostsRemoveLabel: "Retirer",
    hostsSave: "Enregistrer les hôtes",
    hostsSaving: "Enregistrement…",
    hostsSaved: "Hôtes autorisés enregistrés.",
    hostsReset: "Rétablir la liste du serveur",
    hostsResetDone: "Liste du serveur rétablie.",
    hostsEmpty:
      "Ajoutez au moins un hôte : une liste vide bloquerait tous les tests.",
    hostsDuplicate: "Cet hôte est déjà dans la liste.",
    hostsInvalid:
      "Format attendu : hôte, hôte:port ou *.domaine (sous-domaines d'un domaine que vous contrôlez), sans schéma, chemin ni identifiants.",
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
