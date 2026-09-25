import type {
  DeliveryZoneDefinition,
  Weekday,
  ZoneCode,
} from './delivery-zones.types.js';

export const ZONE_CODES = ['ZONA 1', 'ZONA 2'] as const satisfies readonly ZoneCode[];

export const DELIVERY_ZONES = {
  'ZONA 1': {
    code: 'ZONA 1',
    label: 'Zona 1',
    deliveryDays: [1, 3, 5],
  },
  'ZONA 2': {
    code: 'ZONA 2',
    label: 'Zona 2',
    deliveryDays: [2, 4, 6],
  },
} as const satisfies Record<ZoneCode, DeliveryZoneDefinition>;

export const DELIVERY_DAY_LABEL: Record<Weekday, string> = {
  0: 'Domingo',
  1: 'Lunes',
  2: 'Martes',
  3: 'Miércoles',
  4: 'Jueves',
  5: 'Viernes',
  6: 'Sábado',
};

export const DELIVERY_ZONE_BY_CODE: ReadonlyMap<string, DeliveryZoneDefinition> =
  new Map(ZONE_CODES.map((code) => [code, DELIVERY_ZONES[code]]));

export const DEFAULT_APP_TIMEZONE = 'America/Argentina/Buenos_Aires';
