# Bifurcation Engine v15 deployment

## Google Drive P0
1. Enable Google Drive API in Google Cloud.
2. Create an OAuth 2.0 Web Client ID and add the production origin to Authorized JavaScript origins.
3. Set `VITE_GOOGLE_CLIENT_ID` in the Railway environment.
4. Because `VITE_*` is embedded at build time, rebuild/redeploy after changing it.
5. Configure OAuth consent/test users as required by the Google Cloud publication mode.
6. In v15 the Drive status is **not** derived from the token. The app verifies OAuth, Drive API access, appDataFolder library bootstrap, write and read-back before reporting connected.
7. The library is stored in Google's application-data area and may not appear in the normal My Drive file list.

Do not put OAuth client secrets in `VITE_*`. The Client ID is public frontend configuration.

## Failure semantics
`MISSING_CONFIG`, `GIS_MISSING`, `OAUTH_DENIED`, API/permission errors, write/read-back failures and conflicts remain diagnosable. Local/session cache is retained on failure.
