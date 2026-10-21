# BiForge — STATUS

> The single authoritative progress file. Updated: 2026-10-21 · **v56**  
> Canonical documentation: English set under `docs/` (this repository).

## 1. Current status

| Workstream | Status |
| --- | --- |
| **Version** | **56** (`APP_VERSION`, `package.json`) |
| **Simple / Expert** | **Unchanged** (no conversation/prompt edits in this release) |
| **Project UX (P58)** | Two paths: Simple words + Professional; deploy instructions in UI |
| **Project generation (P58 server)** | `/code/build` uses App Builder limits (default 80 files / 8000 lines, env-overridable); richer code_author prompt; ZIP always includes `DEPLOY-MANUAL.md` |
| **GitHub / Render** | Still **manual only** — no auto push or auto deploy |
| **Open** | Full baked-in stack template packs; MANUAL1 acceptance |

## 2. Next (owner-driven)

1. Apply patch; set `CODE_EXECUTOR=model_patch` where generation is wanted.
2. Smoke Simple/Expert + both Project paths + one `/code/build`.
3. Optional: tune `CODE_APP_BUILDER_MAX_FILES` / `CODE_APP_BUILDER_MAX_LINES`.
4. MANUAL1.

## 3. Requires explicit owner authorisation

GitHub App write; executing generated code on the BiForge host; claiming MANUAL1 without evidence.
