/* eslint-disable no-console */
// Smoke test for FASE 3 — Productos y Pricing.
// Exercises the pricing engine end-to-end against an in-memory MongoDB.
import { setupTestDb, teardownTestDb } from '../tests/setup';
import { loadEnv } from '../src/config/env';
import { createApp } from '../src/app';
import { createUser } from '../src/modules/users/users.service';
import { ROLES, defaultPermissionsForRole } from '../src/modules/users/users.types';
import { signAccessToken } from '../src/modules/auth/auth.tokens';
import { Product } from '../src/modules/products/products.model';
import { Client } from '../src/modules/clients/clients.model';
import { PricingRule } from '../src/modules/pricing/pricing.rules.model';
import { buildQuote } from '../src/modules/pricing/pricing.engine';
import type { ClientType } from '../src/modules/clients/clients.types';

const baseAddress = { street: 'Av. San Martín', number: '123', locality: 'Buchardo' };

async function main(): Promise<void> {
  await setupTestDb();
  loadEnv();

  console.log('== Smoke test: FASE 3 — Productos + Pricing ==\n');

  const app = createApp();

  // 1) SUPER_ADMIN
  await createUser({
    firstName: 'Super',
    lastName: 'Admin',
    email: 'admin@buchardo.gob.ar',
    password: 'SuperSecret123',
    role: ROLES.SUPER_ADMIN,
  });
  const { User } = await import('../src/modules/users/users.model');
  const admin = await User.findOne({ email: 'admin@buchardo.gob.ar' });
  const adminToken = signAccessToken({
    sub: admin!._id.toString(),
    role: admin!.role,
    permissions: defaultPermissionsForRole(admin!.role),
  });
  console.log('1) SUPER_ADMIN creado');

  // 2) Productos temporales (NO son seed de municipio)
  const agua = await Product.create({
    code: 'AGUA_RECARGA',
    name: 'Recarga de agua',
    productType: 'WATER_REFILL',
    basePriceMinor: 1_000_000, // $10.000 ARS
    tracksStock: false,
    active: true,
  });
  const bidon = await Product.create({
    code: 'BIDON',
    name: 'Bidón',
    productType: 'CONTAINER',
    basePriceMinor: 1_500_000,
    tracksStock: true,
    active: true,
  });
  const dispenser = await Product.create({
    code: 'DISPENSER',
    name: 'Dispenser',
    productType: 'DISPENSER',
    basePriceMinor: 3_500_000,
    tracksStock: true,
    active: true,
  });
  console.log(
    `2) Productos temporales creados: AGUA=$10.000, BIDON=$15.000, DISPENSER=$35.000`,
  );

  // 3) Cuatro clientes
  const clientTypes: ClientType[] = ['LOCAL', 'JUBILADO', 'NO_LOCAL', 'AYUDA_SOCIAL'];
  const clients: Record<ClientType, Awaited<ReturnType<typeof Client.create>>> = {} as never;
  for (let i = 0; i < clientTypes.length; i++) {
    const t = clientTypes[i];
    const doc = await Client.create({
      firstName: t,
      lastName: `Cliente ${i}`,
      documentType: 'DNI',
      documentNumber: `${20_000_000 + i}`,
      clientType: t,
      address: baseAddress,
      active: true,
    });
    clients[t] = doc;
  }
  console.log('3) 4 clientes creados: LOCAL, JUBILADO, NO_LOCAL, AYUDA_SOCIAL');

  // 4) Reglas comerciales iniciales
  const initialRules = [
    { name: 'Precio base local', clientType: 'LOCAL' as ClientType, value: 0 },
    { name: 'Descuento jubilados', clientType: 'JUBILADO' as ClientType, value: -50 },
    { name: 'Recargo no local', clientType: 'NO_LOCAL' as ClientType, value: 40 },
    {
      name: 'Beneficio ayuda social',
      clientType: 'AYUDA_SOCIAL' as ClientType,
      value: -100,
    },
  ];
  for (const r of initialRules) {
    await PricingRule.create({
      name: r.name,
      clientType: r.clientType,
      scope: 'ALL_PRODUCTS',
      productType: null,
      productId: null,
      adjustmentType: 'PERCENTAGE',
      adjustmentValue: r.value,
      priority: 0,
      active: true,
    });
  }
  console.log('4) Reglas iniciales: LOCAL=0%, JUBILADO=-50%, NO_LOCAL=+40%, AYUDA_SOCIAL=-100%');

  // 5) Cotizar Recarga $10.000
  console.log('\n5) Cotizar Recarga $10.000 por tipo de cliente:');
  for (const t of clientTypes) {
    const result = await buildQuote(clients[t]._id.toString(), [
      { productId: agua._id.toString(), quantity: 1 },
    ]);
    const line = result.items[0];
    console.log(
      `   ${t.padEnd(13)} base=$10.000 final=$${(line.unitFinalPriceMinor / 100).toFixed(2)} ajuste=${line.adjustmentPercentage}%`,
    );
  }

  // 6) Cambiar dinámicamente JUBILADO -50 → -30
  console.log('\n6) Actualizar regla JUBILADO: -50% → -30%');
  const jubRule = await PricingRule.findOne({
    clientType: 'JUBILADO',
    scope: 'ALL_PRODUCTS',
    productType: null,
    productId: null,
    priority: 0,
    active: true,
  });
  jubRule!.adjustmentValue = -30;
  await jubRule!.save();

  // 7) Cotizar de nuevo — debe dar $7.000
  console.log('7) Cotizar Recarga $10.000 para JUBILADO tras cambio:');
  const jubResult = await buildQuote(clients.JUBILADO._id.toString(), [
    { productId: agua._id.toString(), quantity: 1 },
  ]);
  const jubLine = jubResult.items[0];
  console.log(
    `   JUBILADO     base=$10.000 final=$${(jubLine.unitFinalPriceMinor / 100).toFixed(2)} ajuste=${jubLine.adjustmentPercentage}%`,
  );
  if (jubLine.unitFinalPriceMinor !== 700_000) {
    throw new Error(
      `Expected 700000 minor for JUBILADO @ -30%, got ${jubLine.unitFinalPriceMinor}`,
    );
  }
  if (jubLine.appliedRule?.name !== 'Descuento jubilados') {
    throw new Error('Expected rule "Descuento jubilados" applied');
  }

  // 8) Regla específica: JUBILADO sobre Dispenser -10%
  console.log('\n8) Crear regla específica: JUBILADO / PRODUCT(DISPENSER) / -10%');
  const specificRule = await PricingRule.create({
    name: 'Descuento Jubilado Dispenser',
    clientType: 'JUBILADO',
    scope: 'PRODUCT',
    productType: null,
    productId: dispenser._id,
    adjustmentType: 'PERCENTAGE',
    adjustmentValue: -10,
    priority: 10,
    active: true,
  });

  // 9) Cotizar Recarga y Dispenser para JUBILADO
  console.log('9) Cotizar ambos productos para JUBILADO:');
  const mixedResult = await buildQuote(clients.JUBILADO._id.toString(), [
    { productId: agua._id.toString(), quantity: 1 },
    { productId: dispenser._id.toString(), quantity: 1 },
  ]);
  for (const line of mixedResult.items) {
    console.log(
      `   ${line.productCode.padEnd(10)} base=$${(line.unitBasePriceMinor / 100).toFixed(2)} final=$${(line.unitFinalPriceMinor / 100).toFixed(2)} ajuste=${line.adjustmentPercentage}% regla=${line.appliedRule?.name ?? '-'}`,
    );
  }

  // 10) Desactivar regla específica
  console.log('\n10) Desactivar regla específica del Dispenser');
  specificRule.active = false;
  await specificRule.save();

  // 11) Verificar que Dispenser vuelve a aplicar regla global
  console.log('11) Cotizar Dispenser para JUBILADO (debe volver a -30%):');
  const dispenserResult = await buildQuote(clients.JUBILADO._id.toString(), [
    { productId: dispenser._id.toString(), quantity: 1 },
  ]);
  const dispLine = dispenserResult.items[0];
  console.log(
    `   DISPENSER   base=$35.000 final=$${(dispLine.unitFinalPriceMinor / 100).toFixed(2)} ajuste=${dispLine.adjustmentPercentage}% regla=${dispLine.appliedRule?.name ?? '-'}`,
  );
  if (dispLine.appliedRule?.name !== 'Descuento jubilados') {
    throw new Error('Expected global rule to apply again');
  }
  if (dispLine.unitFinalPriceMinor !== 2_450_000) {
    throw new Error(
      `Expected 2450000 minor for DISPENSER @ -30%, got ${dispLine.unitFinalPriceMinor}`,
    );
  }

  // Validate HTTP endpoint for admin
  const request = (await import('supertest')).default;
  const apiRes = await request(app)
    .post('/api/pricing/quote')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      clientId: clients.JUBILADO._id.toString(),
      items: [{ productId: bidon._id.toString(), quantity: 2 }],
    });
  if (apiRes.status !== 200) {
    throw new Error(`HTTP quote failed: ${apiRes.status}`);
  }
  console.log(
    `\n   HTTP /api/pricing/quote: bidón x2 JUBILADO base=$30.000 final=$${(apiRes.body.data.totals.finalMinor / 100).toFixed(2)}`,
  );

  console.log('\n✅ Smoke test FASE 3 OK');

  await teardownTestDb();
}

main().catch(async (err) => {
  console.error('\n❌ Smoke test failed:', err);
  await teardownTestDb();
  process.exit(1);
});
