# Architecture de `apps/canary-pr-qa` : audit et cible

Ce document remplace l'accumulation de correctifs par famille. Il nomme les causes structurelles
mesurées, l'architecture cible, l'ordre de migration, et ce qui est conservé ou supprimé.
Les ancrages `fichier:ligne` renvoient au code au moment de l'audit (`8143ac9` + branche `feat/marker-precedence`).

## 1. Le défaut de conception central

Le planificateur écrit un contrat d'exécution **avant** d'avoir observé l'application :

- la découverte charge **une** URL, **une** fois, **sans authentification** ni fixtures
  (`runner.ts:97-137`), alors que chaque scénario s'exécute **authentifié** avec un storage state
  (`executor.ts:461-463`) : l'évidence de validation n'est pas la page que le scénario joue ;
- l'instantané est pris à `domcontentloaded` (`canary.ts:676-687`) : sur une SPA, le modèle planifie
  la coquille, pas l'écran ;
- une seule vue est connue (`plan-evidence.ts:640-655`) : toute exigence portant sur un écran atteint
  après un clic est soit devinée, soit abandonnée ;
- l'état initial de l'application (montant attendu, session ouverte) est **persisté entre runs** et
  n'est jamais observé ; il est donc supposé, et le verdict dépend de l'ordre et de l'historique.

Conséquence mesurable : 5 échecs sur 10 au lot AU reposaient sur des assertions dont la précondition
n'était jamais établie par le plan ; `3c51455f` a échoué sur un montant attendu que la porte ne
pouvait ni exiger (il est peut-être déjà là) ni certifier absent (personne ne l'a observé).

Le reste — citations, cibles inventées, longueurs, transitions — n'est que la surface de ce défaut.

## 2. Causes structurelles

**C1. Aucune représentation explicite de l'état.** Six contrôles re-dérivent les préconditions par
expression régulière (`markerGuards`, `controlFor`, `hasInitialValue`, `unmetControl`,
`lengthConditionOf`, `repairRequirementAttribution`). Chacun couvre un fragment ; aucun ne couvre
l'ensemble. `controlFor` exige l'`aria-label` sur la même ligne que le champ ; `hasInitialValue`
prenait pour un état initial une ligne supprimée du patch et un littéral de fichier de test
(corrigé ici) ; une chaîne de gardes écrite sur plusieurs lignes était invisible (corrigé ici).

**C2. Le contrôle le plus fréquent n'est pas négociable.** `validatePlanEvidence` s'exécute après
`model.json` et n'apparaît pas dans le canal de correction : le modèle n'a aucune manche pour une
cible inventée, trois pour une citation.

**C3. Le verdict n'est pas une fonction du plan.** `settlePlan` répare puis juge ; `repairStepTarget`
remplace la cible jouée à l'exécution, hors du `contract.hash`. Un plan peut donc produire deux
verdicts, et le contrat exécuté n'est pas celui qui a été validé.

**C4. Le blâme est décidé par la forme de l'assertion, pas par la preuve.** Une valeur inchangée et
déjà satisfaisante devient `blocked` si la vérification était `transition`, `passed` si elle était
`state`. `aggregate()` écrase de plus les catégories : un run mixte publie `failed` en comptant les
bloqués comme des échecs.

**C5. Les budgets sont incohérents entre eux.** `plannerPayloadLimit` (`runner.ts:789`) somme
120 000 + 120 000 + 30 000 caractères sans consulter `QA_RUN_MAX_TOKENS` ; uneborne de sortie de
8 000 tokens contredit les mesures internes du dépôt (24 000–50 000) ; quatre budgets de message
rivaux (1 860 / 1 500 / 1 900) doivent tenir dans une correction tronquée à 2 000 caractères.

**C6. Le prompt est le seul canal d'apprentissage.** ~90 règles, dont une quinzaine de récits
d'incidents, non testées : rien ne mesure l'obéissance du modèle, et une règle ancienne peut
contredire une nouvelle sans que rien ne le signale.

## 3. Architecture cible

### 3.1 Découverte qui observe ce que le scénario jouera

- La découverte prend **la même identité** que l'exécution (storage state + fixtures déclarées) et le
  dit dans le résultat ; une découverte anonyme reste possible mais devient **explicite** et
  n'alimente plus l'évidence de cibles.
- Attente **post-hydratation** : `networkidle` borné, puis instantané ; la taille de l'instantané et
  un éventuel dépassement sont **publiés** au lieu d'être silencieux.
- **Exploration bornée des vues** : à partir des contrôles de navigation observés (rôle bouton/lien,
  `href` interne), ouvrir au plus N vues, sans saisie, sans soumission, sans effet métier ; chaque
  vue donne un instantané ARIA et l'ensemble est indexé par route. Un plan qui vise une vue non
  observée est refusé **avant** le navigateur, avec la liste des vues connues.
- Le modèle reçoit **le même texte** que l'évidence : une seule constante de troncature, mesurée.

### 3.2 État explicite, avec trois valeurs

Une structure unique, calculée une fois depuis le diff et les observations :

```
Field      { name, control?{action,label}, initial?: {value, provenance}|unknown }
Condition  { field, operator, literal?, polarity, provenance(file,line) }
Outcome    { value, requires: Condition[], after: Outcome[] }
Marker     { attribute, expression, fallback, outcomes, controls[] }
```

Chaque assertion déclare l'**état qu'elle exige** ; le gate répond `satisfait` / `contredit` /
`inconnu` :

- `satisfait` : une étape l'établit **ou** l'état observé le prouve ;
- `contredit` : la dernière écriture, l'état observé ou la polarité le démentissent (arithmétique
  de longueur comprise) ;
