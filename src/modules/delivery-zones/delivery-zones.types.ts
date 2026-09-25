/**
 * Delivery zones module.
 *
 * Buchardo reparte en dos zonas siguiendo un calendario fijo:
 *   ZONA 1 → Lunes, miércoles y viernes (1, 3, 5)
 *   ZONA 2 → Martes, jueves y sábado   (2, 4, 6)
 *   Domingo (0) no reparte ninguna zona.
 *
 * La regla es estable; por ahora la mantenemos como constante y no creamos
 * una colección maestra. Cuando el municipio sume una zona nueva, se agrega
 * al map `DELIVERY_ZONES` y a `ZONE_CODES`. Moverlo a una colección es
 * trivial luego: la firma de los helpers no cambia.
 *
 * Toda la lógica de "qué zona reparte hoy" vive acá — backend y frontend
 * consumen el mismo backend como fuente única.
 */

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type ZoneCode = 'ZONA 1' | 'ZONA 2';

export interface DeliveryZoneDefinition {
  readonly code: ZoneCode;
  readonly label: string;
  /** Weekdays (0=Dom..6=Sáb) in which this zone delivers. */
  readonly deliveryDays: readonly Weekday[];
}

export interface DeliveryZoneContext {
  /** Date used to compute the weekday, expressed in the app's timezone. */
  readonly today: Date;
  /** 0=Dom..6=Sáb en la timezone de la app. */
  readonly weekday: Weekday;
  /** Zones whose schedule matches `weekday`. Empty on Sunday. */
  readonly zones: readonly ZoneCode[];
  /** Spanish label for the weekday ("Lunes", "Martes", …). */
  readonly weekdayLabel: string;
}
