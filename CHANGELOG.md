## P56 — Regression guard and test hygiene (2026-10-18)

- No product change. All test files now run in CI; a guard test fails when a route, module, control or check disappears.
- Documents synchronised; spec coverage audit added.

## P55 — First test round: Drive, Decision brief, More menu (2026-10-18)

- Google Drive: files from every mode go to BiForge / Simple | Expert | Project; every save or refusal is shown; files attached before Connect are saved after it.
- Project: Drive buttons (connect, save all, save file, save ZIP).
- «Decision brief» is readable text in a proper dialog.
- The More menu is closed by default at every width.

## P54 — Project Delivery tab: gates and manual Code Delivery (2026-10-17)

- New tab **Delivery**: hand-off task, package, result, checks, review, decision, repair, close. GitHub stays read-only.
- New `POST /api/projects/:projectId/code/manual`, `GET /api/projects/:projectId/code`; `expectedBranch` on code tasks.

## P53 — Project scope «analysis + ZIP», GitHub read-only (2026-10-17)

- `CODE_EXECUTOR=model_patch` no longer implies GitHub write; `GITHUB_DIFF_UPLOAD=true` is the only write switch.
- `/api/session` reports capability booleans to a signed-in person; the Project page shows what is available on this server.
- ADR-06 Amendment 1.

## P47 — Mode controls only in More menu (2026-10-15)

- Removed top-level **Expert method / Simple chat** and **Modes** header buttons.
- Mode changes only via **More**: Mode selection (three cards), Switch to Expert/Simple, Project workspace.

## P46 — Return to mode cards from Simple/Expert (2026-10-15)

- Header **Modes** button (and More → Change mode) clears `biforge-start-mode` and shows the three-card start screen again.
- Stale `Project` session on `/` no longer skips the start screen.
- Project workspace «Back» links clear session and go to mode selection (symmetric with chat).

## P45 — UI1 start screen on prod + ui-check (2026-10-15)

- Confirmed production bundle lacked `chooseStartMode` / start cards; ship `src/App.tsx` with explicit Simple / Expert / Project start screen after sign-in.
- More menu: **Change mode** returns to the start screen (clears session selection).
- `tests/ui-check.mjs`: click Simple on the mode start screen before waiting for `.header-actions` (fixes ui-check red).

## P44 — CI hotfix for P42/P43 (2026-10-15)

- `docs/REPO_MAP.md`: describe `tests/qa1.test.mjs`, `tests/p43-rm-c3.test.mjs`, `test:qa1`, `test:p43`.
- `tests/p41-ui1.test.mjs`: keep UI1 → QA1 → MANUAL1 marker order requirements with clearer asserts.
- `package.json`: `test:qa1` uses `node --import tsx --test` so TypeScript server modules load in CI.
- `docs/STATUS.md`: restore `**UI1**` marker ahead of `**QA1**` / `**MANUAL1**`.

## P43 — RM-C3 close: authorize `model_patch` (2026-10-15)

- Owner command closed checklist **RM-C3**: `CODE_EXECUTOR=model_patch` authorized after accepted ADR-10 / E-01.
- Process/docs only: STATUS, OWNER_OPS, DELEGATION, `.env.example` updated; runtime still requires the environment variable.
- GitHub App write permissions and `GITHUB_DIFF_UPLOAD` remain deferred (ADR-06).
- Regression: `tests/p43-rm-c3.test.mjs`.

## P42 — QA1 cross-mode automated checks (2026-10-15)

- Added offline QA1 suite (`tests/qa1.test.mjs`) covering Simple classification and soft-fail, Expert/Project instruction isolation, UI start cards, shared honesty core, triage wiring and integrity of prior mode regressions.
- Wired `npm run test:qa1` into package scripts; product runtime behaviour unchanged.
- STATUS next gate advanced to MANUAL1 after offline QA1.

## P40 — Mandatory patch delivery contract (2026-10-15)

