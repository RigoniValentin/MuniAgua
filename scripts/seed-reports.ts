/* eslint-disable no-console */
/**
 * Seed reports — datos enfocados en /admin/informes.
 *
 * Asume que `seed:demo` ya corrió: reutiliza el repartidor
 * `repartidor@demo.local`. Si falta, aborta con un mensaje claro.
 *
 * Idempotente. Crea ~22 DELIVERED con deliveredAt distribuido en los
 * presets de período (Hoy / Ayer / Esta semana / Este mes / Mes pasado /
 * ~45 días atrás) mezclando CASH/ACCOUNT, distintos tipos de cliente y
 * productos (RECARGA / BIDON / DISPENSER) sobre el único repartidor
 * disponible. Además siembra 3 órdenes CANCELLED para validar que no
 * suman a los totales.
 *
 * Config vía env:
 *   REPORTS_DRIVER_EMAIL       (default: repartidor@demo.local) — debe existir
 *   REPORTS_CLIENT_DOC_PREFIX  (default: 9911)                  — prefijo sintético
 *
 * Run con:
 *   npm run seed:reports
 */
import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import { loadEnv } from '../src/config/env.js';
import {
  detectTransactionSupport,
  runAtomicOperation,
} from '../src/shared/transactions.js';
import { User } from '../src/modules/users/users.model.js';
import { ROLES } from '../src/modules/users/users.types.js';
import { Client } from '../src/modules/clients/clients.model.js';
import { Product } from '../src/modules/products/products.model.js';
import { PricingRule } from '../src/modules/pricing/pricing.rules.model.js';
import { Order } from '../src/modules/orders/orders.model.js';
import { AccountMovement } from '../src/modules/accounts/account-movements.model.js';
import { computeAdjustment } from '../src/shared/money.js';
import { logger } from '../src/shared/logger.js';

type ClientType = 'LOCAL' | 'JUBILADO' | 'NO_LOCAL' | 'AYUDA_SOCIAL';

interface ClientSeed {
  firstName: string;
  lastName: string;
  documentNumber: string;
  clientType: ClientType;
  address: { street: string; number: string; locality: string };
  zona: 'ZONA 1' | 'ZONA 2';
}

interface ProductSeed {
  code: string;
  name: string;
  productType: 'WATER_REFILL' | 'CONTAINER' | 'DISPENSER';
  basePriceMinor: number;
}

const PRODUCTS: ProductSeed[] = [
  {
    code: 'RECARGA',
    name: 'Recarga de agua 20L',
    productType: 'WATER_REFILL',
    basePriceMinor: 1_000_000,
  },
  {
    code: 'BIDON',
    name: 'Bidón 20L',
    productType: 'CONTAINER',
    basePriceMinor: 1_500_000,
  },
  {
    code: 'DISPENSER',
    name: 'Dispenser',
    productType: 'DISPENSER',
    basePriceMinor: 3_500_000,
  },
];

interface RuleSeed {
  name: string;
  clientType: ClientType;
  adjustmentValue: number;
}

const RULES: RuleSeed[] = [
  { name: 'Precio base local', clientType: 'LOCAL', adjustmentValue: 0 },
  { name: 'Descuento jubilados', clientType: 'JUBILADO', adjustmentValue: -50 },
  { name: 'Beneficio ayuda social', clientType: 'AYUDA_SOCIAL', adjustmentValue: -100 },
];

