# 13. Evidence-Led Implementation Roadmap

This roadmap separates release closure from feature work. It is based on the v55 archive's current status and coverage audit; it does not authorize code changes. Execute each stage only after the owner approves the scope.

## Stage 0 — Establish a reproducible baseline (release blocker)

**Goal:** know which source revision is being reproduced and prove that the repository builds.

Tasks:
1. Use a network-enabled environment with Node 22.12+ and run `npm ci`.
2. Run `npm run check`, `npm run build`, clean PostgreSQL migration and `npm run test:database:live`.
3. Capture full logs, exact commit SHA, Node/npm versions and status for each stage.
4. Inspect the real CI run and ensure Gitleaks, DB, API-security and build stages are green.

Exit criteria: clean dependency install, all required automated stages pass, migration inventory matches, build output exists.

## Stage 1 — Owner-side release acceptance (MANUAL1)

**Goal:** validate real behaviour and permissions that source tests cannot prove.

Tasks: deploy the intended v55 commit only after CI; run `/health` and `/ready`; execute Simple plain factual, research/numbers with search enabled/disabled, Expert dialogue, Project analysis/State proposals, Project ZIP/manual delivery, Drive save in each mode, and verifier enabled/absent/failing. Verify GitHub App actual read-only permissions, provider data policies and secret handling. Record evidence.

Exit criteria: signed MANUAL1 record, no critical safety/security regression, rollback path known.

## Stage 2 — Resolve release gaps by owner decision

### 2A. Project Workspace parity (ADR-12)

Decision: implement secure server-side Project archive ingestion in a worker thread or formally amend ADR-12 to state browser-only Workspace as intended. If implemented, require actual-byte counters, entry and compression limits, path normalisation, timeout/memory controls, concurrency semaphore 1–2, no execution, and tests for traversal/archive bombs. Add Project artifact upload/download routes only with explicit size/security/storage contract.

Exit criteria: decision recorded; if implementing, acceptance tests cover valid archive, traversal, absolute/drive/UNC paths, symlinks, compressed bomb, actual byte limits, timeout, worker crash and concurrent ingest.

### 2B. `/ops` metrics (candidate P57)

Expose only operationally useful, redacted aggregates already supported by the usage ledger: calls, token counts, latency, fallback share, executor runs, integrity errors, State conflicts and retries. Protect access and test no prompt/file/secret leakage.

Exit criteria: metrics reconcile against ledger fixtures; sensitive payloads are not returned.

### 2C. Registry/config drift and import

Owner decides whether to persist model registry and whether Simple-to-Project import is a product requirement. Avoid implementing merely because schema or docs mention the feature.

## Stage 3 — Deferred integrations (only after MANUAL1)

- Provider cascade expansion (P49): run comparative evidence first; preserve cost/data policy, quality class, quota/cooldown, call budget and fail-soft behaviour.
- GitHub write/PR/repository creation: separate owner decision, named test repository, minimum permissions, protected `main`, verify writes are branch-bounded, never merge/deploy automatically.
- Time-based ledger cleanup, OCR for scanned PDFs, audio/video, Project budget editor, State version UI, operations navigation, more plan templates.

Exit criteria: each item has a SPEC, threat review, acceptance tests and explicit owner authorization.

## Stage 4 — Documentation adoption and legacy retirement

Adopt this package through a documentation-only patch. Make the English index authoritative only after owner resolves conflict with the current Russian canonical-TZ rule. Update CI docs checks and all key pointers. Archive patch SPEC/REPORT history off-repository with an immutable archive and index.

Exit criteria: no broken doc links, one active roadmap pointer, ADRs preserved, all claims linked to source/tests, `npm run check:docs` passes.

## Sequencing rule

Do not combine a release verification stage with unrelated feature development. Do not mark a stage complete without recorded evidence. A missing test result is `NOT_RUN`, not PASS. A decision needed from the owner remains a blocker rather than an invented implementation detail.
