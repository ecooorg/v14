# 9. Testing and Equivalence

## 9.1 Evidence context

Audit date: 2026-10-19. Source archive SHA-256: `d0ac5d3dc9052aced2454bd7d1c7905af5af0825a85116eb33fe9938e37be396`. Node.js observed: `v22.16.0`; npm observed: `10.9.2`. The archive contains 100 `tests/*.mjs` files, 14 SQL migrations and a comprehensive `npm run check` chain. A complete dependency installation was blocked: the initial `npm ci` attempt did not complete in the available execution window, and the explicit offline retry returned `ENOTCACHED` for `zod`. The `npm run check` chain passed version/docs/version-test/copy-lint then stopped at TypeScript with missing `vite/client` type definitions. The outcomes below distinguish commands actually executed from tests not run.

## 9.2 Executed check results

| Command | Status | Exit | Evidence / reason |
|---|---|---:|---|
| `node scripts/check-version.mjs` | **PASS** | `0` | Version check OK: 55 |
| `node scripts/check-docs.mjs` | **PASS** | `0` | check:docs OK (123 Markdown files, 420 backticked paths checked) |
| `node scripts/lint-copy.mjs` | **PASS** | `0` | lint:copy OK |
| `node tests/version-check.test.mjs` | **PASS** | `0` | version-check tests passed |
| `node tests/package-c.test.mjs` | **PASS** | `0` | package C static checks passed |
| `node --experimental-strip-types --test tests/p56-feature-guard.test.mjs` | **PASS** | `0` | 7 tests passed, 0 failed |
| `node --experimental-strip-types --test tests/gate-engine.test.mjs` | **PASS** | `0` | 7 tests passed, 0 failed |
| `node --experimental-strip-types --test tests/p48-epistemic.test.mjs` | **PASS** | `0` | 8 tests passed, 0 failed |
| `node --experimental-strip-types --test tests/code-executor.test.mjs` | **BLOCKED** | `1` | ERR_MODULE_NOT_FOUND: zod; dependency installation incomplete |
| `npm ci --offline --ignore-scripts --no-audit --no-fund` | **BLOCKED** | `1` | ENOTCACHED: zod package unavailable in local npm cache |
| `npm run typecheck (via npm run check)` | **BLOCKED** | `2` | TypeScript starts but cannot find type definition vite/client because dependencies are incomplete |
| `npm run build` | **NOT_RUN** | `—` | Cannot run: dependency installation incomplete |
| `npm run check` | **BLOCKED** | `2` | Version/docs/version-test/copy-lint pass; chain stops at typecheck with missing vite/client definitions |
| `PostgreSQL live tests` | **NOT_RUN** | `—` | No configured DATABASE_URL / test PostgreSQL service in this environment |
| `Google/Groq/GitHub/Railway live acceptance` | **NOT_RUN** | `—` | No production credentials or live service evidence available |
| `node --test tests/p41-ui1.test.mjs` | **PASS** | `0` | 7 tests passed, 0 failed |
| `node --test tests/p43-rm-c3.test.mjs` | **PASS** | `0` | 6 tests passed, 0 failed |
| `node --experimental-strip-types --test tests/p55-test-round1.test.mjs` | **PASS** | `0` | 15 tests passed, 0 failed |
| `node --experimental-strip-types --test tests/p50-web-search.test.mjs` | **PASS** | `0` | 21 tests passed, 0 failed |
| `node --experimental-strip-types --test tests/redact.test.mjs` | **PASS** | `0` | 5 tests passed, 0 failed |
| `node --experimental-strip-types --test tests/injection-corpus.test.mjs` | **PASS** | `0` | 4 tests passed, 0 failed |
| `node --experimental-strip-types --test tests/reasoning.test.mjs` | **PASS** | `0` | 1 test passed, 0 failed |
| `node --experimental-strip-types --test tests/driveMerge.test.mjs` | **PASS** | `0` | 1 test passed, 0 failed |
| `node --experimental-strip-types --test tests/export-name.test.mjs` | **PASS** | `0` | 1 test passed, 0 failed |
| `node --experimental-strip-types --test tests/p53-project-scope.test.mjs` | **BLOCKED** | `1` | ERR_MODULE_NOT_FOUND: zod; dependency installation incomplete |
| `node --experimental-strip-types --test tests/p54-project-delivery.test.mjs` | **BLOCKED** | `1` | 13 passed; 1 React render test blocked because react package is missing |
| `node --experimental-strip-types --test tests/security.test.mjs` | **BLOCKED** | `1` | Node strip-only mode cannot compile TypeScript parameter properties; project tsx runner unavailable |

