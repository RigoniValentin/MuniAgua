import {
  DEFAULT_APP_TIMEZONE,
  DELIVERY_DAY_LABEL,
  DELIVERY_ZONE_BY_CODE,
  DELIVERY_ZONES,
  ZONE_CODES,
} from './delivery-zones.constants.js';
import type {
  DeliveryZoneContext,
  DeliveryZoneDefinition,
  Weekday,
  ZoneCode,
} from './delivery-zones.types.js';

/** Type guard for known zone codes. Free-form strings from DB may be stale. */
export function isKnownZone(code: string | null | undefined): code is ZoneCode {
  return typeof code === 'string' && ZONE_CODES.includes(code as ZoneCode);
}

/** Returns the zone definition if `code` matches a known zone, else `null`. */
export function getZoneDefinition(
  code: string | null | undefined,
): DeliveryZoneDefinition | null {
  if (!code) return null;
  return DELIVERY_ZONE_BY_CODE.get(code) ?? null;
}

/** Set of weekdays (0..6) on which `zone` delivers. Empty for unknown zones. */
export function deliveryDaysFor(
  zone: string | null | undefined,
): readonly Weekday[] {
  const def = getZoneDefinition(zone);
  if (!def) return [];
  return def.deliveryDays;
}

/** True when `zone` delivers on the given weekday. Unknown zones return false. */
export function zoneDeliversOn(
  zone: string | null | undefined,
  weekday: Weekday,
): boolean {
  const def = getZoneDefinition(zone);
  if (!def) return false;
  return def.deliveryDays.includes(weekday);
}

/** Zones (intersected) that deliver on `weekday`. Returns empty on Sunday. */
export function zonesForWeekday(weekday: Weekday): readonly ZoneCode[] {
  const wd: Weekday = weekday;
  return ZONE_CODES.filter((code) => {
    const days = DELIVERY_ZONES[code].deliveryDays;
    return days.some((d) => d === wd);
  });
}

/**
 * Format an integer weekday (0..6) as its Spanish label.
 * Out-of-range values fall back to "Día N" to avoid silent bugs.
 */
export function weekdayLabel(weekday: number): string {
  if (weekday >= 0 && weekday <= 6) {
    return DELIVERY_DAY_LABEL[weekday as Weekday];
  }
  return `Día ${weekday}`;
}

/**
 * Compute the weekday of `date` projected onto `timeZone`, then return the
 * delivery-zone context for that weekday. Uses `Intl.DateTimeFormat` so it
 * does NOT depend on the host server's timezone — important when the app
 * runs in containers set to UTC.
 *
 * @param date   Reference instant (defaults to `new Date()`).
 * @param timeZone IANA TZ identifier. Defaults to `America/Argentina/Buenos_Aires`.
 */
export function zonesForDate(
  date: Date = new Date(),
  timeZone: string = DEFAULT_APP_TIMEZONE,
): DeliveryZoneContext {
  const weekday = weekdayInTimeZone(date, timeZone);
  const safeWeekday = (
    weekday >= 0 && weekday <= 6 ? weekday : 0
  ) as Weekday;
  return {
    today: date,
    weekday: safeWeekday,
    zones: zonesForWeekday(safeWeekday),
    weekdayLabel: weekdayLabel(safeWeekday),
  };
}

/**
 * Pure helper: given a `Date`, returns the weekday (0=Dom..6=Sáb) of the
 * wall-clock date in `timeZone`. Falls back to `getDay()` if `Intl` chokes
 * on an unknown zone (e.g. tests injecting bogus values).
 */
export function weekdayInTimeZone(date: Date, timeZone: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
    });
    const parts = fmt.formatToParts(date);
    const w = parts.find((p) => p.type === 'weekday')?.value ?? '';
    switch (w) {
      case 'Sun':
        return 0;
      case 'Mon':
        return 1;
      case 'Tue':
        return 2;
      case 'Wed':
        return 3;
      case 'Thu':
        return 4;
      case 'Fri':
        return 5;
      case 'Sat':
        return 6;
      default:
        return date.getDay();
    }
  } catch {
    return date.getDay();
  }
}
