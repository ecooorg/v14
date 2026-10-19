# Railway deployment — v55

> **Document:** DEPLOY_RAILWAY · **Product version:** 55 · **Canonical docs:** `docs/` (English set)

This file describes how the current application is deployed. Project Mode and PostgreSQL are opt-in. For architecture, environment variables, and runbook detail see `docs/08-Deployment-and-Runbook.md` and `docs/03-API-and-Integration-Contracts.md`. Status: `docs/STATUS.md`.

The decision method and the answer layer are described in `CHANGELOG_AGENT_BEHAVIOR.md`. Infrastructure changes are kept separate from the decision methodology.

## Required environment

- `GEMINI_API_KEY`
- `ENABLE_APP_AUTH=true`
- `APP_PASSWORD`
- `SESSION_SECRET` — any random string of 16+ characters. Required when sign-in is on: the server refuses to start without it. Sessions are a signed cookie (HMAC, 7 days), so they survive restarts and deploys. Changing the secret signs everyone out.
- `TRUST_PROXY_HOPS=1` — number of trusted proxy hops in front of the app (Railway: 1). The default in production is 1.

If `APP_PASSWORD` is empty in production the site is open to everyone; the server only logs a loud warning and starts anyway.

## Optional

- `VITE_GOOGLE_CLIENT_ID` — Google OAuth Web client ID for the Railway origin. Enables the Google Drive button. It is read at build time.
- `MODEL_CASCADE_LIGHT`, `MODEL_CASCADE_STRONG` — comma-separated model lists, tried in order (defaults in `server.ts`: `gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite`). Do not add `gemini-3.7-flash` / `gemini-3.5-flash`: since 8 Oct 2026 Google routes them to 3.8 / 3.6, so they share the same quota and are not a fallback. A per-model quota error now parks that model for 30 minutes and the request moves on to the next one.
- `RATE_LIMIT_PER_HOUR` (default 60), `DAILY_CALL_CAP` (default 200). Requests made with the user's own key (`x-byok-key`) do not use the daily cap.
- `MAX_MODEL_CALLS` — model responses allowed for one HTTP request, retries included (default 4).
- `EXPERT_ATTACH_TOTAL_CHARS` (default 20000) — attached file text allowed in expert requests.
- `GIT_COMMIT` — commit shown by `/health` when `RAILWAY_GIT_COMMIT_SHA` (set by Railway) is absent; the first 12 characters are shown as `commit`.
- `SKIP_DIST_HEALTHCHECK=true` — only for tests: skips the check that `dist/` exists in production health.
- `NODE_ENV` — set by the platform; `production` enables secure cookies and the default of one proxy hop.
- `PORT` — set by the platform (default 3000); `PG_POOL_MAX` and `PGSSLMODE` — PostgreSQL pool size and SSL mode; `PROJECT_RATE_LIMIT_PER_MINUTE` (default 60) — Project Mode per-IP limit; `DISABLE_HMR=true` — development only.
- `LOGIN_MAX_FAILS` (default 10) and `LOGIN_WINDOW_MIN` (default 15) — failed sign-ins allowed per address per window.
- `MAX_UPLOAD_BYTES` (default 10485760) — largest file the person can attach. `MAX_ATTACH_TEXT_CHARS` (default 30000) — how much text of one file is passed to the model.
- `LLM_CALL_TIMEOUT_MS` (default 25000), `LLM_TOTAL_DEADLINE_MS` (default 70000), `LLM_ROUND_PAUSE_MS`, `MAX_BODY_BYTES`, `GEMINI_BASE_URL`.

## Recommended production values (12 October 2026)

| Variable | Value | Note |
| --- | --- | --- |
| `MODEL_CASCADE_LIGHT`, `MODEL_CASCADE_STRONG` | not set (code default) | Remove old lists that still contain `gemini-3.7-flash` or `gemini-3.5-flash`; they override the default |
| `LLM_CALL_TIMEOUT_MS` | `25000` | |
| `LLM_TOTAL_DEADLINE_MS`, `MAX_MODEL_CALLS` | defaults (`70000`, `4`) | |
| `DAILY_CALL_CAP` | `1000` during the pilot | Counts every attempt, failed ones too |
| `RATE_LIMIT_PER_HOUR` | `60` | |
| `TRUST_PROXY_HOPS` | `1` | Default in production |
| `GROQ_PLAN` | `free` or `paid` | Not read by server code; documentation marker |
| `ENABLE_WEB_SEARCH` | `true` to enable web search for fresh facts (off by default) | Optional: `WEB_SEARCH_MODE` (`auto`/`explicit`), `WEB_SEARCH_MODEL`, `WEB_SEARCH_TIMEOUT_MS` (default `15000`) |