interface DateInTz {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

function getZonedParts(date: Date, timezone: string): DateInTz {
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

function zonedDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
): Date {
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
  const p = getZonedParts(date, timezone);
  return zonedDate(p.year, p.month, p.day, 0, 0, 0, timezone);
}

function endOfZonedDay(date: Date, timezone: string): Date {
  const p = getZonedParts(date, timezone);
  return zonedDate(p.year, p.month, p.day + 1, 0, 0, 0, timezone);
}

interface ResolvedPreset {
  dateFrom: Date;
  dateTo: Date;
  pickMidday(): Date;
}

function resolvePreset(
  preset: 'TODAY' | 'YESTERDAY' | 'THIS_WEEK' | 'THIS_MONTH' | 'LAST_MONTH' | 'CUSTOM_45D',
  now: Date,
  timezone: string,
): ResolvedPreset {
  const todayParts = getZonedParts(now, timezone);
  const todayStart = zonedDate(
    todayParts.year,
    todayParts.month,
    todayParts.day,
    0,
    0,
    0,
    timezone,
  );
  if (preset === 'TODAY') {
    return {
      dateFrom: todayStart,
      dateTo: endOfZonedDay(now, timezone),
      pickMidday: () =>
        zonedDate(
          todayParts.year,
          todayParts.month,
          todayParts.day,
          12,
          0,
          0,
          timezone,
        ),
    };
  }
  if (preset === 'YESTERDAY') {
    const yStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    return {
      dateFrom: yStart,
      dateTo: todayStart,
      pickMidday: () => {
        const p = getZonedParts(yStart, timezone);
        return zonedDate(p.year, p.month, p.day, 12, 0, 0, timezone);
      },
    };
  }
  if (preset === 'THIS_WEEK') {
    const daysFromMonday = todayParts.weekday - 1;
    const monday = new Date(todayStart.getTime() - daysFromMonday * 24 * 60 * 60 * 1000);
    return {
      dateFrom: monday,
      dateTo: new Date(monday.getTime() + 7 * 24 * 60 * 60 * 1000),
      pickMidday: () => {
        // Distribute mid-week orders across the available weekdays.
        const orderDay = Math.min(todayParts.weekday, 5);
        const target = monday.getTime() + (orderDay - 1) * 24 * 60 * 60 * 1000;
        const p = getZonedParts(new Date(target), timezone);
        return zonedDate(p.year, p.month, p.day, 11, 30, 0, timezone);
      },
    };
  }
  if (preset === 'THIS_MONTH') {
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
      dateFrom: monthStart,
      dateTo: nextMonthStart,
      pickMidday: (() => {
        const day = Math.min(todayParts.day, 28);
        return () =>
          zonedDate(todayParts.year, todayParts.month, day, 10, 0, 0, timezone);
      })(),
    };
  }
  if (preset === 'LAST_MONTH') {
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
      dateFrom: monthStart,
      dateTo: nextMonthStart,
      pickMidday: () => {
        // Pick a day around the middle of the previous month.
        const p = getZonedParts(monthStart, timezone);
        return zonedDate(p.year, p.month, 15, 11, 0, 0, timezone);
      },
    };
  }
  // CUSTOM_45D: order 45 days ago.
  const fortyFive = new Date(todayStart.getTime() - 45 * 24 * 60 * 60 * 1000);
  return {
    dateFrom: fortyFive,
    dateTo: new Date(todayStart.getTime() - 40 * 24 * 60 * 60 * 1000),
    pickMidday: () => {
      const p = getZonedParts(fortyFive, timezone);
      return zonedDate(p.year, p.month, p.day, 14, 0, 0, timezone);
    },
  };
}

interface OrderSpec {
  demoKey: string;
  client: NonNullable<Awaited<ReturnType<typeof Client.findOne>>>;
  driver: NonNullable<Awaited<ReturnType<typeof User.findOne>>>;
  product: NonNullable<Awaited<ReturnType<typeof Product.findOne>>>;
  quantity: number;
  paymentMethod: 'CASH' | 'ACCOUNT';
  deliveredAt: Date;
  customerNote?: string;
}

interface CancelSpec {
  demoKey: string;
  client: NonNullable<Awaited<ReturnType<typeof Client.findOne>>>;
  cancelledAt: Date;
  reason: string;
}

async function ensureUserByEmail(
  email: string,
): Promise<NonNullable<Awaited<ReturnType<typeof User.findOne>>>> {
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (!existing) {
    throw new Error(
      `No se encontró el usuario ${email}. Corré \`npm run seed:demo\` antes.`,
    );
  }
  return existing;
}

async function ensureClient(seed: ClientSeed) {
  const existing = await Client.findOne({
    documentType: 'DNI',
    documentNumber: seed.documentNumber,
  });
  if (existing) {
    return existing;
  }
  return Client.create({
    firstName: seed.firstName,
    lastName: seed.lastName,
    documentType: 'DNI',
    documentNumber: seed.documentNumber,
    clientType: seed.clientType,
    address: seed.address,
    active: true,
    zona: seed.zona,
  });
}

async function ensureProduct(seed: ProductSeed) {
  const existing = await Product.findOne({ code: seed.code });
  if (existing) {
    return existing;
  }
  return Product.create({
    code: seed.code,
    name: seed.name,
    productType: seed.productType,
    basePriceMinor: seed.basePriceMinor,
    tracksStock: false,
    active: true,
  });
}