- Documented `bf-PNN.zip` as the required primary artifact; `.patch`/`.diff` cannot substitute for the ZIP.
- Required independent archive read-back/content verification and explicit `DELIVERY BLOCKED` when a verified ZIP cannot be produced.
- `patch:pack` now defaults to `bf-PNN.zip`; added a regression guard for the contract. Process-only; product behavior/version unchanged.

# P39 — file-work security

- TAR ingestion now keeps the first occurrence of an exact duplicate path and reports later duplicates as skipped.

## P38 — Workspace export UI (2026-10-15)

- Workspace card: Download all (.zip), Changes only, Text diff (when version ≥ 2).
- Uses existing `exportWorkspace` (byte-identical full export).
- `test:p38`; product version 39.

## DOC1 — STATUS hub (2026-10-15)

- Added `docs/STATUS.md` as the only day-to-day progress file (where we are, next, owner blockers, open questions).
- `START_HERE`, `CURRENT_STATE`, `NEXT` reduced to pointers; AGENTS / PATCH_TEMPLATE / DEVELOPMENT_PROTOCOL require STATUS updates each patch.
- No product version bump (docs-only hygiene).

## P37 — Unified Workspace attach (2026-10-15)

- One primary **Attach** button: a single zip/tar is unpacked into the workspace tree; other files are stored as entries. Optional Folder on desktop.
- Composer drag-and-drop / `be:attach-files` routes into the same workspace (agent-visible place after privacy ack).
- Clearer status copy: file count and “say what to do in your message”.
- Product version 37. Export remains the next planned capability (P38 in the file-work plan).

## P36 — Workspace ChangeSet UI (2026-10-15)

- Human confirmation card for agent ChangeSet: unified diff, Apply / Reject / Rollback.
- Version never advances until Apply; validate re-checks baseSha256; rollback commits a new version.
- `parseChangeSetFromText` extracts ChangeSet from agent JSON fences; App surfaces it to WorkspacePanel.
- Docs: parallel TZ rules + “later green CI closes earlier gates” in `docs/BiForge_TZ_P26.md` §15.
- `npm run test:p36`; product version 36.

## P35 — Universal File Analysis (2026-10-15)

- Shared `FileContentExtractor` (`src/workspace/extract.ts`): PDF via `unpdf`, DOCX/XLSX/PPTX via `jszip`+XML, CSV/TSV/JSON/text via pure JS. No new npm dependencies.
- Office zip packages classified as `office` by extension. `readWorkspaceFile` / WorkspacePanel attachments use extracted text with DATA markers (D-07); images and undecodable binaries stay metadata-only.
- Secrets remain excluded without explicit approval; original blobs are never mutated.
- `npm run test:p35`; product version 35.

## P34 — Universal Workspace MVP (2026-10-15)

- WorkspacePanel is available in the shared Simple/Expert application surface and supports individual/multiple files in addition to archives and folders.
- After explicit privacy acknowledgement, bounded readable text and safe metadata are attached to agent requests; secret-flagged files are excluded. Unsupported binary formats remain preserved but are not claimed to be decoded.
- Fixed Workspace persistence to accept content-addressed SHA-256 blobs produced by ingest; added P34 ingest/persistence/byte-integrity tests.
- Automated checks were NOT RUN: dependency installation timed out in the patch environment. CI must run `npm run test:p27`, `npm run test:p34`, `npm run check`, and `npm run build`.

# Changelog

## MP2 completion — light Simple/information prompt (2026-10-14)

- `buildSimpleConversationPrompt` takes the detected conversation mode. `information` now gets a light prompt (shared core, light method, boundaries, unavailable-answer contract, files/documents rules, compact crisis triage, JSON keys with optional scaffold fields) instead of the full decision method. Simple prompt for `information`: 28 668 → 12 413 chars on the same input.
- `decision`, `research`, `engineering` and an omitted mode keep the previous prompt text unchanged (verified against a pre-change snapshot). Expert and Project instructions untouched.
- `server.ts` passes the detected mode to the prompt builder. The information mode paragraph no longer mentions the removed rituals.
- New `tests/mp2.test.mjs` (`npm run test:mp2`, part of `npm run check`). Product version label stays 24.

