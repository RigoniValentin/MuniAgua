import { describe, it, expect } from 'vitest';
import {
  DELIVERY_DAY_LABEL,
  DELIVERY_ZONES,
  ZONE_CODES,
} from '../src/modules/delivery-zones/delivery-zones.constants';
import {
  deliveryDaysFor,
  isKnownZone,
  weekdayInTimeZone,
  weekdayLabel,
  zoneDeliversOn,
  zonesForDate,
  zonesForWeekday,
} from '../src/modules/delivery-zones/delivery-zones.helpers';

describe('delivery-zones constants', () => {
  it('declares ZONA 1 = L/X/V and ZONA 2 = M/J/S', () => {
    expect([...DELIVERY_ZONES['ZONA 1'].deliveryDays]).toEqual([1, 3, 5]);
    expect([...DELIVERY_ZONES['ZONA 2'].deliveryDays]).toEqual([2, 4, 6]);
    expect(ZONE_CODES).toEqual(['ZONA 1', 'ZONA 2']);
  });

  it('exposes a label for every weekday', () => {
    for (let d = 0; d <= 6; d++) {
      expect(DELIVERY_DAY_LABEL[d as 0]).toBeTruthy();
    }
  });
});

describe('isKnownZone', () => {
  it('accepts known codes', () => {
    expect(isKnownZone('ZONA 1')).toBe(true);
    expect(isKnownZone('ZONA 2')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isKnownZone(null)).toBe(false);
    expect(isKnownZone(undefined)).toBe(false);
    expect(isKnownZone('')).toBe(false);
    expect(isKnownZone('ZONA 3')).toBe(false);
    expect(isKnownZone('zona 1')).toBe(false);
  });
});

describe('zoneDeliversOn / deliveryDaysFor', () => {
  it('ZONA 1 delivers on Mon/Wed/Fri and nowhere else', () => {
    expect(zoneDeliversOn('ZONA 1', 1)).toBe(true);
    expect(zoneDeliversOn('ZONA 1', 3)).toBe(true);
    expect(zoneDeliversOn('ZONA 1', 5)).toBe(true);
    expect(zoneDeliversOn('ZONA 1', 0)).toBe(false);
    expect(zoneDeliversOn('ZONA 1', 2)).toBe(false);
    expect(zoneDeliversOn('ZONA 1', 4)).toBe(false);
    expect(zoneDeliversOn('ZONA 1', 6)).toBe(false);
  });

  it('ZONA 2 delivers on Tue/Thu/Sat and nowhere else', () => {
    expect(zoneDeliversOn('ZONA 2', 2)).toBe(true);
    expect(zoneDeliversOn('ZONA 2', 4)).toBe(true);
    expect(zoneDeliversOn('ZONA 2', 6)).toBe(true);
    expect(zoneDeliversOn('ZONA 2', 0)).toBe(false);
    expect(zoneDeliversOn('ZONA 2', 1)).toBe(false);
  });

  it('returns false for unknown zones and nulls', () => {
    expect(zoneDeliversOn(null, 1)).toBe(false);
    expect(zoneDeliversOn('ZONA 3', 1)).toBe(false);
  });

  it('deliveryDaysFor mirrors the constants', () => {
    expect([...deliveryDaysFor('ZONA 1')]).toEqual([1, 3, 5]);
    expect([...deliveryDaysFor('ZONA 2')]).toEqual([2, 4, 6]);
    expect([...deliveryDaysFor(null)]).toEqual([]);
  });
});

describe('zonesForWeekday', () => {
  it('returns only ZONA 1 on Mon/Wed/Fri', () => {
    expect(zonesForWeekday(1)).toEqual(['ZONA 1']);
    expect(zonesForWeekday(3)).toEqual(['ZONA 1']);
    expect(zonesForWeekday(5)).toEqual(['ZONA 1']);
  });

  it('returns only ZONA 2 on Tue/Thu/Sat', () => {
    expect(zonesForWeekday(2)).toEqual(['ZONA 2']);
    expect(zonesForWeekday(4)).toEqual(['ZONA 2']);
    expect(zonesForWeekday(6)).toEqual(['ZONA 2']);
  });

  it('returns empty on Sunday', () => {
    expect(zonesForWeekday(0)).toEqual([]);
  });
});

describe('weekdayLabel', () => {
  it('uses the Spanish label for valid weekdays', () => {
    expect(weekdayLabel(1)).toBe('Lunes');
    expect(weekdayLabel(3)).toBe('Miércoles');
    expect(weekdayLabel(0)).toBe('Domingo');
  });

  it('falls back gracefully for invalid inputs', () => {
    expect(weekdayLabel(-1)).toBe('Día -1');
    expect(weekdayLabel(7)).toBe('Día 7');
  });
});

describe('weekdayInTimeZone', () => {
  it('returns the weekday in the requested timezone', () => {
    // Pick a moment that is Sunday in AR but already Monday in UTC
    // (ART = UTC-3). 2024-06-09T22:00 ART = 2024-06-10T01:00 UTC.
    const lateSundayArt = new Date('2024-06-10T01:00:00Z');
    expect(weekdayInTimeZone(lateSundayArt, 'America/Argentina/Buenos_Aires')).toBe(0);
    expect(weekdayInTimeZone(lateSundayArt, 'UTC')).toBe(1);

    // A canonical Wednesday afternoon: identical weekday in both zones,
    // showing the helper isn't always crossing the day boundary.
    const wedAfternoon = new Date('2024-06-12T18:00:00Z');
    expect(weekdayInTimeZone(wedAfternoon, 'America/Argentina/Buenos_Aires')).toBe(3);
    expect(weekdayInTimeZone(wedAfternoon, 'UTC')).toBe(3);
  });

  it('falls back to getDay() for unknown zones', () => {
    const d = new Date('2024-06-10T12:00:00Z');
    expect(weekdayInTimeZone(d, 'Atlantis/Avalon')).toBe(d.getDay());
  });
});

describe('zonesForDate', () => {
  it('produces an empty zones list on Sunday and labels it "Domingo"', () => {
    // 2024-06-09 is a Sunday.
    const sunday = new Date('2024-06-09T15:00:00Z');
    const ctx = zonesForDate(sunday, 'America/Argentina/Buenos_Aires');
    expect(ctx.weekday).toBe(0);
    expect(ctx.weekdayLabel).toBe('Domingo');
    expect(ctx.zones).toEqual([]);
  });

  it('produces [ZONA 1] on Wednesday', () => {
    // 2024-06-12 is a Wednesday.
    const wed = new Date('2024-06-12T15:00:00Z');
    const ctx = zonesForDate(wed, 'America/Argentina/Buenos_Aires');
    expect(ctx.weekday).toBe(3);
    expect(ctx.weekdayLabel).toBe('Miércoles');
    expect(ctx.zones).toEqual(['ZONA 1']);
  });

  it('produces [ZONA 2] on Tuesday regardless of host TZ', () => {
    // 2024-06-11 is a Tuesday.
    const tue = new Date('2024-06-11T23:00:00Z');
    const ctx = zonesForDate(tue, 'America/Argentina/Buenos_Aires');
    expect(ctx.weekday).toBe(2);
    expect(ctx.zones).toEqual(['ZONA 2']);
  });
});
