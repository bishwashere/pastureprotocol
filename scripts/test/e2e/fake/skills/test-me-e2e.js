#!/usr/bin/env node
import { skipFakeCounterpart } from '../skip-fake-counterpart.js';

skipFakeCounterpart('me-e2e', 'scripts/test/e2e/real/skills/test-me-e2e.js');
