# 7. Security, Privacy and Operations

## 7.1 Security objectives

Protect provider/GitHub credentials, sessions, Project State/artifacts, audit trail, model/provider policy, budgets and production configuration. Main adversary paths identified in `docs/THREAT_MODEL.md` are prompt injection through user files/PRs/CI logs, credential exposure, forged actor identity/CSRF, budget/approval bypass, unsafe model activation, and supply-chain compromise.

## 7.2 Authentication and browser request protections

- Shared-password sign-in uses `APP_PASSWORD`; session token is signed with HMAC-SHA256 using `SESSION_SECRET`, cookie name `be_session`. Cookie is HttpOnly, SameSite=Lax, Path=/, includes Max-Age and `Secure` in secure deployments.
- `ENABLE_APP_AUTH` controls app auth; Project Mode startup explicitly requires auth not be disabled.
- Login failures are limited by an in-memory limiter (default 10 failures per 15 minutes, configurable through `LOGIN_MAX_FAILS` and `LOGIN_WINDOW_MIN`). Source also uses database rate-limit storage in Project Mode.
- State-changing browser requests are checked for same origin. Missing Origin is intentionally treated as a non-browser/server-to-server request for CLI/health-harness compatibility; therefore Origin checking is not by itself a complete CSRF model.
- Configure `TRUST_PROXY_HOPS` correctly behind a reverse proxy; never trust arbitrary client-supplied identity fields.

Sources: `server/security.ts`, `server.ts` login/session middleware, `.env.example`, `tests/security.test.mjs`.

## 7.3 Human authority and capability boundaries

Human-only actions include decisions, approvals, budget increases, destructive operations, gate waivers, code task accept/repair/reject decisions, access control and deployment changes. Actor kind is derived by server routes, not trusted from request bodies. A model output may propose an operation but is not itself authorization.

GitHub policy: read-only by default; no merge or admin permission; no secrets or workflow write; any approved write is limited to explicitly permitted `biforge/*` branches and never `main`. `CODE_EXECUTOR=model_patch` means source ZIP generation only and does not switch GitHub writes on. `GITHUB_DIFF_UPLOAD=true` is the single documented write switch; the production default is off. Actual installed App permissions are **NOT RUN** in this archive audit.

## 7.4 Secrets and logging

- Secrets are only in approved environment/secret stores; never commit, bundle into browser code, store in State/artifacts, or send to code executors.
- `.env.example` contains placeholders and variable names, not deployable credentials.
- Use `server/redact.ts` before logging untrusted text; do not log full prompts or private files by default.
- Gitleaks runs in CI. Static redaction/injection tests exist. Live production logs and secret leakage were not inspected.
- Do not paste credential values into this documentation or generated evidence.

## 7.5 Untrusted data and file safety

Uploaded files, archives, extracted contents, webpages, repositories, PR comments, CI logs and generated artifacts are data, not instructions. Validate all external input with schemas and size limits; use parameterized SQL; never execute extracted files. Archive safety uses normalised paths, rejects traversal/absolute/drive/UNC patterns, and must use actual decompressed-byte counters rather than trusting archive headers.

Browser Workspace uses a Web Worker; Project server-side unpacking was accepted in ADR-12 but is not implemented. Do not silently describe the future worker as current behaviour.

## 7.6 Data policy and model selection

Projects carry sensitivity (`normal|high`) in code/task package contracts. High-sensitivity work must use paid/self-hosted data policy, and sending code/Task Packages to an external provider requires separate approval. Free provider plans are for synthetic data/tests only per the existing policy. Models should only be activated after connection verification; the policy requires verification freshness within 90 days. The runtime model registry is code-defined in this release.

## 7.7 Operational endpoints

- `/health`: liveness/version/commit; in production can return 503 `DIST_MISSING` if built client assets are absent.
- `/ready`: readiness; returns 503 when database is not configured/unavailable.
- `/api/health`: basic public health; authenticated callers may see model/key/auth configuration metadata.
- `/api/ops` and `/ops`: diagnostics; the exact access/fields are in `server.ts`. The audit states metrics are incomplete versus the usage ledger. Do not expose this endpoint without verifying auth and data minimisation.

## 7.8 Backup and incident handling

ADR-09 targets daily PostgreSQL backups with 7-day retention, RPO ≤24 hours and RTO ≤4 hours, but explicitly says live configuration and restore performance must be verified. `npm run ops:backup-check` checks migration inventory and does not perform a full restore. A real restore drill must restore to a disposable database, run migrations if needed, check schema version and `/ready`, then run a signed-in Simple smoke.

If a potential secret leak occurs: stop propagation, do not reproduce the value in logs/docs, identify file/location, rotate affected credentials through the owner, verify logs/artifacts/client bundles, and record a sanitized incident report.

## 7.9 Security evidence status

Static controls and source-level tests exist, but this archive review did not execute the full security suite because dependencies were unavailable. No live penetration test, GitHub App rights verification, production log inspection, provider privacy-contract check or Railway access audit was performed. Those items remain NOT RUN.
