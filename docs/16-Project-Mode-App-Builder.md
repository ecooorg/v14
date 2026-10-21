# 16. Project Mode App Builder (P58)

**Status:** design + frontend implementation in v56. Server generation limits and full template packs remain open.

## 16.1 Intent

Project Mode was hard to use for both beginners and professionals. P58 splits the **entry experience** without changing Simple or Expert modes.

| Path | Audience | Input | Output |
| --- | --- | --- | --- |
| **Simple words** | Beginners / clear goals in plain language | Idea text + button questions | Project with confirmed passport; optional source ZIP; on-screen manual deploy steps |
| **Professional** | Domain specialists | Existing description, analysis, plan, delivery | Same class of artefact: source ZIP you publish yourself |

**Non-goals for P58**

- Automatic GitHub or Render integration.
- Changes to Simple/Expert prompts, UI, or routes.
- Autonomous merge or server-side execution of generated code.

## 16.2 User flow (Simple words)

1. Open `/project`, sign in if required.
2. Choose **Simple words**.
3. Describe the idea in ordinary language.
4. Answer kind / auth / database / language / optional constraints / stack hint.
5. Confirm summary → create project + confirm passport (existing state API).
6. If `CODE_EXECUTOR=model_patch`, call existing `/code/build` with a composed goal that requests README, `.env.example`, and manual deploy guidance.
7. Show download link (when present) and fixed **manual deploy** instructions (GitHub + host by hand).

## 16.3 User flow (Professional)

1. Choose **Professional** (or create a project from the classic form).
2. Use existing Passport, analysis, plans, tasks, Delivery, Create program.
3. When a ZIP is produced, show the same manual deploy instruction block.

## 16.4 Implementation map

| Piece | Location |
| --- | --- |
| Path chooser UI | `src/ProjectPathChooser.tsx` |
| Novice wizard | `src/ProjectNoviceWizard.tsx` |
| Answers → passport / build goal / deploy text | `src/projectAppBuilder.ts` |
| Integration | `src/ProjectMode.tsx` (path state; no App.tsx changes) |
| Copy | `src/projectCapabilities.ts`, `src/UserGuide.tsx` |

## 16.5 Server limits (P58)

- Legacy defaults remain `DEFAULT_MAX_FILES = 10`, `DEFAULT_MAX_CHANGED_LINES = 400` for small/manual packages.
- Product `/code/build` uses **App Builder** limits: `APP_BUILDER_MAX_FILES` (default 80) and `APP_BUILDER_MAX_CHANGED_LINES` (default 8000), overridable via `CODE_APP_BUILDER_MAX_FILES` / `CODE_APP_BUILDER_MAX_LINES`.
- Absolute schema ceiling: 120 files / 20000 lines.
- `callCodeAuthor` raises `maxOutputTokens` and timeout when App Builder limits are in effect.
- Every source ZIP includes `DEPLOY-MANUAL.md` (manual GitHub + Render/Railway steps).

## 16.6 Safety

- Human confirmation of passport remains required for analysis unlock.
- Generated code is never executed on the BiForge server.
- Deploy remains fully manual.

## 16.7 Acceptance (owner)

1. Simple and Expert modes behave as in v55 (no functional regression).
2. Project start shows two paths.
3. Simple words creates a project and shows deploy instructions; ZIP when executor enabled.
4. Professional path still reaches analysis / plan / delivery.
5. No automatic remote publish.
