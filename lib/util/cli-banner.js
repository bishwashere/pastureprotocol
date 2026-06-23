/**
 * Pasture Protocol interactive CLI banner (setup, skills wizard, install/remove prompts).
 * Skip with PASTURE_NO_BANNER=1 or when tests inject ask/promptSecret deps.
 */

const BANNER_LINES = [
  '   ┌────────────────────────────────────────────────────────────────┐',
  '   │   ██████╗  █████╗ ███████╗████████╗██╗   ██╗██████╗ ███████╗   │',
  '   │   ██╔══██╗██╔══██╗██╔════╝╚══██╔══╝██║   ██║██╔══██╗██╔════╝   │',
  '   │   ██████╔╝███████║███████╗   ██║   ██║   ██║██████╔╝█████╗     │',
  '   │   ██╔═══╝ ██╔══██║╚════██║   ██║   ██║   ██║██╔══██╗██╔══╝     │',
  '   │   ██║     ██║  ██║███████║   ██║   ╚██████╔╝██║  ██║███████╗   │',
  '   │   ╚═╝     ╚═╝  ╚═╝╚══════╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚══════╝   │',
  '   │                                                                │',
  '   │                        P R O T O C O L                         │',
  '   └────────────────────────────────────────────────────────────────┘',
  '        Agent ↔ Delegation ↔ State ↔ Autonomy',
];

export const CLI_BANNER = BANNER_LINES.join('\n');

let sessionActive = false;

/** @param {{ suppressBanner?: boolean, ask?: Function, promptSecret?: Function }} [deps] */
export function shouldShowCliBanner(deps = {}) {
  if (process.env.PASTURE_NO_BANNER === '1') return false;
  if (!process.stdout.isTTY) return false;
  if (deps.suppressBanner) return false;
  if (deps.ask || deps.promptSecret) return false;
  return true;
}

export function printCliBanner() {
  console.log(CLI_BANNER);
}

/** Print banner once at the start of an interactive CLI session. */
export function beginCliSession(deps = {}) {
  if (!shouldShowCliBanner(deps)) return;
  if (sessionActive) return;
  sessionActive = true;
  printCliBanner();
  console.log('');
}

/** Re-print banner at the top of a menu loop while the session is active. */
export function refreshCliBanner(deps = {}) {
  if (!shouldShowCliBanner(deps)) return;
  if (!sessionActive) sessionActive = true;
  console.log('');
  printCliBanner();
  console.log('');
}

export function endCliSession() {
  sessionActive = false;
}

export function isCliSessionActive() {
  return sessionActive;
}
