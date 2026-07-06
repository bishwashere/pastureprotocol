#!/usr/bin/env node
import { skipFakeCounterpart } from '../skip-fake-counterpart.js';

skipFakeCounterpart('cron-e2e', 'scripts/test/e2e/real/skills/test-cron-e2e.js');
