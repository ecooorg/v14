# 8. Deployment and Runbook

## 8.1 Runtime prerequisites

- Node.js `>=22.12 <23`; repository `.nvmrc` specifies `22.12.0`.
- npm compatible with the lockfile. Install with `npm ci` in a network-enabled environment.
- PostgreSQL 16 for CI; Project Mode requires a reachable PostgreSQL service.
- Gemini API key for model-backed conversation; optional Groq/search/Drive/GitHub configuration only when enabling those capabilities.
- Production secrets must be stored in the deployment provider's secret/environment system.

## 8.2 Local setup

```bash
nvm use
npm ci
cp .env.example .env
# Edit .env locally; never commit it.
npm run dev
```

`npm run dev` uses `tsx server.ts`. The exact frontend/backend development proxy is in `vite.config.ts`. Do not use placeholder `.env.example` credentials for a public deployment.

## 8.3 Build and checks

```bash
npm run check
npm run build
```

`npm run check` is an extensive sequential gate containing version/docs checks, copy lint, TypeScript typecheck and many focused/acceptance/regression tests, including database contracts, State/task/queue/gate, security/injection/redaction, Workspace, Drive, GitHub, delivery and P56 feature guard. The exact authoritative command list is the `check` script in `package.json`; `scripts/run-independent-checks.mjs` is used in CI to run stages independently so one failure does not hide later failures.

CI (`.github/workflows/ci.yml`) installs dependencies, applies migrations against PostgreSQL 16, runs independent checks, live database tests, Project Mode API security tests, builds the app and runs Gitleaks. CI workflow success must be read from the actual workflow run; it is not established by the archive.

## 8.4 Project Mode startup contract

Before setting `ENABLE_PROJECT_MODE=true`, configure non-empty `APP_PASSWORD`, `SESSION_SECRET`, `DATABASE_URL` and ensure `ENABLE_APP_AUTH` is not `false`. Use a strong random password and at least 16 random characters for the session secret (the project connection guide sets that minimum). Configure `PGSSLMODE` according to the environment; production examples use `require`, local CI sets `disable`.

If `DATABASE_URL` is set, `npm start` runs `npm run db:migrate` before starting `dist-server/server.js`. Do not assume migrations ran successfully unless startup logs and `schema_migrations` confirm it.

## 8.5 Deploy sequence (owner-controlled)

1. Confirm the intended commit and version (current archive version 55).
2. Review changes and ensure no secrets are included.
3. Run `npm ci`, `npm run check`, `npm run build` in a supported environment.
4. In CI, verify migration, live DB contract, API security, build and secret-scan stages.
5. Confirm the GitHub App is read-only in production unless a separately approved write scope is required.
6. Deploy to the intended Railway environment using owner-authorized workflow; do not infer deployment authority from this document.
7. Check `/health`, `/ready`, sign-in and a short Simple conversation.
8. Run manual acceptance scenarios (Simple factual, research/numbers, Expert dialogue, Project analysis/delivery, Drive save, optional Groq on/off).
9. Verify operational logs/metrics, DB migration inventory, backup configuration and rollback path.
10. Record evidence with commit SHA, timestamp, environment (no secrets), commands, results and reviewer.

The source `docs/STATUS.md` on the snapshot says CI confirmation, deployment of v55, smoke and MANUAL1 were owner next steps. This audit did not verify that they subsequently occurred.

## 8.6 Rollback

Application rollback is redeploying the previous known-good build/commit; database rollback is a separate operation. Preserve expand/contract compatibility. Do not reverse migrations casually in production. If a deployment breaks readiness, capture sanitized diagnostics, stop further changes, and use the owner-approved rollback procedure.

## 8.7 Backup and restore

ADR-09 target: daily backup, 7-day retention, RPO ≤24h and RTO ≤4h. These are targets, not confirmed provider facts. A restore drill is required on a disposable database: restore backup, migrate if necessary, confirm expected `schema_migrations`, `/ready`, sign-in and Simple smoke. `npm run ops:backup-check` is not a restore drill.

## 8.8 Operational variables

- Model/time: `LLM_CALL_TIMEOUT_MS`, `LLM_TOTAL_DEADLINE_MS`, `MAX_MODEL_CALLS`.
- Latency policy (P57): `QUALITY_RETRY_MAX_ELAPSED_MS`, `EPISTEMIC_TIMEOUT_MS`, `OLDER_ASSISTANT_MAX_CHARS` (see `server/latencyPolicy.ts`). The log line `conversation_timing` shows where each turn spent its time.
- Request/file limits: `MAX_BODY_BYTES`, `MAX_UPLOAD_BYTES`, `MAX_ATTACH_TEXT_CHARS`, `EXPERT_ATTACH_TOTAL_CHARS`.
- Usage limits: `DAILY_CALL_CAP`, `RATE_LIMIT_PER_HOUR`, `PROJECT_RATE_LIMIT_PER_MINUTE`, `PG_POOL_MAX`.
- Worker: `WORKER_LEASE_MS`, `WORKER_HEARTBEAT_MS`, `WORKER_POLL_MS`; validate heartbeat ≤ half lease.
- Search: `ENABLE_WEB_SEARCH`, `WEB_SEARCH_PROVIDER`, `WEB_SEARCH_TIMEOUT_MS`, `WEB_SEARCH_MAX_PAGES`, `WEB_SEARCH_MAX_QUERIES`, `WEB_SEARCH_FETCH_PAGES`.
- Delivery: `CODE_EXECUTOR=manual|model_patch`, `GITHUB_DIFF_UPLOAD=true` only by separate owner decision.

## 8.9 Current environment test limitation

In the audit environment, `npm ci --offline` failed because `zod` was not in the npm cache. Therefore no complete build, typecheck, Project API run, PostgreSQL migration run, or full `npm run check` is claimed. See document 09 for executed commands and statuses.