async function ensureRule(seed: RuleSeed) {
  const existing = await PricingRule.findOne({
    name: seed.name,
    active: true,
  });
  if (existing) {
    return existing;
  }
  return PricingRule.create({
    name: seed.name,
    clientType: seed.clientType,
    scope: 'ALL_PRODUCTS',
    productType: null,
    productId: null,
    adjustmentType: 'PERCENTAGE',
    adjustmentValue: seed.adjustmentValue,
    priority: 0,
    active: true,
  });
}

interface SnapshotLine {
  productId: Types.ObjectId;
  productCode: string;
  productName: string;
  productType: 'WATER_REFILL' | 'CONTAINER' | 'DISPENSER' | 'OTHER';
  quantity: number;
  unitBasePriceMinor: number;
  adjustmentPercentage: number;
  unitFinalPriceMinor: number;
  subtotalBaseMinor: number;
  subtotalFinalMinor: number;
  appliedRuleId: Types.ObjectId | null;
  appliedRuleName: string | null;
}

function snapshotLine(
  product: NonNullable<Awaited<ReturnType<typeof Product.findOne>>>,
  rule: { _id: Types.ObjectId; name: string; adjustmentValue: number } | null,
  quantity: number,
): SnapshotLine {
  const percentage = rule?.adjustmentValue ?? 0;
  const unitBase = product.basePriceMinor;
  const unitFinal = computeAdjustment(unitBase, percentage).finalMinor;
  return {
    productId: product._id,
    productCode: product.code,
    productName: product.name,
    productType: product.productType,
    quantity,
    unitBasePriceMinor: unitBase,
    adjustmentPercentage: percentage,
    unitFinalPriceMinor: unitFinal,
    subtotalBaseMinor: unitBase * quantity,
    subtotalFinalMinor: unitFinal * quantity,
    appliedRuleId: rule ? rule._id : null,
    appliedRuleName: rule ? rule.name : null,
  };
}

