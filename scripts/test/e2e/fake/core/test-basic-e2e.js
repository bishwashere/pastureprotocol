#!/usr/bin/env node
import { skipFakeCounterpart } from '../skip-fake-counterpart.js';

skipFakeCounterpart('basic-e2e', 'scripts/test/e2e/real/core/test-basic-e2e.js');
