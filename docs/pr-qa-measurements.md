# Mesures — campagnes de runs et comparaison appariée

Ce fichier est **généré** depuis les artefacts des runs (aucune donnée saisie à la main).

## Campagnes (10 runs par lot, même PR #20, même modèle `opencode-go/deepseek-v4.1-flash`, même oracle)

| Lot | Run | Verdict | Scénarios verts | Échecs produit | Bloqués | Tokens | Appels | Durée |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **BA** | 10 runs | 7/10 verts | 87 | 2 | 2 | 2 810 804 | 16 | — |
| | `0ce50724` | passed | 8 | 0 | 0 | 344 988 | 2 | 6 min 28 s |
| | `f83f0762` | failed | 7 | 1 | 0 | 351 925 | 2 | 7 min 42 s |
| | `0675aba9` | passed | 8 | 0 | 0 | 175 557 | 1 | 5 min 7 s |
| | `afcc9846` | blocked | 11 | 0 | 1 | 367 771 | 2 | 9 min 36 s |
| | `24db19b8` | failed | 10 | 1 | 1 | 344 781 | 2 | 7 min 4 s |
| | `d830e035` | passed | 9 | 0 | 0 | 174 808 | 1 | 5 min 55 s |
| | `ec6445c9` | passed | 7 | 0 | 0 | 353 246 | 2 | 7 min 53 s |
| | `94673c0a` | passed | 10 | 0 | 0 | 175 614 | 1 | 5 min 44 s |
| | `8bc0711c` | passed | 8 | 0 | 0 | 336 968 | 2 | 6 min 5 s |
| | `dc7e9356` | passed | 9 | 0 | 0 | 185 146 | 1 | 5 min 58 s |
| **CC** | 10 runs | 7/10 verts | 63 | 0 | 0 | 3 784 344 | 21 | — |
| | `7db8c556` | passed | 8 | 0 | 0 | 346 877 | 2 | 6 min 24 s |
| | `cb1a3dab` | blocked | 0 | 0 | 0 | 349 981 | 2 | 5 min 35 s |
| | `ddd8a0a0` | blocked | 7 | 0 | 0 | 348 808 | 2 | 7 min 9 s |
| | `450099db` | passed | 8 | 0 | 0 | 370 075 | 2 | 8 min 31 s |
| | `50dae25e` | passed | 8 | 0 | 0 | 369 035 | 2 | 8 min 31 s |
| | `1193dcf5` | passed | 7 | 0 | 0 | 360 875 | 2 | 7 min 39 s |
| | `c1d77bba` | passed | 10 | 0 | 0 | 350 599 | 2 | 7 min 14 s |
| | `56ae5df7` | blocked | 0 | 0 | 0 | 374 029 | 2 | 7 min 11 s |
| | `0637d181` | passed | 6 | 0 | 0 | 354 008 | 2 | 6 min 50 s |
| | `500a02a9` | passed | 9 | 0 | 0 | 560 057 | 3 | 9 min 40 s |
| **DD** | 10 runs | 5/10 verts | 71 | 1 | 4 | 3 414 409 | 20 | — |
| | `b8818582` | blocked | 8 | 0 | 1 | 341 097 | 3 | 6 min 31 s |
| | `0b71b8a3` | passed | 7 | 0 | 0 | 349 856 | 2 | 6 min 53 s |
| | `f5ecbaac` | failed | 7 | 1 | 0 | 347 830 | 2 | 7 min 7 s |
| | `bed1253d` | blocked | 9 | 0 | 1 | 578 063 | 3 | 9 min 43 s |
| | `b5711fb7` | blocked | 7 | 0 | 2 | 369 615 | 2 | 7 min 47 s |
| | `bc0e083e` | blocked | 0 | 0 | 0 | 365 281 | 2 | 6 min 55 s |
| | `3f60a8d1` | passed | 7 | 0 | 0 | 174 404 | 1 | 4 min 46 s |
| | `fe361a8b` | passed | 9 | 0 | 0 | 342 134 | 2 | 7 min 6 s |
| | `b498e8f1` | passed | 8 | 0 | 0 | 171 469 | 1 | 5 min 8 s |
| | `a30c3d72` | passed | 9 | 0 | 0 | 374 660 | 2 | 8 min 24 s |
| **EE** | 10 runs | 6/10 verts | 84 | 0 | 5 | 4 326 987 | 27 | — |
| | `28525781` | blocked | 7 | 0 | 1 | 359 669 | 3 | 8 min 2 s |
| | `74fb516d` | passed | 10 | 0 | 0 | 498 189 | 3 | 7 min 7 s |
| | `8a16f402` | blocked | 7 | 0 | 1 | 351 693 | 2 | 7 min 34 s |
| | `d07c4ed4` | blocked | 9 | 0 | 2 | 366 146 | 3 | 9 min 16 s |
| | `f031c109` | passed | 10 | 0 | 0 | 517 684 | 3 | 8 min 14 s |
| | `c7136c7b` | passed | 6 | 0 | 0 | 327 969 | 2 | 5 min 13 s |
| | `273dc450` | passed | 8 | 0 | 0 | 506 849 | 3 | 8 min 10 s |
| | `cd62137e` | blocked | 9 | 0 | 1 | 697 388 | 4 | 9 min 33 s |
| | `4bde1657` | passed | 7 | 0 | 0 | 362 968 | 2 | 9 min 26 s |
| | `f7c2778e` | passed | 11 | 0 | 0 | 338 432 | 2 | 7 min 28 s |
| **FF** | 9 runs | 8/9 verts | 74 | 0 | 2 | 3 863 964 | 24 | — |
| | `403d43d2` | passed | 5 | 0 | 0 | 336 076 | 2 | 5 min 51 s |
| | `441bfc0e` | passed | 10 | 0 | 0 | 541 081 | 3 | 12 min 18 s |
| | `34f76fd9` | passed | 7 | 0 | 0 | 340 043 | 2 | 6 min 42 s |
| | `cd6d22f6` | passed | 8 | 0 | 0 | 521 408 | 3 | 9 min 0 s |
| | `6dd36613` | passed | 10 | 0 | 0 | 374 716 | 2 | 11 min 3 s |
| | `7900e46d` | blocked | 8 | 0 | 2 | 712 384 | 5 | 13 min 32 s |
| | `896d4967` | passed | 9 | 0 | 0 | 348 839 | 2 | 8 min 7 s |
| | `bfc43f8e` | passed | 7 | 0 | 0 | 332 222 | 3 | 6 min 50 s |
| | `510b96f2` | passed | 10 | 0 | 0 | 357 195 | 2 | 9 min 7 s |
| **GG** | 10 runs | 5/10 verts | 74 | 1 | 3 | 3 832 769 | 22 | — |
| | `ca55513b` | blocked | 7 | 0 | 1 | 499 627 | 3 | 7 min 15 s |
| | `e3f3ad2b` | passed | 7 | 0 | 0 | 358 074 | 2 | 7 min 33 s |
| | `160792a9` | failed | 8 | 1 | 0 | 516 390 | 3 | 9 min 40 s |
| | `74f1cfea` | blocked | 0 | 0 | 0 | 335 979 | 2 | 5 min 15 s |
| | `bc46290b` | passed | 10 | 0 | 0 | 367 118 | 2 | 8 min 19 s |
| | `6832a9e4` | blocked | 9 | 0 | 1 | 339 732 | 2 | 6 min 15 s |
| | `d8b73758` | passed | 10 | 0 | 0 | 356 605 | 2 | 8 min 33 s |
| | `5afc804a` | blocked | 8 | 0 | 1 | 355 266 | 2 | 8 min 55 s |
| | `c22a89f1` | passed | 8 | 0 | 0 | 339 426 | 2 | 7 min 44 s |
| | `566ffe64` | passed | 7 | 0 | 0 | 364 552 | 2 | 9 min 19 s |
| **HH** | 10 runs | 10/10 verts | 86 | 0 | 0 | 2 440 356 | 18 | — |
| | `b6641dfb` | passed | 10 | 0 | 0 | 396 142 | 3 | 8 min 38 s |
| | `6db4cf7e` | passed | 9 | 0 | 0 | 132 788 | 1 | 5 min 2 s |
| | `13d0aaac` | passed | 6 | 0 | 0 | 269 451 | 2 | 8 min 4 s |
| | `79f33027` | passed | 10 | 0 | 0 | 270 930 | 2 | 8 min 29 s |
| | `4f684ac2` | passed | 8 | 0 | 0 | 133 635 | 1 | 6 min 36 s |
| | `9da45e20` | passed | 10 | 0 | 0 | 139 699 | 1 | 7 min 8 s |
| | `7c0983ed` | passed | 11 | 0 | 0 | 429 664 | 3 | 12 min 27 s |
| | `43aae022` | passed | 8 | 0 | 0 | 280 863 | 2 | 8 min 21 s |
| | `1b960768` | passed | 7 | 0 | 0 | 255 324 | 2 | 6 min 10 s |
| | `53133517` | passed | 7 | 0 | 0 | 131 860 | 1 | 4 min 54 s |
| **II** | 10 runs | 7/10 verts | 75 | 0 | 2 | 3 144 996 | 23 | — |
| | `5deb7c69` | passed | 9 | 0 | 0 | 147 603 | 1 | 6 min 16 s |
| | `0da1a10e` | blocked | 0 | 0 | 0 | 267 192 | 2 | 5 min 12 s |
| | `437ec805` | blocked | 7 | 0 | 1 | 274 157 | 2 | 7 min 36 s |
| | `c61cb8dc` | passed | 9 | 0 | 0 | 274 189 | 2 | 7 min 20 s |
| | `d9f65e49` | passed | 9 | 0 | 0 | 565 462 | 4 | 12 min 48 s |
| | `6e3f63fa` | blocked | 5 | 0 | 1 | 278 182 | 2 | 7 min 19 s |
| | `bd230341` | passed | 7 | 0 | 0 | 293 350 | 2 | 9 min 17 s |
| | `72ce4151` | passed | 10 | 0 | 0 | 256 755 | 2 | 6 min 24 s |
| | `e9752df0` | passed | 10 | 0 | 0 | 526 565 | 4 | 10 min 2 s |
| | `851b62d2` | passed | 9 | 0 | 0 | 261 541 | 2 | 7 min 25 s |

## Comparaison appariée `8143ac9` (origine) → `a05d63d` (aujourd'hui), 79 plans réels

- plans comparés : **79** (lots BA à II), mêmes entrées, aucune génération LLM ;

- refusés par la porte d'origine : **5** ; refusés aujourd'hui : **15** ;

- plans nouvellement refusés : **10**, dont **10** visent un scénario qui n'était pas vert dans son run d'origine → **aucun faux refus** ;

- plans acceptés aujourd'hui qui étaient refusés à l'origine : **0** → **aucun contrôle affaibli** ;

- deux exécutions rendent un verdict identique (déterminisme vérifié en CI).

Test permanent : `apps/canary-pr-qa/test/replay-comparison.test.ts` (fixtures `plans.json.gz`, `baseline-verdicts.json`).