async function ensureDeliveredOrder(spec: OrderSpec): Promise<void> {
  const idempotencyKey = `demo:reports:${spec.demoKey}`;
  const existing = await Order.findOne({
    'deliveryAddressSnapshot.references': idempotencyKey,
  });
  if (existing) {
    logger.info(`Reports order exists (${spec.demoKey})`);
    return;
  }

  const rule: { _id: Types.ObjectId; name: string; adjustmentValue: number } | null =
    (() => {
      if (spec.client.clientType === 'AYUDA_SOCIAL') {
        return { _id: new Types.ObjectId(), name: 'Beneficio ayuda social', adjustmentValue: -100 };
      }
      if (spec.client.clientType === 'JUBILADO') {
        return { _id: new Types.ObjectId(), name: 'Descuento jubilados', adjustmentValue: -50 };
      }
      return null;
    })();

  const items = [snapshotLine(spec.product, rule, spec.quantity)];
  const totalBaseMinor = items.reduce((acc, i) => acc + i.subtotalBaseMinor, 0);
  const totalFinalMinor = items.reduce((acc, i) => acc + i.subtotalFinalMinor, 0);

  const createdOrder = await runAtomicOperation({
    label: `seed-reports.ensureDeliveredOrder:${spec.demoKey}`,
    transactional: async (session) => {
      const [created] = await Order.create(
        [
          {
            clientId: spec.client._id,
            origin: spec.paymentMethod === 'CASH' ? 'CITIZEN' : 'STAFF',
            status: 'DELIVERED',
            paymentMethod: spec.paymentMethod,
            items,
            totalBaseMinor,
            totalFinalMinor,
            deliveryAddressSnapshot: {
              street: spec.client.address.street,
              number: spec.client.address.number,
              floor: spec.client.address.floor ?? null,
              apartment: spec.client.address.apartment ?? null,
              neighborhood: spec.client.address.neighborhood ?? null,
              locality: spec.client.address.locality,
              postalCode: spec.client.address.postalCode ?? null,
              references: idempotencyKey,
            },
            zonaSnapshot: spec.client.zona ?? null,
            customerNote: spec.customerNote ?? null,
            assignedTo: spec.driver._id,
            assignedAt: spec.deliveredAt,
            startedDeliveryAt: spec.deliveredAt,
            deliveredAt: spec.deliveredAt,
            paidAt: spec.paymentMethod === 'CASH' ? spec.deliveredAt : null,
            createdBy: spec.driver._id,
            createdAt: spec.deliveredAt,
            updatedAt: spec.deliveredAt,
          },
        ],
        { session },
      );
      if (!created) throw new Error('Order not created');

      if (totalFinalMinor > 0 && spec.paymentMethod === 'ACCOUNT') {
        const [debit] = await AccountMovement.create(
          [
            {
              clientId: spec.client._id,
              direction: 'DEBIT',
              amountMinor: totalFinalMinor,
              movementType: 'ORDER_CHARGE',
              description: `Pedido #${created._id.toString().slice(-6).toUpperCase()}`,
              occurredAt: spec.deliveredAt,
              sourceType: 'ORDER',
              sourceId: created._id,
              idempotencyKey: `${idempotencyKey}:debit`,
              createdBy: spec.driver._id,
              createdAt: spec.deliveredAt,
              updatedAt: spec.deliveredAt,
            },
          ],
          { session },
        );
        if (debit) {
          created.accountMovementId = debit._id;
          await created.save({ session });
        }
      }
      return created;
    },
    fallback: async () => {
      const created = await Order.create({
        clientId: spec.client._id,
        origin: spec.paymentMethod === 'CASH' ? 'CITIZEN' : 'STAFF',
        status: 'DELIVERED',
        paymentMethod: spec.paymentMethod,
        items,
        totalBaseMinor,
        totalFinalMinor,
        deliveryAddressSnapshot: {
          street: spec.client.address.street,
          number: spec.client.address.number,
          floor: spec.client.address.floor ?? null,
          apartment: spec.client.address.apartment ?? null,
          neighborhood: spec.client.address.neighborhood ?? null,
          locality: spec.client.address.locality,
          postalCode: spec.client.address.postalCode ?? null,
          references: idempotencyKey,
        },
        zonaSnapshot: spec.client.zona ?? null,
        customerNote: spec.customerNote ?? null,
        assignedTo: spec.driver._id,
        assignedAt: spec.deliveredAt,
        startedDeliveryAt: spec.deliveredAt,
        deliveredAt: spec.deliveredAt,
        paidAt: spec.paymentMethod === 'CASH' ? spec.deliveredAt : null,
        createdBy: spec.driver._id,
        createdAt: spec.deliveredAt,
        updatedAt: spec.deliveredAt,
      });
      try {
        if (totalFinalMinor > 0 && spec.paymentMethod === 'ACCOUNT') {
          const debit = await AccountMovement.create({
            clientId: spec.client._id,
            direction: 'DEBIT',
            amountMinor: totalFinalMinor,
            movementType: 'ORDER_CHARGE',
            description: `Pedido #${created._id.toString().slice(-6).toUpperCase()}`,
            occurredAt: spec.deliveredAt,
            sourceType: 'ORDER',
            sourceId: created._id,
            idempotencyKey: `${idempotencyKey}:debit`,
            createdBy: spec.driver._id,
            createdAt: spec.deliveredAt,
            updatedAt: spec.deliveredAt,
          });
          created.accountMovementId = debit._id;
          await created.save();
        }
        return created;
      } catch (err) {
        try {
          await Order.deleteOne({ _id: created._id });
        } catch {
          // best-effort
        }
        throw err;
      }
    },
  });
  void createdOrder;
  logger.info(
    `Reports delivered order created (${spec.demoKey}) — ${spec.paymentMethod}`,
  );
}

