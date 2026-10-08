# Bifurcation Engine v1.5.0

Decision cockpit implementing the **Before You Choose** method (Bifurcation Engine).

International edition: English interface, USD examples, no regional localization. People can write to the agent in any language: it answers in the language it is written to, and the interface can be translated with the browser.

The default screen is a conversation. The method (radar, expansion, critique, small tests, return) is kept by the agent and stays invisible; the step-by-step protocol is available in expert mode.

## Method loops

**UNDERSTAND → EXPAND → ATTACK → VERIFY → LEARN**

- Epistemic radar (6 categories) → knowledge map  
- User options + 3–5 from the model (hybrid / reversible / get-fact)  
- Symmetric red team + pre-mortem + 1–3 hypotheses  
- Experiment Card with lock-in, EVPI (article example = 40), forecast only from the human  
- Decision is written only by the human  

## Stack

React + TypeScript + Vite, Express, Gemini API, localStorage, zod.

## Run

```bash
cp .env.example .env
# set GEMINI_API_KEY and optionally APP_PASSWORD
npm install
npm run dev
```

Production:

```bash
npm run build
npm start
```

Checks:

```bash
npm run lint:copy
npm run test:core
npm run check
npm run test:virtual   # real server.ts against a scripted fake Gemini (no key, no network)
```

## Files

In the conversation the person can attach PDF, Word, Excel, PowerPoint, text files and images (the paperclip button), and download results: a document prepared by the agent, any reply, or the whole conversation, as Word or PDF. A document card also has quick edits: **Shorter**, **Add table**, and **Remove section**; each makes one model request and keeps the previous version in conversation history. Files are read in server memory and never stored on disk. With Google sign-in configured, a document can also be saved to Drive as a Google Doc. File errors use the interface language (English/Russian) with stable error codes. Expert requests limit attached file text to 20,000 characters total; chat requests allow up to 60,000. Details and limits: `DEPLOY_RAILWAY.md`.

## Crisis support

Default contacts are international (IASP, 988 where applicable). Replace in `src/config/support.ts` for a specific region.

Distress detection works in two layers: a multilingual marker list (`src/config/support.ts`, checked on every message in the conversation and on the server) and the model's own crisis triage in any language. When either fires, the server appends the contacts to the reply and the client shows them.

## Version

One version number everywhere, defined in `src/config.ts` (`APP_VERSION`); `npm run check` fails if `package.json`, README, DEPLOY_RAILWAY.md or the changelog disagree. The local-storage data schema keeps its own number, `SCHEMA_VERSION`.
Highlights: conversation-first agent with invisible method discipline, memory of the next step between visits, multilingual crisis safety, soft quality checks instead of hard errors, safe Google Drive sync, password sign-in with signed cookies. See `CHANGELOG_AGENT_BEHAVIOR.md`.

## Deployment notes
Password sign-in and optional Google Drive appData storage are controlled by environment variables; see `DEPLOY_RAILWAY.md` for the full list.
Set `ENABLE_APP_AUTH=true`, `APP_PASSWORD` and `SESSION_SECRET` (16+ characters, required when sign-in is on) on Railway. For Drive, set `VITE_GOOGLE_CLIENT_ID` to a Google OAuth web client ID allowed for the Railway origin.
The PWA plugin/service worker is disabled in this build to prevent stale cached assets from masking the current frontend.

## Known limit: two devices writing at the same moment
Before each write to Google Drive the app checks again whether the file changed since it was read, and merges if so. The Drive API does not offer a conditional write for this file type, so a write from another device in the few milliseconds between that check and our write can still be overwritten. Both libraries are merged by dialog id on the next sync, and a backup is kept locally, so this is rare and recoverable, but it is not fully excluded. It needs a manual check with real Google (QA-01d).

## Cost and prompt size

Each model call is logged as `llm_usage` (prompt size in characters and, when the API returns them, token counts). The same numbers are in the response `meta` (`promptChars`, `inputTokens`, `outputTokens`); the interface does not show them. To measure the average and the maximum on the 10 control situations plus a 4-turn dialogue: `BASE_URL=... APP_PASSWORD=... BYOK_KEY=... node scripts/measure-prompt.mjs` (writes `perf-report.json`). Blind quality comparison of two builds on a live model: `scripts/acceptance-s2-06.mjs` (usage in the file header).
