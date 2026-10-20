/**
 * Les préconditions que le run 985c3de7 (déploiement de la PR #62) a réellement
 * déclarées, recopiées de son `result.json` : six scénarios, tous bloqués avant
 * la première étape navigateur par `Role Administrateur démo 1 missing`.
 *
 * Le catalogue de confiance ne déclare rien pour ce dépôt — `QA_FIXTURES_FILE`
 * n'est pas défini dans les services `pr-qa` et `worker`, et le `config/` monté
 * en lecture ne contient aucun `fixtures.json` — donc aucun nom ne pouvait y
 * correspondre, sous aucune graphie : le refus ne nommait ni ce que le catalogue
 * portait, ni que ces deux valeurs sont des bascules de profil et de pharmacie
 * visibles dans la page de découverte, conduites par une étape.
 */
export const LOT_W_REPO = "pharmania/arpilabe-pilotage";
export const LOT_W_PRECONDITIONS: { id: string; preconditions: string[] }[] = [
  {
    id: "comptage-juste-cloture",
    preconditions: [
      "role:Administrateur démo 1",
      "role:Pharmacie DEMO17 active (valeur par défaut du sélecteur « Pharmacie active »)",
    ],
  },
  {
    id: "ecart-bloquant-puis-justifie",
    preconditions: [
      "role:Administrateur démo 1",
      "role:Pharmacie DEMO17 active",
    ],
  },
  {
    id: "quantite-decimale-refusee",
    preconditions: [
      "role:Administrateur démo 1",
      "role:Pharmacie DEMO17 active",
    ],
  },
  {
    id: "reouverture-debloque",
    preconditions: [
      "role:Administrateur démo 1",
      "role:Pharmacie DEMO17 active",
    ],
  },
  {
    id: "comptage-conserve-par-pharmacie",
    preconditions: [
      "role:Administrateur démo 1",
      "role:Pharmacie DEMO17 active",
    ],
  },
  {
    id: "montant-attendu-illisible",
    preconditions: [
      "role:Administrateur démo 1",
      "role:Pharmacie DEMO17 active",
    ],
  },
];
