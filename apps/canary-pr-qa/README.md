# Autonomous PR QA in the Canary fork

This app takes a GitHub PR URL, reads its description and changed files at immutable commits, plans functional scenarios with an OpenAI-compatible model, then executes them in **the existing Canary Chromium engine**. Each scenario gets its own headless session, video, trace, HAR, console log, step screenshots and Canary report. The runner evaluates assertions independently of the model and publishes a PR comment and commit status.

## Quick start (Node 22+, Linux/macOS)

```bash
git clone https://github.com/Noext/canary.git
cd canary
git remote add upstream https://github.com/0xnyn/canary.git
git remote set-url --push upstream DISABLED
git checkout feat/autonomous-pr-qa
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @usecanary/pr-qa... build
node apps/canary/dist/cli.js install
# Linux only, if Chromium system libraries are missing:
corepack pnpm --filter @usecanary/daemon exec playwright install-deps chromium
cp .env.example .env
# Edit .env: GitHub PAT, model endpoint/name, preview hosts and API token.
node --env-file=.env apps/canary-pr-qa/dist/cli.js run https://github.com/OWNER/REPO/pull/123
```

Use `--preview https://preview.example.com` when the PR has no matching GitHub deployment; use `--no-publish` for local-only testing. Exit code **0** means every planned browser scenario passed and publication (if enabled) succeeded; **1** means an assertion failed; **2** means blocked, skipped, stale, invalid input or publication failure. A pass does not cover explicitly skipped non-browser changes; these are listed in every report.

The GitHub token used by this deployed app is your own fine-grained PAT or installation token. The ChatGPT GitHub connection used to develop this fork is not exported into the app. Grant Contents, Metadata and Deployments **read**, Pull requests **write**, and Commit statuses **write**, scoped to the repositories you intend to test. Do not use an all-repository token unnecessarily.

## Exact-commit preview provenance

The runner refuses to test a generic staging URL without evidence of the deployed SHA:

1. By default it queries GitHub deployments in the base and head repositories, filters the **full 40-character PR head SHA**, and requires the configured environment (default `preview`) and the most recent deployment status to be `success` with an `environment_url`. A previous successful status followed by failure/inactive is not accepted. This trusts GitHub deployment metadata; a pipeline must maintain it correctly.
2. For `--preview` or `PREVIEW_URL_TEMPLATE`, the running preview must return `x-commit-sha: <full SHA>` on its root response, or set `PREVIEW_SHA_PATH=/version.json` and serve `{"sha":"<full SHA>"}`. The response must not redirect. If `PREVIEW_SHA_PATH` is configured, GitHub-resolved deployments are also probed against the live server.
3. The PR head/base/state and preview provenance are rechecked before publishing the final result. A changed PR or preview is reported as stale or blocked, never green.

Templates accept `{sha}` and `{pr}`. `PREVIEW_ALLOWED_HOSTS` requires exact host and optional port matches, e.g. `my-preview.example.com,127.0.0.1:3000`. For VPS previews, prefer immutable SHA-specific hostnames. Redirecting previews must use their final URL. The browser's explicit navigation tools stay on the preview origin; navigation away through a page control is detected and blocks execution, but this is not a network sandbox. For untrusted applications use a separate network-restricted VPS/container, without cloud metadata access. Browser fixtures must be disposable: tests really click, fill and submit forms.

## VPS with Docker Compose

```bash
cp .env.example .env
# Set a reachable model URL, allowed repos/preview hosts, PAT and random QA_API_TOKEN.
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

Chromium and Canary run together in one container; no Kubernetes or external browser server. The service listens on localhost on the VPS. Put a TLS reverse proxy in front of it if remote access is needed. For a model on the VPS itself, use a Docker-reachable address; `localhost` inside the container is the container. Linux Docker does not automatically define `host.docker.internal`; use an IP reachable from the container or add `extra_hosts: ["host.docker.internal:host-gateway"]` to compose. Preview hosts must also be reachable from the container.

```bash
curl -X POST http://127.0.0.1:8787/runs \
  -H "Authorization: Bearer $QA_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"prUrl":"https://github.com/OWNER/REPO/pull/123","previewUrl":"https://preview.example.com"}'
