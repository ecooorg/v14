# 3. API and Integration Contracts

## 3.1 HTTP conventions

The public HTTP surface is registered primarily in `server.ts`; health routes are in `server/healthRoutes.ts`. JSON success responses commonly use `{"success":true,"data":...}`; errors generally use `{"success":false,"error":"...","code":"..."}`. Project route errors are normalised by `projectError()` in `server.ts`; important statuses include 400 for malformed requests, 404 for missing entities, 409 for State version conflicts or invalid task/plan transitions, 422 for refused State policy changes, and 503 for missing model/database capability. Do not assume every legacy analysis endpoint uses the same envelope.

Authentication/session endpoints and public health routes are distinct from Project domain routes. The repository contains a shared-password session mechanism; do not expose Project Mode without enabling the intended auth configuration. The actual route-level middleware coverage must be revalidated whenever the route list changes.

## 3.2 Registered route catalogue

The following list was generated from route registrations in the archive and includes source line references. It is a registration inventory, not a claim that all routes are externally reachable in the deployed environment.

| Method | Path | Source |
|---|---|---|
| `POST` | `/api/webhooks/github` | server.ts:93 |
| `GET` | `/api/session` | server.ts:268 |
| `POST` | `/api/login` | server.ts:277 |
| `POST` | `/api/logout` | server.ts:329 |
| `GET` | `/api/projects` | server.ts:370 |
| `POST` | `/api/projects` | server.ts:377 |
| `DELETE` | `/api/projects/:projectId` | server.ts:386 |
| `GET` | `/api/projects/:projectId` | server.ts:394 |
| `GET` | `/api/projects/:projectId/versions` | server.ts:402 |
| `PUT` | `/api/projects/:projectId/state` | server.ts:409 |
| `POST` | `/api/projects/:projectId/analyze` | server.ts:417 |
| `POST` | `/api/projects/:projectId/items/review` | server.ts:426 |
| `POST` | `/api/projects/:projectId/decisions` | server.ts:433 |
| `GET` | `/api/projects/:projectId/plans` | server.ts:441 |
| `POST` | `/api/projects/:projectId/plans` | server.ts:444 |
| `GET` | `/api/projects/:projectId/plans/:planId/tasks` | server.ts:451 |
| `GET` | `/api/projects/:projectId/approvals` | server.ts:458 |
| `POST` | `/api/projects/:projectId/approvals/:approvalId/decision` | server.ts:464 |
| `GET` | `/api/projects/:projectId/tasks` | server.ts:471 |
| `GET` | `/api/projects/:projectId/budgets/:scope/:scopeId` | server.ts:478 |
| `PUT` | `/api/projects/:projectId/budgets/:scope/:scopeId` | server.ts:484 |
| `GET` | `/api/projects/:projectId/settings` | server.ts:491 |
| `PUT` | `/api/projects/:projectId/settings` | server.ts:494 |
| `POST` | `/api/projects/:projectId/tasks/:taskId/queue` | server.ts:500 |
| `GET` | `/api/projects/:projectId/tasks/:taskId` | server.ts:509 |
| `POST` | `/api/projects/:projectId/tasks/:taskId/validate` | server.ts:516 |
| `GET` | `/api/projects/:projectId/tasks/:taskId/gates` | server.ts:526 |
| `POST` | `/api/projects/:projectId/tasks/:taskId/gates/:gate/waive` | server.ts:534 |
| `POST` | `/api/projects/:projectId/tasks/:taskId/gates/:gate/approve` | server.ts:545 |
| `GET` | `/api/projects/:projectId/tasks/:taskId/code` | server.ts:586 |
| `POST` | `/api/projects/:projectId/code/build` | server.ts:593 |
| `GET` | `/api/projects/:projectId/code` | server.ts:631 |
| `POST` | `/api/projects/:projectId/code/manual` | server.ts:642 |
| `POST` | `/api/projects/:projectId/tasks/:taskId/code/start` | server.ts:670 |
| `POST` | `/api/projects/:projectId/tasks/:taskId/code/brief` | server.ts:679 |
| `POST` | `/api/projects/:projectId/tasks/:taskId/code/:codeTaskId/approve` | server.ts:705 |
| `POST` | `/api/projects/:projectId/tasks/:taskId/code/:codeTaskId/commit-package` | server.ts:712 |
| `GET` | `/api/projects/:projectId/tasks/:taskId/code/:codeTaskId` | server.ts:719 |
| `GET` | `/api/projects/:projectId/tasks/:taskId/code/:codeTaskId/download` | server.ts:725 |
| `GET` | `/api/projects/:projectId/tasks/:taskId/code/:codeTaskId/package` | server.ts:737 |
| `POST` | `/api/projects/:projectId/tasks/:taskId/code/:codeTaskId/result` | server.ts:743 |
| `POST` | `/api/projects/:projectId/tasks/:taskId/code/:codeTaskId/refresh` | server.ts:753 |
| `POST` | `/api/projects/:projectId/tasks/:taskId/code/:codeTaskId/cancel` | server.ts:761 |
| `POST` | `/api/projects/:projectId/tasks/:taskId/code/:codeTaskId/review` | server.ts:769 |
| `POST` | `/api/projects/:projectId/tasks/:taskId/code/:codeTaskId/decide` | server.ts:780 |
| `POST` | `/api/projects/:projectId/tasks/:taskId/code/:codeTaskId/repair` | server.ts:795 |
| `GET` | `/api/projects/:projectId/artifacts` | server.ts:815 |
| `GET` | `/api/projects/:projectId/artifacts/:artifactId` | server.ts:819 |
| `GET` | `/api/projects/:projectId/ledger` | server.ts:827 |
| `GET` | `/api/ops` | server.ts:1437 |
| `GET` | `/ops` | server.ts:1449 |
| `POST` | `/api/conversation` | server.ts:1677 |
| `POST` | `/api/neutralize` | server.ts:1981 |
| `POST` | `/api/radar` | server.ts:2006 |
| `POST` | `/api/understand` | server.ts:2169 |
| `POST` | `/api/knowledge-map` | server.ts:2293 |
| `POST` | `/api/expand` | server.ts:2359 |
| `POST` | `/api/redteam-pair` | server.ts:2403 |
| `POST` | `/api/redteam` | server.ts:2433 |
| `POST` | `/api/premortem` | server.ts:2460 |
| `POST` | `/api/experiment-draft` | server.ts:2497 |
| `POST` | `/api/forecast-wording` | server.ts:2536 |
| `POST` | `/api/synthesis` | server.ts:2572 |
| `POST` | `/api/review` | server.ts:2617 |
| `POST` | `/api/analyze-full` | server.ts:2645 |
| `POST` | `/api/radar-legacy` | server.ts:2648 |
| `POST` | `/api/evpi` | server.ts:2653 |
| `POST` | `/api/revise-document` | server.ts:2664 |
| `POST` | `/api/attach` | server.ts:2705 |
| `POST` | `/api/export-document` | server.ts:2725 |
| `GET` | `*` | server.ts:2820 |
| `GET` | `/health` | server/healthRoutes.ts:22 |
| `GET` | `/ready` | server/healthRoutes.ts:30 |
| `GET` | `/api/health` | server/healthRoutes.ts:37 |

