# Railway deployment — v13 recovery

This build intentionally uses the v13 decision engine as the baseline.

## Required environment

- `GEMINI_API_KEY`
- `ENABLE_APP_AUTH=true`
- `APP_PASSWORD`
- `SESSION_SECRET` (kept as a deployment secret; the current session implementation uses random server-side session tokens)

## Optional

- `VITE_GOOGLE_CLIENT_ID` — Google OAuth Web client ID for the Railway origin. This enables the Google Drive button in the app.
- `MODEL_CASCADE_LIGHT`
- `MODEL_CASCADE_STRONG`
- `RATE_LIMIT_PER_HOUR`
- `DAILY_CALL_CAP`

## Build / start

Railway uses:

- build: `npm install && npm run build`
- start: `npm start`

The production server serves the generated `dist/` directory from `server.ts`.

## Google Drive

The app requests only `https://www.googleapis.com/auth/drive.appdata` and stores one JSON library in the user's hidden application-data area. On first connection, an existing library is loaded; if none exists, the current local v13 library is uploaded. The `Save Drive` button writes the current library back to Drive.

## Important recovery constraint

Do not replace the v13 decision engine with v14/v15 prompts or state-machine logic while validating this build. Infrastructure changes are deliberately kept separate from the decision methodology.