## Mode initiative — master implementation plan (2026-10-14)

- Added `docs/MASTER_IMPLEMENTATION_PLAN.md` as the single active sequence for the Simple / Expert / Project mode initiative.
- Recorded owner-approved mode definitions, shared-core architecture, MP1–MP3, explicit start-screen mode selection, integrated automated QA and manual acceptance.
- Updated `docs/CURRENT_STATE.md`, `docs/NEXT.md`, `docs/START_HERE.md`, `docs/REPO_MAP.md`, and `AGENTS.md` to point to the plan. Marked the earlier PI-03 SPEC and uncertainty concept as historical for active planning.
- Documentation only: no runtime code, UI, prompt, model or test behaviour changed. Coding requires a separate owner command.

## Docs — history off-repo + patch journal (2026-10-14)

- `docs/HISTORY_OFFREPO.md`: full path list for owner local archive (ARCHIVE/CONCEPTS bulk + optional CHANGELOG_AGENT_BEHAVIOR).
- `docs/PATCH_JOURNAL.md`: short newest-first agent patch log.
- `ARCHIVE/README.md`, `CONCEPTS/README.md`: stubs after bulk leaves GitHub.
- `AGENTS.md` / `START_HERE.md`: no extra md files; one SPEC + one REPORT per patch.

## Docs — OWNER_OPS bookmarks (2026-10-14)

- Added `docs/OWNER_OPS.md`: single non-secret registry of prod URL, Railway project, GitHub App, deploy facts.
- Pointers from START_HERE, CURRENT_STATE, REPO_MAP, AGENTS.

## Docs — agent patches from P27 (2026-10-14)

- **Next agent patch** pointer in `docs/CURRENT_STATE.md` (current: **P27**).
- `docs/P27-SPEC.md`: Simple Mode workspace attach UI (~½ session scope).
- `docs/NEXT.md`: schedule **P27–P34+**; owner `RM-*` separated from agent patches.
- `docs/START_HERE.md`, `AGENTS.md`: “next patch” = pointer + SPEC only.
- Supersedes unfinished naming P26a.2 UI / P26b-UI (work moves to P27–P29).

## Docs — agent queue snapshot (2026-10-14)

- `docs/CURRENT_STATE.md` rewritten: done / partial / open gates for the next AI Assistant.
- `docs/NEXT.md`: **Unified queue** table (G4 + P26 in one order).
- `docs/START_HERE.md`, `AGENTS.md`: pointers to snapshot and queue; do not re-do closed P26a/P26b core.

## P26b — Workspace ChangeSet and export (2026-10-14)

- changeset.ts / exportZip.ts / diff.ts; test:p26b; docs P26b-SPEC/REPORT.

## P26a.2 — tar/folder ingest and workspace storage/context (2026-10-13)

- Added POSIX tar + gzip-tar reader (PAX/GNU long names), folder-ingest helper, IndexedDB store, privacy-gated WORKSPACE context, safe file reads/search and bounded model follow-up contract.
- Added `test:p26a2` to `npm run check`.
- AC-04 Simple/Expert UI + fake-Gemini end-to-end remains NOT_RUN; this slice provides the core helpers but does not yet wire them into the chat UI.

## P26a — Workspace zip ingest (2026-10-13)

- ADR-12: controlled server-side archive unpack in Project Mode only.
- New `src/workspace/` core: paths, classify, hash, zip ingest, memory store.
- `server/files.ts`: accept source/config extensions as text; fix zip path `..` check.
- Tests: `npm run test:p26a` (paths + ingest + bf-v24 fixture).

## Process tooling — 2026-10-13 (no product version change)

- **PA-05:** E-01 closed. `ARCHIVE/E01-NOTES.md`, `ARCHIVE/E01-RESULTS.json`. ADR-10 status → **Accepted** (TZ §11.9 PASS: 3/3 green first, 0 fixes, model ≤ manual human time). Owner: `ok ADR-10`. RM-B5 and RM-B6 closed; Stage C open on command. Product version unchanged (24).

