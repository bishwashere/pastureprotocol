/**
 * Home Assistant executor: re-exports from the skill's CLI layer.
 * Execution (API + token) lives in skills/home-assistant/ (ha-cli.js + executor.js).
 */

export { executeHomeAssistant } from '../../skills/home-assistant/executor.js';