- `inconnu` : ni le diff ni l'observation ne tranchent → **aucun refus**, et le run porte la mention
  « précondition non observable », jamais un vert silencieux.

`inconnu` est ce qui manque aujourd'hui : sans lui, on refuse à tort (`justificationRequired`, hérité
d'un état persisté) ou on accepte à tort (`3c51455f`).

### 3.3 Un seul canal de preuve

`line` désigné, texte écrit par le gate. La recopie libre disparaît après que la parité est prouvée
sur les plans historiques : cela supprime ~1 100 lignes de forensique de copie (`stitchedQuoteFragments`,
`quoteDivergence`, `amputatedQuote`, `suggestedQuoteLines`, `weakWitnessLines`, `wordAlignedFragment`).

### 3.4 Verdicts qui séparent la cause

`aggregate()` cesse d'écraser les catégories ; un run publie `passed` / `blocked` / `failed` /
`unverified` avec la **cause** : `plan-impossible`, `plan-incomplete`, `product-regression`,
`product-broken-baseline`, `infrastructure`, `non-conclusive`. Un invariant qui ne change ni en base
ni en tête n'est jamais un défaut produit ; la comparaison base/tête (`QA_BASELINE_URL_TEMPLATE`,
déjà présente) devient la preuve d'attribution, pas la forme de l'assertion.

### 3.5 Contrat idempotent

`plan.asWritten` (ce que le modèle a écrit, hashé) et `plan.settled` (après réparation, avec la liste
des réparations) sont deux artefacts distincts. Un verdict doit être reproductible à partir de
`asWritten` + règles, et toute réparation est nommée dans le rapport.

## 4. Ordre de migration

1. **Harnais de rejeu** (fait) : sept plans réels rejoués sans modèle, verdicts pinés.
2. **État explicite** (§3.2) en lecture seule : calculé, publié, non opposé au plan — on mesure.
3. **Découverte alignée** (§3.1) : identité, hydratation, vues bornées ; l'état observé alimente `initial`.
4. **Opposition au plan** : préconditions `contredit` refusées, `inconnu` déclaré ; le canal de
   correction reçoit **tous** les refus (y compris cibles).
5. **Verdicts et attribution** (§3.4), puis **contrat idempotent** (§3.5).
6. **Suppression** de la recopie libre et des détecteurs devenus redondants, preuve de parité à l'appui.

## 5. Ce qui est conservé

Gate déterministe avant toute dépense de navigateur ; `contract.hash` et `CONTRACT_INCOMPLETE` ;
désignation de ligne par le gate ; correction contrainte par indice ; refus nommés avec remède ;
séparation `blocked`/`failed`/`skipped`/`stale` et recheck SHA ; réservation de tokens avant envoi ;
`redact` et empreintes dans les journaux ; skip critique approuvé sur la branche de base.

## 5 bis. Mesures déjà obtenues

| Lot | Build | Sonde de vues | Runs verts | Scénarios verts | Tokens | Appels |
| --- | --- | --- | --- | --- | --- | --- |
| BA | `8143ac9` | non | 7/10 | 87 | 2 810 804 | 16 |
| BB | `7a6050b` | oui | 7/10 | 92 | 5 378 250 | 32 |

La sonde de navigation double le coût (+91 % de tokens, +16 appels) pour cinq
scénarios verts de plus et **aucun run vert supplémentaire** sur dix. Elle reste
livrée, désactivée par défaut (`QA_VIEW_PROBE=false`), parce qu'un gain non
démontré ne justifie pas un coût démontré : elle sera réactivée quand un
déclencheur plus étroit sera mesuré (par exemple seulement pour les plans dont
une assertion vise une vue qui n'est pas la page d'entrée).

## 6. Mesure

Référence : `8143ac9`. Lots de 10, runs appariés et entrelacés à version figée, plus les rejeux
déterministes. Ce qui est rapporté : runs entièrement verts, assertions réellement vérifiées, refus
et leurs causes, faux refus, faux verts, tokens par phase, durée, stabilité entre exécutions
identiques. Aucune conclusion sur un seul lot.
