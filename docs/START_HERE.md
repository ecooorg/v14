# START HERE

> **Progress and “what’s next”:** [`docs/STATUS.md`](./STATUS.md) only.  
> **Agent rules:** [`AGENTS.md`](../AGENTS.md).  
> **Canonical product docs:**  [`docs/README.md`](./README.md).

## In 30 seconds

1. BiForge is a decision and project agent (Node/Express + React + model providers), deployable on Railway.
2. Modes: **Simple**, **Expert**, **Project**.
3. Canonical documentation  `docs/` (`01`–`15` + STATUS).
4. Before any change: `docs/STATUS.md` → `AGENTS.md` → authorised scope → code.
5. Every patch deliverable is a ZIP of **changed/new files only** (see `AGENTS.md` §5).
6. Deploy notes: [`docs/DEPLOY.md`](./DEPLOY.md).

## Do not read everything

Long historical plans and per-patch reports are **out of the repository**. Use:

- `docs/STATUS.md` — daily pointer  
- `docs/01` … `docs/13` — current contract  
- `docs/12` — open decisions  
- Code + `migrations/` + `tests/` — implementation evidence

## Language

- Repository (code, comments, docs): English.  
- UI: English source; user may use browser translation.  
- Agent replies to the end user: language of the user’s first message.
