#!/usr/bin/env node
import { skipFakeCounterpart } from '../skip-fake-counterpart.js';

skipFakeCounterpart('agent', 'scripts/test/e2e/real/agent/test-agent.js');
