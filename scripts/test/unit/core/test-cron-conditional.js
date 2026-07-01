#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-cron-conditional-'));
  const storePath = join(stateDir, 'cron', 'jobs.json');
  try {
    const { executeCron } = await import('../../../../lib/agent/executors/cron.js');
    const { loadJobs } = await import('../../../../cron/store.js');
    const { isEmptyPollResponse, runConditionalJob } = await import('../../../../cron/conditional.js');

    assert(isEmptyPollResponse([]), 'empty array is empty');
    assert(isEmptyPollResponse({}), 'empty object is empty');
    assert(isEmptyPollResponse(null), 'null is empty');
    assert(isEmptyPollResponse(''), 'empty string is empty');
    assert(!isEmptyPollResponse([{ sku: 'macmini' }]), 'non-empty array is not empty');

    await executeCron(
      { storePath, jid: '7656021862', scheduleOneShot: () => {}, startCron: () => {} },
      {
        action: 'add',
        job: {
          name: 'Mac mini restock',
          message: "Check macmini restock (notify ONLY if non-empty): curl 'http://localhost.test/restock'",
          schedule: { kind: 'cron', expr: '*/20 * * * * *', tz: 'America/New_York' },
          notifyWhen: 'non_empty_response',
          url: 'http://localhost.test/restock',
          label: 'Mac mini restock',
        },
      },
    );

    const [job] = loadJobs(storePath);
    assert(job?.conditional?.notifyWhen === 'non_empty_response', 'conditional notifyWhen persisted');
    assert(job?.conditional?.url === 'http://localhost.test/restock', 'conditional URL persisted');
    assert(job?.schedule?.expr === '*/20 * * * * *', 'second-level cron expr persisted');

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '[]',
      });
      const emptyText = await runConditionalJob(job);
      assert(emptyText === '', `empty array should suppress notification, got: ${emptyText}`);

      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify([{ sku: 'macmini', status: 'in_stock' }]),
      });
      const nonEmptyText = await runConditionalJob(job);
      assert(/Mac mini restock/.test(nonEmptyText), 'non-empty response includes label');
      assert(/in_stock/.test(nonEmptyText), 'non-empty response includes payload');
    } finally {
      globalThis.fetch = originalFetch;
    }

    console.log('test-cron-conditional passed');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
