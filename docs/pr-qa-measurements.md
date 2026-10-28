# Mesures — campagnes de runs, classes d'échec et comparaison appariée

Ce fichier est **généré** par `apps/canary-pr-qa/test/measurements-report.test.ts`
depuis les artefacts des runs : aucune valeur saisie à la main, et une mesure
périmée fait échouer la CI.

## Campagnes (10 runs par lot, même PR, même modèle, même oracle)

| Lot | Run | Verdict | Diagnostic du run | Vert | Échec | Bloqué | Classes d'échec | Tokens | Appels | Durée |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BA | `0ce50724` | passed | — | 8 | 0 | 0 | — | 344988 | 2 | 6 min 29 s |
| BA | `f83f0762` | failed | — | 7 | 1 | 0 | plan-impossible×1 | 351925 | 2 | 7 min 43 s |
| BA | `0675aba9` | passed | — | 8 | 0 | 0 | — | 175557 | 1 | 5 min 7 s |
| BA | `afcc9846` | blocked | — | 11 | 0 | 1 | plan-defective×1 | 367771 | 2 | 9 min 36 s |
| BA | `24db19b8` | failed | — | 10 | 1 | 1 | plan-impossible×2 | 344781 | 2 | 7 min 4 s |
| BA | `d830e035` | passed | — | 9 | 0 | 0 | — | 174808 | 1 | 5 min 56 s |
| BA | `ec6445c9` | passed | — | 7 | 0 | 0 | — | 353246 | 2 | 7 min 54 s |
| BA | `94673c0a` | passed | — | 10 | 0 | 0 | — | 175614 | 1 | 5 min 45 s |
| BA | `8bc0711c` | passed | — | 8 | 0 | 0 | — | 336968 | 2 | 6 min 5 s |
| BA | `dc7e9356` | passed | — | 9 | 0 | 0 | — | 185146 | 1 | 5 min 59 s |
| CC | `7db8c556` | passed | — | 8 | 0 | 0 | — | 346877 | 2 | 6 min 25 s |
| CC | `cb1a3dab` | blocked | REQUIREMENT_UNGROUNDED → plan-defective | 0 | 0 | 0 | — | 349981 | 2 | 5 min 35 s |
| CC | `ddd8a0a0` | blocked | — | 7 | 0 | 0 | — | 348808 | 2 | 7 min 10 s |
| CC | `450099db` | passed | — | 8 | 0 | 0 | — | 370075 | 2 | 8 min 31 s |
| CC | `50dae25e` | passed | — | 8 | 0 | 0 | — | 369035 | 2 | 8 min 31 s |
| CC | `1193dcf5` | passed | — | 7 | 0 | 0 | — | 360875 | 2 | 7 min 39 s |
| CC | `c1d77bba` | passed | — | 10 | 0 | 0 | — | 350599 | 2 | 7 min 15 s |
| CC | `56ae5df7` | blocked | MARKER_ORDER_UNREACHABLE → plan-defective | 0 | 0 | 0 | — | 374029 | 2 | 7 min 11 s |
| CC | `0637d181` | passed | — | 6 | 0 | 0 | — | 354008 | 2 | 6 min 50 s |
| CC | `500a02a9` | passed | — | 9 | 0 | 0 | — | 560057 | 3 | 9 min 40 s |
| DD | `b8818582` | blocked | — | 8 | 0 | 1 | plan-defective×1 | 341097 | 3 | 6 min 31 s |
| DD | `0b71b8a3` | passed | — | 7 | 0 | 0 | — | 349856 | 2 | 6 min 54 s |
| DD | `f5ecbaac` | failed | — | 7 | 1 | 0 | plan-impossible×1 | 347830 | 2 | 7 min 8 s |
| DD | `bed1253d` | blocked | — | 9 | 0 | 1 | plan-defective×1 | 578063 | 3 | 9 min 44 s |
| DD | `b5711fb7` | blocked | — | 7 | 0 | 2 | plan-impossible×2 | 369615 | 2 | 7 min 48 s |
| DD | `bc0e083e` | blocked | REQUIREMENT_UNGROUNDED → plan-defective | 0 | 0 | 0 | — | 365281 | 2 | 6 min 56 s |
| DD | `3f60a8d1` | passed | — | 7 | 0 | 0 | — | 174404 | 1 | 4 min 47 s |
| DD | `fe361a8b` | passed | — | 9 | 0 | 0 | — | 342134 | 2 | 7 min 7 s |
| DD | `b498e8f1` | passed | — | 8 | 0 | 0 | — | 171469 | 1 | 5 min 9 s |
| DD | `a30c3d72` | passed | — | 9 | 0 | 0 | — | 374660 | 2 | 8 min 24 s |
| EE | `28525781` | blocked | — | 7 | 0 | 1 | plan-defective×1 | 359669 | 3 | 8 min 3 s |
| EE | `74fb516d` | passed | — | 10 | 0 | 0 | — | 498189 | 3 | 7 min 7 s |
| EE | `8a16f402` | blocked | — | 7 | 0 | 1 | plan-impossible×1 | 351693 | 2 | 7 min 35 s |
| EE | `d07c4ed4` | blocked | — | 9 | 0 | 2 | plan-impossible×2 | 366146 | 3 | 9 min 16 s |
| EE | `f031c109` | passed | — | 10 | 0 | 0 | — | 517684 | 3 | 8 min 15 s |
| EE | `c7136c7b` | passed | — | 6 | 0 | 0 | — | 327969 | 2 | 5 min 14 s |
| EE | `273dc450` | passed | — | 8 | 0 | 0 | — | 506849 | 3 | 8 min 11 s |
| EE | `cd62137e` | blocked | — | 9 | 0 | 1 | plan-defective×1 | 697388 | 4 | 9 min 33 s |
| EE | `4bde1657` | passed | — | 7 | 0 | 0 | — | 362968 | 2 | 9 min 26 s |
| EE | `f7c2778e` | passed | — | 11 | 0 | 0 | — | 338432 | 2 | 7 min 29 s |
| FF | `403d43d2` | passed | — | 5 | 0 | 0 | — | 336076 | 2 | 5 min 52 s |
| FF | `441bfc0e` | passed | — | 10 | 0 | 0 | — | 541081 | 3 | 12 min 18 s |
| FF | `34f76fd9` | passed | — | 7 | 0 | 0 | — | 340043 | 2 | 6 min 43 s |
| FF | `cd6d22f6` | passed | — | 8 | 0 | 0 | — | 521408 | 3 | 9 min 1 s |
| FF | `6dd36613` | passed | — | 10 | 0 | 0 | — | 374716 | 2 | 11 min 4 s |
| FF | `7900e46d` | blocked | — | 8 | 0 | 2 | plan-impossible×2 | 712384 | 5 | 13 min 33 s |
| FF | `896d4967` | passed | — | 9 | 0 | 0 | — | 348839 | 2 | 8 min 7 s |
| FF | `bfc43f8e` | passed | — | 7 | 0 | 0 | — | 332222 | 3 | 6 min 51 s |
| FF | `510b96f2` | passed | — | 10 | 0 | 0 | — | 357195 | 2 | 9 min 8 s |
| GG | `ca55513b` | blocked | — | 7 | 0 | 1 | plan-defective×1 | 499627 | 3 | 7 min 16 s |
| GG | `e3f3ad2b` | passed | — | 7 | 0 | 0 | — | 358074 | 2 | 7 min 34 s |
| GG | `160792a9` | failed | — | 8 | 1 | 0 | plan-defective×1 | 516390 | 3 | 9 min 40 s |
| GG | `74f1cfea` | blocked | REQUIREMENT_UNGROUNDED → plan-defective | 0 | 0 | 0 | — | 335979 | 2 | 5 min 15 s |
| GG | `bc46290b` | passed | — | 10 | 0 | 0 | — | 367118 | 2 | 8 min 20 s |
| GG | `6832a9e4` | blocked | — | 9 | 0 | 1 | plan-impossible×1 | 339732 | 2 | 6 min 15 s |
| GG | `d8b73758` | passed | — | 10 | 0 | 0 | — | 356605 | 2 | 8 min 33 s |
| GG | `5afc804a` | blocked | — | 8 | 0 | 1 | plan-impossible×1 | 355266 | 2 | 8 min 55 s |
| GG | `c22a89f1` | passed | — | 8 | 0 | 0 | — | 339426 | 2 | 7 min 45 s |
| GG | `566ffe64` | passed | — | 7 | 0 | 0 | — | 364552 | 2 | 9 min 20 s |
| HH | `b6641dfb` | passed | — | 10 | 0 | 0 | — | 396142 | 3 | 8 min 38 s |
| HH | `6db4cf7e` | passed | — | 9 | 0 | 0 | — | 132788 | 1 | 5 min 3 s |
| HH | `13d0aaac` | passed | — | 6 | 0 | 0 | — | 269451 | 2 | 8 min 4 s |
| HH | `79f33027` | passed | — | 10 | 0 | 0 | — | 270930 | 2 | 8 min 30 s |
| HH | `4f684ac2` | passed | — | 8 | 0 | 0 | — | 133635 | 1 | 6 min 36 s |
| HH | `9da45e20` | passed | — | 10 | 0 | 0 | — | 139699 | 1 | 7 min 8 s |
| HH | `7c0983ed` | passed | — | 11 | 0 | 0 | — | 429664 | 3 | 12 min 27 s |
| HH | `43aae022` | passed | — | 8 | 0 | 0 | — | 280863 | 2 | 8 min 21 s |
| HH | `1b960768` | passed | — | 7 | 0 | 0 | — | 255324 | 2 | 6 min 11 s |
| HH | `53133517` | passed | — | 7 | 0 | 0 | — | 131860 | 1 | 4 min 55 s |
| II | `5deb7c69` | passed | — | 9 | 0 | 0 | — | 147603 | 1 | 6 min 17 s |
| II | `0da1a10e` | blocked | REQUIREMENT_UNGROUNDED → plan-defective | 0 | 0 | 0 | — | 267192 | 2 | 5 min 12 s |
| II | `437ec805` | blocked | — | 7 | 0 | 1 | plan-impossible×1 | 274157 | 2 | 7 min 36 s |
| II | `c61cb8dc` | passed | — | 9 | 0 | 0 | — | 274189 | 2 | 7 min 21 s |
| II | `d9f65e49` | passed | — | 9 | 0 | 0 | — | 565462 | 4 | 12 min 49 s |
| II | `6e3f63fa` | blocked | — | 5 | 0 | 1 | plan-impossible×1 | 278182 | 2 | 7 min 19 s |
| II | `bd230341` | passed | — | 7 | 0 | 0 | — | 293350 | 2 | 9 min 17 s |
| II | `72ce4151` | passed | — | 10 | 0 | 0 | — | 256755 | 2 | 6 min 24 s |
| II | `e9752df0` | passed | — | 10 | 0 | 0 | — | 526565 | 4 | 10 min 2 s |
| II | `851b62d2` | passed | — | 9 | 0 | 0 | — | 261541 | 2 | 7 min 26 s |