## Process tooling — 2026-10-13 (no product version change)

- **PA-04:** E-01 lab runner template (`CONCEPTS/e01-task.yml`, `workflow_dispatch`, `GITHUB_TOKEN`), setup guide, `scripts/e01-notes-merge.mjs`, `tests/pa04-acceptance.test.mjs`. Navigator: Run workflow + one-line minutes; notes via Assistant patch.

## Process tooling — 2026-10-13 (no product version change)

- **P19x:** `model_patch` driver — `driveModelPatch` (code_author payload → `validateModelPatch` → `biforge/<task_id>` commit → PR). Still gated by `CODE_EXECUTOR=model_patch` and ADR-10. Tests: `tests/p19x-acceptance.test.mjs`.
- **PA-02:** E-01 harness (`scripts/e01-harness.mjs`) separate from the product (TZ 11.9); fixtures and `tests/pa02-acceptance.test.mjs`. Test GitHub repository approved for the experiment.

## Process tooling — 2026-10-13 (no product version change)

- PA-01: evidence workflow and gate evaluator (process tooling, no product change). `scripts/gate-eval.mjs`, `scripts/evidence-collect.mjs`, `.github/workflows/evidence.yml`, `tests/pa01-acceptance.test.mjs`. Delegation policy `docs/DELEGATION.md` accepted; `AGENTS.md` section 12.

## Documentation — 2026-10-13 (no product version change)

- TZ v3.0 (one 284 KB file) split into parts, no change of decisions or requirements: `docs/SPEC_PRODUCT.md`, `docs/SPEC_ENGINE.md`, `docs/SPEC_DEV_PROCESS.md`, `docs/SPEC_CONNECTIONS.md`; `docs/BiForge_TZ_v3.md` is now the index with a section → file map. Former section 16.7 became the flat checklist `docs/NEXT.md` (steps `RM-*`). History, Appendices C/F/G and the original monolith moved to `ARCHIVE/TZ_v3.0_*.md`. Section numbers are preserved.

## v24 — 2026-10-12

- **P24 (BX-25):** authenticated `/ops` and `/api/ops` metrics, `ops:backup-check`, ADR-09 (RPO/RTO), OPS_ROLLBACK procedure.

## v23 — 2026-10-12

- **P23 (BX-24):** security evidence — formal threat model, injection corpus CI assertions, redaction, rights review, audit completeness (login fail, project delete, settings change).
- Product version **23**.

## v15a — 2026-10-12

- **P15a (BX-27.a):** provider connection and quota monitoring (Appendix G S1–S2). Migration `014_provider_snapshots`, pure evaluators, CLI `monitor:connections`, weekly GitHub Actions workflow, ADR-11.
- Instruction track **PI-01 / PI-02 / PI-03final** recorded as complete in CURRENT_STATE.
- Security foundation for P23: `docs/THREAT_MODEL.md`, `docs/RIGHTS_REVIEW.md`, injection corpus fixtures, `server/redact.ts` + tests.

# Changelog
- PI-01: Simple Mode conversation prompt gets the uncertainty contract (TZ-INSTRUCTIONS-01 P1): best available result of a marked kind instead of a repeated limitation, no invented numbers, no claimed search. No schema or post-processing change; test `tests/pi01.test.mjs`. Product version label `PI-01`.
- P22: BX-23 Repair Loop — classify failure, at most two repair packages, stop on limit / identical diff / identical error / no progress / budget with a diagnostic artifact; one flaky CI restart. Product version 22.
- P21: BX-22.b pilot — structured reviewer findings on DELIVERED code tasks; human decision accept/repair/reject; review gate evidence; product version 21.

Format: newest first. Behavior changes must update tests and this file in the same step (TZ 16.3).

- P20b: Task PASS blocked unless gates Release Candidate is PASS/WAIVED when a code head exists; `POST .../gates/:gate/approve` for requirements/spec/review.
- P20: brief_writer package drafts; human package approval; Test Integrity package baseline; optional commit of approved package to `biforge/<task_id>` (writes gated). Product version 20.
## PI-02

