import assert from 'assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const stateDir = mkdtempSync(join(tmpdir(), 'pasture-identity-sync-'));
process.env.PASTURE_STATE_DIR = stateDir;

const { syncMainAgentIdentityFromWorkspace, syncMainAgentIdentityFileFromWorkspace } = await import('../../../../lib/agent/identity-sync.js');

mkdirSync(join(stateDir, 'workspace'), { recursive: true });
mkdirSync(join(stateDir, 'agents', 'main', 'workspace'), { recursive: true });

const globalWhoAmI = 'Your name is Pasture.';
const mainWhoAmIPath = join(stateDir, 'agents', 'main', 'workspace', 'WhoAmI.md');

writeFileSync(join(stateDir, 'workspace', 'WhoAmI.md'), globalWhoAmI, 'utf8');
writeFileSync(mainWhoAmIPath, 'Your name is CowCode.', 'utf8');

const first = syncMainAgentIdentityFileFromWorkspace('WhoAmI.md');
assert.equal(first.ok, true);
assert.equal(first.changed, true);
assert.equal(readFileSync(mainWhoAmIPath, 'utf8'), globalWhoAmI);

writeFileSync(join(stateDir, 'workspace', 'MyHuman.md'), 'Human context', 'utf8');
const skipped = syncMainAgentIdentityFileFromWorkspace('MyHuman.md');
assert.equal(skipped.skipped, true);
assert.equal(skipped.reason, 'not_synced_file');

const second = syncMainAgentIdentityFromWorkspace();
assert.equal(second.length, 1);
assert.equal(second[0].ok, true);
assert.equal(second[0].changed, false);

console.log('identity sync tests passed');