## Comparaison appariée des portes, 79 plans réels

- refusés par la porte de `8143ac9` : **5**
- refusés par la porte courante : **15**

## Comment lire les classes

- `plan-impossible` : le gate d'aujourd'hui refuse le plan — le défaut est démontrable ;
- `plan-defective` : le plan est fautif mais rien de statique ne le tranche (cible absente, transition sur invariant, citation) ;
- `product-regression` : un plan accepté a observé autre chose que l'attendu ;
- `infrastructure` : le service n'a pas pu travailler (modèle, budget, worker) ;
- `unclassified` : aucun diagnostic — la CI échoue si ce cas devient fréquent.


## Campagne entrelacée (deux builds alternés sur le même service)

Les lots sont alternés entre `8143ac9` et la lignée courante sur le même
service. **Tous** les lots sont agrégés, y compris ceux qui régressent : un
lot défavorable n'est jamais retiré du calcul.

| Lot | Build | Runs verts | Scénarios verts | Échecs produit | Tokens |
| --- | --- | --- | --- | --- | --- |
| CC | `pre-8143ac9` | 7/10 | 63 | 0 | 3784344 |
| DD | `0000000` | 5/10 | 71 | 1 | 3414409 |
| EE | `0000000` | 6/10 | 84 | 0 | 4326987 |
| FF | `0000000` | 8/10 | 74 | 0 | 4291666 |
| GG | `0000000` | 5/10 | 74 | 1 | 3832769 |
| HH | `0000000` | 10/10 | 86 | 0 | 2440356 |
| II | `0000000` | 7/10 | 75 | 0 | 3144996 |
| JJ | `8143ac9` | 7/10 | 84 | 3 | 3013492 |
| KK | `922159d` | 1/10 | 69 | 0 | 4768170 |
| LL | `0000000` | 1/10 | 66 | 1 | 3061792 |
| MM | `8f831ab` | 7/10 | 93 | 2 | 2804726 |
| NN | `8143ac9` | 6/10 | 67 | 1 | 2579651 |
| OO | `a683f86` | 4/10 | 58 | 0 | 2158790 |
| PP | `a683f86` | 7/10 | 70 | 0 | 2551153 |
| QQ | `345b972` | 5/10 | 77 | 1 | 2746767 |
| RR | `9d563e0` | 5/10 | 89 | 1 | 3033696 |
| SS | `c5b3634` | 9/10 | 93 | 1 | 2921272 |
| TT | `8143ac9` | 4/10 | 72 | 4 | 3060539 |
| UU | `f8a6959` | 9/10 | 88 | 0 | 2843491 |
| BA | `pre-8143ac9` | 7/10 | 87 | 2 | 2810804 |

