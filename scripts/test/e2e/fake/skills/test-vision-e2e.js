#!/usr/bin/env node
import { skipFakeCounterpart } from '../skip-fake-counterpart.js';

skipFakeCounterpart('vision-e2e', 'scripts/test/e2e/real/skills/test-vision-e2e.js');
