# 1. Product and System Specification

**Status:** normative description of the v55 source snapshot; implementation-derived, with open gaps called out.

## 1.1 Product definition

BiForge is a web application for conversational assistance and managed project work. In Simple and Expert modes, the user interacts through a conversation-oriented interface. Project mode adds persistent project state, structured requirements and risks, plans, tasks, budgets, approvals, artifacts, evidence gates and a controlled software-delivery workflow. The core distinction is that a Project is modelled as persistent, versioned work rather than only as a chat transcript.

The application is a TypeScript/React frontend and Node.js/Express backend. PostgreSQL is used for Project Mode persistence when `DATABASE_URL` is configured. Google Gemini is the primary model integration; a Groq-compatible verifier/provider path is optional. The browser has Workspace and Google Drive-related functionality.

**Source evidence:** `package.json`, `src/App.tsx`, `src/ProjectMode.tsx`, `server.ts`, `server/contracts.ts`, `migrations/001_project_state.sql`, `docs/STATUS.md`.

## 1.2 Operating modes

### Simple

Purpose: general information, explanations, practical advice, research-like requests and explicit decision support. The selected mode is a product-level contract; the server also infers an internal task type for Simple. Existing code contains separate prompt packages and intent-quality checks.

- Information is the light default when intent is unclear.
- Explicit choice/decision requests may use decision framing.
- Research/engineering requests retain specialised instructions.
- An information soft-fail can request a bounded rewrite if the draft is mostly limitations, opens with a methodology preamble, or invents a need for exact/live data that the user did not request.
- Optional web search is disabled unless `ENABLE_WEB_SEARCH=true`; do not claim a web search occurred when it did not.

**Source evidence:** `server/conversationMode.ts`, `server/promptPacks.ts`, `server/intentFlags.ts`, `server.ts` `/api/conversation`, `docs/MASTER_IMPLEMENTATION_PLAN.md`, `docs/STATUS.md`.

### Expert

Purpose: deep problem analysis, assumption checking, alternatives, risks, and structured reasoning. The UI retains a selected Expert mode and sends mode/stage/method context to the conversation endpoint. Open dialogue should not erase the Expert contract.

**Source evidence:** `src/App.tsx`, `src/ModeMenu.tsx`, `server/conversationMode.ts`, `server.ts` `/api/conversation`, `docs/P52-SPEC.md`, `docs/PATCH_JOURNAL.md`.

### Project

Purpose: manage a project using persistent State, plans, tasks, budgets, approvals, artifacts, checks and delivery evidence. Project Mode is explicitly opt-in at deployment (`ENABLE_PROJECT_MODE=true`) and requires authentication and PostgreSQL configuration at startup.

Current shipped scope is **analysis + plans/tasks + human approvals + generated source ZIP + manual, read-only GitHub delivery**. It is not a general-purpose autonomous software execution/deployment environment.

**Source evidence:** `server.ts`, `src/ProjectMode.tsx`, `src/ProjectDelivery.tsx`, `server/projectCapabilities.ts`, `docs/ADR-06-github-repositories.md` Amendment 1, `docs/SPEC_COVERAGE_AUDIT.md`.

## 1.3 Product invariants

1. **Human decisions:** models can propose State changes but cannot create or alter Project decisions. State patch policy enforces this (`server/statePipeline.ts`).
2. **Versioned State:** Project State updates are optimistic-concurrency controlled with `expected_version`; stale updates must return a conflict rather than silently overwrite newer state (`server/contracts.ts`, `server/stateService.ts`).
3. **Validated proposals:** model-generated changes are schema-validated; a rejected operation causes the patch transaction to fail atomically (`server/statePipeline.ts`).
4. **Evidence-backed PASS:** a Task cannot enter `PASS` without successful validation and non-empty evidence (`server/taskMachine.ts`). Gate `PASS` requires valid evidence bound to the current commit; missing evidence is `NOT_RUN` (`server/gateEngine.ts`).
5. **Human budget authority:** budget increases and sensitive approvals require human authority (`server/planMachine.ts`, `server.ts`).
6. **Least privilege:** GitHub remains read-only by default. `CODE_EXECUTOR=model_patch` enables validated ZIP generation; it does not itself enable GitHub write. The separate `GITHUB_DIFF_UPLOAD=true` flag is the only documented write switch and is off by default in this release (`server/projectCapabilities.ts`, `docs/ADR-06-github-repositories.md`).
7. **No server-side arbitrary execution:** generated code is delivered as a ZIP; the product must not execute untrusted code on the production server or merge/deploy on behalf of the user (`docs/SECURITY_POLICY.md`, `docs/ADR-06-github-repositories.md`).
8. **Untrusted content remains data:** files, web pages, PR text and CI logs must not override system/policy instructions (`server/untrustedData.ts`, `docs/THREAT_MODEL.md`).
9. **Secret minimisation:** credentials stay in environment/secret stores and must not be exposed in client bundles, logs, State, artifacts or model-facing code execution packages (`docs/SECURITY_POLICY.md`, `server/redact.ts`).
10. **No implicit provider cascade claim:** a broader multi-provider cascade is deferred; current router code exists but is explicitly not wired to Simple Mode (`server/router.ts`, `docs/STATUS.md`, `docs/P49-SPEC.md`).