- PI-02 (TZ-INSTRUCTIONS-01 P2): server-side intent flags (`userForbadeQuestions`, `userAskedApproximate`, `userAskedSearch`, `userCriticizedEvasion`) adjust Simple Mode post-processing — `askAllowed`, soft quality-audit / retry text, and `meta.search_expected`. No new model JSON fields. Version label `PI-02`.

## Unreleased
- P19: BX-21.b. `model_patch` executor (gated by CODE_EXECUTOR=model_patch): structured patch schema, validateModelPatch (protected paths, size, allowed_paths), createModelPatchExecutor; ADR-10 remains interim. Repository: ARCHIVE/ (historical SPECs and reports) and CONCEPTS/ (future drafts); AGENTS.md and START_HERE updated. Packer: `scripts/pack-simple.mjs` replaces the previous patch:pack path (timeout-safe, no hanging children). Simple Mode unchanged.


- P18: BX-21.a. CodeExecutor interface and the `manual` executor (`server/codeExecutor.ts`, `server/codeTaskService.ts`, migration 010: `code_tasks`). A human starts a run with a Task Package, takes `PACKAGE.md` (artifact, no secrets, deterministic) to any tool and returns a PR, a branch or a unified diff; results are validated (10 files / 400 lines, `allowed_paths`, protected paths, text only, no modes, symlinks or renames) and a refused result is `BLOCKED` with violation codes. Diff upload is applied through the Git Data API as one commit on `biforge/<task_id>` plus a PR, only with `GITHUB_DIFF_UPLOAD=true`; no merge, no `main`. PR found by webhook or `refresh`. `max_code_tasks` is checked at start; `model_patch` is unavailable until P19. Seven routes under `/api/projects/:projectId/tasks/:taskId/code`, human session only. Simple Mode unchanged.
- P13b (build process): the ZIP is created and validated before long-running tests; independent stages use timeouts, forced process-group termination, and streaming logs; report `PARTIAL` for errors, timeouts, blockers, and checks that did not start. Critical preflight still blocks delivery. Agent stop rules, report and CI clarified; test and PostgreSQL time limits added.

- Process (documents only): TZ 16.3.2 and 16.4.4, patches P13a and P13b in the plan, Navigator / AI Assistant terms and AGENTS.md section 3.1, `docs/NEXT.md`. No program code changed.

