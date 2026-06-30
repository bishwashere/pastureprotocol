/**
 * Compatibility wrapper.
 *
 * The turn-routing implementation lives in turn-router.js. Keep the old export
 * names so existing tests and imports continue to work during the rename.
 */

export {
  routeTurn as planIntent,
  turnRouteToSystemBlock as intentPlanToSystemBlock,
  buildCasualChatTurnRoute as buildCasualChatIntentPlan,
} from './turn-router.js';
