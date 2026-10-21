import { getEnv } from '../../config/env.js';
import {
  REPORT_PERIOD_PRESETS,
  type ReportFilters,
  type ReportPeriodPreset,
  type ResolvedReportPeriod,
} from './reports.types.js';

/**
 * Return the integer Y/M/D/H/m/s for the given UTC `Date` rendered in the
 * given IANA timezone. Implementation-free of heavy dependencies so the
 * module stays small.
 */
function getZonedParts(date: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
} {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = formatter.formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = part.value;
    }
  }
  const weekdayMap: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  return {
    year: Number(lookup.year ?? '1970'),
    month: Number(lookup.month ?? '01'),
    day: Number(lookup.day ?? '01'),
    hour: Number((lookup.hour ?? '00').replace('24', '00')),
    minute: Number(lookup.minute ?? '00'),
    second: Number(lookup.second ?? '00'),
    weekday: weekdayMap[lookup.weekday ?? 'Mon'] ?? 1,
  };
}

/**
 * Build a UTC `Date` from year/month/day in the given timezone at
 * midnight local time. Going through `Intl.DateTimeFormat` keeps the math
 * timezone-aware without pulling in a date library.
 */
function zonedDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
): Date {
  // Strategy: compute the UTC instant that, when formatted in
  // `timezone`, displays the desired local fields. We start by assuming
  // UTC == local, then correct by the offset Intl reports.
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = getZonedParts(new Date(utcGuess), timezone);
  const reconstructedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const offset = reconstructedAsUtc - utcGuess;
  return new Date(utcGuess - offset);
}

function startOfZonedDay(date: Date, timezone: string): Date {
  const parts = getZonedParts(date, timezone);
  return zonedDate(parts.year, parts.month, parts.day, 0, 0, 0, timezone);
}

function endOfZonedDay(date: Date, timezone: string): Date {
  const parts = getZonedParts(date, timezone);
  return zonedDate(parts.year, parts.month, parts.day + 1, 0, 0, 0, timezone);
}