# Response: {id, statusUrl, reportUrl}. Poll the authenticated statusUrl.
curl http://127.0.0.1:8787/runs/RUN_ID -H "Authorization: Bearer $QA_API_TOKEN"
```

Jobs run serially, with a bounded queue, and are persisted under `QA_DATA_DIR`. After a service restart, incomplete jobs are marked `interrupted` and require explicit resubmission; browser side effects are not silently replayed. `GET /health` is unauthenticated. All job actions require the API bearer token. `GITHUB_ALLOWED_REPOS` is mandatory in service mode.

Set `ARTIFACT_BASE_URL=https://qa.example.com` to include report links in GitHub comments and statuses. With `ARTIFACT_PUBLIC=false`, artifacts require bearer authentication: download them using curl with the Authorization header or configure authentication at your reverse proxy. With `true`, UUID report/video URLs are accessible without the API token. These may expose test data, screenshots and cookies in HAR/traces: use only suitable test accounts. No browser profile directory is exported. Reports are preserved in `qa-data` and full native sessions remain in `~/.canary/sessions`; use `canary ui` to browse them with the original UI.

## Workflow and architecture

| Module | Responsibility |
| --- | --- |
| `github.ts` | PR URL validation, paginated diff, pinned head/base context, exact-SHA deployments, comments and statuses |
| `preview.ts` | Live SHA verification, deployment evidence and host allowlist |
| `model.ts` + `schema.ts` | Validated JSON planning/execution, bounded retries and prompts |
| `canary.ts` | Adapter to the fork's built Canary CLI; deterministic scripts from typed actions; native session artifacts |
| `runner.ts` | Discovery, scenario execution, immutable assertions, final SHA recheck and publication |
| `server.ts` | Authenticated job submission, persistent status, queue and artifact serving |
| `report.ts` | JSON, Markdown and HTML run report linking each native Canary session |

The planner sees the PR diff, relevant head/base files, README/package conventions and an actual initial page snapshot. Plans cite changed files and explicitly account for files that are not browser-testable. Large/incomplete diffs fail closed rather than produce a silent partial pass. Only an original plan's assertions can be executed; their expected values cannot be changed during execution. The executor selects one typed action per turn (observe, navigate, click, fill, press, select, check, assert, finish or blocked). It does not generate arbitrary executable JavaScript. Actions are compiled to sandboxed Canary scripts, recorded as steps, and observations from the actual browser are returned to the model. A mismatched assertion is terminal. Failed selectors can be repaired from new observations, within action/time/error budgets.

The model is responsible for scenario relevance and expected-value reasoning; deterministic assertions prevent self-declared success but cannot guarantee exhaustive or correct test design. Review the generated plan and skipped list. Supported assertions: normalized text contains expected, exact input value, exact URL, count, visible and hidden. Unsupported workflows (native dialogs, downloads, mail/OTP, complex external SSO, multi-origin flows) should be blocked. There is no source-code modification, automatic application deployment, webhook installation or test-data provisioning. Protected previews or login-required apps need a fixture/preauthenticated preview that the browser can access; missing credentials are blocked. No API key or GitHub token is passed to browser scripts or model context.

## Automated validation

```bash
corepack pnpm --filter @usecanary/pr-qa test
corepack pnpm --filter @usecanary/pr-qa compile
# Requires built CLI, installed Canary runtime and Chromium:
corepack pnpm --filter @usecanary/pr-qa... build
node apps/canary/dist/cli.js install
corepack pnpm --filter @usecanary/pr-qa test:e2e
corepack pnpm check
```

The E2E test uses a local GitHub REST fixture and scripted OpenAI-compatible responses **with real Canary Chromium sessions**. It verifies actual form interaction, positive and failing assertions, non-empty WebM/trace/screenshot artifacts, and the outgoing GitHub comment/status requests. It does not claim to evaluate a real LLM's reasoning quality or live GitHub authorization. CI runs it separately after installing the real runtime. Runtime configuration can switch to your real API without code changes.

If Unix sockets are unavailable in your development environment, set `CANARY_DAEMON_PORT=18473` and a `CANARY_DAEMON_TOKEN` of at least 32 random characters for both the CLI and its spawned daemon. This opt-in transport binds only to `127.0.0.1` and authenticates every request; it never publishes the daemon port in Docker Compose. Normal VPS operation keeps Canary's native socket transport. Stop the daemon before switching transports. The sandbox bundle build uses `node --import tsx` so it does not require tsx's extra IPC socket.

## Maintaining the official fork

Keep `origin` as `Noext/canary`, `upstream` as `0xnyn/canary`, and work on `feat/autonomous-pr-qa`. All new orchestration lives in a separate workspace; the Canary engine remains intact. Update from upstream through a reviewed merge on a separate branch; never force-push or open an upstream PR implicitly. The development PR targets `Noext/canary:main`.