## 3.3 Core Project API request shapes

These contracts are read from the current Zod schemas/route handlers; response `data` shapes should be taken from the domain service and route implementation.

### Projects and State

- `POST /api/projects`: strict request `{name: string(1..200), goal?: string(max 2000), state?: object}`. If `state` is absent, server initialises `{passport: defaultPassport(goal)}`. Responds `201` with project.
- `GET /api/projects?limit=N`: lists projects; default limit 100.
- `GET /api/projects/:projectId`: returns one project or 404.
- `DELETE /api/projects/:projectId`: human-attributed deletion; 404 if absent.
- `GET /api/projects/:projectId/versions?limit=N`: state version history; default limit 50.
- `PUT /api/projects/:projectId/state`: strict `{expected_version: positive integer, state: object}`. State supports an optional Passport; if present it must validate. Stale version is a 409 conflict.
- `POST /api/projects/:projectId/analyze`: `{expected_version: integer >=1, task: trimmed string 1..4000, artifact_ids?: string[] (max 5, each max 128)}`. Requires server Gemini configuration.
- `POST /api/projects/:projectId/items/review`: `{expected_version, section, id, action: confirm|reject, reason?}`.
- `POST /api/projects/:projectId/decisions`: `{expected_version, text: 1..2000, rationale?: <=2000}`; human decision only.

