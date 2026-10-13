/**
 * Le texte de la surface « Clés API ». Il vit à part parce qu'elle grandit seule
 * et que `i18n.ts` approche du plafond de taille du gate d'architecture ; le
 * réexport garde un seul import pour les composants (`@/i18n`).
 */
export const apiKeys = {
  copy: "Copier le jeton",
  copyFailed:
    "Copie impossible : le presse-papiers est indisponible dans ce navigateur.",
  create: "Créer la clé",
  created: (name: string) => `Clé « ${name} » créée.`,
  creating: "Création…",
  createTitle: "Créer une clé",
  empty: "Aucune clé pour le moment. Créez-en une pour connecter un agent.",
  intro:
    "Une clé API ouvre le serveur MCP aux agents et aux outils externes : elle y lit vos tests, et peut en lancer un si sa portée le permet.",
  lastUsed: (date: string) => `Dernière utilisation : ${date}`,
  lastUsedNever: "Jamais utilisée",
  listTitle: "Clés existantes",
  nameLabel: "Nom de la clé",
  namePlaceholder: "Agent de support, Claude Desktop…",
  receipt: (name: string) =>
    `Jeton de « ${name} » copié dans le presse-papiers.`,
  repos: (list: string) => `Dépôts : ${list}`,
  reposNone: "Aucun dépôt : cette clé ne peut rien lire.",
  revoke: "Révoquer",
  revoked: "Révoquée",
  revokedAt: (date: string) => `Révoquée le ${date}`,
  revokeDone: (name: string) =>
    `Clé « ${name} » révoquée. Son jeton ne peut plus être copié.`,
  revoking: "Révocation…",
  role: {
    help: {
      operator:
        "En plus de la lecture, cette clé peut lancer un test — sans pouvoir l'annuler ni toucher à vos réglages.",
      viewer:
        "Cette clé lit vos tests, leurs rapports et les tentatives automatiques, sans rien lancer.",
    },
    label: "Portée de la clé",
    names: {
      operator: "Peut lancer un test",
      viewer: "Lecture seule",
    },
  },
  scope:
    "Chaque clé garde la portée choisie à sa création : lecture seule, ou droit de lancer un test. Aucune clé ne modifie vos réglages.",
  title: "Clés API",
  tokenTitle: "Copiez ce jeton maintenant",
  tokenWarning:
    "Ce jeton ne s’affichera plus en entier : le serveur n’en garde qu’une copie chiffrée pour vous le recopier à la demande.",
} as const;
