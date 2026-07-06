#!/usr/bin/env node
import { skipFakeCounterpart } from '../skip-fake-counterpart.js';

skipFakeCounterpart('server-inspect-e2e', 'scripts/test/e2e/real/skills/test-server-inspect-e2e.js');
