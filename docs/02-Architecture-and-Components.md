# 2. Architecture and Components

## 2.1 Runtime topology

```text
Browser (React 19 + Vite)
  ├─ Simple / Expert conversation UI
  ├─ Project Mode UI and Delivery tab
  ├─ Workspace (browser-side file intake / archive extraction / change sets)
  ├─ browser storage and Google Drive integration
  └─ HTTP requests to Express
          │
          ▼
Node.js 22 / Express server (`server.ts`)
  ├─ authentication, session, rate/body limits, CSRF-origin checks
  ├─ conversation + prompt/mode logic ── Gemini adapter ── Gemini API
  │                                  ├─ optional Groq-compatible verifier
  │                                  └─ optional web search provider
  ├─ Project API routes / domain services
  │   ├─ Project repository + State validation/versioning/events
  │   ├─ analysis + bounded context builder
  │   ├─ plan/task/run/job/approval/budget services
  │   ├─ artifact storage, hash/manifest verification, usage ledger
  │   ├─ gate engine, reviewer, repair loop, code task package
  │   └─ GitHub integration (read-only default; writes feature-gated)
  └─ health/readiness/ops routes
          │
          ▼
PostgreSQL (Project Mode persistence; migrations 001–014)

External services: Google Gemini, optional Groq-compatible API, optional search provider, Google Drive OAuth/API, GitHub App/API, host deployment/runtime (e.g. Render or any Node host).
```

This diagram is a logical architecture inferred from source. It does not assert a particular production topology beyond the configuration documented in the repository.

## 2.2 Repository layers

| Layer | Responsibility | Main source files |
|---|---|---|
| Frontend shell | Mode selection, conversation, local settings/history, file UI | `src/App.tsx`, `src/main.tsx`, `src/ModeMenu.tsx` |
| Expert / Project screens | Structured Expert flow, Project State and Delivery | `src/ProjectMode.tsx`, `src/ProjectDelivery.tsx`, `src/UserGuide.tsx` |
| Workspace | Path safety, archive intake, extraction, classification, context, ChangeSet, export | `src/workspace/*`, `src/WorkspacePanel.tsx`, `src/WorkspaceChangeSetCard.tsx` |
| Browser persistence and Drive | Local storage, autosave, Drive mirroring/sync/merge/export | `src/storage.ts`, `src/autosave.ts`, `src/driveClient.ts`, `src/driveSync.ts`, `src/driveMerge.ts`, `src/useDrive.ts` |
| HTTP/API bootstrap | Middleware, routes, mode prompt orchestration, provider wiring | `server.ts` |
| Contracts and policy | Zod contracts, errors, State patch validation, security helpers | `server/contracts.ts`, `server/statePipeline.ts`, `server/security.ts` |
| Model adapters | Normalized provider request/response, Gemini and OpenAI-compatible adapters | `server/adapter.ts`, `server/geminiAdapter.ts`, `server/openaiCompatAdapter.ts` |
| Project domain | Persistence, analysis, plans/tasks/queue/approvals/budgets | `server/projectRepository.ts`, `server/stateService.ts`, `server/analysisService.ts`, `server/planService.ts`, `server/taskService.ts`, `server/queueService.ts`, `server/worker.ts` |
| Artifacts and evidence | Content metadata, SHA-256, manifest, integrity, ledger, gates | `server/artifactFormat.ts`, `server/artifactRepository.ts`, `server/ledger.ts`, `server/gateEngine.ts`, `server/gateService.ts` |
| Code delivery | Task package, diff/source validation, review, repair and GitHub result handling | `server/codeExecutor.ts`, `server/codeTaskService.ts`, `server/briefWriter.ts`, `server/reviewer.ts`, `server/repairLoop.ts`, `server/githubIntegration.ts` |
| Operations | health, readiness, ops metrics, migration/backup/check scripts | `server/healthRoutes.ts`, `server/opsMetrics.ts`, `scripts/*`, `.github/workflows/*` |

## 2.3 Startup and feature boundaries

- Node version requirement is `>=22.12 <23` (`package.json`); `.nvmrc` specifies `22.12.0`.
- `npm run dev` invokes `tsx server.ts`. `npm run build` builds the Vite client and compiles the server. `npm start` applies migrations if `DATABASE_URL` exists.
- When `ENABLE_PROJECT_MODE=true`, the start command requires non-empty `APP_PASSWORD`, `SESSION_SECRET`, and `DATABASE_URL`, and requires `ENABLE_APP_AUTH` not be `false`.
- Project Mode functionality is therefore not a valid no-database deployment mode. `/ready` reports not ready if a database is not configured or reachable.
- `CODE_EXECUTOR` defaults to `manual`; `model_patch` enables source ZIP generation, not server execution and not GitHub write.
- `ENABLE_WEB_SEARCH` is an opt-in capability; default is off.

## 2.4 Data flow: Project analysis

1. Browser submits a project analysis request with project ID, expected State version, task text and optional artifact IDs.
2. Server validates request shape and requires a configured Gemini adapter.
3. Analysis service loads current project State and referenced artifact context.
4. Context builder selects relevant State sections and bounded artifact excerpts under a token budget; chat history is omitted unless explicitly justified and labelled.
5. The model returns a structured JSON analysis and State patch proposal.
6. State patch schema and actor policy validate the proposal. System-owned metadata/IDs are assigned server-side; model cannot make decisions or set review statuses.
7. State update uses optimistic versioning; conflicts are surfaced rather than silently overwriting. Events/versions and usage evidence are persisted through domain services.

Sources: `server.ts`, `server/analysisService.ts`, `server/contextBuilder.ts`, `server/statePipeline.ts`, `server/stateService.ts`.

## 2.5 Data flow: task execution

Task lifecycle is separate from the job queue and run lifecycle. A task is validated, queued with idempotency information, represented by a Run and Job, claimed under a lease, processed by a worker handler, and then validated against evidence. A successful Run only moves the Task to `VALIDATING`; it never directly makes the Task `PASS`. Budget exhaustion blocks the task pending human intervention. The worker library exists, but `server/worker.ts` comments that it is not started from `server.ts` in the current release. Do not claim background processing is active in production without separate deployment/runtime evidence.

Sources: `server/taskMachine.ts`, `server/queueMachine.ts`, `server/queueService.ts`, `server/worker.ts`, `docs/SPEC_COVERAGE_AUDIT.md`.

## 2.6 Source-level architectural constraints

- Domain state transitions should be pure/testable and services own persistence.
- Provider-specific request details are isolated behind adapters.
- Project State is a versioned JSON document plus typed `items`; schema compatibility permits older State without a Passport.
- The model registry is in code, not a database registry in this release; see open decision F-04.
- The deterministic router is a distinct module and explicitly says it is not wired to Simple Mode. Do not treat its presence as proof of cascade behaviour in the conversation path.
- Project archive ingestion on the server is missing despite accepted ADR-12; browser Workspace is the actual implementation.
