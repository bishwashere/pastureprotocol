#!/usr/bin/env node
import { skipFakeCounterpart } from '../skip-fake-counterpart.js';

skipFakeCounterpart('write-e2e', 'scripts/test/e2e/real/skills/test-write-e2e.js');
