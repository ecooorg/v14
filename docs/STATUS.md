# BiForge Builder — STATUS

> Starter tree for testing **pipeline-first** generation (IR → scaffold → ZIP).  
> Version: `APP_VERSION` in `src/config.ts` (= `package.json`). Product line: **builder**.

## 1. Current status

| Workstream | Status |
| --- | --- |
| **Version** | `57` — single source: `src/config.ts` + `package.json` |
| **Simple / Expert** | Unchanged conversation modes |
| **Project generation** | Default `POST /code/build` uses **pipeline** (`server/appBuilder`) |
| **Code delivery** | Scaffold ZIP without requiring the model; optional slice if `CODE_EXECUTOR=model_patch` and `APP_BUILDER_MODEL_SLICE=true`; legacy `engine: "model_patch"` still available |
| **GitHub write** | Deferred (ADR-06); off by default; `GITHUB_DIFF_UPLOAD` opt-in only |
| **Deploy BiForge itself** | `docs/DEPLOY.md` (any host) |
| **Structure** | No host-specific deploy filename in repo root |

## 2. How generation works

```
wizard / goal → App IR → resolve stack → materialize scaffold
  → optional model slice → ZIP (README + BIFORGE-IR.json)
  → human uploads to GitHub / host manually
```

## 3. Out of repository

Strings like DEPLOY-MANUAL.md inside generated ZIPs are archive contents, not paths here.

## 4. Owner authorisation

GitHub App write; executing generated code on the BiForge host.

## Docs

- Changelog: only `CHANGELOG.md`. The old `CHANGELOG_AGENT_BEHAVIOR.md` name is retired and must not be recreated.
