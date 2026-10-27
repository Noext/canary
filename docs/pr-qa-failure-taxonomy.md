# Taxonomie des familles d'échec — état figé

Généré depuis les artefacts stockés (`test/historical/plans.json.gz` : 79 plans réels
des lots BA→II ; `test/historical/interleaved.json` : 9 lots entrelacés JJ→SS).
Aucun chiffre saisi à la main. Références figées : baseline `8143ac9`, lignée `4b92c9a`.

## Familles observées sur les 79 plans stockés (24 runs non verts)

| Famille | Scénarios | Runs concernés | Lots | Préventable avant exécution ? |
| --- | --- | --- | --- | --- |
| `MARKER_ORDER_UNREACHABLE` | 9 | 9 (437ec805, 5afc804a, 6832a9e4, 6e3f63fa…) | DD, EE, FF, GG, II | partielle : la contradiction de longueur est démontrable (message nommant la valeur exacte depuis #102) ; l'ordre des gardes ne l'est pas toujours |
| `TARGET_NOT_FOUND` | 6 | 6 (28525781, 7900e46d, afcc9846, b8818582…) | BA, DD, EE, FF, GG | partielle : un libellé du diff est vérifiable statiquement, une cible rendue après interaction ne l'est pas (d'où la réécriture) |
| `TRANSITION_NOT_OBSERVED` | 3 | 3 (160792a9, f5ecbaac, f83f0762…) | BA, DD, GG | partielle : le gate requalifie en bloqué ; prévenir demande l'observation de l'exécution |
| `TRANSITION_ON_INVARIANT` | 3 | 3 (24db19b8, b5711fb7, bed1253d…) | BA, DD | partielle : idem, corrigé par la réécriture après observation (#101/#117) |
| `no-diagnostic` | 1 | 1 (24db19b8…) | BA | non : un run bloqué sans diagnostic est un trou d'instrumentation |

## Campagnes entrelacées (agrégats, tous lots)

| Lot | Build | Verts | Scénarios verts | Échecs produit | Bloqués | Tokens |
| --- | --- | --- | --- | --- | --- | --- |
| JJ | `8143ac9` | 6/10 | 75 | 3 | 3 | 2590005 |
| KK | `922159d` | 1/10 | 61 | 0 | 14 | 4370933 |
| MM | `8f831ab` | 7/10 | 93 | 2 | 3 | 2804726 |
| NN | `8143ac9` | 6/10 | 62 | 1 | 3 | 2307186 |
| OO | `a683f86` | 4/9 | 51 | 0 | 1 | 1892214 |
| PP | `a683f86` | 7/10 | 70 | 0 | 2 | 2551153 |
| QQ | `345b972` | 5/10 | 77 | 1 | 10 | 2746767 |
| RR | `9d563e0` | 5/10 | 89 | 1 | 6 | 3033696 |
| SS | `c5b3634` | 9/10 | 93 | 1 | 1 | 2921272 |

Total : **50/89 = 56 %** de runs entièrement verts.

## Ce que la taxonomie ne dit pas encore

- Les familles ci-dessus viennent des lots BA→II. Le lot le plus récent (SS, réécriture
  élargie) ne laisse qu'un scénario bloqué et un échec produit : la composition a changé,
  et les fréquences historiques ne décrivent plus le build courant.
- Les 9 lots entrelacés n'ont pas de classification par run stockée (agrégats seulement) :
  c'est le premier manque à combler pour la campagne suivante.
