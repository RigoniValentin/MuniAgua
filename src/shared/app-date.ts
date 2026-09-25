import { getEnv } from '../config/env.js';
import { zonesForDate } from '../modules/delivery-zones/delivery-zones.helpers.js';
import type { DeliveryZoneContext } from '../modules/delivery-zones/delivery-zones.types.js';

/**
 * "Today" expressed in the app's timezone, plus the active delivery-zone
 * context derived from it. Single source for "which zone is on duty today".
 */
export function getAppToday(now: Date = new Date()): DeliveryZoneContext {
  return zonesForDate(now, getEnv().APP_TIMEZONE);
}
