/* eslint-disable no-console */
/**
 * Seed demo — FASE 7 / MVP demo seed.
 *
 * Idempotent. Creates demo users (admin / driver / citizen), demo clients
 * (JUBILADO linked to citizen, LOCAL, AYUDA_SOCIAL), demo products and
 * demo pricing rules. Also seeds a few historical orders/payments so the
 * demo screens are populated on first run. Passwords come from environment
 * variables so the script can be re-run in any environment safely.
 *
 * Configuration via env:
 *   DEMO_ADMIN_EMAIL      (default: admin@demo.local)
 *   DEMO_ADMIN_PASSWORD   (required)
 *   DEMO_DRIVER_EMAIL     (default: repartidor@demo.local)
 *   DEMO_DRIVER_PASSWORD  (required)
 *   DEMO_CITIZEN_EMAIL    (default: ciudadano@demo.local)
 *   DEMO_CITIZEN_PASSWORD (required)
 *
 * Run with:
 *   npm run seed:demo
 */
import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { loadEnv } from '../src/config/env.js';
import {
  detectTransactionSupport,
  runAtomicOperation,
} from '../src/shared/transactions.js';
import { User } from '../src/modules/users/users.model.js';
import { hashPassword } from '../src/modules/users/users.service.js';
import { ROLES } from '../src/modules/users/users.types.js';
import { Client } from '../src/modules/clients/clients.model.js';
import { Product } from '../src/modules/products/products.model.js';
import { PricingRule } from '../src/modules/pricing/pricing.rules.model.js';
import { Order } from '../src/modules/orders/orders.model.js';
import { AccountMovement } from '../src/modules/accounts/account-movements.model.js';
import { Payment } from '../src/modules/payments/payments.model.js';
import { getPaymentReceiptStorage } from '../src/modules/payments/payments.storage.js';
import { logger } from '../src/shared/logger.js';

interface UserSeed {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: 'ADMIN' | 'REPARTIDOR' | 'CIUDADANO';
}

interface ProductSeed {
  code: string;
  name: string;
  productType: 'WATER_REFILL' | 'CONTAINER' | 'DISPENSER' | 'OTHER';
  basePriceMinor: number;
}

const PRODUCT_SEEDS: ProductSeed[] = [
  { code: 'RECARGA', name: 'Recarga de agua 20L', productType: 'WATER_REFILL', basePriceMinor: 1_000_000 },
  { code: 'BIDON', name: 'Bidón 20L', productType: 'CONTAINER', basePriceMinor: 1_500_000 },
  { code: 'DISPENSER', name: 'Dispenser', productType: 'DISPENSER', basePriceMinor: 3_500_000 },
];

interface ClientSeed {
  firstName: string;
  lastName: string;
  documentType: 'DNI' | 'CUIT' | 'CUIL' | 'OTHER';
  documentNumber: string;
  clientType: 'LOCAL' | 'JUBILADO' | 'NO_LOCAL' | 'AYUDA_SOCIAL';
  address: { street: string; number: string; locality: string };
  phone?: string;
  linkUserEmail?: string;
  /**
   * Optional delivery zone ('ZONA 1' / 'ZONA 2'). When present, the seed
   * promotes CONFIRMED → PENDING for orders placed on that zone's day,
   * matching the new driver-centric flow.
   */
  zona?: 'ZONA 1' | 'ZONA 2';
}

