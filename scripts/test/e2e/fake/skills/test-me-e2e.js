#!/usr/bin/env node
import { runNamedFakeE2E } from '../fake-app-e2e.js';

await runNamedFakeE2E('me-e2e');
