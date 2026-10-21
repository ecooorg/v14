# 5. Agent Runtime and Prompt Contracts

## 5.1 Conversation path

`POST /api/conversation` is the primary conversation endpoint. The selected product mode, internal Simple task classification, mode-specific instruction package, attachment context, user-intent flags and bounded retry logic are assembled server-side. Provider calls are made through a server adapter; provider credentials remain server-side. The exact current prompt strings live in `server/promptCore.ts`, `server/promptPacks.ts`, `server/conversationMode.ts`, `server/intentFlags.ts`, and `server.ts`. Those source files—not historical prompt descriptions—are the executable prompt contract for this baseline.

The product uses a common core plus mode-specific instructions. The common layer covers universal behaviour such as honesty, safety and untrusted-data handling; Simple/Expert/Project retain distinct task contracts. Do not collapse them into a single prompt that applies Project/Expert process overhead to every Simple factual question.

## 5.2 Simple intent and quality retry

`server/conversationMode.ts` chooses a task type within Simple; `server/intentFlags.ts` contains deterministic flags for explicit approximate-answer requests, search requests, criticism of evasiveness, bans on questions/methodology, and demands for direct answers. `informationSoftFail()` checks empty output, limitation-only drafts, methodology/AI preambles, invented precision requirements, and lecturing after an explicit user constraint. If it fails, `informationRetryHint()` asks for a rewrite in the information contract; it must not silently switch to decision mode.

This is a heuristic quality retry, not a formal factuality guarantee. It cannot prove that every answer is correct. Current configured request limits include `LLM_CALL_TIMEOUT_MS` (default documented 25,000 ms), `LLM_TOTAL_DEADLINE_MS` (70,000 ms) and `MAX_MODEL_CALLS` (4), but actual effective values depend on server code/environment.

P57 latency policy (`server/latencyPolicy.ts`): the quality retry is skipped when the turn has already taken longer than `QUALITY_RETRY_MAX_ELAPSED_MS` (the first draft is returned, as it already is when the retry fails); the optional verifier waits at most `EPISTEMIC_TIMEOUT_MS`; assistant messages older than the last two messages are cut to `OLDER_ASSISTANT_MAX_CHARS` in the model input (user messages and the durable state are never cut). Setting a value to `0` restores the earlier behaviour for the retry guard and the cutting.

## 5.3 Project analysis instruction

`server/contextBuilder.ts` defines the analyst instruction. The model is asked to return one JSON object with `summary` and `patch.ops`. Allowed operations are `add`, `update`, `reject` against State sections `facts`, `unknowns`, `hypotheses`, `risks`, `requirements`; it must not touch decisions or system-owned IDs/status/author/source. A fact needs a `ref` (`msg:...` or `artifact:...`) or remains unverified.

The Context Builder is a pure function. It includes project head fields (goal, phase, type, next action), selected State items ranked by relevance and protected categories, artifacts referenced by the task, and task text. It returns token accounting, included/excluded items and optional history reason. Default total context limit is 6,000 estimated tokens; artifact excerpt default is 3,000 estimated tokens (text cap is approximated as tokens × 4 characters). These are source defaults, not a provider's exact tokenizer guarantee.

## 5.4 State Pipeline

1. Parse model patch using `statePatchSchema` (1–100 operations).
2. Parse existing `state.items`; invalid existing data refuses the patch.
3. Reject model decisions and system-owned fields.
4. Generate IDs, author, timestamp and source server-side.
5. Force model-added reviewable items to `proposed`; human additions may default to confirmed.
6. Validate each item against its section schema.
7. If any operation errors, return failure and apply none.
8. On success, persist with expected-version optimistic concurrency and record state/event history.

`compactState()` applies deterministic trimming to lower-priority long text when section budgets are exceeded. Decisions, requirements and high-severity open risks are protected. The code returns `needsLlm` sections where deterministic trimming is insufficient; do not claim LLM compaction is active unless a call site confirms it.

## 5.5 Provider adapters and routing

Normalized adapter requests carry request ID, model ID, optional system prompt, prompt, JSON-output flag, output cap and metadata. Responses carry normalized output, token usage, latency, provider/model identifiers, retryability and typed error class. Adapters isolate provider-specific payload/error mapping.

A deterministic Router exists in `server/router.ts`. It filters registry entries by active status, provider health/cooldown, required capabilities, minimum quality, adapter presence, sensitivity/data policy, paid approval, context/input budgets and quota; it sorts by quality class, then cost tier, then registry order. On transient failure it retries once within call/deadline limits, applies cooldown, handles quota/auth/output errors according to the matrix, and records attempts/units. **The source explicitly states this router is not wired to Simple Mode.** Do not document a working general multi-provider cascade in the shipped conversation path. P49 cascade expansion is deferred.

## 5.6 Budgeting and telemetry

The Project engine has scoped budgets (`project|task|run`) for calls, tokens, cost units, wall-clock time, attempts and code tasks. Separate model-router budget units use `BUDGET_POLICY_VERSION = units-v1`; the default task/daily unit constants are 30/300, and token units are derived by `unitsFor()`. Do not conflate this model-router unit ledger with Project budget limit fields without following the call path.

`usage_ledger` records provider/model, input/cached/output tokens, latency, retries, status, error class, estimated cost, route decision and timestamp. The `/ops` implementation is partial according to `docs/SPEC_COVERAGE_AUDIT.md`; not every available ledger metric is exposed.

## 5.7 Epistemic verifier

The P48 verifier is optional, can be configured by `GROQ_API_KEY` and/or `EPISTEMIC_VERIFIER_MODEL`, and is designed as a fail-soft check. Missing key, crisis path or provider failure skips/degrades the verifier rather than blocking the primary response. It should not be described as a guarantee of correctness or a substitute for source verification. Test `tests/p48-epistemic.test.mjs` passed in the current environment (8/8).

## 5.8 Web search

Search is opt-in via `ENABLE_WEB_SEARCH=true`. Provider selection and bounds are in `server/webSearch.ts` and `.env.example`, including provider, timeout, max pages, max queries, page fetching and optional translation model. When disabled or failing, the system must not claim it searched. Search results and fetched page content are untrusted data, not instructions. Live provider quota/accuracy is NOT RUN in this audit.

## 5.9 Prompt and agent equivalence requirements

A rebuild must preserve: explicit mode selection; no silent mode switching; internal Simple intent classification; bounded retry budget; JSON parsing/repair behaviour; Project State proposal-only model permissions; context budget and protected State; provider error classification; budget checks before calls; usage accounting for attempted calls; and fail-soft behaviour for optional verifier/search. Exact prompt text should be copied from the baseline source and versioned in the rebuild. Exact model output is not expected to be deterministic.
