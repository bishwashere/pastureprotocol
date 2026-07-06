#!/usr/bin/env node
import { skipFakeCounterpart } from '../skip-fake-counterpart.js';

skipFakeCounterpart('casual-greetings-e2e', 'scripts/test/e2e/real/agent/test-casual-greetings.js');