async function ensureCancelledOrder(spec: CancelSpec): Promise<void> {
  const idempotencyKey = `demo:reports:${spec.demoKey}`;
  const existing = await Order.findOne({
    'deliveryAddressSnapshot.references': idempotencyKey,
  });
  if (existing) {
    logger.info(`Reports cancelled order exists (${spec.demoKey})`);
    return;
  }
  // El schema exige items.length > 0 pero la cancelación sin items es
  // un caso real. Inserción directa vía el driver de Mongo para saltar
  // el validador de Mongoose (los informes no leen `items`).
  await mongoose.connection.collection('orders').insertOne({
    clientId: spec.client._id,
    origin: 'STAFF',
    status: 'CANCELLED',
    paymentMethod: 'ACCOUNT',
    items: [],
    totalBaseMinor: 0,
    totalFinalMinor: 0,
    deliveryAddressSnapshot: {
      street: spec.client.address.street,
      number: spec.client.address.number,
      floor: null,
      apartment: null,
      neighborhood: null,
      locality: spec.client.address.locality,
      postalCode: null,
      references: idempotencyKey,
    },
    zonaSnapshot: spec.client.zona ?? null,
    customerNote: null,
    assignedTo: null,
    assignedAt: null,
    startedDeliveryAt: null,
    deliveredAt: null,
    cancelledAt: spec.cancelledAt,
    cancellationReason: spec.reason,
    createdBy: spec.client._id,
    createdAt: spec.cancelledAt,
    updatedAt: spec.cancelledAt,
  });
  logger.info(`Reports cancelled order created (${spec.demoKey})`);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const driverEmail =
    env.REPORTS_DRIVER_EMAIL ?? 'repartidor@demo.local';
  const docPrefix = env.REPORTS_CLIENT_DOC_PREFIX ?? '9911';

  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await detectTransactionSupport();

  // Driver — debe existir (viene de seed:demo).
  const driver = await ensureUserByEmail(driverEmail);
  if (driver.role !== ROLES.REPARTIDOR || !driver.active) {
    throw new Error(
      `El usuario ${driverEmail} no es un REPARTIDOR activo.`,
    );
  }
  logger.info(`Driver ready: ${driver.email} (${driver._id.toString()})`);

  // Productos (no chocar con los del seed-demo si no existen).
  const productsByCode: Record<
    string,
    NonNullable<Awaited<ReturnType<typeof Product.findOne>>>
  > = {};
  for (const p of PRODUCTS) {
    productsByCode[p.code] = await ensureProduct(p);
  }

  // Reglas (idempotente) para que `appliedRuleName` no quede null si el
  // cliente tiene un descuento asociado.
  for (const r of RULES) {
    await ensureRule(r);
  }

  // Clientes sintéticos (1 por tipo, docNumbers prefijados para no
  // chocar con el seed-demo).
  const clientsByType: Record<ClientType, NonNullable<Awaited<ReturnType<typeof Client.findOne>>>> = {} as Record<
    ClientType,
    NonNullable<Awaited<ReturnType<typeof Client.findOne>>>
  >;
  const clientSeeds: ClientSeed[] = [
    {
      firstName: 'Juan',
      lastName: 'Peralta',
      documentNumber: `${docPrefix}1001`,
      clientType: 'LOCAL',
      address: { street: 'Av. San Martín', number: '120', locality: 'Buchardo' },
      zona: 'ZONA 1',
    },
    {
      firstName: 'María',
      lastName: 'Quiroga',
      documentNumber: `${docPrefix}1002`,
      clientType: 'JUBILADO',
      address: { street: 'Belgrano', number: '330', locality: 'Buchardo' },
      zona: 'ZONA 1',
    },
    {
      firstName: 'Pedro',
      lastName: 'Salas',
      documentNumber: `${docPrefix}1003`,
      clientType: 'AYUDA_SOCIAL',
      address: { street: 'Rivadavia', number: '880', locality: 'Buchardo' },
      zona: 'ZONA 2',
    },
    {
      firstName: 'Lucía',
      lastName: 'Torres',
      documentNumber: `${docPrefix}1004`,
      clientType: 'NO_LOCAL',
      address: { street: 'Mitre', number: '440', locality: 'Buchardo' },
      zona: 'ZONA 2',
    },
  ];
  for (const seed of clientSeeds) {
    const client = await ensureClient(seed);
    clientsByType[seed.clientType] = client;
  }

  const now = new Date();
  const timezone = env.APP_TIMEZONE;

  type OrderSpecInput = Omit<OrderSpec, 'driver' | 'client' | 'product' | 'deliveredAt'> & {
    clientType: ClientType;
    productCode: string;
    preset: 'TODAY' | 'YESTERDAY' | 'THIS_WEEK' | 'THIS_MONTH' | 'LAST_MONTH' | 'CUSTOM_45D';
  };

  const plan: OrderSpecInput[] = [
    // Hoy (3)
    {
      demoKey: 'today-local-cash-1',
      clientType: 'LOCAL',
      productCode: 'RECARGA',
      quantity: 2,
      paymentMethod: 'CASH',
      preset: 'TODAY',
      customerNote: 'Hoy - local efectivo',
    },
    {
      demoKey: 'today-jubilado-account-1',
      clientType: 'JUBILADO',
      productCode: 'RECARGA',
      quantity: 1,
      paymentMethod: 'ACCOUNT',
      preset: 'TODAY',
      customerNote: 'Hoy - jubilado cta cte',
    },
    {
      demoKey: 'today-social-account-1',
      clientType: 'AYUDA_SOCIAL',
      productCode: 'BIDON',
      quantity: 1,
      paymentMethod: 'ACCOUNT',
      preset: 'TODAY',
      customerNote: 'Hoy - ayuda social',
    },
    // Ayer (2)
    {
      demoKey: 'yesterday-local-cash-1',
      clientType: 'LOCAL',
      productCode: 'DISPENSER',
      quantity: 1,
      paymentMethod: 'CASH',
      preset: 'YESTERDAY',
    },
    {
      demoKey: 'yesterday-no-local-account-1',
      clientType: 'NO_LOCAL',
      productCode: 'RECARGA',
      quantity: 3,
      paymentMethod: 'ACCOUNT',
      preset: 'YESTERDAY',
    },
    // Esta semana (4): distribuidas en lun-jue. Hoy es viernes → 4 ocurrencias
    // antes de hoy. Para mantener el set chico y estable, las sembramos con
    // una fecha 1d, 2d, 3d y 4d atrás antes de "hoy".
    {
      demoKey: 'week-jubilado-account-1',
      clientType: 'JUBILADO',
      productCode: 'BIDON',
      quantity: 1,
      paymentMethod: 'ACCOUNT',
      preset: 'THIS_WEEK',
    },
    {
      demoKey: 'week-local-cash-1',
      clientType: 'LOCAL',
      productCode: 'RECARGA',
      quantity: 4,
      paymentMethod: 'CASH',
      preset: 'THIS_WEEK',
    },
    {
      demoKey: 'week-no-local-account-1',
      clientType: 'NO_LOCAL',
      productCode: 'DISPENSER',
      quantity: 1,
      paymentMethod: 'ACCOUNT',
      preset: 'THIS_WEEK',
    },
    {
      demoKey: 'week-jubilado-account-2',
      clientType: 'JUBILADO',
      productCode: 'RECARGA',
      quantity: 2,
      paymentMethod: 'ACCOUNT',
      preset: 'THIS_WEEK',
    },
    // Este mes (6)
    {
      demoKey: 'month-local-cash-1',
      clientType: 'LOCAL',
      productCode: 'RECARGA',
      quantity: 2,
      paymentMethod: 'CASH',
      preset: 'THIS_MONTH',
    },
    {
      demoKey: 'month-local-cash-2',
      clientType: 'LOCAL',
      productCode: 'BIDON',
      quantity: 1,
      paymentMethod: 'CASH',
      preset: 'THIS_MONTH',
    },
    {
      demoKey: 'month-jubilado-account-1',
      clientType: 'JUBILADO',
      productCode: 'RECARGA',
      quantity: 1,
      paymentMethod: 'ACCOUNT',
      preset: 'THIS_MONTH',
    },
    {
      demoKey: 'month-jubilado-account-2',
      clientType: 'JUBILADO',
      productCode: 'DISPENSER',
      quantity: 1,
      paymentMethod: 'ACCOUNT',
      preset: 'THIS_MONTH',
    },
    {
      demoKey: 'month-no-local-account-1',
      clientType: 'NO_LOCAL',
      productCode: 'RECARGA',
      quantity: 2,
      paymentMethod: 'ACCOUNT',
      preset: 'THIS_MONTH',
    },
    {
      demoKey: 'month-social-account-1',
      clientType: 'AYUDA_SOCIAL',
      productCode: 'RECARGA',
      quantity: 1,
      paymentMethod: 'ACCOUNT',
      preset: 'THIS_MONTH',
    },
    // Mes pasado (5)
    {
      demoKey: 'last-month-local-cash-1',
      clientType: 'LOCAL',
      productCode: 'RECARGA',
      quantity: 3,
      paymentMethod: 'CASH',
      preset: 'LAST_MONTH',
    },
    {
      demoKey: 'last-month-local-cash-2',
      clientType: 'LOCAL',
      productCode: 'DISPENSER',
      quantity: 1,
      paymentMethod: 'CASH',
      preset: 'LAST_MONTH',
    },
    {
      demoKey: 'last-month-jubilado-account-1',
      clientType: 'JUBILADO',
      productCode: 'BIDON',
      quantity: 1,
      paymentMethod: 'ACCOUNT',
      preset: 'LAST_MONTH',
    },
    {
      demoKey: 'last-month-no-local-account-1',
      clientType: 'NO_LOCAL',
      productCode: 'RECARGA',
      quantity: 2,
      paymentMethod: 'ACCOUNT',
      preset: 'LAST_MONTH',
    },
    {
      demoKey: 'last-month-social-account-1',
      clientType: 'AYUDA_SOCIAL',
      productCode: 'RECARGA',
      quantity: 2,
      paymentMethod: 'ACCOUNT',
      preset: 'LAST_MONTH',
    },
    // Hace ~45 días (2) — sólo aparecen con un rango custom.
    {
      demoKey: 'custom-45d-jubilado-account-1',
      clientType: 'JUBILADO',
      productCode: 'RECARGA',
      quantity: 1,
      paymentMethod: 'ACCOUNT',
      preset: 'CUSTOM_45D',
    },
    {
      demoKey: 'custom-45d-local-cash-1',
      clientType: 'LOCAL',
      productCode: 'BIDON',
      quantity: 1,
      paymentMethod: 'CASH',
      preset: 'CUSTOM_45D',
    },
  ];

  // Construimos las especificaciones finales con deliveredAt calculado
  // en zona horaria de Buenos Aires.
  const fullSpecs: OrderSpec[] = plan.map((p, idx) => {
    const preset = resolvePreset(p.preset, now, timezone);
    const base = preset.pickMidday();
    // Espaciamos las órdenes dentro del preset con offsets de horas
    // distintas (idx*55min) para que los `deliveredAt` no choquen.
    const deliveredAt = new Date(base.getTime() + idx * 55 * 60 * 1000);
    const client = clientsByType[p.clientType];
    const product = productsByCode[p.productCode];
    if (!client || !product) {
      throw new Error(`Missing seed entity for ${p.demoKey}`);
    }
    return {
      demoKey: p.demoKey,
      client,
      driver,
      product,
      quantity: p.quantity,
      paymentMethod: p.paymentMethod,
      deliveredAt,
      customerNote: p.customerNote,
    };
  });

  for (const spec of fullSpecs) {
    await ensureDeliveredOrder(spec);
  }

  // 3 canceladas en períodos distintos.
  const todayParts = getZonedParts(now, timezone);
  const cancelledAtThisMonth = zonedDate(
    todayParts.year,
    todayParts.month,
    Math.max(1, todayParts.day - 1),
    9,
    30,
    0,
    timezone,
  );
  const lastMonthP = getZonedParts(
    new Date(
      startOfZonedDay(now, timezone).getTime() - 20 * 24 * 60 * 60 * 1000,
    ),
    timezone,
  );
  const cancelledAtLastMonth = zonedDate(
    lastMonthP.year,
    lastMonthP.month,
    10,
    11,
    15,
    0,
    timezone,
  );
  const cancelledAtOld = new Date(
    startOfZonedDay(now, timezone).getTime() - 50 * 24 * 60 * 60 * 1000,
  );

  const cancelledSpecs: CancelSpec[] = [
    {
      demoKey: 'cancelled-this-month-1',
      client: clientsByType.LOCAL,
      cancelledAt: cancelledAtThisMonth,
      reason: 'Cliente ausente',
    },
    {
      demoKey: 'cancelled-last-month-1',
      client: clientsByType.JUBILADO,
      cancelledAt: cancelledAtLastMonth,
      reason: 'Error de carga',
    },
    {
      demoKey: 'cancelled-old-1',
      client: clientsByType.NO_LOCAL,
      cancelledAt: cancelledAtOld,
      reason: 'Solicitud del cliente',
    },
  ];
  for (const spec of cancelledSpecs) {
    await ensureCancelledOrder(spec);
  }

  logger.info(
    `Seed reports finished — ${fullSpecs.length} delivered + ${cancelledSpecs.length} cancelled`,
  );
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  logger.error('Seed reports failed', err);
  process.exit(1);
});
