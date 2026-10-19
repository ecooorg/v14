# BiForge — Canonical Technical Documentation

**Documentation set:** 1.0 (canonical from documentation migration patch, 2026-10-19)  
**Product baseline:** package version **55** (`package.json`, `docs/STATUS.md`)  
**Evidence snapshot source:** `bf-main (30).zip`  
**Language:** English only (normative documentation)

## Purpose and authority

This set is the **canonical product documentation** for BiForge. It consolidates the product contract, implementation-derived behaviour, operating procedures, test evidence, unresolved gaps, and roadmap.

- Living progress pointer: [`STATUS.md`](STATUS.md)  
- Agent process rules: [`../AGENTS.md`](../AGENTS.md)  
- Onboarding: [`START_HERE.md`](START_HERE.md)

Historical Russian specifications and per-patch SPEC/REPORT files are **retired from this repository** and retained only in the owner’s local archives.

Evidence note: the original audit environment did not complete full `npm ci` / typecheck / build / MANUAL1. Individual executed checks are recorded in `09-Testing-and-Equivalence.md`. Do not treat static inventory as proof of full runtime acceptance.

## Document set

1. [`01-Product-and-System-Specification.md`](01-Product-and-System-Specification.md) — normative product scope, modes, capability boundaries, acceptance principles.
2. [`02-Architecture-and-Components.md`](02-Architecture-and-Components.md) — runtime architecture, module responsibilities, data flow.
3. [`03-API-and-Integration-Contracts.md`](03-API-and-Integration-Contracts.md) — HTTP endpoints, provider contracts, environment configuration.
4. [`04-Database-and-State-Machines.md`](04-Database-and-State-Machines.md) — schema inventory, State invariants, lifecycle machines.
5. [`05-Agent-Runtime-and-Prompt-Contracts.md`](05-Agent-Runtime-and-Prompt-Contracts.md) — mode routing, prompt assembly, analysis pipeline, model routing and budgets.
6. [`06-UI-Workspace-and-File-Handling.md`](06-UI-Workspace-and-File-Handling.md) — user flows, Workspace, files, exports and Google Drive.
7. [`07-Security-Privacy-and-Operations.md`](07-Security-Privacy-and-Operations.md) — threat model, authentication, permissions, operational controls.
8. [`08-Deployment-and-Runbook.md`](08-Deployment-and-Runbook.md) — reproducible install/build/deploy, migrations, health, rollback and backup targets.
9. [`09-Testing-and-Equivalence.md`](09-Testing-and-Equivalence.md) — executed evidence, test catalogue policy, equivalence criteria and manual acceptance.
10. [`10-Requirements-Traceability.csv`](10-Requirements-Traceability.csv) — machine-readable requirement-to-source/test mapping.
11. [`11-Repository-and-Route-Inventory.md`](11-Repository-and-Route-Inventory.md) — generated source inventory, complete registered route catalogue, environment variable inventory.
12. [`12-Documentation-Migration-and-Open-Decisions.md`](12-Documentation-Migration-and-Open-Decisions.md) — contradictions, unimplemented ADRs, supersession map, decisions required.
13. [`13-Implementation-Roadmap.md`](13-Implementation-Roadmap.md) — evidence-led sequence of next steps and release gates.

## Evidence language

- **IMPLEMENTED (static):** behaviour or structure directly located in source/configuration/migrations. This is not proof that it executes successfully.
- **TESTED (executed):** a named command was run in this environment and its recorded outcome is available.
- **DOCUMENTED ONLY:** stated in existing documentation but not confirmed from code or live evidence.
- **GAP / NOT IMPLEMENTED:** current coverage audit or code inspection indicates absent functionality.
- **NOT RUN / BLOCKED:** no valid execution evidence was obtained.
- **OWNER DECISION REQUIRED:** repository material explicitly reserves the choice to the product owner.

## Normative rule

For the *current shipped baseline*, use the implementation and migrations as the source of truth for what exists, then use this set to describe the verified contract. For product intent, retain only requirements that are implemented or explicitly marked as planned. If a normative statement conflicts with code, do not silently choose one: log the conflict and obtain a decision. See document 12.

## Reproduction limits

A source archive can support a high-fidelity rebuild, but exact production equivalence also depends on secrets, provider model versions, Google Drive OAuth configuration, GitHub App permissions, deployment settings, and human acceptance results not present in the archive. Model outputs are nondeterministic; equivalence is defined by contracts, safety invariants, observable UI/API behaviour, and acceptance tests rather than identical generated prose.
