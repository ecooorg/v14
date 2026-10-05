# Bifurcation Engine 13.1

This build intentionally preserves the v13 decision methodology. Added infrastructure only:
- password session login;
- optional Google Drive appDataFolder as primary persistence after connection.

The decision engine is in `server.ts` and the client core/storage helpers are in `engine.ts`.