- P13a: BX-28. Process automation (TZ 16.3.2): `npm run patch:pack` builds the cumulative archive (changed and new files, no manifest) and a report with only the commands actually run; the preflight refuses a manifest, nested or new top-level folders, possible secrets and changes to `tests/acceptance/**`; `ci.yml` writes a one-line CI result and the first failed test (job summary and annotation). Scripts `patch-tools.mjs`, `patch-pack.mjs`, `ci-summary.mjs`. No product code changed; Simple Mode unchanged.
- P14: BX-17.b. Full Artifact Registry: any file as an artifact (unknown format = binary), type from content, manifest per version (migration 008, older versions backfilled), tamper and missing-object detection on every read, limits (5 MB, 200 versions, 1000 artifacts, file name), executables flagged and never run, inspect, preview (text), diff, ZIP name listing without unpacking, project manifest export; ADR-05, ADR-08; `check:docs` now requires `server/`, `tests/` and `test:*` scripts in `docs/REPO_MAP.md`. No routes, no UI; Simple Mode unchanged.
- P13: BX-16 (domain part). Budgets on project/task/run (calls, tokens, units, wall clock, attempts, code tasks) checked before every model call, over budget -> Task BLOCKED(budget) plus one approval request, only a human raises a budget; Task Graph v1 (validator: no cycles, known dependencies, at most 12 tasks, total within the project limit; static template; a plan runs only after human approval); `approvals` table, modes supervised/manual (no autonomous); at most 2 Runs per project. Migration 007; `server/planMachine.ts`, `server/planService.ts`. No routes, no UI, worker not started from server.ts; Simple Mode unchanged.
- P12: BX-15.b. Job queue and worker (server/queueMachine.ts, server/queueService.ts, server/worker.ts, migration 006: jobs): FOR UPDATE SKIP LOCKED claim, lease and heartbeat, expired lease -> Run ABANDONED and Task BLOCKED(recovery), recovery pass on worker start, a lost worker never becomes PASS; enqueueTask creates the job and finishRun closes it. Worker is not started from server.ts; Simple Mode and S1 untouched.
- P11: BX-15.a. Task/Run state machine (server/taskMachine.ts, server/taskService.ts, migration 005: tasks, runs, task_events): strict transitions, optimistic versions, an event per transition, idempotent createTask/enqueueTask by key and input fingerprint, PASS only with recorded validation and evidence, a lost or failed run never becomes PASS (ABANDONED -> BLOCKED(recovery)), changed input invalidates PASS. No routes or UI; Simple Mode and S1 untouched.
- P10: BX-14. Golden-eval: 18 RU/EN tasks (10 analysis, 8 verify with injected defects and clean controls), deterministic scoring, runner on fake adapters, Markdown report docs/GOLDEN-EVAL-REPORT.md (quality, units, shadow cost, provisional quality_class suggestions), ADR-04 draft (cross_model decision belongs to the owner; report is a hypothesis). Simple Mode and Router untouched.
- P09: BX-13.b. Fallback matrix rows implemented and tested (deadline-aware retry, cooldown until reset via retryAfterMs, provider disable with audit event and 6 h expiry, category system, escalate human), model_health table and hydration, quota windows restored from the ledger, daily cap per project with 80 %/100 % levels. Simple Mode untouched.
- P08: BX-13.a. Router v1 (`server/router.ts`): candidate order by quality class, cost tier (`self_hosted` < `free` < `paid`) and registry order; paid models only with explicit approval; sensitivity filter (`high` admits only `paid`/`self_hosted` data policies); context, input-budget and quota-window checks (rpm/tpm/rpd/tpd) before the call; output capped by the model limit; per-run budget in units (30 by default) checked before every call, `blocked` instead of overspending. New `server/budget.ts` (units formula `units-v1`, quota tracker, shadow cost), `server/routeDecisions.ts`, migration `003_route_decisions.sql` (`route_decisions`, `usage_ledger.units`); ledger rows carry `route_decision_id`, units and shadow cost. Registry: `costTier`, `limits`, `pricing`, `self_hosted` data policy. `tests/p08-acceptance.test.mjs` (owner-approved, protected) added to `check`. ADR-07 accepted. Simple Mode untouched.
- P07: BX-12.a. `server/openaiCompatAdapter.ts` (universal Chat Completions adapter), Groq in the registry (`openai/gpt-oss-120b` active, two others disabled; Free-plan limits and budgets recorded), `groq` in `connectors.yaml` and `verify:connections` (Bearer auth, JSON content check), manual workflow `verify-groq.yml`. `verify:connections --only groq` returned OK on 10 October 2026.
- TZ: Appendix G (monitoring of free and limited provider capacity; planned after G2 as reserve patches P15a/P15b, steps BX-27.a/b), ADR-11, risk R-21, pointer in 7.5. Documentation only.
- P06: BX-09.a part 2 and BX-09.b (slice S1, TZ 18.0). `server/contextBuilder.ts` (instruction + State slice by relevance within a token limit + decisions and requirements always + referenced artifacts + task; unverified and rejected items excluded; chat history only with a recorded reason; tokens measured per block); `server/analysisService.ts` (passport must be confirmed -> Router-min -> patch pipeline as `proposed` -> `analysis.md` artifact -> ledger rows with `run_id`; human confirm/reject; decisions human only); routes `POST /api/projects/:id/analyze`, `/items/review`, `/decisions`, `GET .../artifacts`, `.../artifacts/:artifactId`, `.../ledger`; Project Mode panel (task, proposed items with Confirm/Reject, decision form, artifacts, model calls with tokens). Simple Mode untouched. UI and code name "Bifurcation Engine" replaced with "BiForge" everywhere. Tests `context-builder.test.mjs`, `analysis-live.test.mjs`.
- P05: BX-09.a part 1. `server/statePipeline.ts` (State items schema, patch pipeline schema -> policy -> apply, atomic; model items always `proposed`; decisions human only; fact without `ref` is `unverified`; one rule-based confirmation: artifact ref + quote; deterministic compaction that never touches decisions, requirements and open high risks); `server/stateService.ts` (applies a patch or compaction as a new State version with audit events); `updateProjectState` refuses `actor: agent` without the pipeline; State with invalid `items` is refused. Not wired to any route or to Simple Mode. Tests `state-pipeline.test.mjs`, `state-pipeline-live.test.mjs`.
- P04: BX-17.a and BX-10.b. Migration `002_artifacts_ledger.sql` (`artifacts`, `usage_ledger`, `connection_checks`); `server/artifactRepository.ts` (text artifacts, versions, SHA-256, same content is not duplicated, hash checked on read); `server/ledger.ts` and an `onCall` hook in Router-min (every call is reported); `connectors.yaml` in manifest format v1 (gemini, postgres); `npm run verify:connections` (`scripts/verify-connections.mjs`); `docs/CONNECTIONS.md` rewritten (rules R1-R7, A-01/A-02 console checks); tests `connections.test.mjs`, `artifacts-live.test.mjs`. Simple Mode untouched.
- P03: BX-10.a part 2 and BX-11. Added `server/geminiAdapter.ts`, `server/fakeProvider.ts`, `server/router.ts` (Router-min, fallback by TZ 7.4), `tests/conformance.test.mjs`, `docs/ADR-02-gemini-adapter.md`. `generate()` and Simple Mode untouched (not switched).
- P02: BX-10.a part 1 (no switching). Added `server/adapter.ts` (provider error classes, fallback matrix as data, `ProviderAdapter` contract, normalized response schema) and `server/modelRegistry.ts` (registry schema, Gemini seed, capability and 90-day checks); `tests/model-layer.test.mjs`. `generate()` and Simple Mode untouched; the registry is not stored in the database yet.
- P00: documentation only. Added `docs/START_HERE.md`, `docs/REPO_MAP.md`, `docs/CURRENT_STATE.md`, `docs/PATCH_TEMPLATE.md`, `docs/BX-07-REPORT.md`; one specification name `docs/BiForge_TZ_v3.md`; TZ status approved, section "How to read" and 16.3.1 (actual process); `AGENTS.md` aligned with the real process; `scripts/check-docs.mjs` also checks backticked paths; environment variables documented; removed root clutter files and `BIFORGE-STATE.json`.
- P00b: deleted historical step specs, reports and audits (BX-01…BX-05, BF-01, QA diagnostic of 9 October 2026, `AUDIT_REPORT_RU.md`); references updated.
- Patch A: `/health`, `/ready`, `/api/health` return `commit` (RAILWAY_GIT_COMMIT_SHA).
- Patch B: TZ updated (language rule 6.1.1, step rules in 16.3, BX-07 narrowed); CHANGELOG.md added.
- BX-07.a: `updateProjectState` requires a non-empty `sourceRef`; `project.created` event records `source_ref`; live test checks provenance on versions and events.
- BX-07.b: live test that Project State and history survive a service restart and the version counter continues.
- BX-07.c (part 1): `/project` UI (src/ProjectMode.tsx) is English; test text updated. Simple Mode (src/ui.ts, src/App.tsx) is still Russian — next part.
- BX-07.c: UI is English only (TZ 6.1.1). Removed the Russian UI dictionary and DOM translation from `src/ui.ts` (`installUiLanguage` is now a no-op), Russian variants of error/status messages (`src/errors.ts`, `attachments.ts`, `ConversationFiles.tsx`, `App.tsx`, `libraryExport.ts`), and the Russian model-unavailable fallback reply (`server.ts`). Kept on purpose: Russian number words and keyword lists (recognition logic), crisis phrases, transliteration table, language detection, and Russian test inputs. Generated document labels still follow the dialogue language.
- TZ: section 16.4 reworked into a patch-based delivery plan (P01-P25); UI shows only 'BiForge' (6.1.1 rule 4); 16.3 rule 6 and 16.5 updated.