### Plans, approvals, budgets, settings

- `POST /api/projects/:projectId/plans`: `{source?: template|model|human, template?: <=100, goal?: <=2000, nodes?: unknown}`. Defaults source to `human`; creation is attributed to a human actor.
- `GET /api/projects/:projectId/approvals?status=PENDING|APPROVED|REJECTED`.
- `POST /api/projects/:projectId/approvals/:approvalId/decision`: `{decision: APPROVED|REJECTED, reason?: <=1000, budget_limits?: {scope: project|task|run, scope_id, limits}}`. Limit keys are `max_model_calls`, `max_tokens`, `max_cost_units`, `max_wall_clock_ms`, `max_attempts`, `max_code_tasks`; each may be a non-negative integer or null.
- `PUT /api/projects/:projectId/budgets/:scope/:scopeId`: body `{limits: strict budget-limit object}`; scope is project/task/run.
- `PUT /api/projects/:projectId/settings`: optional `approval_mode: supervised|manual`, `max_concurrent_runs: integer 1..10`.
- `POST /api/projects/:projectId/tasks/:taskId/queue`: `{expected_version: integer >=1, idempotency_key: trimmed string 1..200}`.

### Code task / delivery

- Code brief route accepts a bounded goal, constraints, acceptance criteria, allowed paths, sensitivity, optional acceptance-test/context files (each collection max 50) and limits (`maxFiles` up to 50, `maxChangedLines` up to 5000). Exact schema is in `server.ts` near the `/code/brief` route.
- Code task `result` accepts `kind: pr|branch|diff` with the corresponding branch/PR/diff fields; exact schema is `codeResultSchema` in `server.ts`.
- `cancel` requires a non-empty reason up to 500 chars. `review` accepts optional notes up to 2000 chars. `decide` accepts `accept|repair|reject` and optional reason up to 1000 chars. `repair` accepts a bounded trigger, flaky flag, 64-hex diff hash, failing-test count, log excerpt up to 2000 chars and up to 10 links.
- ZIP download sets `Content-Type: application/zip`; missing source bundle is a 404 `BUNDLE_NOT_FOUND`.

## 3.4 Provider adapter contract

`server/adapter.ts` defines the provider-normalised request and response.

Request: `requestId`, `modelId`, optional `system`, `prompt`, optional `json` (default false), optional positive `maxOutputTokens`, and `metadata` object (default `{}`). Strict schema.

Response: `status: ok|error`; optional output (string/object/array); usage `{input, cached, output}` non-negative integers; `latencyMs`; `providerId`; `modelId`; optional `finishReason`; `retryable`; optional `errorClass`, `rawRef`, `retryAfterMs`. An `ok` response must include output and no error class. An `error` response must include an error class.

Capabilities: `json_output`, `long_context`, `vision`, `tool_use`, `code_patch`, `cached_tokens`. Error classes: `PROVIDER_TRANSIENT`, `PROVIDER_QUOTA`, `PROVIDER_AUTH`, `INVALID_REQUEST`, `INVALID_OUTPUT`, `POLICY_REJECTED`. HTTP 401/403 map to auth; 408/5xx to transient; 429 is quota only when caller identifies quota exhaustion; otherwise transient.

