# AGENTS — BiForge agent instructions

> **Progress / next / open questions:** always `docs/STATUS.md` first (human + agent).  
> This file = process rules and prohibitions, not a second task queue.  
> If any plan disagrees with STATUS on “what is next”, **STATUS wins**.

> **Start with `docs/START_HERE.md`.** · **Document:** AGENTS.md · **Canonical product documentation:** English set under `docs/` (from this patch) · **Status:** policy document

## 1. Purpose and authority

This repository contains **BiForge**, a multi-model project agent that ships Simple, Expert, and Project modes (product version **55**).

**Canonical product documentation is English only**, located under `docs/`:

| Document | Role |
| --- | --- |
| `docs/README.md` | Index of the canonical set |
| `docs/01-Product-and-System-Specification.md` | Product scope, modes, boundaries |
| `docs/02-Architecture-and-Components.md` | Runtime architecture |
| `docs/03-API-and-Integration-Contracts.md` | HTTP and provider contracts |
| `docs/04-Database-and-State-Machines.md` | Schema and state machines |
| `docs/05-Agent-Runtime-and-Prompt-Contracts.md` | Agent runtime and prompts |
| `docs/06-UI-Workspace-and-File-Handling.md` | UI and Workspace |
| `docs/07-Security-Privacy-and-Operations.md` | Security and ops controls |
| `docs/08-Deployment-and-Runbook.md` | Install, deploy, run |
| `docs/09-Testing-and-Equivalence.md` | Tests and acceptance |
| `docs/10-Requirements-Traceability.csv` | Requirements matrix |
| `docs/11-Repository-and-Route-Inventory.md` | Routes and inventory |
| `docs/12-Documentation-Migration-and-Open-Decisions.md` | Open decisions and gaps |
| `docs/13-Implementation-Roadmap.md` | Roadmap |
| `docs/STATUS.md` | Living progress pointer |
| `docs/START_HERE.md` | 30-second onboarding |

All previous specifications, patch SPECs/REPORTs, and historical plans are **retired from the repository**. They may exist only in the owner’s local archives. Do not treat retired material as current requirements.

These instructions define the default working rules for coding agents. If an instruction appears to conflict with an approved owner decision or the canonical documentation, stop and report the conflict instead of silently choosing one.

**Terms.** *Navigator* is the human co-developer (the owner). *AI Assistant* is the AI co-developer (the agent these instructions are written for).

**Language policy**

- All code, comments, and repository documentation: **English only**.
- UI strings: English in source; browser translation may be used by the end user.
- Agent dialogue with the user: language of the user’s first message in the conversation.

## 2. Scope

- Work only on the explicitly authorised scope. The owner must command each implementation stage.
- Do not invent new product requirements. If something is missing from the canonical docs, treat it as an open decision (`docs/12-…` and `docs/STATUS.md`) and ask the Navigator.
- Identifiers of completed historical patches are frozen; do not reuse old SPEC numbers as living requirements.

## 3. Sources of truth (priority)

1. `docs/STATUS.md` — what is current and what is next  
2. This file (`AGENTS.md`) — process rules  
3. Canonical set under `docs/01`–`docs/13` — product contract  
4. Code, migrations, tests — implementation evidence  
5. Owner command in the current session — overrides plans, never overrides safety

## 4. Hard prohibitions

- Do not commit secrets, API keys, or real credentials.
- Do not enable GitHub write, silent merge to main, or production deploy without explicit owner authorisation.
- Do not change application behaviour in a documentation-only patch.
- Do not reintroduce retired or historical P*-SPEC files into the repository.
- Do not claim a test passed if it did not run, or a dependency is present if install failed.
- Do not expand scope beyond the authorised patch.

## 5. Delivery of work

- The model may have no GitHub access. The owner uploads archives and applies patches by hand when required.
- **Required deliverable for every patch:** a downloadable archive containing only the **changed and new files** (not a full tree dump). A `.patch`/`.diff` alone does not replace the archive.
- After code changes: run the narrowest relevant tests, then `npm run check` when the environment allows.
- Update `docs/STATUS.md` and `CHANGELOG.md` when the product version or behaviour changes. Do **not** create or revive `CHANGELOG.md` (retired; history lives only in `CHANGELOG.md`).
- **Product version.** Single source of truth: `APP_VERSION` in `src/config.ts`, kept equal to `package.json` `"version"`. Enforced by `scripts/check-version.mjs`. Do not require version stamps in README or deploy markdown. Operator deploy: `docs/DEPLOY.md`.

## 6. Safety and honesty

- Prefer failing a check over claiming success without evidence.
- Record environment limits (missing packages, no DB, no network) explicitly.
- Security, auth, and permission changes require owner review.

## 7. Token economy of the development agent

Goal: fewest tokens, time, and tool calls that still give a correct, tested, safe result. Economy never replaces a required test or a correct answer.

- **Read narrowly.** Read first only what the task names plus the files you will change.
- **Ask once.** Ask only questions that block the start, in one message.
- **Act, do not narrate.** No plans or recaps unless the owner asks.
- **Test in order.** Narrowest test first, then full `npm run check` once when possible.
- **Do not repeat output.** Name files and results in one or two lines.
- **Stay in scope.** Change only authorised files.
- **Deliver small.** Archive holds only changed and new files.
- **Honest limits.** If a command could not run, say so in one line.

## 8. Delegation of decisions

- **Tier 0:** Act (routine implementation inside authorised scope).
- **Tier 1:** Decide and disclose (local design choices that do not change product contract).
- **Tier 2:** Prepare a decision for the Navigator (product scope, security gates, external integrations).
- **Tier 3:** Never decide alone — merge to production, GitHub App write rights, billing, secrets, formal acceptance (MANUAL1), waiving gates.

Silence is never consent in Tiers 2 and 3.

## 9. Changing this file

A change to `AGENTS.md` is a policy change and requires owner review in the same patch that edits it.
