# Canary Replay

Canary Replay lets a developer validate a stored plan against the production gates
without starting a browser session, resolving a preview, deploying, or publishing
a GitHub status/comment.

## Capture a replay bundle

Set `QA_REPLAY_BUNDLE=true` in the environment used for a normal PR QA run. After
planning and the production settlement step, Canary writes:

```
<QA_DATA_DIR>/<run-id>/replay-bundle.json
```

The bundle pins the PR URL, head/base SHAs, source context, diff, trusted policy and
catalog, exact planner payload, raw generated plan, settled plan, and the initial
ARIA observation. Capture is opt-in because source files and page text may contain
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
- **`plan`** sends the stored planner payload to the configured model with the
  current planner prompt/schema, then applies those same gates. It calls the model
  endpoint only; it does not rediscover the page or execute scenarios.

A non-zero exit code means the resulting plan has one or more refusals.
Inconclusive evidence is reported separately and is not silently treated as proof.

The bundle stores both the raw generated plan and the settled plan. Gate mode
validates the settled plan, matching the final production validation path; the raw
plan is preserved for analysis.

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
