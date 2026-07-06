#!/usr/bin/env node
import { skipFakeCounterpart } from '../skip-fake-counterpart.js';

skipFakeCounterpart('home-assistant-e2e', 'scripts/test/e2e/real/skills/test-home-assistant-e2e.js');