Adapters currently include Gemini and OpenAI-compatible implementations. The actual registry and availability must be checked against `server/modelRegistry.ts`, environment configuration and connection verification; registry status is not automatically equivalent to live provider availability.

## 3.5 Environment configuration inventory

This inventory lists variable names referenced by source/configuration. A reference does not necessarily mean the variable is required in every deployment. Requiredness depends on feature flags and routes. Values must never be copied into documentation.

| Variable | Presence / use |
|---|---|
| `APP_PASSWORD` | Documented in `.env.example` |
| `CHECK_TIMEOUT_MS` | Referenced in source/config; see inventory |
| `CI` | Referenced in source/config; see inventory |
| `CI_STATUS` | Referenced in source/config; see inventory |
| `CODE_EXECUTOR` | Documented in `.env.example` |
| `DAILY_CALL_CAP` | Documented in `.env.example` |
| `DATABASE_URL` | Documented in `.env.example` |
| `DISABLE_HMR` | Documented in `.env.example` |
| `E01_TEST_REPO` | Referenced in source/config; see inventory |
| `ENABLE_APP_AUTH` | Documented in `.env.example` |
| `ENABLE_PROJECT_MODE` | Documented in `.env.example` |
| `EPISTEMIC_VERIFIER_MODEL` | Referenced in source/config; see inventory |
| `EXPERT_ATTACH_TOTAL_CHARS` | Documented in `.env.example` |
| `FUZZ_SEED` | Referenced in source/config; see inventory |
| `GEMINI_API_KEY` | Documented in `.env.example` |
| `GEMINI_BASE_URL` | Documented in `.env.example` |
| `GITHUB_API_BASE_URL` | Documented in `.env.example` |
| `GITHUB_APP_ID` | Documented in `.env.example` |
| `GITHUB_APP_INSTALLATION_ID` | Documented in `.env.example` |
| `GITHUB_APP_PRIVATE_KEY` | Documented in `.env.example` |
| `GITHUB_DIFF_UPLOAD` | Documented in `.env.example` |
| `GITHUB_REPOSITORY` | Documented in `.env.example` |
| `GITHUB_REPOSITORY_NAME` | Documented in `.env.example` |
| `GITHUB_REPOSITORY_OWNER` | Documented in `.env.example` |
| `GITHUB_RUN_ID` | Referenced in source/config; see inventory |
| `GITHUB_SERVER_URL` | Referenced in source/config; see inventory |
| `GITHUB_STEP_SUMMARY` | Referenced in source/config; see inventory |
| `GITHUB_WEBHOOK_SECRET` | Documented in `.env.example` |
| `GIT_COMMIT` | Documented in `.env.example` |
| `GROQ_API_KEY` | Referenced in source/config; see inventory |
| `GROQ_BASE_URL` | Referenced in source/config; see inventory |
| `LLM_CALL_TIMEOUT_MS` | Documented in `.env.example` |
| `LLM_TOTAL_DEADLINE_MS` | Documented in `.env.example` |
| `LOGIN_MAX_FAILS` | Documented in `.env.example` |
| `LOGIN_WINDOW_MIN` | Documented in `.env.example` |
| `MAX_ATTACH_TEXT_CHARS` | Documented in `.env.example` |
| `MAX_BODY_BYTES` | Documented in `.env.example` |
| `MAX_MODEL_CALLS` | Documented in `.env.example` |
| `MAX_UPLOAD_BYTES` | Documented in `.env.example` |
| `MODEL_CASCADE_LIGHT` | Documented in `.env.example` |
| `MODEL_CASCADE_STRONG` | Documented in `.env.example` |
| `NODE_ENV` | Referenced in source/config; see inventory |
| `ONLY` | Documented in `.env.example` |
| `OPS_RSS_LIMIT_MB` | Referenced in source/config; see inventory |
| `PA01_TEST_API_KEY` | Referenced in source/config; see inventory |
| `PGSSLMODE` | Documented in `.env.example` |
| `PG_POOL_MAX` | Documented in `.env.example` |
| `PORT` | Referenced in source/config; see inventory |
| `PROJECT_RATE_LIMIT_PER_MINUTE` | Documented in `.env.example` |
| `RAILWAY_GIT_COMMIT_SHA` | Documented in `.env.example` |
| `RAILWAY_REPLICA_ID` | Referenced in source/config; see inventory |
| `RATE_LIMIT_PER_HOUR` | Documented in `.env.example` |
| `SERPER_API_KEY` | Documented in `.env.example` |
| `SESSION_SECRET` | Documented in `.env.example` |
| `SIDE` | Referenced in source/config; see inventory |
| `SKIP_DIST_HEALTHCHECK` | Documented in `.env.example` |
| `TASK` | Referenced in source/config; see inventory |
| `TRUST_PROXY_HOPS` | Documented in `.env.example` |
| `WEB_SEARCH_FETCH_PAGES` | Documented in `.env.example` |
| `WEB_SEARCH_MAX_PAGES` | Documented in `.env.example` |
| `WEB_SEARCH_MAX_QUERIES` | Documented in `.env.example` |
| `WEB_SEARCH_MODEL` | Documented in `.env.example` |
| `WEB_SEARCH_SEED_PAGES` | Referenced in source/config; see inventory |
| `WEB_SEARCH_TIMEOUT_MS` | Documented in `.env.example` |
| `WEB_SEARCH_TRANSLATE_MODEL` | Documented in `.env.example` |
| `WORKER_HEARTBEAT_MS` | Referenced in source/config; see inventory |
| `WORKER_LEASE_MS` | Referenced in source/config; see inventory |
| `WORKER_POLL_MS` | Referenced in source/config; see inventory |

