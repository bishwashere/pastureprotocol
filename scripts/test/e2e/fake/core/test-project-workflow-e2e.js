#!/usr/bin/env node
import { skipFakeCounterpart } from '../skip-fake-counterpart.js';

skipFakeCounterpart('project-workflow-e2e', 'scripts/test/e2e/real/core/test-project-workflow-e2e.js');