Gemini limits apply per project (not per API key) and per model; daily limits reset at midnight Pacific time. Real project data requires a billed project with a spending limit (A-02). A quota error from one model parks it for 30 minutes (log type `llm_quota`) and the next model is tried; `GEMINI_QUOTA` is returned only when every model is out of quota. Check the model list against the provider's documentation once a month (TZ section 16.7, maintenance table).

## Health check

- `GET /health` — public liveness probe: JSON with exactly `status` and `version`; no sign-in, no model call, no outbound requests.
- `GET /api/health` — the same for visitors who are not signed in; signed-in users also get `hasKey`, `authRequired`, and the model lists.
- Not yet in the Railway configuration: `Healthcheck Path = /health` is not set in `railway.toml`. Until it is, the platform does not detect an unhealthy process by this route (BX-02, TZv3.0, section 15.1).
- A readiness probe `/ready` (database and migrations) does not exist yet; it appears with PostgreSQL (BX-04).

## Build / start

Railway uses:

- build: `npm install && npm run build`
- start: `npm start`

The production server serves the generated `dist/` directory from `server.ts`.

## Planned changes (TZv3.0)

These items are not done in this version. They are the operational fixes of BX-02 (section 15.1) and the later steps; this file will be updated together with each of them.

1. Set `Healthcheck Path = /health` in Railway and describe it in `railway.toml`.
2. Unknown `/api/*` routes return a JSON 404. Today the catch-all route in production serves `index.html` for them.
3. Bring `railway.toml`, `nixpacks.toml`, and the Railway panel settings to one description (builder, restart count, start command). The file in the repository is the source of truth. Today the build uses `npm install`; reproducible installs use `npm ci`.
4. Start production from the compiled `dist` and pin the Node version (today `npm start` runs `tsx server.ts`; `nixpacks.toml` uses Node 22; `package.json` requires Node 20 or newer).
5. CI on `ecooorg/bf`: lint, typecheck, unit and virtual tests, build, secret scanning; required checks on `main`; "Wait for CI" and auto-deploy from `main` in Railway (section 15.2).
6. With PostgreSQL (BX-04): migrations under the expand → contract rule so that version N works with schema N−1, daily backup and a restore test (BX-25), structured JSON logs, a protected `/ops` page.

## Paid billing for real data

Files and messages are sent to Gemini (see below). On the free tier of the Gemini API the provider may use data to improve its products; on the paid tier it does not (A-02, confirmed 9 October 2026). Therefore use a **paid billing project with a spending limit or alert** for real data, and keep a free key for synthetic tests only. Set `DAILY_CALL_CAP` as the application's daily ceiling (section 14.4). Connection names and checks for every service are described in Appendix E of the specification (`connectors.yaml` and `docs/03-API-and-Integration-Contracts.md`).

## Files in the conversation