## 1.6.0 — cumulative P13b + P15 patch (2026-10-11)
- Wired Task Graph plan/approval/task routes and Project Mode controls.
- Started queue worker in configured Project Mode and connected task model calls to pre-call budget guards, Run-linked ledger, and Artifact Registry.
- Added P15 static acceptance checks and truthful report/ADR-10 pending record.
- Live G2/E-01 remain unverified; no `model_patch` execution or deployment approval is implied.

## P17 — Gate Engine and CI evidence (BX-20)
- Gate Engine (`server/gateEngine.ts`, `server/gateService.ts`, migration 009: `gate_evidence`, `gate_waivers`, `task_heads`). PASS only from registered evidence bound to the head commit; model statements rejected; evidence of another commit or invalidated evidence is ignored; a new head SHA invalidates earlier evidence; changes under `tests/acceptance/**` are FAIL, an unreadable diff is BLOCKED; WAIVED only by a human with a reason, audited; Release Candidate is derived and has a manifest.
- `/api/webhooks/github` now registers evidence for `check_run` and `pull_request` events of `biforge/<task_id>` branches (typed fields only, idempotent); invalid signatures still 401. Routes `GET /api/projects/:projectId/tasks/:taskId/gates` and `POST .../gates/:gate/waive`.
- P16 completion: read of PRs, PR files and check runs; Task Package commit helper limited to `biforge/<task_id>` and Task Package paths, off unless writes are enabled, no merge operation.
- Fix: `connectors.yaml` github block (literal `\n`) and `github` row in `docs/CONNECTIONS.md`; `docs/CURRENT_STATE.md` rebuilt (the archive copy held a script); `docs/REPO_MAP.md` rows separated.

