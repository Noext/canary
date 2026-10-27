# Taxonomie des familles d'échec — état figé

Deux sources, toutes deux committées et recalculées par des tests :
`test/historical/plans.json.gz` (79 plans réels des lots BA→II, identifiants et
diagnostics de scénario) et `test/historical/campaign-runs.json` (**181 runs**, un
identifiant par ligne, verdict, scénarios verts, échecs produit, tokens, diagnostic
de run et codes de scénario). `interleaved.json` n'est plus qu'un agrégat dérivé.

Références figées : baseline `8143ac9`, lignée `4b92c9a`.

## A. Familles sur les 79 plans des lots BA→II

| Famille | Scénarios | Runs | Lots |
| --- | --- | --- | --- |
| `MARKER_ORDER_UNREACHABLE` | 9 | 9 : `b5711fb7`, `8a16f402`, `d07c4ed4`, `cd62137e`, `7900e46d`, `6832a9e4`, `5afc804a`, `437ec805`, `6e3f63fa` | DD, EE, FF, GG, II |
| `TARGET_NOT_FOUND` | 6 | 6 : `afcc9846`, `b8818582`, `28525781`, `d07c4ed4`, `7900e46d`, `ca55513b` | BA, DD, EE, FF, GG |
| `TRANSITION_NOT_OBSERVED` | 3 | 3 : `f83f0762`, `f5ecbaac`, `160792a9` | BA, DD, GG |
| `TRANSITION_ON_INVARIANT` | 3 | 3 : `24db19b8`, `bed1253d`, `b5711fb7` | BA, DD |
| `no-diagnostic` | 1 | 1 : `24db19b8` | BA |

## B. Familles sur les 181 runs des campagnes (identifiants complets dans le fichier)

| Famille | Occurrences | Lots concernés |
| --- | --- | --- |
| `TARGET_NOT_FOUND` | 26 | DD, EE, FF, GG, JJ, KK, LL, NN, PP, QQ, RR |
| `MARKER_ORDER_UNREACHABLE` | 22 | DD, EE, FF, GG, II, KK, LL, MM, OO, PP, QQ, RR, SS |
| `QA_ERROR` | 9 | KK, LL, MM, NN, OO |
| `TRANSITION_NOT_OBSERVED` | 8 | DD, GG, JJ, NN, RR, TT |
| `REQUIREMENT_UNGROUNDED` | 6 | DD, GG, II, KK, OO, QQ |
| `TRANSITION_ON_INVARIANT` | 4 | DD, QQ, RR |
| `RUN_BUDGET_EXCEEDED` | 4 | FF, NN, TT |
| `PLAN_CHANGED_FILE_UNCOVERED` | 2 | OO, PP |
| `PLAN_STATE_TARGET_READ_AS_TEXT` | 1 | KK |
| `HTTP_502` | 1 | OO |
| `COVERAGE_WITNESS_MISSING` | 1 | QQ |
| `PLAN_SCHEMA_INVALID` | 1 | TT |
| `PLAN_SELECTOR_UNSTABLE` | 1 | UU |

Les runs non verts et leur diagnostic, lot par lot :

