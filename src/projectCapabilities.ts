/**
 * P53 / ADR-06 Amendment 1 + P58 App Builder copy.
 * What the Project page tells the person about this server.
 * Plain words only: no variable names, no values.
 */
export interface Capabilities {
  analysis: boolean;
  plans: boolean;
  programZip: boolean;
  manualDelivery: { githubRead: boolean };
  githubWrite: boolean;
}

export const PROJECT_SCOPE_TEXT =
  'Project: two paths — Simple words (guided idea → ZIP) or Professional (analysis, plan, delivery). Output is a source ZIP and manual deploy steps. GitHub is read-only; BiForge never merges or deploys for you.';
export const ZIP_OFF_HINT = 'Automatic coding is switched off on this server.';

export interface CapabilityRow { label: string; on: boolean; note: string }

/** Rows for the "What is available here" block. Unknown capabilities (older server) render as "not reported". */
export function describeCapabilities(caps: Capabilities | null | undefined): CapabilityRow[] {
  if (!caps) return [{ label: 'Server features', on: false, note: 'Not reported by this server.' }];
  return [
    { label: 'Analysis', on: Boolean(caps.analysis), note: 'You confirm or reject every proposed change.' },
    { label: 'Plans and approvals', on: Boolean(caps.plans), note: 'Tasks run under your budgets.' },
    { label: 'Program as ZIP', on: Boolean(caps.programZip), note: caps.programZip ? 'Source is checked, never run on the server. Use Simple words or Create program.' : ZIP_OFF_HINT },
    { label: 'Receive results from GitHub', on: Boolean(caps.manualDelivery?.githubRead), note: caps.manualDelivery?.githubRead ? 'Needed to read a pull request or checks of a hand-off task.' : 'GitHub is not connected, so results of hand-off tasks cannot be read.' },
    { label: 'Writing to GitHub', on: Boolean(caps.githubWrite), note: caps.githubWrite ? 'Switched on by the owner.' : 'Off by design. BiForge only reads and never merges.' },
  ];
}
