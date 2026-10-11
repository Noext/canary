# Évaluation IA réelle

Le corpus `apps/canary-pr-qa/evals/corpus.json` contient des cas annotés avec leur
oracle indépendant : formulaire sain, mutation produisant un mauvais résultat,
texte leurre statique et absence de changement d'état. Chromium et le moteur
Canary sont réels ; seuls GitHub et les previews locales sont des fixtures.
Le plan et les décisions sont produits par **l'endpoint IA configuré**, jamais
par le modèle de fixture des tests d'orchestration.

```bash
QA_EVAL_LIVE=true QA_EVAL_MODELS=model-a,model-b QA_EVAL_REPEATS=3 \
  pnpm --filter @usecanary/pr-qa exec tsx scripts/evaluate.ts
```

Configurer d'abord `OPENAI_BASE_URL`, `OPENAI_API_KEY` et `OPENAI_MODEL` dans
l'environnement de ce shell. Le runner publie `evaluation.json`, les résultats
par essai et les preuves des runs sous `QA_EVAL_OUTPUT` (défaut
`qa-data/evaluation`). Il conserve les hashes du corpus et des prompts.

Métriques : taux de bugs détectés par assertion réelle, faux verts, réussite des
cas sains, taux de blocage. **Un blocage ne compte pas comme un bug détecté.**
Le gate échoue sur tout faux vert, toute erreur sur cas sain ou détection sous
`QA_EVAL_MIN_DETECTION` (1 par défaut). Exécuter avant une modification de modèle
ou de prompt ; les modèles peuvent varier entre deux requêtes identiques.

Pour des PR représentatives de votre produit, renseigner `QA_EVAL_CORPUS` avec le
même format : remplacer `fixture` par `prUrl` et `previewUrl`, ajouter une
annotation vérifiée manuellement et les actions minimales attendues. Les PR et
previews doivent rester disponibles et épinglées ; utiliser exclusivement les
comptes/données de test configurés. `publish=false` évite les commentaires/statuts
GitHub pendant l'évaluation. Les interactions navigateur et fixtures restent réelles.

Ce petit corpus est un gate initial, pas un benchmark exhaustif ou une garantie
qu'une QA autonome peut remplacer toutes les suites de tests. Aucune qualité IA
réelle n'est affirmée tant que ce corpus n'a pas été exécuté avec vos modèles.