function parseIsoDateInTimezone(
  raw: string,
  timezone: string,
  endOfDay: boolean,
): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) {
    throw new Error(`Fecha inválida: ${raw}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (endOfDay) {
    return zonedDate(year, month, day + 1, 0, 0, 0, timezone);
  }
  return zonedDate(year, month, day, 0, 0, 0, timezone);
}

function isoDate(date: Date): string {
  const iso = date.toISOString();
  return iso.slice(0, 10);
}

const PRESET_LABEL: Record<ReportPeriodPreset, string> = {
  TODAY: 'Hoy',
  YESTERDAY: 'Ayer',
  THIS_WEEK: 'Esta semana',
  THIS_MONTH: 'Este mes',
  LAST_MONTH: 'Mes pasado',
  CUSTOM: 'Personalizado',
};

/**
 * Compute the inclusive start (00:00 local) and exclusive end (next day
 * 00:00 local) for the given period, expressed as UTC `Date` instances.
 *
 * The math is timezone-aware: a "today" call in Buenos Aires returns
 * the AR-local day even when the server clock runs in UTC.
 */
export function resolveReportPeriod(
  filters: ReportFilters,
  now: Date = new Date(),
): ResolvedReportPeriod {
  const timezone = getEnv().APP_TIMEZONE;
  const preset = filters.period;
  const todayParts = getZonedParts(now, timezone);

  if (preset === REPORT_PERIOD_PRESETS.CUSTOM) {
    if (!filters.dateFrom || !filters.dateTo) {
      throw new Error('dateFrom y dateTo son obligatorios en período personalizado');
    }
    if (filters.dateFrom > filters.dateTo) {
      throw new Error('dateFrom no puede ser mayor que dateTo');
    }
    const dateFrom = parseIsoDateInTimezone(filters.dateFrom, timezone, false);
    const dateTo = parseIsoDateInTimezone(filters.dateTo, timezone, true);
    return {
      preset,
      dateFrom,
      dateTo,
      label: `${filters.dateFrom} → ${filters.dateTo}`,
    };
  }

  const todayStart = zonedDate(
    todayParts.year,
    todayParts.month,
    todayParts.day,
    0,
    0,
    0,
    timezone,
  );

  if (preset === REPORT_PERIOD_PRESETS.TODAY) {
    return {
      preset,
      dateFrom: todayStart,
      dateTo: new Date(todayStart.getTime() + 24 * 60 * 60 * 1000),
      label: PRESET_LABEL[preset],
    };
  }
  if (preset === REPORT_PERIOD_PRESETS.YESTERDAY) {
    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    return {
      preset,
      dateFrom: yesterdayStart,
      dateTo: todayStart,
      label: PRESET_LABEL[preset],
    };
  }
  if (preset === REPORT_PERIOD_PRESETS.THIS_WEEK) {
    // ISO week: Monday 00:00 → next Monday 00:00.
    const weekday = todayParts.weekday;
    const daysFromMonday = weekday - 1;
    const mondayStart = new Date(
      todayStart.getTime() - daysFromMonday * 24 * 60 * 60 * 1000,
    );
    return {
      preset,
      dateFrom: mondayStart,
      dateTo: new Date(mondayStart.getTime() + 7 * 24 * 60 * 60 * 1000),
      label: PRESET_LABEL[preset],
    };
  }
  if (preset === REPORT_PERIOD_PRESETS.THIS_MONTH) {
    const monthStart = zonedDate(
      todayParts.year,
      todayParts.month,
      1,
      0,
      0,
      0,
      timezone,
    );
    const nextMonthStart = zonedDate(
      todayParts.month === 12 ? todayParts.year + 1 : todayParts.year,
      todayParts.month === 12 ? 1 : todayParts.month + 1,
      1,
      0,
      0,
      0,
      timezone,
    );
    return {
      preset,
      dateFrom: monthStart,
      dateTo: nextMonthStart,
      label: PRESET_LABEL[preset],
    };
  }
  if (preset === REPORT_PERIOD_PRESETS.LAST_MONTH) {
    const lastMonth = todayParts.month === 1 ? 12 : todayParts.month - 1;
    const lastMonthYear =
      todayParts.month === 1 ? todayParts.year - 1 : todayParts.year;
    const monthStart = zonedDate(lastMonthYear, lastMonth, 1, 0, 0, 0, timezone);
    const nextMonthStart = zonedDate(
      todayParts.year,
      todayParts.month,
      1,
      0,
      0,
      0,
      timezone,
    );
    return {
      preset,
      dateFrom: monthStart,
      dateTo: nextMonthStart,
      label: PRESET_LABEL[preset],
    };
  }

  // Defensive fallback — the enum should have been exhaustive.
  throw new Error(`Período no soportado: ${String(preset)}`);
}

/**
 * Convert the resolved period to the date strings shown in the UI.
 */
export function periodDateLabels(period: ResolvedReportPeriod): {
  dateFrom: string;
  dateToExclusive: string;
  displayedTo: string;
} {
  const timezone = getEnv().APP_TIMEZONE;
  const dateFrom = isoDate(period.dateFrom);
  const displayedToExclusive = isoDate(period.dateTo);
  // `dateTo` is the exclusive upper bound. Show the user the last
  // inclusive day by subtracting one day in the app timezone.
  const displayedToZoned = startOfZonedDay(period.dateTo, timezone);
  const oneDayBeforeEnd = new Date(
    displayedToZoned.getTime() - 24 * 60 * 60 * 1000,
  );
  const displayedTo = isoDate(oneDayBeforeEnd);
  return {
    dateFrom,
    dateToExclusive: displayedToExclusive,
    displayedTo,
  };
}

export { endOfZonedDay, startOfZonedDay };
