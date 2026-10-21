## v56

- **P58 Project App Builder (UI):** path chooser Simple words / Professional; novice wizard; manual deploy copy; User guide update. Simple/Expert unchanged.
- **P58 generation (server):** `/api/projects/:id/code/build` uses App Builder limits (default 80 files / 8000 lines; `CODE_APP_BUILDER_MAX_FILES` / `CODE_APP_BUILDER_MAX_LINES`). `validateChangeSet` no longer clamps package limits back to 10/400. `callCodeAuthor` uses higher output tokens and scaffold-oriented rules when limits > legacy. Generated ZIP always includes `DEPLOY-MANUAL.md`. Goal field on build accepts up to 8000 characters.
- **Still off by design:** automatic GitHub write / Render deploy; execution of generated code on the BiForge server.

## v55

- Prior release baseline (latency policy, UX friendliness). See repository history.
