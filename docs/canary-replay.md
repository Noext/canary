# Canary Replay

Canary Replay lets a developer validate a stored plan against the production gates
without repeating the PR → preview deployment → Chromium campaign loop.

## Capture a replay bundle

Set `QA_REPLAY_BUNDLE=true` in the environment used for a normal PR QA run. Canary
writes `replay-bundle.json` under the run directory in `QA_DATA_DIR`.

The bundle pins the PR URL, head/base SHAs, source context, diff, trusted policy and
catalog, planner input payload, raw generated plan, settled plan, initial ARIA
observation, and (after execution) the outcome and assertion results for each
scenario. Capture is opt-in because source files and page text may contain
sensitive information. Keep the run directory private; do not commit bundles or
publish them as CI artifacts without reviewing their contents.

## Replay a bundle

From the repository root:

```bash
pnpm --filter @usecanary/pr-qa dev -- replay ./qa-data/<run-id>/replay-bundle.json --mode gate
pnpm --filter @usecanary/pr-qa dev -- replay ./qa-data/<run-id>/replay-bundle.json --mode plan
```

- **`gate`** reads the bundle and runs the shared production plan-refusal,
  coverage, provenance and page-evidence checks. It makes no model request and
  does not use Chromium, a preview, GitHub, deployment, or tracing exporters.
- **`plan`** sends the stored planner input to the configured model with the
  current planner prompt/schema, then applies the same planner-time gates and
  production correction path. It calls the model endpoint only; it does not
  rediscover the page or execute scenarios.

The result carries a `verdict`, and the exit code follows it:

| `verdict` | Meaning | Exit |
| --- | --- | --- |
| `refused` | The plan has one or more refusals. | 1 |
| `accepted` | No refusal, and the page evidence was usable. | 0 |
| `unproven` | No refusal, but the page evidence could not judge the plan (no discovery snapshot, or a snapshot cut at its ceiling). | 1 |

`unproven` is not an error and not a refusal: it says the replay proved nothing, so it
must not be reported as a success. A replay of that kind proves only that the checks it
could run found nothing to object to.

Exit 0 therefore means *this plan is not refused*, never *the original run passed*.
`recordedOutcome` echoes the outcome stored in the bundle (when the run had finished), so a
reader never confuses the two: offline replay re-executes no scenario and cannot pronounce an
execution verdict.

## Regression workflow

1. Change the implementation locally.
2. Run compile, unit tests, and `pnpm --filter @usecanary/pr-qa test:replay`.
3. For a validator change, gate-replay relevant stored bundles.
4. For a planner/prompt change, run `--mode plan` against a small relevant subset.
5. Use browser replay only when the question depends on runtime state, navigation,
   or an element appearing after an interaction.

The historical corpus still contains cases that cannot be proven statically:
a transition on an invariant value and a target missing only after navigation.
Those require runtime evidence; offline replay must leave them inconclusive rather
than inventing a browser verdict.
