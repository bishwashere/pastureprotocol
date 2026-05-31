#!/usr/bin/env node
import {
  parseInternalPairJid,
  extractProjectContext,
  buildTurnStartInboxDetails,
  buildTurnDoneInboxDetails,
  buildDelegationStartInboxDetails,
} from '../../lib/team-inbox.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run() {
  assert(parseInternalPairJid('internal:main->marketer')?.fromAgentId === 'main', 'parse from');
  assert(parseInternalPairJid('internal:main->marketer')?.toAgentId === 'marketer', 'parse to');
  assert(extractProjectContext('blog ideas for nextpostai.com') === 'Project = nextpostai.com', 'extract project');

  const start = buildTurnStartInboxDetails({
    userText: 'What can be 3 blog ideas for marketting nextpostai.com',
    ctx: { jid: 'internal:main->marketer' },
  });
  assert(start.inbox.kind === 'received_from', 'received_from kind');
  assert(start.inbox.fromAgentId === 'main', 'from main');
  assert(start.inbox.context === 'Project = nextpostai.com', 'context on start');

  const done = buildTurnDoneInboxDetails({
    textToSend: '[CowCode] 1) Idea A\n2) Idea B',
    skillsCalled: ['search', 'memory'],
    ctx: { jid: 'internal:main->marketer' },
  });
  assert(done.inbox.kind === 'returned_to', 'returned_to kind');
  assert(done.inbox.toAgentId === 'main', 'return to main');
  assert(done.inbox.skills.join(',') === 'search,memory', 'skills on done');

  const delegated = buildDelegationStartInboxDetails({
    message: 'What can be 3 blog ideas for nextpostai.com',
    callerAgentId: 'main',
    targetAgentId: 'marketer',
  });
  assert(delegated.inbox.kind === 'delegated_to', 'delegated_to kind');
  assert(delegated.inbox.context === 'Project = nextpostai.com', 'delegation context');

  console.log('team-inbox tests passed');
}

run();