## 1.4 Capability inventory

| Capability | Current baseline | Evidence / limitation |
|---|---|---|
| Three selectable modes | Implemented in source | `src/App.tsx`, `src/ModeMenu.tsx`; user-facing manual acceptance remains open. |
| Gemini conversation | Implemented in source | `server.ts`, `server/geminiAdapter.ts`; live key/provider behaviour not tested here. |
| Optional Groq verifier | Implemented as optional, fail-soft path | `server/epistemicVerifier.ts`; optional and not allowed to block primary response. |
| Optional web search | Implemented behind opt-in | `server/webSearch.ts`, `docs/P50-SPEC.md`; disabled by default. |
| Project State, versions and events | Implemented in code/schema | migrations 001, `server/statePipeline.ts`, `server/stateService.ts`. |
| Plans, tasks, queue, leases, budgets, approvals | Implemented in code/schema | migrations 005–007, `server/planMachine.ts`, `server/taskMachine.ts`, `server/queueService.ts`. |
| Artifact ledger / integrity | Implemented in code/schema | migrations 002 and 008, `server/artifactRepository.ts`. |
| Gate evidence / release candidate | Implemented in code/schema | migration 009, `server/gateEngine.ts`. |
| ZIP source generation | Implemented, bounded | `server/codeExecutor.ts`, code task routes; not executed on server. |
| GitHub read-only delivery | Implemented in code; live permissions unverified | `server/githubIntegration.ts`, ADR-06 Amendment 1. |
| GitHub write/PR creation | Code paths exist but gated/off by default | `GITHUB_DIFF_UPLOAD=true`; requires owner decision and real permission verification. |
| Workspace browser unpack/classify/context/change set/export | Implemented in browser | `src/workspace/*`, `src/WorkspacePanel.tsx`; iOS/Safari manual acceptance NOT RUN. |
| Project server-side archive ingestion | **Not implemented** | Accepted ADR-12 lacks `server/workspace/ingestWorker.ts`; Project passes bounded excerpts. |
| Project artifact upload/download | **Not implemented as full workflow** | Coverage audit reports artifacts are list/read only. |
| `/ops` full ledger-derived telemetry | Partial | Coverage audit says calls/tokens/latency/fallback/executor/integrity/state-conflict/retry metrics are missing. |
| Simple-to-Project import | Not implemented | Schema supports `simple_import` origin, route/button absent per coverage audit. |
| Production deployment and MANUAL1 acceptance | Not evidenced by this archive | `docs/STATUS.md` records owner-side CI/deploy/smoke/MANUAL1 as next steps. |

## 1.5 User-visible project model

A Project has an identifier, name, status, versioned JSON State, settings and a collection of plans/tasks/approvals/budgets/artifacts/events. The Project Passport is stored in State under `passport`; it captures project type, goal, users, inputs/outputs, constraints, security/data handling, success criteria, budget, executor choice and human involvement level. Passport status is `proposed` or `confirmed`.

State item sections are: `facts`, `unknowns`, `hypotheses`, `decisions`, `risks`, `requirements`. Items have system-assigned IDs and provenance. Facts without a reference are marked unverified and are not context-grade established facts. Model-originated items remain proposed; decisions are human-only. See document 04 for schema details.

## 1.6 Project delivery contract

The documented current workflow is: create a Task / Task Package; approve the package where required; either download generated source ZIP or use a manual external tool; provide a branch/PR/diff result; refresh GitHub evidence; evaluate gates and run the reviewer; record a human accept/repair/reject decision. Merge is external and human-controlled. The current source contains several gated write-oriented endpoints, but the release contract must treat them as unavailable unless the explicit write switch and external permissions are verified.

## 1.7 Out of scope for the current release

- Autonomous merge, deployment or production code execution.
- Model-driven changes to permissions, model registry or budget limits without validation/human authority.
- Automatic activation of unverified models.
- A promised multi-provider cascade in Simple Mode.
- Server-side Project archive unpacking until ADR-12 is implemented or formally amended.
- OCR of scanned PDFs, audio/video ingestion, and other explicitly deferred file capabilities.
- Guaranteed byte-identical LLM output.

## 1.8 Acceptance definition

A rebuild is considered functionally equivalent only if: (a) the same public routes and error contracts are preserved; (b) schema, versioning and human-only invariants hold; (c) the same user mode selection produces the same mode contract and does not silently switch; (d) Project task/approval/gate transitions obey the state machines; (e) file/Workspace security invariants hold; (f) budgets and feature flags enforce the same boundaries; (g) automated checks pass; and (h) owner-side manual scenarios for real providers, Drive, GitHub permissions, deployment and backup restore are completed. A green static suite alone is insufficient.
