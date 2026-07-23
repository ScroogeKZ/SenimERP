import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { signSsoToken } from '@senimerp/auth-client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { EventConsumerService } from './event-consumer.service.js';

async function runDiscountsTest() {
  console.log('=== STARTING LINE ITEM DISCOUNTS INTEGRATION TEST ===');

  console.log('[Test] Bootstrapping SenimERP API server for Discounts test...');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  const port = process.env.PORT || 3004;
  await app.listen(port);
  console.log(`[Test] ERP API running on http://localhost:${port}`);

  const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
  const tenantId = `disc_tenant_${Date.now()}`;
  const schemaName = `tenant_${tenantId}`;

  // 1. Ensure clean schema setup
  const rawPublicClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=public` } }
  });
  await rawPublicClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
  await rawPublicClient.$disconnect();

  const getAuthHeaders = () => {
    const ssoToken = signSsoToken({
      sub: 'usr_test_disc_manager',
      tenantId,
      email: 'discounts@senim.kz',
      roles: ['ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_CEO']
    });
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ssoToken}`
    };
  };

  const baseUrl = `http://localhost:${port}`;

  // Trigger schema provisioning
  console.log('[Test] Triggering on-demand schema provisioning...');
  const whRes = await fetch(`${baseUrl}/api/warehouses`, { headers: getAuthHeaders() });
  if (!whRes.ok) throw new Error(`GET /api/warehouses failed: ${await whRes.text()}`);

  const tenantClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=${schemaName}` } }
  });

  const eventConsumer = app.get(EventConsumerService);
  const customerId = `cust_disc_${Date.now()}`;
  const bin = `99${Math.floor(100000000 + Math.random() * 900000000)}`;

  // Step 1: deal.won with listPrice present (Discount scenario)
  console.log('[Test 1] Simulating deal.won event with listPrice present...');
  const deal1Id = `deal_disc_1_${Date.now()}`;
  await eventConsumer.handleDealWon({
    eventId: `evt_disc_1_${Date.now()}`,
    eventType: 'deal.won',
    tenantId,
    timestamp: new Date().toISOString(),
    payload: {
      dealId: deal1Id,
      customerId,
      customerName: 'Клиент Со Скидкой',
      customerBin: bin,
      amount: 17000,
      items: [
        { sku: 'SKU-DISC-1', crmProductId: 'prod_d1', name: 'Товар со скидкой', quantity: 10, price: 800, listPrice: 1000 },
        { sku: 'SRV-DISC-1', crmProductId: 'prod_d2', name: 'Услуга со скидкой', quantity: 2, price: 4500, listPrice: 5000 }
      ]
    }
  } as any);

  const inv1 = await tenantClient.invoice.findFirst({
    where: { crmDealId: deal1Id },
    include: { items: true }
  });
  if (!inv1) throw new Error('Invoice 1 creation failed');

  const invGoodLine = inv1.items.find((i) => i.sku === 'SKU-DISC-1');
  console.log(`[Test 1] Invoice Line SKU-DISC-1: price=${invGoodLine?.price}, originalPrice=${invGoodLine?.originalPrice}, discountAmount=${invGoodLine?.discountAmount}, discountPercent=${invGoodLine?.discountPercent}`);
  if (Number(invGoodLine?.originalPrice) !== 1000 || Number(invGoodLine?.discountAmount) !== 2000 || Number(invGoodLine?.discountPercent) !== 20.00) {
    throw new Error(`Expected Invoice line SKU-DISC-1: originalPrice=1000, discountAmount=2000, discountPercent=20.00. Got: ${JSON.stringify(invGoodLine)}`);
  }

  const wb1 = await tenantClient.waybill.findFirst({
    where: { crmDealId: deal1Id },
    include: { items: true }
  });
  if (!wb1) throw new Error('Waybill 1 creation failed');
  const wbGoodLine = wb1.items.find((i) => i.sku === 'SKU-DISC-1');
  console.log(`[Test 1] Waybill Line SKU-DISC-1: price=${wbGoodLine?.price}, originalPrice=${wbGoodLine?.originalPrice}, discountAmount=${wbGoodLine?.discountAmount}, discountPercent=${wbGoodLine?.discountPercent}`);
  if (Number(wbGoodLine?.originalPrice) !== 1000 || Number(wbGoodLine?.discountAmount) !== 2000 || Number(wbGoodLine?.discountPercent) !== 20.00) {
    throw new Error(`Expected Waybill line SKU-DISC-1: originalPrice=1000, discountAmount=2000, discountPercent=20.00. Got: ${JSON.stringify(wbGoodLine)}`);
  }

  const act1 = await tenantClient.serviceAct.findFirst({
    where: { crmDealId: deal1Id },
    include: { items: true }
  });
  if (!act1) throw new Error('ServiceAct 1 creation failed');
  const actSrvLine = act1.items.find((i) => i.sku === 'SRV-DISC-1');
  console.log(`[Test 1] Act Line SRV-DISC-1: price=${actSrvLine?.price}, originalPrice=${actSrvLine?.originalPrice}, discountAmount=${actSrvLine?.discountAmount}, discountPercent=${actSrvLine?.discountPercent}`);
  if (Number(actSrvLine?.originalPrice) !== 5000 || Number(actSrvLine?.discountAmount) !== 1000 || Number(actSrvLine?.discountPercent) !== 10.00) {
    throw new Error(`Expected Act line SRV-DISC-1: originalPrice=5000, discountAmount=1000, discountPercent=10.00. Got: ${JSON.stringify(actSrvLine)}`);
  }
  console.log('[Test 1 SUCCESS] Discount calculation and storage verified across Invoice, Waybill, and ServiceAct!');

  // Step 2: deal.won without listPrice (listPrice missing)
  console.log('[Test 2] Simulating deal.won event with listPrice missing...');
  const deal2Id = `deal_disc_2_${Date.now()}`;
  await eventConsumer.handleDealWon({
    eventId: `evt_disc_2_${Date.now()}`,
    eventType: 'deal.won',
    tenantId,
    timestamp: new Date().toISOString(),
    payload: {
      dealId: deal2Id,
      customerId,
      customerName: 'Клиент Без ПрайсЛиста',
      customerBin: bin,
      amount: 7500,
      items: [
        { sku: 'SKU-DISC-NOLIST', crmProductId: 'prod_nolist', name: 'Товар без listPrice', quantity: 5, price: 1500 }
      ]
    }
  } as any);

  const inv2 = await tenantClient.invoice.findFirst({
    where: { crmDealId: deal2Id },
    include: { items: true }
  });
  if (!inv2) throw new Error('Invoice 2 creation failed');
  const noListLine = inv2.items.find((i) => i.sku === 'SKU-DISC-NOLIST');
  console.log(`[Test 2] Invoice Line SKU-DISC-NOLIST: originalPrice=${noListLine?.originalPrice}, discountAmount=${noListLine?.discountAmount}, discountPercent=${noListLine?.discountPercent}`);
  if (noListLine?.originalPrice !== null || Number(noListLine?.discountAmount) !== 0 || Number(noListLine?.discountPercent) !== 0) {
    throw new Error(`Expected null originalPrice and 0 discount. Got: ${JSON.stringify(noListLine)}`);
  }
  console.log('[Test 2 SUCCESS] Missing listPrice default handling verified!');

  // Step 3: Surcharge scenario (price > listPrice)
  console.log('[Test 3] Simulating deal.won event with surcharge (price > listPrice)...');
  const deal3Id = `deal_disc_3_${Date.now()}`;
  await eventConsumer.handleDealWon({
    eventId: `evt_disc_3_${Date.now()}`,
    eventType: 'deal.won',
    tenantId,
    timestamp: new Date().toISOString(),
    payload: {
      dealId: deal3Id,
      customerId,
      customerName: 'Клиент С Наценкой',
      customerBin: bin,
      amount: 4800,
      items: [
        { sku: 'SKU-SURCHARGE', crmProductId: 'prod_sur', name: 'Товар с наценкой', quantity: 4, price: 1200, listPrice: 1000 }
      ]
    }
  } as any);

  const inv3 = await tenantClient.invoice.findFirst({
    where: { crmDealId: deal3Id },
    include: { items: true }
  });
  if (!inv3) throw new Error('Invoice 3 creation failed');
  const surchargeLine = inv3.items.find((i) => i.sku === 'SKU-SURCHARGE');
  console.log(`[Test 3] Invoice Line SKU-SURCHARGE: price=${surchargeLine?.price}, originalPrice=${surchargeLine?.originalPrice}, discountAmount=${surchargeLine?.discountAmount}, discountPercent=${surchargeLine?.discountPercent}`);
  if (Number(surchargeLine?.originalPrice) !== 1000 || Number(surchargeLine?.discountAmount) !== -800 || Number(surchargeLine?.discountPercent) !== -20.00) {
    throw new Error(`Expected surcharge line: originalPrice=1000, discountAmount=-800, discountPercent=-20.00. Got: ${JSON.stringify(surchargeLine)}`);
  }
  console.log('[Test 3 SUCCESS] Surcharge (negative discount) recorded correctly!');

  // Step 4: GET /api/reports/discounts report endpoint
  console.log('[Test 4] Calling GET /api/reports/discounts...');
  const reportRes = await fetch(`${baseUrl}/api/reports/discounts`, {
    headers: getAuthHeaders()
  });
  if (!reportRes.ok) throw new Error(`GET /api/reports/discounts failed: ${await reportRes.text()}`);
  const reportData = await reportRes.json();
  console.log(`[Test 4] Report output: ${JSON.stringify(reportData)}`);

  const customerReport = reportData.find((r: any) => r.bin === bin);
  if (!customerReport) throw new Error(`Customer report for BIN ${bin} not found in output`);

  console.log(`[Test 4 SUCCESS] Customer ${customerReport.customerName} total discount: ${customerReport.totalDiscountAmount} KZT across ${customerReport.itemCount} items.`);
  if (customerReport.totalDiscountAmount !== 4400) {
    throw new Error(`Expected total discount amount 4400. Got ${customerReport.totalDiscountAmount}`);
  }

  // Step 5: Input Validation Rejection Tests
  console.log('[Test 5] Testing handleDealWon input validation rejection...');
  const invalidDealId = `deal_invalid_${Date.now()}`;
  try {
    await eventConsumer.handleDealWon({
      eventId: `evt_inv_1_${Date.now()}`,
      eventType: 'deal.won',
      tenantId,
      timestamp: new Date().toISOString(),
      payload: {
        dealId: invalidDealId,
        customerId,
        customerName: 'Битый Запрос',
        customerBin: bin,
        items: [{ sku: 'SKU-BAD', name: 'Отрицательная цена', quantity: 1, price: -500 }]
      }
    } as any);
    throw new Error('Negative price was expected to be rejected!');
  } catch (err: any) {
    if (!err.message.includes('Invalid price')) throw err;
    console.log(`  [5a SUCCESS] Negative price rejected: ${err.message}`);
  }

  try {
    await eventConsumer.handleDealWon({
      eventId: `evt_inv_2_${Date.now()}`,
      eventType: 'deal.won',
      tenantId,
      timestamp: new Date().toISOString(),
      payload: {
        dealId: invalidDealId,
        customerId,
        customerName: 'Битый Запрос 2',
        customerBin: bin,
        items: [{ sku: 'SKU-BAD-2', name: 'Нулевое количество', quantity: 0, price: 1000 }]
      }
    } as any);
    throw new Error('Zero quantity was expected to be rejected!');
  } catch (err: any) {
    if (!err.message.includes('Invalid quantity')) throw err;
    console.log(`  [5b SUCCESS] Zero quantity rejected: ${err.message}`);
  }

  const badInv = await tenantClient.invoice.findFirst({ where: { crmDealId: invalidDealId } });
  if (badInv) throw new Error('No invoice should be created for invalid deal payload!');
  console.log('[Test 5 SUCCESS] Input validation rejection verified.');

  // Step 6: Missing Default Warehouse Fallback Test
  console.log('[Test 6] Testing missing default warehouse rejection and rollback...');
  await tenantClient.$executeRawUnsafe(`UPDATE "${schemaName}"."Warehouse" SET "isDefault" = false;`);

  const noWhDealId = `deal_nowh_${Date.now()}`;
  try {
    await eventConsumer.handleDealWon({
      eventId: `evt_nowh_${Date.now()}`,
      eventType: 'deal.won',
      tenantId,
      timestamp: new Date().toISOString(),
      payload: {
        dealId: noWhDealId,
        customerId,
        customerName: 'Тест Без Склада',
        customerBin: bin,
        items: [{ sku: 'SKU-PHYS-NOWH', name: 'Физический Товар Без Склада', quantity: 5, price: 2000 }]
      }
    } as any);
    throw new Error('deal.won with physical items and no default warehouse expected to fail!');
  } catch (err: any) {
    if (!err.message.includes('no default warehouse configured')) throw err;
    console.log(`  [Test 6 SUCCESS] Missing default warehouse rejected: ${err.message}`);
  }

  const rolledBackInv = await tenantClient.invoice.findFirst({ where: { crmDealId: noWhDealId } });
  const rolledBackWb = await tenantClient.waybill.findFirst({ where: { crmDealId: noWhDealId } });
  if (rolledBackInv || rolledBackWb) {
    throw new Error('Transaction was not rolled back properly on missing warehouse error!');
  }
  console.log('[Test 6 SUCCESS] Transaction rollback verified on missing default warehouse.');

  // Restore default warehouse for subsequent tests
  await tenantClient.$executeRawUnsafe(`UPDATE "${schemaName}"."Warehouse" SET "isDefault" = true;`);

  // Step 7: Decimal Precision & Multi-item Rounding Assertion
  console.log('[Test 7] Testing multi-item Decimal precision rounding...');
  const decDealId = `deal_dec_${Date.now()}`;
  await eventConsumer.handleDealWon({
    eventId: `evt_dec_${Date.now()}`,
    eventType: 'deal.won',
    tenantId,
    timestamp: new Date().toISOString(),
    payload: {
      dealId: decDealId,
      customerId,
      customerName: 'Дробный Клиент',
      customerBin: bin,
      items: [
        { sku: 'SKU-DEC-1', name: 'Товар 1', quantity: 3, price: 100.33, vatRate: 12 },
        { sku: 'SKU-DEC-2', name: 'Товар 2', quantity: 7, price: 55.55, vatRate: 12 },
        { sku: 'SRV-DEC-1', name: 'Услуга 1', quantity: 2, price: 99.99, vatRate: 12 }
      ]
    }
  } as any);

  const decInv = await tenantClient.invoice.findFirst({
    where: { crmDealId: decDealId },
    include: { items: true }
  });
  if (!decInv) throw new Error('Decimal Invoice creation failed');

  // Item 1: 100.33 * 3 = 300.99, vat = 36.12, total = 337.11
  // Item 2: 55.55 * 7 = 388.85, vat = 46.66, total = 435.51
  // Item 3: 99.99 * 2 = 199.98, vat = 24.00, total = 223.98
  // Total Invoice vatAmount = 36.12 + 46.66 + 24.00 = 106.78
  // Total Invoice amount = 337.11 + 435.51 + 223.98 = 996.60
  if (Number(decInv.vatAmount) !== 106.78 || Number(decInv.amount) !== 996.60) {
    throw new Error(`Invoice Decimal total mismatch! Expected vatAmount=106.78, amount=996.60. Got vat=${decInv.vatAmount}, amount=${decInv.amount}`);
  }

  const decWb = await tenantClient.waybill.findFirst({
    where: { crmDealId: decDealId }
  });
  if (!decWb) throw new Error('Decimal Waybill creation failed');
  // Waybill goods total vat = 36.12 + 46.66 = 82.78, amount = 337.11 + 435.51 = 772.62
  if (Number(decWb.vatAmount) !== 82.78 || Number(decWb.amount) !== 772.62) {
    throw new Error(`Waybill Decimal total mismatch! Expected vatAmount=82.78, amount=772.62. Got vat=${decWb.vatAmount}, amount=${decWb.amount}`);
  }

  const decAct = await tenantClient.serviceAct.findFirst({
    where: { crmDealId: decDealId }
  });
  if (!decAct) throw new Error('Decimal ServiceAct creation failed');
  // ServiceAct total vat = 24.00, amount = 223.98
  if (Number(decAct.vatAmount) !== 24.00 || Number(decAct.amount) !== 223.98) {
    throw new Error(`ServiceAct Decimal total mismatch! Expected vatAmount=24.00, amount=223.98. Got vat=${decAct.vatAmount}, amount=${decAct.amount}`);
  }
  console.log('[Test 7 SUCCESS] Multi-item Decimal precision verified across Invoice, Waybill, and ServiceAct!');

  await tenantClient.$disconnect();
  console.log('=== LINE ITEM DISCOUNTS INTEGRATION TEST PASSED SUCCESSFULLY! ===');
  await app.close();
  process.exit(0);
}

runDiscountsTest().catch((err) => {
  console.error('=== LINE ITEM DISCOUNTS INTEGRATION TEST FAILED ===', err);
  process.exit(1);
});
