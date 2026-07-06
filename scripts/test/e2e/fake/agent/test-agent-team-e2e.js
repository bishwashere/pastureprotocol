#!/usr/bin/env node
import { skipFakeCounterpart } from '../skip-fake-counterpart.js';

skipFakeCounterpart('agent-team-e2e', 'scripts/test/e2e/real/agent/test-agent-team-e2e.js');
