#!/usr/bin/env node
/**
 * Unit tests for go-read filesystem commands.
 *
 * These must pass without Unix shell binaries such as ls, pwd, find, sh, or du.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeGoRead, validatePackageManagerArgs } from '../../../../lib/agent/executors/go-read.js';
import { validateCreateNextAppArgs, validatePackageManagerWriteArgs } from '../../../../lib/agent/executors/go-write.js';
import { getSkillContext } from '../../../../skills/loader.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'pasture-go-read-fs-'));
  const nestedDir = join(workspaceDir, 'nested');
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(join(workspaceDir, 'alpha.txt'), 'alpha text\n', 'utf8');
  writeFileSync(join(workspaceDir, '.hidden'), 'hidden text\n', 'utf8');
  writeFileSync(join(nestedDir, 'beta.md'), '# Beta\n', 'utf8');

  const ctx = { workspaceDir };

  const pwd = await executeGoRead(ctx, { action: 'pwd', argv: [] });
  assert(pwd === workspaceDir, `expected pwd ${workspaceDir}, got ${pwd}`);

  const ls = await executeGoRead(ctx, { action: 'ls', argv: ['-la'] });
  assert(ls.includes('alpha.txt'), `expected ls to include alpha.txt, got ${ls}`);
  assert(ls.includes('.hidden'), `expected ls -a to include .hidden, got ${ls}`);
  assert(ls.includes('nested/'), `expected ls to include nested directory, got ${ls}`);

  const cat = await executeGoRead(ctx, { action: 'cat', argv: ['alpha.txt'] });
  assert(cat.trim() === 'alpha text', `expected cat output, got ${cat}`);

  const cd = await executeGoRead(ctx, { action: 'cd', argv: ['nested'] });
  assert(cd === nestedDir, `expected cd ${nestedDir}, got ${cd}`);

  const found = await executeGoRead(ctx, {
    action: 'find',
    argv: ['.', '-maxdepth', '2', '-type', 'f', '-name', '*.md', '-print'],
  });
  assert(found.includes(join(nestedDir, 'beta.md')), `expected find to locate beta.md, got ${found}`);
  assert(!found.includes('alpha.txt'), `expected find -name *.md to exclude alpha.txt, got ${found}`);

  const du = await executeGoRead(ctx, { action: 'du', argv: ['-sh', '.'] });
  assert(du.includes(workspaceDir), `expected du to include workspace path, got ${du}`);

  const npmVersion = await executeGoRead(ctx, { action: 'npm', argv: ['--version'] });
  assert(/^\d+\.\d+\.\d+/.test(npmVersion.trim()), `expected npm --version output, got ${npmVersion}`);

  const npmInstall = JSON.parse(await executeGoRead(ctx, { action: 'npm', argv: ['install'] }));
  assert(/not allowed/i.test(npmInstall.error || ''), `expected npm install to be refused, got ${JSON.stringify(npmInstall)}`);

  const npmVersionPatch = JSON.parse(await executeGoRead(ctx, { action: 'npm', argv: ['version', 'patch'] }));
  assert(/read-only/i.test(npmVersionPatch.error || ''), `expected npm version patch to be refused, got ${JSON.stringify(npmVersionPatch)}`);

  const pnpmRun = validatePackageManagerArgs('pnpm', ['run', 'test']);
  assert(pnpmRun.ok, `expected pnpm run to be allowed in go-read, got ${JSON.stringify(pnpmRun)}`);

  const npmBuild = validatePackageManagerArgs('npm', ['run', 'build']);
  assert(npmBuild.ok, `expected npm run build to be allowed in go-read, got ${JSON.stringify(npmBuild)}`);

  const npmStart = validatePackageManagerArgs('npm', ['start']);
  assert(npmStart.ok, `expected npm start to be allowed in go-read, got ${JSON.stringify(npmStart)}`);

  const writeInstall = validatePackageManagerWriteArgs('npm', ['install']);
  assert(writeInstall.ok, `expected npm install to be allowed in go-write, got ${JSON.stringify(writeInstall)}`);

  const writeRun = validatePackageManagerWriteArgs('npm', ['run', 'build']);
  assert(!writeRun.ok && /not allowed/i.test(writeRun.error || ''), `expected npm run build to be refused in go-write, got ${JSON.stringify(writeRun)}`);

  const nextApp = validateCreateNextAppArgs({
    path: 'my-personal-portfolio',
    packageManager: 'npm',
    typescript: true,
    tailwind: true,
    eslint: true,
    appRouter: true,
    srcDir: false,
    importAlias: '@/*',
  }, ctx);
  assert(nextApp.ok, `expected create_next_app args to be valid, got ${JSON.stringify(nextApp)}`);
  assert(nextApp.command === 'npx', `expected npm-backed scaffold to use npx, got ${nextApp.command}`);
  assert(nextApp.argv.includes('create-next-app@latest'), `expected create-next-app package in argv, got ${nextApp.argv.join(' ')}`);
  assert(nextApp.argv.includes('--typescript'), `expected --typescript in argv, got ${nextApp.argv.join(' ')}`);
  assert(nextApp.argv.includes('--tailwind'), `expected --tailwind in argv, got ${nextApp.argv.join(' ')}`);
  assert(nextApp.argv.includes('--app'), `expected --app in argv, got ${nextApp.argv.join(' ')}`);

  const badNextApp = validateCreateNextAppArgs({ path: 'x', packageManager: 'npx' }, ctx);
  assert(!badNextApp.ok && /packageManager/i.test(badNextApp.error || ''), `expected packageManager guard, got ${JSON.stringify(badNextApp)}`);

  const skillContext = getSkillContext({ hintSkills: ['go-write'] });
  const toolNames = skillContext.runSkillTool.map((tool) => tool?.function?.name).filter(Boolean);
  assert(toolNames.includes('go_write_create_next_app'), `expected go_write_create_next_app tool, got ${toolNames.join(', ')}`);

  const missing = JSON.parse(await executeGoRead(ctx, { action: 'ls', argv: ['missing'] }));
  assert(/not found/i.test(missing.error || ''), `expected missing path error, got ${JSON.stringify(missing)}`);

  console.log('Go-read filesystem test passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
