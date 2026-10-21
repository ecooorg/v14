# Deploy BiForge (any host)

Operator runbook for running **this** application (Simple / Expert / Project). Not the ZIP apps that Project Mode generates for end users.

## Requirements

- Node.js (see `.nvmrc`)
- PostgreSQL when Project Mode is enabled
- Model API key (e.g. `GEMINI_API_KEY`) for conversation features

## Environment

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port |
| `GEMINI_API_KEY` | Primary model |
| `DATABASE_URL` | PostgreSQL (required for Project Mode) |
| `ENABLE_PROJECT_MODE` | `true` to enable `/project` |
| `ENABLE_APP_AUTH` | Required with Project Mode |
| `APP_PASSWORD` / `SESSION_SECRET` | Auth |
| `CODE_EXECUTOR` | Set to `model_patch` only if AI code generation is wanted |
| `GITHUB_DIFF_UPLOAD` | Keep unset/false unless GitHub write is explicitly enabled |

Start from `.env.example`. Never commit secrets.

## Build and start

```bash
npm ci
npm run build
npm start
```

Health: `GET /health`. More detail: `docs/08-Deployment-and-Runbook.md`.

## On any platform

1. Connect this repository to a Node web service.
2. Set the variables above.
3. Build: `npm ci && npm run build`
4. Start: `npm start`
5. Attach Postgres if Project Mode is on.

UI differs by host; commands and env names stay the same.

## Project Mode ZIPs

Generated apps are separate. Their README covers local run and manual publish. BiForge does not push or deploy those ZIPs for you.
