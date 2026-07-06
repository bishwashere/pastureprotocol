#!/usr/bin/env node
import { skipFakeCounterpart } from '../skip-fake-counterpart.js';

skipFakeCounterpart('speech-e2e', 'scripts/test/e2e/real/skills/test-speech-e2e.js');
