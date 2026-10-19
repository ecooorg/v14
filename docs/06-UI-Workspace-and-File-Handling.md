# 6. UI, Workspace and File Handling

## 6.1 Primary navigation and modes

The start experience exposes Simple, Expert and Project choices with stable UI test IDs in `src/App.tsx`: `start-mode-simple`, `start-mode-expert`, `start-mode-project`. The mode control is available from a single Mode button/menu; mode items were removed from the More menu in P51. The selected mode is expected to persist for the current interaction and not change automatically.

The interface includes conversation history, attachments, autosave/offline indicators, user guide, export features, Drive controls, Project screens and a Project Delivery tab. Key public UI surfaces are listed in `tests/feature-manifest.json`. This manifest is a regression guard, not a complete UX specification.

## 6.2 Simple and Expert conversations

- Simple is intended for direct information/advice, with explicit internal classification rather than automatic conversion into a decision session.
- Expert provides deeper structured analysis and retains its selected mode/stage/method through open dialogue.
- Attachment handling includes file extraction and text limits; `.env.example` documents defaults of 10 MiB per upload, 30,000 characters per file and 20,000 total attachment characters for Expert. Actual values may be overridden.
- Browser-side storage is used for local saved texts and other client state; do not assume it is server-synchronised unless a Drive/mirror path explicitly reports success.

## 6.3 Browser Workspace

The Workspace library lives in `src/workspace/`. Its functional units include path validation, archive parsing (`tar.ts` and zip-related helpers), ingestion, extraction/classification, context selection, file hashes, diffs, ChangeSet parsing/application, in-memory and IndexedDB storage, persisted ingestion and ZIP export. The UI surfaces Workspace state through `src/WorkspacePanel.tsx` and proposed edits through `src/WorkspaceChangeSetCard.tsx`.

The browser is the current host for Workspace archive unpacking. Security expectations include: reject path traversal and absolute paths; normalise separators; do not execute extracted content; treat file content as untrusted; bound entries/bytes/context; preserve hashes and paths; require user confirmation before applying a ChangeSet; export deterministic file contents. Exact limits and edge-case rules are in `src/workspace/paths.ts`, `src/workspace/ingest.ts`, `src/workspace/extract.ts`, `src/workspace/changeset.ts`, and `docs/BiForge_TZ_P26.md`.

## 6.4 Important Project-mode file gap

Accepted ADR-12 calls for isolated server-side archive unpacking in a worker thread for Project Mode. The P56 coverage audit states this is **not implemented**: `server/workspace/ingestWorker.ts` is absent. Project analysis receives a bounded excerpt (reported at about 2,600 characters in the coverage audit); Project artifacts are list/read only, without a full upload/download workflow. Until the owner either implements ADR-12 or amends it, the correct current behaviour is browser Workspace plus bounded excerpts, not server-side Project ingestion.

## 6.5 Generated source and delivery UI

Project UI exposes a “Create program” path and a Delivery tab. The current generated-program capability is a validated ZIP artifact; the server does not run the code. Manual delivery supports Task Package creation/download, human approval, recording a branch/PR/diff, refreshing GitHub status, review, repair request, and accept/repair/reject decision. GitHub is read-only by default; buttons/write endpoints must remain hidden/blocked unless the separate write feature switch is enabled.

Limits from `server/codeExecutor.ts`: default 10 changed files, 400 changed lines, 512,000-byte diff, 1,000,000-byte file and 1,000,000-byte `PACKAGE.md`. Package schema, allowed paths, protected paths, secret rules and source validation must be preserved.

## 6.6 Google Drive

P55 status says Google Drive saves files in every mode with visible results and Project buttons, and the UI has “Save all files to Google Drive” / “Save ZIP to Google Drive” paths. Source modules include `src/driveClient.ts`, `src/driveExport.ts`, `src/driveMerge.ts`, `src/driveMirror.ts`, `src/driveSync.ts`, `src/useDrive.ts`.

A rebuild must distinguish local pending/mirrored state from confirmed remote success, show failures, avoid silent overwrite during merge, and retain visible sync status. Real OAuth credentials, consent configuration and live Drive acceptance were not tested in this environment.

## 6.7 Accessibility, browser and manual acceptance

Preserve accessible labels and stable test IDs. Automated UI checks exist (`npm run test:ui`, `.github/workflows/ui-check.yml`) but Playwright/browser installation and actual iOS/Safari acceptance were not verified here. MANUAL1 is still listed as owner-side work in `docs/STATUS.md`; a successful static test must not be reported as full UX acceptance.
