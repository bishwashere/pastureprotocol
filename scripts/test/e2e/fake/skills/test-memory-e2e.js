#!/usr/bin/env node
import { skipFakeCounterpart } from '../skip-fake-counterpart.js';

skipFakeCounterpart('memory-e2e', 'scripts/test/e2e/real/skills/test-memory-e2e.js');
