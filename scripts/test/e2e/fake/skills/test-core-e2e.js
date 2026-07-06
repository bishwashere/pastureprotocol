#!/usr/bin/env node
import { skipFakeCounterpart } from '../skip-fake-counterpart.js';

skipFakeCounterpart('core-e2e', 'scripts/test/e2e/real/skills/test-core-e2e.js');