Référence `8143ac9` (30 runs) : **57 %** de runs verts, 7.4 scénarios verts par run, 0.3 échec produit par run, 288456.1 tokens par run.
Toute la lignée non-référence (170 runs, y compris les builds dont un défaut a été corrigé depuis) : **61 %** de runs verts, 7.7 scénarios verts par run, 0.1 échec produit par run, 323154 tokens par run.

Lignée historique seule (150 runs, builds antérieurs au build courant) : **57 %**.

**Build courant seul** (20 runs de deux commits de source identique — SS `c5b3634`, UU `f8a6959`) : **90 %** de runs verts, 9.1 scénarios verts par run, 0.1 échec produit par run, 288238.2 tokens par run.

Les deux agrégats sont publiés parce qu'ils répondent à deux questions différentes :
« la lignée a-t-elle progressé depuis la référence ? » (tous lots, y compris les
régressions corrigées depuis) et « le code d'aujourd'hui fait-il mieux que la
référence ? » (code identique). Le second n'a de sens que comparé à une campagne
fraîche de la référence : c'est ce que la prochaine campagne mesure.

Expériences isolées (un lot de chaque côté, jamais agrégées) :

- `QQ` (politique « un défaut de contrat coûte le scénario ») : 5/10 contre 7/10
  pour `PP` sur le même build — l'hypothèse « le refus fatal coûte des runs verts »
  est réfutée par la mesure.
- `RR` (réparation déterministe d'une cible proche) : 5/10 contre 7/10 pour `PP`,
  mais 89 scénarios verts contre 70 — la réparation débloque des étapes sans
  rendre les plans justes.

`SS` et `UU` forment l'agrégat « build courant » : ce ne sont pas des expériences
isolées, et le meilleur lot n'est pas présenté comme une moyenne séparée.

**Durées** : `startedAt`/`endedAt` sont publiés par run ci-dessus pour les lots BA à
II, et la campagne contrôlée les enregistre aussi : 492,6 s contre 427,9 s par run,
un écart non séparable (erreur-type 50 s).
