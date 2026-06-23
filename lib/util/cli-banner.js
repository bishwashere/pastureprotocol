/**
 * Pasture Protocol interactive CLI banner.
 * Shown for pasture subcommands and subprocess CLIs (setup, auth, skills wizard, logs, …).
 * Skip with PASTURE_NO_BANNER=1 or when tests inject ask/promptSecret deps.
 */

/** Subcommands handled in cli.js that show the banner at entry. */
export const PASTURE_CLI_SUBS = new Set([
  'auth',
  'start',
  'stop',
  'status',
  'restart',
  'logs',
  'dashboard',
  'update',
  'avatars',
  'uninstall',
  'tide',
  'index',
  'create',
  'delete',
  'server',
  'skills',
  'add',
  'remove',
]);

/** Subcommands that spawn a child script which prints the banner at its own entry. */
const SUBPROCESS_CLI_ENTRY = new Set(['setup', 'auth', 'tide', 'index']);

/**
 * Whether cli.js should print the banner before handling this invocation.
 * @param {string|undefined} sub
 * @param {string[]} [args]
 */
export function shouldBannerAtCliEntry(sub, args = []) {
  if (!sub) return false;
  if (SUBPROCESS_CLI_ENTRY.has(sub)) return false;
  if (sub === 'skills' && !(args[1] || '').toLowerCase()) return false;
  return PASTURE_CLI_SUBS.has(sub);
}

/** Print banner at cli.js entry when this invocation is a pasture CLI command. */
export function maybeBeginCliSession(sub, args = []) {
  if (shouldBannerAtCliEntry(sub, args)) beginCliSession();
}

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

export function endCliSession() {
  sessionActive = false;
}

export function isCliSessionActive() {
  return sessionActive;
}
