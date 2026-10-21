# 12. Documentation Migration and Open Decisions

## 12.1 Why consolidation is required

The source snapshot has a canonical Russian technical specification, multiple product/engine/connection/process specs, a mode implementation plan, patch-level SPEC/REPORT pairs, ADRs, current-state/status/next files, audit reports, user guides and historical references. Some are normative for particular concerns; others are historical, stale, or explicit snapshots. Keeping all of them active creates ambiguity about which product version and implementation state a team should reproduce.

This set establishes one English-language entry point and separates current contract, implementation evidence, operational procedure, gaps and historical decisions. It does not erase the original record.

## 12.2 Proposed authority after owner approval

| Concern | Canonical document in this set | Existing source(s) to demote/retire from active use |
|---|---|---|
| Product contract and scope | 01 | `docs/BiForge_TZ_v3.md`, `docs/BiForge_TZ_P26.md`, `docs/SPEC_PRODUCT.md` |
| Architecture/runtime | 02 and 05 | `docs/SPEC_ENGINE.md`, `docs/REPO_MAP.md`, selected patch specs |
| API/provider/config | 03 and 11 | `docs/SPEC_CONNECTIONS.md`, `docs/CONNECTIONS.md`, connection appendix material |
| DB and state machines | 04 | engine spec sections and migration/patch narratives |
| UI/Workspace/files | 06 | `docs/USER_GUIDE.md`, P26/P27–P55 specs/reports, UX1/UI1 reports |
| Security/privacy | 07 | `docs/SECURITY_POLICY.md`, `docs/THREAT_MODEL.md`, security-related patch specs |
| Deployment/ops | 08 | `docs/OWNER_OPS.md`, `docs/OPS_ROLLBACK.md`, ADR-09 operational targets |
| Tests and release acceptance | 09 and 10 | `docs/TESTING_POLICY.md`, `docs/SPEC_COVERAGE_AUDIT.md`, patch acceptance reports |
| Historical decisions | 12, plus preserved ADR register | all ADRs and patch reports; retain as decision history until explicit disposition |
| Roadmap | 13 | `docs/MASTER_IMPLEMENTATION_PLAN.md`, `docs/NEXT.md`, `docs/STATUS.md` after owner approval |

## 12.3 Do not delete on the basis of this generated package alone

The repository policy says closed history and `ARCHIVE/CONCEPTS` bulk live off-repository, and only `STATUS.md` is the living queue pointer. The owner also requires explicit authorization before implementation or scope changes. Accordingly, this package is a proposed replacement documentation set; the existing repository has **not** been modified. Before deleting/replacing files, first merge the set in a documentation-only patch, validate all links and paths, preserve an immutable archive, and update the project instructions to point to this set. Keep ADR decision records unless a deliberate decision-register format replaces them.

## 12.4 Open implementation gaps confirmed by current coverage audit

- **F-01 / ADR-12:** server-side archive unpack in Project Mode not implemented; `server/workspace/ingestWorker.ts` absent. Decide implement vs formally amend ADR.
- **F-02:** `/ops` lacks several ledger-derived metrics (calls, tokens, latency, fallback share, executor runs, integrity errors, State conflicts, retries). P57 is a candidate, not completed.
- **F-03:** Simple-to-Project import is optional but absent; owner decision.
- **F-04:** model registry is code-defined, not DB-backed; `BIFORGE_PROJECTS_ORG` is documented but unused; owner decision.
- **F-05:** GitHub write/PR/repository creation, timed ledger cleanup, provider cascade expansion, OCR/audio/video remain deferred.
- **F-06:** Project UI has no budget editor, State version history UI, `/ops` link; one plan template; worker runs analysis tasks only.
- **T-04:** automated QA1 is primarily static; live behavioural mode scenarios require MANUAL1.
- **T-05:** gates G0–G4 are not all recorded closed; `RIGHTS_REVIEW.md` lacks owner signature and actual GitHub App rights are NOT_RUN.
- **T-06:** iOS/Safari Workspace acceptance NOT_RUN.
- **Release:** the source snapshot still lists CI confirmation, v55 deploy, smoke and MANUAL1 as owner next steps.

Source: `docs/SPEC_COVERAGE_AUDIT.md`, `docs/STATUS.md`, ADR-06/09/12.

## 12.5 Known documentation inconsistencies / provenance risks

1. `AGENTS.md` points to Russian TZv3 as canonical and describes current patch process. This generated set is English and must not silently supersede that instruction until the owner explicitly adopts it.
2. `docs/MASTER_IMPLEMENTATION_PLAN.md` describes the approved mode initiative and says MANUAL1 is open; `docs/NEXT.md` is a legacy queue snapshot. These must not be treated as equal active roadmaps.
3. ADR-12 says accepted but implementation status says not implemented. Decision status and code status must remain separate.
4. ADR-06 historically describes write permissions as a conditional possibility; Amendment 1 is the current release contract: Project is analysis + ZIP and GitHub read-only by default.
5. `SPEC_COVERAGE_AUDIT.md` asserts three modes work at the level of code/automatic tests, but manual acceptance is still open and this audit could not run the complete suite. The correct release claim is static implementation present, selected checks passed, full suite and MANUAL1 not verified here.
6. Some historical links point to reports not present in the archive; retain them as history rather than treating missing historical artifacts as current requirements.
7. ADR-03 is referenced as skipped/missing; do not fabricate an ADR-03 decision.
8. Version terminology is inconsistent: `package.json` reports version 55 and `docs/STATUS.md` treats v55 as the current baseline, while `AGENTS.md` still calls Simple Mode product version 24. Do not interpret these as the same version scheme without an owner-approved versioning rule.

## 12.6 Owner decisions required before final normative adoption

1. Should English documentation become the canonical language even though current `AGENTS.md` declares the Russian TZ text canonical?
2. Should ADR-12 be implemented or amended to match current browser-only Project Workspace behaviour?
3. Should the model registry remain code-defined or become persisted/configurable in PostgreSQL?
4. Should Simple-to-Project import be implemented?
5. When, if ever, should GitHub write/PR/repository creation be enabled, and for which exact repositories/permissions?
6. Should provider cascade expansion remain deferred after MANUAL1?
7. What is the actual production deployment commit/environment and whether v55 is deployed?
8. Has MANUAL1 passed? Provide owner-side evidence, not an inference from static tests.
9. Have G0–G4 rights/security/backup gates been formally closed?

## 12.7 Controlled migration procedure

1. Owner approves the new English document set and resolves language authority.
2. Copy the set into the repository (suggested `docs/canonical/` or replace `docs/` only after path review).
3. Update `README.md`, `AGENTS.md`, `docs/START_HERE.md` and the doc checker to point to the new index.
4. Update links in deployment, CI, patch process and owner operations instructions.
5. Keep a concise ADR register and append-only decision history.
6. Move superseded patch specs/reports to an immutable off-repository archive; do not delete without confirming historical references are preserved.
7. Run `npm run check:docs`, `npm run check`, `npm run build`; run live DB contracts and MANUAL1.
8. Commit as a documentation-only change and retain the prior archive/hash.
