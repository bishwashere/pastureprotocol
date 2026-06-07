#!/usr/bin/env node
/**
 * Backfill agent profile pictures.
 *
 * Iterates every visible agent and generates a DALL·E avatar for any that
 * do not already have one saved to disk.  Skips generation when the OpenAI
 * key is not configured.  Safe to re-run: existing avatar.png files are
 * never overwritten.
 *
 * Usage:
 *   node scripts/backfill-agent-avatars.js
 *   pasture avatars
 */

import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = process.env.PASTURE_INSTALL_DIR
  ? resolve(process.env.PASTURE_INSTALL_DIR)
  : resolve(__dirname, '..');

// Load env from state dir so API keys are available.
const { getEnvPath } = await import(join(INSTALL_DIR, 'lib', 'paths.js'));
dotenv.config({ path: getEnvPath() });

const { listVisibleAgentIds, getAgentTitle } = await import(join(INSTALL_DIR, 'lib', 'agent-config.js'));
const { generateAndSaveAgentAvatar, hasAgentAvatar } = await import(join(INSTALL_DIR, 'lib', 'agent-avatar.js'));

async function main() {
  const ids = listVisibleAgentIds();
  const missing = ids.filter((id) => !hasAgentAvatar(id));

  if (missing.length === 0) {
    console.log('[avatars] All agents already have a profile picture.');
    return;
  }

  console.log(`[avatars] Generating profile pictures for ${missing.length} agent(s): ${missing.join(', ')}`);

  for (const id of missing) {
    const title = getAgentTitle(id) || id;
    process.stdout.write(`[avatars]   ${id} (${title}) … `);
    const result = await generateAndSaveAgentAvatar(id, title);
    if (result) {
      process.stdout.write('✓\n');
    } else {
      process.stdout.write('skipped (no key or error)\n');
    }
  }

  console.log('[avatars] Done.');
}

main().catch((err) => {
  console.error('[avatars] Fatal error:', err?.message || err);
  process.exit(1);
});
