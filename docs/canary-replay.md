# Canary Replay: deterministic historical gate replay

## Run it locally

From the repository root:

```bash
pnpm --filter @usecanary/pr-qa test:replay
```

This runs `test/historical.test.ts` against the frozen PR #20 diff snapshot and
seven real historical plans. It does **not** call the planner model, open a browser,
resolve a preview, deploy code, or publish a GitHub status/comment. It is intended
as a fast regression check while changing deterministic plan gates.

The corpus currently checks attribution repair and selected source-witness /
length refusals, and records two defects that static evidence cannot prove:
an invariant transition and a target missing after navigation. Those two cases
must not be described as fully validated offline; they require runtime evidence.

## What this first increment does not do

This is the entry point for the deterministic replay workflow, not yet the full
three-mode replay system. In particular, the corpus is a fixed set of seven
plans, not a general `--bundle` interface; it does not replay every production
gate or regenerate plans with the model. The next increments should:

1. Persist immutable run bundles containing the exact planner payload, model
   snapshot, source/diff context, original full plan, refusals/repairs, and
   available runtime observations, with credentials and session material excluded.
2. Extract the production plan-validation pipeline into a shared function so
   production and replay call the **same** gates, rather than maintaining a
   second validator.
3. Add a bundle-driven `gate` mode with no network, model, browser, or publication.
4. Add an opt-in `plan` mode that calls the configured model against frozen input
   only, then applies the same validation/repair path without discovering a preview.
5. Keep browser replay targeted to cases whose correctness depends on runtime
   state or DOM availability.

The full plan must be validated even when a report focuses on one previously
failing scenario: global coverage requirements depend on the other scenarios.
