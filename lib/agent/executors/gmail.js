/**
 * Gmail executor: semantically named Gmail actions backed by the gog CLI.
 * Translates structured args → gog argv, then delegates to the gog spawn logic.
 * Actions: list_emails, read_email, search_inbox, send_email, reply_email,
 *          archive, trash, mark_read, label_email, summarize_inbox.
 */

import { readFileSync } from 'fs';
import { getConfigPath } from '../../util/paths.js';
import { resolveAccount } from '../../util/credential-utils.js';
import { runCliAsExecutor } from './spawn-with-timeout.js';

const MAX_OUTPUT_CHARS = 16_000;

function getDefaultAccount() {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const config = JSON.parse(raw);
    const account = config?.skills?.gog?.account || config?.skills?.gmail?.account;
    if (account && typeof account === 'string' && account.trim()) return account.trim();
    if (process.env.GOG_ACCOUNT) return process.env.GOG_ACCOUNT;
  } catch (_) {}
  return '';
}

function runGog(argv, account, cwd) {
  const env = { ...process.env };
  const pathSep = process.platform === 'win32' ? ';' : ':';
  env.PATH = ['/opt/homebrew/bin', '/usr/local/bin'].join(pathSep) + pathSep + (env.PATH || '');
  const acc = resolveAccount(account, getDefaultAccount);
  if (acc) env.GOG_ACCOUNT = acc;
  return runCliAsExecutor('gog', argv, {
    cwd: cwd || process.cwd(),
    env,
    maxOutputChars: MAX_OUTPUT_CHARS,
  });
}

function idsToQueryParts(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return '';
  return ids.map((id) => `rfc822msgid:${id}`).join(' OR ');
}

/**
 * @param {object} ctx
 * @param {object} args
 * @param {string} toolName - e.g. gmail_list_emails
 */
export async function executeGmail(ctx, args, toolName) {
  const action = (toolName || '').replace(/^gmail_/, '') || (args?.action && String(args.action).trim());
  if (!action) return JSON.stringify({ error: 'action required' });

  const account = args?.account?.trim() || '';
  const cwd = ctx?.workspaceDir || process.cwd();

  switch (action) {

    case 'list_emails': {
      const label = (args?.label?.trim() || 'INBOX').toUpperCase();
      const max = Math.min(200, Math.max(1, Number(args?.max) || 20));
      const query = args?.query?.trim() || '';
      const argv = ['gmail', 'search', `in:${label}`, ...(query ? [query] : []),
        '--max', String(max), '--json', '--no-input'];
      return runGog(argv, account, cwd);
    }

    case 'read_email': {
      const id = args?.id?.trim();
      if (!id) return JSON.stringify({ error: 'id required' });
      const argv = ['gmail', 'read', id, '--json', '--no-input'];
      return runGog(argv, account, cwd);
    }

    case 'search_inbox': {
      const query = args?.query?.trim();
      if (!query) return JSON.stringify({ error: 'query required' });
      const max = Math.min(500, Math.max(1, Number(args?.max) || 50));
      const argv = ['gmail', 'search', query, '--max', String(max), '--json', '--no-input'];
      return runGog(argv, account, cwd);
    }

    case 'send_email': {
      if (args?.confirm !== true) {
        return JSON.stringify({ error: 'Confirmation required. Ask the user to confirm before sending email. Set confirm: true to proceed.' });
      }
      const to = args?.to?.trim();
      const subject = args?.subject?.trim();
      const body = args?.body?.trim();
      if (!to || !subject || !body) return JSON.stringify({ error: 'to, subject, and body are all required' });
      const argv = ['gmail', 'send', '--to', to, '--subject', subject, '--body', body,
        ...(args?.cc?.trim() ? ['--cc', args.cc.trim()] : []),
        '--json', '--no-input'];
      return runGog(argv, account, cwd);
    }

    case 'reply_email': {
      if (args?.confirm !== true) {
        return JSON.stringify({ error: 'Confirmation required. Ask the user to confirm before sending a reply. Set confirm: true to proceed.' });
      }
      const id = args?.id?.trim();
      const body = args?.body?.trim();
      if (!id || !body) return JSON.stringify({ error: 'id and body are required' });
      const argv = ['gmail', 'reply', id, '--body', body, '--json', '--no-input'];
      return runGog(argv, account, cwd);
    }

    case 'archive': {
      const ids = args?.ids;
      const query = args?.query?.trim() || '';

      // "archive inbox" special case
      if (ids === 'inbox' || (Array.isArray(ids) && ids[0] === 'inbox')) {
        const argv = ['gmail', 'archive', '--query', 'in:inbox', '--json', '--no-input'];
        return runGog(argv, account, cwd);
      }

      let q = query;
      if (Array.isArray(ids) && ids.length > 0) {
        q = idsToQueryParts(ids);
      }
      if (!q) return JSON.stringify({ error: 'ids or query required to archive messages' });
      const argv = ['gmail', 'archive', '--query', q, '--json', '--no-input'];
      return runGog(argv, account, cwd);
    }

    case 'trash': {
      const ids = args?.ids;
      const query = args?.query?.trim() || '';
      let q = query;
      if (Array.isArray(ids) && ids.length > 0) q = idsToQueryParts(ids);
      if (!q) return JSON.stringify({ error: 'ids or query required to trash messages' });
      const argv = ['gmail', 'trash', '--query', q, '--json', '--no-input'];
      return runGog(argv, account, cwd);
    }

    case 'mark_read': {
      const ids = args?.ids;
      const query = args?.query?.trim() || '';
      let q = query || 'is:unread in:inbox';
      if (Array.isArray(ids) && ids.length > 0) q = idsToQueryParts(ids);
      const argv = ['gmail', 'mark-read', '--query', q, '--json', '--no-input'];
      return runGog(argv, account, cwd);
    }

    case 'label_email': {
      const ids = args?.ids;
      if (!Array.isArray(ids) || ids.length === 0) return JSON.stringify({ error: 'ids array required' });
      const addLabels = Array.isArray(args?.add_labels) ? args.add_labels : [];
      const removeLabels = Array.isArray(args?.remove_labels) ? args.remove_labels : [];
      const argv = ['gmail', 'label', '--ids', ids.join(','),
        ...(addLabels.length > 0 ? ['--add', addLabels.join(',')] : []),
        ...(removeLabels.length > 0 ? ['--remove', removeLabels.join(',')] : []),
        '--json', '--no-input'];
      return runGog(argv, account, cwd);
    }

    case 'summarize_inbox': {
      const max = Math.min(500, Math.max(1, Number(args?.max) || 100));
      const query = args?.query?.trim() || 'is:unread in:inbox';
      const argv = ['gmail', 'search', query, '--max', String(max), '--json', '--no-input'];
      const raw = await runGog(argv, account, cwd);
      // Return raw result; agent summarizes from the JSON data
      return raw;
    }

    default:
      return JSON.stringify({ error: `Unknown Gmail action: ${action}` });
  }
}
