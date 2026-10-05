# Deploy (Railway and similar)

## Required environment variables

Set these in the host dashboard (Railway → Variables). Do **not** rely on a committed `.env` file.

| Variable | Example | Required |
|----------|---------|----------|
| `SESSION_SECRET` | long random string (32+ chars) | **Yes** (production) |
| `TESTER_CODES` | `alice:CodeOne,bob:CodeTwo` | **Yes** (production) |
| `GEMINI_API_KEY` | key from Google AI Studio | Yes for AI replies |
| `PUBLIC_ORIGIN` | `https://your-app.up.railway.app` | Recommended |
| `AI_ENABLED` | `true` | Optional (default true) |
| `GLOBAL_DAILY_CALL_CAP` | `500` | Optional |
| `PORT` | set by host | Optional |

Without `SESSION_SECRET` and `TESTER_CODES` the process exits on purpose (INF-2).

## Build / start

- Build: `npm run build`
- Start: `npm run start` (serves `dist/` + API)

## Checklist after deploy

1. Open `/api/health` → `{"status":"ok"}`
2. Open site → privacy → storage → login with a tester code
3. Send a short message in a new dialog
