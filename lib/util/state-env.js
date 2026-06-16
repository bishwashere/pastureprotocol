/**
 * Reload ~/.pasture/.env into process.env so setup changes apply without restart.
 */
import dotenv from 'dotenv';
import { getEnvPath } from './paths.js';

export function refreshStateEnv() {
  dotenv.config({ path: getEnvPath(), override: true });
}