- Attach: PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), text (.txt .md .csv .tsv .json .log) and images (png, jpg, webp, gif), up to 5 files per message. The file type is decided by the file's bytes, not its name or MIME type. Old .doc/.xls/.ppt are refused with a hint to re-save.
- Text is extracted on the server in memory and returned to the browser, which keeps it in the dialogue and sends it back with each message. Images and scanned PDFs are held in server memory for 30 minutes (64 MB total) only so the model can look at them once; the model's summary is then kept in the dialogue. Nothing is written to disk, so no persistent volume is needed.
- Download: the model returns a structured `document`; `/api/export-document` builds `.docx` (library `docx`) or `.pdf` (library `pdfkit` with the bundled DejaVu Sans font from the npm package `dejavu-fonts-ttf`, which covers Latin, Cyrillic and Greek; CJK text will not render in PDF, DOCX is not affected). File names are always English ASCII (the agent's suggested name, else the transliterated title). The same endpoint saves any reply or the whole conversation. No model call is made for a download.
- Limits: 30 uploads and 60 downloads per address per 10 minutes. Uploads do not use `RATE_LIMIT_PER_HOUR`; the message that carries them does.
- Files are sent to Gemini together with the message they are attached to. Say so to people who use the deployment.
- Expert steps (`UNDERSTAND` through `REVIEW`) accept the same decision files; their combined file-text block is limited to 20,000 characters by default, while the normal conversation limit is 60,000. Images and scanned PDFs are not re-sent as raw bytes to expert steps; their saved descriptions are used there.
- Document cards support **Shorter**, **Add table**, and **Remove section**. Each action makes exactly one document-edit model request; the prior document remains in conversation history and the new version can be saved normally.
- File/export/upload errors have stable codes (`TOO_LARGE`, `UNSUPPORTED_TYPE`, `UNREADABLE`, `EMPTY`, `EMPTY_TEXT`, `RATE_LIMIT`, `ATTACH_FAILED`, `EXPORT_FAILED`, `BAD_FORMAT`, `EMPTY_DOCUMENT`, `BAD_UPLOAD`, `TOO_LONG`, `PRECONDITION`) and are rendered in the selected English/Russian interface language.

## Save to Google Docs

Documents, replies and conversations can be saved to the person's Drive as a native Google Doc. This needs no new keys: it uses the same `VITE_GOOGLE_CLIENT_ID`. One thing to do in Google Cloud: on the OAuth consent screen add the scope `https://www.googleapis.com/auth/drive.file` (non-sensitive: the app only sees files it creates). Each person is asked for consent the first time they press the button. The button does not appear when `VITE_GOOGLE_CLIENT_ID` is empty.

## Google Drive

The Drive button connects with two scopes: `https://www.googleapis.com/auth/drive.appdata` (one hidden JSON library of your dialogues) and `https://www.googleapis.com/auth/drive.file` (the files BiForge saves for you, visible in My Drive). On connection the local and Drive libraries are merged by dialog id (the later `updatedAt` wins) and the result is written to both sides; a local backup is made first and an empty library never overwrites a non-empty one. Autosave runs after connecting (debounce 4 s, at least 30 s between writes); the `Save to Drive` button always writes at once. The Google token lives in `sessionStorage` and is requested again when it expires.

**Where files go (P55).** My Drive → **BiForge** → **Simple**, **Expert** or **Project** (→ the project name). Files you attach, documents the agent writes and the packages it produces are saved there; a file attached before Drive was connected waits in memory and is saved right after you connect. Project files are saved with the buttons on the Project page. The library itself is in the hidden app-data area and is **not** visible in My Drive. Every save, wait or refusal is shown as a message in the header (or on the Project page).

**Google Cloud checklist (owner, once).**
1. APIs & Services → Library → **Google Drive API** → Enable.
2. OAuth consent screen → Data access → add **both** scopes: `.../auth/drive.appdata` and `.../auth/drive.file`. If the app is in *Testing*, add your Google account under Test users.
3. Credentials → the OAuth Web client → Authorized JavaScript origins → the Railway URL of this app (exactly, with `https://`).
4. When Google asks for permissions, **leave the file permission ticked** («See, edit, create and delete only the specific Google Drive files you use with this app»). If it is unticked the app says so and nothing is saved; press Drive again.

## Important constraint

Do not change the decision prompts or state logic while validating a build. Infrastructure changes are deliberately kept separate from the decision methodology.


## Project Mode (BX-06, opt-in)

Project Mode is deliberately disabled by default so existing Simple Mode deployments keep their behavior. To enable it, configure all of the following in Railway: `ENABLE_PROJECT_MODE=true`, `ENABLE_APP_AUTH=true`, a non-empty strong `APP_PASSWORD`, a random `SESSION_SECRET` of at least 16 characters, and `DATABASE_URL` pointing at PostgreSQL. The build creates the browser bundle in `dist/` and compiles the server to `dist-server/`; production starts with Node from the compiled output. The startup command runs `npm run db:migrate` before launching the server whenever `DATABASE_URL` is configured; if Project Mode is enabled, required security settings are validated before migration. Do not enable Project Mode until the PostgreSQL service and backup policy are configured.

The Project Mode UI is available at `/project`; its API is under `/api/projects`. Requests require a signed session, same-origin protection for browser writes, and a PostgreSQL-backed per-IP request limiter. `/ready` returns 503 until the required BX-04 migration is present. Simple Mode remains at `/`.
