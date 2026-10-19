# BiForge — STATUS

> The single authoritative progress file. Updated: 2026-10-19 · **v55**  
> Canonical documentation: English set under `docs/` (this repository).

## 1. Current status

| Workstream | Status |
| --- | --- |
| **Version** | **55** (`APP_VERSION`, `package.json`) |
| **Documentation** | **Canonical English set adopted** (this patch). Retired Russian TZ and historical P*-SPEC/REPORT removed from the repository (owner local archives only). |
| **Modes** | Simple / Expert / Project implemented in tree |
| **Code Delivery** | `model_patch`; runtime env-gated; GitHub write deferred |
| **QA** | Offline suite present; full `npm ci` / `check` / MANUAL1 not fully verified in the documentation audit environment |
| **Open product gaps** | See `docs/12-Documentation-Migration-and-Open-Decisions.md` and section 3 below |

## 2. Next (owner-driven)

| # | Item | Notes |
| --- | --- | --- |
| 1 | Restore full dependency install | `npm ci` from `package-lock.json` in an environment with registry access |
| 2 | Green `npm run check` and `npm run build` | Fix only issues confirmed after dependencies are present |
| 3 | PostgreSQL migrations + contract tests | Requires `DATABASE_URL` |
| 4 | MANUAL1 | Full owner acceptance (Simple / Expert / Project, Drive, delivery) |
| 5 | ADR-12 decision | Implement server-side archive unpack **or** formally amend to browser-only Workspace |
| 6 | Production deploy confirmation | Whether v55 is live; GitHub App remains read-only until authorised |

Do not start a new feature patch until the owner commands it. Prefer environment restoration and verification over new scope.

## 3. Open decisions (summary)

1. ADR-12: server unpack vs amend.  
2. Model registry: code-defined vs persisted.  
3. Simple → Project import: implement or defer.  
4. GitHub write / PR creation: when and for which repos.  
5. Provider cascade expansion: remain deferred after MANUAL1?  
6. Formal close of security/backup gates (G0–G4).

Details: `docs/12-Documentation-Migration-and-Open-Decisions.md`, `docs/13-Implementation-Roadmap.md`.

## 4. Requires explicit owner authorisation

Server-side code execution beyond current gates; GitHub App write; production secrets rotation; claiming MANUAL1 passed without owner evidence.

---

*STATUS — keep this file short. History lives in local archives and in `CHANGELOG.md` / `CHANGELOG_AGENT_BEHAVIOR.md`.*
