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

## Planner capture and offline re-judging (`_planner/`, `rejudge`)

The replay bundle above exists only when the run produced an accepted plan. A
paid planner response that was refused (unreadable JSON, a plan that violates
the schema, a gate refusal) or that the budget no longer allowed to correct used
to leave no trace: `result.json` carries no plan, and the diagnostic only kept a
500-character excerpt and the first 12 schema violations. Every run therefore
writes, regardless of `QA_REPLAY_BUNDLE` and of the outcome:

| File | Written | Contents |
| --- | --- | --- |
| `_planner/inputs.json` | before the first planner call | PR context, trusted policy and catalog, the exact planner payload, discovery evidence (`url`, `aria`), the gate settings (`QA_MAX_SCENARIOS`, `QA_MAX_STEPS`, `QA_PER_SCENARIO_COVERAGE`) and the effective model configuration without secrets (model, base URL host only, token bounds, reasoning effort, JSON mode, stream, retries, timeout, run budgets) |
| `_planner/response-<n>.json` | for every paid model response, as soon as its usage is counted and before any budget check, then rewritten with its verdict | `call` (the run's response number), `purpose` (first line of the system prompt), `constrained`, `content` (redacted, up to 1 MB, `contentChars`/`contentTruncated`), `finishReason`, raw `usage` (including `completion_tokens_details`), `reasoningChars` (a count — reasoning text is never stored), `maxTokens`, `durationMs`, and `verdict`: `accepted`, `unusable` (+ reason), `unreadable` (+ `JSON.parse` error), `schema` (+ the full issue list), `gate` (+ the correction sent to the model) or `discarded` |

Each response also appends a one-line `modelResponse` entry to `events.jsonl`
(call, file, finish reason, verdict — never the content). Target-repair calls
are recorded the same way, under their own `purpose`.

The files are private: mode 0600 in a 0700 directory, passed through `redact`,
and never served by the artifact route (signed, public or authenticated). They
contain source and page text, like the replay bundle: keep the run directory
private. A failed write is logged and never fails the run.

When a refused response cannot be corrected because the envelope no longer
covers the next call, the run now fails with the response's own error
(`PLAN_SCHEMA_INVALID`, `MODEL_JSON_INVALID`, `MODEL_OUTPUT_INCOMPLETE`),
its excerpt and `Validation:` detail, followed by `Next model call not sent:
reservation … for … remaining`, instead of a bare `RUN_BUDGET_EXCEEDED`. When
the correction of a gate-refused plan fails (HTTP error, timeout, empty,
unreadable, schema-invalid or discarded answer), the refused plan is returned to
the runner, which re-applies its gates and records it — it is never marked valid.

Re-judge the saved responses for free — no model, no browser, no network:

```bash
canary-pr-qa rejudge ./qa-data/<run-id>               # every planner response
canary-pr-qa rejudge ./qa-data/<run-id> --response 1  # one response
# from a checkout: pnpm --filter @usecanary/pr-qa build && node apps/canary-pr-qa/dist/cli.js rejudge …
```

`rejudge` loads `inputs.json` and the responses, then applies the exact
functions the run uses: the usable-response check, `JSON.parse` and
`plannerPlanSchema(sourceLineMaterial(context))` with the full issue list, the
planner correction (`replayPlannerCorrection`, i.e. `planRefusals` plus the
quote-pick correction) and the complete pre-execution gate
(`replayPlanValidation`). Answers to a constrained correction and non-planner
responses are reported as `skipped`. It prints JSON and exits 0 only when every
judged response would be accepted with no refusal today, 1 otherwise. Because
the code is the current one, re-judging after a gate or schema change shows how
that change would have judged the paid response.

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