const CLIENT_SEEDS: ClientSeed[] = [
  {
    firstName: 'Roberto',
    lastName: 'Gómez',
    documentType: 'DNI',
    documentNumber: '12345678',
    clientType: 'JUBILADO',
    address: { street: 'Belgrano', number: '250', locality: 'Buchardo' },
    phone: '+5493584000001',
    linkUserEmail: 'ciudadano@demo.local',
    zona: 'ZONA 1',
  },
  {
    firstName: 'María',
    lastName: 'López',
    documentType: 'DNI',
    documentNumber: '22334455',
    clientType: 'LOCAL',
    address: { street: 'San Martín', number: '450', locality: 'Buchardo' },
    zona: 'ZONA 2',
  },
  {
    firstName: 'Carlos',
    lastName: 'Ruiz',
    documentType: 'DNI',
    documentNumber: '33445566',
    clientType: 'AYUDA_SOCIAL',
    address: { street: 'Rivadavia', number: '780', locality: 'Buchardo' },
  },
  {
    firstName: 'Lucía',
    lastName: 'Fernández',
    documentType: 'DNI',
    documentNumber: '44556677',
    clientType: 'LOCAL',
    address: { street: 'Mitre', number: '120', locality: 'Buchardo' },
    zona: 'ZONA 1',
  },
];

interface RuleSeed {
  name: string;
  clientType: 'LOCAL' | 'JUBILADO' | 'NO_LOCAL' | 'AYUDA_SOCIAL';
  adjustmentValue: number;
}

const RULE_SEEDS: RuleSeed[] = [
  { name: 'Precio base local', clientType: 'LOCAL', adjustmentValue: 0 },
  { name: 'Descuento jubilados', clientType: 'JUBILADO', adjustmentValue: -50 },
  { name: 'Beneficio ayuda social', clientType: 'AYUDA_SOCIAL', adjustmentValue: -100 },
];

async function ensureUser(seed: UserSeed): Promise<NonNullable<Awaited<ReturnType<typeof User.findOne>>>> {
  const existing = await User.findOne({ email: seed.email.toLowerCase() });
  if (existing) {
    logger.info(`User exists: ${seed.email} (${existing._id.toString()})`);
    return existing;
  }
  const passwordHash = await hashPassword(seed.password);
  const created = await User.create({
    firstName: seed.firstName,
    lastName: seed.lastName,
    email: seed.email.toLowerCase(),
    passwordHash,
    role: ROLES[seed.role],
    active: true,
  });
  logger.info(`User created: ${seed.email} (${created._id.toString()})`);
  return created;
}

async function ensureProduct(seed: ProductSeed) {
  const existing = await Product.findOne({ code: seed.code });
  if (existing) {
    logger.info(`Product exists: ${seed.code}`);
    return existing;
  }
  const created = await Product.create({
    code: seed.code,
    name: seed.name,
    productType: seed.productType,
    basePriceMinor: seed.basePriceMinor,
    tracksStock: false,
    active: true,
  });
  logger.info(`Product created: ${seed.code} (${created._id.toString()})`);
  return created;
}

async function ensureClient(seed: ClientSeed) {
  const existing = await Client.findOne({
    documentType: seed.documentType,
    documentNumber: seed.documentNumber,
  });
  if (existing) {
    logger.info(`Client exists: ${seed.documentNumber}`);
    return existing;
  }
  const payload: Parameters<typeof Client.create>[0] = {
    firstName: seed.firstName,
    lastName: seed.lastName,
    documentType: seed.documentType,
    documentNumber: seed.documentNumber,
    clientType: seed.clientType,
    address: seed.address,
    active: true,
  };
  if (seed.phone) payload.phone = seed.phone;
  if (seed.zona) payload.zona = seed.zona;
  if (seed.linkUserEmail) {
    const user = await User.findOne({ email: seed.linkUserEmail.toLowerCase() });
    if (user) {
      payload.userId = user._id;
    } else {
      logger.warn(
        `Client ${seed.documentNumber}: linkUserEmail not found (${seed.linkUserEmail})`,
      );
    }
  }
  const created = await Client.create(payload);
  logger.info(`Client created: ${seed.documentNumber} (${created._id.toString()})`);
  return created;
}