Feature-critical configuration documented in `.env.example` and `docs/SPEC_CONNECTIONS.md` includes: `DATABASE_URL`, `APP_PASSWORD`, `SESSION_SECRET`, `ENABLE_APP_AUTH`, `ENABLE_PROJECT_MODE`, `GEMINI_API_KEY`, optional `GROQ_API_KEY`, `CODE_EXECUTOR`, `GITHUB_DIFF_UPLOAD`, `ENABLE_WEB_SEARCH`, `SERPER_API_KEY`, `GITHUB_APP_*`, `PGSSLMODE`, request/upload/attachment limits, rate limits, call/time budgets, and worker lease/poll intervals. `.env.example` contains example placeholders, not production-safe values.

## 3.6 External integrations and source of truth

| Integration | Current contract |
|---|---|
| Gemini | Primary chat and Project analysis; server-side key only. |
| Groq / OpenAI-compatible | Optional verifier/provider; does not block the primary answer on failure. |
| Web search | Opt-in; configured provider may be Serper or Gemini grounding, with optional page fetching. Disabled by default. |
| Google Drive | Browser-side connection/sync/mirroring; user-visible result status; Drive OAuth client ID may be supplied through `VITE_GOOGLE_CLIENT_ID`. |
| GitHub App | Read-only default. Metadata/contents/checks/PR read access as installed. Merge forbidden. Write paths are feature-gated and must not write to `main`. |
| PostgreSQL | Required for Project Mode; migration scripts apply migrations 001–014. |
| Railway | Deployment assumptions documented, but live production configuration is not verified by the source archive. |

## 3.7 API compatibility rules

- Treat existing field names and enum values as public contract. Do not casually convert snake_case request fields to camelCase.
- Preserve optimistic concurrency semantics (`expected_version`) and idempotency keys.
- Keep validation strict for control-plane and code-delivery requests.
- A model-produced string is not an authorization token or a human decision. Actor identity is assigned by the server.
- Never infer production availability from route registration alone.