**Interpretation:** 83 individual assertions/test cases passed across the selected executable Node test files (excluding non-TAP static scripts); the Project Delivery suite additionally had 13 passing cases and one React render case blocked by missing dependencies. These passes establish only the specific static/pure-function checks they cover. Dependency-related failures are **BLOCKED**, not product assertion failures. A full build/check status remains unknown.

## 9.3 Existing test strategy

The test tree includes: core/reasoning; version consistency; UI check; Project API/contracts; DB migration/live DB; State/context pipeline; task/queue/gates; budgets/approvals; provider model layer and conformance; injection corpus/redaction/security; Workspace path/ingest/ChangeSet/export; Google Drive sync/merge/mirror/docs; GitHub integration/delivery; code executor/task delivery/review/repair; acceptance tests for P08–P56; legacy/regression tests; and stage 2.

The `check` script in `package.json` is the current source of truth for test-chain composition. P56 adds a guard that every test file is covered by an npm script, scripts are included in the check chain or separate CI step, all manifest routes/modules/screens remain present, and route/module additions/removals are reviewed. The P56 feature guard passed 7/7 here.

## 9.4 Required test layers for a reproducible rebuild

1. **Static:** docs/path checks, copy lint, typecheck, source lint/secret scan.
2. **Pure unit:** State patch policy, optimistic concurrency helper logic, task/run/job/gate machines, budget calculations, provider error classification, path/diff validators, prompt intent flags.
3. **Service/contract:** repository and service behaviour against isolated PostgreSQL; idempotency, concurrency, migrations, artifacts, ledger, approvals, audit.
4. **API/security:** session cookie, Origin handling, login throttling, server-derived actor, rate limits, request-size limits, route authorization, GitHub webhook signature, redaction and injection corpus.
5. **Frontend/browser:** mode selection, mode persistence, attachments, Workspace archive safety, ChangeSet confirmation, exports, Drive status and Project Delivery.
6. **Provider integration:** controlled fake provider tests plus explicit live smoke with secrets held in environment; model output/schema, timeout, quota, auth and fail-soft verifier/search.
7. **Operational:** clean migration, build, health/readiness, backup restore, rollback and capacity checks.
8. **Human acceptance:** owner-run Simple/Expert/Project workflows, Drive save, Project delivery and real GitHub App permission review.

## 9.5 Equivalence oracle

A second implementation is equivalent when it preserves observable contracts and invariants, not identical prose. Use a fixed acceptance corpus with: request, selected mode, relevant state/files, expected route/contract, safety constraints, allowed output variation, expected state transition, evidence requirements and failure behaviour.

Minimum invariant suite:

- Mode selection is explicit; no automatic switch.
- A factual Simple query does not become a decision session absent decision intent.
- Optional verifier/search failures do not hard-fail the primary conversation.
- State model proposals cannot write decisions, system IDs, author, source or review statuses; invalid patch is atomic.
- Concurrent stale State updates conflict rather than overwrite.
- Task PASS requires validation and evidence; a successful Run only advances to VALIDATING.
- No gate PASS without valid evidence for the same commit and rules version.
- Budget is checked before model calls; a budget stop blocks for human review.
- Unsafe file paths/archives are rejected; extracted content is never executed.
- ZIP/code patch respects allowlists, protected paths, file/line/byte caps and secret rules.
- GitHub writes remain off by default, merge never automated, `main` protected.
- Secrets never appear in API response, browser bundle, logs or generated package.
- Drive success/failure is visible and merge conflicts are not silently discarded.

## 9.6 Manual acceptance (MANUAL1)

MANUAL1 remains an explicit release gate in the snapshot's `docs/STATUS.md`. Minimum evidence should include: (a) Simple plain factual answer; (b) Simple current research/numbers with search on and off, without false claims of searching; (c) Expert structured analysis and open dialogue preserving mode; (d) Project create/State proposal/human review/version conflict; (e) plan/approval/task/gate path; (f) generated ZIP and manual delivery/reviewer/human decision; (g) Drive save in each mode with visible result; (h) Groq verifier enabled and absent/failing; (i) sign-in/readiness and rollback/backup evidence. Record provider/model and relevant configuration by names only, never secret values.

## 9.7 Release evidence record template

For each test, record: test ID; commit SHA; application version; environment type; command or human steps; start/end time; status (`PASS`, `FAIL`, `BLOCKED`, `NOT_RUN`, `REAL_ONLY`, `WAIVED`); logs/artifact links; redacted failure summary; actor/reviewer; waiver reason if applicable. Never infer PASS from missing logs.
