# Railway deployment — v20.0.1

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
- `MODEL_CASCADE_LIGHT`, `MODEL_CASCADE_STRONG` — comma-separated model lists, tried in order (defaults in `server.ts`).
- `RATE_LIMIT_PER_HOUR` (default 60), `DAILY_CALL_CAP` (default 200). Requests made with the user's own key (`x-byok-key`) do not use the daily cap.
- `MAX_MODEL_CALLS` — model responses allowed for one HTTP request, retries included (default 4).
- `LOGIN_MAX_FAILS` (default 10) and `LOGIN_WINDOW_MIN` (default 15) — failed sign-ins allowed per address per window.
- `LLM_CALL_TIMEOUT_MS` (default 25000), `LLM_TOTAL_DEADLINE_MS` (default 70000), `LLM_ROUND_PAUSE_MS`, `MAX_BODY_BYTES`, `GEMINI_BASE_URL`.

## Build / start

Railway uses:

- build: `npm install && npm run build`
- start: `npm start`

The production server serves the generated `dist/` directory from `server.ts`.

## Google Drive

The app requests only `https://www.googleapis.com/auth/drive.appdata` and stores one JSON library in the user's hidden application-data area. On connection the local and Drive libraries are merged by dialog id (the later `updatedAt` wins) and the result is written to both sides; a local backup is made first and an empty library never overwrites a non-empty one. Autosave runs after connecting (debounce 4 s, at least 30 s between writes); the `Save to Drive` button always writes at once. The Google token lives in `sessionStorage` and is requested again when it expires.

## Important constraint

Do not change the decision prompts or state logic while validating a build. Infrastructure changes are deliberately kept separate from the decision methodology.
