#!/usr/bin/env node
import { skipFakeCounterpart } from '../skip-fake-counterpart.js';

skipFakeCounterpart('gog-e2e', 'scripts/test/e2e/real/skills/test-gog-e2e.js');
