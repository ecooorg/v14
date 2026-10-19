/**
 * P53 / ADR-06 Amendment 1: what Project Mode can do on this server. Pure: no database, no network.
 * Booleans only: never a variable value, never a secret.
 *  - programZip: `CODE_EXECUTOR=model_patch` (small program as a validated ZIP; nothing is run on the server).
 *  - manualDelivery.githubRead: a GitHub App is configured, so BiForge can read a PR / branch / checks.
 *  - githubWrite: the single write switch `GITHUB_DIFF_UPLOAD=true`. `model_patch` alone never turns it on.
 */
import { githubWritesEnabled } from './githubIntegration.ts';

export interface ProjectCapabilities {
  analysis: true;
  plans: true;
  programZip: boolean;
  manualDelivery: { githubRead: boolean };
  githubWrite: boolean;
}

export function projectCapabilities(input: { env?: NodeJS.ProcessEnv; githubConfigured: boolean }): ProjectCapabilities {
  const env = input.env ?? process.env;
  return {
    analysis: true,
    plans: true,
    programZip: env.CODE_EXECUTOR === 'model_patch',
    manualDelivery: { githubRead: Boolean(input.githubConfigured) },
    // Same rule as githubWritesEnabled(), evaluated against the given env so the matrix can be tested.
    githubWrite: env === process.env ? githubWritesEnabled() : env.GITHUB_DIFF_UPLOAD === 'true',
  };
}
