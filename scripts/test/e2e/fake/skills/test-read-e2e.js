#!/usr/bin/env node
import { skipFakeCounterpart } from '../skip-fake-counterpart.js';

skipFakeCounterpart('read-e2e', 'scripts/test/e2e/real/skills/test-read-e2e.js');