async function ensureRule(seed: RuleSeed) {
  const existing = await PricingRule.findOne({
    name: seed.name,
    active: true,
  });
  if (existing) {
    logger.info(`Rule exists: ${seed.name}`);
    return existing;
  }
  const created = await PricingRule.create({
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
  logger.info(`Rule created: ${seed.name} (${created._id.toString()})`);
  return created;
}

/**
 * Build a tiny placeholder PNG receipt and persist it through the configured
 * storage. We need a real file on disk so the admin payment detail page can
 * render the receipt (the storage layer enforces UUID-based opaque keys).
 */
async function seedReceiptFile(): Promise<{
  storageKey: string;
  originalName: string;
  mimeType: string;
  size: number;
  sha256: string;
}> {
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.from('demo-receipt');
  const buffer = Buffer.concat([pngMagic, body]);
  const tmpPath = path.join(os.tmpdir(), `demo-receipt-${Date.now()}.png`);
  await fs.writeFile(tmpPath, buffer);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const storageKey = `${randomUUID()}.png`;
  const storage = getPaymentReceiptStorage();
  await storage.save(storageKey, tmpPath);
  return {
    storageKey,
    originalName: 'comprobante-demo.png',
    mimeType: 'image/png',
    size: buffer.length,
    sha256,
  };
}

/**
 * Snapshot pricing helper that mirrors what buildQuote would produce for the
 * known demo seed (LOCAL 0% / JUBILADO -50% / AYUDA_SOCIAL -100%). This keeps
 * the seed self-contained without needing transactions.
 */
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
  const unitFinal = Math.max(
    0,
    Math.round((unitBase * (100 + percentage)) / 100),
  );
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

interface DemoOrderSpec {
  /** Stable idempotency key (use documentNumber or client-scoped string). */
  demoKey: string;
  client: NonNullable<Awaited<ReturnType<typeof Client.findOne>>>;
  origin: 'CITIZEN' | 'STAFF';
  status: 'CONFIRMED' | 'PENDING' | 'ASSIGNED' | 'OUT_FOR_DELIVERY' | 'DELIVERED';
  items: Array<{
    product: NonNullable<Awaited<ReturnType<typeof Product.findOne>>>;
    quantity: number;
  }>;
  rule: { _id: Types.ObjectId; name: string; adjustmentValue: number } | null;
  driver?: NonNullable<Awaited<ReturnType<typeof User.findOne>>>;
  daysAgo: number;
  customerNote?: string;
}

async function ensureDemoOrder(
  spec: DemoOrderSpec,
): Promise<NonNullable<Awaited<ReturnType<typeof Order.findOne>>> | null> {
  const idempotencyKey = `demo:order:${spec.demoKey}`;
  // Dedupe via the linked ledger movement's idempotency key. AYUDA_SOCIAL
  // ($0) orders skip the ledger and are deduped by a sentinel key on Order.
  if (spec.demoKey) {
    const movementWithKey = await AccountMovement.findOne({ idempotencyKey });
    if (movementWithKey) {
      const order = await Order.findOne({ accountMovementId: movementWithKey._id });
      if (order) {
        logger.info(`Demo order exists (${spec.demoKey})`);
        return order;
      }
    }
    const orderWithSentinel = await Order.findOne({
      'deliveryAddressSnapshot.references': `demo:${spec.demoKey}`,
    });
    if (orderWithSentinel) {
      logger.info(`Demo order exists (${spec.demoKey})`);
      return orderWithSentinel;
    }
  }

  const now = new Date();
  const createdAt = new Date(now.getTime() - spec.daysAgo * 24 * 60 * 60 * 1000);
  const items = spec.items.map(({ product, quantity }) =>
    snapshotLine(product, spec.rule, quantity),
  );
  const totalBaseMinor = items.reduce((acc, i) => acc + i.subtotalBaseMinor, 0);
  const totalFinalMinor = items.reduce((acc, i) => acc + i.subtotalFinalMinor, 0);

  let orderDoc: Awaited<ReturnType<typeof Order.create>> | null = null;
  const orderIdempotencyKey = idempotencyKey;
  const { value: createdOrder } = await runAtomicOperation({
    label: `seed-demo.ensureDemoOrder:${spec.demoKey}`,
    transactional: async (session) => {
      const [created] = await Order.create(
        [
          {
            clientId: spec.client._id,
            origin: spec.origin,
            status: spec.status,
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
                references: `demo:${spec.demoKey}`,
              },
            zonaSnapshot: spec.client.zona ?? null,
            customerNote: spec.customerNote ?? null,
            assignedTo: spec.driver ? spec.driver._id : null,
            assignedAt:
              spec.status === 'ASSIGNED' ||
              spec.status === 'OUT_FOR_DELIVERY' ||
              spec.status === 'DELIVERED'
                ? createdAt
                : null,
            startedDeliveryAt:
              spec.status === 'OUT_FOR_DELIVERY' || spec.status === 'DELIVERED'
                ? createdAt
                : null,
            deliveredAt: spec.status === 'DELIVERED' ? createdAt : null,
            createdBy: spec.driver ? spec.driver._id : spec.client.userId ?? new Types.ObjectId(),
            createdAt,
            updatedAt: createdAt,
          },
        ],
        { session },
      );
      if (!created) throw new Error('Order not created');

      if (totalFinalMinor > 0) {
        const debit = await AccountMovement.create(
          [
            {
              clientId: spec.client._id,
              direction: 'DEBIT',
              amountMinor: totalFinalMinor,
              movementType: 'ORDER_CHARGE',
              description: `Pedido #${created._id.toString().slice(-6).toUpperCase()}`,
              occurredAt: createdAt,
              sourceType: 'ORDER',
              sourceId: created._id,
              idempotencyKey: orderIdempotencyKey,
              createdBy: spec.client.userId ?? spec.driver?._id,
              createdAt,
              updatedAt: createdAt,
            },
          ],
          { session },
        );
        if (debit[0]) {
          created.accountMovementId = debit[0]._id;
          await created.save({ session });
        }
      }
      return created;
    },
    fallback: async () => {
      const created = await Order.create({
        clientId: spec.client._id,
        origin: spec.origin,
        status: spec.status,
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
          references: `demo:${spec.demoKey}`,
        },
        zonaSnapshot: spec.client.zona ?? null,
        customerNote: spec.customerNote ?? null,
        assignedTo: spec.driver ? spec.driver._id : null,
        assignedAt:
          spec.status === 'ASSIGNED' ||
          spec.status === 'OUT_FOR_DELIVERY' ||
          spec.status === 'DELIVERED'
            ? createdAt
            : null,
        startedDeliveryAt:
          spec.status === 'OUT_FOR_DELIVERY' || spec.status === 'DELIVERED'
            ? createdAt
            : null,
        deliveredAt: spec.status === 'DELIVERED' ? createdAt : null,
        createdBy: spec.driver
          ? spec.driver._id
          : spec.client.userId ?? new Types.ObjectId(),
        createdAt,
        updatedAt: createdAt,
      });
      try {
        if (totalFinalMinor > 0) {
          const debit = await AccountMovement.create({
            clientId: spec.client._id,
            direction: 'DEBIT',
            amountMinor: totalFinalMinor,
            movementType: 'ORDER_CHARGE',
            description: `Pedido #${created._id.toString().slice(-6).toUpperCase()}`,
            occurredAt: createdAt,
            sourceType: 'ORDER',
            sourceId: created._id,
            idempotencyKey: orderIdempotencyKey,
            createdBy: spec.client.userId ?? spec.driver?._id,
            createdAt,
            updatedAt: createdAt,
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
  orderDoc = createdOrder;

  logger.info(`Demo order created (${spec.demoKey})`);
  return orderDoc;
}

async function ensureDemoPayment(opts: {
  client: NonNullable<Awaited<ReturnType<typeof Client.findOne>>>;
  submitter: NonNullable<Awaited<ReturnType<typeof User.findOne>>>;
  reviewer: NonNullable<Awaited<ReturnType<typeof User.findOne>>>;
  amountMinor: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVERSED';
  idempotencyKey: string;
  note: string;
  daysAgo: number;
}): Promise<void> {
  // Dedupe via ledger idempotency key.
  const existingMovement = await AccountMovement.findOne({
    idempotencyKey: opts.idempotencyKey,
  });
  if (existingMovement) {
    logger.info(`Demo payment exists (${opts.idempotencyKey})`);
    return;
  }
  const now = new Date();
  const submittedAt = new Date(now.getTime() - opts.daysAgo * 24 * 60 * 60 * 1000);
  const reviewedAt =
    opts.status === 'PENDING'
      ? null
      : new Date(submittedAt.getTime() + 60 * 60 * 1000);
  const receipt = await seedReceiptFile();

  let ledgerMovementId: Types.ObjectId | null = null;
  const paymentIdempotencyKey = opts.idempotencyKey;
  const { value } = await runAtomicOperation<{
    payment: Awaited<ReturnType<typeof Payment.create>>[number] | null;
    ledgerMovementId: Types.ObjectId | null;
  }>({
    label: `seed-demo.ensureDemoPayment:${opts.idempotencyKey}`,
    transactional: async (session) => {
      const [paymentDoc] = await Payment.create(
        [
          {
            clientId: opts.client._id,
            submittedBy: opts.submitter._id,
            amountMinor: opts.amountMinor,
            paymentMethod: 'BANK_TRANSFER',
            status: opts.status,
            note: opts.note,
            receipt,
            submittedAt,
            reviewedBy: reviewedAt ? opts.reviewer._id : null,
            reviewedAt,
            createdAt: submittedAt,
            updatedAt: submittedAt,
          },
        ],
        { session },
      );

        let movementId: Types.ObjectId | null = null;
        if (opts.status === 'APPROVED' && paymentDoc) {
          const [movement] = await AccountMovement.create(
            [
              {
                clientId: opts.client._id,
                direction: 'CREDIT',
                amountMinor: opts.amountMinor,
                movementType: 'PAYMENT',
                description: 'Pago aprobado por la Municipalidad',
                occurredAt: reviewedAt ?? now,
                sourceType: 'PAYMENT',
                sourceId: paymentDoc._id,
                idempotencyKey: paymentIdempotencyKey,
                createdBy: opts.reviewer._id,
                createdAt: reviewedAt ?? now,
                updatedAt: reviewedAt ?? now,
              },
            ],
            { session },
          );
        if (movement) {
          movementId = movement._id;
          paymentDoc.ledgerMovementId = movement._id;
          await paymentDoc.save({ session });
        }
      }
      return { payment: paymentDoc, ledgerMovementId: movementId };
    },
    fallback: async () => {
      const paymentDoc = await Payment.create({
        clientId: opts.client._id,
        submittedBy: opts.submitter._id,
        amountMinor: opts.amountMinor,
        paymentMethod: 'BANK_TRANSFER',
        status: opts.status,
        note: opts.note,
        receipt,
        submittedAt,
        reviewedBy: reviewedAt ? opts.reviewer._id : null,
        reviewedAt,
        createdAt: submittedAt,
        updatedAt: submittedAt,
      });
      try {
        let movementId: Types.ObjectId | null = null;
        if (opts.status === 'APPROVED') {
          const movement = await AccountMovement.create({
            clientId: opts.client._id,
            direction: 'CREDIT',
            amountMinor: opts.amountMinor,
            movementType: 'PAYMENT',
            description: 'Pago aprobado por la Municipalidad',
            occurredAt: reviewedAt ?? now,
            sourceType: 'PAYMENT',
            sourceId: paymentDoc._id,
            idempotencyKey: paymentIdempotencyKey,
            createdBy: opts.reviewer._id,
            createdAt: reviewedAt ?? now,
            updatedAt: reviewedAt ?? now,
          });
          movementId = movement._id;
          paymentDoc.ledgerMovementId = movement._id;
          await paymentDoc.save();
        }
        return { payment: paymentDoc, ledgerMovementId: movementId };
      } catch (err) {
        try {
          await Payment.deleteOne({ _id: paymentDoc._id });
        } catch {
          // best-effort
        }
        throw err;
      }
    },
  });
  ledgerMovementId = value.ledgerMovementId;
  void ledgerMovementId;
  logger.info(`Demo payment created (${opts.idempotencyKey})`);
}

async function main(): Promise<void> {
  const env = loadEnv();

  const userSeeds: UserSeed[] = [
    {
      email: env.DEMO_ADMIN_EMAIL ?? 'admin@demo.local',
      password: env.DEMO_ADMIN_PASSWORD ?? 'ChangeMe123!',
      firstName: 'Admin',
      lastName: 'Demo',
      role: 'ADMIN',
    },
    {
      email: env.DEMO_DRIVER_EMAIL ?? 'repartidor@demo.local',
      password: env.DEMO_DRIVER_PASSWORD ?? 'ChangeMe123!',
      firstName: 'Repartidor',
      lastName: 'Demo',
      role: 'REPARTIDOR',
    },
    {
      email: env.DEMO_CITIZEN_EMAIL ?? 'ciudadano@demo.local',
      password: env.DEMO_CITIZEN_PASSWORD ?? 'ChangeMe123!',
      firstName: 'Roberto',
      lastName: 'Gómez',
      role: 'CIUDADANO',
    },
  ];

  // Refuse to run with placeholder passwords in production.
  if (env.NODE_ENV === 'production') {
    const placeholders = userSeeds.filter(
      (u) =>
        !env[`DEMO_${u.role}_PASSWORD` as keyof typeof env] &&
        u.password === 'ChangeMe123!',
    );
    if (placeholders.length > 0) {
      logger.error(
        'Refusing to run seed:demo in production with placeholder passwords',
      );
      process.exit(1);
    }
  }

  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await detectTransactionSupport();

  // 1) Users
  let adminUser!: Awaited<ReturnType<typeof ensureUser>>;
  let driverUser!: Awaited<ReturnType<typeof ensureUser>>;
  let citizenUser!: Awaited<ReturnType<typeof ensureUser>>;
  for (const u of userSeeds) {
    const created = await ensureUser(u);
    if (u.role === 'ADMIN') adminUser = created;
    else if (u.role === 'REPARTIDOR') driverUser = created;
    else citizenUser = created;
  }

  // 2) Clients
  const clientsByDoc: Record<string, NonNullable<Awaited<ReturnType<typeof Client.findOne>>>> = {};
  for (const c of CLIENT_SEEDS) {
    clientsByDoc[c.documentNumber] = await ensureClient(c);
  }

  // 3) Products
  const productsByCode: Record<string, NonNullable<Awaited<ReturnType<typeof Product.findOne>>>> = {};
  for (const p of PRODUCT_SEEDS) {
    productsByCode[p.code] = await ensureProduct(p);
  }

  // 4) Pricing rules
  const rulesByType: Record<string, NonNullable<Awaited<ReturnType<typeof PricingRule.findOne>>>> = {};
  for (const r of RULE_SEEDS) {
    rulesByType[r.clientType] = await ensureRule(r);
  }

  // 5) Demo historical data (orders + payments) so screens aren't empty.
  const jubiladoClient = clientsByDoc['12345678']!;
  const localClient = clientsByDoc['22334455']!;
  const socialClient = clientsByDoc['33445566']!;

  // JUBILADO: historical delivered order (already paid) — saldo $0 after both moves.
  const jubiladoRule = rulesByType['JUBILADO']
    ? {
        _id: rulesByType['JUBILADO']._id,
        name: rulesByType['JUBILADO'].name,
        adjustmentValue: rulesByType['JUBILADO'].adjustmentValue,
      }
    : null;

  await ensureDemoOrder({
    demoKey: 'jubilado-historical-delivered',
    client: jubiladoClient,
    origin: 'CITIZEN',
    status: 'DELIVERED',
    driver: driverUser,
    items: [
      { product: productsByCode['RECARGA']!, quantity: 1 },
      { product: productsByCode['BIDON']!, quantity: 1 },
    ],
    rule: jubiladoRule,
    daysAgo: 14,
    customerNote: 'Entrega del mes anterior',
  });

  // Pair the historical delivered order with an APPROVED payment so the
  // JUBILADO citizen starts the demo at exactly $0 balance.
  const lastDelivered = await Order.findOne({
    clientId: jubiladoClient._id,
    status: 'DELIVERED',
  })
    .sort({ createdAt: -1 })
    .lean();
  if (lastDelivered) {
    const totalMinor = lastDelivered.totalFinalMinor;
    if (totalMinor > 0) {
      // Add a CREDIT movement paired with that DEBIT so the ledger is balanced.
      const creditIdempotency = `demo:order:jubilado-historical-delivered:payment`;
      const creditAlready = await AccountMovement.findOne({
        idempotencyKey: creditIdempotency,
      });
      if (!creditAlready) {
        await AccountMovement.create({
          clientId: jubiladoClient._id,
          direction: 'CREDIT',
          amountMinor: totalMinor,
          movementType: 'PAYMENT',
          description: 'Pago del pedido histórico',
          occurredAt: new Date(
            lastDelivered.deliveredAt?.getTime() ?? Date.now() - 13 * 24 * 60 * 60 * 1000,
          ),
          sourceType: 'SYSTEM',
          sourceId: null,
          idempotencyKey: creditIdempotency,
          createdBy: adminUser._id,
        });
        logger.info('Demo credit (historical) created for JUBILADO');
      }
    }
  }

  // LOCAL: a delivered order with PENDING payment so the admin sees a payment
  // to approve and the demo flow has a pending payment to act on.
  const localRule = rulesByType['LOCAL']
    ? {
        _id: rulesByType['LOCAL']._id,
        name: rulesByType['LOCAL'].name,
        adjustmentValue: rulesByType['LOCAL'].adjustmentValue,
      }
    : null;

  await ensureDemoOrder({
    demoKey: 'local-historical-delivered',
    client: localClient,
    origin: 'STAFF',
    status: 'DELIVERED',
    driver: driverUser,
    items: [
      { product: productsByCode['RECARGA']!, quantity: 1 },
      { product: productsByCode['DISPENSER']!, quantity: 1 },
    ],
    rule: localRule,
    daysAgo: 3,
    customerNote: 'Entrega directa',
  });

  await ensureDemoPayment({
    client: localClient,
    submitter: citizenUser,
    reviewer: adminUser,
    amountMinor: 4_500_000,
    status: 'PENDING',
    idempotencyKey: 'demo:payment:local-historical',
    note: 'Transferencia bancaria del 10/03',
    daysAgo: 2,
  });

  // AYUDA_SOCIAL: a $0 delivered order so the screens show social-aid flow.
  const socialRule = rulesByType['AYUDA_SOCIAL']
    ? {
        _id: rulesByType['AYUDA_SOCIAL']._id,
        name: rulesByType['AYUDA_SOCIAL'].name,
        adjustmentValue: rulesByType['AYUDA_SOCIAL'].adjustmentValue,
      }
    : null;

  await ensureDemoOrder({
    demoKey: 'social-historical-delivered',
    client: socialClient,
    origin: 'STAFF',
    status: 'DELIVERED',
    driver: driverUser,
    items: [{ product: productsByCode['RECARGA']!, quantity: 1 }],
    rule: socialRule,
    daysAgo: 5,
  });

  // JUBILADO: a PENDING order placed by the citizen — visible to drivers on
  // ZONA 1 day (Lun/Mié/Vie). Replaces the old "pending assignment" demo:
  // admin no longer assigns, repartidores gestionan.
  await ensureDemoOrder({
    demoKey: 'jubilado-pending',
    client: jubiladoClient,
    origin: 'CITIZEN',
    status: 'PENDING',
    items: [{ product: productsByCode['RECARGA']!, quantity: 2 }],
    rule: jubiladoRule,
    daysAgo: 0,
    customerNote: 'Para mañana por la mañana',
  });

  logger.info('Seed demo finished.');
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  logger.error('Seed demo failed', err);
  process.exit(1);
});
