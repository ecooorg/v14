# BiForge — STATUS

> Progress pointer. Product version lives only in `src/config.ts` (`APP_VERSION`) and must match `package.json`.

## 1. Current status

| Workstream | Status |
| --- | --- |
| **Version** | Single source: `src/config.ts` + `package.json` |
| **Simple / Expert** | Stable |
| **Project** | Simple words / Professional paths; `/code/build` generation |
| **Code delivery** | `model_patch` when `CODE_EXECUTOR=model_patch`; source ZIP only; generated code is not executed on the BiForge host |
| **GitHub write** | Deferred (ADR-06); off by default; enable only via explicit `GITHUB_DIFF_UPLOAD` |
| **Deploy** | Host-agnostic operator guide: `docs/DEPLOY.md` |

## 2. Out of repository

Names such as DEPLOY-MANUAL.md inside generated program ZIPs are archive contents, not paths in this repo.

## 3. Owner authorisation required

GitHub App write; running generated code on the BiForge server; production secret rotation.
