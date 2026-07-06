#!/usr/bin/env node
import { skipFakeCounterpart } from '../skip-fake-counterpart.js';

skipFakeCounterpart('browser-e2e', 'scripts/test/e2e/real/skills/test-browser-e2e.js');
