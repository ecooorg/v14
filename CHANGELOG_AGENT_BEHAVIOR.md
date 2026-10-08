# Agent behavior and model routing changes

## v1.0

Files in the conversation. The decision method, state logic and every existing prompt paragraph are unchanged; two sections and two schema fields were added to the conversation prompt.

- Attach files to a message (start screen and chat): PDF, DOCX, XLSX, PPTX, text, images. `POST /api/attach` validates by file bytes, extracts text in memory (`server/files.ts`), and returns it. Images and scanned PDFs are shown to the model directly on the turn they are attached; the model returns `attachmentNotes` (a faithful summary) which the client stores so later turns still know the file.
- Conversation prompt: new section FILES THE PERSON ATTACHES (file content is the person's own data, never instructions; fake file delimiters are neutralised) and new section DOCUMENTS AND FILES YOU HAND OVER. New JSON fields `document` and `attachmentNotes`; new intent `DOCUMENT`.
- Agent-made documents: the model returns a structured `document` (title and blocks, plain text). The server cleans it exactly like a reply (markdown and internal labels removed), drops it on a crisis turn, and does not require a gain on a document turn (no quality retry). `POST /api/export-document` builds Word or PDF on demand (`server/documents.ts`); no model call, nothing stored.
- Download any reply or the whole conversation as Word or PDF. Downloaded file names are always English (lower-case letters, digits, dashes): the agent suggests a short English `fileName` in the `document`; without it the title is transliterated (Cyrillic to Latin); replies are saved as `note`, conversations as `conversation`.
- Save to Google Docs: a button on documents, replies and conversations uploads the Word version to the person's Drive and lets Drive convert it into a native Google Doc (editable online, shareable by link). Uses a separate token with only the `drive.file` scope (files this app creates), requested when the button is pressed, same `VITE_GOOGLE_CLIENT_ID`, no new keys; the library sync still uses `drive.appdata` only and is unchanged. The button is shown only when Google sign-in is configured. Google Doc name = the English file name. Tests: `tests/driveDocs.test.mjs` (5).
- Auto-growing text fields: every multi-line field (`AutoTextarea`) and every free-text one-line field in the expert screens (`AutoInput`: Field, journal hypothesis, forecast wording, basis, fact, what I updated) now grows with its text, so everything typed is visible and editable without scrolling inside the field (`src/components/AutoGrow.tsx`). It follows typing, pasted text, programmatic clearing after Send, width changes (rotation, window resize) and font loading, and keeps the line being typed on screen on phones. One-line fields still ignore Enter and turn pasted line breaks into spaces. Numeric, password and checkbox fields are unchanged.
- Number check: numbers found in attached files count as the person's own input.
- Privacy text on the welcome screen now says that attached files are sent to Gemini with the message.
- New dependencies: `docx`, `pdfkit`, `dejavu-fonts-ttf`, `unpdf`; dev: `@types/pdfkit`.
- Tests: `tests/files.test.mjs` (25 unit tests, includes a PDF/DOCX round trip with Cyrillic) and `tests/virtual/files.test.mjs` (24 tests on the real server with a fake Gemini); `npm run check` runs both.
- Fixed in `src/App.tsx` (three `tsc` errors present in the previous package): two were type-only; the third was a real bug in Expert mode: the block with "THE DECISION" and the assumptions lists was shown only when `summary` was empty (a non-empty string compared with `> 0` is false), so the summary never appeared. `tsc --noEmit` is now clean.
- Fixed: `check-version` failed on the previous package because `DEPLOY_RAILWAY.md` and this file still said v20.0.1 while `src/config.ts` says 1.0.
- Not checked: live Gemini with real images and scans, real browsers (WebKit, iPhone), Drive sync with large dialogues.

## v20.0.1

- Test-only release, application code unchanged. Found while running QA-03 on real packages.
- `tests/ui/ui-check.mjs`: after Start a fresh profile shows "Nothing here yet", so the old test never opened a conversation (chat checks passed with nothing to check, and the "Method" button was never found). The test now presses "New decision" and waits for the textarea, so the chat, Method and expanded-mode checks run for real. Defect in the test, not in the UI.
- `tests/ui/ui-check.mjs`: console errors caused by blocked Google Fonts requests (fonts.googleapis.com, fonts.gstatic.com) are ignored; they fail with 403 in sandboxes without internet access and the CSS has a fallback font stack. Other console errors still fail the test. Environment issue.
- Version raised to 20.0.1 in `src/config.ts`, `package.json`, `package-lock.json`, README, DEPLOY_RAILWAY.md.
- Not checked: WebKit, real iPhone focus zoom, live Gemini, real Google Drive (QA-04, PERF-02, S2-07 remain with the owner).
- Environment note: the sandbox blocked `cdn.playwright.dev`, so Chromium 153 was taken from the npm package `@sparticuz/chromium` and placed in the Playwright browsers folder. Same major version as Playwright expects, but not the official build.

## v20.0.0
- Release that closes the v19 review (see the v20 specification). The conversation prompt text, the model list and the chain order are NOT changed. Versions "19.1" and "19.2" were never marked in the files (everything said 19.0.0); their content is part of this release.
- VER-01 / VER-02: version 20.0.0 in `src/config.ts`, `package.json`, `package-lock.json`, README, DEPLOY_RAILWAY.md. README "Version" section rewritten (it still said 17.0.0). `scripts/check-version.mjs` now flags any stale `v10`-`v19` / `10.x.x`-`19.x.x` label in README, DEPLOY_RAILWAY.md, `server.ts`, `App.tsx`, `config.ts`, `en.ts`, `icsBuilder.ts`, `index.html`, `railway.toml` and `.env.example` (code comment lines are exempt; before, only 10-15 and 18 were caught).
- DOC-02: DEPLOY_RAILWAY.md rewritten to match the code: signed session cookie (not server-side tokens), `SESSION_SECRET` required (16+ characters), and all variables the server reads (`MAX_MODEL_CALLS`, `LOGIN_MAX_FAILS`, `LOGIN_WINDOW_MIN`, `TRUST_PROXY_HOPS`, `LLM_CALL_TIMEOUT_MS`, `LLM_TOTAL_DEADLINE_MS`, ...). README "Deployment notes" fixed.
- MOD-01: the "Model routing" section below now describes what the code does (it used to name `gemini-3.8-flash` as primary). No behaviour change.
- UI-08: every `.ghost`, `.primary` and `.danger` control has a 44 x 44 px tap area on all widths (before: only header buttons below 600 px; the Start button was about 35 px); list, chip and card buttons get the same size.
- UI-09: text in all inputs, textareas and selects is 16 px (the chat field was 15 px, so iOS zoomed on focus).
- UI-10: tiny text raised: 8-10 px -> 11 px, 11 px -> 12 px (CSS and inline styles).
- `tests/ui/ui-check.mjs` now also checks input font size, tap areas in the chat, the History panel and the Google AI screen, at 360 / 414 / 768 / 1024 px.
- ROB-01: `/api/expand` and `/api/redteam-pair` check the shape of the answer (3-5 options with the three required kinds; two red-team rounds). A wrong shape gets ONE retry on the reserve model inside the request's `MAX_MODEL_CALLS` budget; `meta` sums both calls; if the retry also fails the error is still 500 `SCHEMA`. Code: `generateChecked` in `server.ts`; tests: section K of `tests/virtual/stage2.test.mjs`.
- HIS-01 (decision): History keeps showing the dialogs of this device. After connecting, the local and Drive libraries are merged and written to both sides, so a dialog that exists only on Drive reaches the device at the first sync; a separate Drive-only list would need Drive reads that cannot be tested without real Google. Not changed.
- NOT done in this environment (no network, no live model, no real Google): QA-03 (`npm ci && npm run check && npm run test:ui` on real packages), QA-04 (`QA_DRIVE_CHECKLIST.md` on real Google and devices), PERF-02 (`scripts/measure-prompt.mjs`), S2-07 (`scripts/acceptance-s2-06.mjs`, blind comparison), PERF-03 (prompt shortening, allowed only after PERF-02 and S2-07). The owner runs them; results go here. Until then the changes of this release are checked only by syntax checks and by reading the code.
- Result record (fill in): QA-03 date/result: 2026-10-06, PARTIAL on real packages (Node 22.22.2, Linux, Chromium 153 only; no WebKit, no real iPhone): `npm ci` OK; `npm run lint` OK; `npm run build` OK; `npm run check` OK (stage2 202/202); `npm run test:ui` OK on 360/414/768/1024 px (74 checks) after two test-only fixes, see v20.0.1. QA-04 date/result: pending. PERF-02 average / maximum prompt size: pending. S2-07 date, models, ratings, decision: pending.

## v19.0.0
- Fixes and test repair after the full v18 check with a model bridge. The conversation prompt text, the model list and the chain order are NOT changed.
- FIX-02 follow-up: cutting a question sentence out of `reply` no longer glues the neighbouring sentences together ("part.Next" -> "part. Next"). Test added.
- PERF-01 follow-up: when the quality check triggers a retry, `meta` now sums `calls`, `promptChars`, `durationMs` and tokens of both model calls (before, only the second call was counted).
- QA-02: the browser check now passes the welcome screen (Start button), checks the Start tap area, watches console and page errors, takes a welcome screenshot per width, and a failure on one width can no longer hang the run.
- Housekeeping: version 19.0.0 everywhere; `check-version` also catches stale 16-18 labels; `tests/ui/_local*` is ignored.
- Test repair: `tests/fixtures/regression.json` expected 1 model call for cases where the quality retry fires (it encoded the PERF-01 bug); now 2, and the test also checks `meta.calls` against the real number of calls reaching the fake model.
- S-3: `scrubInternalLabels` no longer leaves orphaned punctuation ("; .", "..", "?.") after removing a label, and bare source tags `(USER_DATA)` / `(GENERAL_PATTERN)` / `(GUESS)` are removed too.
- S-4: one model-call budget (`MAX_MODEL_CALLS`) per HTTP request: the quality retry in `/api/conversation` and the format retry in `/api/synthesis` share it with the first call (before, each `generate()` counted separately).
- S-5: `/api/synthesis` checks the answer (exactly 5 paragraphs, 250-350 words, tolerance 10 %, word count skipped for CJK). One retry on another model; if it still fails the answer is returned with `meta.warnings` (no hard error). `meta` sums both calls.
- Error mapping: quota / rate-limit errors now give 429 (not 500) on `/api/premortem`, `/api/experiment-draft`, `/api/forecast-wording`, `/api/synthesis`, `/api/review`, like the other endpoints.
- New suite `tests/virtual/stage2.test.mjs` (195 checks, part of `npm run check`): auth, 400/401/410, EVPI 10/40/30, chat invariants over 10 situations x 7 mutations, crisis (RU / ES / every marker), model failures and fallback, headers and key not logged, all 12 extended endpoints.
- Open for the next stages: Start button size fix if the browser measurement shows < 44 px; `/api/expand` and `/api/redteam-pair` return 500 SCHEMA on a wrong model shape without trying another model (design decision, not changed).

## v18.0.0
- Stage 2, step 5 (PERF-01 done; S2-06 prepared, to be run by the owner on a live model). The conversation prompt text, the model list and the chain order are NOT changed in this build.
- PERF-01: every model call logs `llm_usage` (model, stage, `promptChars` = system instruction + prompt, `inputTokens` / `outputTokens` when the API returns `usageMetadata`). The response `meta` has `promptChars`, and `inputTokens` / `outputTokens` when available, summed over all model responses of the request (retries included). The client only stores `meta`; nothing is shown to the user. Code: `generate()` in `server.ts`; test: `tests/virtual/perf.test.mjs`.
- Measuring: `scripts/measure-prompt.mjs` runs the 10 control situations plus one 4-turn dialogue and writes `perf-report.json` (average and maximum). Needs a running server and the owner's key (`x-byok-key`).
- S2-06: `scripts/acceptance-s2-06.mjs` (shared cases in `scripts/cases.mjs`) runs the 10 situations on two servers (reference build and build under test, labels `A_LABEL` / `B_LABEL`) and writes a blind sheet plus a separate key; it also records prompt size per case.
- Prompt shortening: NOT done. The owner's decision 4 allows it only after live measurements and a blind check on the 10 situations; neither can be run without a live model. Procedure: measure v17.5 and v18 (`measure-prompt.mjs`), shorten repeats in the prompt without changing the meaning of v16 / v17 rules, run S2-06 (reference = unshortened, test = shortened), accept or revert.
- S2-06 result and decision: pending (owner). Record here: date, models, ratings per criterion, comparison with an ordinary chat assistant, decision (accept / rework).

## v17.5.0
- Stage 1, steps 1-4 done (end of stage 1). FIX-02: the visible reply now holds at most one question. Question sentences inside `reply` are dropped when a separate `question` field is used or when the reply already holds one; with HIGH context or in crisis mode the visible reply holds no questions. Code: `buildVisibleReply` in `server/reasoningState.ts`.
- UI-06: export file is `bifurcation_<APP_VERSION>_<time>.json`; old files still import. UI-07: pinch zoom allowed, input text 16 px. CODE-01: one `SCHEMA_VERSION` (in `src/config.ts`, re-exported from `src/types/decision.ts`; value 11 unchanged).
- TEST-01 (part): the Drive sync core moved from `useDrive` into the pure function `syncOnce` (`src/utils/driveSync.ts`, Drive client injected); tests with a fake Drive in `tests/driveSync.test.mjs`.
- DRV-01: right before writing, the file's id and modified time are read again; if they changed since the read, the file is read again and merged (at most 3 times). If Drive keeps changing, nothing is written, local dialogs stay untouched and a short message is shown. Merge rules 1-3 and backups are unchanged.
- DRV-02: autosave writes only when the local library has records newer than the last save of this device; at least `AUTOSAVE_MIN_INTERVAL_MS` (30 s, `VITE_AUTOSAVE_MIN_INTERVAL_MS` overrides) between two writes; the 4 s debounce stays. Manual "Save to Drive" and connect always write at once. Autosave conflict/failure messages are shown at most once per interval. Code: `src/utils/autosave.ts`; tests in `tests/driveSync.test.mjs`. Manual check list: `QA_DRIVE_CHECKLIST.md`.
- QA-02: 10 control situations as fixtures (`tests/fixtures/regression.json`) run by `tests/virtual/regression.test.mjs` against the real server with a fake model (checks: no markup, no service labels, at most one question, hypotheses not in facts, one model call). Browser check of the interface at 360/414/768/1024 px: `npm run test:ui` (Playwright, not part of `npm run check`); free CI job in `.github/workflows/ui-check.yml`.

## v17.0.0
- Stage 2 (in progress): answer improvements on top of the v16 core. Current version is defined in `src/config.ts`.
- INFRA-01: a bad-format answer (invalid JSON or numbers outside the input) gets one retry on another model instead of walking the whole chain; at most `MAX_MODEL_CALLS` (default 4) model responses per request; requests made with the user's own key (`x-byok-key`) do not use the server's daily cap; `meta` now has `calls` and `lightFallback` (set when the strong chain falls back to a lite model).
- I2, methodology layer: the conversation prompt gets a "V17 layer" (is the problem clear; hold the core problem; model hypotheses are not facts or goals; "you did not understand me" is recognised by the model, no keyword list; short answer by default; at most one question; drift check; plain text, dash lists). The checks run inside the same model call: service fields `problemClear`, `driftDetected`, `notUnderstoodSignal` are read on the server and are never sent to the client or shown.
- I2, state: the existing `state` object is extended in place with `coreProblem`, `userConcern`, `userReasoningState`; `hypotheses` stay separate from `facts`. The server reads old states without errors, caps size (items, list length, characters), drops unknown fields, and moves a new "fact" that only echoes the previous model reply into `hypotheses`. Code: `server/reasoningState.ts`.
- I2, safety nets: only the first question is kept; leaked service labels and field names are removed from the reply; `stripMarkdown` stays.
- I4: `scripts/acceptance-s2-05.mjs` runs the 10 acceptance situations on v16.5 and v17 and writes a blind sheet (the key is a separate file). Also fixed type errors in `App.tsx` (missing `Field` component, Brier input type), so `npm run lint` is clean.
- Final cleanup: removed unused `pendingRetry` state in `useDrive.ts` (reconnect already merges and retries the save); neutral CSS comments.

## v16.5.0
- Interface, Google Drive safety, sign-in hardening and tests. Answer methodology unchanged from v16.0.0. Current version is defined in `src/config.ts`.

## v13 (versions unified; earlier 8/10/11/12 labels retired)
- Conversation is the default; the method is kept by the agent. Entry offers four optional starting intents (think out loud / argue against my plan / prepare for a conversation / what to find out first) as plain chips, not forms.
- Memory without accounts: the client stores the agent's `state` and `nextStep` per decision and sends them back; "Noted for next time" shows the step. A visit after 1+ day tells the agent (`returningAfterDays`) to start from what happened.
- Safety: multilingual distress markers checked on every message (client) and on the server; the model also triages crisis in any language; on either signal the server appends international contacts to the reply and suppresses questions.
- Prompt: one warm human sentence when feelings are expressed (no therapy language); facts and values are separated instead of the all-or-nothing values-only exit; convergence to one small step after about four messages, with an optional short note for oneself or a trusted person; natural "other seat" / "prepare the conversation with the other person" / expectations without percentages / stopping rule in plain words.
- `translate="no"` and `dir="auto"` on conversation text so browser translation does not rewrite what people wrote and right-to-left languages render correctly.
- `npm run check` is green: core tests now import the real modules (run with tsx) and test the real number-validation contract (percent-only).
- Not in v13 (expert mode, planned separately): journal 30/90/180, confidence input 0-100 only, replacing alert()/prompt(), record versions with hash.

## Agent behavior (current)
- The conversational agent is an analytical engine, not a chat assistant: it uses model strengths (structuring, hidden assumptions, option space, critique, calculation, test design) and does not imitate human experience or values.
- Core question of every reply: which next fact, check or experiment would most change the decision, and how to get it cheaply.
- Triage first (CRISIS / VALUES_ONLY / LIGHT / PROCEED). CRISIS stops analysis and points to a real person.
- The user's options are treated as what they currently see, not the whole space. New branches must change the *shape* of the decision (timing, sequence, test, reversibility, split, scale, scope, goal, conditions, get-fact-first, keep-open), never just one more item on the same axis.
- Expansion is not mandatory: a reply may instead add a reframing, a hidden assumption, a contradiction, a decisive unknown, a cheap test or a calculation.
- LOW context: no expansion; say what is understood, show the fork, ask one question. MEDIUM: analysis + at most one question. HIGH: no question.
- The follow-up question is appended to `reply` by the server (the client renders only `reply`).
- Quality check is soft: one retry on the reserve model; if it still fails the person gets the answer anyway (no 500 from quality gates).
- The agent never chooses, ranks or recommends among options/values; it may name the most informative next step. No invented numbers/percentages; thresholds are set by the human.
- Reframing alone is not an answer: after it the agent must still give a working structure for the question asked (for "when should I act" questions: a ladder of signals - watch / prepare / test / decide - with outside facts separated from personal thresholds the person sets).
- Concreteness test: any phrase the person could answer with "what exactly would I do?" must be expanded into an action, who is involved, cost in kind and reversibility. Empty phrases ("prepare groundwork", "build flexibility") are not allowed.
- If the agent catches itself writing "for your case / in your region" about something it does not know, that circumstance is the decisive unknown and must be asked.
- No invented durations/amounts/counts; general claims are tendencies worth verifying; no beliefs attributed to the person that they did not state; no restating the question or sweeping opener.
- Server strips leaked method labels such as "(Split-base)" or "(Sequence)" from replies as a safety net.
- Prompt contains no subject-matter examples. Subject examples belong in test cases (tests/virtual), not in the prompt.

## Model routing
- Default order for both chains: `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, then (strong chain) `gemini-flash-latest`, `gemini-flash-lite-latest`, `gemini-3.8-flash`; the light chain is `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-flash-lite-latest`. Override with `MODEL_CASCADE_STRONG` / `MODEL_CASCADE_LIGHT`; the user's preferred model only changes the starting point.
- A request never walks the whole chain for a format problem: one retry on another model, at most `MAX_MODEL_CALLS` (default 4) model responses per HTTP request.
- Per-model 429/rate-limit and transient 5xx/timeout errors move on to the next model; daily/provider quota exhaustion does not cascade across models.
- The application counts model calls against `DAILY_CALL_CAP`; requests with the user's own key (`x-byok-key`) are not counted.
- The conversation quality-gate retry explicitly starts on the reserve strong model (index 1), as do the synthesis and shape-check retries.
- `meta.lightFallback` is set when the strong chain ends up on a light model.