## P16 — GitHub integration foundation
- Added least-privilege GitHub App connection verification and signed webhook ingress for `pull_request` / `check_run` events. Event processing and Code Delivery remain disabled pending owner decisions.

- Model pool: removed deprecated aliases gemini-3.7-flash and gemini-3.5-flash (routed by Google to 3.8 / 3.6). A quota error from one model no longer aborts the whole request: the model is parked for 30 min (`llm_quota` log) and the next one is tried; `GEMINI_QUOTA` is returned only when every model is out of quota. Defaults: LLM_CALL_TIMEOUT_MS 25000, LLM_TOTAL_DEADLINE_MS 70000.

- Documents (12 October 2026): TZ section 16.7 added (step-by-step plan to G4: stages A-F, owner and agent roles, PASS criteria, branch on E-01, recommended Railway Variables, after-G4 work); 16.4.1 and 16.4.2.a brought to the actual state (P01-P24 done); `docs/NEXT.md`, `docs/CURRENT_STATE.md`, `docs/START_HERE.md`, `AGENTS.md`, `DEPLOY_RAILWAY.md`, `docs/REPO_MAP.md` updated. No program code changed.


## 13 October 2026 — Project Mode program creation

- Added a gated “Create a small program” action in Project Mode and `POST /api/projects/:projectId/code/build`.
- Wired the model_patch start path to the configured Router-backed JSON code author.
- Validated generated source is stored as a downloadable ZIP artifact under `generated-projects/<task_id>/**`; GitHub PR delivery remains gated and merge is still human-only.
- Documented maximum automation as an owner-set primary priority without expanding delegation permissions.
- Generated code is not executed by the BiForge server; runtime tests/preview and CI evidence are not implied by source generation.

## P41 — UI1 mode start screen (2026-10-15)

- Added explicit Simple, Expert, and Project start cards. Project shows an explicit disabled state when unavailable; selecting a mode is user-driven and does not auto-switch later.
- Recorded the existing folder-picker-to-menu behavior (`PICK_FOLDER_EVENT`) in the patch journal.
- Corrected STATUS sequencing to UI1 → QA1 → MANUAL1 and removed the resolved UX1 feedback question.