| Lot | Runs non verts (identifiant court → diagnostic) |
| --- | --- |
| DD | `b8818582`→TARGET_NOT_FOUND ; `f5ecbaac`→TRANSITION_NOT_OBSERVED ; `bed1253d`→TRANSITION_ON_INVARIANT ; `b5711fb7`→MARKER_ORDER_UNREACHABLE,TRANSITION_ON_INVARIANT ; `bc0e083e`→REQUIREMENT_UNGROUNDED |
| EE | `28525781`→TARGET_NOT_FOUND ; `8a16f402`→MARKER_ORDER_UNREACHABLE ; `d07c4ed4`→MARKER_ORDER_UNREACHABLE,TARGET_NOT_FOUND ; `cd62137e`→MARKER_ORDER_UNREACHABLE |
| FF | `d5151bca`→RUN_BUDGET_EXCEEDED ; `7900e46d`→RUN_BUDGET_EXCEEDED |
| GG | `ca55513b`→TARGET_NOT_FOUND ; `160792a9`→TRANSITION_NOT_OBSERVED ; `74f1cfea`→REQUIREMENT_UNGROUNDED ; `6832a9e4`→MARKER_ORDER_UNREACHABLE ; `5afc804a`→MARKER_ORDER_UNREACHABLE |
| II | `0da1a10e`→REQUIREMENT_UNGROUNDED ; `437ec805`→MARKER_ORDER_UNREACHABLE ; `6e3f63fa`→MARKER_ORDER_UNREACHABLE |
| JJ | `df72d1b7`→TRANSITION_NOT_OBSERVED ; `aae64659`→TARGET_NOT_FOUND,TRANSITION_NOT_OBSERVED ; `be9084c6`→no-diagnostic |
| KK | `90315438`→REQUIREMENT_UNGROUNDED ; `d2d3cf14`→TARGET_NOT_FOUND ; `e5ee0dd5`→TARGET_NOT_FOUND ; `97ec3d9d`→QA_ERROR ; `361d115a`→TARGET_NOT_FOUND ; `51644ed9`→TARGET_NOT_FOUND ; `ca37803e`→PLAN_STATE_TARGET_READ_AS_TEXT,TARGET_NOT_FOUND ; `eb8a7336`→MARKER_ORDER_UNREACHABLE,TARGET_NOT_FOUND ; `50cfa0d8`→TARGET_NOT_FOUND |
| LL | `779e5398`→TARGET_NOT_FOUND ; `3674c055`→TARGET_NOT_FOUND ; `e336f483`→TARGET_NOT_FOUND ; `e86df885`→TARGET_NOT_FOUND ; `d7345e75`→TARGET_NOT_FOUND ; `979044da`→TARGET_NOT_FOUND ; `7e1a2c04`→QA_ERROR ; `9fd1e99e`→QA_ERROR ; `ee3bf230`→MARKER_ORDER_UNREACHABLE |
| MM | `839cee08`→QA_ERROR ; `9a7b18e7`→no-diagnostic ; `99ec13c1`→MARKER_ORDER_UNREACHABLE |
| NN | `a4387f43`→RUN_BUDGET_EXCEEDED ; `6c2d9572`→TARGET_NOT_FOUND ; `8fc389ff`→TARGET_NOT_FOUND,TRANSITION_NOT_OBSERVED ; `1b8d8d87`→QA_ERROR |
| OO | `790fe5b5`→HTTP_502 ; `4d1f7d43`→REQUIREMENT_UNGROUNDED ; `01dc01ab`→PLAN_CHANGED_FILE_UNCOVERED ; `2db6f362`→MARKER_ORDER_UNREACHABLE ; `827e2108`→MARKER_ORDER_UNREACHABLE ; `7b121e6d`→QA_ERROR |
| PP | `425e70e7`→MARKER_ORDER_UNREACHABLE ; `9e5c2edc`→TARGET_NOT_FOUND ; `f6c74998`→PLAN_CHANGED_FILE_UNCOVERED |
| QQ | `56149663`→MARKER_ORDER_UNREACHABLE ; `e29f3f7a`→TRANSITION_ON_INVARIANT ; `28bcb05f`→COVERAGE_WITNESS_MISSING ; `e56bb5ce`→MARKER_ORDER_UNREACHABLE,TARGET_NOT_FOUND ; `a2e88c67`→REQUIREMENT_UNGROUNDED,TARGET_NOT_FOUND |
| RR | `e90c9e75`→TARGET_NOT_FOUND,TRANSITION_ON_INVARIANT ; `0b8ddefe`→TRANSITION_NOT_OBSERVED ; `22f8d228`→MARKER_ORDER_UNREACHABLE ; `b8086467`→MARKER_ORDER_UNREACHABLE ; `0f05b09e`→MARKER_ORDER_UNREACHABLE |
| SS | `277dee09`→MARKER_ORDER_UNREACHABLE |
| TT | `e6f24ee9`→RUN_BUDGET_EXCEEDED ; `4fed6f58`→PLAN_SCHEMA_INVALID ; `60c44866`→TRANSITION_NOT_OBSERVED ; `f6a6a890`→TRANSITION_NOT_OBSERVED ; `c9c68ce9`→no-diagnostic ; `2417c8b5`→no-diagnostic |
| UU | `739e7bdb`→PLAN_SELECTOR_UNSTABLE |

## C. Périmètres publiés (recalculés depuis les runs)

| Périmètre | Runs | Verts | Scénarios verts/run | Échecs produit/run | Tokens/run |
| --- | --- | --- | --- | --- | --- |
| Référence `8143ac9` | 30 | 17 (57 %) | 7.4 | 0.27 | 288456 |
| Build courant (SS, UU) | 20 | 18 (90 %) | 9.1 | 0.05 | 288238 |
| Autres builds de la lignée | 131 | 72 (55 %) | 7.6 | 0.05 | 329285 |
