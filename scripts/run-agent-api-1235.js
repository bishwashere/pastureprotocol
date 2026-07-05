#!/usr/bin/env node
process.env.PASTURE_AGENT_API_PORT = process.env.PASTURE_AGENT_API_PORT || '1235';
await import('./agent-api-server.js');
