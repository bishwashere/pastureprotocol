#!/usr/bin/env node
import { skipFakeCounterpart } from '../skip-fake-counterpart.js';

skipFakeCounterpart('dashboard-browser-e2e', 'scripts/test/e2e/real/dashboard/test-dashboard-browser-e2e.js');
